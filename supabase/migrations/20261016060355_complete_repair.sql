alter table public.inventory_transactions
  add column repair_order_id uuid references public.repair_orders(id);
create index inventory_transactions_repair_order_idx on public.inventory_transactions(repair_order_id);

alter table public.inventory_serials drop constraint inventory_serials_status_check;
alter table public.inventory_serials
  add constraint inventory_serials_status_check check (status in ('in_stock','sold','removed','warranty_out','repair_used')),
  add column repair_order_id uuid references public.repair_orders(id),
  add column repair_line_id uuid references public.repair_lines(id),
  add column repair_used_at timestamptz;
create index inventory_serials_repair_order_idx on public.inventory_serials(repair_order_id);
create index inventory_serials_repair_line_idx on public.inventory_serials(repair_line_id);

alter table public.warranties drop constraint warranties_source_check;
alter table public.warranties drop constraint warranties_source_links_check;
alter table public.warranties
  add column repair_order_id uuid references public.repair_orders(id),
  add constraint warranties_source_check check (source in ('sale','manual','repair')),
  add constraint warranties_source_links_check check (
    (source='sale' and sale_id is not null and sale_line_id is not null and repair_order_id is null)
    or (source='manual' and repair_order_id is null and (sale_line_id is null or serial_id is not null))
    or (source='repair' and repair_order_id is not null and sale_id is null and sale_line_id is null and serial_id is not null)
  );
create index warranties_repair_order_idx on public.warranties(repair_order_id);

create function app_private.complete_repair_order(p_order_id uuid, p_serial_ids_by_line jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_order public.repair_orders%rowtype;
  v_line public.repair_lines%rowtype;
  v_item public.items%rowtype;
  v_serial public.inventory_serials%rowtype;
  v_serial_id uuid;
  v_serial_ids jsonb;
  v_serial_numbers text[];
  v_warranty_id uuid;
  v_today date := (now() at time zone 'Asia/Taipei')::date;
begin
  if not app_private.is_active_staff() then raise exception '帳號權限不足' using errcode='42501'; end if;
  if jsonb_typeof(p_serial_ids_by_line) is distinct from 'object' then raise exception '維修序號格式無效'; end if;
  select * into v_order from public.repair_orders where id=p_order_id for update;
  if not found or v_order.status <> 'quoted' then raise exception '維修單未報價或已完工'; end if;
  if exists (select 1 from jsonb_object_keys(p_serial_ids_by_line) as k(key)
    where not exists (select 1 from public.repair_lines where id=k.key::uuid and repair_order_id=p_order_id)) then
    raise exception '維修序號行項不符';
  end if;
  for v_line in select * from public.repair_lines where repair_order_id=p_order_id order by item_id,id loop
    select * into v_item from public.items where id=v_line.item_id for update;
    if not found or v_item.category not in ('零件','用品','電池') or v_item.stock < v_line.quantity then raise exception '品項不適用或庫存不足'; end if;
    v_serial_ids := coalesce(p_serial_ids_by_line->(v_line.id::text),'[]'::jsonb);
    if jsonb_typeof(v_serial_ids) <> 'array' then raise exception '維修序號格式無效'; end if;
    v_serial_numbers := '{}';
    if v_item.category='電池' then
      if v_order.customer_id is null then raise exception '電池維修須選擇既有會員'; end if;
      if not exists (select 1 from public.customers where id=v_order.customer_id and active) then raise exception '維修會員已停用'; end if;
      if v_item.warranty_months <= 0 then raise exception '電池品項須設定保固月數'; end if;
      if jsonb_array_length(v_serial_ids) <> v_line.quantity then raise exception '電池序號數量不符'; end if;
      if (select count(*) from public.inventory_serials where item_id=v_item.id and status='in_stock') <> v_item.stock then
        raise exception '在庫序號尚未補齊'; end if;
    elsif jsonb_array_length(v_serial_ids) <> 0 then
      raise exception '非電池品項不可指定序號';
    end if;
    for v_serial_id in select value::text::uuid from jsonb_array_elements_text(v_serial_ids) order by value::text::uuid loop
      select * into v_serial from public.inventory_serials where id=v_serial_id for update;
      if not found or v_serial.item_id <> v_item.id or v_serial.status <> 'in_stock' then
        raise exception '維修序號不可用或與品項不符'; end if;
      insert into public.warranties(customer_id,customer_name,item_id,item_name,barcode,source,
        serial_id,serial_number,repair_order_id,purchased_at,expires_at,created_by)
      values(v_order.customer_id,v_order.customer_name,v_item.id,v_item.name,v_item.barcode,'repair',
        v_serial.id,v_serial.serial_number,p_order_id,v_today,
        (v_today + make_interval(months=>v_item.warranty_months))::date,auth.uid())
      returning id into v_warranty_id;
      update public.inventory_serials set status='repair_used',repair_order_id=p_order_id,
        repair_line_id=v_line.id,customer_id=v_order.customer_id,warranty_id=v_warranty_id,
        repair_used_at=clock_timestamp() where id=v_serial_id;
      v_serial_numbers := array_append(v_serial_numbers,v_serial.serial_number);
    end loop;
    update public.items set stock=stock-v_line.quantity where id=v_item.id;
    insert into public.inventory_transactions(item_id,type,quantity,note,created_by,
      repair_order_id,customer_id,item_name,serial_numbers,serial_ids)
    values(v_item.id,'out',v_line.quantity,'維修單 ' || v_order.repair_number,auth.uid(),
      p_order_id,v_order.customer_id,v_item.name,v_serial_numbers,
      array(select value::text::uuid from jsonb_array_elements_text(v_serial_ids)));
  end loop;
  update public.repair_orders set status='completed',completed_at=clock_timestamp(),completed_by=auth.uid(),
    updated_at=clock_timestamp(),updated_by=auth.uid() where id=p_order_id;
  return p_order_id;
end;
$$;

create function public.complete_repair_order(p_order_id uuid, p_serial_ids_by_line jsonb)
returns uuid language sql security invoker set search_path='' as $$
  select app_private.complete_repair_order(p_order_id,p_serial_ids_by_line)
$$;
revoke all on function app_private.complete_repair_order(uuid,jsonb),public.complete_repair_order(uuid,jsonb)
  from public,anon,authenticated;
grant execute on function app_private.complete_repair_order(uuid,jsonb),public.complete_repair_order(uuid,jsonb)
  to authenticated;
