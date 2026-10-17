-- 維修人員與維修分紅。
-- 1. 儲存維修單時一併寫入維修人員（內容與 20261018010000 相同，只加入維修人員處理）。
create or replace function app_private.save_repair_order(p_order jsonb, p_lines jsonb, p_expected_updated_at timestamptz default null)
returns uuid language plpgsql security definer set search_path = '' as $$
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
  v_status text := coalesce(p_order->>'status','intake');
  v_salesperson uuid := nullif(p_order->>'salespersonId','')::uuid;
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
    or v_vehicle = '' or v_issue = '' or v_labor < 0 or v_status not in ('intake','quoted') then
    raise exception '維修單資料無效';
  end if;
  if v_customer_id is not null then
    select name, phone into v_customer_name, v_customer_phone from public.customers
      where id = v_customer_id and active;
    if not found then raise exception '會員不存在或已停用'; end if;
  end if;
  if v_customer_name = '' or v_customer_phone = '' then raise exception '請填客戶姓名與電話'; end if;
  if v_salesperson is null then raise exception '請選擇業務員'; end if;
  if v_id is null then
    if v_status <> 'intake' then raise exception '新維修單必須先接修'; end if;
    perform 1 from public.salespeople where id = v_salesperson and active;
    if not found then raise exception '業務員不存在或已停用，請重新選擇'; end if;
    -- 維修人員儲存時可空白（完工時才必選）；有選就必須在職。
    if v_technician is not null then
      perform 1 from public.repair_technicians where id = v_technician and active;
      if not found then raise exception '維修人員不存在或已停用，請重新選擇'; end if;
    end if;
    v_id := gen_random_uuid();
    v_number := nextval('public.repair_order_number_seq');
    insert into public.repair_orders(id,repair_number,customer_id,customer_name,customer_phone,
      plate_number,original_serial_number,vehicle_name,issue,diagnosis,labor_amount,salesperson_id,technician_id,created_by,updated_by)
    values (v_id,'R-' || to_char(now() at time zone 'Asia/Taipei','YYYYMMDD') || '-' ||
      lpad(v_number::text,greatest(4,length(v_number::text)),'0'),v_customer_id,v_customer_name,v_customer_phone,
      v_plate,v_serial,v_vehicle,v_issue,v_diagnosis,v_labor,v_salesperson,v_technician,auth.uid(),auth.uid());
  else
    select * into v_old from public.repair_orders where id = v_id for update;
    if not found or v_old.status not in ('intake','quoted') then raise exception '維修單不存在或已鎖定'; end if;
    if p_expected_updated_at is null or v_old.updated_at <> p_expected_updated_at then
      raise exception '維修單已由其他人修改，請重新載入';
    end if;
    if v_old.status = 'quoted' and v_status = 'intake' then raise exception '已報價維修單不可退回接修中'; end if;
    -- 換成另一位業務員時才檢查是否仍在職；沿用原本的業務員即使已停用也可繼續編輯。
    if v_salesperson is distinct from v_old.salesperson_id then
      perform 1 from public.salespeople where id = v_salesperson and active;
      if not found then raise exception '業務員不存在或已停用，請重新選擇'; end if;
    end if;
    -- 維修人員同理：換人時才檢查在職。
    if v_technician is not null and v_technician is distinct from v_old.technician_id then
      perform 1 from public.repair_technicians where id = v_technician and active;
      if not found then raise exception '維修人員不存在或已停用，請重新選擇'; end if;
    end if;
    update public.repair_orders set customer_id=v_customer_id,customer_name=v_customer_name,customer_phone=v_customer_phone,
      plate_number=v_plate,original_serial_number=v_serial,vehicle_name=v_vehicle,issue=v_issue,
      diagnosis=v_diagnosis,labor_amount=v_labor,salesperson_id=v_salesperson,technician_id=v_technician,status=v_status,updated_by=auth.uid(),updated_at=clock_timestamp(),
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
    if not found or v_item.category not in ('零件','用品','電池') or v_quantity is null or v_quantity <= 0
      or v_price is null or v_price < 0 then raise exception '維修用料資料無效'; end if;
    insert into public.repair_lines(repair_order_id,item_id,item_name,item_sku,quantity,unit_price,subtotal)
      values(v_id,v_item.id,v_item.name,v_item.sku,v_quantity,v_price,v_quantity*v_price);
    v_total := v_total + v_quantity*v_price;
  end loop;
  update public.repair_orders set total=v_total where id=v_id;
  return v_id;
end;
$$;

-- 2. 維修單狀態變成「已完工」時自動執行（觸發器）。它和扣庫存、建保固在同一筆交易內，
--    這裡 raise 會讓整張維修單的完工全部取消，不會留下已扣庫存卻沒完工的結果。
create or replace function app_private.record_repair_bonus()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_name text;
  v_active boolean;
  v_percent numeric(5,2);
  v_unconfirmed text;
  v_cost numeric(12,2);
  v_lines jsonb;
  v_net numeric(12,2);
begin
  if new.technician_id is null then raise exception '請先指定維修人員再確認完工'; end if;
  select name, active into v_name, v_active from public.repair_technicians where id = new.technician_id;
  if not coalesce(v_active, false) then raise exception '維修人員已停用，請重新指定'; end if;
  select repair_bonus_percent into v_percent from app_private.bonus_settings where id;
  -- 百分比未設定＝功能未啟用：不記帳、也不檢查成本。
  if v_percent is null then return null; end if;
  select l.item_name into v_unconfirmed
    from public.repair_lines l left join public.item_costs c on c.item_id = l.item_id
    where l.repair_order_id = new.id and not coalesce(c.cost_confirmed, false)
    order by l.item_name limit 1;
  if found then
    raise exception '用料「%」成本尚未確認，請店長在分紅管理確認後再完工', v_unconfirmed;
  end if;
  select coalesce(sum(l.quantity * c.cost), 0),
    coalesce(jsonb_agg(jsonb_build_object('itemId', l.item_id, 'itemName', l.item_name,
      'quantity', l.quantity, 'unitCost', c.cost) order by l.id), '[]'::jsonb)
    into v_cost, v_lines
    from public.repair_lines l join public.item_costs c on c.item_id = l.item_id
    where l.repair_order_id = new.id;
  v_net := greatest(new.total - v_cost, 0);
  insert into app_private.repair_bonus_records(repair_order_id, repair_number, technician_id, technician_name,
    repair_total, parts_cost, net_amount, bonus_percent, bonus_amount, cost_lines, occurred_at)
  values (new.id, new.repair_number, new.technician_id, v_name, new.total, v_cost, v_net, v_percent,
    round(v_net * v_percent / 100, 2), v_lines, coalesce(new.completed_at, clock_timestamp()));
  return null;
end;
$$;
revoke all on function app_private.record_repair_bonus() from public, anon, authenticated;
create trigger repair_orders_record_bonus
  after update of status on public.repair_orders
  for each row when (old.status <> 'completed' and new.status = 'completed')
  execute function app_private.record_repair_bonus();
