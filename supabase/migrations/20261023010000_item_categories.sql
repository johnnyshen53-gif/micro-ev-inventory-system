-- 2026-10 品項分類改版：機車／零件／用品／電池 → 車身／電池／電控元件／機構元件／外觀元件
--
-- 規則對照：
--   車身＝整台車（原「機車」）：要登記原廠序號、有保固、可列入機車獎金，不能當維修用料。
--   電池：不變。
--   電控元件／機構元件／外觀元件：取代原「零件」「用品」，可當維修用料。
--
-- 1. 資料：先檢查，再把「機車」直接改名「車身」。「零件」「用品」無法自動判斷要歸哪一類，
--    若還有這兩類的品項就中止遷移，請先清除測試資料或在網站上改好分類再執行。
-- 2. 品項表加上分類檢查，資料庫只接受五種新分類。
-- 3. 10 個資料庫函式中寫死的舊分類名稱改成新分類（只換分類字串，其餘邏輯不變）。
--    函式內容由「套用前全部遷移的結果」自動替換後匯出，替換規則：
--      '機車' → '車身'
--      ('零件','用品','電池') → ('電池','電控元件','機構元件','外觀元件')

do $$
begin
  if exists (select 1 from public.items where category in ('零件', '用品')) then
    raise exception '仍有「零件」或「用品」分類的品項。請先清除測試資料，或在網站上把這些品項改成新分類後，再執行此遷移。';
  end if;
end $$;

-- 先檢查再改資料：檢查不通過時，資料完全不會被動到。
update public.items set category = '車身' where category = '機車';

alter table public.items alter column category set default '電控元件';
alter table public.items add constraint items_category_check
  check (category in ('車身', '電池', '電控元件', '機構元件', '外觀元件'));

CREATE OR REPLACE FUNCTION app_private.complete_repair_order(p_order_id uuid, p_serial_ids_by_line jsonb)
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
    if v_item.category='電池' then
      if v_order.customer_id is null then raise exception '電池維修須選擇既有會員'; end if;
      if not exists (select 1 from public.customers where id=v_order.customer_id and active) then raise exception '維修會員已停用'; end if;
      if v_item.warranty_months <= 0 then raise exception '電池品項須設定保固月數'; end if;
      if jsonb_array_length(v_serial_ids) <> v_line.quantity then raise exception '電池序號數量不符'; end if;
      if (select count(*) from public.inventory_serials where item_id=v_item.id and status='in_stock') <> v_item.stock then
        raise exception '在庫序號尚未補齊'; end if;
    elsif jsonb_array_length(v_serial_ids) <> 0 then
      raise exception '非電池品項不可指定序號';
    end if;
    for v_serial_id in select value::text::uuid from jsonb_array_elements_text(v_serial_ids) order by value::text::uuid loop
      select * into v_serial from public.inventory_serials where id=v_serial_id for update;
      if not found or v_serial.item_id <> v_item.id or v_serial.status <> 'in_stock' then
        raise exception '維修序號不可用或與品項不符'; end if;
      insert into public.warranties(customer_id,customer_name,item_id,item_name,barcode,source,
        serial_id,serial_number,repair_order_id,purchased_at,expires_at,created_by)
      values(v_order.customer_id,v_order.customer_name,v_item.id,v_item.name,v_item.barcode,'repair',
        v_serial.id,v_serial.serial_number,p_order_id,v_today,
        (v_today + make_interval(months=>v_item.warranty_months))::date,auth.uid())
      returning id into v_warranty_id;
      update public.inventory_serials set status='repair_used',repair_order_id=p_order_id,
        repair_line_id=v_line.id,customer_id=v_order.customer_id,warranty_id=v_warranty_id,
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
$function$
;

CREATE OR REPLACE FUNCTION app_private.create_sale_with_serials(p_lines jsonb, p_customer_id uuid, p_sale_id uuid)
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
    if v_item.category in ('車身','電池') then
      if p_customer_id is null or jsonb_array_length(v_serial_ids) <> v_quantity then raise exception '序號銷售須指定客戶與足量序號'; end if;
      if (select count(*) from public.inventory_serials where item_id = v_item.id and status = 'in_stock') <> v_item.stock then
        raise exception '在庫序號尚未補齊';
      end if;
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
      if v_item.warranty_months > 0 then
        insert into public.warranties (customer_id, customer_name, item_id, item_name, barcode, source,
          sale_id, sale_line_id, sale_number, serial_id, serial_number, purchased_at, expires_at, created_by)
        values (p_customer_id, v_customer_name, v_item.id, v_item.name, v_item.barcode, 'sale',
          v_sale_id, v_line_id, v_sale_number, v_serial.id, v_serial.serial_number, v_purchased_at,
          (v_purchased_at + make_interval(months => v_item.warranty_months))::date, auth.uid());
      end if;
    end loop;
    if p_customer_id is not null and v_item.warranty_months > 0 and v_item.category not in ('車身','電池') then
      insert into public.warranties (customer_id, customer_name, item_id, item_name, barcode, source,
        sale_id, sale_line_id, sale_number, purchased_at, expires_at, created_by)
      values (p_customer_id, v_customer_name, v_item.id, v_item.name, v_item.barcode, 'sale',
        v_sale_id, v_line_id, v_sale_number, v_purchased_at,
        (v_purchased_at + make_interval(months => v_item.warranty_months))::date, auth.uid());
    end if;
    insert into public.inventory_transactions (item_id, type, quantity, note, created_by)
      values (v_item.id, 'out', v_quantity, '銷售管理 ' || v_sale_number, auth.uid());
    v_total := v_total + v_item.price * v_quantity;
  end loop;
  update public.sales set total = v_total where id = v_sale_id;
  return v_sale_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION app_private.get_bonus_admin_state()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not app_private.is_admin() then raise exception '只有店長可以查看分紅設定' using errcode = '42501'; end if;
  return jsonb_build_object(
    'motorcycleBonusAmount', (select motorcycle_bonus_amount from app_private.bonus_settings where id),
    'repairBonusPercent', (select repair_bonus_percent from app_private.bonus_settings where id),
    'recipientIds', coalesce((select jsonb_agg(salesperson_id order by salesperson_id) from app_private.motorcycle_bonus_recipients), '[]'::jsonb),
    'motorcycleItemIds', coalesce((select jsonb_agg(item_id order by item_id) from app_private.motorcycle_bonus_items), '[]'::jsonb),
    'partCosts', coalesce((select jsonb_agg(jsonb_build_object('itemId', i.id, 'name', i.name, 'category', i.category,
        'cost', c.cost, 'confirmed', coalesce(c.cost_confirmed, false)) order by i.category, i.name)
      from public.items i left join public.item_costs c on c.item_id = i.id
      where i.category in ('電池','電控元件','機構元件','外觀元件')), '[]'::jsonb),
    'technicians', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'active', active) order by active desc, name)
      from public.salespeople where is_technician), '[]'::jsonb));
end;
$function$
;

CREATE OR REPLACE FUNCTION app_private.issue_warranty_replacement(p_item_id uuid, p_quantity integer, p_warranty_id uuid, p_serial_ids uuid[], p_note text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_item public.items%rowtype;
  v_warranty public.warranties%rowtype;
  v_serial public.inventory_serials%rowtype;
  v_serial_id uuid;
  v_numbers text[] := '{}';
  v_now timestamptz := now();
  v_id uuid := gen_random_uuid();
  v_cost numeric(12,2);
  v_expired boolean;
  v_note text;
begin
  if not app_private.is_active_staff() then raise exception '帳號權限不足'; end if;
  if p_quantity is null or p_quantity <= 0 or nullif(trim(p_note), '') is null then raise exception '出保固數量或原因無效'; end if;
  select * into v_warranty from public.warranties where id = p_warranty_id;
  if not found then raise exception '原保固不存在'; end if;
  -- 原保固已過期：店員不可出保固；店長可放行，並在原因前加註記，方便日後查核。
  v_expired := v_warranty.expires_at < (now() at time zone 'Asia/Taipei')::date;
  if v_expired and not app_private.is_admin() then
    raise exception '原保固已於 % 到期，僅店長可放行出保固', v_warranty.expires_at using errcode = '42501';
  end if;
  v_note := trim(p_note);
  if v_expired and left(v_note, 8) <> '[過期保固放行]' then v_note := '[過期保固放行] ' || v_note; end if;
  select * into v_item from public.items where id = p_item_id for update;
  if not found or v_item.stock < p_quantity then raise exception '品項不存在或庫存不足'; end if;
  if v_item.category in ('車身','電池') then
    if coalesce(array_length(p_serial_ids, 1), 0) <> p_quantity or
      (select count(*) from public.inventory_serials where item_id = p_item_id and status = 'in_stock') <> v_item.stock then
      raise exception '出保固序號數量或在庫狀態不符';
    end if;
  elsif coalesce(array_length(p_serial_ids, 1), 0) <> 0 then raise exception '非序號品項不可指定序號'; end if;
  foreach v_serial_id in array coalesce(p_serial_ids, '{}'::uuid[]) loop
    select * into v_serial from public.inventory_serials where id = v_serial_id for update;
    if not found or v_serial.item_id <> p_item_id or v_serial.status <> 'in_stock' then
      raise exception '出保固序號不可用或與品項不符';
    end if;
    v_numbers := array_append(v_numbers, v_serial.serial_number);
    update public.inventory_serials set status = 'warranty_out', warranty_id = p_warranty_id,
      customer_id = v_warranty.customer_id, removed_at = v_now, removed_by = auth.uid(),
      removal_reason = v_note where id = v_serial_id;
  end loop;
  select cost into v_cost from public.item_costs where item_id = p_item_id;
  update public.items set stock = stock - p_quantity where id = p_item_id;
  insert into public.inventory_transactions (id, item_id, type, quantity, note, warranty_id, customer_id,
    item_name, expires_at, unit_cost_snapshot, serial_ids, serial_numbers, created_by, created_at)
  values (v_id, p_item_id, 'out', p_quantity, v_note, p_warranty_id, v_warranty.customer_id,
    v_item.name, v_warranty.expires_at, coalesce(v_cost, 0), coalesce(p_serial_ids, '{}'::uuid[]), v_numbers,
    auth.uid(), v_now);
  return v_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION app_private.save_repair_order(p_order jsonb, p_lines jsonb, p_expected_updated_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_id uuid := nullif(p_order->>'id','')::uuid;
  v_customer_id uuid := nullif(p_order->>'customerId','')::uuid;
  v_customer_name text := trim(coalesce(p_order->>'customerName',''));
  v_customer_phone text := trim(coalesce(p_order->>'customerPhone',''));
  v_plate text := trim(coalesce(p_order->>'plateNumber',''));
  v_serial text := trim(coalesce(p_order->>'originalSerialNumber',''));
  v_vehicle text := trim(coalesce(p_order->>'vehicleName',''));
  v_issue text := trim(coalesce(p_order->>'issue',''));
  v_diagnosis text := trim(coalesce(p_order->>'diagnosis',''));
  v_labor numeric(12,2) := coalesce((p_order->>'laborAmount')::numeric,0);
  -- 工時與計算當下的費率快照：兩者同時有值或同時空白（空白＝直接輸入工資）。
  v_hours numeric(8,2) := nullif(p_order->>'laborHours','')::numeric;
  v_rate numeric(12,2) := nullif(p_order->>'laborRate','')::numeric;
  v_status text := coalesce(p_order->>'status','intake');
  v_technician uuid := nullif(p_order->>'technicianId','')::uuid;
  v_old public.repair_orders%rowtype;
  v_item public.items%rowtype;
  v_line jsonb;
  v_quantity integer;
  v_price numeric(12,2);
  v_total numeric(12,2);
  v_number bigint;
begin
  if not app_private.is_active_staff() then raise exception '帳號權限不足' using errcode = '42501'; end if;
  if jsonb_typeof(p_lines) is distinct from 'array' or v_plate = '' and v_serial = ''
    or v_vehicle = '' or v_issue = '' or v_labor < 0 or v_status not in ('intake','quoted')
    or coalesce(v_hours,0) < 0 or coalesce(v_rate,0) < 0 or (v_hours is null) <> (v_rate is null) then
    raise exception '維修單資料無效';
  end if;
  if v_customer_id is not null then
    select name, phone into v_customer_name, v_customer_phone from public.customers
      where id = v_customer_id and active;
    if not found then raise exception '會員不存在或已停用'; end if;
  end if;
  if v_customer_name = '' or v_customer_phone = '' then raise exception '請填客戶姓名與電話'; end if;
  if v_id is null then
    if v_status <> 'intake' then raise exception '新維修單必須先接修'; end if;
    -- 維修人員儲存時可空白（完工時才必選）；有選就必須在職。
    if v_technician is not null then
      perform 1 from public.salespeople where id = v_technician and active and is_technician;
      if not found then raise exception '維修人員不存在、已停用或未勾選維修員身分，請重新選擇'; end if;
    end if;
    v_id := gen_random_uuid();
    v_number := nextval('public.repair_order_number_seq');
    insert into public.repair_orders(id,repair_number,customer_id,customer_name,customer_phone,
      plate_number,original_serial_number,vehicle_name,issue,diagnosis,labor_amount,labor_hours,labor_rate,technician_id,created_by,updated_by)
    values (v_id,'R-' || to_char(now() at time zone 'Asia/Taipei','YYYYMMDD') || '-' ||
      lpad(v_number::text,greatest(4,length(v_number::text)),'0'),v_customer_id,v_customer_name,v_customer_phone,
      v_plate,v_serial,v_vehicle,v_issue,v_diagnosis,v_labor,v_hours,v_rate,v_technician,auth.uid(),auth.uid());
  else
    select * into v_old from public.repair_orders where id = v_id for update;
    if not found or v_old.status not in ('intake','quoted') then raise exception '維修單不存在或已鎖定'; end if;
    if p_expected_updated_at is null or v_old.updated_at <> p_expected_updated_at then
      raise exception '維修單已由其他人修改，請重新載入';
    end if;
    if v_old.status = 'quoted' and v_status = 'intake' then raise exception '已報價維修單不可退回接修中'; end if;
    -- 維修人員同理：換人時才檢查在職。
    if v_technician is not null and v_technician is distinct from v_old.technician_id then
      perform 1 from public.salespeople where id = v_technician and active and is_technician;
      if not found then raise exception '維修人員不存在、已停用或未勾選維修員身分，請重新選擇'; end if;
    end if;
    update public.repair_orders set customer_id=v_customer_id,customer_name=v_customer_name,customer_phone=v_customer_phone,
      plate_number=v_plate,original_serial_number=v_serial,vehicle_name=v_vehicle,issue=v_issue,
      diagnosis=v_diagnosis,labor_amount=v_labor,labor_hours=v_hours,labor_rate=v_rate,technician_id=v_technician,status=v_status,updated_by=auth.uid(),updated_at=clock_timestamp(),
      quoted_by=case when v_old.status='intake' and v_status='quoted' then auth.uid() else quoted_by end,
      quoted_at=case when v_old.status='intake' and v_status='quoted' then clock_timestamp() else quoted_at end
      where id=v_id;
    delete from public.repair_lines where repair_order_id=v_id;
  end if;
  v_total := v_labor;
  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_quantity := (v_line->>'quantity')::integer;
    v_price := (v_line->>'unitPrice')::numeric;
    select * into v_item from public.items where id = (v_line->>'itemId')::uuid;
    if not found or v_item.category not in ('電池','電控元件','機構元件','外觀元件') or v_quantity is null or v_quantity <= 0
      or v_price is null or v_price < 0 then raise exception '維修用料資料無效'; end if;
    insert into public.repair_lines(repair_order_id,item_id,item_name,item_sku,quantity,unit_price,subtotal)
      values(v_id,v_item.id,v_item.name,v_item.sku,v_quantity,v_price,v_quantity*v_price);
    v_total := v_total + v_quantity*v_price;
  end loop;
  update public.repair_orders set total=v_total where id=v_id;
  return v_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION app_private.validate_imported_relations(p_state jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_row jsonb;
begin
  if not app_private.is_admin() then raise exception '只有店長可以執行首次資料移轉'; end if;
  for v_row in select value from jsonb_array_elements(coalesce(p_state->'serials','[]'::jsonb)) loop
    if exists (
      select 1 from public.inventory_serials s
      left join public.sale_lines l on l.id = s.sale_line_id
      left join public.sales sale on sale.id = l.sale_id
      where s.id = (v_row->>'id')::uuid and (
        (s.sale_line_id is not null and (l.item_id is distinct from s.item_id
          or sale.customer_id is distinct from s.customer_id))
        or (s.status = 'sold' and (s.sale_line_id is null or s.customer_id is null))
        or (s.status <> 'sold' and s.sale_line_id is not null)
        or (s.purchase_id is not null and not exists (
          select 1 from public.purchase_lines pl join public.purchases p on p.id = pl.purchase_id
          where pl.purchase_id = s.purchase_id and pl.item_id = s.item_id and p.status = 'received'))
        or (s.status = 'warranty_out' and (s.warranty_id is null or not exists (
          select 1 from public.warranties w where w.id = s.warranty_id
            and w.customer_id = s.customer_id)))
        or (s.status <> 'warranty_out' and s.warranty_id is not null)
      )
    ) then raise exception '備份實物序號關聯無效：%', v_row->>'id'; end if;
  end loop;
  for v_row in select value from jsonb_array_elements(coalesce(p_state->'warranties','[]'::jsonb)) loop
    if exists (
      select 1 from public.warranties w
      left join public.sale_lines l on l.id = w.sale_line_id
      left join public.sales sale on sale.id = l.sale_id
      left join public.inventory_serials s on s.id = w.serial_id
      where w.id = (v_row->>'id')::uuid and (
        (w.source = 'sale' and (l.item_id is distinct from w.item_id
          or sale.customer_id is distinct from w.customer_id))
        or (w.serial_id is not null and (s.item_id is distinct from w.item_id
          or s.customer_id is distinct from w.customer_id
          or s.sale_line_id is distinct from w.sale_line_id
          or s.serial_number is distinct from w.serial_number or s.status <> 'sold'))
      )
    ) then raise exception '備份保固關聯無效：%', v_row->>'id'; end if;
  end loop;
  if exists (
    select 1 from public.items i
    where i.category in ('車身','電池') and (
      select count(*) from public.inventory_serials s where s.item_id = i.id and s.status = 'in_stock'
    ) > i.stock
  ) then raise exception '在庫序號超過雲端庫存'; end if;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.create_serialized_item(p_item jsonb, p_cost numeric, p_serials jsonb)
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
    or p_serials is null or jsonb_typeof(p_serials) <> 'array' or jsonb_array_length(p_serials) <> v_stock then
    raise exception '品項與原廠序號數量不相符';
  end if;
  insert into public.items (id, name, category, sku, barcode, price, stock, minimum_stock,
    warranty_months, notes, supplier_id, created_by)
  values (v_id, p_item->>'name', p_item->>'category', coalesce(p_item->>'sku', ''),
    coalesce(p_item->>'barcode', ''), (p_item->>'price')::numeric, v_stock,
    (p_item->>'minimum_stock')::integer, coalesce((p_item->>'warranty_months')::integer, 0),
    coalesce(p_item->>'notes', ''), nullif(p_item->>'supplier_id', '')::uuid, auth.uid());
  insert into public.item_costs (item_id, cost, updated_by) values (v_id, p_cost, auth.uid());
  perform public.register_inventory_serials(v_id, p_serials);
  return v_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.receive_purchase(p_purchase_id uuid, p_serial_numbers_by_item jsonb)
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
      if v_count <> v_line.quantity then raise exception '收貨序號數量不符'; end if;
      if (select count(*) from public.inventory_serials where item_id = v_item.id and status = 'in_stock') <> v_item.stock then
        raise exception '在庫序號尚未補齊';
      end if;
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
$function$
;

CREATE OR REPLACE FUNCTION public.register_inventory_serials(p_item_id uuid, p_serials jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_item public.items%rowtype;
  v_serial jsonb;
  v_count integer;
begin
  if not app_private.is_admin() then raise exception '管理員權限不足' using errcode = '42501'; end if;
  if p_serials is null or jsonb_typeof(p_serials) <> 'array' or jsonb_array_length(p_serials) = 0 then
    raise exception '請輸入原廠序號';
  end if;
  select * into v_item from public.items where id = p_item_id for update;
  if not found then raise exception '品項不存在'; end if;
  if v_item.category not in ('車身', '電池') then raise exception '此品項不使用原廠序號'; end if;
  select count(*) into v_count from public.inventory_serials where item_id = p_item_id and status = 'in_stock';
  if v_count + jsonb_array_length(p_serials) > v_item.stock then raise exception '原廠序號數量超過現有庫存'; end if;
  for v_serial in select value from jsonb_array_elements(p_serials) loop
    if jsonb_typeof(v_serial) <> 'object' or nullif(trim(v_serial->>'serialNumber'), '') is null
      or nullif(v_serial->>'id', '') is null then raise exception '原廠序號資料不完整'; end if;
    insert into public.inventory_serials (id, item_id, serial_number, status, created_by)
      values ((v_serial->>'id')::uuid, p_item_id, trim(v_serial->>'serialNumber'), 'in_stock', auth.uid());
  end loop;
  return jsonb_array_length(p_serials);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.save_warranty(p_warranty jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_id uuid := (p_warranty->>'id')::uuid;
  v_customer uuid := (p_warranty->>'customerId')::uuid;
  v_item uuid := (p_warranty->>'itemId')::uuid;
  v_serial uuid := nullif(p_warranty->>'serialId', '')::uuid;
  v_line uuid := nullif(p_warranty->>'saleId', '')::uuid;
  v_sale uuid;
  v_old public.warranties%rowtype;
  v_customer_name text;
  v_item_row public.items%rowtype;
  v_serial_row public.inventory_serials%rowtype;
  v_purchased date := (p_warranty->>'purchasedAt')::date;
  v_expires date := (p_warranty->>'expiresAt')::date;
begin
  if not app_private.is_active_staff() then raise exception '帳號權限不足'; end if;
  if v_id is null or v_purchased is null or v_expires is null or v_expires < v_purchased then raise exception '保固日期無效'; end if;
  select * into v_old from public.warranties where id = v_id for update;
  if found then
    if v_old.customer_id <> v_customer or v_old.item_id <> v_item or v_old.source <> p_warranty->>'source'
      or v_old.serial_id is distinct from v_serial or v_old.sale_line_id is distinct from v_line then
      raise exception '保固來源與商品不可更改';
    end if;
    update public.warranties set purchased_at = v_purchased, expires_at = v_expires,
      note = coalesce(p_warranty->>'note', '') where id = v_id;
    return v_id;
  end if;
  select name into v_customer_name from public.customers where id = v_customer;
  if not found then raise exception '保固客戶不存在'; end if;
  select * into v_item_row from public.items where id = v_item;
  if not found then raise exception '保固品項不存在'; end if;
  if v_serial is not null then
    select * into v_serial_row from public.inventory_serials where id = v_serial;
    if not found or v_serial_row.status <> 'sold' or v_serial_row.item_id <> v_item
      or v_serial_row.customer_id <> v_customer or v_serial_row.sale_line_id is distinct from v_line then
      raise exception '保固序號與客戶或品項不相符';
    end if;
  elsif v_item_row.category in ('車身', '電池') then raise exception '序號品項必須指定已售序號'; end if;
  if v_line is not null then
    select s.id into v_sale from public.sale_lines sl join public.sales s on s.id = sl.sale_id
      where sl.id = v_line and sl.item_id = v_item and s.customer_id = v_customer;
    if not found then raise exception '保固銷售來源不相符'; end if;
  elsif p_warranty->>'source' <> 'manual' then raise exception '銷售保固必須有銷售來源'; end if;
  insert into public.warranties (id, customer_id, customer_name, item_id, item_name, barcode, source,
    sale_id, sale_line_id, sale_number, serial_id, serial_number, purchased_at, expires_at, note, created_by)
  values (v_id, v_customer, v_customer_name, v_item, v_item_row.name, v_item_row.barcode,
    p_warranty->>'source', v_sale, v_line, coalesce(p_warranty->>'saleNumber', ''),
    v_serial, coalesce(v_serial_row.serial_number, ''), v_purchased, v_expires,
    coalesce(p_warranty->>'note', ''), auth.uid());
  return v_id;
end;
$function$
;
