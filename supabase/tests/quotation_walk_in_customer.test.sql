-- 報價單客戶可直接填寫：選清單客戶或填姓名（電話可空白），填寫的客戶不會新增到客戶管理。整個測試在交易內，結束時 rollback。
begin;
insert into auth.users(id, email) values ('7a000000-0000-4000-8000-000000000002', 'walkin-clerk@example.invalid');
update public.profiles set role = 'clerk', active = true where id = '7a000000-0000-4000-8000-000000000002';
insert into auth.sessions(id, user_id) values ('7a000000-0000-4000-8000-000000000012', '7a000000-0000-4000-8000-000000000002');
insert into public.customers(id, member_number, name, phone, created_by) values
  ('7a000000-0000-4000-8000-000000000021', 'M7A0001', '清單客戶', '0911000000', '7a000000-0000-4000-8000-000000000002');
insert into public.items(id, name, category, sku, price, stock) values ('7a000000-0000-4000-8000-000000000031', '輪胎', '機構元件', 'WI-TIRE', 1450, 0);

select set_config('request.jwt.claim.sub', '7a000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"7a000000-0000-4000-8000-000000000002","session_id":"7a000000-0000-4000-8000-000000000012"}', true);
set local role authenticated;

do $$
declare
  v_line jsonb := '[{"itemId":"7a000000-0000-4000-8000-000000000031","itemName":"輪胎","quantity":2,"unitPrice":1450}]';
  v_customers integer := (select count(*) from public.customers);
  v_q uuid;
  v_denied boolean;
begin
  -- 1) 直接填寫姓名、電話：存在報價單上，不新增客戶。
  v_q := gen_random_uuid();
  perform public.save_quotation(jsonb_build_object('id', v_q, 'number', 'Q-WALK-1', 'customerId', '', 'customerName', '  路過的王先生  ',
    'customerPhone', '0922333444', 'total', 2900), v_line);
  if (select customer_id from public.quotations where id = v_q) is not null
    or (select customer_name from public.quotations where id = v_q) <> '路過的王先生'
    or (select customer_phone from public.quotations where id = v_q) <> '0922333444' then
    raise exception 'walk-in customer not stored on the quotation';
  end if;
  if (select count(*) from public.customers) <> v_customers then raise exception 'walk-in customer added to customers'; end if;

  -- 2) 電話可空白；customerId 欄位不存在也可以。
  v_q := gen_random_uuid();
  perform public.save_quotation(jsonb_build_object('id', v_q, 'number', 'Q-WALK-2', 'customerName', '李小姐', 'total', 2900), v_line);
  if (select customer_phone from public.quotations where id = v_q) <> '' then raise exception 'empty phone should be allowed'; end if;
  if (select plate_number from public.quotations where id = v_q) <> '' then raise exception 'plate number should default to empty'; end if;

  -- 2b) 車號選填：存成大寫、去頭尾空白。
  v_q := gen_random_uuid();
  perform public.save_quotation(jsonb_build_object('id', v_q, 'number', 'Q-PLATE-1', 'customerName', '張先生', 'plateNumber', ' abc-1234 ', 'total', 2900), v_line);
  if (select plate_number from public.quotations where id = v_q) <> 'ABC-1234' then raise exception 'plate number not stored'; end if;

  -- 3) 沒選客戶也沒填姓名：擋下。
  v_denied := false;
  begin
    perform public.save_quotation(jsonb_build_object('id', gen_random_uuid(), 'number', 'Q-WALK-3', 'customerId', '', 'customerName', '   ', 'total', 2900), v_line);
  exception when others then v_denied := sqlerrm like '%請選擇客戶或填寫客戶姓名%'; end;
  if not v_denied then raise exception 'missing customer accepted'; end if;

  -- 4) 選清單客戶：照舊，填寫欄位不存。
  v_q := gen_random_uuid();
  perform public.save_quotation(jsonb_build_object('id', v_q, 'number', 'Q-LIST-1', 'customerId', '7a000000-0000-4000-8000-000000000021',
    'customerName', '清單客戶', 'customerPhone', '0911000000', 'total', 2900), v_line);
  if (select customer_id from public.quotations where id = v_q) <> '7a000000-0000-4000-8000-000000000021'
    or (select customer_name from public.quotations where id = v_q) <> '' then
    raise exception 'listed customer quotation changed';
  end if;
end $$;

reset role;
do $$ begin
  -- 資料表本身也擋：沒有客戶 ID 又沒有姓名的報價寫不進去。
  begin
    insert into public.quotations(id, quote_number, customer_id, customer_name, total, created_by)
      values (gen_random_uuid(), 'Q-RAW', null, '', 0, '7a000000-0000-4000-8000-000000000002');
    raise exception 'constraint missing';
  exception when check_violation then null; end;
end $$;
rollback;
