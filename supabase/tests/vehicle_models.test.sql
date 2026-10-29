-- 車種：店長維護車種清單、「通用」受保護、網站新增品項必須選啟用中的車種、舊品項照常運作。整個測試在交易內，結束時 rollback。
begin;
insert into auth.users(id, email) values
  ('78000000-0000-4000-8000-000000000001', 'vm-admin@example.invalid'),
  ('78000000-0000-4000-8000-000000000002', 'vm-clerk@example.invalid');
update public.profiles set role = 'admin', active = true where id = '78000000-0000-4000-8000-000000000001';
update public.profiles set role = 'clerk', active = true where id = '78000000-0000-4000-8000-000000000002';
insert into auth.sessions(id, user_id) values
  ('78000000-0000-4000-8000-000000000011', '78000000-0000-4000-8000-000000000001'),
  ('78000000-0000-4000-8000-000000000012', '78000000-0000-4000-8000-000000000002');
-- 上線前就存在、還沒有車種的舊品項（資料庫管理者建立，不受新增必填限制）。
insert into public.items(id, name, category, sku, price, stock) values
  ('78000000-0000-4000-8000-000000000031', '舊煞車皮', '機構元件', 'VM-OLD', 200, 5);

-- 預期 p_sql 失敗且訊息含 p_message。「沒有失敗」的檢查放在例外區塊外面，才不會被自己的例外處理吞掉。
create function pg_temp.expect_error(p_sql text, p_message text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm not like '%' || p_message || '%' then raise; end if;
    return;
  end;
  raise exception 'statement unexpectedly succeeded: %', p_sql;
end $$;
grant execute on function pg_temp.expect_error(text, text) to authenticated;

do $$
begin
  if (select count(*) from public.vehicle_models where is_universal) <> 1
    or (select name from public.vehicle_models where is_universal) <> '通用' then
    raise exception 'universal model missing';
  end if;
end $$;

-- 店長
select set_config('request.jwt.claim.sub', '78000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"78000000-0000-4000-8000-000000000001","session_id":"78000000-0000-4000-8000-000000000011"}', true);
set local role authenticated;
insert into public.vehicle_models(id, name) values
  ('78000000-0000-4000-8000-0000000000a1', '小偉士'),
  ('78000000-0000-4000-8000-0000000000a2', 'Vespa');
select pg_temp.expect_error($q$insert into public.vehicle_models(name) values ('vespa')$q$, 'vehicle_models_name_key');
select pg_temp.expect_error($q$insert into public.vehicle_models(name) values (' 小粉 ')$q$, 'vehicle_models_name_check');
select pg_temp.expect_error($q$insert into public.vehicle_models(name) values ('')$q$, 'vehicle_models_name_check');
select pg_temp.expect_error($q$insert into public.vehicle_models(name, is_universal) values ('全車系', true)$q$, '「通用」車種已存在');
select pg_temp.expect_error($q$update public.vehicle_models set name = '全部' where is_universal$q$, '「通用」車種不能改名或停用');
select pg_temp.expect_error($q$update public.vehicle_models set active = false where is_universal$q$, '「通用」車種不能改名或停用');
select pg_temp.expect_error($q$update public.vehicle_models set is_universal = true where id = '78000000-0000-4000-8000-0000000000a2'$q$, '不能把其他車種改成「通用」');
select pg_temp.expect_error($q$delete from public.vehicle_models where id = '78000000-0000-4000-8000-0000000000a2'$q$, 'permission denied');
update public.vehicle_models set name = '小偉士 S' where id = '78000000-0000-4000-8000-0000000000a1';

-- 新增品項：一定要選啟用中的車種
select pg_temp.expect_error($q$insert into public.items(id, name, price, stock) values ('78000000-0000-4000-8000-000000000041', '沒車種', 1, 0)$q$, '請選擇車種');
insert into public.items(id, name, price, stock, vehicle_model_id) values
  ('78000000-0000-4000-8000-000000000042', '小偉士後照鏡', 300, 2, '78000000-0000-4000-8000-0000000000a1'),
  ('78000000-0000-4000-8000-000000000043', '通用手套', 150, 4, (select id from public.vehicle_models where is_universal));
update public.vehicle_models set active = false where id = '78000000-0000-4000-8000-0000000000a2';
select pg_temp.expect_error($q$insert into public.items(id, name, price, stock, vehicle_model_id) values ('78000000-0000-4000-8000-000000000044', '停用車種', 1, 0, '78000000-0000-4000-8000-0000000000a2')$q$, '車種已停用');
select pg_temp.expect_error($q$insert into public.items(id, name, price, stock, vehicle_model_id) values ('78000000-0000-4000-8000-000000000045', '不存在車種', 1, 0, '78000000-0000-4000-8000-0000000000ff')$q$, '車種已停用或不存在');
-- 車身／電池（含序號）也要車種
select pg_temp.expect_error($q$select public.create_serialized_item(jsonb_build_object('id','78000000-0000-4000-8000-000000000046','name','序號電池','category','電池',
  'price',100,'stock',1,'minimum_stock',0), 50, jsonb_build_array(jsonb_build_object('id','78000000-0000-4000-8000-000000000056','serialNumber','VM-SN-1')))$q$, '請選擇車種');
select public.create_serialized_item(jsonb_build_object('id','78000000-0000-4000-8000-000000000047','name','序號電池','category','電池',
  'price',100,'stock',1,'minimum_stock',0,'vehicle_model_id','78000000-0000-4000-8000-0000000000a1'), 50,
  jsonb_build_array(jsonb_build_object('id','78000000-0000-4000-8000-000000000057','serialNumber','VM-SN-2')));

do $$
begin
  if (select vehicle_model_id from public.items where id = '78000000-0000-4000-8000-000000000047') <> '78000000-0000-4000-8000-0000000000a1' then
    raise exception 'serialized item model not saved';
  end if;
end $$;

-- 車種停用後：已使用的品項照常改庫存、改名；不能改成停用車種，也不能清空車種。
update public.vehicle_models set active = false where id = '78000000-0000-4000-8000-0000000000a1';
update public.items set stock = stock - 1, name = '小偉士後照鏡（左）' where id = '78000000-0000-4000-8000-000000000042';
select pg_temp.expect_error($q$update public.items set vehicle_model_id = null where id = '78000000-0000-4000-8000-000000000042'$q$, '車種不可清空');
select pg_temp.expect_error($q$update public.items set vehicle_model_id = '78000000-0000-4000-8000-0000000000a2' where id = '78000000-0000-4000-8000-000000000043'$q$, '車種已停用');
-- 舊品項（沒有車種）照常異動，之後可補上車種
update public.items set stock = stock + 1 where id = '78000000-0000-4000-8000-000000000031';
update public.items set vehicle_model_id = (select id from public.vehicle_models where is_universal) where id = '78000000-0000-4000-8000-000000000031';
update public.vehicle_models set active = true where id = '78000000-0000-4000-8000-0000000000a1';
reset role;

do $$
begin
  if (select stock from public.items where id = '78000000-0000-4000-8000-000000000042') <> 1 then raise exception 'stock update failed'; end if;
  if (select vehicle_model_id from public.items where id = '78000000-0000-4000-8000-000000000031') is null then raise exception 'legacy model not set'; end if;
  if (select name from public.vehicle_models where id = '78000000-0000-4000-8000-0000000000a1') <> '小偉士 S' then raise exception 'rename failed'; end if;
  if (select created_by from public.vehicle_models where id = '78000000-0000-4000-8000-0000000000a1') <> '78000000-0000-4000-8000-000000000001' then raise exception 'created_by not kept'; end if;
end $$;

-- 店員：可以讀車種，不能新增或修改
select set_config('request.jwt.claim.sub', '78000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"78000000-0000-4000-8000-000000000002","session_id":"78000000-0000-4000-8000-000000000012"}', true);
set local role authenticated;
select pg_temp.expect_error($q$insert into public.vehicle_models(name) values ('店員加的')$q$, 'row-level security');
update public.vehicle_models set name = '店員改的' where id = '78000000-0000-4000-8000-0000000000a1';
do $$
begin
  if (select count(*) from public.vehicle_models) <> 3 then raise exception 'clerk cannot read models'; end if;
end $$;
reset role;
do $$
begin
  if (select name from public.vehicle_models where id = '78000000-0000-4000-8000-0000000000a1') <> '小偉士 S' then raise exception 'clerk changed model'; end if;
  if has_table_privilege('anon', 'public.vehicle_models', 'SELECT') then raise exception 'anon can read models'; end if;
end $$;

rollback;
