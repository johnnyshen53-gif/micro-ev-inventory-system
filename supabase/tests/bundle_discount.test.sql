-- 車身＋電池組合折扣：每 1 車身＋1 電池折 500；先組合、再車身電池、最後優惠代碼；報價單相同。整個測試在交易內，結束時 rollback。
begin;
insert into auth.users(id, email) values ('7d000000-0000-4000-8000-000000000001', 'bundle-admin@example.invalid');
update public.profiles set role = 'admin', active = true where id = '7d000000-0000-4000-8000-000000000001';
insert into auth.sessions(id, user_id) values ('7d000000-0000-4000-8000-000000000011', '7d000000-0000-4000-8000-000000000001');
insert into public.items(id, name, category, sku, price, stock, vehicle_model_id) values
  ('7d000000-0000-4000-8000-000000000031', '小偉士', '車身', 'BD-BODY', 30000, 10, (select id from public.vehicle_models where is_universal)),
  ('7d000000-0000-4000-8000-000000000032', '鋰電池', '電池', 'BD-BAT', 5000, 10, (select id from public.vehicle_models where is_universal)),
  ('7d000000-0000-4000-8000-000000000033', '安全帽', '外觀元件', 'BD-HELM', 800, 5, (select id from public.vehicle_models where is_universal));
insert into public.salespeople(id, name, active, created_by) values ('7d000000-0000-4000-8000-000000000051', '業務', true, '7d000000-0000-4000-8000-000000000001');

select set_config('request.jwt.claim.sub', '7d000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"7d000000-0000-4000-8000-000000000001","session_id":"7d000000-0000-4000-8000-000000000011"}', true);
set local role authenticated;

create function pg_temp.sell(p_lines jsonb, p_coupon text default null) returns uuid language sql as $$
  select public.create_sale_with_serials(p_lines, null::uuid, '7d000000-0000-4000-8000-000000000051', gen_random_uuid(), '[]'::jsonb, p_coupon,
    (now() at time zone 'Asia/Taipei')::date)
$$;

do $$
declare
  v_body jsonb := '{"item_id":"7d000000-0000-4000-8000-000000000031","quantity":1}';
  v_bat jsonb := '{"item_id":"7d000000-0000-4000-8000-000000000032","quantity":1}';
  v_sale uuid;
  v_q uuid;
begin
  -- 1) 1 車身＋1 電池：折 500，從車身扣。
  v_sale := pg_temp.sell(jsonb_build_array(v_body, v_bat));
  if (select total from public.sales where id = v_sale) <> 34500 or (select bundle_discount from public.sales where id = v_sale) <> 500
    or (select discount from public.sale_lines where sale_id = v_sale and item_id = '7d000000-0000-4000-8000-000000000031') <> 500
    or (select discount from public.sale_lines where sale_id = v_sale and item_id = '7d000000-0000-4000-8000-000000000032') <> 0 then
    raise exception 'single set wrong';
  end if;
  if (select (summary->>'bundle_discount')::numeric from public.audit_logs where target_id = v_sale and action = 'sale_created') <> 500 then
    raise exception 'audit missing bundle discount'; end if;

  -- 2) 2 車身＋1 電池：只配成 1 組，折 500；2 車身＋2 電池折 1,000。
  v_sale := pg_temp.sell(jsonb_build_array(jsonb_set(v_body, '{quantity}', '2'), v_bat));
  if (select bundle_discount from public.sales where id = v_sale) <> 500 or (select total from public.sales where id = v_sale) <> 64500 then
    raise exception 'two bodies one battery wrong'; end if;
  v_sale := pg_temp.sell(jsonb_build_array(jsonb_set(v_body, '{quantity}', '1'), jsonb_set(v_bat, '{quantity}', '2')));
  if (select bundle_discount from public.sales where id = v_sale) <> 500 then raise exception 'one body two batteries wrong'; end if;

  -- 3) 只有車身、或只有零件：不折。
  v_sale := pg_temp.sell(jsonb_build_array(v_body, '{"item_id":"7d000000-0000-4000-8000-000000000033","quantity":1}'::jsonb));
  if (select bundle_discount from public.sales where id = v_sale) <> 0 or (select total from public.sales where id = v_sale) <> 30800 then
    raise exception 'no battery should not discount'; end if;

  -- 4) 報價單：同樣折 500；總額不符會被擋。
  v_q := gen_random_uuid();
  perform public.save_quotation(jsonb_build_object('id', v_q, 'number', 'Q-BD-1', 'customerName', '王先生', 'total', 34500),
    '[{"itemId":"7d000000-0000-4000-8000-000000000031","itemName":"小偉士","quantity":1,"unitPrice":30000},
      {"itemId":"7d000000-0000-4000-8000-000000000032","itemName":"鋰電池","quantity":1,"unitPrice":5000}]');
  if (select total from public.quotations where id = v_q) <> 34500 or (select bundle_discount from public.quotations where id = v_q) <> 500
    or (select discount from public.quotation_lines where quotation_id = v_q and item_id = '7d000000-0000-4000-8000-000000000031') <> 500 then
    raise exception 'quotation bundle wrong'; end if;
  begin
    perform public.save_quotation(jsonb_build_object('id', gen_random_uuid(), 'number', 'Q-BD-2', 'customerName', '王先生', 'total', 35000),
      '[{"itemId":"7d000000-0000-4000-8000-000000000031","itemName":"小偉士","quantity":1,"unitPrice":30000},
        {"itemId":"7d000000-0000-4000-8000-000000000032","itemName":"鋰電池","quantity":1,"unitPrice":5000}]');
    raise exception 'undiscounted quotation total accepted';
  exception when raise_exception then if sqlerrm not like '%報價總額無效%' then raise; end if; end;
end $$;

-- 5) 和優惠代碼併用：先扣 500，再算代碼（10% → (35000−500)×10% ＝ 3450）。
do $$
declare v_sale uuid;
begin
  perform public.save_coupon(jsonb_build_object('code', 'BD10', 'kind', 'percent', 'value', 10,
    'startsOn', ((now() at time zone 'Asia/Taipei')::date - 1)::text, 'endsOn', ((now() at time zone 'Asia/Taipei')::date + 1)::text));
  v_sale := pg_temp.sell('[{"item_id":"7d000000-0000-4000-8000-000000000031","quantity":1},{"item_id":"7d000000-0000-4000-8000-000000000032","quantity":1}]', 'BD10');
  if (select total from public.sales where id = v_sale) <> 31050 then
    raise exception 'coupon after bundle wrong: %', (select total from public.sales where id = v_sale); end if;
end $$;
rollback;
