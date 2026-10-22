-- 官網車款：店長設定官網顯示、訪客只讀得到勾選顯示的車身／電池、照片空間只有店長能寫。整個測試在交易內，結束時 rollback。
begin;
insert into auth.users(id, email) values
  ('77000000-0000-4000-8000-000000000001', 'web-admin@example.invalid'),
  ('77000000-0000-4000-8000-000000000002', 'web-clerk@example.invalid');
update public.profiles set role = 'admin', active = true where id = '77000000-0000-4000-8000-000000000001';
update public.profiles set role = 'clerk', active = true where id = '77000000-0000-4000-8000-000000000002';
insert into auth.sessions(id, user_id) values
  ('77000000-0000-4000-8000-000000000011', '77000000-0000-4000-8000-000000000001'),
  ('77000000-0000-4000-8000-000000000012', '77000000-0000-4000-8000-000000000002');
insert into public.items(id, name, category, sku, price, stock) values
  ('77000000-0000-4000-8000-000000000031', '小粉微電車', '車身', 'WEB-CAR', 39800, 0),
  ('77000000-0000-4000-8000-000000000032', '48V 24Ah 鋰電池', '電池', 'WEB-BAT', 12000, 3),
  ('77000000-0000-4000-8000-000000000033', '煞車拉桿', '機構元件', 'WEB-LEV', 350, 9),
  ('77000000-0000-4000-8000-000000000034', '隱藏的車', '車身', 'WEB-HID', 30000, 1);
insert into public.item_costs(item_id, cost) values ('77000000-0000-4000-8000-000000000031', 28000);

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

-- 店長
select set_config('request.jwt.claim.sub', '77000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"77000000-0000-4000-8000-000000000001","session_id":"77000000-0000-4000-8000-000000000011"}', true);
set local role authenticated;
do $$
begin
  perform public.save_item_web('{"itemId":"77000000-0000-4000-8000-000000000031","visible":true,"rangeKm":"45","topSpeed":"25",
    "batterySpec":"48V 24Ah 鋰電池","summary":"  通勤買菜都好騎  ","photoPath":"77000000-0000-4000-8000-000000000031/1730000000000.webp"}');
  perform public.save_item_web('{"itemId":"77000000-0000-4000-8000-000000000032","visible":true,"rangeKm":"","topSpeed":null}');
  perform public.save_item_web('{"itemId":"77000000-0000-4000-8000-000000000034","visible":false,"summary":"還沒要上"}');
  -- 再存一次＝整筆取代（照片拿掉）
  perform public.save_item_web('{"itemId":"77000000-0000-4000-8000-000000000032","visible":true,"batterySpec":"48V 24Ah","summary":"適用多數車款"}');
  if (select count(*) from public.item_web) <> 3 then raise exception 'rows not saved'; end if;
  if (select summary from public.item_web where item_id = '77000000-0000-4000-8000-000000000031') <> '通勤買菜都好騎' then raise exception 'summary not trimmed'; end if;
  if (select range_km from public.item_web where item_id = '77000000-0000-4000-8000-000000000032') is not null then raise exception 'blank should be null'; end if;
  if (select count(*) from public.audit_logs where action = 'item_web.saved') <> 4 then raise exception 'audit missing'; end if;
end $$;
select pg_temp.expect_error($q$select public.save_item_web('{"itemId":"77000000-0000-4000-8000-000000000033","visible":true}')$q$, '只有車身、電池');
select pg_temp.expect_error($q$select public.save_item_web('{"itemId":"77000000-0000-4000-8000-000000000031","topSpeed":"120"}')$q$, '最高時速');
select pg_temp.expect_error($q$select public.save_item_web('{"itemId":"77000000-0000-4000-8000-000000000031","rangeKm":"0"}')$q$, '續航');
select pg_temp.expect_error($q$select public.save_item_web(jsonb_build_object('itemId','77000000-0000-4000-8000-000000000031','summary',repeat('字',301)))$q$, '簡介');
select pg_temp.expect_error($q$select public.save_item_web('{"itemId":"77000000-0000-4000-8000-000000000031","photoPath":"77000000-0000-4000-8000-000000000032/a.webp"}')$q$, '照片路徑');
select pg_temp.expect_error($q$select public.save_item_web('{"itemId":"77000000-0000-4000-8000-000000000031","photoPath":"../../etc/x"}')$q$, '照片路徑');
select pg_temp.expect_error($q$select public.save_item_web('{"itemId":"77000000-0000-4000-8000-000000000099"}')$q$, '品項不存在');
-- 店長能管理照片
insert into storage.objects(bucket_id, name) values ('website-photos', '77000000-0000-4000-8000-000000000031/1730000000000.webp');
delete from storage.objects where bucket_id = 'website-photos' and name like '77000000%';
reset role;

-- 店員：不能設定、看不到設定表、不能上傳照片
select set_config('request.jwt.claim.sub', '77000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"77000000-0000-4000-8000-000000000002","session_id":"77000000-0000-4000-8000-000000000012"}', true);
set local role authenticated;
select pg_temp.expect_error($q$select public.save_item_web('{"itemId":"77000000-0000-4000-8000-000000000031","visible":false}')$q$, '只有店長');
do $$ begin
  if (select count(*) from public.item_web) <> 0 then raise exception 'clerk should not read item_web'; end if;
end $$;
select pg_temp.expect_error($q$insert into storage.objects(bucket_id, name) values ('website-photos', '77000000-0000-4000-8000-000000000031/x.webp')$q$, 'row-level security');
reset role;

-- 訪客（官網）
set local role anon;
do $$
declare r record; v_names text;
begin
  select string_agg(name, ',' order by name) into v_names from public.get_public_items() where name in ('小粉微電車','48V 24Ah 鋰電池','煞車拉桿','隱藏的車');
  if v_names <> '48V 24Ah 鋰電池,小粉微電車' then raise exception 'wrong public items: %', v_names; end if;
  select * into r from public.get_public_items() where name = '小粉微電車';
  if r.category <> '車身' or r.range_km <> 45 or r.top_speed <> 25 or r.photo_path <> '77000000-0000-4000-8000-000000000031/1730000000000.webp' then
    raise exception 'wrong car row %', row_to_json(r);
  end if;
  -- 車身排在電池前面
  if (select category from public.get_public_items() limit 1) <> '車身' then raise exception 'cars should come first'; end if;
end $$;
create function pg_temp.expect_denied(p_sql text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when insufficient_privilege then return;
  end;
  raise exception 'statement unexpectedly succeeded: %', p_sql;
end $$;
select pg_temp.expect_denied('select * from public.item_web');
select pg_temp.expect_denied('select * from public.items');
select pg_temp.expect_denied($q$select public.save_item_web('{}')$q$);
reset role;

-- 回傳欄位固定：沒有價格、成本、庫存、料號、id
do $$
begin
  if (select string_agg(parameter_name, ',' order by ordinal_position) from information_schema.parameters
      where specific_schema = 'public' and specific_name like 'get_public_items%' and parameter_mode = 'OUT')
     <> 'name,category,range_km,top_speed,battery_spec,summary,photo_path' then
    raise exception 'unexpected output columns';
  end if;
  if not (select public from storage.buckets where id = 'website-photos') then raise exception 'bucket should be public'; end if;
end $$;

-- 刪除品項時，官網設定一併刪除
delete from public.items where id = '77000000-0000-4000-8000-000000000034';
do $$ begin
  if exists (select 1 from public.item_web where item_id = '77000000-0000-4000-8000-000000000034') then raise exception 'cascade failed'; end if;
end $$;
rollback;
