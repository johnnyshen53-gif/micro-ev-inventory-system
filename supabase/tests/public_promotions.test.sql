-- 官網公開優惠：只列進行中的組合、欄位不含內部資料、訪客讀得到但仍讀不到資料表。整個測試在交易內，結束時 rollback。
begin;
insert into auth.users(id, email) values ('76000000-0000-4000-8000-000000000001', 'pub-admin@example.invalid');
update public.profiles set role = 'admin', active = true where id = '76000000-0000-4000-8000-000000000001';
insert into public.items(id, name, category, sku, price, stock) values
  ('76000000-0000-4000-8000-000000000031', '鋰電池', '電池', 'PUB-BAT', 12000, 5),
  ('76000000-0000-4000-8000-000000000032', '安全帽', '機構元件', 'PUB-HEL', 1500, 5);
insert into public.item_costs(item_id, cost) values ('76000000-0000-4000-8000-000000000031', 8000);

do $$
declare v_today date := (now() at time zone 'Asia/Taipei')::date;
begin
  insert into public.promotions(id, name, starts_on, ends_on, combo_price, active, created_by) values
    ('76000000-0000-4000-8000-000000000101', '進行中組合', v_today - 3, v_today, 12500, true, '76000000-0000-4000-8000-000000000001'),
    ('76000000-0000-4000-8000-000000000102', '已停用組合', v_today - 3, v_today + 3, 12500, false, '76000000-0000-4000-8000-000000000001'),
    ('76000000-0000-4000-8000-000000000103', '已結束組合', v_today - 9, v_today - 1, 12500, true, '76000000-0000-4000-8000-000000000001'),
    ('76000000-0000-4000-8000-000000000104', '尚未開始組合', v_today + 1, v_today + 9, 12500, true, '76000000-0000-4000-8000-000000000001');
  insert into public.promotion_items(promotion_id, item_id, quantity)
    select p, i, q from (values
      ('76000000-0000-4000-8000-000000000101'::uuid, '76000000-0000-4000-8000-000000000031'::uuid, 1),
      ('76000000-0000-4000-8000-000000000101', '76000000-0000-4000-8000-000000000032', 2),
      ('76000000-0000-4000-8000-000000000102', '76000000-0000-4000-8000-000000000031', 2),
      ('76000000-0000-4000-8000-000000000103', '76000000-0000-4000-8000-000000000031', 2),
      ('76000000-0000-4000-8000-000000000104', '76000000-0000-4000-8000-000000000031', 2)) v(p, i, q);
end $$;

set local role anon;
do $$
declare r record; v_count int;
begin
  select count(*) into v_count from public.get_public_promotions() where name like '%組合';
  if v_count <> 1 then raise exception 'expected only the running promotion, got %', v_count; end if;
  select * into r from public.get_public_promotions() where name = '進行中組合';
  if r.combo_price <> 12500 or r.list_total <> 15000 then raise exception 'wrong prices % %', r.combo_price, r.list_total; end if;
  if r.items <> '[{"name":"安全帽","quantity":2},{"name":"鋰電池","quantity":1}]'::jsonb then raise exception 'wrong items %', r.items; end if;
  if r.ends_on <> (now() at time zone 'Asia/Taipei')::date then raise exception 'end day should be included'; end if;
end $$;

-- 訪客仍然不能直接讀資料表（只能透過上面的函式）。
create function pg_temp.expect_denied(p_sql text) returns void language plpgsql as $$
begin
  execute p_sql;
  raise exception 'expected permission denied: %', p_sql;
exception when insufficient_privilege then null;
end $$;
select pg_temp.expect_denied('select * from public.promotions');
select pg_temp.expect_denied('select * from public.items');
select pg_temp.expect_denied('select * from public.item_costs');
select pg_temp.expect_denied('select * from app_private.coupons');
reset role;

-- 回傳欄位固定：沒有成本、庫存、id。
do $$
begin
  if (select string_agg(parameter_name, ',' order by ordinal_position) from information_schema.parameters
      where specific_schema = 'public' and specific_name like 'get_public_promotions%' and parameter_mode = 'OUT')
     <> 'name,starts_on,ends_on,combo_price,list_total,items' then
    raise exception 'unexpected output columns';
  end if;
end $$;
rollback;
