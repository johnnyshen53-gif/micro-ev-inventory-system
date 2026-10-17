create or replace function app_private.create_sale(p_lines jsonb)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_sale_id uuid := gen_random_uuid();
  v_sale_number text := 'S' || to_char(now(), 'YYYYMMDDHH24MISSMS') || '-' || substr(replace(v_sale_id::text, '-', ''), 1, 6);
  v_line jsonb;
  v_item public.items%rowtype;
  v_quantity integer;
  v_total numeric(12,2) := 0;
begin
  if not app_private.is_active_staff() then raise exception '帳號已停用或沒有權限'; end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception '銷售品項不可空白'; end if;
  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_quantity := (v_line ->> 'quantity')::integer;
    if v_quantity is null or v_quantity <= 0 then raise exception '銷售數量必須大於零'; end if;
    select * into v_item from public.items where id = (v_line ->> 'item_id')::uuid for update;
    if not found then raise exception '找不到品項'; end if;
    if v_item.stock < v_quantity then raise exception '庫存不足：%', v_item.name; end if;
    update public.items set stock = stock - v_quantity where id = v_item.id;
    insert into public.sale_lines (sale_id, item_id, item_name, barcode, quantity, unit_price, subtotal)
      values (v_sale_id, v_item.id, v_item.name, v_item.barcode, v_quantity, v_item.price, v_item.price * v_quantity);
    insert into public.inventory_transactions (item_id, type, quantity, note, created_by)
      values (v_item.id, 'out', v_quantity, '銷售管理 ' || v_sale_number, auth.uid());
    v_total := v_total + v_item.price * v_quantity;
  end loop;
  insert into public.sales (id, sale_number, total, created_by) values (v_sale_id, v_sale_number, v_total, auth.uid());
  insert into public.audit_logs (actor_id, action, target_type, target_id, summary)
    values (auth.uid(), 'sale_created', 'sale', v_sale_id, jsonb_build_object('sale_number', v_sale_number, 'total', v_total));
  return v_sale_id;
end;
$$;

create or replace function public.create_sale(p_lines jsonb)
returns uuid language sql security invoker set search_path = public, app_private as $$
  select app_private.create_sale(p_lines)
$$;
revoke all on function app_private.create_sale(jsonb) from public, anon;
grant execute on function app_private.create_sale(jsonb) to authenticated;
revoke all on function public.create_sale(jsonb) from public, anon;
grant execute on function public.create_sale(jsonb) to authenticated;
