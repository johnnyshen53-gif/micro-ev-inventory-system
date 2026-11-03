-- 銷售日期：結帳可選今天或以前；月報表、業務員績效、保固起算都依銷售日期。整個測試在交易內，結束時 rollback。
begin;
insert into auth.users(id, email) values ('79000000-0000-4000-8000-000000000001', 'sale-date-admin@example.invalid');
update public.profiles set role = 'admin', active = true where id = '79000000-0000-4000-8000-000000000001';
insert into auth.sessions(id, user_id) values ('79000000-0000-4000-8000-000000000011', '79000000-0000-4000-8000-000000000001');
insert into public.items(id, name, category, sku, price, stock, warranty_months, vehicle_model_id) values
  ('79000000-0000-4000-8000-000000000031', '安全帽', '外觀元件', 'SD-HELM', 500, 10, 6, (select id from public.vehicle_models where is_universal));
insert into public.customers(id, member_number, name, phone) values ('79000000-0000-4000-8000-000000000051', 'SD-0001', '日期客戶', '0900000000');
insert into public.salespeople(id, name, active, created_by) values
  ('79000000-0000-4000-8000-000000000041', '日期業務', true, '79000000-0000-4000-8000-000000000001');

select set_config('request.jwt.claim.sub', '79000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"79000000-0000-4000-8000-000000000001","session_id":"79000000-0000-4000-8000-000000000011"}', true);
set local role authenticated;

do $$
declare
  v_today date := (now() at time zone 'Asia/Taipei')::date;
  v_back date := ((now() at time zone 'Asia/Taipei')::date - interval '2 months')::date;
  v_lines jsonb := jsonb_build_array(jsonb_build_object('item_id', '79000000-0000-4000-8000-000000000031', 'quantity', 1));
  v_sale uuid;
  v_checkout uuid := gen_random_uuid();
  v_denied boolean;
begin
  -- 未來日期、空白日期都會被擋，庫存不變。
  v_denied := false;
  begin perform public.create_sale_with_serials(v_lines, null::uuid, '79000000-0000-4000-8000-000000000041', gen_random_uuid(), '[]'::jsonb, null::text, v_today + 1);
  exception when others then v_denied := sqlerrm like '%不可晚於今天%'; end;
  if not v_denied then raise exception 'future sale date accepted'; end if;
  v_denied := false;
  begin perform public.create_sale_with_serials(v_lines, null::uuid, '79000000-0000-4000-8000-000000000041', gen_random_uuid(), '[]'::jsonb, null::text, null::date);
  exception when others then v_denied := sqlerrm like '%請填寫銷售日期%'; end;
  if not v_denied then raise exception 'empty sale date accepted'; end if;
  if (select stock from public.items where id = '79000000-0000-4000-8000-000000000031') <> 10 then raise exception 'rejected sale changed stock'; end if;

  -- 補登兩個月前的銷售（有客戶 → 建立保固，保固從銷售日期起算）。
  v_sale := public.create_sale_with_serials(v_lines, '79000000-0000-4000-8000-000000000051', '79000000-0000-4000-8000-000000000041', v_checkout, '[]'::jsonb, null::text, v_back);
  if (select sale_date from public.sales where id = v_sale) <> v_back then raise exception 'sale_date not stored'; end if;
  -- 保固系統停用（20261106010000）：結帳不再建立保固。
  if exists (select 1 from public.warranties where sale_id = v_sale) then raise exception 'sale should not create a warranty'; end if;
  -- 同一個結帳識別碼重送：回傳同一張單，不重複扣庫存，日期不被改。
  if public.create_sale_with_serials(v_lines, '79000000-0000-4000-8000-000000000051', '79000000-0000-4000-8000-000000000041', v_checkout, '[]'::jsonb, null::text, v_today) <> v_sale
    or (select sale_date from public.sales where id = v_sale) <> v_back
    or (select stock from public.items where id = '79000000-0000-4000-8000-000000000031') <> 9 then
    raise exception 'retry changed the sale';
  end if;

  -- 月報表：補登的單歸在兩個月前，不在本月。
  if not exists (select 1 from public.get_monthly_sale_assignments(to_char(v_back, 'YYYY-MM')) where sale_number = (select sale_number from public.sales where id = v_sale))
    or exists (select 1 from public.get_monthly_sale_assignments(to_char(v_today, 'YYYY-MM')) where sale_number = (select sale_number from public.sales where id = v_sale)) then
    raise exception 'assignment month not based on sale date';
  end if;
  if (select total from public.get_monthly_salesperson_performance(to_char(v_back, 'YYYY-MM')) where salesperson_name = '日期業務') <> 500
    or exists (select 1 from public.get_monthly_salesperson_performance(to_char(v_today, 'YYYY-MM')) where salesperson_name = '日期業務') then
    raise exception 'performance month not based on sale date';
  end if;

  -- 舊的 6 參數版本仍可用；沒有 sale_date 的單以建立日期歸月。
  v_sale := public.create_sale_with_serials(v_lines, null::uuid, '79000000-0000-4000-8000-000000000041', gen_random_uuid(), '[]'::jsonb, null::text);
  if (select sale_date from public.sales where id = v_sale) is not null then raise exception 'old rpc should leave sale_date empty'; end if;
  if (select total from public.get_monthly_salesperson_performance(to_char(v_today, 'YYYY-MM')) where salesperson_name = '日期業務') <> 500 then
    raise exception 'legacy sale not counted in creation month';
  end if;
end;
$$;

reset role;
do $$ begin
  if has_function_privilege('anon', 'public.create_sale_with_serials(jsonb, uuid, uuid, uuid, jsonb, text, date)', 'EXECUTE') then
    raise exception 'anon can call dated checkout';
  end if;
end $$;
rollback;
