begin;

select set_config('request.jwt.claim.sub',
  (select id::text from public.profiles where active and role = 'admin' limit 1), true);
select set_config('request.jwt.claims',
  (select json_build_object('sub', p.id, 'session_id', s.id)::text
    from public.profiles p join auth.sessions s on s.user_id = p.id
    where p.active and p.role = 'admin' limit 1), true);

do $$
declare
  v_actor uuid := auth.uid();
  v_claims text := current_setting('request.jwt.claims');
  v_item uuid := gen_random_uuid();
  v_other uuid := gen_random_uuid();
  v_supplier uuid := gen_random_uuid();
  v_purchase uuid := gen_random_uuid();
  v_customer uuid := gen_random_uuid();
  v_sale uuid := gen_random_uuid();
  v_sale_line uuid := gen_random_uuid();
  v_serial uuid := gen_random_uuid();
  v_sale_warranty uuid := gen_random_uuid();
  v_quote uuid := gen_random_uuid();
  v_warranty uuid := gen_random_uuid();
  v_case uuid := gen_random_uuid();
  v_bad jsonb;
  v_state jsonb;
  v_denied boolean;
begin
  if v_actor is null then raise exception 'test requires an active admin'; end if;
  insert into public.items (id, name, category, stock, price, created_by)
    values (v_item, '匯入測試電池', '電池', 0, 20, v_actor),
           (v_other, '其他測試電池', '電池', 0, 20, v_actor);
  insert into public.customers (id, member_number, name, created_by)
    values (v_customer, 'M999998', '匯入測試客戶', v_actor);
  insert into public.sales (id, sale_number, total, customer_id, created_by, created_at)
    values (v_sale, 'S20991231002', 20, v_customer, v_actor, '2026-10-15T00:00:00Z');
  insert into public.sale_lines (id, sale_id, item_id, item_name, barcode, quantity, unit_price, subtotal)
    values (v_sale_line, v_sale, v_item, '匯入測試電池', '', 1, 20, 20);
  perform set_config('role', 'authenticated', true);
  if not app_private.is_admin() then raise exception 'test requires an active admin'; end if;
  v_state := jsonb_build_object(
    'items', jsonb_build_array(jsonb_build_object('id', v_item, 'name', '匯入測試電池',
      'category', '電池', 'stock', 0, 'price', 20)),
    'suppliers', jsonb_build_array(jsonb_build_object('id', v_supplier, 'name', '匯入測試供應商')),
    'purchases', jsonb_build_array(jsonb_build_object('id', v_purchase, 'number', 'P20991231002',
      'supplierId', v_supplier, 'supplierSnapshot', jsonb_build_object('name', '匯入測試供應商'),
      'status', 'draft', 'paymentStatus', 'unpaid', 'total', 20,
      'lines', jsonb_build_array(jsonb_build_object('itemId', v_item, 'itemName', '匯入測試電池',
        'quantity', 1, 'unitCost', 20, 'subtotal', 20)))),
    'customers', jsonb_build_array(jsonb_build_object('id', v_customer)),
    'quotations', jsonb_build_array(jsonb_build_object('id', v_quote, 'number', 'Q20991231002',
      'customerId', v_customer, 'total', 20,
      'lines', jsonb_build_array(jsonb_build_object('itemId', v_item, 'itemName', '匯入測試電池',
        'quantity', 1, 'unitPrice', 20, 'subtotal', 20)))),
    'warranties', jsonb_build_array(jsonb_build_object('id', v_warranty, 'customerId', v_customer,
      'customerName', '匯入測試客戶', 'itemId', v_item, 'itemName', '匯入測試電池',
      'source', 'manual', 'purchasedAt', '2026-10-15', 'expiresAt', '2027-10-15')),
    'warrantyCases', jsonb_build_array(jsonb_build_object('id', v_case, 'warrantyId', v_warranty,
      'issue', '測試送修', 'status', 'pending', 'itemName', '匯入測試電池',
      'purchasedAt', '2026-10-15', 'expiresAt', '2027-10-15')),
    'sales', jsonb_build_array(jsonb_build_object('id', v_sale_line, 'itemId', v_item,
      'serialIds', jsonb_build_array(v_serial), 'serialNumbers', jsonb_build_array('IMPORT-SN-1'))),
    'serials', jsonb_build_array(jsonb_build_object('id', v_serial, 'itemId', v_item,
      'serialNumber', 'IMPORT-SN-1', 'status', 'sold', 'saleId', v_sale_line,
      'customerId', v_customer, 'soldAt', '2026-10-15T00:00:00Z')));
  v_state := jsonb_set(v_state, '{warranties}', (v_state->'warranties') ||
    jsonb_build_array(jsonb_build_object('id', v_sale_warranty, 'customerId', v_customer,
      'customerName', '匯入測試客戶', 'itemId', v_item, 'itemName', '匯入測試電池',
      'source', 'sale', 'saleId', v_sale_line, 'saleNumber', 'S20991231002',
      'serialId', v_serial, 'serialNumber', 'IMPORT-SN-1',
      'purchasedAt', '2026-10-15', 'expiresAt', '2027-10-15')));
  v_bad := jsonb_set(v_state, '{purchases,0,supplierId}', to_jsonb(gen_random_uuid()));
  v_denied := false;
  begin perform public.import_cloud_operations(v_bad);
  exception when others then v_denied := true;
  end;
  if not v_denied or exists (select 1 from public.suppliers where id = v_supplier)
    or exists (select 1 from public.app_migrations where module = 'cloud_operations') then
    raise exception 'failed import wrote partial data or migration marker';
  end if;
  v_bad := jsonb_set(v_state, '{items,0,stock}', '999'::jsonb);
  v_denied := false;
  begin perform public.import_cloud_operations(v_bad);
  exception when others then v_denied := true;
  end;
  if not v_denied or exists (select 1 from public.app_migrations where module = 'cloud_operations') then
    raise exception 'stale stock was accepted or marked migrated';
  end if;
  v_bad := jsonb_set(v_state, '{serials,0,itemId}', to_jsonb(v_other));
  v_denied := false;
  begin perform public.import_cloud_operations(v_bad);
  exception when others then v_denied := true;
  end;
  if not v_denied or exists (select 1 from public.app_migrations where module = 'cloud_operations') then
    raise exception 'cross-item serial was accepted or marked migrated';
  end if;
  perform set_config('request.jwt.claim.sub', gen_random_uuid()::text, true);
  perform set_config('request.jwt.claims', '{}'::text, true);
  v_denied := false;
  begin perform public.import_cloud_operations(v_state);
  exception when others then v_denied := true;
  end;
  if not v_denied then raise exception 'non-admin imported data'; end if;
  perform set_config('request.jwt.claim.sub', v_actor::text, true);
  perform set_config('request.jwt.claims', v_claims, true);
  if public.import_cloud_operations(v_state) is not true then raise exception 'initial import was skipped'; end if;
  if not exists (select 1 from public.suppliers where id = v_supplier)
    or not exists (select 1 from public.purchases where id = v_purchase)
    or not exists (select 1 from public.purchase_lines where purchase_id = v_purchase)
    or not exists (select 1 from public.quotations where id = v_quote)
    or not exists (select 1 from public.warranties where id = v_warranty)
    or not exists (select 1 from public.warranty_cases where id = v_case)
    or not exists (select 1 from public.inventory_serials where id = v_serial and sale_line_id = v_sale_line)
    or not exists (select 1 from public.warranties where id = v_sale_warranty and serial_id = v_serial)
    or not exists (select 1 from public.app_migrations where module = 'cloud_operations') then
    raise exception 'successful import did not write all records and marker';
  end if;
  if public.import_cloud_operations(v_state) is not false then raise exception 'repeat import was not skipped'; end if;
end $$;

rollback;
