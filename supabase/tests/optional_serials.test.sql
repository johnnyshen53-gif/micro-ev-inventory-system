-- 序號全面改選填＋保固停用：車身／電池銷售、收貨可以不填序號；有填不可超過數量；不再自動建立保固；
-- 「在庫序號數≠庫存」之後仍可收貨與銷售。整個測試在交易內，結束時 rollback。
begin;
insert into auth.users(id, email) values ('7c000000-0000-4000-8000-000000000001', 'serial-admin@example.invalid');
update public.profiles set role = 'admin', active = true where id = '7c000000-0000-4000-8000-000000000001';
insert into auth.sessions(id, user_id) values ('7c000000-0000-4000-8000-000000000011', '7c000000-0000-4000-8000-000000000001');
insert into public.suppliers(id, name, created_by) values ('7c000000-0000-4000-8000-000000000021', '車廠', '7c000000-0000-4000-8000-000000000001');
insert into public.items(id, name, category, sku, price, stock, warranty_months, supplier_id, vehicle_model_id) values
  ('7c000000-0000-4000-8000-000000000031', '小偉士', '車身', 'OS-BODY', 30000, 2, 12, '7c000000-0000-4000-8000-000000000021', (select id from public.vehicle_models where is_universal));
insert into public.inventory_serials(id, item_id, serial_number, status, created_by) values
  ('7c000000-0000-4000-8000-000000000041', '7c000000-0000-4000-8000-000000000031', 'VIN-001', 'in_stock', '7c000000-0000-4000-8000-000000000001'),
  ('7c000000-0000-4000-8000-000000000042', '7c000000-0000-4000-8000-000000000031', 'VIN-002', 'in_stock', '7c000000-0000-4000-8000-000000000001');
insert into public.salespeople(id, name, active, created_by) values
  ('7c000000-0000-4000-8000-000000000051', '業務', true, '7c000000-0000-4000-8000-000000000001');

select set_config('request.jwt.claim.sub', '7c000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"7c000000-0000-4000-8000-000000000001","session_id":"7c000000-0000-4000-8000-000000000011"}', true);
set local role authenticated;

do $$
declare
  v_body text := '7c000000-0000-4000-8000-000000000031';
  v_sale uuid;
  v_denied boolean;
begin
  -- 1) 車身不選序號、不選客戶也能賣；不建立保固；序號還在庫。
  v_sale := public.create_sale_with_serials(jsonb_build_array(jsonb_build_object('item_id', v_body, 'quantity', 1)),
    null::uuid, '7c000000-0000-4000-8000-000000000051', gen_random_uuid(), '[]'::jsonb, null::text, (now() at time zone 'Asia/Taipei')::date);
  if (select stock from public.items where id = v_body::uuid) <> 1 then raise exception 'stock not deducted'; end if;
  if exists (select 1 from public.warranties) then raise exception 'warranty created'; end if;
  if (select count(*) from public.inventory_serials where item_id = v_body::uuid and status = 'in_stock') <> 2 then raise exception 'serials changed'; end if;

  -- 2) 現在「在庫序號 2 ≠ 庫存 1」，仍可以選序號賣出（以前會被擋）。
  v_sale := public.create_sale_with_serials(jsonb_build_array(jsonb_build_object('item_id', v_body, 'quantity', 1,
      'serial_ids', jsonb_build_array('7c000000-0000-4000-8000-000000000041'))),
    null::uuid, '7c000000-0000-4000-8000-000000000051', gen_random_uuid(), '[]'::jsonb, null::text, (now() at time zone 'Asia/Taipei')::date);
  if (select status from public.inventory_serials where id = '7c000000-0000-4000-8000-000000000041') <> 'sold'
    or (select stock from public.items where id = v_body::uuid) <> 0 then raise exception 'serial sale failed'; end if;
  if exists (select 1 from public.warranties) then raise exception 'warranty created on serial sale'; end if;

  -- 3) 收貨可以不填序號，也可以只填一部分；填超過數量會被擋。
  perform public.save_purchase(jsonb_build_object('id', '7c000000-0000-4000-8000-000000000061', 'number', 'P20261106001',
    'supplierId', '7c000000-0000-4000-8000-000000000021', 'total', 75000), jsonb_build_array(jsonb_build_object('itemId', v_body, 'quantity', 3, 'unitCost', 25000)));
  v_denied := false;
  begin perform public.receive_purchase('7c000000-0000-4000-8000-000000000061', jsonb_build_object(v_body, jsonb_build_array('A', 'B', 'C', 'D')));
  exception when others then v_denied := sqlerrm like '%收貨序號數超過收貨數量%'; end;
  if not v_denied then raise exception 'too many receipt serials accepted'; end if;
  perform public.receive_purchase('7c000000-0000-4000-8000-000000000061', jsonb_build_object(v_body, jsonb_build_array('VIN-003')));
  if (select stock from public.items where id = v_body::uuid) <> 3
    or not exists (select 1 from public.inventory_serials where serial_number = 'VIN-003' and status = 'in_stock') then
    raise exception 'partial-serial receipt failed'; end if;

  -- 4) 選的序號比數量多：擋下。
  v_denied := false;
  begin perform public.create_sale_with_serials(jsonb_build_array(jsonb_build_object('item_id', v_body, 'quantity', 1,
      'serial_ids', jsonb_build_array('7c000000-0000-4000-8000-000000000042', (select id from public.inventory_serials where serial_number = 'VIN-003')))),
    null::uuid, '7c000000-0000-4000-8000-000000000051', gen_random_uuid(), '[]'::jsonb, null::text, (now() at time zone 'Asia/Taipei')::date);
  exception when others then v_denied := sqlerrm like '%所選序號數超過銷售數量%'; end;
  if not v_denied then raise exception 'too many sale serials accepted'; end if;
end $$;
rollback;
