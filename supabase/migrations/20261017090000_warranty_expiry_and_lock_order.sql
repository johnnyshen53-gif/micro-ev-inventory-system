-- 後續強化
-- 1. 出保固換貨：原保固已過期時，店員不可出保固，只有店長可放行（原因自動加註「[過期保固放行]」）。
-- 2. 結帳：先依 ID 排序鎖定品項與序號，避免多台同時結帳時互相卡死。

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
  v_expired boolean;
  v_note text;
begin
  if not app_private.is_active_staff() then raise exception '帳號權限不足'; end if;
  if p_quantity is null or p_quantity <= 0 or nullif(trim(p_note), '') is null then raise exception '出保固數量或原因無效'; end if;
  select * into v_warranty from public.warranties where id = p_warranty_id;
  if not found then raise exception '原保固不存在'; end if;
  -- 原保固已過期：店員不可出保固；店長可放行，並在原因前加註記，方便日後查核。
  v_expired := v_warranty.expires_at < (now() at time zone 'Asia/Taipei')::date;
  if v_expired and not app_private.is_admin() then
    raise exception '原保固已於 % 到期，僅店長可放行出保固', v_warranty.expires_at using errcode = '42501';
  end if;
  v_note := trim(p_note);
  if v_expired and left(v_note, 8) <> '[過期保固放行]' then v_note := '[過期保固放行] ' || v_note; end if;
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
      removal_reason = v_note where id = v_serial_id;
  end loop;
  select cost into v_cost from public.item_costs where item_id = p_item_id;
  update public.items set stock = stock - p_quantity where id = p_item_id;
  insert into public.inventory_transactions (id, item_id, type, quantity, note, warranty_id, customer_id,
    item_name, expires_at, unit_cost_snapshot, serial_ids, serial_numbers, created_by, created_at)
  values (v_id, p_item_id, 'out', p_quantity, v_note, p_warranty_id, v_warranty.customer_id,
    v_item.name, v_warranty.expires_at, coalesce(v_cost, 0), coalesce(p_serial_ids, '{}'::uuid[]), v_numbers,
    auth.uid(), v_now);
  return v_id;
end;
$$;

create or replace function app_private.lock_sale_rows(p_lines jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then return; end if;
  -- ORDER BY 搭配 FOR UPDATE：資料列會依 ID 順序逐一上鎖。
  perform 1 from public.items
    where id in (
      select (line ->> 'item_id')::uuid from jsonb_array_elements(p_lines) as line
      where jsonb_typeof(line) = 'object' and line ? 'item_id')
    order by id for update;
  perform 1 from public.inventory_serials
    where id in (
      select serial_id::uuid
      from jsonb_array_elements(p_lines) as line,
        jsonb_array_elements_text(case when jsonb_typeof(line -> 'serial_ids') = 'array' then line -> 'serial_ids' else '[]'::jsonb end) as serial_id
      where jsonb_typeof(line) = 'object')
    order by id for update;
end;
$$;
revoke all on function app_private.lock_sale_rows(jsonb) from public, anon, authenticated;

create or replace function app_private.create_sale_with_serials_logged(
  p_lines jsonb, p_customer_id uuid, p_salesperson_id uuid, p_checkout_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_name text;
  v_sale_id uuid;
  v_existing_by uuid;
begin
  if not app_private.is_active_staff() then raise exception '帳號權限不足' using errcode = '42501'; end if;
  if p_checkout_id is null then raise exception '結帳識別碼不可空白'; end if;
  -- 交易層級的 advisory lock：同一個 checkout id 同時送兩次時，第二次會等第一次結束後才往下檢查。
  perform pg_advisory_xact_lock(hashtextextended('sale_checkout:' || p_checkout_id::text, 0));
  select created_by into v_existing_by from public.sales where id = p_checkout_id;
  if found then
    if v_existing_by is distinct from auth.uid() then
      raise exception '結帳識別碼已被使用' using errcode = '23505';
    end if;
    return p_checkout_id;
  end if;
  if p_salesperson_id is null then raise exception '結帳時請選擇業務員'; end if;
  select name into v_name from public.salespeople
    where id = p_salesperson_id and active for share;
  if not found then raise exception '業務員不存在或已停用，請重新選擇'; end if;
  -- 先依 ID 排序鎖住所有品項與序號，多台同時結帳時鎖定順序一致，不會互相卡死（deadlock）。
  perform app_private.lock_sale_rows(p_lines);
  v_sale_id := app_private.create_sale_with_serials(p_lines, p_customer_id, p_checkout_id);
  insert into public.audit_logs (actor_id, action, target_type, target_id, summary)
    select auth.uid(), 'sale_created', 'sale', v_sale_id,
      jsonb_build_object('sale_number', sale_number, 'total', total)
    from public.sales where id = v_sale_id;
  insert into app_private.sale_salesperson_attributions(sale_id, salesperson_id, salesperson_name)
    values (v_sale_id, p_salesperson_id, v_name);
  return v_sale_id;
end;
$$;
