-- Applied through the connected Supabase management API; filename matches its live version.
create or replace function public.create_or_update_supplier(p_supplier jsonb)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  v_id uuid := (p_supplier->>'id')::uuid;
begin
  if not app_private.is_admin() then raise exception '管理員權限不足'; end if;
  if v_id is null or nullif(trim(p_supplier->>'name'), '') is null then raise exception '供應商資料不完整'; end if;
  insert into public.suppliers (id, name, contact, phone, address, tax_id, note, active, created_by)
  values (v_id, trim(p_supplier->>'name'), coalesce(p_supplier->>'contact', ''), coalesce(p_supplier->>'phone', ''),
    coalesce(p_supplier->>'address', ''), coalesce(p_supplier->>'taxId', ''), coalesce(p_supplier->>'note', ''),
    coalesce((p_supplier->>'active')::boolean, true), auth.uid())
  on conflict (id) do update set name = excluded.name, contact = excluded.contact, phone = excluded.phone,
    address = excluded.address, tax_id = excluded.tax_id, note = excluded.note, active = excluded.active,
    updated_at = now();
  return v_id;
end;
$$;

create or replace function public.save_quotation(p_quotation jsonb, p_lines jsonb)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  v_id uuid := (p_quotation->>'id')::uuid;
  v_customer_id uuid := (p_quotation->>'customerId')::uuid;
  v_salesperson_id uuid := (p_quotation->>'salespersonId')::uuid;
  v_line jsonb;
  v_item public.items%rowtype;
  v_quantity integer;
  v_total numeric(12,2) := 0;
begin
  if not app_private.is_active_staff() then raise exception '帳號權限不足'; end if;
  if v_id is null or nullif(trim(p_quotation->>'number'), '') is null or
     jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception '報價資料不完整';
  end if;
  if exists (select 1 from public.quotations where id = v_id) then raise exception '報價已存在，不能覆寫'; end if;
  if not exists (select 1 from public.customers where id = v_customer_id and active) then raise exception '報價客戶不存在或已停用'; end if;
  if v_salesperson_id is not null and not exists (select 1 from public.salespeople where id = v_salesperson_id and active) then
    raise exception '報價業務不存在或已停用';
  end if;
  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_quantity := (v_line->>'quantity')::integer;
    if v_quantity is null or v_quantity <= 0 then raise exception '報價數量無效'; end if;
    select * into v_item from public.items where id = (v_line->>'itemId')::uuid;
    if not found then raise exception '報價品項不存在'; end if;
    if (v_line->>'itemName') is distinct from v_item.name or (v_line->>'unitPrice')::numeric is distinct from v_item.price then
      raise exception '報價品項資料已變更，請重新整理';
    end if;
    v_total := v_total + v_quantity * v_item.price;
  end loop;
  if v_total is distinct from (p_quotation->>'total')::numeric then raise exception '報價總額無效'; end if;
  insert into public.quotations (id, quote_number, customer_id, salesperson_id, total, note, created_by)
  values (v_id, trim(p_quotation->>'number'), v_customer_id, v_salesperson_id, v_total,
    coalesce(p_quotation->>'note', ''), auth.uid());
  for v_line in select value from jsonb_array_elements(p_lines) loop
    select * into v_item from public.items where id = (v_line->>'itemId')::uuid;
    v_quantity := (v_line->>'quantity')::integer;
    insert into public.quotation_lines (quotation_id, item_id, item_name, quantity, unit_price, subtotal)
    values (v_id, v_item.id, v_item.name, v_quantity, v_item.price, v_quantity * v_item.price);
  end loop;
  return v_id;
end;
$$;

revoke all on function public.create_or_update_supplier(jsonb), public.save_quotation(jsonb, jsonb) from public, anon;
grant execute on function public.create_or_update_supplier(jsonb), public.save_quotation(jsonb, jsonb) to authenticated;
