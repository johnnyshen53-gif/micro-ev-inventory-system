-- 品項單位（個、組、支…）：選填，空字串＝沒有設定，最多 10 個字。
alter table public.items add column unit text not null default '' check (char_length(unit) <= 10);

-- 新增車身／電池（連同序號一起建立）時，也一併存入單位。
create or replace function public.create_serialized_item(p_item jsonb, p_cost numeric, p_serials jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_id uuid := (p_item->>'id')::uuid;
  v_stock integer := (p_item->>'stock')::integer;
begin
  if not app_private.is_admin() then raise exception '管理員權限不足' using errcode = '42501'; end if;
  if v_id is null or p_item->>'category' not in ('車身', '電池') or v_stock is null or v_stock < 1
    or p_serials is null or jsonb_typeof(p_serials) <> 'array' or jsonb_array_length(p_serials) < 1
    or jsonb_array_length(p_serials) > v_stock then  -- 序號選填：可以只登錄一部分，不可超過庫存
    raise exception '品項與原廠序號數量不相符';
  end if;
  insert into public.items (id, name, category, sku, barcode, price, stock, minimum_stock,
    warranty_months, notes, supplier_id, price_locked, vehicle_model_id, special_price, member_price, unit, created_by)
  values (v_id, p_item->>'name', p_item->>'category', coalesce(p_item->>'sku', ''),
    coalesce(p_item->>'barcode', ''), (p_item->>'price')::numeric, v_stock,
    (p_item->>'minimum_stock')::integer, coalesce((p_item->>'warranty_months')::integer, 0),
    coalesce(p_item->>'notes', ''), nullif(p_item->>'supplier_id', '')::uuid,
    coalesce((p_item->>'price_locked')::boolean, false), nullif(p_item->>'vehicle_model_id', '')::uuid,
    nullif(p_item->>'special_price', '')::numeric, nullif(p_item->>'member_price', '')::numeric,
    coalesce(btrim(p_item->>'unit'), ''), auth.uid());
  insert into public.item_costs (item_id, cost, staff_price, updated_by)
    values (v_id, p_cost, nullif(p_item->>'staff_price', '')::numeric, auth.uid());
  perform public.register_inventory_serials(v_id, p_serials);
  return v_id;
end;
$function$;
