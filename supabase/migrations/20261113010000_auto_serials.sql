-- 自動序號：車身、電池入庫時，沒填原廠序號的件數由系統編號（分類 2 碼＋入庫日期 8 碼＋流水號 4 碼，由程式產生後登錄）。
-- 序號選填後，賣出時沒選序號的那幾件序號仍是「在庫」，在庫序號數可能比庫存多；
-- 所以「入庫時登錄的序號」（p_stock_in_quantity＝這次入庫件數）只檢查不超過這次入庫的件數，
-- 「補登舊庫存的序號」（沒帶 p_stock_in_quantity）維持原本的檢查：在庫序號加這次登錄的不能超過庫存。
drop function public.register_inventory_serials(uuid, jsonb);
create function public.register_inventory_serials(p_item_id uuid, p_serials jsonb, p_stock_in_quantity integer default null)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_item public.items%rowtype;
  v_serial jsonb;
  v_count integer;
begin
  if not app_private.is_admin() then raise exception '管理員權限不足' using errcode = '42501'; end if;
  if p_serials is null or jsonb_typeof(p_serials) <> 'array' or jsonb_array_length(p_serials) = 0 then
    raise exception '請輸入原廠序號';
  end if;
  select * into v_item from public.items where id = p_item_id for update;
  if not found then raise exception '品項不存在'; end if;
  if v_item.category not in ('車身', '電池') then raise exception '此品項不使用原廠序號'; end if;
  if p_stock_in_quantity is not null then
    if p_stock_in_quantity < 1 or jsonb_array_length(p_serials) > p_stock_in_quantity or jsonb_array_length(p_serials) > v_item.stock then
      raise exception '原廠序號數量超過入庫數量';
    end if;
  else
    select count(*) into v_count from public.inventory_serials where item_id = p_item_id and status = 'in_stock';
    if v_count + jsonb_array_length(p_serials) > v_item.stock then raise exception '原廠序號數量超過現有庫存'; end if;
  end if;
  for v_serial in select value from jsonb_array_elements(p_serials) loop
    if jsonb_typeof(v_serial) <> 'object' or nullif(trim(v_serial->>'serialNumber'), '') is null
      or nullif(v_serial->>'id', '') is null then raise exception '原廠序號資料不完整'; end if;
    insert into public.inventory_serials (id, item_id, serial_number, status, created_by)
      values ((v_serial->>'id')::uuid, p_item_id, trim(v_serial->>'serialNumber'), 'in_stock', auth.uid());
  end loop;
  return jsonb_array_length(p_serials);
end;
$function$;
revoke all on function public.register_inventory_serials(uuid, jsonb, integer) from public, anon;
grant execute on function public.register_inventory_serials(uuid, jsonb, integer) to authenticated, service_role;
