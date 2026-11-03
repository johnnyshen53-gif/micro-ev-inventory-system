-- 品項停用：不能入庫、進貨、收貨、銷售、報價；出庫與盤點仍可。整個測試在交易內，結束時 rollback。
begin;
insert into auth.users(id, email) values ('7e000000-0000-4000-8000-000000000001', 'active-admin@example.invalid');
update public.profiles set role = 'admin', active = true where id = '7e000000-0000-4000-8000-000000000001';
insert into auth.sessions(id, user_id) values ('7e000000-0000-4000-8000-000000000011', '7e000000-0000-4000-8000-000000000001');
insert into public.suppliers(id, name, created_by) values ('7e000000-0000-4000-8000-000000000021', '供應商', '7e000000-0000-4000-8000-000000000001');
insert into public.items(id, name, category, sku, price, stock, supplier_id, vehicle_model_id) values
  ('7e000000-0000-4000-8000-000000000031', '舊款後照鏡', '外觀元件', 'IA-MIR', 800, 5, '7e000000-0000-4000-8000-000000000021', (select id from public.vehicle_models where is_universal));
insert into public.salespeople(id, name, active, created_by) values ('7e000000-0000-4000-8000-000000000051', '業務', true, '7e000000-0000-4000-8000-000000000001');

select set_config('request.jwt.claim.sub', '7e000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"7e000000-0000-4000-8000-000000000001","session_id":"7e000000-0000-4000-8000-000000000011"}', true);
set local role authenticated;

create function pg_temp.expect_error(p_sql text, p_message text) returns void language plpgsql as $$
begin
  execute p_sql;
  raise exception 'expected error containing %', p_message;
exception when others then
  if sqlerrm not like '%' || p_message || '%' then raise; end if;
end $$;

do $$
begin
  if not (select active from public.items where id = '7e000000-0000-4000-8000-000000000031') then raise exception 'items should default to active'; end if;
  -- 先建好一張進貨草稿（停用前）。
  perform public.save_purchase(jsonb_build_object('id', '7e000000-0000-4000-8000-000000000061', 'number', 'P20261108001',
    'supplierId', '7e000000-0000-4000-8000-000000000021', 'total', 500), '[{"itemId":"7e000000-0000-4000-8000-000000000031","quantity":1,"unitCost":500}]');
  -- 店長停用品項（一般的品項更新）。
  update public.items set active = false where id = '7e000000-0000-4000-8000-000000000031';
end $$;

select pg_temp.expect_error($$select public.adjust_inventory('7e000000-0000-4000-8000-000000000031', 'in', 1, '')$$, '已停用，無法入庫');
select pg_temp.expect_error($$select public.receive_purchase('7e000000-0000-4000-8000-000000000061', '{}'::jsonb)$$, '已停用，無法收貨入庫');
select pg_temp.expect_error($$select public.save_purchase(jsonb_build_object('id', gen_random_uuid(), 'number', 'P20261108002',
    'supplierId', '7e000000-0000-4000-8000-000000000021', 'total', 500), '[{"itemId":"7e000000-0000-4000-8000-000000000031","quantity":1,"unitCost":500}]')$$, '不能加入進貨單');
select pg_temp.expect_error($$select public.create_sale_with_serials('[{"item_id":"7e000000-0000-4000-8000-000000000031","quantity":1}]', null::uuid,
    '7e000000-0000-4000-8000-000000000051', gen_random_uuid(), '[]'::jsonb, null::text, (now() at time zone 'Asia/Taipei')::date)$$, '已停用，無法銷售');
select pg_temp.expect_error($$select public.save_quotation(jsonb_build_object('id', gen_random_uuid(), 'number', 'Q-IA-1', 'customerName', '王', 'total', 800),
    '[{"itemId":"7e000000-0000-4000-8000-000000000031","itemName":"舊款後照鏡","quantity":1,"unitPrice":800}]')$$, '已停用，無法報價');

do $$
begin
  -- 出庫、盤點仍可（清掉剩下的庫存）。
  perform public.adjust_inventory('7e000000-0000-4000-8000-000000000031', 'out', 2, '報廢');
  perform public.adjust_inventory('7e000000-0000-4000-8000-000000000031', 'set', 0, '盤點');
  if (select stock from public.items where id = '7e000000-0000-4000-8000-000000000031') <> 0 then raise exception 'out/set should still work'; end if;
  -- 重新啟用後可以入庫。
  update public.items set active = true where id = '7e000000-0000-4000-8000-000000000031';
  perform public.adjust_inventory('7e000000-0000-4000-8000-000000000031', 'in', 3, '');
  if (select stock from public.items where id = '7e000000-0000-4000-8000-000000000031') <> 3 then raise exception 'reactivated stock-in failed'; end if;
end $$;
rollback;
