-- 售價加成：收貨時依分類加成重算售價、固定售價不動、未設定分類不動、權限。整個測試在交易內，結束時 rollback。
begin;
insert into auth.users(id, email) values
  ('74000000-0000-4000-8000-000000000001', 'markup-admin@example.invalid'),
  ('74000000-0000-4000-8000-000000000002', 'markup-clerk@example.invalid');
update public.profiles set role = 'admin', active = true where id = '74000000-0000-4000-8000-000000000001';
update public.profiles set role = 'clerk', active = true where id = '74000000-0000-4000-8000-000000000002';
insert into auth.sessions(id, user_id) values
  ('74000000-0000-4000-8000-000000000011', '74000000-0000-4000-8000-000000000001'),
  ('74000000-0000-4000-8000-000000000012', '74000000-0000-4000-8000-000000000002');
insert into public.suppliers(id, name, created_by) values
  ('74000000-0000-4000-8000-000000000021', '加成供應商', '74000000-0000-4000-8000-000000000001');
insert into public.items(id, name, category, sku, price, stock, supplier_id, price_locked) values
  ('74000000-0000-4000-8000-000000000031', '控制器', '電控元件', 'MK-A', 100, 0, '74000000-0000-4000-8000-000000000021', false),
  ('74000000-0000-4000-8000-000000000032', '特價控制器', '電控元件', 'MK-B', 999, 0, '74000000-0000-4000-8000-000000000021', true),
  ('74000000-0000-4000-8000-000000000033', '避震器', '機構元件', 'MK-C', 50, 0, '74000000-0000-4000-8000-000000000021', false);

select set_config('request.jwt.claim.sub', '74000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"74000000-0000-4000-8000-000000000001","session_id":"74000000-0000-4000-8000-000000000011"}', true);
set local role authenticated;

do $$
declare v_purchase uuid := '74000000-0000-4000-8000-000000000041';
begin
  -- 不合法的分類或數值會被拒絕。
  begin perform public.save_price_markups('{"零件": 10}'); raise exception 'unknown category accepted';
  exception when raise_exception then if sqlerrm not like '未知的分類%' then raise; end if; end;
  begin perform public.save_price_markups('{"電池": -1}'); raise exception 'negative markup accepted';
  exception when raise_exception then if sqlerrm not like '%加成須介於%' then raise; end if; end;

  perform public.save_price_markups('{"電控元件": 35, "車身": 15.5, "電池": null}');
  if public.get_price_markups() <> '{"電控元件": 35.00, "車身": 15.50}'::jsonb then
    raise exception 'unexpected markups %', public.get_price_markups();
  end if;
  -- 873 × 1.35 ＝ 1178.55 → 無條件進位到 10 元 ＝ 1180；剛好整十時不再進位。
  if app_private.markup_price_for('電控元件', 873) <> 1180 then raise exception 'rounding wrong'; end if;
  if app_private.markup_price_for('電控元件', 100) <> 140 then raise exception '135 should round up to 140'; end if;
  if app_private.markup_price_for('車身', 1000) <> 1160 then raise exception '1155 should round up to 1160'; end if;
  if app_private.markup_price_for('機構元件', 100) is not null then raise exception 'unset category should be null'; end if;

  perform public.save_purchase(jsonb_build_object('id', v_purchase, 'number', 'P20261024001',
    'supplierId', '74000000-0000-4000-8000-000000000021', 'total', 1846),
    '[{"itemId":"74000000-0000-4000-8000-000000000031","quantity":1,"unitCost":873},
      {"itemId":"74000000-0000-4000-8000-000000000032","quantity":1,"unitCost":873},
      {"itemId":"74000000-0000-4000-8000-000000000033","quantity":1,"unitCost":100}]');
  perform public.receive_purchase(v_purchase, '{}'::jsonb);

  if (select price from public.items where id = '74000000-0000-4000-8000-000000000031') <> 1180 then
    raise exception 'markup price not applied';
  end if;
  if (select price from public.items where id = '74000000-0000-4000-8000-000000000032') <> 999 then
    raise exception 'locked price was overwritten';
  end if;
  if (select price from public.items where id = '74000000-0000-4000-8000-000000000033') <> 50 then
    raise exception 'category without markup was changed';
  end if;
end $$;

-- 店員看不到也改不了加成；直接呼叫計算函式只會得到 null。
select set_config('request.jwt.claim.sub', '74000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"74000000-0000-4000-8000-000000000002","session_id":"74000000-0000-4000-8000-000000000012"}', true);
do $$
begin
  begin perform public.get_price_markups(); raise exception 'clerk read markups';
  exception when insufficient_privilege then null; end;
  begin perform public.save_price_markups('{"電控元件": 1}'); raise exception 'clerk saved markups';
  exception when insufficient_privilege then null; end;
  if app_private.markup_price_for('電控元件', 100) is not null then raise exception 'clerk got a markup price'; end if;
  begin perform 1 from app_private.price_markups; raise exception 'clerk read markup table';
  exception when insufficient_privilege then null; end;
end $$;
rollback;
