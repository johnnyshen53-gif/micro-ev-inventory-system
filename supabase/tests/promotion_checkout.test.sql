-- 特惠組合（第 2 步）：結帳套用組合價、折扣攤提、數量與期間檢查、失敗整筆取消。整個測試在交易內，結束時 rollback。
begin;
insert into auth.users(id, email) values
  ('76000000-0000-4000-8000-000000000001', 'promo-co-admin@example.invalid'),
  ('76000000-0000-4000-8000-000000000002', 'promo-co-clerk@example.invalid');
update public.profiles set role = 'admin', active = true where id = '76000000-0000-4000-8000-000000000001';
update public.profiles set role = 'clerk', active = true where id = '76000000-0000-4000-8000-000000000002';
insert into auth.sessions(id, user_id) values
  ('76000000-0000-4000-8000-000000000011', '76000000-0000-4000-8000-000000000001'),
  ('76000000-0000-4000-8000-000000000012', '76000000-0000-4000-8000-000000000002');
insert into public.items(id, name, category, sku, price, stock) values
  ('76000000-0000-4000-8000-000000000031', '行車記錄器', '電控元件', 'PC-CAM', 6550, 10),
  ('76000000-0000-4000-8000-000000000032', '輪胎', '機構元件', 'PC-TIRE', 1450, 10),
  ('76000000-0000-4000-8000-000000000033', '後照鏡', '外觀元件', 'PC-MIR', 800, 10);
insert into public.salespeople(id, name, active, created_by) values
  ('76000000-0000-4000-8000-000000000041', '組合業務', true, '76000000-0000-4000-8000-000000000001');

select set_config('request.jwt.claim.sub', '76000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"76000000-0000-4000-8000-000000000001","session_id":"76000000-0000-4000-8000-000000000011"}', true);
set local role authenticated;

create function pg_temp.expect_error(p_sql text, p_message text) returns void language plpgsql as $$
begin
  execute p_sql;
  raise exception 'expected error containing %', p_message;
exception when others then
  if sqlerrm not like '%' || p_message || '%' then raise; end if;
end $$;

-- 店長建立組合：A＝記錄器＋輪胎＋後照鏡 8000（原價 8800）；B＝輪胎 2 條 2500（原價 2900）；C＝已過期；D＝已停用。
do $$
declare
  v_items jsonb := '[{"itemId":"76000000-0000-4000-8000-000000000031","quantity":1},{"itemId":"76000000-0000-4000-8000-000000000032","quantity":1},{"itemId":"76000000-0000-4000-8000-000000000033","quantity":1}]';
  v_start text := (current_date - 2)::text;
  v_end text := (current_date + 2)::text;
begin
  perform set_config('test.a', public.save_promotion(jsonb_build_object('name', 'A 保養組', 'startsOn', v_start, 'endsOn', v_end,
    'comboPrice', 8000, 'items', v_items))::text, true);
  perform set_config('test.b', public.save_promotion(jsonb_build_object('name', 'B 輪胎組', 'startsOn', v_start, 'endsOn', v_end,
    'comboPrice', 2500, 'items', '[{"itemId":"76000000-0000-4000-8000-000000000032","quantity":2}]'::jsonb))::text, true);
  perform set_config('test.c', public.save_promotion(jsonb_build_object('name', 'C 過期組', 'startsOn', '2020-01-01', 'endsOn', '2020-01-31',
    'comboPrice', 8000, 'items', v_items))::text, true);
  perform set_config('test.d', public.save_promotion(jsonb_build_object('name', 'D 停用組', 'startsOn', v_start, 'endsOn', v_end,
    'comboPrice', 8000, 'active', false, 'items', v_items))::text, true);
end $$;

-- 店員結帳。
select set_config('request.jwt.claim.sub', '76000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"76000000-0000-4000-8000-000000000002","session_id":"76000000-0000-4000-8000-000000000012"}', true);
do $$
declare
  v_person uuid := '76000000-0000-4000-8000-000000000041';
  v_cam uuid := '76000000-0000-4000-8000-000000000031';
  v_tire uuid := '76000000-0000-4000-8000-000000000032';
  v_mirror uuid := '76000000-0000-4000-8000-000000000033';
  v_a uuid := current_setting('test.a')::uuid;
  v_b uuid := current_setting('test.b')::uuid;
  v_checkout uuid := gen_random_uuid();
  v_lines jsonb;
  v_sale uuid;
begin
  -- 1) 套用 A×1：折扣 800。輪胎 floor(800×1450/8800)=131、後照鏡 floor(800×800/8800)=72，記錄器拿剩下 597。
  v_lines := jsonb_build_array(jsonb_build_object('item_id', v_cam, 'quantity', 1),
    jsonb_build_object('item_id', v_tire, 'quantity', 1), jsonb_build_object('item_id', v_mirror, 'quantity', 1));
  v_sale := public.create_sale_with_serials(v_lines, null::uuid, v_person, v_checkout,
    jsonb_build_array(jsonb_build_object('promotionId', v_a, 'times', 1)));
  if (select total from public.sales where id = v_sale) <> 8000 then raise exception 'sale total should be 8000'; end if;
  if (select discount from public.sale_lines where sale_id = v_sale and item_id = v_cam) <> 597
    or (select discount from public.sale_lines where sale_id = v_sale and item_id = v_tire) <> 131
    or (select discount from public.sale_lines where sale_id = v_sale and item_id = v_mirror) <> 72 then
    raise exception 'discount allocation wrong: %', (select jsonb_agg(jsonb_build_object(item_name, discount)) from public.sale_lines where sale_id = v_sale);
  end if;
  if (select subtotal from public.sale_lines where sale_id = v_sale and item_id = v_cam) <> 5953
    or (select unit_price from public.sale_lines where sale_id = v_sale and item_id = v_cam) <> 6550 then
    raise exception 'unit price must stay list price and subtotal must be net';
  end if;
  if (select count(*) from public.sale_promotions where sale_id = v_sale and promotion_id = v_a and times = 1
      and combo_price = 8000 and list_total = 8800 and discount = 800 and promotion_name = 'A 保養組') <> 1 then
    raise exception 'sale_promotions snapshot missing';
  end if;
  if (select summary->>'promotion_discount' from public.audit_logs where target_id = v_sale and action = 'sale_created')::numeric <> 800 then
    raise exception 'audit log should record discount';
  end if;

  -- 2) 同一個 checkout id 重送：回傳同一張單，不重複寫組合紀錄。
  perform public.create_sale_with_serials(v_lines, null::uuid, v_person, v_checkout,
    jsonb_build_array(jsonb_build_object('promotionId', v_a, 'times', 1)));
  if (select count(*) from public.sale_promotions where sale_id = v_sale) <> 1 then raise exception 'retry duplicated promotions'; end if;

  -- 3) 同一張單套 A×1＋B×2：輪胎需要 1＋4＝5 條。B 折扣 (2900−2500)×2＝800，全在輪胎上；合計 8000＋5000＋其他。
  v_lines := jsonb_build_array(jsonb_build_object('item_id', v_cam, 'quantity', 1),
    jsonb_build_object('item_id', v_tire, 'quantity', 5), jsonb_build_object('item_id', v_mirror, 'quantity', 1));
  v_sale := public.create_sale_with_serials(v_lines, null::uuid, v_person, gen_random_uuid(),
    jsonb_build_array(jsonb_build_object('promotionId', v_a, 'times', 1), jsonb_build_object('promotionId', v_b, 'times', 2)));
  if (select total from public.sales where id = v_sale) <> 13000 then raise exception 'A+B×2 total should be 13000, got %', (select total from public.sales where id = v_sale); end if;
  if (select discount from public.sale_lines where sale_id = v_sale and item_id = v_tire) <> 931 then raise exception 'tire discount should be 131+800'; end if;

  -- 4) 舊網頁：4 個參數呼叫照常結帳，不套組合。
  v_sale := public.create_sale_with_serials(jsonb_build_array(jsonb_build_object('item_id', v_mirror, 'quantity', 1)),
    null::uuid, v_person, gen_random_uuid());
  if (select total from public.sales where id = v_sale) <> 800 or (select discount from public.sale_lines where sale_id = v_sale) <> 0 then
    raise exception 'legacy call should sell at list price';
  end if;
end $$;

-- 5) 不符合規則：整筆取消，庫存不變。
do $$
declare
  v_person uuid := '76000000-0000-4000-8000-000000000041';
  v_lines jsonb := '[{"item_id":"76000000-0000-4000-8000-000000000031","quantity":1},{"item_id":"76000000-0000-4000-8000-000000000032","quantity":1},{"item_id":"76000000-0000-4000-8000-000000000033","quantity":1}]';
  v_stock integer := (select stock from public.items where id = '76000000-0000-4000-8000-000000000032');
  v_sales integer := (select count(*) from public.sales);
  v_call text := 'select public.create_sale_with_serials(%L::jsonb, null::uuid, %L::uuid, gen_random_uuid(), %L::jsonb)';
begin
  perform pg_temp.expect_error(format(v_call, v_lines, v_person, jsonb_build_array(jsonb_build_object('promotionId', current_setting('test.b'), 'times', 1))), '購物車數量不足');
  perform pg_temp.expect_error(format(v_call, v_lines, v_person, jsonb_build_array(jsonb_build_object('promotionId', current_setting('test.a'), 'times', 2))), '購物車數量不足');
  perform pg_temp.expect_error(format(v_call, v_lines, v_person, jsonb_build_array(jsonb_build_object('promotionId', current_setting('test.c'), 'times', 1))), '不在優惠期間或已停用');
  perform pg_temp.expect_error(format(v_call, v_lines, v_person, jsonb_build_array(jsonb_build_object('promotionId', current_setting('test.d'), 'times', 1))), '不在優惠期間或已停用');
  perform pg_temp.expect_error(format(v_call, v_lines, v_person, jsonb_build_array(jsonb_build_object('promotionId', current_setting('test.a'), 'times', 1),
    jsonb_build_object('promotionId', current_setting('test.a'), 'times', 1))), '用組數表示');
  perform pg_temp.expect_error(format(v_call, v_lines, v_person, jsonb_build_array(jsonb_build_object('promotionId', current_setting('test.a'), 'times', 0))), '組數須為 1～99');
  perform pg_temp.expect_error(format(v_call, '[{"item_id":"76000000-0000-4000-8000-000000000031","quantity":1}]', v_person,
    jsonb_build_array(jsonb_build_object('promotionId', current_setting('test.a'), 'times', 1))), '購物車缺少');
  perform pg_temp.expect_error(format(v_call, v_lines, v_person, jsonb_build_array(jsonb_build_object('promotionId', gen_random_uuid(), 'times', 1))), '特惠組合不存在');
  if (select stock from public.items where id = '76000000-0000-4000-8000-000000000032') <> v_stock
    or (select count(*) from public.sales) <> v_sales then
    raise exception 'failed promotion must cancel the whole sale';
  end if;
  -- 店員不能直接改組合紀錄。
  begin insert into public.sale_promotions(sale_id, promotion_id, promotion_name, times, combo_price, list_total, discount)
    select id, current_setting('test.a')::uuid, 'x', 1, 1, 2, 1 from public.sales limit 1;
    raise exception 'clerk wrote sale_promotions';
  exception when insufficient_privilege then null; end;
end $$;

-- 6) 店長：用過的組合不能刪除（訊息清楚），沒用過的可以刪。原價變動後組合價不划算時不能套用。
select set_config('request.jwt.claim.sub', '76000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"76000000-0000-4000-8000-000000000001","session_id":"76000000-0000-4000-8000-000000000011"}', true);
do $$
begin
  perform pg_temp.expect_error(format('select public.delete_promotion(%L)', current_setting('test.a')), '已有銷售紀錄');
  perform public.delete_promotion(current_setting('test.c')::uuid);
  update public.items set price = 1000 where id = '76000000-0000-4000-8000-000000000032';
  perform pg_temp.expect_error(format('select public.create_sale_with_serials(%L::jsonb, null::uuid, %L::uuid, gen_random_uuid(), %L::jsonb)',
    '[{"item_id":"76000000-0000-4000-8000-000000000032","quantity":2}]', '76000000-0000-4000-8000-000000000041',
    jsonb_build_array(jsonb_build_object('promotionId', current_setting('test.b'), 'times', 1))), '已不高於組合價');
end $$;
rollback;
