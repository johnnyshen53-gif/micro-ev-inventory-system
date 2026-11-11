-- 最後價格異動時間：四種賣價或成本有變才更新；改其他欄位不動；新增時可帶入指定時間。整個測試在交易內，結束時 rollback。
begin;
insert into auth.users(id, email) values ('7a100000-0000-4000-8000-000000000001', 'pc-admin@example.invalid');
update public.profiles set role = 'admin', active = true where id = '7a100000-0000-4000-8000-000000000001';
insert into auth.sessions(id, user_id) values ('7a100000-0000-4000-8000-000000000011', '7a100000-0000-4000-8000-000000000001');
select set_config('request.jwt.claim.sub', '7a100000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"7a100000-0000-4000-8000-000000000001","session_id":"7a100000-0000-4000-8000-000000000011"}', true);
set local role authenticated;

create function pg_temp.stamp(p_id uuid) returns timestamptz language sql as $$ select price_changed_at from public.items where id = p_id $$;
-- 把時間撥回過去，方便看出「有沒有被更新成現在」（同一個交易裡 now() 不會變）。
create function pg_temp.rewind(p_id uuid) returns void language sql as $$ update public.items set price_changed_at = '2020-01-01T00:00:00Z' where id = p_id $$;

do $$
declare
  a constant uuid := '7a100000-0000-4000-8000-000000000031';
  b constant uuid := '7a100000-0000-4000-8000-000000000032';
  old_time constant timestamptz := '2020-01-01T00:00:00Z';
begin
  -- 新增：沒指定＝現在；有指定（匯入帶原資料的異動日期）＝照指定。
  insert into public.items(id, name, category, sku, price, stock, vehicle_model_id) values (a, '座墊', '外觀元件', 'PC-A', 950, 5, (select id from public.vehicle_models where is_universal));
  insert into public.items(id, name, category, sku, price, stock, vehicle_model_id, price_changed_at) values (b, '後架', '機構元件', 'PC-B', 1380, 5, (select id from public.vehicle_models where is_universal), '2021-07-23T08:32:26Z');
  if pg_temp.stamp(a) is distinct from now() then raise exception 'new item should be stamped now'; end if;
  if pg_temp.stamp(b) is distinct from '2021-07-23T08:32:26Z'::timestamptz then raise exception 'insert should keep the given time'; end if;
  -- 新增品項跟著建立成本列：不算異動。
  insert into public.item_costs(item_id, cost) values (b, 700);
  if pg_temp.stamp(b) is distinct from '2021-07-23T08:32:26Z'::timestamptz then raise exception 'creating the cost row must not touch the time'; end if;

  -- 改名稱、庫存、備註：不動。
  perform pg_temp.rewind(a);
  update public.items set name = '座墊（黑）', notes = 'x', minimum_stock = 2 where id = a;
  perform public.adjust_inventory(a, 'in', 3, '');
  if pg_temp.stamp(a) is distinct from old_time then raise exception 'non-price edits must not touch the time'; end if;
  -- 價格送一樣的值：不動。
  update public.items set price = 950, special_price = null where id = a;
  if pg_temp.stamp(a) is distinct from old_time then raise exception 'same price must not touch the time'; end if;

  -- 售價、特價、會員價：各自改動都會更新。
  update public.items set price = 990 where id = a;
  if pg_temp.stamp(a) is distinct from now() then raise exception 'price change should stamp'; end if;
  perform pg_temp.rewind(a); update public.items set special_price = 849 where id = a;
  if pg_temp.stamp(a) is distinct from now() then raise exception 'special price change should stamp'; end if;
  perform pg_temp.rewind(a); update public.items set member_price = 0 where id = a;
  if pg_temp.stamp(a) is distinct from now() then raise exception 'member price change should stamp'; end if;
  perform pg_temp.rewind(a); update public.items set special_price = null where id = a;
  if pg_temp.stamp(a) is distinct from now() then raise exception 'clearing a price should stamp'; end if;

  -- 成本、員工價（item_costs）：改動會更新；送一樣的值或只改其他欄位不動。
  insert into public.item_costs(item_id, cost) values (a, 500);
  perform pg_temp.rewind(a); update public.item_costs set cost = 500, cost_confirmed = true where item_id = a;
  if pg_temp.stamp(a) is distinct from old_time then raise exception 'same cost must not touch the time'; end if;
  update public.item_costs set cost = 520 where item_id = a;
  if pg_temp.stamp(a) is distinct from now() then raise exception 'cost change should stamp'; end if;
  perform pg_temp.rewind(a); update public.item_costs set staff_price = 600 where item_id = a;
  if pg_temp.stamp(a) is distinct from now() then raise exception 'staff price change should stamp'; end if;
  if pg_temp.stamp(b) is distinct from '2021-07-23T08:32:26Z'::timestamptz then raise exception 'other items must not be touched'; end if;
end $$;
rollback;
