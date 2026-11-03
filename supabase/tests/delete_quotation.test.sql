-- 刪除報價單：只有店長能刪；刪除時留操作紀錄，明細與組合一起刪。整個測試在交易內，結束時 rollback。
begin;
insert into auth.users(id, email) values
  ('7b000000-0000-4000-8000-000000000001', 'delq-admin@example.invalid'),
  ('7b000000-0000-4000-8000-000000000002', 'delq-clerk@example.invalid');
update public.profiles set role = 'admin', active = true where id = '7b000000-0000-4000-8000-000000000001';
update public.profiles set role = 'clerk', active = true where id = '7b000000-0000-4000-8000-000000000002';
insert into auth.sessions(id, user_id) values
  ('7b000000-0000-4000-8000-000000000011', '7b000000-0000-4000-8000-000000000001'),
  ('7b000000-0000-4000-8000-000000000012', '7b000000-0000-4000-8000-000000000002');
insert into public.items(id, name, category, sku, price, stock) values ('7b000000-0000-4000-8000-000000000031', '輪胎', '機構元件', 'DQ-TIRE', 1450, 0);

-- 店員建立一張報價單，然後試著刪除（應被擋）。
select set_config('request.jwt.claim.sub', '7b000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"7b000000-0000-4000-8000-000000000002","session_id":"7b000000-0000-4000-8000-000000000012"}', true);
set local role authenticated;
do $$
declare v_denied boolean := false;
begin
  perform public.save_quotation(jsonb_build_object('id', '7b000000-0000-4000-8000-000000000041', 'number', 'Q-DEL-1', 'customerName', '王先生',
    'plateNumber', 'ABC-1234', 'total', 2900), '[{"itemId":"7b000000-0000-4000-8000-000000000031","itemName":"輪胎","quantity":2,"unitPrice":1450}]');
  begin
    perform public.delete_quotation('7b000000-0000-4000-8000-000000000041');
  exception when others then v_denied := sqlerrm like '%只有店長可以刪除報價單%'; end;
  if not v_denied or not exists (select 1 from public.quotations where id = '7b000000-0000-4000-8000-000000000041') then
    raise exception 'clerk could delete a quotation';
  end if;
end $$;

-- 店長刪除：報價單與明細都不見，留下一筆操作紀錄。
select set_config('request.jwt.claim.sub', '7b000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"7b000000-0000-4000-8000-000000000001","session_id":"7b000000-0000-4000-8000-000000000011"}', true);
do $$
declare v_denied boolean := false;
begin
  perform public.delete_quotation('7b000000-0000-4000-8000-000000000041');
end $$;
reset role;
do $$
declare v_denied boolean := false;
begin
  if exists (select 1 from public.quotations where id = '7b000000-0000-4000-8000-000000000041')
    or exists (select 1 from public.quotation_lines where quotation_id = '7b000000-0000-4000-8000-000000000041') then
    raise exception 'quotation or lines remain';
  end if;
  if not exists (select 1 from public.audit_logs where action = 'quotation_deleted' and target_id = '7b000000-0000-4000-8000-000000000041'
      and actor_id = '7b000000-0000-4000-8000-000000000001' and summary->>'quote_number' = 'Q-DEL-1' and summary->>'customer_name' = '王先生'
      and (summary->>'total')::numeric = 2900 and jsonb_array_length(summary->'lines') = 1) then
    raise exception 'audit log missing';
  end if;
  if has_function_privilege('anon', 'public.delete_quotation(uuid)', 'EXECUTE') then raise exception 'anon can delete quotations'; end if;
end $$;

-- 刪除不存在的報價單：清楚的錯誤訊息。
select set_config('request.jwt.claim.sub', '7b000000-0000-4000-8000-000000000001', true);
set local role authenticated;
do $$
declare v_denied boolean := false;
begin
  begin perform public.delete_quotation(gen_random_uuid());
  exception when others then v_denied := sqlerrm like '%找不到報價單%'; end;
  if not v_denied then raise exception 'missing quotation not reported'; end if;
end $$;
rollback;
