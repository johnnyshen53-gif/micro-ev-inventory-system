begin;
insert into auth.users(id, email) values
  ('70000000-0000-4000-8000-000000000001', 'repair-admin@example.invalid'),
  ('70000000-0000-4000-8000-000000000002', 'repair-clerk@example.invalid');
update public.profiles set role = 'admin', active = true where id = '70000000-0000-4000-8000-000000000001';
update public.profiles set active = true where id = '70000000-0000-4000-8000-000000000002';
insert into auth.sessions(id, user_id) values
  ('70000000-0000-4000-8000-000000000011', '70000000-0000-4000-8000-000000000001'),
  ('70000000-0000-4000-8000-000000000012', '70000000-0000-4000-8000-000000000002');
insert into public.customers(id, member_number, name, phone, created_by) values
  ('70000000-0000-4000-8000-000000000021', 'M700001', '會員甲', '0900000001', '70000000-0000-4000-8000-000000000001');
do $$ begin
  if (select plate_numbers from public.customers where member_number='M700001') <> '{}'::text[] then
    raise exception 'legacy customer plate list does not default to empty'; end if;
  update public.customers set plate_numbers=array['ABC-1234','DEF-5678'] where member_number='M700001';
  if (select plate_numbers from public.customers where member_number='M700001') <> array['ABC-1234','DEF-5678'] then
    raise exception 'customer plate list did not persist'; end if;
end $$;
insert into public.items(id, name, category, sku, price, stock, created_by) values
  ('70000000-0000-4000-8000-000000000031', '煞車片', '零件', 'PART-1', 120, 5, '70000000-0000-4000-8000-000000000001');
insert into public.items(id, name, category, sku, price, stock, warranty_months, created_by) values
  ('70000000-0000-4000-8000-000000000032', '電池甲', '電池', 'BAT-1', 2000, 2, 12, '70000000-0000-4000-8000-000000000001'),
  ('70000000-0000-4000-8000-000000000033', '無保固電池', '電池', 'BAT-0', 1800, 1, 0, '70000000-0000-4000-8000-000000000001');
insert into public.inventory_serials(id,item_id,serial_number,status,created_by) values
  ('70000000-0000-4000-8000-000000000041','70000000-0000-4000-8000-000000000032','BAT-001','in_stock','70000000-0000-4000-8000-000000000001'),
  ('70000000-0000-4000-8000-000000000042','70000000-0000-4000-8000-000000000032','BAT-002','in_stock','70000000-0000-4000-8000-000000000001'),
  ('70000000-0000-4000-8000-000000000043','70000000-0000-4000-8000-000000000033','BAT-003','in_stock','70000000-0000-4000-8000-000000000001');
-- 維修單必須指定業務員（20261018010000_repair_salesperson）。
insert into public.salespeople(id, name, active, created_by) values
  ('70000000-0000-4000-8000-000000000051', '維修業務', true, '70000000-0000-4000-8000-000000000001');
select set_config('request.jwt.claim.sub', '70000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"70000000-0000-4000-8000-000000000002","session_id":"70000000-0000-4000-8000-000000000012"}', true);
set local role authenticated;

do $$
declare
  v_guest uuid;
  v_member uuid;
  v_version timestamptz;
  v_denied boolean;
begin
  v_guest := public.save_repair_order(
    '{"salespersonId":"70000000-0000-4000-8000-000000000051","customerName":"臨時客","customerPhone":"0911000000","plateNumber":"ABC-123","vehicleName":"車型 A","issue":"煞車異音","laborAmount":80,"status":"intake","total":1}'::jsonb,
    jsonb_build_array(jsonb_build_object('itemId','70000000-0000-4000-8000-000000000031','quantity',2,'unitPrice',120)));
  if (select status <> 'intake' or total <> 320 or customer_id is not null or repair_number !~ '^R-[0-9]{8}-[0-9]{4,}$' from public.repair_orders where id = v_guest) then
    raise exception 'guest order or server total wrong';
  end if;
  if (select count(*) from public.repair_lines where repair_order_id = v_guest) <> 1 then raise exception 'repair line missing'; end if;
  if (select stock from public.items where id = '70000000-0000-4000-8000-000000000031') <> 5 then raise exception 'draft changed stock'; end if;

  v_member := public.save_repair_order(
    '{"salespersonId":"70000000-0000-4000-8000-000000000051","customerId":"70000000-0000-4000-8000-000000000021","originalSerialNumber":"SERIAL-1","vehicleName":"車型 B","issue":"無法啟動","laborAmount":0,"status":"intake"}'::jsonb,
    '[]'::jsonb);
  if (select customer_name <> '會員甲' or customer_phone <> '0900000001' from public.repair_orders where id = v_member) then raise exception 'member snapshot wrong'; end if;
  if (select repair_number from public.repair_orders where id = v_member) = (select repair_number from public.repair_orders where id = v_guest) then raise exception 'duplicate repair number'; end if;

  v_denied := false;
  begin
    perform public.save_repair_order('{"salespersonId":"70000000-0000-4000-8000-000000000051","customerName":"無車","customerPhone":"0911000000","vehicleName":"車型","issue":"故障","status":"intake"}'::jsonb, '[]'::jsonb);
  exception when others then v_denied := true; end;
  if not v_denied then raise exception 'missing plate and serial accepted'; end if;

  v_denied := false;
  begin
    perform public.save_repair_order('{"salespersonId":"70000000-0000-4000-8000-000000000051","customerName":"負工資","customerPhone":"0911000000","plateNumber":"ABC","vehicleName":"車型","issue":"故障","laborAmount":-1,"status":"intake"}'::jsonb, '[]'::jsonb);
  exception when others then v_denied := true; end;
  if not v_denied then raise exception 'negative labor accepted'; end if;

  v_denied := false;
  begin
    perform public.save_repair_order('{"salespersonId":"70000000-0000-4000-8000-000000000051","customerName":"錯價","customerPhone":"0911000000","plateNumber":"ABC","vehicleName":"車型","issue":"故障","status":"intake"}'::jsonb,
      jsonb_build_array(jsonb_build_object('itemId','70000000-0000-4000-8000-000000000031','quantity',0,'unitPrice',120)));
  exception when others then v_denied := true; end;
  if not v_denied then raise exception 'zero quantity accepted'; end if;

  v_denied := false;
  begin
    perform public.save_repair_order('{"salespersonId":"70000000-0000-4000-8000-000000000051","customerName":"錯價","customerPhone":"0911000000","plateNumber":"ABC","vehicleName":"車型","issue":"故障"}'::jsonb,
      jsonb_build_array(jsonb_build_object('itemId','70000000-0000-4000-8000-000000000031','quantity',1,'unitPrice',-1)));
  exception when others then v_denied := true; end;
  if not v_denied then raise exception 'negative line price accepted'; end if;

  v_denied := false;
  begin
    perform public.mark_repair_paid(v_guest);
  exception when others then v_denied := true; end;
  if not v_denied then raise exception 'uncompleted order paid'; end if;

  select updated_at into v_version from public.repair_orders where id = v_guest;
  perform public.save_repair_order(
    jsonb_build_object('salespersonId','70000000-0000-4000-8000-000000000051','id',v_guest,'customerName','臨時客','customerPhone','0911000000','plateNumber','ABC-123','vehicleName','車型 A','issue','煞車異音','diagnosis','更換煞車片','laborAmount',80,'status','quoted'),
    jsonb_build_array(jsonb_build_object('itemId','70000000-0000-4000-8000-000000000031','quantity',2,'unitPrice',120)), v_version);
  if (select status <> 'quoted' or quoted_by <> auth.uid() or quoted_at is null from public.repair_orders where id = v_guest) then raise exception 'quotation transition wrong'; end if;
  v_denied := false;
  begin
    perform public.save_repair_order(jsonb_build_object('salespersonId','70000000-0000-4000-8000-000000000051','id',v_guest,'customerName','臨時客','customerPhone','0911000000','plateNumber','ABC-123','vehicleName','車型 A','issue','舊資料','status','quoted'), '[]'::jsonb, v_version);
  exception when others then v_denied := true; end;
  if not v_denied then raise exception 'stale edit accepted'; end if;

  perform public.cancel_repair_order(v_guest);
  if (select status <> 'cancelled' or cancelled_by <> auth.uid() or cancelled_at is null from public.repair_orders where id = v_guest) then raise exception 'cancel transition wrong'; end if;
  v_denied := false;
  begin perform public.save_repair_order(jsonb_build_object('salespersonId','70000000-0000-4000-8000-000000000051','id',v_guest,'customerName','臨時客','customerPhone','0911000000','plateNumber','ABC-123','vehicleName','車型 A','issue','故障','status','quoted'), '[]'::jsonb, (select updated_at from public.repair_orders where id = v_guest));
  exception when others then v_denied := true; end;
  if not v_denied then raise exception 'cancelled order reopened'; end if;
  if has_table_privilege('authenticated', 'public.repair_orders', 'UPDATE') or has_table_privilege('anon', 'public.repair_orders', 'SELECT') then
    raise exception 'direct table privileges too broad';
  end if;
end;
$$;
do $$
declare
  v_order uuid;
  v_guest uuid;
  v_line uuid;
  v_denied boolean;
  v_before integer;
begin
  v_order := public.save_repair_order(
    '{"salespersonId":"70000000-0000-4000-8000-000000000051","customerId":"70000000-0000-4000-8000-000000000021","plateNumber":"ABC-123","vehicleName":"車型","issue":"維修","status":"intake"}'::jsonb,
    jsonb_build_array(
      jsonb_build_object('itemId','70000000-0000-4000-8000-000000000031','quantity',2,'unitPrice',120),
      jsonb_build_object('itemId','70000000-0000-4000-8000-000000000032','quantity',1,'unitPrice',2000)));
  perform public.save_repair_order(
    jsonb_build_object('salespersonId','70000000-0000-4000-8000-000000000051','id',v_order,'customerId','70000000-0000-4000-8000-000000000021','plateNumber','ABC-123','vehicleName','車型','issue','維修','status','quoted'),
    jsonb_build_array(
      jsonb_build_object('itemId','70000000-0000-4000-8000-000000000031','quantity',2,'unitPrice',120),
      jsonb_build_object('itemId','70000000-0000-4000-8000-000000000032','quantity',1,'unitPrice',2000)),
    (select updated_at from public.repair_orders where id=v_order));
  select id into v_line from public.repair_lines where repair_order_id=v_order and item_id='70000000-0000-4000-8000-000000000032';
  v_denied := false;
  begin perform public.complete_repair_order(v_order, '{}'::jsonb); exception when others then v_denied := true; end;
  if not v_denied or (select stock from public.items where id='70000000-0000-4000-8000-000000000031') <> 5 then
    raise exception 'missing battery serial partly deducted stock'; end if;
  v_denied := false;
  begin perform public.complete_repair_order(v_order, jsonb_build_object(v_line::text,jsonb_build_array('70000000-0000-4000-8000-000000000043')));
  exception when others then v_denied := true; end;
  if not v_denied or (select count(*) from public.inventory_transactions where repair_order_id=v_order) <> 0 then
    raise exception 'wrong-item serial partly completed'; end if;
  v_denied := false;
  begin perform public.complete_repair_order(v_order, jsonb_build_object(v_line::text,jsonb_build_array('70000000-0000-4000-8000-000000000041','70000000-0000-4000-8000-000000000041')));
  exception when others then v_denied := true; end;
  if not v_denied or (select count(*) from public.warranties where repair_order_id=v_order) <> 0 then
    raise exception 'duplicate or wrong-count serial partly completed'; end if;
  perform public.complete_repair_order(v_order, jsonb_build_object(v_line::text,jsonb_build_array('70000000-0000-4000-8000-000000000041')));
  if (select status <> 'completed' or completed_by <> auth.uid() or completed_at is null from public.repair_orders where id=v_order)
    or (select stock from public.items where id='70000000-0000-4000-8000-000000000031') <> 3
    or (select stock from public.items where id='70000000-0000-4000-8000-000000000032') <> 1
    or (select status <> 'repair_used' or repair_order_id <> v_order from public.inventory_serials where id='70000000-0000-4000-8000-000000000041')
    or (select count(*) from public.inventory_transactions where repair_order_id=v_order) <> 2
    or (select count(*) from public.warranties where repair_order_id=v_order and source='repair' and customer_id='70000000-0000-4000-8000-000000000021') <> 1
    then raise exception 'mixed completion incomplete'; end if;
  v_denied := false;
  begin perform public.complete_repair_order(v_order, '{}'::jsonb); exception when others then v_denied := true; end;
  if not v_denied then raise exception 'double completion accepted'; end if;
  perform public.mark_repair_paid(v_order);
  if (select payment_status <> 'paid' or paid_by <> auth.uid() or paid_at is null from public.repair_orders where id=v_order)
    then raise exception 'payment not recorded'; end if;
  if (select count(*) from public.sales) <> 0 then raise exception 'repair created a sale'; end if;

  v_guest := public.save_repair_order(
    '{"salespersonId":"70000000-0000-4000-8000-000000000051","customerName":"臨時客","customerPhone":"0911000000","plateNumber":"ABC","vehicleName":"車型","issue":"維修"}'::jsonb,
    jsonb_build_array(jsonb_build_object('itemId','70000000-0000-4000-8000-000000000032','quantity',1,'unitPrice',2000)));
  perform public.save_repair_order(
    jsonb_build_object('salespersonId','70000000-0000-4000-8000-000000000051','id',v_guest,'customerName','臨時客','customerPhone','0911000000','plateNumber','ABC','vehicleName','車型','issue','維修','status','quoted'),
    jsonb_build_array(jsonb_build_object('itemId','70000000-0000-4000-8000-000000000032','quantity',1,'unitPrice',2000)),
    (select updated_at from public.repair_orders where id=v_guest));
  select id into v_line from public.repair_lines where repair_order_id=v_guest;
  v_denied := false;
  begin perform public.complete_repair_order(v_guest, jsonb_build_object(v_line::text,jsonb_build_array('70000000-0000-4000-8000-000000000042')));
  exception when others then v_denied := true; end;
  if not v_denied or (select status from public.repair_orders where id=v_guest) <> 'quoted' then
    raise exception 'guest battery completed without member'; end if;
  v_denied := false;
  begin perform public.complete_repair_order(v_guest, jsonb_build_object(v_line::text,jsonb_build_array('70000000-0000-4000-8000-000000000041')));
  exception when others then v_denied := true; end;
  if not v_denied then raise exception 'already-used serial accepted'; end if;
  perform public.save_repair_order(
    jsonb_build_object('salespersonId','70000000-0000-4000-8000-000000000051','id',v_guest,'customerId','70000000-0000-4000-8000-000000000021','plateNumber','ABC','vehicleName','車型','issue','維修','status','quoted'),
    jsonb_build_array(jsonb_build_object('itemId','70000000-0000-4000-8000-000000000032','quantity',1,'unitPrice',2000)),
    (select updated_at from public.repair_orders where id=v_guest));
  perform public.complete_repair_order(v_guest, jsonb_build_object(
    (select id::text from public.repair_lines where repair_order_id=v_guest), jsonb_build_array('70000000-0000-4000-8000-000000000042')));
  if (select count(*) from public.warranties where repair_order_id=v_guest and customer_id='70000000-0000-4000-8000-000000000021') <> 1 then
    raise exception 'guest-to-member completion did not link member warranty'; end if;

  v_order := public.save_repair_order(
    '{"salespersonId":"70000000-0000-4000-8000-000000000051","customerId":"70000000-0000-4000-8000-000000000021","plateNumber":"DEF","vehicleName":"車型","issue":"維修"}'::jsonb,
    jsonb_build_array(jsonb_build_object('itemId','70000000-0000-4000-8000-000000000033','quantity',1,'unitPrice',1800)));
  perform public.save_repair_order(
    jsonb_build_object('salespersonId','70000000-0000-4000-8000-000000000051','id',v_order,'customerId','70000000-0000-4000-8000-000000000021','plateNumber','DEF','vehicleName','車型','issue','維修','status','quoted'),
    jsonb_build_array(jsonb_build_object('itemId','70000000-0000-4000-8000-000000000033','quantity',1,'unitPrice',1800)),
    (select updated_at from public.repair_orders where id=v_order));
  v_denied := false;
  begin perform public.complete_repair_order(v_order, jsonb_build_object(
    (select id::text from public.repair_lines where repair_order_id=v_order), jsonb_build_array('70000000-0000-4000-8000-000000000043')));
  exception when others then v_denied := true; end;
  if not v_denied or (select stock from public.items where id='70000000-0000-4000-8000-000000000033') <> 1 then
    raise exception 'zero-warranty battery partly completed'; end if;
  v_order := public.save_repair_order(
    '{"salespersonId":"70000000-0000-4000-8000-000000000051","customerName":"臨時客","customerPhone":"0911000000","plateNumber":"XYZ","vehicleName":"車型","issue":"維修"}'::jsonb,
    jsonb_build_array(jsonb_build_object('itemId','70000000-0000-4000-8000-000000000031','quantity',4,'unitPrice',120)));
  perform public.save_repair_order(
    jsonb_build_object('salespersonId','70000000-0000-4000-8000-000000000051','id',v_order,'customerName','臨時客','customerPhone','0911000000','plateNumber','XYZ','vehicleName','車型','issue','維修','status','quoted'),
    jsonb_build_array(jsonb_build_object('itemId','70000000-0000-4000-8000-000000000031','quantity',4,'unitPrice',120)),
    (select updated_at from public.repair_orders where id=v_order));
  v_denied := false;
  begin perform public.complete_repair_order(v_order, '{}'::jsonb); exception when others then v_denied := true; end;
  if not v_denied or (select status from public.repair_orders where id=v_order) <> 'quoted'
    or (select stock from public.items where id='70000000-0000-4000-8000-000000000031') <> 3
    or (select count(*) from public.inventory_transactions where repair_order_id=v_order) <> 0 then
    raise exception 'insufficient stock partly completed'; end if;
  v_before := (select count(*) from public.warranties);
  if v_before <> 2 then raise exception 'failed completion changed warranties'; end if;
end $$;
do $$
declare
  v_order uuid;
  v_denied boolean := false;
begin
  select id into v_order from public.repair_orders where status='cancelled' limit 1;
  begin perform public.delete_repair_order(v_order); exception when insufficient_privilege then v_denied := true; end;
  if not v_denied or not exists (select 1 from public.repair_orders where id=v_order) then
    raise exception 'staff deleted unfinished repair'; end if;
end $$;
reset role;
select set_config('request.jwt.claim.sub', '70000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"70000000-0000-4000-8000-000000000001","session_id":"70000000-0000-4000-8000-000000000011"}', true);
set local role authenticated;
do $$
declare
  v_order uuid;
  v_status text;
  v_denied boolean;
begin
  for v_status in select unnest(array['intake', 'quoted', 'cancelled']) loop
    v_order := public.save_repair_order(
      '{"salespersonId":"70000000-0000-4000-8000-000000000051","customerName":"待刪客","customerPhone":"0911000000","plateNumber":"DEL","vehicleName":"車型","issue":"測試"}'::jsonb,
      jsonb_build_array(jsonb_build_object('itemId','70000000-0000-4000-8000-000000000031','quantity',1,'unitPrice',120)));
    if v_status = 'quoted' then
      perform public.save_repair_order(
        jsonb_build_object('salespersonId','70000000-0000-4000-8000-000000000051','id',v_order,'customerName','待刪客','customerPhone','0911000000','plateNumber','DEL','vehicleName','車型','issue','測試','status','quoted'),
        jsonb_build_array(jsonb_build_object('itemId','70000000-0000-4000-8000-000000000031','quantity',1,'unitPrice',120)),
        (select updated_at from public.repair_orders where id=v_order));
    elsif v_status = 'cancelled' then
      perform public.cancel_repair_order(v_order);
    end if;
    perform public.delete_repair_order(v_order);
    if exists (select 1 from public.repair_orders where id=v_order)
      or exists (select 1 from public.repair_lines where repair_order_id=v_order) then
      raise exception 'deleted % repair still has rows', v_status;
    end if;
  end loop;
  select id into v_order from public.repair_orders where status='completed' limit 1;
  v_denied := false;
  begin perform public.delete_repair_order(v_order); exception when others then v_denied := true; end;
  if not v_denied or not exists (select 1 from public.repair_orders where id=v_order) then
    raise exception 'completed repair could be deleted'; end if;
end $$;
reset role;
update public.profiles set active = false where id = '70000000-0000-4000-8000-000000000002';
select set_config('request.jwt.claim.sub', '70000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"70000000-0000-4000-8000-000000000002","session_id":"70000000-0000-4000-8000-000000000012"}', true);
set local role authenticated;
do $$
declare v_denied boolean := false;
begin
  if exists (select 1 from public.repair_orders) then raise exception 'inactive staff can read repairs'; end if;
  begin
    perform public.save_repair_order('{"salespersonId":"70000000-0000-4000-8000-000000000051","customerName":"臨時客","customerPhone":"0911000000","plateNumber":"ABC","vehicleName":"車型","issue":"故障"}'::jsonb, '[]'::jsonb);
  exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'inactive staff can create repairs'; end if;
  if has_function_privilege('anon','public.save_repair_order(jsonb,jsonb,timestamptz)','EXECUTE')
    or has_function_privilege('anon','public.complete_repair_order(uuid,jsonb)','EXECUTE') then
    raise exception 'anonymous can call repair RPC'; end if;
end $$;
reset role;
rollback;
