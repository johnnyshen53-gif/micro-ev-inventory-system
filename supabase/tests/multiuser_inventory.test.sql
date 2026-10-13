-- Run as postgres. All test fixtures are rolled back; no customer data is changed.
begin;
do $$
declare
  v_table text;
begin
  if to_regclass('public.profiles') is null then
    raise exception 'profiles table is missing';
  end if;
  if to_regclass('public.items') is null then
    raise exception 'items table is missing';
  end if;
  if to_regclass('public.item_costs') is null then
    raise exception 'item_costs table is missing';
  end if;
  if to_regclass('public.sales') is null then
    raise exception 'sales table is missing';
  end if;
  if to_regclass('public.audit_logs') is null then
    raise exception 'audit_logs table is missing';
  end if;
  foreach v_table in array array['warranties', 'warranty_cases'] loop
    if to_regclass('public.' || v_table) is null then
      raise exception '% table is missing', v_table;
    end if;
    if not (select relrowsecurity from pg_class where oid = to_regclass('public.' || v_table)) then
      raise exception '% RLS is disabled', v_table;
    end if;
    if has_table_privilege('anon', 'public.' || v_table, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
      or has_table_privilege('authenticated', 'public.' || v_table, 'TRUNCATE') then
      raise exception '% has unsafe grants', v_table;
    end if;
    -- Admins and clerks share authenticated: DELETE grant must be guarded by admin RLS.
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = v_table
      and cmd = 'DELETE' and qual like '%app_private.is_admin()%')
      or exists (select 1 from pg_policies where schemaname = 'public' and tablename = v_table
      and cmd in ('ALL', 'DELETE') and (qual is null or qual not like '%app_private.is_admin()%')) then
      raise exception '% has missing or clerk-accessible delete policy', v_table;
    end if;
  end loop;
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
    and table_name = 'items' and column_name = 'warranty_months' and data_type = 'integer'
    and is_nullable = 'NO' and column_default = '0') then
    raise exception 'items.warranty_months integer not null default 0 is missing';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
    and table_name = 'sales' and column_name = 'customer_id' and data_type = 'uuid' and is_nullable = 'YES') then
    raise exception 'sales.customer_id nullable uuid is missing';
  end if;
  if to_regprocedure('public.create_sale(jsonb,uuid)') is null
    or to_regprocedure('app_private.create_sale(jsonb,uuid)') is null then
    raise exception 'customer-aware sale RPC is missing';
  end if;
  if has_function_privilege('anon', 'public.create_sale(jsonb,uuid)', 'EXECUTE')
    or has_function_privilege('anon', 'app_private.create_sale(jsonb,uuid)', 'EXECUTE') then
    raise exception 'anonymous sale RPC access is enabled';
  end if;
end $$;

select
  relname,
  relrowsecurity as rls_enabled
from pg_class
where oid in (
  'public.profiles'::regclass,
  'public.items'::regclass,
  'public.item_costs'::regclass,
  'public.sales'::regclass,
  'public.audit_logs'::regclass
)
and relrowsecurity is false;

select proname
from pg_proc
where oid = 'public.create_sale(jsonb,uuid)'::regprocedure;

do $$
declare
  v_user uuid := gen_random_uuid();
  v_session uuid := gen_random_uuid();
  v_customer uuid := gen_random_uuid();
  v_item uuid := gen_random_uuid();
  v_other_item uuid := gen_random_uuid();
  v_no_warranty_item uuid := gen_random_uuid();
  v_sale uuid;
  v_warranty uuid;
  v_case uuid;
  v_count integer;
  v_stock integer;
begin
  insert into auth.users (id) values (v_user);
  update public.profiles set active=true where id=v_user;
  insert into auth.sessions (id,user_id) values (v_session,v_user);
  insert into public.customers (id, member_number, name, created_by)
    values (v_customer, 'test-' || v_customer, 'Warranty SQL test', v_user);
  insert into public.items (id, name, price, stock, warranty_months, created_by) values
    (v_item, 'Warranty SQL item', 100, 10, 1, v_user),
    (v_other_item, 'Warranty SQL second item', 200, 10, 12, v_user),
    (v_no_warranty_item, 'Warranty SQL zero item', 50, 10, 0, v_user);
  begin
    update public.items set warranty_months = -1 where id = v_item;
    raise exception 'negative warranty months accepted';
  exception when check_violation then null;
  end;
  perform set_config('request.jwt.claim.sub', v_user::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('session_id',v_session)::text, true);
  set local role authenticated;
  v_sale := public.create_sale(jsonb_build_array(
    jsonb_build_object('item_id', v_item, 'quantity', 2),
    jsonb_build_object('item_id', v_other_item, 'quantity', 1),
    jsonb_build_object('item_id', v_no_warranty_item, 'quantity', 1)), v_customer);
  if (select count(*) from public.warranties where sale_id = v_sale) <> 2
    or (select total from public.sales where id = v_sale) <> 450 then
    raise exception 'multi-line sale warranties or total are incorrect';
  end if;
  if exists (select 1 from public.warranties where sale_id = v_sale
    and (purchased_at <> (now() at time zone 'Asia/Taipei')::date
      or expires_at <> (purchased_at + make_interval(months => case when item_id = v_item then 1 else 12 end))::date)) then
    raise exception 'warranty calendar expiry or Taipei purchase date is incorrect';
  end if;
  if (date '2024-01-31' + make_interval(months => 1))::date <> date '2024-02-29' then
    raise exception 'month-end calendar addition failed';
  end if;
  v_sale := public.create_sale(jsonb_build_array(jsonb_build_object('item_id', v_item, 'quantity', 1)), null);
  if exists (select 1 from public.warranties where sale_id = v_sale) then
    raise exception 'sale without customer created a warranty';
  end if;
  perform public.create_sale(jsonb_build_array(jsonb_build_object('item_id', v_item, 'quantity', 1)));
  begin
    perform public.create_sale(null, null);
    raise exception 'NULL sale accepted';
  exception when raise_exception then
    if sqlerrm = 'NULL sale accepted' then raise; end if;
  end;
  select stock into v_stock from public.items where id = v_item;
  begin
    perform public.create_sale(jsonb_build_array(
      jsonb_build_object('item_id', v_item, 'quantity', 1),
      jsonb_build_object('item_id', v_other_item, 'quantity', 999)), v_customer);
    raise exception 'insufficient stock sale accepted';
  exception when raise_exception then
    if sqlerrm = 'insufficient stock sale accepted' then raise; end if;
  end;
  if (select stock from public.items where id = v_item) <> v_stock then
    raise exception 'failed multi-line sale changed stock';
  end if;
  insert into public.warranties (customer_id, customer_name, item_id, item_name, source, purchased_at, expires_at, created_by)
    values (v_customer, 'Warranty SQL test', v_item, 'Manual snapshot', 'manual', '2024-01-31', '2024-02-29', v_user)
    returning id into v_warranty;
  insert into public.warranty_cases (warranty_id, issue, item_name, purchased_at, expires_at, created_by)
    values (v_warranty, 'Test repair', 'Manual snapshot', '2024-01-31', '2024-02-29', v_user)
    returning id into v_case;
  update public.warranties set note = 'Clerk can edit', expires_at = '2024-03-31' where id = v_warranty;
  if not exists (select 1 from public.warranties where id = v_warranty
    and note = 'Clerk can edit' and expires_at = date '2024-03-31') then
    raise exception 'clerk warranty update did not persist note and expiry';
  end if;
  update public.warranty_cases set status = 'in_progress', resolution_note = 'Clerk can edit' where id = v_case;
  if (select expires_at from public.warranty_cases where id = v_case) <> date '2024-02-29' then
    raise exception 'case date snapshot changed with warranty';
  end if;
  begin
    update public.warranty_cases set status = 'invalid' where id = v_case;
    raise exception 'invalid case status accepted';
  exception when check_violation then null;
  end;
  delete from public.warranty_cases where id = v_case;
  get diagnostics v_count = row_count;
  if v_count <> 0 then raise exception 'clerk deleted warranty case'; end if;
  delete from public.warranties where id = v_warranty;
  get diagnostics v_count = row_count;
  if v_count <> 0 then raise exception 'clerk deleted warranty'; end if;
  update public.items set warranty_months = 99 where id = v_item;
  get diagnostics v_count = row_count;
  if v_count <> 0 then raise exception 'clerk changed warranty months'; end if;
  reset role;
  update public.profiles set active = false where id = v_user;
  set local role authenticated;
  if exists (select 1 from public.warranties where id = v_warranty)
    or exists (select 1 from public.warranty_cases where id = v_case) then
    raise exception 'inactive staff can read warranties or cases';
  end if;
  begin
    perform public.create_sale(jsonb_build_array(jsonb_build_object('item_id', v_item, 'quantity', 1)), v_customer);
    raise exception 'inactive staff created sale';
  exception when raise_exception then
    if sqlerrm = 'inactive staff created sale' then raise; end if;
  end;
  reset role;
  update public.profiles set active = true, role = 'admin' where id = v_user;
  set local role authenticated;
  delete from public.warranties where id = v_warranty;
  get diagnostics v_count = row_count;
  if v_count <> 1 or exists (select 1 from public.warranty_cases where id = v_case) then
    raise exception 'admin delete or case cascade failed';
  end if;
  select stock into v_stock from public.items where id = v_item;
  perform public.adjust_inventory(v_item, 'in', 2, 'SQL atomic adjustment test');
  if (select stock from public.items where id = v_item) <> v_stock + 2
    or not exists (select 1 from public.inventory_transactions where item_id = v_item and type = 'in' and quantity = 2 and note = 'SQL atomic adjustment test') then
    raise exception 'atomic inventory adjustment did not persist';
  end if;
  begin
    perform public.adjust_inventory(v_item, 'out', 999999, 'must fail');
    raise exception 'insufficient adjustment accepted';
  exception when raise_exception then
    if sqlerrm = 'insufficient adjustment accepted' then raise; end if;
  end;
  reset role;
end $$;
rollback;
