-- 特惠組合（第 1 步）：店長新增／修改／刪除組合的規則與權限。整個測試在交易內，結束時 rollback。
begin;
insert into auth.users(id, email) values
  ('75000000-0000-4000-8000-000000000001', 'promo-admin@example.invalid'),
  ('75000000-0000-4000-8000-000000000002', 'promo-clerk@example.invalid');
update public.profiles set role = 'admin', active = true where id = '75000000-0000-4000-8000-000000000001';
update public.profiles set role = 'clerk', active = true where id = '75000000-0000-4000-8000-000000000002';
insert into auth.sessions(id, user_id) values
  ('75000000-0000-4000-8000-000000000011', '75000000-0000-4000-8000-000000000001'),
  ('75000000-0000-4000-8000-000000000012', '75000000-0000-4000-8000-000000000002');
insert into public.items(id, name, category, sku, price, stock) values
  ('75000000-0000-4000-8000-000000000031', '鋰電池', '電池', 'PR-BAT', 12000, 5),
  ('75000000-0000-4000-8000-000000000032', '輪胎', '機構元件', 'PR-TIRE', 1450, 5),
  ('75000000-0000-4000-8000-000000000033', '行車記錄器', '電控元件', 'PR-CAM', 6550, 5);

select set_config('request.jwt.claim.sub', '75000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"75000000-0000-4000-8000-000000000001","session_id":"75000000-0000-4000-8000-000000000011"}', true);
set local role authenticated;

create function pg_temp.expect_error(p_sql text, p_message text) returns void language plpgsql as $$
begin
  execute p_sql;
  raise exception 'expected error containing %', p_message;
exception when others then
  if sqlerrm not like '%' || p_message || '%' then raise; end if;
end $$;

do $$
declare v_id uuid; v_base jsonb := '{"name":"10 月換電池保養組","startsOn":"2026-10-01","endsOn":"2026-10-31","comboPrice":18800,
  "items":[{"itemId":"75000000-0000-4000-8000-000000000031","quantity":1},{"itemId":"75000000-0000-4000-8000-000000000032","quantity":1},
           {"itemId":"75000000-0000-4000-8000-000000000033","quantity":1}]}';
begin
  v_id := public.save_promotion(v_base);
  if (select count(*) from public.promotion_items where promotion_id = v_id) <> 3 then raise exception 'items not saved'; end if;
  if (select combo_price from public.promotions where id = v_id) <> 18800 then raise exception 'price not saved'; end if;

  -- 修改：換內容、停用；舊內容整批取代。
  perform public.save_promotion(v_base || jsonb_build_object('id', v_id, 'active', false, 'comboPrice', 2500,
    'items', '[{"itemId":"75000000-0000-4000-8000-000000000032","quantity":2}]'::jsonb));
  if (select count(*) from public.promotion_items where promotion_id = v_id) <> 1 then raise exception 'items not replaced'; end if;
  if (select active from public.promotions where id = v_id) then raise exception 'not deactivated'; end if;

  perform pg_temp.expect_error(format('select public.save_promotion(%L)', v_base || '{"comboPrice":20000}'), '須低於目前原價合計');
  perform pg_temp.expect_error(format('select public.save_promotion(%L)', v_base || '{"endsOn":"2026-09-30"}'), '結束日不可早於開始日');
  perform pg_temp.expect_error(format('select public.save_promotion(%L)', v_base || '{"name":"  "}'), '請填寫組合名稱');
  perform pg_temp.expect_error(format('select public.save_promotion(%L)', v_base || '{"items":[{"itemId":"75000000-0000-4000-8000-000000000031","quantity":1}]}'), '至少要有 2 件');
  perform pg_temp.expect_error(format('select public.save_promotion(%L)', v_base || '{"items":[{"itemId":"75000000-0000-4000-8000-000000000031","quantity":1},{"itemId":"75000000-0000-4000-8000-000000000031","quantity":1}]}'), '合併成一列');
  perform pg_temp.expect_error(format('select public.save_promotion(%L)', v_base || '{"comboPrice":100.555}'), '最多兩位小數');

  perform public.delete_promotion(v_id);
  if exists (select 1 from public.promotions where id = v_id) or exists (select 1 from public.promotion_items where promotion_id = v_id) then
    raise exception 'promotion not deleted';
  end if;
  perform set_config('test.promo', public.save_promotion(v_base)::text, true);
end $$;

-- 店員：可以讀組合（結帳要用），不能新增、修改、刪除，也不能直接寫資料表。
select set_config('request.jwt.claim.sub', '75000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"75000000-0000-4000-8000-000000000002","session_id":"75000000-0000-4000-8000-000000000012"}', true);
do $$
declare v_id uuid := current_setting('test.promo')::uuid;
begin
  if (select count(*) from public.promotion_items where promotion_id = v_id) <> 3 then raise exception 'clerk cannot read promotions'; end if;
  begin perform public.save_promotion('{"name":"x"}'); raise exception 'clerk saved'; exception when insufficient_privilege then null; end;
  begin perform public.delete_promotion(v_id); raise exception 'clerk deleted'; exception when insufficient_privilege then null; end;
  begin update public.promotions set combo_price = 1 where id = v_id; raise exception 'clerk updated table';
  exception when insufficient_privilege then null; end;
end $$;
rollback;
