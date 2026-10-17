-- 維修單歸屬業務員，並在月銷售的業務員績效加入維修金額。
-- 1. 維修單新增業務員欄位；新增／編輯維修單時必選（舊維修單維持空白＝未歸屬，店長可補登）。
alter table public.repair_orders add column if not exists salesperson_id uuid references public.salespeople(id);
create index if not exists repair_orders_salesperson_idx on public.repair_orders(salesperson_id);

-- 2. 儲存維修單時一併寫入業務員（內容與 20261016060350 相同，只加入業務員處理）。
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
    v_id := gen_random_uuid();
    v_number := nextval('public.repair_order_number_seq');
    insert into public.repair_orders(id,repair_number,customer_id,customer_name,customer_phone,
      plate_number,original_serial_number,vehicle_name,issue,diagnosis,labor_amount,salesperson_id,created_by,updated_by)
    values (v_id,'R-' || to_char(now() at time zone 'Asia/Taipei','YYYYMMDD') || '-' ||
      lpad(v_number::text,greatest(4,length(v_number::text)),'0'),v_customer_id,v_customer_name,v_customer_phone,
      v_plate,v_serial,v_vehicle,v_issue,v_diagnosis,v_labor,v_salesperson,auth.uid(),auth.uid());
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
    update public.repair_orders set customer_id=v_customer_id,customer_name=v_customer_name,customer_phone=v_customer_phone,
      plate_number=v_plate,original_serial_number=v_serial,vehicle_name=v_vehicle,issue=v_issue,
      diagnosis=v_diagnosis,labor_amount=v_labor,salesperson_id=v_salesperson,status=v_status,updated_by=auth.uid(),updated_at=clock_timestamp(),
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

-- 3. 店長補登或更正任何狀態維修單的業務員（例如舊維修單、已完工維修單）。
create or replace function app_private.assign_repair_salesperson(p_order_id uuid, p_salesperson_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_number text;
begin
  if not app_private.is_admin() then raise exception '只有店長可以補登維修單業務員' using errcode = '42501'; end if;
  if p_salesperson_id is null then raise exception '請選擇業務員'; end if;
  perform 1 from public.salespeople where id = p_salesperson_id;
  if not found then raise exception '業務員不存在'; end if;
  update public.repair_orders set salesperson_id = p_salesperson_id, updated_by = auth.uid(), updated_at = clock_timestamp()
    where id = p_order_id returning repair_number into v_number;
  if not found then raise exception '維修單不存在'; end if;
  insert into public.audit_logs(actor_id, action, target_type, target_id, summary)
    values (auth.uid(), 'repair.assign_salesperson', 'repair_order', p_order_id,
      jsonb_build_object('repair_number', v_number, 'salesperson_id', p_salesperson_id));
end;
$$;
create or replace function public.assign_repair_salesperson(p_order_id uuid, p_salesperson_id uuid)
returns void language sql security invoker set search_path = '' as $$
  select app_private.assign_repair_salesperson(p_order_id, p_salesperson_id)
$$;

-- 4. 業務員當月維修：完工日在當月的維修單，金額為維修單總額（工資＋用料）。
create or replace function app_private.get_monthly_salesperson_repairs(p_month text)
returns table (salesperson_id uuid, salesperson_name text, repair_count bigint, repair_total numeric)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_first date;
  v_start timestamptz;
  v_end timestamptz;
begin
  if not app_private.is_admin() then
    raise exception '只有店長可以查看業務員績效' using errcode = '42501';
  end if;
  if p_month is null or p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception '月份格式必須為 YYYY-MM';
  end if;
  v_first := make_date(left(p_month, 4)::integer, right(p_month, 2)::integer, 1);
  v_start := v_first::timestamp at time zone 'Asia/Taipei';
  v_end := (v_first + interval '1 month')::timestamp at time zone 'Asia/Taipei';
  return query
    select p.id, coalesce(p.name, '未歸屬'), count(*)::bigint, sum(r.total)
    from public.repair_orders r
    left join public.salespeople p on p.id = r.salesperson_id
    where r.status = 'completed' and r.completed_at >= v_start and r.completed_at < v_end
    group by p.id, p.name
    order by (p.id is null), sum(r.total) desc, p.name;
end;
$$;
create or replace function public.get_monthly_salesperson_repairs(p_month text)
returns table (salesperson_id uuid, salesperson_name text, repair_count bigint, repair_total numeric)
language sql stable security invoker set search_path = '' as $$
  select * from app_private.get_monthly_salesperson_repairs(p_month)
$$;

revoke all on function app_private.assign_repair_salesperson(uuid, uuid), public.assign_repair_salesperson(uuid, uuid),
  app_private.get_monthly_salesperson_repairs(text), public.get_monthly_salesperson_repairs(text) from public, anon, authenticated;
grant execute on function app_private.assign_repair_salesperson(uuid, uuid), public.assign_repair_salesperson(uuid, uuid),
  app_private.get_monthly_salesperson_repairs(text), public.get_monthly_salesperson_repairs(text) to authenticated;
