begin;

insert into auth.users(id, email) values
  ('50000000-0000-4000-8000-000000000001', 'checkout-admin@example.invalid'),
  ('50000000-0000-4000-8000-000000000011', 'checkout-clerk@example.invalid');
update public.profiles set role = 'admin', active = true where id = '50000000-0000-4000-8000-000000000001';
update public.profiles set role = 'clerk', active = true where id = '50000000-0000-4000-8000-000000000011';
insert into auth.sessions(id, user_id) values
  ('50000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000001'),
  ('50000000-0000-4000-8000-000000000012', '50000000-0000-4000-8000-000000000011');
select set_config('request.jwt.claim.sub', '50000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"50000000-0000-4000-8000-000000000001","session_id":"50000000-0000-4000-8000-000000000002"}', true);
set local role authenticated;

do $$
declare
  v_person uuid := gen_random_uuid();
  v_item uuid := gen_random_uuid();
  v_checkout uuid := gen_random_uuid();
  v_lines jsonb;
  v_result uuid;
  v_denied boolean;
begin
  insert into public.salespeople(id, name, active, created_by) values (v_person, '冪等業務', true, auth.uid());
  insert into public.items(id, name, price, stock, created_by, vehicle_model_id) values (v_item, '冪等測試零件', 100, 3, auth.uid(), (select id from public.vehicle_models where is_universal));
  v_lines := jsonb_build_array(jsonb_build_object('item_id', v_item, 'quantity', 1));

  -- 第一次結帳：建立銷售單，銷售單 ID 就是 checkout id，庫存 3 → 2。
  v_result := public.create_sale_with_serials(v_lines, null::uuid, v_person, v_checkout);
  if v_result <> v_checkout then raise exception 'sale id should equal checkout id'; end if;
  perform set_config('test.checkout', v_checkout::text, true);
  if (select stock from public.items where id = v_item) <> 2 then raise exception 'first checkout did not deduct stock once'; end if;

  -- 同一個 checkout id 重送：回傳同一張單，庫存、明細、異動、稽核都不可再增加。
  v_result := public.create_sale_with_serials(v_lines, null::uuid, v_person, v_checkout);
  if v_result <> v_checkout then raise exception 'retry should return the existing sale'; end if;
  if (select stock from public.items where id = v_item) <> 2 then raise exception 'retry deducted stock twice'; end if;
  if (select count(*) from public.sales where id = v_checkout) <> 1 then raise exception 'retry created another sale'; end if;
  if (select count(*) from public.sale_lines where sale_id = v_checkout) <> 1 then raise exception 'retry duplicated sale lines'; end if;
  if (select count(*) from public.inventory_transactions where item_id = v_item and type = 'out') <> 1 then raise exception 'retry duplicated inventory history'; end if;
  if (select count(*) from public.audit_logs where target_id = v_checkout and action = 'sale_created') <> 1 then raise exception 'retry duplicated audit log'; end if;

  -- 缺少 checkout id 要被拒絕，且不動庫存。
  v_denied := false;
  begin
    perform public.create_sale_with_serials(v_lines, null::uuid, v_person, null::uuid);
  exception when others then v_denied := true;
  end;
  if not v_denied or (select stock from public.items where id = v_item) <> 2 then raise exception 'missing checkout id changed stock'; end if;

  -- 重送時即使業務員已停用，也只回傳原單（原單建立時業務員有效）。
  update public.salespeople set active = false where id = v_person;
  if public.create_sale_with_serials(v_lines, null::uuid, v_person, v_checkout) <> v_checkout then
    raise exception 'retry after salesperson deactivation should return existing sale';
  end if;
  update public.salespeople set active = true where id = v_person;

  -- 舊的三參數入口仍可用（每次都是新單）。
  perform public.create_sale_with_serials(v_lines, null::uuid, v_person);
  if (select stock from public.items where id = v_item) <> 1 then raise exception 'legacy checkout path broke'; end if;
end $$;

-- 換另一位員工拿同一個 checkout id：不可回傳別人的單，也不可扣庫存。
select set_config('request.jwt.claim.sub', '50000000-0000-4000-8000-000000000011', true);
select set_config('request.jwt.claims', '{"sub":"50000000-0000-4000-8000-000000000011","session_id":"50000000-0000-4000-8000-000000000012"}', true);
do $$
declare
  v_sale public.sales%rowtype;
  v_item uuid;
  v_person uuid;
  v_denied boolean := false;
begin
  select * into v_sale from public.sales where id = current_setting('test.checkout')::uuid;
  select item_id into v_item from public.sale_lines where sale_id = v_sale.id;
  select id into v_person from public.salespeople where name = '冪等業務';
  begin
    perform public.create_sale_with_serials(jsonb_build_array(jsonb_build_object('item_id', v_item, 'quantity', 1)), null::uuid, v_person, v_sale.id);
  exception when others then v_denied := true;
  end;
  if not v_denied then raise exception 'another user reused a checkout id'; end if;
  if (select stock from public.items where id = v_item) <> 1 then raise exception 'reused checkout id changed stock'; end if;
end $$;

rollback;
