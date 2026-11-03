-- 序號全面改選填＋保固系統停用：
-- 1. 銷售：車身／電池可以不選序號（有選不可超過數量），不再要求客戶，也不再自動建立保固。
-- 2. 進貨收貨：序號可以不填（有填不可超過收貨數量）。
-- 3. 維修完工：電池可以不選序號、不必選會員，不再建立維修保固。
-- 4. 新增車身／電池品項時，初始序號可以少於庫存（不可超過）。
-- 三處都拿掉「在庫序號數必須等於庫存」的檢查；舊的保固資料保留不刪。

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
    v_serial_ids := coalesce(v_line->'serial_ids', '[]'::jsonb);
    if jsonb_typeof(v_serial_ids) <> 'array' then raise exception '銷售序號格式無效'; end if;
    -- 序號選填：車身／電池可以不選序號，有選就不能超過數量；不再要求客戶與「在庫序號數＝庫存」。
    if v_item.category in ('車身','電池') then
      if jsonb_array_length(v_serial_ids) > v_quantity then raise exception '所選序號數超過銷售數量'; end if;
    elsif jsonb_array_length(v_serial_ids) <> 0 then raise exception '非序號品項不可指定序號'; end if;
    update public.items set stock = stock - v_quantity where id = v_item.id;
    insert into public.sale_lines (sale_id, item_id, item_name, barcode, quantity, unit_price, subtotal)
      values (v_sale_id, v_item.id, v_item.name, v_item.barcode, v_quantity, v_item.price, v_item.price * v_quantity)
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
    v_total := v_total + v_item.price * v_quantity;
  end loop;
  update public.sales set total = v_total where id = v_sale_id;
  return v_sale_id;
end;
$function$;

create or replace function public.receive_purchase(p_purchase_id uuid, p_serial_numbers_by_item jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_purchase public.purchases%rowtype;
  v_line public.purchase_lines%rowtype;
  v_item public.items%rowtype;
  v_numbers jsonb;
  v_number jsonb;
  v_count integer;
  v_now timestamptz := now();
begin
  if not app_private.is_admin() then raise exception '管理員權限不足'; end if;
  select * into v_purchase from public.purchases where id = p_purchase_id for update;
  if not found or v_purchase.status <> 'draft' then raise exception '進貨單不存在或已收貨'; end if;
  if jsonb_typeof(p_serial_numbers_by_item) is distinct from 'object' then raise exception '收貨序號格式無效'; end if;
  if exists (select 1 from jsonb_object_keys(p_serial_numbers_by_item) key
    where not exists (select 1 from public.purchase_lines where purchase_id = p_purchase_id and item_id::text = key)) then
    raise exception '收貨序號品項不在進貨單';
  end if;
  if not exists (select 1 from public.purchase_lines where purchase_id = p_purchase_id) then raise exception '進貨單沒有明細'; end if;
  for v_line in select * from public.purchase_lines where purchase_id = p_purchase_id order by item_id loop
    select * into v_item from public.items where id = v_line.item_id for update;
    if not found or v_item.supplier_id is distinct from v_purchase.supplier_id then raise exception '品項供應商已變更，請修改草稿'; end if;
    v_numbers := coalesce(p_serial_numbers_by_item->(v_item.id::text), '[]'::jsonb);
    if jsonb_typeof(v_numbers) is distinct from 'array' then raise exception '收貨序號格式無效'; end if;
    v_count := jsonb_array_length(v_numbers);
    if v_item.category in ('車身', '電池') then
      -- 序號選填：可以不填，有填就不能超過收貨數量。
      if v_count > v_line.quantity then raise exception '收貨序號數超過收貨數量'; end if;
    elsif v_count <> 0 then raise exception '非序號品項不可填寫序號'; end if;
    for v_number in select value from jsonb_array_elements(v_numbers) loop
      if jsonb_typeof(v_number) <> 'string' or nullif(trim(v_number #>> '{}'), '') is null then
        raise exception '原廠序號無效';
      end if;
    end loop;
  end loop;
  for v_line in select * from public.purchase_lines where purchase_id = p_purchase_id order by item_id loop
    update public.items set stock = stock + v_line.quantity where id = v_line.item_id;
    insert into public.item_costs (item_id, cost, updated_by) values (v_line.item_id, v_line.unit_cost, auth.uid())
      on conflict (item_id) do update set cost = excluded.cost, updated_by = excluded.updated_by, updated_at = v_now;
    -- 售價加成：該分類有設定加成、且品項沒有勾「固定售價」時，用這次進貨單價重算售價（無條件進位到 10 元）。
    update public.items i set price = app_private.markup_price_for(i.category, v_line.unit_cost)
      where i.id = v_line.item_id and not i.price_locked
        and app_private.markup_price_for(i.category, v_line.unit_cost) is not null;
    insert into public.inventory_transactions (item_id, type, quantity, note, purchase_id, created_by)
      values (v_line.item_id, 'in', v_line.quantity, '進貨收貨：' || v_purchase.purchase_number, p_purchase_id, auth.uid());
    for v_number in select value from jsonb_array_elements(coalesce(p_serial_numbers_by_item->(v_line.item_id::text), '[]'::jsonb)) loop
      insert into public.inventory_serials (item_id, serial_number, status, purchase_id, created_by)
      values (v_line.item_id, trim(v_number #>> '{}'), 'in_stock', p_purchase_id, auth.uid());
    end loop;
  end loop;
  update public.purchases set status = 'received', received_by = auth.uid(), received_at = v_now where id = p_purchase_id;
  return p_purchase_id;
end;
$function$;

create or replace function app_private.complete_repair_order(p_order_id uuid, p_serial_ids_by_line jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_order public.repair_orders%rowtype;
  v_line public.repair_lines%rowtype;
  v_item public.items%rowtype;
  v_serial public.inventory_serials%rowtype;
  v_serial_id uuid;
  v_serial_ids jsonb;
  v_serial_numbers text[];
  v_warranty_id uuid;
  v_today date := (now() at time zone 'Asia/Taipei')::date;
begin
  if not app_private.is_active_staff() then raise exception '帳號權限不足' using errcode='42501'; end if;
  if jsonb_typeof(p_serial_ids_by_line) is distinct from 'object' then raise exception '維修序號格式無效'; end if;
  select * into v_order from public.repair_orders where id=p_order_id for update;
  if not found or v_order.status <> 'quoted' then raise exception '維修單未報價或已完工'; end if;
  if exists (select 1 from jsonb_object_keys(p_serial_ids_by_line) as k(key)
    where not exists (select 1 from public.repair_lines where id=k.key::uuid and repair_order_id=p_order_id)) then
    raise exception '維修序號行項不符';
  end if;
  for v_line in select * from public.repair_lines where repair_order_id=p_order_id order by item_id,id loop
    select * into v_item from public.items where id=v_line.item_id for update;
    if not found or v_item.category not in ('電池','電控元件','機構元件','外觀元件') or v_item.stock < v_line.quantity then raise exception '品項不適用或庫存不足'; end if;
    v_serial_ids := coalesce(p_serial_ids_by_line->(v_line.id::text),'[]'::jsonb);
    if jsonb_typeof(v_serial_ids) <> 'array' then raise exception '維修序號格式無效'; end if;
    v_serial_numbers := '{}';
    -- 序號選填、保固停用：電池可以不選序號、不必選會員；有選序號就不能超過數量。
    if v_item.category='電池' then
      if jsonb_array_length(v_serial_ids) > v_line.quantity then raise exception '所選電池序號數超過數量'; end if;
    elsif jsonb_array_length(v_serial_ids) <> 0 then
      raise exception '非電池品項不可指定序號';
    end if;
    for v_serial_id in select value::text::uuid from jsonb_array_elements_text(v_serial_ids) order by value::text::uuid loop
      select * into v_serial from public.inventory_serials where id=v_serial_id for update;
      if not found or v_serial.item_id <> v_item.id or v_serial.status <> 'in_stock' then
        raise exception '維修序號不可用或與品項不符'; end if;
      update public.inventory_serials set status='repair_used',repair_order_id=p_order_id,
        repair_line_id=v_line.id,customer_id=v_order.customer_id,warranty_id=null,
        repair_used_at=clock_timestamp() where id=v_serial_id;
      v_serial_numbers := array_append(v_serial_numbers,v_serial.serial_number);
    end loop;
    update public.items set stock=stock-v_line.quantity where id=v_item.id;
    insert into public.inventory_transactions(item_id,type,quantity,note,created_by,
      repair_order_id,customer_id,item_name,serial_numbers,serial_ids)
    values(v_item.id,'out',v_line.quantity,'維修單 ' || v_order.repair_number,auth.uid(),
      p_order_id,v_order.customer_id,v_item.name,v_serial_numbers,
      array(select value::text::uuid from jsonb_array_elements_text(v_serial_ids)));
  end loop;
  update public.repair_orders set status='completed',completed_at=clock_timestamp(),completed_by=auth.uid(),
    updated_at=clock_timestamp(),updated_by=auth.uid() where id=p_order_id;
  return p_order_id;
end;
$function$;

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
    warranty_months, notes, supplier_id, price_locked, vehicle_model_id, created_by)
  values (v_id, p_item->>'name', p_item->>'category', coalesce(p_item->>'sku', ''),
    coalesce(p_item->>'barcode', ''), (p_item->>'price')::numeric, v_stock,
    (p_item->>'minimum_stock')::integer, coalesce((p_item->>'warranty_months')::integer, 0),
    coalesce(p_item->>'notes', ''), nullif(p_item->>'supplier_id', '')::uuid,
    coalesce((p_item->>'price_locked')::boolean, false), nullif(p_item->>'vehicle_model_id', '')::uuid, auth.uid());
  insert into public.item_costs (item_id, cost, updated_by) values (v_id, p_cost, auth.uid());
  perform public.register_inventory_serials(v_id, p_serials);
  return v_id;
end;
$function$;
