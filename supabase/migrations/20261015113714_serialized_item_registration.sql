-- Register physical units only when the authenticated manager has enough unassigned stock.
create or replace function public.register_inventory_serials(p_item_id uuid, p_serials jsonb)
returns integer language plpgsql security invoker set search_path = '' as $$
declare
  v_item public.items%rowtype;
  v_serial jsonb;
  v_count integer;
begin
  if not app_private.is_admin() then raise exception '管理員權限不足' using errcode = '42501'; end if;
  if p_serials is null or jsonb_typeof(p_serials) <> 'array' or jsonb_array_length(p_serials) = 0 then
    raise exception '請輸入原廠序號';
  end if;
  select * into v_item from public.items where id = p_item_id for update;
  if not found then raise exception '品項不存在'; end if;
  if v_item.category not in ('機車', '電池') then raise exception '此品項不使用原廠序號'; end if;
  select count(*) into v_count from public.inventory_serials where item_id = p_item_id and status = 'in_stock';
  if v_count + jsonb_array_length(p_serials) > v_item.stock then raise exception '原廠序號數量超過現有庫存'; end if;
  for v_serial in select value from jsonb_array_elements(p_serials) loop
    if jsonb_typeof(v_serial) <> 'object' or nullif(trim(v_serial->>'serialNumber'), '') is null
      or nullif(v_serial->>'id', '') is null then raise exception '原廠序號資料不完整'; end if;
    insert into public.inventory_serials (id, item_id, serial_number, status, created_by)
      values ((v_serial->>'id')::uuid, p_item_id, trim(v_serial->>'serialNumber'), 'in_stock', auth.uid());
  end loop;
  return jsonb_array_length(p_serials);
end;
$$;

create or replace function public.create_serialized_item(p_item jsonb, p_cost numeric, p_serials jsonb)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  v_id uuid := (p_item->>'id')::uuid;
  v_stock integer := (p_item->>'stock')::integer;
begin
  if not app_private.is_admin() then raise exception '管理員權限不足' using errcode = '42501'; end if;
  if v_id is null or p_item->>'category' not in ('機車', '電池') or v_stock is null or v_stock < 1
    or p_serials is null or jsonb_typeof(p_serials) <> 'array' or jsonb_array_length(p_serials) <> v_stock then
    raise exception '品項與原廠序號數量不相符';
  end if;
  insert into public.items (id, name, category, sku, barcode, price, stock, minimum_stock,
    warranty_months, notes, supplier_id, created_by)
  values (v_id, p_item->>'name', p_item->>'category', coalesce(p_item->>'sku', ''),
    coalesce(p_item->>'barcode', ''), (p_item->>'price')::numeric, v_stock,
    (p_item->>'minimum_stock')::integer, coalesce((p_item->>'warranty_months')::integer, 0),
    coalesce(p_item->>'notes', ''), nullif(p_item->>'supplier_id', '')::uuid, auth.uid());
  insert into public.item_costs (item_id, cost, updated_by) values (v_id, p_cost, auth.uid());
  perform public.register_inventory_serials(v_id, p_serials);
  return v_id;
end;
$$;

revoke all on function public.register_inventory_serials(uuid, jsonb), public.create_serialized_item(jsonb, numeric, jsonb) from public, anon;
grant execute on function public.register_inventory_serials(uuid, jsonb), public.create_serialized_item(jsonb, numeric, jsonb) to authenticated;
