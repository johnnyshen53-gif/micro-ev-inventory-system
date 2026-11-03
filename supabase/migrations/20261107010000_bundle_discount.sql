-- 車身＋電池組合折扣：同一張銷售單／報價單裡，每「1 台車身＋1 顆電池」配成一組折 500 元
-- （例：2 車身＋2 電池折 1,000；2 車身＋1 電池折 500）。自動套用，可和特惠組合、優惠代碼併用：
-- 先算特惠組合 → 再扣車身＋電池折扣 → 最後才算優惠代碼。折扣先從車身扣（金額大的先），不夠再從電池扣，每列最多扣到 0。
alter table public.sales add column bundle_discount numeric(12,2) not null default 0;
alter table public.quotations add column bundle_discount numeric(12,2) not null default 0;

-- p_lines：同一品項已合併的 [{ itemId, quantity, net（扣掉組合折扣後的金額，單位：分） }]。
-- 回傳 { total（分）, sets（組數）, byItem: { 品項ID: 分 } }。
create function app_private.calc_bundle_discounts(p_lines jsonb)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
  v_per_set constant bigint := 50000;  -- 每組 500 元（以分計）
  v_sets integer;
  v_rest bigint;
  v_cut bigint;
  v_by jsonb := '{}'::jsonb;
  r record;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then return jsonb_build_object('total', 0, 'sets', 0, 'byItem', '{}'::jsonb); end if;
  select least(coalesce(sum((l->>'quantity')::integer) filter (where i.category = '車身'), 0),
               coalesce(sum((l->>'quantity')::integer) filter (where i.category = '電池'), 0))
    into v_sets
    from jsonb_array_elements(p_lines) l join public.items i on i.id = (l->>'itemId')::uuid;
  v_sets := coalesce(v_sets, 0);
  v_rest := v_sets * v_per_set;
  for r in select l->>'itemId' as item_id, (l->>'net')::bigint as net
      from jsonb_array_elements(p_lines) l join public.items i on i.id = (l->>'itemId')::uuid
      where i.category in ('車身', '電池')
      order by case when i.category = '車身' then 0 else 1 end, (l->>'net')::bigint desc, (l->>'itemId') collate "C" loop
    exit when v_rest <= 0;
    v_cut := least(v_rest, greatest(r.net, 0));
    if v_cut > 0 then
      v_by := jsonb_set(v_by, array[r.item_id], to_jsonb(coalesce((v_by->>r.item_id)::bigint, 0) + v_cut));
      v_rest := v_rest - v_cut;
    end if;
  end loop;
  return jsonb_build_object('total', v_sets * v_per_set - v_rest, 'sets', v_sets, 'byItem', v_by);
end;
$$;

-- 結帳：在特惠組合之後套用，更新明細折扣、小計與銷售總額；回傳折扣金額（元）。
create function app_private.apply_bundle_discount(p_sale_id uuid)
returns numeric language plpgsql security definer set search_path = '' as $$
declare
  v_calc jsonb;
  v_key text;
  v_left bigint;
  v_cut bigint;
  r record;
begin
  v_calc := app_private.calc_bundle_discounts(
    (select jsonb_agg(jsonb_build_object('itemId', item_id, 'quantity', quantity, 'net', net))
       from (select item_id, sum(quantity)::integer as quantity, sum(round(subtotal * 100))::bigint as net
               from public.sale_lines where sale_id = p_sale_id group by item_id) a));
  if (v_calc->>'total')::bigint = 0 then return 0; end if;
  for v_key in select jsonb_object_keys(v_calc->'byItem') loop
    v_left := (v_calc->'byItem'->>v_key)::bigint;
    for r in select id, round(subtotal * 100)::bigint as net from public.sale_lines
        where sale_id = p_sale_id and item_id = v_key::uuid order by subtotal desc, id loop
      exit when v_left <= 0;
      v_cut := least(v_left, r.net);
      update public.sale_lines set discount = discount + v_cut / 100.0, subtotal = subtotal - v_cut / 100.0 where id = r.id;
      v_left := v_left - v_cut;
    end loop;
  end loop;
  update public.sales set bundle_discount = (v_calc->>'total')::bigint / 100.0,
    total = (select coalesce(sum(subtotal), 0) from public.sale_lines where sale_id = p_sale_id)
    where id = p_sale_id;
  return (v_calc->>'total')::bigint / 100.0;
end;
$$;

revoke all on function app_private.calc_bundle_discounts(jsonb), app_private.apply_bundle_discount(uuid) from public, anon, authenticated;

create or replace function app_private.create_sale_with_serials_logged(p_lines jsonb, p_customer_id uuid, p_salesperson_id uuid, p_checkout_id uuid, p_promotions jsonb, p_coupon_code text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_name text;
  v_sale_id uuid;
  v_existing_by uuid;
  v_discount numeric;
  v_coupon_discount numeric;
  v_bundle_discount numeric;
begin
  if not app_private.is_active_staff() then raise exception '帳號權限不足' using errcode = '42501'; end if;
  if p_checkout_id is null then raise exception '結帳識別碼不可空白'; end if;
  -- 交易層級的 advisory lock：同一個 checkout id 同時送兩次時，第二次會等第一次結束後才往下檢查。
  perform pg_advisory_xact_lock(hashtextextended('sale_checkout:' || p_checkout_id::text, 0));
  select created_by into v_existing_by from public.sales where id = p_checkout_id;
  if found then
    if v_existing_by is distinct from auth.uid() then
      raise exception '結帳識別碼已被使用' using errcode = '23505';
    end if;
    return p_checkout_id;
  end if;
  if p_salesperson_id is null then raise exception '結帳時請選擇業務員'; end if;
  select name into v_name from public.salespeople
    where id = p_salesperson_id and active and is_sales for share;
  if not found then raise exception '業務員不存在、已停用或未勾選業務員身分，請重新選擇'; end if;
  -- 先依 ID 排序鎖住所有品項與序號，多台同時結帳時鎖定順序一致，不會互相卡死（deadlock）。
  perform app_private.lock_sale_rows(p_lines);
  v_sale_id := app_private.create_sale_with_serials(p_lines, p_customer_id, p_checkout_id);
  -- 先套特惠組合，再套優惠代碼；任何一項不符合規則就整筆結帳取消（同一個交易）。
  v_discount := app_private.apply_sale_promotions(v_sale_id, coalesce(p_promotions, '[]'::jsonb));
  -- 車身＋電池：每配成一組折 500（在特惠組合之後、優惠代碼之前）。
  v_bundle_discount := app_private.apply_bundle_discount(v_sale_id);
  v_coupon_discount := app_private.apply_sale_coupon(v_sale_id, p_coupon_code);
  insert into public.audit_logs (actor_id, action, target_type, target_id, summary)
    select auth.uid(), 'sale_created', 'sale', v_sale_id,
      jsonb_build_object('sale_number', sale_number, 'total', total)
        || case when v_discount > 0 then jsonb_build_object('promotion_discount', v_discount,
             'promotions', coalesce(p_promotions, '[]'::jsonb)) else '{}'::jsonb end
        || case when v_bundle_discount > 0 then jsonb_build_object('bundle_discount', v_bundle_discount) else '{}'::jsonb end
        || case when v_coupon_discount > 0 then jsonb_build_object('coupon_discount', v_coupon_discount,
             'coupon_code', app_private.normalize_coupon_code(p_coupon_code)) else '{}'::jsonb end
    from public.sales where id = v_sale_id;
  insert into app_private.sale_salesperson_attributions(sale_id, salesperson_id, salesperson_name)
    values (v_sale_id, p_salesperson_id, v_name);
  -- 機車獎金：以台數計算，不受折扣影響；重送同一個 checkout id 會在上面提早 return，所以不會重複記帳。
  perform app_private.record_motorcycle_bonus(v_sale_id);
  return v_sale_id;
end;
$function$;

create or replace function app_private.save_quotation(p_quotation jsonb, p_lines jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_id uuid := (p_quotation->>'id')::uuid;
  v_customer_id uuid := nullif(p_quotation->>'customerId', '')::uuid;
  v_customer_name text := left(trim(coalesce(p_quotation->>'customerName', '')), 50);
  v_customer_phone text := left(trim(coalesce(p_quotation->>'customerPhone', '')), 30);
  v_plate_number text := left(upper(trim(coalesce(p_quotation->>'plateNumber', ''))), 20);
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
  v_bundle jsonb;
  v_bundle_left jsonb;
  v_bundle_cut bigint;
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
  -- 車身＋電池：每配成一組折 500，以扣掉組合折扣後的金額為上限（和銷售結帳相同）。
  v_bundle := app_private.calc_bundle_discounts(
    (select jsonb_agg(jsonb_build_object('itemId', i.id, 'quantity', a.quantity,
        'net', round(i.price * 100)::bigint * a.quantity - coalesce((v_calc->'byItem'->>i.id::text)::bigint, 0)))
       from (select (value->>'itemId')::uuid as item_id, sum((value->>'quantity')::integer) as quantity
               from jsonb_array_elements(p_lines) group by 1) a
       join public.items i on i.id = a.item_id));
  v_total := v_total - (v_bundle->>'total')::bigint / 100.0;
  if v_total is distinct from (p_quotation->>'total')::numeric then raise exception '報價總額無效'; end if;

  insert into public.quotations (id,quote_number,customer_id,customer_name,customer_phone,plate_number,salesperson_id,total,bundle_discount,note,created_by)
  values (v_id,trim(p_quotation->>'number'),v_customer_id,v_customer_name,v_customer_phone,v_plate_number,v_salesperson_id,v_total,(v_bundle->>'total')::bigint / 100.0,coalesce(p_quotation->>'note',''),auth.uid());
  v_left := v_calc->'byItem';
  v_bundle_left := v_bundle->'byItem';
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
    -- 車身＋電池折扣：同樣依明細順序往下扣，每列最多扣到 0。
    v_bundle_cut := least(coalesce((v_bundle_left->>v_key)::bigint, 0), round(v_item.price * 100)::bigint * v_quantity - v_line_discount);
    if v_bundle_cut > 0 then
      v_bundle_left := jsonb_set(v_bundle_left, array[v_key], to_jsonb((v_bundle_left->>v_key)::bigint - v_bundle_cut));
      v_line_discount := v_line_discount + v_bundle_cut;
    end if;
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
$function$;
