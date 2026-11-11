-- 特價／會員價／員工價：結帳依價格別計價；沒設定的價格不能選；員工價只有店長能看、能用。整個測試在交易內，結束時 rollback。
begin;
insert into auth.users(id, email) values ('7f000000-0000-4000-8000-000000000001', 'tier-admin@example.invalid'), ('7f000000-0000-4000-8000-000000000002', 'tier-staff@example.invalid');
update public.profiles set role = 'admin', active = true where id = '7f000000-0000-4000-8000-000000000001';
update public.profiles set role = 'clerk', active = true where id = '7f000000-0000-4000-8000-000000000002';
insert into auth.sessions(id, user_id) values ('7f000000-0000-4000-8000-000000000011', '7f000000-0000-4000-8000-000000000001'), ('7f000000-0000-4000-8000-000000000012', '7f000000-0000-4000-8000-000000000002');
insert into public.items(id, name, category, sku, price, special_price, member_price, stock, vehicle_model_id) values
  ('7f000000-0000-4000-8000-000000000031', '座墊', '外觀元件', 'PT-SEAT', 950, 849, 799, 20, (select id from public.vehicle_models where is_universal)),
  ('7f000000-0000-4000-8000-000000000032', '腳踏板', '外觀元件', 'PT-STEP', 1100, null, 0, 20, (select id from public.vehicle_models where is_universal));
insert into public.item_costs(item_id, cost, staff_price) values ('7f000000-0000-4000-8000-000000000031', 500, 600)
  on conflict (item_id) do update set cost = excluded.cost, staff_price = excluded.staff_price;
insert into public.salespeople(id, name, active, created_by) values ('7f000000-0000-4000-8000-000000000051', '業務', true, '7f000000-0000-4000-8000-000000000001');

create function pg_temp.expect_error(p_sql text, p_message text) returns void language plpgsql as $$
begin
  execute p_sql;
  raise exception 'expected error containing %', p_message;
exception when others then
  if sqlerrm not like '%' || p_message || '%' then raise; end if;
end $$;
create function pg_temp.sell(p_lines jsonb) returns uuid language sql as $$
  select public.create_sale_with_serials(p_lines, null::uuid, '7f000000-0000-4000-8000-000000000051', gen_random_uuid(), '[]'::jsonb, null::text, (now() at time zone 'Asia/Taipei')::date)
$$;

-- ── 店員 ──
select set_config('request.jwt.claim.sub', '7f000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"7f000000-0000-4000-8000-000000000002","session_id":"7f000000-0000-4000-8000-000000000012"}', true);
set local role authenticated;
do $$
declare v_sale uuid;
begin
  -- 店員看得到特價、會員價，看不到員工價（item_costs 只有店長能讀）。
  if (select special_price from public.items where id = '7f000000-0000-4000-8000-000000000031') <> 849 then raise exception 'staff should read special price'; end if;
  if exists (select 1 from public.item_costs) then raise exception 'staff must not read item_costs (staff price)'; end if;
  -- 沒帶價格別＝售價；特價、會員價照各自的單價；會員價 0 元＝0 元。
  v_sale := pg_temp.sell('[{"item_id":"7f000000-0000-4000-8000-000000000031","quantity":2},{"item_id":"7f000000-0000-4000-8000-000000000032","quantity":1,"price_tier":"member"}]');
  if (select total from public.sales where id = v_sale) <> 1900 then raise exception 'regular + zero member price total wrong: %', (select total from public.sales where id = v_sale); end if;
  if (select price_tier || ':' || unit_price from public.sale_lines where sale_id = v_sale and item_id = '7f000000-0000-4000-8000-000000000032') <> 'member:0.00' then raise exception 'member tier line wrong'; end if;
  if (select price_tier from public.sale_lines where sale_id = v_sale and item_id = '7f000000-0000-4000-8000-000000000031') <> 'regular' then raise exception 'default tier should be regular'; end if;
  v_sale := pg_temp.sell('[{"item_id":"7f000000-0000-4000-8000-000000000031","quantity":2,"price_tier":"special"}]');
  if (select total from public.sales where id = v_sale) <> 1698 then raise exception 'special price total wrong'; end if;
  if (select unit_price || '/' || subtotal from public.sale_lines where sale_id = v_sale) <> '849.00/1698.00' then raise exception 'special line wrong'; end if;
  v_sale := pg_temp.sell('[{"item_id":"7f000000-0000-4000-8000-000000000031","quantity":1,"price_tier":"member"}]');
  if (select total from public.sales where id = v_sale) <> 799 then raise exception 'member price total wrong'; end if;
end $$;
select pg_temp.expect_error($$select pg_temp.sell('[{"item_id":"7f000000-0000-4000-8000-000000000032","quantity":1,"price_tier":"special"}]')$$, '沒有設定特價');
select pg_temp.expect_error($$select pg_temp.sell('[{"item_id":"7f000000-0000-4000-8000-000000000031","quantity":1,"price_tier":"staff"}]')$$, '只有店長可以用員工價結帳');
select pg_temp.expect_error($$select pg_temp.sell('[{"item_id":"7f000000-0000-4000-8000-000000000031","quantity":1,"price_tier":"vip"}]')$$, '價格別無效');
-- 店員改價格：RLS 擋下（影響 0 列），下面店長段落會確認價格沒變。
update public.items set special_price = 1 where id = '7f000000-0000-4000-8000-000000000031';

-- ── 店長 ──
reset role;
select set_config('request.jwt.claim.sub', '7f000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"7f000000-0000-4000-8000-000000000001","session_id":"7f000000-0000-4000-8000-000000000011"}', true);
set local role authenticated;
do $$
declare v_sale uuid;
begin
  if (select special_price from public.items where id = '7f000000-0000-4000-8000-000000000031') <> 849 then raise exception 'staff must not change prices'; end if;
  if (select staff_price from public.item_costs where item_id = '7f000000-0000-4000-8000-000000000031') <> 600 then raise exception 'admin should read staff price'; end if;
  v_sale := pg_temp.sell('[{"item_id":"7f000000-0000-4000-8000-000000000031","quantity":3,"price_tier":"staff"}]');
  if (select total from public.sales where id = v_sale) <> 1800 then raise exception 'staff price total wrong'; end if;
  if (select price_tier from public.sale_lines where sale_id = v_sale) <> 'staff' then raise exception 'staff tier not recorded'; end if;
  -- 店長可以改三種價格；清成空值＝沒有設定。
  update public.items set special_price = null, member_price = 700 where id = '7f000000-0000-4000-8000-000000000031';
  update public.item_costs set staff_price = null where item_id = '7f000000-0000-4000-8000-000000000031';
  if (select stock from public.items where id = '7f000000-0000-4000-8000-000000000031') <> 12 then raise exception 'stock should be 20 - 2 - 2 - 1 - 3 = 12'; end if;
  -- 新增車身（連同序號）時，三種價格一起存入。
  perform public.create_serialized_item(jsonb_build_object('id', '7f000000-0000-4000-8000-000000000033', 'name', '測試車', 'category', '車身', 'sku', 'PT-BIKE',
    'price', 30000, 'stock', 1, 'minimum_stock', 0, 'special_price', 28000, 'member_price', null, 'staff_price', 25000,
    'vehicle_model_id', (select id from public.vehicle_models where is_universal)), 20000, '[{"id":"7f000000-0000-4000-8000-000000000071","serialNumber":"PT-SN-1"}]');
  if (select special_price::text || '/' || coalesce(member_price::text, 'null') from public.items where id = '7f000000-0000-4000-8000-000000000033') <> '28000.00/null' then raise exception 'serialized item tier prices wrong'; end if;
  if (select cost::text || '/' || staff_price::text from public.item_costs where item_id = '7f000000-0000-4000-8000-000000000033') <> '20000.00/25000.00' then raise exception 'serialized item staff price wrong'; end if;
end $$;
select pg_temp.expect_error($$select pg_temp.sell('[{"item_id":"7f000000-0000-4000-8000-000000000031","quantity":1,"price_tier":"staff"}]')$$, '沒有設定員工價');
select pg_temp.expect_error($$select pg_temp.sell('[{"item_id":"7f000000-0000-4000-8000-000000000032","quantity":1,"price_tier":"staff"}]')$$, '沒有設定員工價');
select pg_temp.expect_error($$update public.items set member_price = -1 where id = '7f000000-0000-4000-8000-000000000031'$$, 'check');
rollback;
