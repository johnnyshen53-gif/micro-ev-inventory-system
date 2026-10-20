-- 店員身分（20261021010000）：同一人可同時是業務員與維修員；選單與分紅只認對應身分。
begin;
insert into auth.users(id, email) values
  ('73000000-0000-4000-8000-000000000001', 'role-admin@example.invalid'),
  ('73000000-0000-4000-8000-000000000002', 'role-clerk@example.invalid');
update public.profiles set role = 'admin', active = true where id = '73000000-0000-4000-8000-000000000001';
update public.profiles set role = 'clerk', active = true where id = '73000000-0000-4000-8000-000000000002';
insert into auth.sessions(id, user_id) values
  ('73000000-0000-4000-8000-000000000011', '73000000-0000-4000-8000-000000000001'),
  ('73000000-0000-4000-8000-000000000012', '73000000-0000-4000-8000-000000000002');
-- 51：業務＋維修；52：只有業務；53：只有維修。
insert into public.salespeople(id, name, active, is_sales, is_technician) values
  ('73000000-0000-4000-8000-000000000051', '全能店員', true, true, true),
  ('73000000-0000-4000-8000-000000000052', '純業務', true, true, false),
  ('73000000-0000-4000-8000-000000000053', '純維修', true, false, true);
insert into public.items(id, name, category, sku, price, stock) values
  ('73000000-0000-4000-8000-000000000031', '獎金車款', '電控元件', 'R-MOTO', 1000, 20);
create function pg_temp.sale_bonus() returns setof app_private.sale_bonus_records
  language sql security definer as $$ select * from app_private.sale_bonus_records $$;
create function pg_temp.repair_bonus() returns setof app_private.repair_bonus_records
  language sql security definer as $$ select * from app_private.repair_bonus_records $$;

do $$
begin
  -- 兩個身分都不勾：拒絕。
  begin
    insert into public.salespeople(name, is_sales, is_technician) values ('無身分', false, false);
    raise exception 'staff without any role was accepted';
  exception when check_violation then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', '73000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"73000000-0000-4000-8000-000000000001","session_id":"73000000-0000-4000-8000-000000000011"}', true);
set local role authenticated;
do $$
declare
  v_lines jsonb := jsonb_build_array(jsonb_build_object('item_id','73000000-0000-4000-8000-000000000031','quantity',1));
  v_base jsonb := '{"customerName":"客人","customerPhone":"0911000000","plateNumber":"R-1","vehicleName":"車型","issue":"保養","laborAmount":100}'::jsonb;
  v_failed text;
  v_order uuid;
begin
  perform public.save_bonus_settings(500, 10,
    array['73000000-0000-4000-8000-000000000051','73000000-0000-4000-8000-000000000052','73000000-0000-4000-8000-000000000053']::uuid[],
    array['73000000-0000-4000-8000-000000000031']::uuid[]);

  -- 結帳：只有「業務員」身分可以當結帳業務員。
  v_failed := null;
  begin perform public.create_sale_with_serials(v_lines, null::uuid, '73000000-0000-4000-8000-000000000053', gen_random_uuid());
  exception when others then v_failed := sqlerrm; end;
  if v_failed is null or v_failed not like '%未勾選業務員身分%' then raise exception 'technician-only staff checked out: %', v_failed; end if;

  -- 機車獎金：名單內只有「業務員」身分的人受領（純維修即使在名單內也不發）。
  perform public.create_sale_with_serials(v_lines, null::uuid, '73000000-0000-4000-8000-000000000052', gen_random_uuid());
  if (select count(*) from pg_temp.sale_bonus()) <> 2
    or exists (select 1 from pg_temp.sale_bonus() where salesperson_id = '73000000-0000-4000-8000-000000000053') then
    raise exception 'motorcycle bonus recipients wrong'; end if;

  -- 維修單：只有「維修員」身分可以指定為維修人員。
  v_failed := null;
  begin perform public.save_repair_order(v_base || '{"technicianId":"73000000-0000-4000-8000-000000000052"}', '[]'::jsonb);
  exception when others then v_failed := sqlerrm; end;
  if v_failed is null or v_failed not like '%未勾選維修員身分%' then raise exception 'sales-only staff set as technician: %', v_failed; end if;

  -- 同一人（全能店員）完工維修也拿得到維修分紅。
  v_order := public.save_repair_order(v_base || '{"technicianId":"73000000-0000-4000-8000-000000000051"}', '[]'::jsonb);
  perform public.save_repair_order(v_base || jsonb_build_object('id', v_order, 'status', 'quoted', 'technicianId', '73000000-0000-4000-8000-000000000051'),
    '[]'::jsonb, (select updated_at from public.repair_orders where id = v_order));
  perform public.complete_repair_order(v_order, '{}'::jsonb);
  if (select bonus_amount from pg_temp.repair_bonus() where repair_order_id = v_order) <> 10 then raise exception 'dual-role repair bonus wrong'; end if;
  if (select count(*) from public.get_monthly_bonus_report(to_char(now() at time zone 'Asia/Taipei', 'YYYY-MM'))
      where person_id = '73000000-0000-4000-8000-000000000051') <> 2 then raise exception 'dual-role person should appear for both kinds'; end if;

  -- 完工前取消維修員身分：拒絕完工。
  v_order := public.save_repair_order(v_base || '{"technicianId":"73000000-0000-4000-8000-000000000053"}', '[]'::jsonb);
  perform public.save_repair_order(v_base || jsonb_build_object('id', v_order, 'status', 'quoted', 'technicianId', '73000000-0000-4000-8000-000000000053'),
    '[]'::jsonb, (select updated_at from public.repair_orders where id = v_order));
  update public.salespeople set is_sales = true, is_technician = false where id = '73000000-0000-4000-8000-000000000053';
  v_failed := null;
  begin perform public.complete_repair_order(v_order, '{}'::jsonb); exception when others then v_failed := sqlerrm; end;
  if v_failed is null or v_failed not like '%未勾選維修員身分%' then raise exception 'completed with non-technician: %', v_failed; end if;

  -- 舊網頁相容：public.repair_technicians 仍可讀到維修員。
  if (select count(*) from public.repair_technicians) <> 1 then raise exception 'compat view wrong'; end if;
end $$;

-- 店員：可讀名單，但不能新增或修改身分。
select set_config('request.jwt.claim.sub', '73000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"73000000-0000-4000-8000-000000000002","session_id":"73000000-0000-4000-8000-000000000012"}', true);
do $$
declare v_count integer;
begin
  if (select count(*) from public.salespeople where id::text like '73000000%') <> 3 then raise exception 'clerk cannot read staff'; end if;
  update public.salespeople set is_technician = true where id = '73000000-0000-4000-8000-000000000052';
  get diagnostics v_count = row_count;
  if v_count <> 0 then raise exception 'clerk changed a staff role'; end if;
end $$;
rollback;
