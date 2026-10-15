-- Applied through the connected Supabase management API; filename matches its live version.
alter table public.purchase_lines add column if not exists item_barcode text not null default '';
alter table public.inventory_transactions add column if not exists purchase_id uuid references public.purchases(id);
create unique index if not exists purchase_lines_one_item on public.purchase_lines(purchase_id, item_id);
create unique index if not exists inventory_transactions_one_purchase_item on public.inventory_transactions(purchase_id, item_id) where purchase_id is not null;

create or replace function public.save_purchase(p_purchase jsonb, p_lines jsonb)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  v_id uuid := (p_purchase->>'id')::uuid;
  v_supplier public.suppliers%rowtype;
  v_old public.purchases%rowtype;
  v_item public.items%rowtype;
  v_line jsonb;
  v_quantity integer;
  v_cost numeric(12,2);
  v_total numeric(12,2) := 0;
  v_snapshot jsonb;
begin
  if not app_private.is_admin() then raise exception '管理員權限不足'; end if;
  if v_id is null or coalesce(p_purchase->>'number', '') !~ '^P[0-9]{11}$'
    or jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception '進貨資料不完整';
  end if;
  select * into v_old from public.purchases where id = v_id for update;
  if found and v_old.status <> 'draft' then raise exception '已收貨進貨單不可修改'; end if;
  select * into v_supplier from public.suppliers where id = (p_purchase->>'supplierId')::uuid;
  if not found or (v_old.id is null and not v_supplier.active) then raise exception '供應商不存在或已停用'; end if;
  v_snapshot := jsonb_build_object('name', v_supplier.name, 'contact', v_supplier.contact,
    'phone', v_supplier.phone, 'address', v_supplier.address, 'taxId', v_supplier.tax_id);
  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_quantity := (v_line->>'quantity')::integer;
    v_cost := (v_line->>'unitCost')::numeric;
    if v_quantity is null or v_quantity <= 0 or v_cost is null or v_cost < 0 or v_cost * 100 <> trunc(v_cost * 100) then
      raise exception '進貨數量或成本無效';
    end if;
    select * into v_item from public.items where id = (v_line->>'itemId')::uuid and supplier_id = v_supplier.id;
    if not found then raise exception '進貨品項不屬於供應商'; end if;
    v_total := v_total + v_quantity * v_cost;
  end loop;
  if v_total is distinct from (p_purchase->>'total')::numeric then raise exception '進貨總額無效'; end if;
  if v_old.id is null then
    insert into public.purchases (id, purchase_number, supplier_id, supplier_snapshot, total, note, created_by)
    values (v_id, p_purchase->>'number', v_supplier.id, v_snapshot, v_total,
      coalesce(p_purchase->>'note', ''), auth.uid());
  else
    update public.purchases set supplier_id = v_supplier.id, supplier_snapshot = v_snapshot,
      total = v_total, note = coalesce(p_purchase->>'note', '') where id = v_id;
    delete from public.purchase_lines where purchase_id = v_id;
  end if;
  for v_line in select value from jsonb_array_elements(p_lines) loop
    select * into v_item from public.items where id = (v_line->>'itemId')::uuid;
    v_quantity := (v_line->>'quantity')::integer;
    v_cost := (v_line->>'unitCost')::numeric;
    insert into public.purchase_lines (purchase_id, item_id, item_name, item_sku, item_barcode, quantity, unit_cost, subtotal)
    values (v_id, v_item.id, v_item.name, v_item.sku, v_item.barcode, v_quantity, v_cost, v_quantity * v_cost);
  end loop;
  return v_id;
end;
$$;

create or replace function public.receive_purchase(p_purchase_id uuid, p_serial_numbers_by_item jsonb)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  v_purchase public.purchases%rowtype;
  v_line public.purchase_lines%rowtype;
  v_item public.items%rowtype;
  v_numbers jsonb;
  v_number jsonb;
  v_count integer;
  v_now timestamptz := now();
begin
  if not app_private.is_admin() then raise exception '管理員權限不足'; end if;
  select * into v_purchase from public.purchases where id = p_purchase_id for update;
  if not found or v_purchase.status <> 'draft' then raise exception '進貨單不存在或已收貨'; end if;
  if jsonb_typeof(p_serial_numbers_by_item) is distinct from 'object' then raise exception '收貨序號格式無效'; end if;
  if exists (select 1 from jsonb_object_keys(p_serial_numbers_by_item) key
    where not exists (select 1 from public.purchase_lines where purchase_id = p_purchase_id and item_id::text = key)) then
    raise exception '收貨序號品項不在進貨單';
  end if;
  if not exists (select 1 from public.purchase_lines where purchase_id = p_purchase_id) then raise exception '進貨單沒有明細'; end if;
  for v_line in select * from public.purchase_lines where purchase_id = p_purchase_id order by item_id loop
    select * into v_item from public.items where id = v_line.item_id for update;
    if not found or v_item.supplier_id is distinct from v_purchase.supplier_id then raise exception '品項供應商已變更，請修改草稿'; end if;
    v_numbers := coalesce(p_serial_numbers_by_item->(v_item.id::text), '[]'::jsonb);
    if jsonb_typeof(v_numbers) is distinct from 'array' then raise exception '收貨序號格式無效'; end if;
    v_count := jsonb_array_length(v_numbers);
    if v_item.category in ('機車', '電池') then
      if v_count <> v_line.quantity then raise exception '收貨序號數量不符'; end if;
      if (select count(*) from public.inventory_serials where item_id = v_item.id and status = 'in_stock') <> v_item.stock then
        raise exception '在庫序號尚未補齊';
      end if;
    elsif v_count <> 0 then raise exception '非序號品項不可填寫序號'; end if;
    for v_number in select value from jsonb_array_elements(v_numbers) loop
      if jsonb_typeof(v_number) <> 'string' or nullif(trim(v_number #>> '{}'), '') is null then
        raise exception '原廠序號無效';
      end if;
    end loop;
  end loop;
  for v_line in select * from public.purchase_lines where purchase_id = p_purchase_id order by item_id loop
    update public.items set stock = stock + v_line.quantity where id = v_line.item_id;
    insert into public.item_costs (item_id, cost, updated_by) values (v_line.item_id, v_line.unit_cost, auth.uid())
      on conflict (item_id) do update set cost = excluded.cost, updated_by = excluded.updated_by, updated_at = v_now;
    insert into public.inventory_transactions (item_id, type, quantity, note, purchase_id, created_by)
      values (v_line.item_id, 'in', v_line.quantity, '進貨收貨：' || v_purchase.purchase_number, p_purchase_id, auth.uid());
    for v_number in select value from jsonb_array_elements(coalesce(p_serial_numbers_by_item->(v_line.item_id::text), '[]'::jsonb)) loop
      insert into public.inventory_serials (item_id, serial_number, status, purchase_id, created_by)
      values (v_line.item_id, trim(v_number #>> '{}'), 'in_stock', p_purchase_id, auth.uid());
    end loop;
  end loop;
  update public.purchases set status = 'received', received_by = auth.uid(), received_at = v_now where id = p_purchase_id;
  return p_purchase_id;
end;
$$;

create or replace function public.mark_purchase_paid(p_purchase_id uuid)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare v_purchase public.purchases%rowtype;
begin
  if not app_private.is_admin() then raise exception '管理員權限不足'; end if;
  select * into v_purchase from public.purchases where id = p_purchase_id for update;
  if not found or v_purchase.status <> 'received' or v_purchase.payment_status <> 'unpaid' then
    raise exception '進貨單尚未收貨或已付款';
  end if;
  update public.purchases set payment_status = 'paid', paid_by = auth.uid(), paid_at = now() where id = p_purchase_id;
  return p_purchase_id;
end;
$$;

create or replace function public.delete_purchase_draft(p_purchase_id uuid)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare v_purchase public.purchases%rowtype;
begin
  if not app_private.is_admin() then raise exception '管理員權限不足'; end if;
  select * into v_purchase from public.purchases where id = p_purchase_id for update;
  if not found or v_purchase.status <> 'draft' then raise exception '只能刪除進貨草稿'; end if;
  delete from public.purchases where id = p_purchase_id;
  return p_purchase_id;
end;
$$;

revoke all on function public.save_purchase(jsonb,jsonb), public.receive_purchase(uuid,jsonb),
  public.mark_purchase_paid(uuid), public.delete_purchase_draft(uuid) from public, anon;
grant execute on function public.save_purchase(jsonb,jsonb), public.receive_purchase(uuid,jsonb),
  public.mark_purchase_paid(uuid), public.delete_purchase_draft(uuid) to authenticated;
