-- 機車銷售獎金與維修分紅：記帳規則、快照不重算、權限。整個測試在交易內，結束時 rollback。
begin;
insert into auth.users(id, email) values
  ('72000000-0000-4000-8000-000000000001', 'bonus-admin@example.invalid'),
  ('72000000-0000-4000-8000-000000000002', 'bonus-clerk@example.invalid');
update public.profiles set role = 'admin', active = true where id = '72000000-0000-4000-8000-000000000001';
update public.profiles set role = 'clerk', active = true where id = '72000000-0000-4000-8000-000000000002';
insert into auth.sessions(id, user_id) values
  ('72000000-0000-4000-8000-000000000011', '72000000-0000-4000-8000-000000000001'),
  ('72000000-0000-4000-8000-000000000012', '72000000-0000-4000-8000-000000000002');
insert into public.salespeople(id, name, active) values
  ('72000000-0000-4000-8000-000000000051', '甲業務', true),
  ('72000000-0000-4000-8000-000000000052', '乙業務', true),
  ('72000000-0000-4000-8000-000000000053', '離職業務', false);
insert into public.items(id, name, category, sku, price, stock) values
  ('72000000-0000-4000-8000-000000000031', '獎金車款', '零件', 'B-MOTO', 1000, 20),
  ('72000000-0000-4000-8000-000000000032', '一般零件', '零件', 'B-PART', 50, 20),
  ('72000000-0000-4000-8000-000000000033', '煞車片', '零件', 'B-PAD', 100, 20),
  ('72000000-0000-4000-8000-000000000034', '未確認成本零件', '零件', 'B-NOCOST', 80, 20);
insert into public.item_costs(item_id, cost) values ('72000000-0000-4000-8000-000000000033', 30);

-- 測試用：以管理身分讀取私有快照表（一般 API 角色讀不到，這正是要的行為）。
create function pg_temp.sale_bonus() returns setof app_private.sale_bonus_records
  language sql security definer as $$ select * from app_private.sale_bonus_records $$;
create function pg_temp.repair_bonus() returns setof app_private.repair_bonus_records
  language sql security definer as $$ select * from app_private.repair_bonus_records $$;

-- 輔助：建立一張「已報價」的維修單（以呼叫者身分執行）。
create function pg_temp.quoted_repair(p_tech uuid, p_item uuid, p_qty integer, p_price numeric, p_labor numeric)
returns uuid language plpgsql as $$
declare
  v_base jsonb := jsonb_build_object('salespersonId','72000000-0000-4000-8000-000000000051','customerName','客人',
    'customerPhone','0911000000','plateNumber','B-1','vehicleName','車型','issue','保養','laborAmount',p_labor);
  v_lines jsonb := case when p_item is null then '[]'::jsonb
    else jsonb_build_array(jsonb_build_object('itemId',p_item,'quantity',p_qty,'unitPrice',p_price)) end;
  v_id uuid;
begin
  if p_tech is not null then v_base := v_base || jsonb_build_object('technicianId', p_tech); end if;
  v_id := public.save_repair_order(v_base, v_lines);
  perform public.save_repair_order(v_base || jsonb_build_object('id', v_id, 'status', 'quoted'), v_lines,
    (select updated_at from public.repair_orders where id = v_id));
  return v_id;
end $$;

select set_config('request.jwt.claim.sub', '72000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"72000000-0000-4000-8000-000000000001","session_id":"72000000-0000-4000-8000-000000000011"}', true);
set local role authenticated;

-- 一、機車獎金
do $$
declare
  v_lines jsonb := jsonb_build_array(
    jsonb_build_object('item_id','72000000-0000-4000-8000-000000000031','quantity',2),
    jsonb_build_object('item_id','72000000-0000-4000-8000-000000000032','quantity',1));
  v_person uuid := '72000000-0000-4000-8000-000000000051';
  v_checkout uuid := gen_random_uuid();
  v_state jsonb;
begin
  -- 未設定：不記帳。
  perform public.create_sale_with_serials(v_lines, null::uuid, v_person, gen_random_uuid());
  if exists (select 1 from pg_temp.sale_bonus()) then raise exception 'unset amount created bonus'; end if;

  -- 每台 500；名單含已停用業務員（不受領）。
  perform public.save_bonus_settings(500, null, array['72000000-0000-4000-8000-000000000051','72000000-0000-4000-8000-000000000052','72000000-0000-4000-8000-000000000053']::uuid[],
    array['72000000-0000-4000-8000-000000000031']::uuid[]);
  v_state := public.get_bonus_admin_state();
  if (v_state->>'motorcycleBonusAmount')::numeric <> 500 or jsonb_array_length(v_state->'recipientIds') <> 3 then
    raise exception 'admin state wrong: %', v_state; end if;

  perform public.create_sale_with_serials(v_lines, null::uuid, v_person, v_checkout);
  if (select count(*) from pg_temp.sale_bonus() where sale_id = v_checkout) <> 2 then
    raise exception 'expected one record per active recipient'; end if;
  if exists (select 1 from pg_temp.sale_bonus() where sale_id = v_checkout and (units <> 2 or bonus_amount <> 1000)) then
    raise exception 'units × amount wrong (unflagged item must not count)'; end if;
  if exists (select 1 from pg_temp.sale_bonus() where salesperson_id = '72000000-0000-4000-8000-000000000053') then
    raise exception 'inactive salesperson received bonus'; end if;

  -- 同一個 checkout 重送：不重複記帳。
  perform public.create_sale_with_serials(v_lines, null::uuid, v_person, v_checkout);
  if (select count(*) from pg_temp.sale_bonus() where sale_id = v_checkout) <> 2 then raise exception 'retry duplicated bonus'; end if;

  -- 改金額：舊紀錄不變。
  perform public.save_bonus_settings(800, null, array['72000000-0000-4000-8000-000000000051']::uuid[], array['72000000-0000-4000-8000-000000000031']::uuid[]);
  if exists (select 1 from pg_temp.sale_bonus() where sale_id = v_checkout and bonus_amount <> 1000) then
    raise exception 'old bonus recalculated'; end if;

  -- 金額 0＝明確不發：不寫紀錄。
  perform public.save_bonus_settings(0, null, array['72000000-0000-4000-8000-000000000051']::uuid[], array['72000000-0000-4000-8000-000000000031']::uuid[]);
  perform public.create_sale_with_serials(v_lines, null::uuid, v_person, gen_random_uuid());
  if (select count(*) from pg_temp.sale_bonus()) <> 2 then raise exception 'zero amount created bonus'; end if;

  -- 名單空：不寫紀錄。
  perform public.save_bonus_settings(500, null, '{}'::uuid[], array['72000000-0000-4000-8000-000000000031']::uuid[]);
  perform public.create_sale_with_serials(v_lines, null::uuid, v_person, gen_random_uuid());
  if (select count(*) from pg_temp.sale_bonus()) <> 2 then raise exception 'empty recipients created bonus'; end if;
end $$;

-- 二、維修分紅
do $$
declare
  v_tech uuid;
  v_off uuid;
  v_order uuid;
  v_failed text;
  v_rec app_private.repair_bonus_records%rowtype;
begin
  -- 維修人員＝勾選「維修員」身分的店員（店長可直接管理店員名單）。
  insert into public.salespeople(name, active, is_sales, is_technician) values ('維修甲', true, false, true) returning id into v_tech;
  insert into public.salespeople(name, active, is_sales, is_technician) values ('維修乙', true, false, true) returning id into v_off;

  -- 百分比未設定：可完工、不記帳、不檢查成本。
  v_order := pg_temp.quoted_repair(v_tech, '72000000-0000-4000-8000-000000000034', 1, 80, 100);
  perform public.complete_repair_order(v_order, '{}'::jsonb);
  if exists (select 1 from pg_temp.repair_bonus()) then raise exception 'unset percent created repair bonus'; end if;

  perform public.save_bonus_settings(null, 10, '{}'::uuid[], '{}'::uuid[]);

  -- 沒有維修人員：拒絕完工，整筆回滾（庫存未扣、狀態未變）。
  v_order := pg_temp.quoted_repair(null, '72000000-0000-4000-8000-000000000033', 2, 100, 200);
  v_failed := null;
  begin perform public.complete_repair_order(v_order, '{}'::jsonb); exception when others then v_failed := sqlerrm; end;
  if v_failed is null or v_failed not like '%請先指定維修人員%' then raise exception 'completed without technician: %', v_failed; end if;
  if (select status from public.repair_orders where id = v_order) <> 'quoted'
    or (select stock from public.items where id = '72000000-0000-4000-8000-000000000033') <> 20 then
    raise exception 'failed completion was not rolled back'; end if;

  -- 用料成本未確認：拒絕完工。
  v_order := pg_temp.quoted_repair(v_tech, '72000000-0000-4000-8000-000000000033', 2, 100, 200);
  v_failed := null;
  begin perform public.complete_repair_order(v_order, '{}'::jsonb); exception when others then v_failed := sqlerrm; end;
  if v_failed is null or v_failed not like '%煞車片%成本尚未確認%' then raise exception 'unconfirmed cost allowed: %', v_failed; end if;

  -- 確認成本後：工資 200 + 用料 2×100 = 400；成本 2×30 = 60；淨額 340 × 10% = 34。
  perform public.set_item_costs_confirmed(array['72000000-0000-4000-8000-000000000033']::uuid[], true);
  perform public.complete_repair_order(v_order, '{}'::jsonb);
  select * into v_rec from pg_temp.repair_bonus() where repair_order_id = v_order;
  if v_rec.repair_total <> 400 or v_rec.parts_cost <> 60 or v_rec.net_amount <> 340 or v_rec.bonus_amount <> 34
    or v_rec.technician_name <> '維修甲' or v_rec.bonus_percent <> 10 then
    raise exception 'repair bonus wrong: % % % %', v_rec.repair_total, v_rec.parts_cost, v_rec.net_amount, v_rec.bonus_amount; end if;
  perform set_config('test.repair_order', v_order::text, true);

  -- 改百分比與成本：舊紀錄不變。
  perform public.save_bonus_settings(null, 50, '{}'::uuid[], '{}'::uuid[]);
  if (select bonus_amount from pg_temp.repair_bonus() where repair_order_id = v_order) <> 34 then
    raise exception 'old repair bonus recalculated'; end if;

  -- 淨額為負：分紅 0，但仍留紀錄供核對。
  v_order := pg_temp.quoted_repair(v_tech, '72000000-0000-4000-8000-000000000033', 1, 10, 0);
  perform public.complete_repair_order(v_order, '{}'::jsonb);
  select * into v_rec from pg_temp.repair_bonus() where repair_order_id = v_order;
  if v_rec.net_amount <> 0 or v_rec.bonus_amount <> 0 or v_rec.parts_cost <> 30 then raise exception 'negative net not clamped'; end if;

  -- 純工資（無用料）：成本 0。
  v_order := pg_temp.quoted_repair(v_tech, null, 0, 0, 300);
  perform public.complete_repair_order(v_order, '{}'::jsonb);
  if (select bonus_amount from pg_temp.repair_bonus() where repair_order_id = v_order) <> 150 then
    raise exception 'labor-only repair bonus wrong'; end if;

  -- 維修人員在完工前停用：拒絕完工。
  v_order := pg_temp.quoted_repair(v_off, null, 0, 0, 100);
  update public.salespeople set active = false where id = v_off;
  v_failed := null;
  begin perform public.complete_repair_order(v_order, '{}'::jsonb); exception when others then v_failed := sqlerrm; end;
  if v_failed is null or v_failed not like '%已停用%' then raise exception 'inactive technician completed: %', v_failed; end if;
  -- 新維修單不可選已停用的人。
  v_failed := null;
  begin perform pg_temp.quoted_repair(v_off, null, 0, 0, 100); exception when others then v_failed := sqlerrm; end;
  if v_failed is null or v_failed not like '%維修人員不存在%已停用%' then raise exception 'saved inactive technician: %', v_failed; end if;

  -- 月報表：機車 2 筆＋維修 3 筆。
  if (select count(*) from public.get_monthly_bonus_report(to_char(now() at time zone 'Asia/Taipei', 'YYYY-MM'))) <> 5 then
    raise exception 'monthly report count wrong'; end if;
  if exists (select 1 from public.get_monthly_bonus_report('2000-01')) then raise exception 'other month leaked'; end if;
end $$;

-- 三、一般員工：看不到也改不了。
select set_config('request.jwt.claim.sub', '72000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"72000000-0000-4000-8000-000000000002","session_id":"72000000-0000-4000-8000-000000000012"}', true);
do $$
declare
  v_denied integer := 0;
begin
  begin perform public.get_bonus_admin_state(); exception when insufficient_privilege then v_denied := v_denied + 1; end;
  begin perform public.save_bonus_settings(1, 1, '{}'::uuid[], '{}'::uuid[]); exception when insufficient_privilege then v_denied := v_denied + 1; end;
  begin perform public.set_item_costs_confirmed('{}'::uuid[], true); exception when insufficient_privilege then v_denied := v_denied + 1; end;
  begin insert into public.salespeople(name, is_sales, is_technician) values ('冒名', false, true); exception when insufficient_privilege then v_denied := v_denied + 1; end;
  begin perform * from public.get_monthly_bonus_report('2026-10'); exception when insufficient_privilege then v_denied := v_denied + 1; end;
  begin perform * from app_private.sale_bonus_records; exception when insufficient_privilege then v_denied := v_denied + 1; end;
  begin perform * from app_private.repair_bonus_records; exception when insufficient_privilege then v_denied := v_denied + 1; end;
  begin insert into public.repair_technicians(name) values ('直接寫入'); exception when insufficient_privilege then v_denied := v_denied + 1; end;
  if v_denied <> 8 then raise exception 'clerk accessed bonus data (% of 8 denied)', v_denied; end if;
  -- 但可讀維修人員姓名（維修單選單用）。
  if not exists (select 1 from public.repair_technicians where name = '維修甲') then raise exception 'clerk cannot read technicians'; end if;
end $$;

rollback;
