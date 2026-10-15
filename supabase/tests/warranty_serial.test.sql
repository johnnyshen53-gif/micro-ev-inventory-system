begin;

select set_config('request.jwt.claim.sub',
  (select id::text from public.profiles where active and role = 'admin' limit 1), true);
select set_config('request.jwt.claims',
  (select json_build_object('sub', p.id, 'session_id', s.id)::text
    from public.profiles p join auth.sessions s on s.user_id = p.id
    where p.active and p.role = 'admin' limit 1), true);
set local role authenticated;

do $$
declare
  v_actor uuid := auth.uid();
  v_claims text := current_setting('request.jwt.claims');
  v_customer uuid := gen_random_uuid();
  v_item uuid := gen_random_uuid();
  v_other uuid := gen_random_uuid();
  v_part uuid := gen_random_uuid();
  v_serial uuid := gen_random_uuid();
  v_other_serial uuid := gen_random_uuid();
  v_sale uuid;
  v_warranty uuid;
  v_case uuid := gen_random_uuid();
  v_manual uuid := gen_random_uuid();
  v_denied boolean;
begin
  if not app_private.is_admin() then raise exception 'test requires an active admin session'; end if;
  insert into public.customers (id, member_number, name, phone, created_by)
    values (v_customer, 'M999999', '保固測試客戶', '0900000000', v_actor);
  insert into public.items (id, name, category, stock, warranty_months, price, created_by)
    values (v_item, '測試電池', '電池', 1, 12, 100, v_actor),
           (v_other, '其他測試電池', '電池', 1, 0, 50, v_actor),
           (v_part, '測試零件', '零件', 0, 0, 20, v_actor);
  insert into public.inventory_serials (id, item_id, serial_number, status, created_by)
    values (v_serial, v_item, 'WARRANTY-TEST-SN-1', 'in_stock', v_actor),
           (v_other_serial, v_other, 'WARRANTY-TEST-SN-2', 'in_stock', v_actor);

  v_denied := false;
  begin
    perform public.create_sale_with_serials(
      jsonb_build_array(jsonb_build_object('item_id', v_item, 'quantity', 1,
        'serial_ids', jsonb_build_array(v_other_serial))), v_customer);
  exception when others then v_denied := true;
  end;
  if not v_denied or (select stock from public.items where id = v_item) <> 1 then
    raise exception 'cross-item serial sale was not rejected atomically';
  end if;

  v_sale := public.create_sale_with_serials(
    jsonb_build_array(jsonb_build_object('item_id', v_item, 'quantity', 1,
      'serial_ids', jsonb_build_array(v_serial))), v_customer);
  select id into v_warranty from public.warranties where sale_id = v_sale and serial_id = v_serial;
  if v_warranty is null or (select stock from public.items where id = v_item) <> 0
    or not exists (select 1 from public.inventory_serials where id = v_serial and status = 'sold'
      and customer_id = v_customer and sale_line_id is not null)
    or not exists (select 1 from public.audit_logs where target_id = v_sale and action = 'sale_created') then
    raise exception 'sale did not persist physical unit and warranty';
  end if;

  perform public.save_warranty_case(jsonb_build_object('id', v_case, 'warrantyId', v_warranty,
    'issue', '無法充電', 'status', 'pending'));
  if not exists (select 1 from public.warranty_cases where id = v_case and warranty_id = v_warranty) then
    raise exception 'repair case was not saved';
  end if;
  perform public.save_warranty(jsonb_build_object('id', v_manual, 'customerId', v_customer,
    'itemId', v_part, 'source', 'manual', 'purchasedAt', '2026-10-15',
    'expiresAt', '2027-10-15', 'note', '手動保固'));
  if not exists (select 1 from public.warranties where id = v_manual and source = 'manual'
    and customer_id = v_customer and item_id = v_part) then
    raise exception 'manual warranty was not saved';
  end if;

  v_denied := false;
  begin
    perform public.issue_warranty_replacement(v_other, 1, v_warranty, array[v_serial], '故障更換');
  exception when others then v_denied := true;
  end;
  if not v_denied or (select stock from public.items where id = v_other) <> 1 then
    raise exception 'invalid replacement serial changed stock';
  end if;
  perform public.issue_warranty_replacement(v_other, 1, v_warranty, array[v_other_serial], '故障更換');
  if (select stock from public.items where id = v_other) <> 0
    or not exists (select 1 from public.inventory_serials where id = v_other_serial and status = 'warranty_out'
      and warranty_id = v_warranty)
    or not exists (select 1 from public.inventory_transactions where warranty_id = v_warranty
      and serial_ids = array[v_other_serial]) then
    raise exception 'warranty replacement did not persist atomically';
  end if;

  v_denied := false;
  begin perform public.delete_warranty(v_warranty);
  exception when others then v_denied := true;
  end;
  if not v_denied then raise exception 'warranty with replacement was deleted'; end if;
  perform set_config('request.jwt.claim.sub', gen_random_uuid()::text, true);
  perform set_config('request.jwt.claims', '{}'::text, true);
  v_denied := false;
  begin perform public.delete_warranty_case(v_case);
  exception when others then v_denied := true;
  end;
  if not v_denied then raise exception 'non-admin deleted repair case'; end if;
  perform set_config('request.jwt.claim.sub', v_actor::text, true);
  perform set_config('request.jwt.claims', v_claims, true);
  perform public.delete_warranty_case(v_case);
end $$;

rollback;
