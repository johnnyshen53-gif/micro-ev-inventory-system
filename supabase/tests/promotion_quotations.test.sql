-- 特惠組合（第 3 步）：報價單套用組合價。整個測試在交易內，結束時 rollback。
begin;
insert into auth.users(id, email) values
  ('77000000-0000-4000-8000-000000000001', 'promo-q-admin@example.invalid'),
  ('77000000-0000-4000-8000-000000000002', 'promo-q-clerk@example.invalid');
update public.profiles set role = 'admin', active = true where id = '77000000-0000-4000-8000-000000000001';
update public.profiles set role = 'clerk', active = true where id = '77000000-0000-4000-8000-000000000002';
insert into auth.sessions(id, user_id) values
  ('77000000-0000-4000-8000-000000000011', '77000000-0000-4000-8000-000000000001'),
  ('77000000-0000-4000-8000-000000000012', '77000000-0000-4000-8000-000000000002');
insert into public.customers(id, member_number, name, phone, created_by) values
  ('77000000-0000-4000-8000-000000000021', 'M770001', '報價客', '0911000000', '77000000-0000-4000-8000-000000000001');
insert into public.items(id, name, category, sku, price, stock) values
  ('77000000-0000-4000-8000-000000000031', '行車記錄器', '電控元件', 'PQ-CAM', 6550, 0),
  ('77000000-0000-4000-8000-000000000032', '輪胎', '機構元件', 'PQ-TIRE', 1450, 0),
  ('77000000-0000-4000-8000-000000000033', '後照鏡', '外觀元件', 'PQ-MIR', 800, 0);
update public.shop_settings set hourly_rate = 800 where id = 1;

select set_config('request.jwt.claim.sub', '77000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"77000000-0000-4000-8000-000000000001","session_id":"77000000-0000-4000-8000-000000000011"}', true);
set local role authenticated;

create function pg_temp.expect_error(p_sql text, p_message text) returns void language plpgsql as $$
begin
  execute p_sql;
  raise exception 'expected error containing %', p_message;
exception when others then
  if sqlerrm not like '%' || p_message || '%' then raise; end if;
end $$;

-- A＝記錄器＋輪胎＋後照鏡 8000（原價 8800）；P＝輪胎 2 條 100（原價 2900，用來測折扣跨列）；X＝已過期。
do $$
declare
  v_items jsonb := '[{"itemId":"77000000-0000-4000-8000-000000000031","quantity":1},{"itemId":"77000000-0000-4000-8000-000000000032","quantity":1},{"itemId":"77000000-0000-4000-8000-000000000033","quantity":1}]';
begin
  perform set_config('test.a', public.save_promotion(jsonb_build_object('name', 'A 保養組', 'startsOn', (current_date - 2)::text,
    'endsOn', (current_date + 2)::text, 'comboPrice', 8000, 'items', v_items))::text, true);
  perform set_config('test.p', public.save_promotion(jsonb_build_object('name', 'P 輪胎組', 'startsOn', (current_date - 2)::text,
    'endsOn', (current_date + 2)::text, 'comboPrice', 100, 'items', '[{"itemId":"77000000-0000-4000-8000-000000000032","quantity":2}]'::jsonb))::text, true);
  perform set_config('test.x', public.save_promotion(jsonb_build_object('name', 'X 過期組', 'startsOn', '2020-01-01',
    'endsOn', '2020-01-31', 'comboPrice', 8000, 'items', v_items))::text, true);
end $$;

-- 店員建立報價。
select set_config('request.jwt.claim.sub', '77000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"77000000-0000-4000-8000-000000000002","session_id":"77000000-0000-4000-8000-000000000012"}', true);
do $$
declare
  v_customer text := '77000000-0000-4000-8000-000000000021';
  v_cam jsonb := '{"itemId":"77000000-0000-4000-8000-000000000031","itemName":"行車記錄器","quantity":1,"unitPrice":6550,"installationRequired":true,"laborHours":1,"hourlyRate":800,"laborAmount":800}';
  v_tire jsonb := '{"itemId":"77000000-0000-4000-8000-000000000032","itemName":"輪胎","quantity":1,"unitPrice":1450}';
  v_mirror jsonb := '{"itemId":"77000000-0000-4000-8000-000000000033","itemName":"後照鏡","quantity":1,"unitPrice":800}';
  v_q uuid;
begin
  -- 1) 套 A×1：材料 8800＋工資 800−折扣 800＝8800；折扣 597／131／72 和銷售結帳一樣。工資不打折。
  v_q := gen_random_uuid();
  perform public.save_quotation(jsonb_build_object('id', v_q, 'number', 'Q-PROMO-1', 'customerId', v_customer, 'total', 8800,
      'promotions', jsonb_build_array(jsonb_build_object('promotionId', current_setting('test.a'), 'times', 1))),
    jsonb_build_array(v_cam, v_tire, v_mirror));
  if (select total from public.quotations where id = v_q) <> 8800 then raise exception 'quote total should be 8800'; end if;
  if (select string_agg(item_name || ':' || subtotal::int || '-' || discount::int || '+' || labor_amount::int, ',' order by item_name)
      from public.quotation_lines where quotation_id = v_q) <> '後照鏡:800-72+0,行車記錄器:6550-597+800,輪胎:1450-131+0' then
    raise exception 'quote discounts wrong: %', (select string_agg(item_name || ':' || subtotal || '-' || discount, ',') from public.quotation_lines where quotation_id = v_q);
  end if;
  if (select count(*) from public.quotation_promotions where quotation_id = v_q and promotion_name = 'A 保養組' and times = 1 and discount = 800 and list_total = 8800) <> 1 then
    raise exception 'quotation_promotions snapshot missing';
  end if;

  -- 2) 同一品項分兩列：P 折扣 2800，第一列輪胎扣滿 1450，剩下 1350 扣在第二列。
  v_q := gen_random_uuid();
  perform public.save_quotation(jsonb_build_object('id', v_q, 'number', 'Q-PROMO-2', 'customerId', v_customer, 'total', 100,
      'promotions', jsonb_build_array(jsonb_build_object('promotionId', current_setting('test.p'), 'times', 1))),
    jsonb_build_array(v_tire, v_tire));
  if (select array_agg(discount order by discount desc) from public.quotation_lines where quotation_id = v_q) <> array[1450, 1350]::numeric[] then
    raise exception 'discount should spill to the next line of the same item';
  end if;

  -- 3) 沒帶 promotions：和以前一樣。
  v_q := gen_random_uuid();
  perform public.save_quotation(jsonb_build_object('id', v_q, 'number', 'Q-PROMO-3', 'customerId', v_customer, 'total', 800),
    jsonb_build_array(v_mirror));
  if (select discount from public.quotation_lines where quotation_id = v_q) <> 0 then raise exception 'plain quote should not discount'; end if;

  -- 4) 錯誤情況：總額沒扣折扣、過期組合、數量不足 → 報價不建立。
  perform pg_temp.expect_error(format('select public.save_quotation(%L, %L)', jsonb_build_object('id', gen_random_uuid(), 'number', 'Q-BAD-1', 'customerId', v_customer, 'total', 9600,
      'promotions', jsonb_build_array(jsonb_build_object('promotionId', current_setting('test.a'), 'times', 1))), jsonb_build_array(v_cam, v_tire, v_mirror)), '報價總額無效');
  perform pg_temp.expect_error(format('select public.save_quotation(%L, %L)', jsonb_build_object('id', gen_random_uuid(), 'number', 'Q-BAD-2', 'customerId', v_customer, 'total', 8800,
      'promotions', jsonb_build_array(jsonb_build_object('promotionId', current_setting('test.x'), 'times', 1))), jsonb_build_array(v_cam, v_tire, v_mirror)), '不在優惠期間');
  perform pg_temp.expect_error(format('select public.save_quotation(%L, %L)', jsonb_build_object('id', gen_random_uuid(), 'number', 'Q-BAD-3', 'customerId', v_customer, 'total', 100,
      'promotions', jsonb_build_array(jsonb_build_object('promotionId', current_setting('test.p'), 'times', 1))), jsonb_build_array(v_tire)), '數量不足');
  if exists (select 1 from public.quotations where quote_number like 'Q-BAD-%') then raise exception 'failed quote was saved'; end if;
  begin insert into public.quotation_promotions(quotation_id, promotion_id, promotion_name, times, combo_price, list_total, discount)
    select id, current_setting('test.a')::uuid, 'x', 1, 1, 2, 1 from public.quotations limit 1;
    raise exception 'clerk wrote quotation_promotions';
  exception when insufficient_privilege then null; end;
end $$;

-- 5) 店長：用在報價單的組合不能刪除。
select set_config('request.jwt.claim.sub', '77000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"77000000-0000-4000-8000-000000000001","session_id":"77000000-0000-4000-8000-000000000011"}', true);
do $$
begin
  perform pg_temp.expect_error(format('select public.delete_promotion(%L)', current_setting('test.a')), '已用在報價單');
  perform public.delete_promotion(current_setting('test.x')::uuid);
end $$;
rollback;
