begin;

insert into auth.users(id, email) values ('30000000-0000-4000-8000-000000000001', 'serial-test-admin@example.invalid');
update public.profiles set role = 'admin', active = true where id = '30000000-0000-4000-8000-000000000001';
insert into auth.sessions(id, user_id) values
  ('30000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000001');

select set_config('request.jwt.claim.sub',
  (select id::text from public.profiles where active and role = 'admin' limit 1), true);
select set_config('request.jwt.claims',
  (select json_build_object('sub', p.id, 'session_id', s.id)::text
    from public.profiles p join auth.sessions s on s.user_id = p.id
    where p.active and p.role = 'admin' limit 1), true);
set local role authenticated;

do $$
declare
  v_item uuid := gen_random_uuid();
  v_serial uuid := gen_random_uuid();
  v_second uuid := gen_random_uuid();
  v_existing uuid := gen_random_uuid();
  v_denied boolean;
begin
  if not app_private.is_admin() then raise exception 'active admin session required'; end if;
  perform public.create_serialized_item(
    jsonb_build_object('id', v_item, 'name', '序號測試電池', 'category', '電池',
      'sku', 'TEST-SERIAL', 'barcode', '', 'price', 100, 'stock', 2,
      'minimum_stock', 0, 'warranty_months', 12, 'notes', '', 'vehicle_model_id', (select id from public.vehicle_models where is_universal)),
    50, jsonb_build_array(jsonb_build_object('id', v_serial, 'serialNumber', 'TEST-FACTORY-A'),
      jsonb_build_object('id', v_second, 'serialNumber', 'TEST-FACTORY-B')));
  if (select stock from public.items where id = v_item) <> 2
    or (select count(*) from public.inventory_serials where item_id = v_item and status = 'in_stock') <> 2
    or (select cost from public.item_costs where item_id = v_item) <> 50 then
    raise exception 'item and initial serials were not saved together';
  end if;

  insert into public.items (id, name, category, stock, created_by, vehicle_model_id)
    values (v_existing, '既有測試電池', '電池', 2, auth.uid(), (select id from public.vehicle_models where is_universal));
  perform public.register_inventory_serials(v_existing,
    jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'serialNumber', 'TEST-FACTORY-E')));
  if (select count(*) from public.inventory_serials where item_id = v_existing and status = 'in_stock') <> 1 then
    raise exception 'existing item registration was not saved';
  end if;
  v_denied := false;
  begin
    perform public.register_inventory_serials(v_existing,
      jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'serialNumber', 'TEST-FACTORY-E')));
  exception when unique_violation then v_denied := true;
  end;
  if not v_denied then raise exception 'duplicate serial was accepted'; end if;

  v_denied := false;
  begin
    perform public.register_inventory_serials(v_item,
      jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'serialNumber', 'TEST-FACTORY-C')));
  exception when others then v_denied := true;
  end;
  if not v_denied then raise exception 'over-capacity serial registration was accepted'; end if;

  v_denied := false;
  begin
    perform public.create_serialized_item(
      jsonb_build_object('id', gen_random_uuid(), 'name', '失敗測試', 'category', '電池',
        'price', 100, 'stock', 2, 'minimum_stock', 0), 50,
      jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'serialNumber', 'TEST-FACTORY-D')));
  exception when others then v_denied := true;
  end;
  if not v_denied or exists (select 1 from public.items where name = '失敗測試') then
    raise exception 'invalid initial serial count did not roll back';
  end if;
end;
$$;

rollback;
