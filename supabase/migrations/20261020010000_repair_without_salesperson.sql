-- 維修單不再需要業務員，只需要維修人員（完工前必選）。
-- 內容與 20261019030000 相同，只移除業務員必選與在職檢查：
--   * 新維修單不寫入業務員。
--   * 編輯既有維修單時不更動 salesperson_id，舊單已記錄的業務員保留不刪。
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
  if v_id is null then
    if v_status <> 'intake' then raise exception '新維修單必須先接修'; end if;
    -- 維修人員儲存時可空白（完工時才必選）；有選就必須在職。
    if v_technician is not null then
      perform 1 from public.repair_technicians where id = v_technician and active;
      if not found then raise exception '維修人員不存在或已停用，請重新選擇'; end if;
    end if;
    v_id := gen_random_uuid();
    v_number := nextval('public.repair_order_number_seq');
    insert into public.repair_orders(id,repair_number,customer_id,customer_name,customer_phone,
      plate_number,original_serial_number,vehicle_name,issue,diagnosis,labor_amount,technician_id,created_by,updated_by)
    values (v_id,'R-' || to_char(now() at time zone 'Asia/Taipei','YYYYMMDD') || '-' ||
      lpad(v_number::text,greatest(4,length(v_number::text)),'0'),v_customer_id,v_customer_name,v_customer_phone,
      v_plate,v_serial,v_vehicle,v_issue,v_diagnosis,v_labor,v_technician,auth.uid(),auth.uid());
  else
    select * into v_old from public.repair_orders where id = v_id for update;
    if not found or v_old.status not in ('intake','quoted') then raise exception '維修單不存在或已鎖定'; end if;
    if p_expected_updated_at is null or v_old.updated_at <> p_expected_updated_at then
      raise exception '維修單已由其他人修改，請重新載入';
    end if;
    if v_old.status = 'quoted' and v_status = 'intake' then raise exception '已報價維修單不可退回接修中'; end if;
    -- 維修人員同理：換人時才檢查在職。
    if v_technician is not null and v_technician is distinct from v_old.technician_id then
      perform 1 from public.repair_technicians where id = v_technician and active;
      if not found then raise exception '維修人員不存在或已停用，請重新選擇'; end if;
    end if;
    update public.repair_orders set customer_id=v_customer_id,customer_name=v_customer_name,customer_phone=v_customer_phone,
      plate_number=v_plate,original_serial_number=v_serial,vehicle_name=v_vehicle,issue=v_issue,
      diagnosis=v_diagnosis,labor_amount=v_labor,technician_id=v_technician,status=v_status,updated_by=auth.uid(),updated_at=clock_timestamp(),
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
