-- 結帳冪等（idempotent checkout）
-- 前端每次結帳產生一個 checkout id，直接當作 sales.id 使用。
-- 若同一個 checkout id 重送（例如雲端已完成、但回應途中網路中斷，使用者再按一次結帳），
-- 伺服器直接回傳既有銷售單，不會再扣一次庫存，也不會再建立保固或業務歸屬。

-- 1. 原銷售主體改為可指定銷售單 ID；內容與 20261015010849 相同，只多了 p_sale_id。
create or replace function app_private.create_sale_with_serials(p_lines jsonb, p_customer_id uuid, p_sale_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_sale_id uuid := coalesce(p_sale_id, gen_random_uuid());
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

-- 舊的兩參數版本保留原行為（隨機 ID），供既有的 logged(jsonb,uuid) 呼叫。
create or replace function app_private.create_sale_with_serials(p_lines jsonb, p_customer_id uuid)
returns uuid language sql security invoker set search_path = '' as $$
  select app_private.create_sale_with_serials(p_lines, p_customer_id, null::uuid)
$$;

-- 2. 帶 checkout id 的結帳入口：先鎖住這個 checkout id，再檢查是否已經建立過。
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

create or replace function public.create_sale_with_serials(
  p_lines jsonb, p_customer_id uuid, p_salesperson_id uuid, p_checkout_id uuid)
returns uuid language sql security invoker set search_path = '' as $$
  select app_private.create_sale_with_serials_logged(p_lines, p_customer_id, p_salesperson_id, p_checkout_id)
$$;

revoke all on function app_private.create_sale_with_serials(jsonb,uuid,uuid),
  app_private.create_sale_with_serials(jsonb,uuid)
  from public, anon, authenticated;
revoke all on function app_private.create_sale_with_serials_logged(jsonb,uuid,uuid,uuid),
  public.create_sale_with_serials(jsonb,uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function app_private.create_sale_with_serials_logged(jsonb,uuid,uuid,uuid),
  public.create_sale_with_serials(jsonb,uuid,uuid,uuid) to authenticated;
