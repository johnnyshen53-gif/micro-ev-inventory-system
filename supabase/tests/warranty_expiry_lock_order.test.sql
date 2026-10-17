begin;

insert into auth.users(id, email) values
  ('60000000-0000-4000-8000-000000000001', 'expiry-admin@example.invalid'),
  ('60000000-0000-4000-8000-000000000011', 'expiry-clerk@example.invalid');
update public.profiles set role = 'admin', active = true where id = '60000000-0000-4000-8000-000000000001';
update public.profiles set role = 'clerk', active = true where id = '60000000-0000-4000-8000-000000000011';
insert into auth.sessions(id, user_id) values
  ('60000000-0000-4000-8000-000000000002', '60000000-0000-4000-8000-000000000001'),
  ('60000000-0000-4000-8000-000000000012', '60000000-0000-4000-8000-000000000011');
select set_config('request.jwt.claim.sub', '60000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"60000000-0000-4000-8000-000000000001","session_id":"60000000-0000-4000-8000-000000000002"}', true);
set local role authenticated;

-- 店長建立測試資料：一個零件、一位客戶、一張已過期保固、一張有效保固。
do $$
declare
  v_item uuid := '60000000-0000-4000-8000-0000000000a1';
  v_customer uuid := '60000000-0000-4000-8000-0000000000c1';
  v_today date := (now() at time zone 'Asia/Taipei')::date;
begin
  insert into public.items(id, name, price, stock, created_by) values (v_item, '保固測試零件', 100, 5, auth.uid());
  insert into public.customers(id, member_number, name, created_by) values (v_customer, 'EXP-001', '保固客戶', auth.uid());
  insert into public.warranties(id, customer_id, customer_name, item_id, item_name, source, purchased_at, expires_at, created_by) values
    ('60000000-0000-4000-8000-0000000000e1', v_customer, '保固客戶', v_item, '保固測試零件', 'manual', v_today - 400, v_today - 1, auth.uid()),
    ('60000000-0000-4000-8000-0000000000f1', v_customer, '保固客戶', v_item, '保固測試零件', 'manual', v_today - 30, v_today, auth.uid());
end $$;

-- 店員：過期保固被擋下且不扣庫存；到期日當天仍算有效，可以出保固。
select set_config('request.jwt.claim.sub', '60000000-0000-4000-8000-000000000011', true);
select set_config('request.jwt.claims', '{"sub":"60000000-0000-4000-8000-000000000011","session_id":"60000000-0000-4000-8000-000000000012"}', true);
do $$
declare v_denied boolean := false;
begin
  begin
    perform public.issue_warranty_replacement('60000000-0000-4000-8000-0000000000a1', 1, '60000000-0000-4000-8000-0000000000e1', '{}'::uuid[], '電池不良');
  exception when others then
    v_denied := sqlerrm like '%僅店長可放行%';
  end;
  if not v_denied then raise exception 'clerk issued replacement for expired warranty'; end if;
  if (select stock from public.items where id = '60000000-0000-4000-8000-0000000000a1') <> 5 then raise exception 'denied replacement changed stock'; end if;

  perform public.issue_warranty_replacement('60000000-0000-4000-8000-0000000000a1', 1, '60000000-0000-4000-8000-0000000000f1', '{}'::uuid[], '當天到期');
  if (select stock from public.items where id = '60000000-0000-4000-8000-0000000000a1') <> 4 then raise exception 'valid warranty replacement failed'; end if;
  if (select note from public.inventory_transactions where warranty_id = '60000000-0000-4000-8000-0000000000f1') <> '當天到期' then
    raise exception 'valid warranty note should not be marked as override';
  end if;
end $$;

-- 店長：可放行過期保固，原因自動加註。
select set_config('request.jwt.claim.sub', '60000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"60000000-0000-4000-8000-000000000001","session_id":"60000000-0000-4000-8000-000000000002"}', true);
do $$
declare
  v_person uuid := gen_random_uuid();
  v_other uuid := gen_random_uuid();
begin
  perform public.issue_warranty_replacement('60000000-0000-4000-8000-0000000000a1', 1, '60000000-0000-4000-8000-0000000000e1', '{}'::uuid[], '客戶通融');
  if (select stock from public.items where id = '60000000-0000-4000-8000-0000000000a1') <> 3 then raise exception 'admin override did not deduct stock'; end if;
  if (select note from public.inventory_transactions where warranty_id = '60000000-0000-4000-8000-0000000000e1') <> '[過期保固放行] 客戶通融' then
    raise exception 'admin override note missing marker';
  end if;

  -- 結帳仍正常：品項順序與 ID 順序相反、同品項出現兩次，都要正確扣庫存。
  insert into public.salespeople(id, name, active, created_by) values (v_person, '鎖定業務', true, auth.uid());
  insert into public.items(id, name, price, stock, created_by) values (v_other, '另一個零件', 50, 4, auth.uid());
  perform public.create_sale_with_serials(jsonb_build_array(
    jsonb_build_object('item_id', greatest(v_other, '60000000-0000-4000-8000-0000000000a1'::uuid), 'quantity', 1),
    jsonb_build_object('item_id', least(v_other, '60000000-0000-4000-8000-0000000000a1'::uuid), 'quantity', 1),
    jsonb_build_object('item_id', v_other, 'quantity', 1)), null::uuid, v_person, gen_random_uuid());
  if (select stock from public.items where id = v_other) <> 2 then raise exception 'locked checkout deducted wrong quantity'; end if;
  if (select stock from public.items where id = '60000000-0000-4000-8000-0000000000a1') <> 2 then raise exception 'locked checkout missed an item'; end if;
end $$;

-- 鎖定輔助函式只能在結帳函式內部使用。
do $$
begin
  if has_function_privilege('authenticated', 'app_private.lock_sale_rows(jsonb)', 'execute') then
    raise exception 'lock helper must not be callable by clients';
  end if;
end $$;

rollback;
