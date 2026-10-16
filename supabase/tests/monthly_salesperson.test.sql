begin;

insert into auth.users(id, email) values ('40000000-0000-4000-8000-000000000001', 'monthly-admin@example.invalid');
update public.profiles set role = 'admin', active = true where id = '40000000-0000-4000-8000-000000000001';
insert into auth.sessions(id, user_id) values
  ('40000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000001');
select set_config('request.jwt.claim.sub', '40000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"40000000-0000-4000-8000-000000000001","session_id":"40000000-0000-4000-8000-000000000002"}', true);
set local role authenticated;

do $$
declare
  v_actor uuid := auth.uid();
  v_person uuid := gen_random_uuid();
  v_item uuid := gen_random_uuid();
  v_sale uuid;
  v_before integer;
  v_denied boolean;
begin
  insert into public.salespeople(id, name, active, created_by) values (v_person, '甲業務', true, v_actor);
  insert into public.items(id, name, price, stock, created_by) values (v_item, '測試品', 100, 3, v_actor);
  v_before := (select stock from public.items where id = v_item);
  v_denied := false;
  begin
    perform public.create_sale_with_serials(jsonb_build_array(jsonb_build_object('item_id',v_item,'quantity',1)), null::uuid, null::uuid);
  exception when others then v_denied := true;
  end;
  if not v_denied or (select stock from public.items where id = v_item) <> v_before then
    raise exception 'missing salesperson changed stock';
  end if;
  v_denied := false;
  begin
    perform public.create_sale_with_serials(jsonb_build_array(jsonb_build_object('item_id',v_item,'quantity',1)), null::uuid, gen_random_uuid());
  exception when others then v_denied := true;
  end;
  if not v_denied or (select stock from public.items where id = v_item) <> v_before then
    raise exception 'unknown salesperson changed stock';
  end if;
  update public.salespeople set active = false where id = v_person;
  v_denied := false;
  begin
    perform public.create_sale_with_serials(jsonb_build_array(jsonb_build_object('item_id',v_item,'quantity',1)), null::uuid, v_person);
  exception when others then v_denied := true;
  end;
  if not v_denied or (select stock from public.items where id = v_item) <> v_before then
    raise exception 'inactive salesperson changed stock';
  end if;
  update public.salespeople set active = true where id = v_person;
  v_sale := public.create_sale_with_serials(jsonb_build_array(jsonb_build_object('item_id',v_item,'quantity',1)), null::uuid, v_person);
  if (select stock from public.items where id = v_item) <> 2
    or (select count(*) from public.audit_logs where target_id = v_sale and action = 'sale_created') <> 1 then
    raise exception 'sale or audit missing';
  end if;
  v_denied := false;
  begin
    perform public.create_sale_with_serials(jsonb_build_array(jsonb_build_object('item_id',v_item,'quantity',1)), null::uuid);
  exception when others then v_denied := true;
  end;
  if not v_denied then raise exception 'old sale RPC bypasses salesperson'; end if;
  v_denied := false;
  begin
    perform public.create_sale(jsonb_build_array(jsonb_build_object('item_id',v_item,'quantity',1)), null::uuid);
  exception when others then v_denied := true;
  end;
  if not v_denied then raise exception 'legacy sale RPC bypasses salesperson'; end if;
  v_denied := false;
  begin
    perform public.create_sale(jsonb_build_array(jsonb_build_object('item_id',v_item,'quantity',1)));
  exception when others then v_denied := true;
  end;
  if not v_denied then raise exception 'single-argument sale RPC bypasses salesperson'; end if;
  if has_table_privilege('authenticated', 'app_private.sale_salesperson_attributions', 'SELECT') then
    raise exception 'authenticated can read private attribution';
  end if;
end;
$$;

reset role;
do $$
begin
  if (select count(*) from app_private.sale_salesperson_attributions
      where salesperson_name = '甲業務' and salesperson_id in
        (select id from public.salespeople where name = '甲業務')) <> 1 then
    raise exception 'private sale attribution missing';
  end if;
end;
$$;

rollback;

begin;
insert into auth.users(id, email) values
  ('50000000-0000-4000-8000-000000000001', 'report-admin@example.invalid'),
  ('50000000-0000-4000-8000-000000000002', 'report-clerk@example.invalid');
update public.profiles set role = 'admin', active = true where id = '50000000-0000-4000-8000-000000000001';
insert into auth.sessions(id, user_id) values
  ('50000000-0000-4000-8000-000000000011', '50000000-0000-4000-8000-000000000001'),
  ('50000000-0000-4000-8000-000000000012', '50000000-0000-4000-8000-000000000002');
insert into public.salespeople(id, name, active, created_by) values
  ('50000000-0000-4000-8000-000000000021', '張業務', false, '50000000-0000-4000-8000-000000000001');
insert into public.items(id, name, price, stock, created_by) values
  ('50000000-0000-4000-8000-000000000022', '測試品', 100, 10, '50000000-0000-4000-8000-000000000001');
insert into public.sales(id, sale_number, total, created_by, created_at) values
  ('50000000-0000-4000-8000-000000000031', 'OCT-START', 250, '50000000-0000-4000-8000-000000000001', '2026-09-30 16:00:00+00'),
  ('50000000-0000-4000-8000-000000000032', 'OCT-END', 50, '50000000-0000-4000-8000-000000000001', '2026-10-31 15:59:59+00'),
  ('50000000-0000-4000-8000-000000000033', 'SEP-END', 40, '50000000-0000-4000-8000-000000000001', '2026-09-30 15:59:59+00'),
  ('50000000-0000-4000-8000-000000000034', 'NOV-START', 60, '50000000-0000-4000-8000-000000000001', '2026-10-31 16:00:00+00'),
  ('50000000-0000-4000-8000-000000000035', 'OLD-UNATTRIBUTED', 70, '50000000-0000-4000-8000-000000000001', '2026-10-15 04:00:00+00');
insert into public.sale_lines(sale_id,item_id,item_name,quantity,unit_price,subtotal) values
  ('50000000-0000-4000-8000-000000000031','50000000-0000-4000-8000-000000000022','測試品',2,100,200),
  ('50000000-0000-4000-8000-000000000031','50000000-0000-4000-8000-000000000022','測試品',1,50,50),
  ('50000000-0000-4000-8000-000000000032','50000000-0000-4000-8000-000000000022','測試品',1,50,50);
insert into app_private.sale_salesperson_attributions(sale_id,salesperson_id,salesperson_name) values
  ('50000000-0000-4000-8000-000000000031','50000000-0000-4000-8000-000000000021','舊名'),
  ('50000000-0000-4000-8000-000000000032','50000000-0000-4000-8000-000000000021','張業務'),
  ('50000000-0000-4000-8000-000000000033','50000000-0000-4000-8000-000000000021','張業務'),
  ('50000000-0000-4000-8000-000000000034','50000000-0000-4000-8000-000000000021','張業務');
select set_config('request.jwt.claim.sub', '50000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"50000000-0000-4000-8000-000000000001","session_id":"50000000-0000-4000-8000-000000000011"}', true);
set local role authenticated;
do $$
declare
  v_rows integer;
  v_quantity bigint;
  v_total numeric;
  v_name text;
  v_denied boolean := false;
begin
  select count(*), max(quantity) filter (where salesperson_id is not null),
    max(total) filter (where salesperson_id is not null),
    max(salesperson_name) filter (where salesperson_id is not null)
    into v_rows, v_quantity, v_total, v_name
    from public.get_monthly_salesperson_performance('2026-10');
  if v_rows <> 2 or v_quantity <> 4 or v_total <> 300 or v_name <> '張業務' then
    raise exception 'Taipei month, stable ID, or order amount aggregation is wrong';
  end if;
  if (select count(*) from public.get_monthly_salesperson_performance('2026-10')
      where salesperson_id is null and salesperson_name = '未歸屬' and quantity = 0 and total = 70) <> 1 then
    raise exception 'legacy sale is not shown as unattributed';
  end if;
  if (select count(*) from public.sales where created_at >= '2026-09-30 16:00:00+00'
      and created_at < '2026-10-31 16:00:00+00') <> 3 then
    raise exception 'legacy unattributed sale missing from monthly overview';
  end if;
  begin perform public.get_monthly_salesperson_performance('2026-13');
  exception when others then v_denied := true;
  end;
  if not v_denied then raise exception 'invalid month accepted'; end if;
  if has_table_privilege('authenticated', 'app_private.sale_salesperson_attributions', 'SELECT')
    or has_function_privilege('anon', 'public.get_monthly_salesperson_performance(text)', 'EXECUTE') then
    raise exception 'personal performance has unsafe direct privileges';
  end if;
  perform set_config('request.jwt.claim.sub', '50000000-0000-4000-8000-000000000002', true);
  perform set_config('request.jwt.claims', '{"sub":"50000000-0000-4000-8000-000000000002","session_id":"50000000-0000-4000-8000-000000000012"}', true);
  v_denied := false;
  begin perform public.get_monthly_salesperson_performance('2026-10');
  exception when others then v_denied := true;
  end;
  if not v_denied then raise exception 'clerk read personal performance'; end if;
end;
$$;
rollback;
