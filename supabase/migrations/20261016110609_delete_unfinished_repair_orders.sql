create function app_private.delete_repair_order(p_order_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_order public.repair_orders%rowtype;
begin
  if not app_private.is_admin() then raise exception '只有店長可以刪除維修單' using errcode = '42501'; end if;
  select * into v_order from public.repair_orders where id=p_order_id for update;
  if not found then raise exception '維修單不存在'; end if;
  if v_order.status not in ('intake','quoted','cancelled') or v_order.payment_status <> 'unpaid'
    or exists (select 1 from public.inventory_transactions where repair_order_id=p_order_id)
    or exists (select 1 from public.inventory_serials where repair_order_id=p_order_id)
    or exists (select 1 from public.warranties where repair_order_id=p_order_id) then
    raise exception '已完工、已扣料或有保固的維修單不可刪除';
  end if;
  delete from public.repair_lines where repair_order_id=p_order_id;
  delete from public.repair_orders where id=p_order_id;
  return p_order_id;
end;
$$;

create function public.delete_repair_order(p_order_id uuid)
returns uuid language sql security invoker set search_path = '' as $$
  select app_private.delete_repair_order(p_order_id)
$$;

revoke all on function app_private.delete_repair_order(uuid),public.delete_repair_order(uuid) from public,anon,authenticated;
grant execute on function app_private.delete_repair_order(uuid),public.delete_repair_order(uuid) to authenticated;
