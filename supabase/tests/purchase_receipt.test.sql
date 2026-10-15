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
  v_supplier uuid := gen_random_uuid();
  v_item uuid := gen_random_uuid();
  v_purchase uuid := gen_random_uuid();
  v_claims text := current_setting('request.jwt.claims');
  v_denied boolean;
begin
  if v_actor is null then raise exception 'test requires an active admin'; end if;
  insert into public.suppliers (id, name, created_by) values (v_supplier, '收貨測試供應商', v_actor);
  insert into public.items (id, name, category, supplier_id, created_by)
    values (v_item, '收貨測試電池', '電池', v_supplier, v_actor);
  perform public.save_purchase(
    jsonb_build_object('id', v_purchase, 'number', 'P20991231001', 'supplierId', v_supplier, 'total', 10),
    jsonb_build_array(jsonb_build_object('itemId', v_item, 'quantity', 1, 'unitCost', 10)));

  v_denied := false;
  begin
    perform public.receive_purchase(v_purchase, '{}'::jsonb);
  exception when others then v_denied := true;
  end;
  if not v_denied then raise exception 'receipt accepted missing serial'; end if;
  if (select stock from public.items where id = v_item) <> 0 or
    exists (select 1 from public.inventory_transactions where purchase_id = v_purchase) then
    raise exception 'failed receipt changed stock or history';
  end if;

  perform set_config('request.jwt.claim.sub', gen_random_uuid()::text, true);
  perform set_config('request.jwt.claims', '{}'::text, true);
  v_denied := false;
  begin
    perform public.receive_purchase(v_purchase, jsonb_build_object(v_item::text, jsonb_build_array('SN-TEST')));
  exception when others then v_denied := true;
  end;
  if not v_denied then raise exception 'non-admin received purchase'; end if;
  perform set_config('request.jwt.claim.sub', v_actor::text, true);
  perform set_config('request.jwt.claims', v_claims, true);

  perform public.receive_purchase(v_purchase, jsonb_build_object(v_item::text, jsonb_build_array('SN-TEST')));
  if (select stock from public.items where id = v_item) <> 1 or
    (select count(*) from public.inventory_transactions where purchase_id = v_purchase) <> 1 or
    (select count(*) from public.inventory_serials where purchase_id = v_purchase) <> 1 then
    raise exception 'receipt did not atomically persist stock, history, and serial';
  end if;
  v_denied := false;
  begin
    perform public.receive_purchase(v_purchase, jsonb_build_object(v_item::text, jsonb_build_array('SN-TEST-2')));
  exception when others then v_denied := true;
  end;
  if not v_denied or (select stock from public.items where id = v_item) <> 1 then
    raise exception 'duplicate receipt changed stock';
  end if;
  perform public.mark_purchase_paid(v_purchase);
  if (select payment_status from public.purchases where id = v_purchase) <> 'paid' then
    raise exception 'payment marker was not saved';
  end if;
end $$;

rollback;
