-- 自動序號：賣出時沒選序號，在庫序號比庫存多，之後入庫仍然可以登錄新序號。整個測試在交易內，結束時 rollback。
begin;
insert into auth.users(id, email) values ('7f100000-0000-4000-8000-000000000001', 'serial-admin@example.invalid');
update public.profiles set role = 'admin', active = true where id = '7f100000-0000-4000-8000-000000000001';
insert into auth.sessions(id, user_id) values ('7f100000-0000-4000-8000-000000000011', '7f100000-0000-4000-8000-000000000001');
select set_config('request.jwt.claim.sub', '7f100000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"7f100000-0000-4000-8000-000000000001","session_id":"7f100000-0000-4000-8000-000000000011"}', true);
set local role authenticated;
do $$
begin
  perform public.create_serialized_item(jsonb_build_object('id', '7f100000-0000-4000-8000-000000000031', 'name', '測試車', 'category', '車身', 'sku', 'AS-1',
    'price', 30000, 'stock', 2, 'minimum_stock', 0, 'vehicle_model_id', (select id from public.vehicle_models where is_universal)), 0,
    '[{"id":"7f100000-0000-4000-8000-000000000071","serialNumber":"01202611120001"},{"id":"7f100000-0000-4000-8000-000000000072","serialNumber":"01202611120002"}]');
  -- 賣出 2 台沒選序號：庫存 0，兩個序號仍在庫。
  update public.items set stock = 0 where id = '7f100000-0000-4000-8000-000000000031';
  -- 再進貨 1 台並登錄 1 個自動序號：在庫序號 3 > 庫存 1，仍可登錄。
  perform public.adjust_inventory('7f100000-0000-4000-8000-000000000031', 'in', 1, '');
  -- 補登（沒帶入庫數量）：在庫 2＋1 > 庫存 1，擋下。
  begin
    perform public.register_inventory_serials('7f100000-0000-4000-8000-000000000031', '[{"id":"7f100000-0000-4000-8000-000000000076","serialNumber":"OLD-1"}]');
    raise exception 'backfill should have failed';
  exception when others then if sqlerrm not like '%超過現有庫存%' then raise; end if;
  end;
  perform public.register_inventory_serials('7f100000-0000-4000-8000-000000000031', '[{"id":"7f100000-0000-4000-8000-000000000073","serialNumber":"01202611120003"}]', 1);
  if (select count(*) from public.inventory_serials where item_id = '7f100000-0000-4000-8000-000000000031' and status = 'in_stock') <> 3 then raise exception 'serial not registered'; end if;
  -- 入庫登錄的件數不能超過這次入庫數量。
  begin
    perform public.register_inventory_serials('7f100000-0000-4000-8000-000000000031', '[{"id":"7f100000-0000-4000-8000-000000000074","serialNumber":"X1"},{"id":"7f100000-0000-4000-8000-000000000075","serialNumber":"X2"}]', 1);
    raise exception 'should have failed';
  exception when others then if sqlerrm not like '%超過入庫數量%' then raise; end if;
  end;
end $$;
rollback;
