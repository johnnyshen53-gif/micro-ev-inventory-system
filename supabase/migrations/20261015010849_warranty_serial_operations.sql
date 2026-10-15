-- Applied through the connected Supabase management API; filename matches its live version.
alter table public.inventory_serials
  add column if not exists sale_line_id uuid references public.sale_lines(id),
  add column if not exists removed_at timestamptz,
  add column if not exists removed_by uuid references public.profiles(id),
  add column if not exists removal_reason text not null default '';

alter table public.warranties drop constraint if exists warranties_sale_line_id_key;
alter table public.warranties drop constraint if exists warranties_check1;
alter table public.warranties
  add column if not exists serial_id uuid references public.inventory_serials(id),
  add column if not exists serial_number text not null default '';
alter table public.warranties add constraint warranties_source_links_check
  check ((source = 'sale' and sale_id is not null and sale_line_id is not null)
    or (source = 'manual' and (sale_line_id is null or serial_id is not null)));
create unique index if not exists warranties_one_serial on public.warranties(serial_id) where serial_id is not null;
create unique index if not exists warranties_one_nonserial_sale_line on public.warranties(sale_line_id)
  where sale_line_id is not null and serial_id is null;

alter table public.inventory_transactions
  add column if not exists warranty_id uuid references public.warranties(id),
  add column if not exists customer_id uuid references public.customers(id),
  add column if not exists item_name text,
  add column if not exists expires_at date,
  add column if not exists unit_cost_snapshot numeric(12,2),
  add column if not exists serial_ids uuid[] not null default '{}',
  add column if not exists serial_numbers text[] not null default '{}';

create or replace function public.save_warranty(p_warranty jsonb)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  v_id uuid := (p_warranty->>'id')::uuid;
  v_customer uuid := (p_warranty->>'customerId')::uuid;
  v_item uuid := (p_warranty->>'itemId')::uuid;
  v_serial uuid := nullif(p_warranty->>'serialId', '')::uuid;
  v_line uuid := nullif(p_warranty->>'saleId', '')::uuid;
  v_sale uuid;
  v_old public.warranties%rowtype;
  v_customer_name text;
  v_item_row public.items%rowtype;
  v_serial_row public.inventory_serials%rowtype;
  v_purchased date := (p_warranty->>'purchasedAt')::date;
  v_expires date := (p_warranty->>'expiresAt')::date;
begin
  if not app_private.is_active_staff() then raise exception '帳號權限不足'; end if;
  if v_id is null or v_purchased is null or v_expires is null or v_expires < v_purchased then raise exception '保固日期無效'; end if;
  select * into v_old from public.warranties where id = v_id for update;
  if found then
    if v_old.customer_id <> v_customer or v_old.item_id <> v_item or v_old.source <> p_warranty->>'source'
      or v_old.serial_id is distinct from v_serial or v_old.sale_line_id is distinct from v_line then
      raise exception '保固來源與商品不可更改';
    end if;
    update public.warranties set purchased_at = v_purchased, expires_at = v_expires,
      note = coalesce(p_warranty->>'note', '') where id = v_id;
    return v_id;
  end if;
  select name into v_customer_name from public.customers where id = v_customer;
  if not found then raise exception '保固客戶不存在'; end if;
  select * into v_item_row from public.items where id = v_item;
  if not found then raise exception '保固品項不存在'; end if;
  if v_serial is not null then
    select * into v_serial_row from public.inventory_serials where id = v_serial;
    if not found or v_serial_row.status <> 'sold' or v_serial_row.item_id <> v_item
      or v_serial_row.customer_id <> v_customer or v_serial_row.sale_line_id is distinct from v_line then
      raise exception '保固序號與客戶或品項不相符';
    end if;
  elsif v_item_row.category in ('機車', '電池') then raise exception '序號品項必須指定已售序號'; end if;
  if v_line is not null then
    select s.id into v_sale from public.sale_lines sl join public.sales s on s.id = sl.sale_id
      where sl.id = v_line and sl.item_id = v_item and s.customer_id = v_customer;
    if not found then raise exception '保固銷售來源不相符'; end if;
  elsif p_warranty->>'source' <> 'manual' then raise exception '銷售保固必須有銷售來源'; end if;
  insert into public.warranties (id, customer_id, customer_name, item_id, item_name, barcode, source,
    sale_id, sale_line_id, sale_number, serial_id, serial_number, purchased_at, expires_at, note, created_by)
  values (v_id, v_customer, v_customer_name, v_item, v_item_row.name, v_item_row.barcode,
    p_warranty->>'source', v_sale, v_line, coalesce(p_warranty->>'saleNumber', ''),
    v_serial, coalesce(v_serial_row.serial_number, ''), v_purchased, v_expires,
    coalesce(p_warranty->>'note', ''), auth.uid());
  return v_id;
end;
$$;

create or replace function public.save_warranty_case(p_case jsonb)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  v_id uuid := (p_case->>'id')::uuid;
  v_warranty public.warranties%rowtype;
  v_old public.warranty_cases%rowtype;
  v_status text := coalesce(p_case->>'status', 'pending');
  v_issue text := trim(coalesce(p_case->>'issue', ''));
  v_handled date := nullif(p_case->>'handledAt', '')::date;
begin
  if not app_private.is_active_staff() then raise exception '帳號權限不足'; end if;
  if v_id is null or v_issue = '' or v_status not in ('pending','in_progress','completed','not_covered') then
    raise exception '送修資料無效';
  end if;
  select * into v_warranty from public.warranties where id = (p_case->>'warrantyId')::uuid;
  if not found then raise exception '原保固不存在'; end if;
  select * into v_old from public.warranty_cases where id = v_id for update;
  if found then
    if v_old.warranty_id <> v_warranty.id then raise exception '送修案件不可改變原保固'; end if;
    update public.warranty_cases set issue = v_issue, status = v_status, handled_at = v_handled,
      resolution_note = coalesce(p_case->>'resolutionNote', '') where id = v_id;
  else
    insert into public.warranty_cases (id, warranty_id, issue, status, handled_at, resolution_note,
      item_name, purchased_at, expires_at, created_by)
    values (v_id, v_warranty.id, v_issue, v_status, v_handled, coalesce(p_case->>'resolutionNote', ''),
      v_warranty.item_name, v_warranty.purchased_at, v_warranty.expires_at, auth.uid());
  end if;
  return v_id;
end;
$$;

create or replace function public.delete_warranty_case(p_case_id uuid)
returns uuid language plpgsql security invoker set search_path = '' as $$
begin
  if not app_private.is_admin() then raise exception '管理員權限不足'; end if;
  delete from public.warranty_cases where id = p_case_id;
  if not found then raise exception '送修案件不存在'; end if;
  return p_case_id;
end;
$$;

create or replace function public.delete_warranty(p_warranty_id uuid)
returns uuid language plpgsql security invoker set search_path = '' as $$
begin
  if not app_private.is_admin() then raise exception '管理員權限不足'; end if;
  if exists (select 1 from public.inventory_transactions where warranty_id = p_warranty_id) then
    raise exception '已有出保固紀錄，不可刪除原保固';
  end if;
  delete from public.warranties where id = p_warranty_id;
  if not found then raise exception '保固不存在'; end if;
  return p_warranty_id;
end;
$$;

create or replace function app_private.create_sale_with_serials(p_lines jsonb, p_customer_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_sale_id uuid := gen_random_uuid();
  v_sale_number text := 'S' || to_char(now(), 'YYYYMMDDHH24MISSMS') || '-' || substr(replace(v_sale_id::text, '-', ''), 1, 6);
  v_line jsonb;
  v_item public.items%rowtype;
  v_line_id uuid;
  v_serial_id uuid;
  v_serial public.inventory_serials%rowtype;
  v_serial_ids jsonb;
  v_customer_name text;
  v_quantity integer;
  v_total numeric(12,2) := 0;
  v_now timestamptz := now();
  v_purchased_at date := (now() at time zone 'Asia/Taipei')::date;
begin
  if not app_private.is_active_staff() then raise exception '帳號權限不足'; end if;
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then raise exception '銷售品項不可空白'; end if;
  if p_customer_id is not null then
    select name into v_customer_name from public.customers where id = p_customer_id and active;
    if not found then raise exception '銷售客戶不存在或已停用'; end if;
  end if;
  insert into public.sales (id, sale_number, total, customer_id, created_by)
    values (v_sale_id, v_sale_number, 0, p_customer_id, auth.uid());
  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_quantity := (v_line->>'quantity')::integer;
    if v_quantity is null or v_quantity <= 0 then raise exception '銷售數量無效'; end if;
    select * into v_item from public.items where id = (v_line->>'item_id')::uuid for update;
    if not found or v_item.stock < v_quantity then raise exception '品項不存在或庫存不足'; end if;
    v_serial_ids := coalesce(v_line->'serial_ids', '[]'::jsonb);
    if jsonb_typeof(v_serial_ids) <> 'array' then raise exception '銷售序號格式無效'; end if;
    if v_item.category in ('機車','電池') then
      if p_customer_id is null or jsonb_array_length(v_serial_ids) <> v_quantity then raise exception '序號銷售須指定客戶與足量序號'; end if;
      if (select count(*) from public.inventory_serials where item_id = v_item.id and status = 'in_stock') <> v_item.stock then
        raise exception '在庫序號尚未補齊';
      end if;
    elsif jsonb_array_length(v_serial_ids) <> 0 then raise exception '非序號品項不可指定序號'; end if;
    update public.items set stock = stock - v_quantity where id = v_item.id;
    insert into public.sale_lines (sale_id, item_id, item_name, barcode, quantity, unit_price, subtotal)
      values (v_sale_id, v_item.id, v_item.name, v_item.barcode, v_quantity, v_item.price, v_item.price * v_quantity)
      returning id into v_line_id;
    for v_serial_id in select value::text::uuid from jsonb_array_elements_text(v_serial_ids) loop
      select * into v_serial from public.inventory_serials where id = v_serial_id for update;
      if not found or v_serial.item_id <> v_item.id or v_serial.status <> 'in_stock' then
        raise exception '銷售序號不可用或與品項不符';
      end if;
      update public.inventory_serials set status = 'sold', sale_id = v_sale_id, sale_line_id = v_line_id,
        customer_id = p_customer_id, sold_at = v_now where id = v_serial_id;
      if v_item.warranty_months > 0 then
        insert into public.warranties (customer_id, customer_name, item_id, item_name, barcode, source,
          sale_id, sale_line_id, sale_number, serial_id, serial_number, purchased_at, expires_at, created_by)
        values (p_customer_id, v_customer_name, v_item.id, v_item.name, v_item.barcode, 'sale',
          v_sale_id, v_line_id, v_sale_number, v_serial.id, v_serial.serial_number, v_purchased_at,
          (v_purchased_at + make_interval(months => v_item.warranty_months))::date, auth.uid());
      end if;
    end loop;
    if p_customer_id is not null and v_item.warranty_months > 0 and v_item.category not in ('機車','電池') then
      insert into public.warranties (customer_id, customer_name, item_id, item_name, barcode, source,
        sale_id, sale_line_id, sale_number, purchased_at, expires_at, created_by)
      values (p_customer_id, v_customer_name, v_item.id, v_item.name, v_item.barcode, 'sale',
        v_sale_id, v_line_id, v_sale_number, v_purchased_at,
        (v_purchased_at + make_interval(months => v_item.warranty_months))::date, auth.uid());
    end if;
    insert into public.inventory_transactions (item_id, type, quantity, note, created_by)
      values (v_item.id, 'out', v_quantity, '銷售管理 ' || v_sale_number, auth.uid());
    v_total := v_total + v_item.price * v_quantity;
  end loop;
  update public.sales set total = v_total where id = v_sale_id;
  return v_sale_id;
end;
$$;

create or replace function public.create_sale_with_serials(p_lines jsonb, p_customer_id uuid)
returns uuid language sql security invoker set search_path = '' as $$
  select app_private.create_sale_with_serials(p_lines, p_customer_id)
$$;

create or replace function app_private.issue_warranty_replacement(p_item_id uuid, p_quantity integer,
  p_warranty_id uuid, p_serial_ids uuid[], p_note text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_item public.items%rowtype;
  v_warranty public.warranties%rowtype;
  v_serial public.inventory_serials%rowtype;
  v_serial_id uuid;
  v_numbers text[] := '{}';
  v_now timestamptz := now();
  v_id uuid := gen_random_uuid();
  v_cost numeric(12,2);
begin
  if not app_private.is_active_staff() then raise exception '帳號權限不足'; end if;
  if p_quantity is null or p_quantity <= 0 or nullif(trim(p_note), '') is null then raise exception '出保固數量或原因無效'; end if;
  select * into v_warranty from public.warranties where id = p_warranty_id;
  if not found then raise exception '原保固不存在'; end if;
  select * into v_item from public.items where id = p_item_id for update;
  if not found or v_item.stock < p_quantity then raise exception '品項不存在或庫存不足'; end if;
  if v_item.category in ('機車','電池') then
    if coalesce(array_length(p_serial_ids, 1), 0) <> p_quantity or
      (select count(*) from public.inventory_serials where item_id = p_item_id and status = 'in_stock') <> v_item.stock then
      raise exception '出保固序號數量或在庫狀態不符';
    end if;
  elsif coalesce(array_length(p_serial_ids, 1), 0) <> 0 then raise exception '非序號品項不可指定序號'; end if;
  foreach v_serial_id in array coalesce(p_serial_ids, '{}'::uuid[]) loop
    select * into v_serial from public.inventory_serials where id = v_serial_id for update;
    if not found or v_serial.item_id <> p_item_id or v_serial.status <> 'in_stock' then
      raise exception '出保固序號不可用或與品項不符';
    end if;
    v_numbers := array_append(v_numbers, v_serial.serial_number);
    update public.inventory_serials set status = 'warranty_out', warranty_id = p_warranty_id,
      customer_id = v_warranty.customer_id, removed_at = v_now, removed_by = auth.uid(),
      removal_reason = trim(p_note) where id = v_serial_id;
  end loop;
  select cost into v_cost from public.item_costs where item_id = p_item_id;
  update public.items set stock = stock - p_quantity where id = p_item_id;
  insert into public.inventory_transactions (id, item_id, type, quantity, note, warranty_id, customer_id,
    item_name, expires_at, unit_cost_snapshot, serial_ids, serial_numbers, created_by, created_at)
  values (v_id, p_item_id, 'out', p_quantity, trim(p_note), p_warranty_id, v_warranty.customer_id,
    v_item.name, v_warranty.expires_at, coalesce(v_cost, 0), coalesce(p_serial_ids, '{}'::uuid[]), v_numbers,
    auth.uid(), v_now);
  return v_id;
end;
$$;

create or replace function public.issue_warranty_replacement(p_item_id uuid, p_quantity integer,
  p_warranty_id uuid, p_serial_ids uuid[], p_note text)
returns uuid language sql security invoker set search_path = '' as $$
  select app_private.issue_warranty_replacement(p_item_id, p_quantity, p_warranty_id, p_serial_ids, p_note)
$$;

revoke all on function public.save_warranty(jsonb), public.save_warranty_case(jsonb),
  public.delete_warranty_case(uuid), public.delete_warranty(uuid),
  app_private.create_sale_with_serials(jsonb,uuid), public.create_sale_with_serials(jsonb,uuid),
  app_private.issue_warranty_replacement(uuid,integer,uuid,uuid[],text),
  public.issue_warranty_replacement(uuid,integer,uuid,uuid[],text) from public, anon;
grant execute on function public.save_warranty(jsonb), public.save_warranty_case(jsonb),
  public.delete_warranty_case(uuid), public.delete_warranty(uuid),
  app_private.create_sale_with_serials(jsonb,uuid), public.create_sale_with_serials(jsonb,uuid),
  app_private.issue_warranty_replacement(uuid,integer,uuid,uuid[],text),
  public.issue_warranty_replacement(uuid,integer,uuid,uuid[],text) to authenticated;
