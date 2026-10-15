-- The caller sends a validated, explicitly selected local backup. This function
-- merges only operational modules; existing core records are never overwritten.
create or replace function app_private.import_cloud_operations(p_state jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_row jsonb;
  v_line jsonb;
  v_key text;
  v_item uuid;
  v_supplier uuid;
  v_sale_header uuid;
begin
  if v_actor is null or not app_private.is_admin() then
    raise exception '只有店長可以執行首次資料移轉';
  end if;
  if p_state is null or jsonb_typeof(p_state) <> 'object' then
    raise exception '備份資料格式無效';
  end if;
  foreach v_key in array array['items','transactions','customers','salespeople','sales',
      'suppliers','purchases','serials','quotations','warranties','warrantyCases'] loop
    if p_state ? v_key and jsonb_typeof(p_state->v_key) <> 'array' then
      raise exception '備份資料格式無效：%', v_key;
    end if;
  end loop;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('micro-ev-cloud-operations-import'));
  if exists (select 1 from public.app_migrations where module = 'cloud_operations') then
    return false;
  end if;

  -- A cloud cache is not an import source: core IDs and stock must already
  -- agree with the server, or the whole transaction is rejected.
  for v_row in select value from jsonb_array_elements(coalesce(p_state->'items', '[]'::jsonb)) loop
    v_item := (v_row->>'id')::uuid;
    if not exists (select 1 from public.items i where i.id = v_item
      and i.name = v_row->>'name' and i.category = v_row->>'category'
      and i.stock = (v_row->>'stock')::integer and i.price = (v_row->>'price')::numeric) then
      raise exception '雲端品項與備份不一致，請先核對：%', v_item;
    end if;
  end loop;
  for v_row in select value from jsonb_array_elements(coalesce(p_state->'customers', '[]'::jsonb)) loop
    if not exists (select 1 from public.customers where id = (v_row->>'id')::uuid) then
      raise exception '備份客戶尚未存在於雲端：%', v_row->>'id';
    end if;
  end loop;
  for v_row in select value from jsonb_array_elements(coalesce(p_state->'salespeople', '[]'::jsonb)) loop
    if not exists (select 1 from public.salespeople where id = (v_row->>'id')::uuid) then
      raise exception '備份業務尚未存在於雲端：%', v_row->>'id';
    end if;
  end loop;
  for v_row in select value from jsonb_array_elements(coalesce(p_state->'sales', '[]'::jsonb)) loop
    if not exists (select 1 from public.sale_lines where id = (v_row->>'id')::uuid) then
      raise exception '備份銷售尚未存在於雲端：%', v_row->>'id';
    end if;
  end loop;
  for v_row in select value from jsonb_array_elements(coalesce(p_state->'transactions', '[]'::jsonb)) loop
    if coalesce(v_row->>'purchaseId','') = '' and coalesce(v_row->>'warrantyId','') = ''
      and not exists (select 1 from public.inventory_transactions where id = (v_row->>'id')::uuid) then
      raise exception '備份庫存異動尚未存在於雲端：%', v_row->>'id';
    end if;
  end loop;

  for v_row in select value from jsonb_array_elements(coalesce(p_state->'suppliers', '[]'::jsonb)) loop
    insert into public.suppliers (id,name,contact,phone,address,tax_id,note,active,created_by,created_at)
    values ((v_row->>'id')::uuid, v_row->>'name', coalesce(v_row->>'contact',''),
      coalesce(v_row->>'phone',''), coalesce(v_row->>'address',''),
      coalesce(v_row->>'taxId',''), coalesce(v_row->>'note',''),
      coalesce((v_row->>'active')::boolean,true), v_actor,
      coalesce(nullif(v_row->>'createdAt','')::timestamptz,now()));
  end loop;
  for v_row in select value from jsonb_array_elements(coalesce(p_state->'items', '[]'::jsonb)) loop
    v_supplier := nullif(v_row->>'supplierId','')::uuid;
    if v_supplier is not null then
      update public.items set supplier_id = v_supplier
      where id = (v_row->>'id')::uuid and supplier_id is null;
      if not exists (select 1 from public.items where id = (v_row->>'id')::uuid and supplier_id = v_supplier) then
        raise exception '品項供應商與雲端不一致：%', v_row->>'id';
      end if;
    end if;
  end loop;

  for v_row in select value from jsonb_array_elements(coalesce(p_state->'purchases', '[]'::jsonb)) loop
    insert into public.purchases (id,purchase_number,supplier_id,supplier_snapshot,status,payment_status,
      total,note,created_by,received_by,paid_by,created_at,received_at,paid_at)
    values ((v_row->>'id')::uuid, v_row->>'number', (v_row->>'supplierId')::uuid,
      v_row->'supplierSnapshot', v_row->>'status', v_row->>'paymentStatus',
      (v_row->>'total')::numeric, coalesce(v_row->>'note',''), v_actor,
      case when v_row->>'status' = 'received' then v_actor else null end,
      case when v_row->>'paymentStatus' = 'paid' then v_actor else null end,
      coalesce(nullif(v_row->>'createdAt','')::timestamptz,now()),
      nullif(v_row->>'receivedAt','')::timestamptz, nullif(v_row->>'paidAt','')::timestamptz);
    for v_line in select value from jsonb_array_elements(v_row->'lines') loop
      insert into public.purchase_lines (purchase_id,item_id,item_name,item_sku,item_barcode,quantity,unit_cost,subtotal)
      values ((v_row->>'id')::uuid,(v_line->>'itemId')::uuid,v_line->>'itemName',
        coalesce(v_line->>'sku',''),coalesce(v_line->>'barcode',''),
        (v_line->>'quantity')::integer,(v_line->>'unitCost')::numeric,(v_line->>'subtotal')::numeric);
    end loop;
  end loop;
  for v_row in select value from jsonb_array_elements(coalesce(p_state->'quotations', '[]'::jsonb)) loop
    insert into public.quotations (id,quote_number,customer_id,salesperson_id,total,note,created_by,created_at)
    values ((v_row->>'id')::uuid,v_row->>'number',(v_row->>'customerId')::uuid,
      nullif(v_row->>'salespersonId','')::uuid,(v_row->>'total')::numeric,
      coalesce(v_row->>'note',''),v_actor,
      coalesce(nullif(v_row->>'createdAt','')::timestamptz,now()));
    for v_line in select value from jsonb_array_elements(v_row->'lines') loop
      insert into public.quotation_lines (quotation_id,item_id,item_name,quantity,unit_price,subtotal)
      values ((v_row->>'id')::uuid,(v_line->>'itemId')::uuid,v_line->>'itemName',
        (v_line->>'quantity')::integer,(v_line->>'unitPrice')::numeric,(v_line->>'subtotal')::numeric);
    end loop;
  end loop;

  for v_row in select value from jsonb_array_elements(coalesce(p_state->'serials', '[]'::jsonb)) loop
    insert into public.inventory_serials (id,item_id,serial_number,status,purchase_id,sale_line_id,
      customer_id,created_by,created_at,sold_at,removed_at,removed_by,removal_reason)
    values ((v_row->>'id')::uuid,(v_row->>'itemId')::uuid,v_row->>'serialNumber',v_row->>'status',
      nullif(v_row->>'purchaseId','')::uuid,nullif(v_row->>'saleId','')::uuid,
      nullif(v_row->>'customerId','')::uuid,v_actor,
      coalesce(nullif(v_row->>'createdAt','')::timestamptz,now()),
      nullif(v_row->>'soldAt','')::timestamptz,nullif(v_row->>'removedAt','')::timestamptz,
      case when v_row->>'status' in ('removed','warranty_out') then v_actor else null end,
      nullif(v_row->>'removalReason',''));
  end loop;
  for v_row in select value from jsonb_array_elements(coalesce(p_state->'warranties', '[]'::jsonb)) loop
    v_sale_header := null;
    if nullif(v_row->>'saleId','') is not null then
      select sale_id into v_sale_header from public.sale_lines where id = (v_row->>'saleId')::uuid;
      if v_sale_header is null then raise exception '保固銷售關聯無效：%', v_row->>'id'; end if;
    end if;
    insert into public.warranties (id,customer_id,customer_name,item_id,item_name,barcode,source,
      sale_id,sale_line_id,sale_number,serial_id,serial_number,purchased_at,expires_at,note,created_by,created_at)
    values ((v_row->>'id')::uuid,(v_row->>'customerId')::uuid,v_row->>'customerName',
      (v_row->>'itemId')::uuid,v_row->>'itemName',coalesce(v_row->>'barcode',''),
      v_row->>'source',v_sale_header,nullif(v_row->>'saleId','')::uuid,
      coalesce(v_row->>'saleNumber',''),nullif(v_row->>'serialId','')::uuid,
      nullif(v_row->>'serialNumber',''),(v_row->>'purchasedAt')::date,
      (v_row->>'expiresAt')::date,coalesce(v_row->>'note',''),v_actor,
      coalesce(nullif(v_row->>'createdAt','')::timestamptz,now()));
  end loop;
  for v_row in select value from jsonb_array_elements(coalesce(p_state->'serials', '[]'::jsonb)) loop
    if nullif(v_row->>'warrantyId','') is not null then
      update public.inventory_serials set warranty_id = (v_row->>'warrantyId')::uuid
      where id = (v_row->>'id')::uuid;
    end if;
  end loop;
  for v_row in select value from jsonb_array_elements(coalesce(p_state->'warrantyCases', '[]'::jsonb)) loop
    insert into public.warranty_cases (id,warranty_id,issue,status,handled_at,resolution_note,
      item_name,purchased_at,expires_at,created_by,created_at)
    values ((v_row->>'id')::uuid,(v_row->>'warrantyId')::uuid,v_row->>'issue',v_row->>'status',
      nullif(v_row->>'handledAt','')::date,coalesce(v_row->>'resolutionNote',''),
      v_row->>'itemName',(v_row->>'purchasedAt')::date,(v_row->>'expiresAt')::date,
      v_actor,coalesce(nullif(v_row->>'createdAt','')::timestamptz,now()));
  end loop;
  for v_row in select value from jsonb_array_elements(coalesce(p_state->'transactions', '[]'::jsonb)) loop
    if coalesce(v_row->>'purchaseId','') <> '' or coalesce(v_row->>'warrantyId','') <> '' then
      insert into public.inventory_transactions (id,item_id,type,quantity,note,purchase_id,warranty_id,
        customer_id,item_name,expires_at,unit_cost_snapshot,serial_ids,serial_numbers,created_by,created_at)
      values ((v_row->>'id')::uuid,(v_row->>'itemId')::uuid,
        case when v_row->>'type' = 'warranty_out' then 'out'
          when v_row->>'type' = 'adjust' then 'set' else v_row->>'type' end,
        (v_row->>'quantity')::integer,coalesce(v_row->>'note',''),
        nullif(v_row->>'purchaseId','')::uuid,nullif(v_row->>'warrantyId','')::uuid,
        nullif(v_row->>'customerId','')::uuid,nullif(v_row->>'itemName',''),
        nullif(v_row->>'expiresAt','')::date,nullif(v_row->>'unitCostSnapshot','')::numeric,
        array(select jsonb_array_elements_text(coalesce(v_row->'serialIds','[]'::jsonb))::uuid),
        array(select jsonb_array_elements_text(coalesce(v_row->'serialNumbers','[]'::jsonb))),
        v_actor,coalesce(nullif(v_row->>'createdAt','')::timestamptz,now()));
    end if;
  end loop;
  insert into public.app_migrations (module,migrated_by,source_fingerprint)
    values ('cloud_operations',v_actor,pg_catalog.md5(p_state::text));
  return true;
end;
$$;

revoke all on function app_private.import_cloud_operations(jsonb) from public, anon, authenticated;
create or replace function public.import_cloud_operations(p_state jsonb)
returns boolean language sql security invoker set search_path = '' as $$
  select app_private.import_cloud_operations(p_state);
$$;
revoke all on function public.import_cloud_operations(jsonb) from public, anon;
grant execute on function public.import_cloud_operations(jsonb) to authenticated;
