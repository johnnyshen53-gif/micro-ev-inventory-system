begin;
insert into auth.users(id, email) values
  ('71000000-0000-4000-8000-000000000001', 'rs-admin@example.invalid'),
  ('71000000-0000-4000-8000-000000000002', 'rs-clerk@example.invalid');
update public.profiles set role = 'admin', active = true where id = '71000000-0000-4000-8000-000000000001';
update public.profiles set active = true where id = '71000000-0000-4000-8000-000000000002';
insert into auth.sessions(id, user_id) values
  ('71000000-0000-4000-8000-000000000011', '71000000-0000-4000-8000-000000000001'),
  ('71000000-0000-4000-8000-000000000012', '71000000-0000-4000-8000-000000000002');
insert into public.salespeople(id, name, active, created_by) values
  ('71000000-0000-4000-8000-000000000051', '甲業務', true, '71000000-0000-4000-8000-000000000001'),
  ('71000000-0000-4000-8000-000000000052', '乙業務', true, '71000000-0000-4000-8000-000000000001'),
  ('71000000-0000-4000-8000-000000000053', '離職業務', false, '71000000-0000-4000-8000-000000000001');
insert into public.items(id, name, category, sku, price, stock, created_by) values
  ('71000000-0000-4000-8000-000000000031', '煞車片', '零件', 'RS-PART', 100, 10, '71000000-0000-4000-8000-000000000001');

-- 店員：建立維修單時業務員必選，且不可選已停用的業務員。
select set_config('request.jwt.claim.sub', '71000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"71000000-0000-4000-8000-000000000002","session_id":"71000000-0000-4000-8000-000000000012"}', true);
set local role authenticated;
do $$
declare
  v_denied boolean;
  v_order uuid;
  v_version timestamptz;
  v_base jsonb := '{"customerName":"客人","customerPhone":"0911000000","plateNumber":"RS-1","vehicleName":"車型","issue":"保養"}'::jsonb;
  v_lines jsonb := jsonb_build_array(jsonb_build_object('itemId','71000000-0000-4000-8000-000000000031','quantity',2,'unitPrice',100));
begin
  v_denied := false;
  begin perform public.save_repair_order(v_base, v_lines); exception when others then v_denied := sqlerrm like '%請選擇業務員%'; end;
  if not v_denied then raise exception 'repair saved without salesperson'; end if;
  v_denied := false;
  begin perform public.save_repair_order(v_base || '{"salespersonId":"71000000-0000-4000-8000-000000000053"}', v_lines); exception when others then v_denied := sqlerrm like '%已停用%'; end;
  if not v_denied then raise exception 'repair saved with inactive salesperson'; end if;

  v_order := public.save_repair_order(v_base || '{"salespersonId":"71000000-0000-4000-8000-000000000051","laborAmount":300}', v_lines);
  if (select salesperson_id from public.repair_orders where id = v_order) <> '71000000-0000-4000-8000-000000000051' then
    raise exception 'salesperson not stored on new repair'; end if;
  -- 店員不可呼叫補登，也不可看月績效。
  v_denied := false;
  begin perform public.assign_repair_salesperson(v_order, '71000000-0000-4000-8000-000000000052'); exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'clerk reassigned repair salesperson'; end if;
  v_denied := false;
  begin perform * from public.get_monthly_salesperson_repairs('2026-10'); exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'clerk read repair performance'; end if;

  -- 報價、完工：完工後才算進當月。
  select updated_at into v_version from public.repair_orders where id = v_order;
  perform public.save_repair_order(v_base || jsonb_build_object('id', v_order, 'salespersonId', '71000000-0000-4000-8000-000000000051', 'laborAmount', 300, 'status', 'quoted'), v_lines, v_version);
  perform set_config('test.repair_order', v_order::text, true);
end $$;

-- 店長：完工、月績效、補登。
select set_config('request.jwt.claim.sub', '71000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"71000000-0000-4000-8000-000000000001","session_id":"71000000-0000-4000-8000-000000000011"}', true);
do $$
declare
  v_order uuid := current_setting('test.repair_order')::uuid;
  v_month text := to_char(now() at time zone 'Asia/Taipei', 'YYYY-MM');
  v_row record;
begin
  if exists (select 1 from public.get_monthly_salesperson_repairs(v_month)) then
    raise exception 'unfinished repair counted in monthly repairs'; end if;
  perform public.complete_repair_order(v_order, '{}'::jsonb);
  select * into v_row from public.get_monthly_salesperson_repairs(v_month);
  if v_row.salesperson_name <> '甲業務' or v_row.repair_count <> 1 or v_row.repair_total <> 500 then
    raise exception 'monthly repair total wrong: % % %', v_row.salesperson_name, v_row.repair_count, v_row.repair_total; end if;

end $$;

-- 模擬上線前的舊維修單：用管理連線把業務員清空。
reset role;
update public.repair_orders set salesperson_id = null where id = current_setting('test.repair_order')::uuid;
set local role authenticated;
do $$
declare
  v_order uuid := current_setting('test.repair_order')::uuid;
  v_month text := to_char(now() at time zone 'Asia/Taipei', 'YYYY-MM');
  v_row record;
begin
  -- 舊維修單（沒有業務員）算「未歸屬」，店長補登後歸到該業務員。
  select * into v_row from public.get_monthly_salesperson_repairs(v_month);
  if v_row.salesperson_id is not null or v_row.salesperson_name <> '未歸屬' then raise exception 'unattributed repair not labelled'; end if;
  perform public.assign_repair_salesperson(v_order, '71000000-0000-4000-8000-000000000052');
  select * into v_row from public.get_monthly_salesperson_repairs(v_month);
  if v_row.salesperson_name <> '乙業務' then raise exception 'assignment not applied'; end if;

  -- 下個月查不到這張單。
  if exists (select 1 from public.get_monthly_salesperson_repairs(to_char((now() at time zone 'Asia/Taipei') + interval '1 month', 'YYYY-MM'))) then
    raise exception 'repair leaked into next month'; end if;
end $$;
rollback;
