-- 優惠代碼：店長設定、店員檢查與結帳套用、與特惠組合併用、使用上限、權限。整個測試在交易內，結束時 rollback。
begin;
insert into auth.users(id, email) values
  ('78000000-0000-4000-8000-000000000001', 'coupon-admin@example.invalid'),
  ('78000000-0000-4000-8000-000000000002', 'coupon-clerk@example.invalid');
update public.profiles set role = 'admin', active = true where id = '78000000-0000-4000-8000-000000000001';
update public.profiles set role = 'clerk', active = true where id = '78000000-0000-4000-8000-000000000002';
insert into auth.sessions(id, user_id) values
  ('78000000-0000-4000-8000-000000000011', '78000000-0000-4000-8000-000000000001'),
  ('78000000-0000-4000-8000-000000000012', '78000000-0000-4000-8000-000000000002');
insert into public.items(id, name, category, sku, price, stock) values
  ('78000000-0000-4000-8000-000000000031', '行車記錄器', '電控元件', 'CP-CAM', 6550, 20),
  ('78000000-0000-4000-8000-000000000032', '輪胎', '機構元件', 'CP-TIRE', 1450, 20),
  ('78000000-0000-4000-8000-000000000033', '後照鏡', '外觀元件', 'CP-MIR', 800, 20);
insert into public.salespeople(id, name, active, created_by) values
  ('78000000-0000-4000-8000-000000000041', '代碼業務', true, '78000000-0000-4000-8000-000000000001');

select set_config('request.jwt.claim.sub', '78000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"78000000-0000-4000-8000-000000000001","session_id":"78000000-0000-4000-8000-000000000011"}', true);
set local role authenticated;

create function pg_temp.expect_error(p_sql text, p_message text) returns void language plpgsql as $$
begin
  execute p_sql;
  raise exception 'expected error containing %', p_message;
exception when others then
  if sqlerrm not like '%' || p_message || '%' then raise; end if;
end $$;

-- 店長建立代碼：OCT10＝打 9 折（折 10%），限用 2 次；VIP500＝折 500；OLD＝已過期；OFF＝停用。組合 A＝三件 8000。
do $$
declare v_start text := (current_date - 2)::text; v_end text := (current_date + 2)::text;
begin
  perform set_config('test.oct', public.save_coupon(jsonb_build_object('code', ' oct10 ', 'description', '10 月 9 折', 'kind', 'percent', 'value', 10,
    'startsOn', v_start, 'endsOn', v_end, 'usageLimit', 2))::text, true);
  perform public.save_coupon(jsonb_build_object('code', 'VIP500', 'kind', 'amount', 'value', 500, 'startsOn', v_start, 'endsOn', v_end));
  perform public.save_coupon(jsonb_build_object('code', 'OLD', 'kind', 'amount', 'value', 100, 'startsOn', '2020-01-01', 'endsOn', '2020-01-31'));
  perform public.save_coupon(jsonb_build_object('code', 'OFF', 'kind', 'amount', 'value', 100, 'startsOn', v_start, 'endsOn', v_end, 'active', false));
  if (select value->>'code' from jsonb_array_elements(public.get_coupons()) where value->>'id' = current_setting('test.oct')) <> 'OCT10' then raise exception 'code should be upper-cased'; end if;
  perform pg_temp.expect_error(format('select public.save_coupon(%L)', jsonb_build_object('code', 'oct10', 'kind', 'amount', 'value', 1, 'startsOn', v_start, 'endsOn', v_end)), '已經存在');
  perform pg_temp.expect_error(format('select public.save_coupon(%L)', jsonb_build_object('code', 'A B', 'kind', 'amount', 'value', 1, 'startsOn', v_start, 'endsOn', v_end)), '英文字母、數字');
  perform pg_temp.expect_error(format('select public.save_coupon(%L)', jsonb_build_object('code', 'BIG', 'kind', 'percent', 'value', 100, 'startsOn', v_start, 'endsOn', v_end)), '須小於 100');
  perform set_config('test.a', public.save_promotion(jsonb_build_object('name', 'A 保養組', 'startsOn', v_start, 'endsOn', v_end, 'comboPrice', 8000,
    'items', '[{"itemId":"78000000-0000-4000-8000-000000000031","quantity":1},{"itemId":"78000000-0000-4000-8000-000000000032","quantity":1},{"itemId":"78000000-0000-4000-8000-000000000033","quantity":1}]'::jsonb))::text, true);
  if jsonb_array_length(public.get_coupons()) <> 4 then raise exception 'admin should list coupons'; end if;
end $$;

-- 店員。
select set_config('request.jwt.claim.sub', '78000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"78000000-0000-4000-8000-000000000002","session_id":"78000000-0000-4000-8000-000000000012"}', true);
do $$
declare
  v_person uuid := '78000000-0000-4000-8000-000000000041';
  v_cam uuid := '78000000-0000-4000-8000-000000000031';
  v_tire uuid := '78000000-0000-4000-8000-000000000032';
  v_mirror uuid := '78000000-0000-4000-8000-000000000033';
  v_lines jsonb;
  v_sale uuid;
  v_checkout uuid := gen_random_uuid();
begin
  -- 店員不能列出代碼，也不能直接讀表；只能檢查自己輸入的代碼。
  begin perform public.get_coupons(); raise exception 'clerk listed coupons'; exception when insufficient_privilege then null; end;
  begin perform count(*) from app_private.coupons; raise exception 'clerk read coupon table'; exception when insufficient_privilege then null; end;
  if public.check_coupon('oct10')->>'kind' <> 'percent' then raise exception 'check_coupon should accept lowercase'; end if;
  perform pg_temp.expect_error('select public.check_coupon(''NOPE'')', '查無優惠代碼');
  perform pg_temp.expect_error('select public.check_coupon(''OLD'')', '已過期');
  perform pg_temp.expect_error('select public.check_coupon(''OFF'')', '已停用');

  -- 1) 組合 A＋OCT10：組合後 8000，再 9 折 → 折 800、實收 7200。
  --    代碼折扣依組合後的實收占比攤：記錄器 5953、輪胎 1319、後照鏡 728 →
  --    輪胎 floor(800×1319/8000)=131、後照鏡 floor(800×728/8000)=72、記錄器拿剩下 597。
  v_lines := jsonb_build_array(jsonb_build_object('item_id', v_cam, 'quantity', 1),
    jsonb_build_object('item_id', v_tire, 'quantity', 1), jsonb_build_object('item_id', v_mirror, 'quantity', 1));
  v_sale := public.create_sale_with_serials(v_lines, null::uuid, v_person, v_checkout,
    jsonb_build_array(jsonb_build_object('promotionId', current_setting('test.a'), 'times', 1)), 'oct10');
  if (select total from public.sales where id = v_sale) <> 7200 then raise exception 'combo + coupon total should be 7200, got %', (select total from public.sales where id = v_sale); end if;
  if (select string_agg(item_name || ':' || discount::int || '/' || subtotal::int, ',' order by item_name) from public.sale_lines where sale_id = v_sale)
    <> '後照鏡:144/656,行車記錄器:1194/5356,輪胎:262/1188' then
    raise exception 'coupon allocation wrong: %', (select string_agg(item_name || ':' || discount || '/' || subtotal, ',' order by item_name) from public.sale_lines where sale_id = v_sale);
  end if;
  if (select discount from public.sale_coupons where sale_id = v_sale and code = 'OCT10') <> 800 then raise exception 'sale_coupons missing'; end if;
  if (select (summary->>'coupon_discount')::numeric from public.audit_logs where target_id = v_sale and action = 'sale_created') <> 800 then raise exception 'audit should record coupon'; end if;
  -- 重送同一個結帳：不重複使用次數。
  perform public.create_sale_with_serials(v_lines, null::uuid, v_person, v_checkout,
    jsonb_build_array(jsonb_build_object('promotionId', current_setting('test.a'), 'times', 1)), 'oct10');
  if (select count(*) from public.sale_coupons where code = 'OCT10') <> 1 then raise exception 'retry used coupon twice'; end if;

  -- 2) 折抵金額不會超過訂單金額：後照鏡 800 用 VIP500 → 300。
  v_sale := public.create_sale_with_serials(jsonb_build_array(jsonb_build_object('item_id', v_mirror, 'quantity', 1)), null::uuid, v_person, gen_random_uuid(), '[]'::jsonb, 'VIP500');
  if (select total from public.sales where id = v_sale) <> 300 then raise exception 'amount coupon wrong'; end if;
  v_sale := public.create_sale_with_serials(jsonb_build_array(jsonb_build_object('item_id', v_mirror, 'quantity', 1)), null::uuid, v_person, gen_random_uuid(), '[]'::jsonb, 'VIP500');
  perform public.create_sale_with_serials(jsonb_build_array(jsonb_build_object('item_id', v_mirror, 'quantity', 1)), null::uuid, v_person, gen_random_uuid(), '[]'::jsonb, 'VIP500');
  -- 打折捨去到元：輪胎 1450 打 9 折 → 折 145。
  v_sale := public.create_sale_with_serials(jsonb_build_array(jsonb_build_object('item_id', v_tire, 'quantity', 1)), null::uuid, v_person, gen_random_uuid(), '[]'::jsonb, 'OCT10');
  if (select total from public.sales where id = v_sale) <> 1305 then raise exception 'percent coupon should floor to dollars'; end if;

  -- 3) OCT10 限用 2 次，已用完：結帳整筆取消、庫存不變。舊網頁 4 個參數照常結帳。
  perform set_config('test.stock', (select stock from public.items where id = v_tire)::text, true);
  perform pg_temp.expect_error(format('select public.create_sale_with_serials(%L::jsonb, null::uuid, %L::uuid, gen_random_uuid(), ''[]''::jsonb, ''OCT10'')',
    jsonb_build_array(jsonb_build_object('item_id', v_tire, 'quantity', 1)), v_person), '已達使用上限');
  if (select stock from public.items where id = v_tire) <> current_setting('test.stock')::integer then raise exception 'failed coupon must cancel the sale'; end if;
  v_sale := public.create_sale_with_serials(jsonb_build_array(jsonb_build_object('item_id', v_tire, 'quantity', 1)), null::uuid, v_person, gen_random_uuid());
  if (select total from public.sales where id = v_sale) <> 1450 then raise exception 'legacy call should still work'; end if;
  begin insert into public.sale_coupons(sale_id, coupon_id, code, kind, value, discount)
    values (v_sale, current_setting('test.oct')::uuid, 'X', 'amount', 1, 1);
    raise exception 'clerk wrote sale_coupons';
  exception when insufficient_privilege then null; end;
end $$;

-- 4) 店長：改代碼內容（含代碼本身）、舊單保留快照；用過的代碼不能刪。
select set_config('request.jwt.claim.sub', '78000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"78000000-0000-4000-8000-000000000001","session_id":"78000000-0000-4000-8000-000000000011"}', true);
do $$
begin
  perform public.save_coupon(jsonb_build_object('id', current_setting('test.oct'), 'code', 'NOV15', 'kind', 'percent', 'value', 15,
    'startsOn', (current_date - 2)::text, 'endsOn', (current_date + 2)::text, 'usageLimit', 10));
  if (select count(*) from public.sale_coupons where code = 'OCT10') <> 2 then raise exception 'old sales should keep the old code'; end if;
  if (select (value->>'usedCount')::int from jsonb_array_elements(public.get_coupons()) where value->>'code' = 'NOV15') <> 2 then raise exception 'used count wrong'; end if;
  perform pg_temp.expect_error(format('select public.delete_coupon(%L)', current_setting('test.oct')), '已有銷售紀錄');
  perform public.delete_coupon((select (value->>'id')::uuid from jsonb_array_elements(public.get_coupons()) where value->>'code' = 'OFF'));
end $$;
rollback;
