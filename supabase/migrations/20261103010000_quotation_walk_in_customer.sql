-- 報價單客戶可直接填寫：不從客戶清單選時，填姓名（必填）與電話（可空白），只存在報價單上，不會新增到客戶管理。
-- customer_id 改為可空白；customer_name／customer_phone 存填寫的客戶（選清單客戶時維持空白，名稱以客戶資料為準）。
alter table public.quotations alter column customer_id drop not null;
alter table public.quotations add column customer_name text not null default '';
alter table public.quotations add column customer_phone text not null default '';
alter table public.quotations add constraint quotations_customer_present
  check (customer_id is not null or length(trim(customer_name)) > 0);

create or replace function app_private.save_quotation(p_quotation jsonb, p_lines jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := (p_quotation->>'id')::uuid;
  v_customer_id uuid := nullif(p_quotation->>'customerId', '')::uuid;
  v_customer_name text := left(trim(coalesce(p_quotation->>'customerName', '')), 50);
  v_customer_phone text := left(trim(coalesce(p_quotation->>'customerPhone', '')), 30);
  v_salesperson_id uuid := (p_quotation->>'salespersonId')::uuid;
  v_line jsonb;
  v_item public.items%rowtype;
  v_quantity integer;
  v_installed boolean;
  v_hours numeric;
  v_rate numeric;
  v_labor numeric;
  v_shop_rate numeric(12,2);
  v_total numeric(12,2) := 0;
  v_calc jsonb;
  v_left jsonb;
  v_key text;
  v_line_discount bigint;
  v_entry jsonb;
begin
  if not app_private.is_active_staff() then raise exception '帳號權限不足'; end if;
  if v_id is null or nullif(trim(p_quotation->>'number'), '') is null or
     jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception '報價資料不完整';
  end if;
  if exists (select 1 from public.quotations where id = v_id) then raise exception '報價已存在，不能覆寫'; end if;
  -- 客戶：從客戶清單選（customer_id），或直接填寫姓名（電話可空白），填寫的客戶只存在報價單上。
  if v_customer_id is not null then
    if not exists (select 1 from public.customers where id = v_customer_id and active) then raise exception '報價客戶不存在或已停用'; end if;
    v_customer_name := ''; v_customer_phone := '';
  elsif v_customer_name = '' then
    raise exception '請選擇客戶或填寫客戶姓名';
  end if;
  if v_salesperson_id is not null and not exists (select 1 from public.salespeople where id = v_salesperson_id and active) then
    raise exception '報價業務不存在或已停用';
  end if;
  select hourly_rate into v_shop_rate from public.shop_settings where id=1;
  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_quantity := (v_line->>'quantity')::integer;
    if v_quantity is null or v_quantity <= 0 then raise exception '報價數量無效'; end if;
    select * into v_item from public.items where id = (v_line->>'itemId')::uuid;
    if not found then raise exception '報價品項不存在'; end if;
    if (v_line->>'itemName') is distinct from v_item.name or (v_line->>'unitPrice')::numeric is distinct from v_item.price then
      raise exception '報價品項資料已變更，請重新整理';
    end if;
    if v_line ? 'installationRequired' and jsonb_typeof(v_line->'installationRequired') <> 'boolean' then raise exception '安裝選項無效'; end if;
    v_installed := coalesce((v_line->>'installationRequired')::boolean,false);
    v_hours := coalesce((v_line->>'laborHours')::numeric,0);
    v_rate := coalesce((v_line->>'hourlyRate')::numeric,0);
    v_labor := coalesce((v_line->>'laborAmount')::numeric,0);
    if v_installed then
      if v_shop_rate is null or v_shop_rate <= 0 or v_hours <= 0 or v_hours <> round(v_hours,2)
        or v_rate <> round(v_rate,2) or v_labor <> round(v_labor,2)
        or v_rate is distinct from v_shop_rate or v_labor is distinct from round(v_hours*v_rate,2) then
        raise exception '工時或工資費率無效，請重新整理報價';
      end if;
    elsif v_hours <> 0 or v_rate <> 0 or v_labor <> 0 then
      raise exception '免安裝品項不可計收工資';
    end if;
    v_total := v_total + v_quantity * v_item.price + v_labor;
  end loop;

  -- 特惠組合：同一品項的數量先合併，以目前售價計算折扣。
  v_calc := app_private.calc_promotion_discounts(
    (select jsonb_agg(jsonb_build_object('itemId', i.id, 'unitPrice', i.price, 'quantity', a.quantity))
       from (select (value->>'itemId')::uuid as item_id, sum((value->>'quantity')::integer) as quantity
               from jsonb_array_elements(p_lines) group by 1) a
       join public.items i on i.id = a.item_id),
    p_quotation->'promotions');
  v_total := v_total - (v_calc->>'total')::bigint / 100.0;
  if v_total is distinct from (p_quotation->>'total')::numeric then raise exception '報價總額無效'; end if;

  insert into public.quotations (id,quote_number,customer_id,customer_name,customer_phone,salesperson_id,total,note,created_by)
  values (v_id,trim(p_quotation->>'number'),v_customer_id,v_customer_name,v_customer_phone,v_salesperson_id,v_total,coalesce(p_quotation->>'note',''),auth.uid());
  v_left := v_calc->'byItem';
  for v_line in select value from jsonb_array_elements(p_lines) loop
    select * into v_item from public.items where id=(v_line->>'itemId')::uuid;
    v_quantity := (v_line->>'quantity')::integer;
    v_installed := coalesce((v_line->>'installationRequired')::boolean,false);
    v_hours := coalesce((v_line->>'laborHours')::numeric,0);
    v_rate := coalesce((v_line->>'hourlyRate')::numeric,0);
    v_labor := coalesce((v_line->>'laborAmount')::numeric,0);
    -- 這個品項還沒扣完的折扣，依明細順序往下扣，每列最多扣到材料小計為 0。
    v_key := v_item.id::text;
    v_line_discount := least(coalesce((v_left->>v_key)::bigint, 0), round(v_item.price * 100)::bigint * v_quantity);
    if v_line_discount > 0 then v_left := jsonb_set(v_left, array[v_key], to_jsonb((v_left->>v_key)::bigint - v_line_discount)); end if;
    insert into public.quotation_lines(quotation_id,item_id,item_name,quantity,unit_price,subtotal,
      installation_required,labor_hours,hourly_rate,labor_amount,discount)
    values (v_id,v_item.id,v_item.name,v_quantity,v_item.price,v_quantity*v_item.price,
      v_installed,v_hours,v_rate,v_labor,v_line_discount / 100.0);
  end loop;
  for v_entry in select value from jsonb_array_elements(v_calc->'entries') loop
    insert into public.quotation_promotions (quotation_id, promotion_id, promotion_name, times, combo_price, list_total, discount)
      values (v_id, (v_entry->>'promotionId')::uuid, v_entry->>'name', (v_entry->>'times')::integer,
        (v_entry->>'comboPrice')::numeric, (v_entry->>'listTotal')::numeric, (v_entry->>'discount')::numeric);
  end loop;
  return v_id;
end;
$$;
