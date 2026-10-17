-- 維修單不需要業務員（20261020010000）：只需要維修人員，舊單已記錄的業務員保留不動。
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
  ('71000000-0000-4000-8000-000000000051', '甲業務', false, '71000000-0000-4000-8000-000000000001');
-- 維修人員＝勾選「維修員」身分的店員（完工必須指定）。
insert into public.salespeople(id, name, active, is_sales, is_technician) values ('71000000-0000-4000-8000-000000000061', '維修甲', true, false, true);
insert into public.items(id, name, category, sku, price, stock, created_by) values
  ('71000000-0000-4000-8000-000000000031', '煞車片', '零件', 'RS-PART', 100, 10, '71000000-0000-4000-8000-000000000001');

-- 店員：沒有業務員也能建立、報價；完工只要有維修人員。
select set_config('request.jwt.claim.sub', '71000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"71000000-0000-4000-8000-000000000002","session_id":"71000000-0000-4000-8000-000000000012"}', true);
set local role authenticated;
do $$
declare
  v_order uuid;
  v_base jsonb := '{"customerName":"客人","customerPhone":"0911000000","plateNumber":"RS-1","vehicleName":"車型","issue":"保養","laborAmount":300}'::jsonb;
  v_lines jsonb := jsonb_build_array(jsonb_build_object('itemId','71000000-0000-4000-8000-000000000031','quantity',2,'unitPrice',100));
begin
  v_order := public.save_repair_order(v_base, v_lines);
  if (select salesperson_id from public.repair_orders where id = v_order) is not null then raise exception 'new repair stored a salesperson'; end if;
  perform public.save_repair_order(v_base || jsonb_build_object('id', v_order, 'status', 'quoted', 'technicianId', '71000000-0000-4000-8000-000000000061'),
    v_lines, (select updated_at from public.repair_orders where id = v_order));
  perform public.complete_repair_order(v_order, '{}'::jsonb);
  if (select status from public.repair_orders where id = v_order) <> 'completed' then raise exception 'repair without salesperson not completed'; end if;

  -- 舊前端若仍送出業務員（甚至是已停用的），也不會被拒絕或寫入。
  v_order := public.save_repair_order(v_base || '{"salespersonId":"71000000-0000-4000-8000-000000000051"}', v_lines);
  if (select salesperson_id from public.repair_orders where id = v_order) is not null then raise exception 'salespersonId should be ignored'; end if;
  perform set_config('test.repair_order', v_order::text, true);
end $$;

-- 模擬上線前的舊維修單：用管理連線寫入業務員。編輯時要保留，不可被清掉。
reset role;
update public.repair_orders set salesperson_id = '71000000-0000-4000-8000-000000000051' where id = current_setting('test.repair_order')::uuid;
set local role authenticated;
do $$
declare
  v_order uuid := current_setting('test.repair_order')::uuid;
begin
  perform public.save_repair_order(jsonb_build_object('id', v_order, 'customerName','客人','customerPhone','0911000000','plateNumber','RS-1',
    'vehicleName','車型','issue','改診斷','laborAmount',300,'status','intake'), '[]'::jsonb, (select updated_at from public.repair_orders where id = v_order));
  if (select salesperson_id from public.repair_orders where id = v_order) is distinct from '71000000-0000-4000-8000-000000000051' then
    raise exception 'editing an old repair cleared its salesperson'; end if;
  if (select issue from public.repair_orders where id = v_order) <> '改診斷' then raise exception 'edit not saved'; end if;
end $$;
rollback;
