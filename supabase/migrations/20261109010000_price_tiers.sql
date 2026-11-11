-- 三種額外價格：特價、會員價（items，店員看得到）、員工價（item_costs，和成本一樣只有店長看得到）。
-- 空值（null）＝沒有設定；0＝0 元。結帳時每個品項可以選用哪一種價格計價，銷售明細記下價格別。
alter table public.items
  add column special_price numeric(12,2) check (special_price >= 0),
  add column member_price numeric(12,2) check (member_price >= 0);
alter table public.item_costs
  add column staff_price numeric(12,2) check (staff_price >= 0);
alter table public.sale_lines
  add column price_tier text not null default 'regular' check (price_tier in ('regular', 'special', 'member', 'staff'));

-- 結帳：單價依每一列的 price_tier 決定（沒帶就是售價）。之後的特惠組合、車身＋電池折扣、優惠代碼都以這個單價為基準。
create or replace function app_private.create_sale_with_serials(p_lines jsonb, p_customer_id uuid, p_sale_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_sale_id uuid := coalesce(p_sale_id, gen_random_uuid());
  v_sale_number text := 'S' || to_char(now(), 'YYYYMMDDHH24MISSMS') || '-' || substr(replace(v_sale_id::text, '-', ''), 1, 6);
  v_line jsonb;
  v_item public.items%rowtype;
  v_line_id uuid;
  v_serial_id uuid;
  v_serial public.inventory_serials%rowtype;
  v_serial_ids jsonb;
  v_customer_name text;
  v_quantity integer;
  v_total numeric(12,2) := 0;
  v_now timestamptz := now();
  v_purchased_at date := (now() at time zone 'Asia/Taipei')::date;
  v_tier text;
  v_unit_price numeric(12,2);
begin
  if not app_private.is_active_staff() then raise exception '帳號權限不足'; end if;
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then raise exception '銷售品項不可空白'; end if;
  if p_customer_id is not null then
    select name into v_customer_name from public.customers where id = p_customer_id and active;
    if not found then raise exception '銷售客戶不存在或已停用'; end if;
  end if;
  insert into public.sales (id, sale_number, total, customer_id, created_by)
    values (v_sale_id, v_sale_number, 0, p_customer_id, auth.uid());
  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_quantity := (v_line->>'quantity')::integer;
    if v_quantity is null or v_quantity <= 0 then raise exception '銷售數量無效'; end if;
    select * into v_item from public.items where id = (v_line->>'item_id')::uuid for update;
    if not found or v_item.stock < v_quantity then raise exception '品項不存在或庫存不足'; end if;
    if not v_item.active then raise exception '品項「%」已停用，無法銷售', v_item.name; end if;
    -- 價格別：regular 售價（預設）、special 特價、member 會員價（要有選客戶）、staff 員工價（只有店長可用）。
    -- 沒設定（null）的價格不能選；0 代表 0 元。
    v_tier := coalesce(nullif(v_line->>'price_tier', ''), 'regular');
    if v_tier = 'regular' then v_unit_price := v_item.price;
    elsif v_tier = 'special' then v_unit_price := v_item.special_price;
    elsif v_tier = 'member' then
      if p_customer_id is null then raise exception '會員價需要先選擇客戶'; end if;
      v_unit_price := v_item.member_price;
    elsif v_tier = 'staff' then
      if not app_private.is_admin() then raise exception '只有店長可以用員工價結帳' using errcode = '42501'; end if;
      select staff_price into v_unit_price from public.item_costs where item_id = v_item.id;
    else raise exception '價格別無效';
    end if;
    if v_unit_price is null then
      raise exception '品項「%」沒有設定%', v_item.name,
        case v_tier when 'special' then '特價' when 'member' then '會員價' else '員工價' end;
    end if;
    v_serial_ids := coalesce(v_line->'serial_ids', '[]'::jsonb);
    if jsonb_typeof(v_serial_ids) <> 'array' then raise exception '銷售序號格式無效'; end if;
    -- 序號選填：車身／電池可以不選序號，有選就不能超過數量；不再要求客戶與「在庫序號數＝庫存」。
    if v_item.category in ('車身','電池') then
      if jsonb_array_length(v_serial_ids) > v_quantity then raise exception '所選序號數超過銷售數量'; end if;
    elsif jsonb_array_length(v_serial_ids) <> 0 then raise exception '非序號品項不可指定序號'; end if;
    update public.items set stock = stock - v_quantity where id = v_item.id;
    insert into public.sale_lines (sale_id, item_id, item_name, barcode, quantity, unit_price, subtotal, price_tier)
      values (v_sale_id, v_item.id, v_item.name, v_item.barcode, v_quantity, v_unit_price, v_unit_price * v_quantity, v_tier)
      returning id into v_line_id;
    for v_serial_id in select value::text::uuid from jsonb_array_elements_text(v_serial_ids) loop
      select * into v_serial from public.inventory_serials where id = v_serial_id for update;
      if not found or v_serial.item_id <> v_item.id or v_serial.status <> 'in_stock' then
        raise exception '銷售序號不可用或與品項不符';
      end if;
      update public.inventory_serials set status = 'sold', sale_id = v_sale_id, sale_line_id = v_line_id,
        customer_id = p_customer_id, sold_at = v_now where id = v_serial_id;
    end loop;
    -- 保固系統停用：結帳不再自動建立保固。
    insert into public.inventory_transactions (item_id, type, quantity, note, created_by)
      values (v_item.id, 'out', v_quantity, '銷售管理 ' || v_sale_number, auth.uid());
    v_total := v_total + v_unit_price * v_quantity;
  end loop;
  update public.sales set total = v_total where id = v_sale_id;
  return v_sale_id;
end;
$function$;

-- 新增車身／電池（連同序號一起建立）時，也一併存入三種價格。
create or replace function public.create_serialized_item(p_item jsonb, p_cost numeric, p_serials jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_id uuid := (p_item->>'id')::uuid;
  v_stock integer := (p_item->>'stock')::integer;
begin
  if not app_private.is_admin() then raise exception '管理員權限不足' using errcode = '42501'; end if;
  if v_id is null or p_item->>'category' not in ('車身', '電池') or v_stock is null or v_stock < 1
    or p_serials is null or jsonb_typeof(p_serials) <> 'array' or jsonb_array_length(p_serials) < 1
    or jsonb_array_length(p_serials) > v_stock then  -- 序號選填：可以只登錄一部分，不可超過庫存
    raise exception '品項與原廠序號數量不相符';
  end if;
  insert into public.items (id, name, category, sku, barcode, price, stock, minimum_stock,
    warranty_months, notes, supplier_id, price_locked, vehicle_model_id, special_price, member_price, created_by)
  values (v_id, p_item->>'name', p_item->>'category', coalesce(p_item->>'sku', ''),
    coalesce(p_item->>'barcode', ''), (p_item->>'price')::numeric, v_stock,
    (p_item->>'minimum_stock')::integer, coalesce((p_item->>'warranty_months')::integer, 0),
    coalesce(p_item->>'notes', ''), nullif(p_item->>'supplier_id', '')::uuid,
    coalesce((p_item->>'price_locked')::boolean, false), nullif(p_item->>'vehicle_model_id', '')::uuid,
    nullif(p_item->>'special_price', '')::numeric, nullif(p_item->>'member_price', '')::numeric, auth.uid());
  insert into public.item_costs (item_id, cost, staff_price, updated_by)
    values (v_id, p_cost, nullif(p_item->>'staff_price', '')::numeric, auth.uid());
  perform public.register_inventory_serials(v_id, p_serials);
  return v_id;
end;
$function$;
