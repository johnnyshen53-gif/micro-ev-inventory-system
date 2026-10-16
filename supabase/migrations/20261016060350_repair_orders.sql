create sequence public.repair_order_number_seq;

create table public.repair_orders (
  id uuid primary key default gen_random_uuid(),
  repair_number text not null unique,
  customer_id uuid references public.customers(id),
  customer_name text not null check (length(trim(customer_name)) > 0),
  customer_phone text not null check (length(trim(customer_phone)) > 0),
  plate_number text not null default '',
  original_serial_number text not null default '',
  vehicle_name text not null check (length(trim(vehicle_name)) > 0),
  issue text not null check (length(trim(issue)) > 0),
  diagnosis text not null default '',
  labor_amount numeric(12,2) not null default 0 check (labor_amount >= 0),
  total numeric(12,2) not null default 0 check (total >= 0),
  status text not null default 'intake' check (status in ('intake','quoted','completed','cancelled')),
  payment_status text not null default 'unpaid' check (payment_status in ('unpaid','paid')),
  created_by uuid not null references public.profiles(id),
  updated_by uuid not null references public.profiles(id),
  quoted_by uuid references public.profiles(id),
  completed_by uuid references public.profiles(id),
  cancelled_by uuid references public.profiles(id),
  paid_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  quoted_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  paid_at timestamptz,
  check (plate_number <> '' or original_serial_number <> ''),
  check (payment_status = 'unpaid' or status = 'completed')
);

create table public.repair_lines (
  id uuid primary key default gen_random_uuid(),
  repair_order_id uuid not null references public.repair_orders(id),
  item_id uuid not null references public.items(id),
  item_name text not null,
  item_sku text not null default '',
  quantity integer not null check (quantity > 0),
  unit_price numeric(12,2) not null check (unit_price >= 0),
  subtotal numeric(12,2) not null check (subtotal >= 0)
);

create index repair_orders_created_at_idx on public.repair_orders(created_at desc);
create index repair_orders_customer_idx on public.repair_orders(customer_id);
create index repair_orders_phone_idx on public.repair_orders(customer_phone);
create index repair_orders_plate_idx on public.repair_orders(plate_number);
create index repair_orders_serial_idx on public.repair_orders(original_serial_number);
create index repair_lines_order_idx on public.repair_lines(repair_order_id);
create index repair_lines_item_idx on public.repair_lines(item_id);

alter table public.repair_orders enable row level security;
alter table public.repair_lines enable row level security;
revoke all on public.repair_orders, public.repair_lines from public, anon, authenticated;
grant select on public.repair_orders, public.repair_lines to authenticated;
create policy "active staff read repair orders" on public.repair_orders for select to authenticated
  using ((select app_private.is_active_staff()));
create policy "active staff read repair lines" on public.repair_lines for select to authenticated
  using ((select app_private.is_active_staff()));

create function app_private.save_repair_order(p_order jsonb, p_lines jsonb, p_expected_updated_at timestamptz default null)
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
    v_id := gen_random_uuid();
    v_number := nextval('public.repair_order_number_seq');
    insert into public.repair_orders(id,repair_number,customer_id,customer_name,customer_phone,
      plate_number,original_serial_number,vehicle_name,issue,diagnosis,labor_amount,created_by,updated_by)
    values (v_id,'R-' || to_char(now() at time zone 'Asia/Taipei','YYYYMMDD') || '-' ||
      lpad(v_number::text,greatest(4,length(v_number::text)),'0'),v_customer_id,v_customer_name,v_customer_phone,
      v_plate,v_serial,v_vehicle,v_issue,v_diagnosis,v_labor,auth.uid(),auth.uid());
  else
    select * into v_old from public.repair_orders where id = v_id for update;
    if not found or v_old.status not in ('intake','quoted') then raise exception '維修單不存在或已鎖定'; end if;
    if p_expected_updated_at is null or v_old.updated_at <> p_expected_updated_at then
      raise exception '維修單已由其他人修改，請重新載入';
    end if;
    if v_old.status = 'quoted' and v_status = 'intake' then raise exception '已報價維修單不可退回接修中'; end if;
    update public.repair_orders set customer_id=v_customer_id,customer_name=v_customer_name,customer_phone=v_customer_phone,
      plate_number=v_plate,original_serial_number=v_serial,vehicle_name=v_vehicle,issue=v_issue,
      diagnosis=v_diagnosis,labor_amount=v_labor,status=v_status,updated_by=auth.uid(),updated_at=clock_timestamp(),
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

create function public.save_repair_order(p_order jsonb, p_lines jsonb, p_expected_updated_at timestamptz default null)
returns uuid language sql security invoker set search_path = '' as $$
  select app_private.save_repair_order(p_order,p_lines,p_expected_updated_at)
$$;

create function app_private.cancel_repair_order(p_order_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
begin
  if not app_private.is_active_staff() then raise exception '帳號權限不足' using errcode = '42501'; end if;
  update public.repair_orders set status='cancelled',cancelled_at=clock_timestamp(),cancelled_by=auth.uid(),
    updated_at=clock_timestamp(),updated_by=auth.uid()
    where id=p_order_id and status in ('intake','quoted');
  if not found then raise exception '維修單不存在或不可取消'; end if;
  return p_order_id;
end;
$$;

create function public.cancel_repair_order(p_order_id uuid)
returns uuid language sql security invoker set search_path = '' as $$
  select app_private.cancel_repair_order(p_order_id)
$$;

create function app_private.mark_repair_paid(p_order_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
begin
  if not app_private.is_active_staff() then raise exception '帳號權限不足' using errcode = '42501'; end if;
  update public.repair_orders set payment_status='paid',paid_at=clock_timestamp(),paid_by=auth.uid(),
    updated_at=clock_timestamp(),updated_by=auth.uid()
    where id=p_order_id and status='completed' and payment_status='unpaid';
  if not found then raise exception '維修單尚未完工或已收款'; end if;
  return p_order_id;
end;
$$;

create function public.mark_repair_paid(p_order_id uuid)
returns uuid language sql security invoker set search_path = '' as $$
  select app_private.mark_repair_paid(p_order_id)
$$;

revoke all on sequence public.repair_order_number_seq from public,anon,authenticated;
revoke all on function app_private.save_repair_order(jsonb,jsonb,timestamptz),public.save_repair_order(jsonb,jsonb,timestamptz),
  app_private.cancel_repair_order(uuid),public.cancel_repair_order(uuid),
  app_private.mark_repair_paid(uuid),public.mark_repair_paid(uuid) from public,anon,authenticated;
grant execute on function app_private.save_repair_order(jsonb,jsonb,timestamptz),public.save_repair_order(jsonb,jsonb,timestamptz),
  app_private.cancel_repair_order(uuid),public.cancel_repair_order(uuid),
  app_private.mark_repair_paid(uuid),public.mark_repair_paid(uuid) to authenticated;
