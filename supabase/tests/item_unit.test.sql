-- 品項單位：預設空字串、最多 10 個字；連同序號建立車身時也會存入。整個測試在交易內，結束時 rollback。
begin;
insert into auth.users(id, email) values ('7d000000-0000-4000-8000-000000000001', 'unit-admin@example.invalid');
update public.profiles set role = 'admin', active = true where id = '7d000000-0000-4000-8000-000000000001';
insert into auth.sessions(id, user_id) values ('7d000000-0000-4000-8000-000000000011', '7d000000-0000-4000-8000-000000000001');
select set_config('request.jwt.claim.sub', '7d000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"7d000000-0000-4000-8000-000000000001","session_id":"7d000000-0000-4000-8000-000000000011"}', true);
set local role authenticated;
do $$
begin
  insert into public.items(id, name, category, sku, price, stock, vehicle_model_id) values ('7d000000-0000-4000-8000-000000000031', '座墊', '外觀元件', 'UN-A', 950, 0, (select id from public.vehicle_models where is_universal));
  if (select unit from public.items where id = '7d000000-0000-4000-8000-000000000031') <> '' then raise exception 'unit should default to empty'; end if;
  update public.items set unit = '組' where id = '7d000000-0000-4000-8000-000000000031';
  begin
    update public.items set unit = '一二三四五六七八九十一' where id = '7d000000-0000-4000-8000-000000000031';
    raise exception 'long unit should fail';
  exception when check_violation then null;
  end;
  perform public.create_serialized_item(jsonb_build_object('id', '7d000000-0000-4000-8000-000000000033', 'name', '測試車', 'category', '車身', 'sku', 'UN-B',
    'price', 30000, 'stock', 1, 'minimum_stock', 0, 'unit', '台', 'vehicle_model_id', (select id from public.vehicle_models where is_universal)), 0, '[{"id":"7d000000-0000-4000-8000-000000000071","serialNumber":"UN-SN-1"}]');
  if (select unit from public.items where id = '7d000000-0000-4000-8000-000000000033') <> '台' then raise exception 'serialized item unit not stored'; end if;
end $$;
rollback;
