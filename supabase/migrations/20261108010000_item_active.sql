-- 品項停用（只有店長能設定）：items.active，預設啟用。
-- 停用的品項：不能入庫（庫存異動「進貨」、品項編輯加庫存）、不能加入進貨單或收貨、不能銷售、不能報價。
-- 出庫、盤點更正仍可操作（方便把剩下的庫存清掉）；已建立的紀錄不受影響。
alter table public.items add column active boolean not null default true;

create or replace function public.adjust_inventory(p_item_id uuid, p_type text, p_quantity integer, p_note text DEFAULT ''::text)
 RETURNS items
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare v_item public.items%rowtype; v_next integer;
begin
  if not app_private.is_admin() then raise exception '僅店長可調整庫存' using errcode = '42501'; end if;
  if p_type not in ('in', 'out', 'set') or p_quantity < 0 then raise exception '庫存異動資料無效'; end if;
  select * into v_item from public.items where id = p_item_id for update;
  if not found then raise exception '找不到品項'; end if;
  if p_type = 'in' and not v_item.active then raise exception '品項「%」已停用，無法入庫', v_item.name; end if;
  v_next := case when p_type = 'in' then v_item.stock + p_quantity when p_type = 'out' then v_item.stock - p_quantity else p_quantity end;
  if v_next < 0 then raise exception '庫存不足，無法出庫'; end if;
  update public.items set stock = v_next where id = p_item_id returning * into v_item;
  insert into public.inventory_transactions(item_id, type, quantity, note, created_by)
    values (p_item_id, p_type, p_quantity, coalesce(p_note, ''), auth.uid());
  return v_item;
end;
$function$;

create or replace function public.save_purchase(p_purchase jsonb, p_lines jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_id uuid := (p_purchase->>'id')::uuid;
  v_supplier public.suppliers%rowtype;
  v_old public.purchases%rowtype;
  v_item public.items%rowtype;
  v_line jsonb;
  v_quantity integer;
  v_cost numeric(12,2);
  v_total numeric(12,2) := 0;
  v_snapshot jsonb;
begin
  if not app_private.is_admin() then raise exception '管理員權限不足'; end if;
  if v_id is null or coalesce(p_purchase->>'number', '') !~ '^P[0-9]{11}$'
    or jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception '進貨資料不完整';
  end if;
  select * into v_old from public.purchases where id = v_id for update;
  if found and v_old.status <> 'draft' then raise exception '已收貨進貨單不可修改'; end if;
  select * into v_supplier from public.suppliers where id = (p_purchase->>'supplierId')::uuid;
  if not found or (v_old.id is null and not v_supplier.active) then raise exception '供應商不存在或已停用'; end if;
  v_snapshot := jsonb_build_object('name', v_supplier.name, 'contact', v_supplier.contact,
    'phone', v_supplier.phone, 'address', v_supplier.address, 'taxId', v_supplier.tax_id);
  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_quantity := (v_line->>'quantity')::integer;
    v_cost := (v_line->>'unitCost')::numeric;
    if v_quantity is null or v_quantity <= 0 or v_cost is null or v_cost < 0 or v_cost * 100 <> trunc(v_cost * 100) then
      raise exception '進貨數量或成本無效';
    end if;
    select * into v_item from public.items where id = (v_line->>'itemId')::uuid and supplier_id = v_supplier.id;
    if not found then raise exception '進貨品項不屬於供應商'; end if;
    if not v_item.active then raise exception '品項「%」已停用，不能加入進貨單', v_item.name; end if;
    v_total := v_total + v_quantity * v_cost;
  end loop;
  if v_total is distinct from (p_purchase->>'total')::numeric then raise exception '進貨總額無效'; end if;
  if v_old.id is null then
    insert into public.purchases (id, purchase_number, supplier_id, supplier_snapshot, total, note, created_by)
    values (v_id, p_purchase->>'number', v_supplier.id, v_snapshot, v_total,
      coalesce(p_purchase->>'note', ''), auth.uid());
  else
    update public.purchases set supplier_id = v_supplier.id, supplier_snapshot = v_snapshot,
      total = v_total, note = coalesce(p_purchase->>'note', '') where id = v_id;
    delete from public.purchase_lines where purchase_id = v_id;
  end if;
  for v_line in select value from jsonb_array_elements(p_lines) loop
    select * into v_item from public.items where id = (v_line->>'itemId')::uuid;
    v_quantity := (v_line->>'quantity')::integer;
    v_cost := (v_line->>'unitCost')::numeric;
    insert into public.purchase_lines (purchase_id, item_id, item_name, item_sku, item_barcode, quantity, unit_cost, subtotal)
    values (v_id, v_item.id, v_item.name, v_item.sku, v_item.barcode, v_quantity, v_cost, v_quantity * v_cost);
  end loop;
  return v_id;
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
    if not v_item.active then raise exception '品項「%」已停用，無法收貨入庫，請先修改進貨單', v_item.name; end if;
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
    if not v_item.active then raise exception '品項「%」已停用，無法銷售', v_item.name; end if;
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
    if not v_item.active then raise exception '品項「%」已停用，無法報價', v_item.name; end if;
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
