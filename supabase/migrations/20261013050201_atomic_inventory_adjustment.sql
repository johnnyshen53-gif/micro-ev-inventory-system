create or replace function public.adjust_inventory(p_item_id uuid, p_type text, p_quantity integer, p_note text default '')
returns public.items
language plpgsql security invoker set search_path = '' as $$
declare v_item public.items%rowtype; v_next integer;
begin
  if not app_private.is_admin() then raise exception '僅店長可調整庫存' using errcode = '42501'; end if;
  if p_type not in ('in', 'out', 'set') or p_quantity < 0 then raise exception '庫存異動資料無效'; end if;
  select * into v_item from public.items where id = p_item_id for update;
  if not found then raise exception '找不到品項'; end if;
  v_next := case when p_type = 'in' then v_item.stock + p_quantity when p_type = 'out' then v_item.stock - p_quantity else p_quantity end;
  if v_next < 0 then raise exception '庫存不足，無法出庫'; end if;
  update public.items set stock = v_next where id = p_item_id returning * into v_item;
  insert into public.inventory_transactions(item_id, type, quantity, note, created_by)
    values (p_item_id, p_type, p_quantity, coalesce(p_note, ''), auth.uid());
  return v_item;
end;
$$;
revoke all on function public.adjust_inventory(uuid, text, integer, text) from public, anon;
grant execute on function public.adjust_inventory(uuid, text, integer, text) to authenticated;
