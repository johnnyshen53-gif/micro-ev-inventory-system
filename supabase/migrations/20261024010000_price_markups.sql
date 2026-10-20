-- 售價加成：依品項分類設定加成百分比，進貨收貨時用「進貨單價 ×（1＋加成%）」自動帶出售價，
-- 無條件進位到 10 元。品項可勾「固定售價」，勾了就不會被自動重算（例如特價品）。
--
-- 1. items.price_locked：固定售價（預設不固定）。
-- 2. app_private.price_markups：五個分類各自的加成 %，沒有資料＝該分類不自動定價。
--    資料表不開放給 API，只能透過下面的店長專用函式讀寫。
-- 3. app_private.markup_price_for(分類, 成本)：算出售價；非店長或該分類未設定時回傳 null。
-- 4. 店長專用 RPC：get_price_markups()／save_price_markups(jsonb)。
-- 5. receive_purchase：收貨更新成本後，順便依加成重算售價（固定售價的品項跳過）。
-- 6. create_serialized_item：新增序號品項時一併存「固定售價」。

alter table public.items add column price_locked boolean not null default false;

create table app_private.price_markups (
  category text primary key check (category in ('車身', '電池', '電控元件', '機構元件', '外觀元件')),
  percent numeric(7,2) not null check (percent >= 0 and percent <= 1000),
  updated_by uuid,
  updated_at timestamptz not null default now()
);
alter table app_private.price_markups enable row level security;
revoke all on app_private.price_markups from public, anon, authenticated;

-- 售價＝成本 ×（1＋加成%），無條件進位到 10 元。numeric 是精確小數，不會有浮點誤差。
create or replace function app_private.markup_price_for(p_category text, p_cost numeric)
returns numeric language plpgsql stable security definer set search_path = '' as $$
declare v_percent numeric;
begin
  if not app_private.is_admin() or p_cost is null or p_cost < 0 then return null; end if;
  select percent into v_percent from app_private.price_markups where category = p_category;
  if not found then return null; end if;
  return ceil(p_cost * (1 + v_percent / 100) / 10) * 10;
end;
$$;

create or replace function app_private.get_price_markups()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not app_private.is_admin() then raise exception '只有店長可以查看售價加成' using errcode = '42501'; end if;
  return coalesce((select jsonb_object_agg(category, percent) from app_private.price_markups), '{}'::jsonb);
end;
$$;

-- p_markups：{"車身": 15, "電控元件": 35, ...}；值為 null 或沒列出的分類＝不自動定價。整批取代。
create or replace function app_private.save_price_markups(p_markups jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare v_key text; v_value jsonb;
begin
  if not app_private.is_admin() then raise exception '只有店長可以修改售價加成' using errcode = '42501'; end if;
  if jsonb_typeof(p_markups) is distinct from 'object' then raise exception '售價加成格式無效'; end if;
  for v_key, v_value in select key, value from jsonb_each(p_markups) loop
    if v_key not in ('車身', '電池', '電控元件', '機構元件', '外觀元件') then raise exception '未知的分類：%', v_key; end if;
    if jsonb_typeof(v_value) not in ('number', 'null') then raise exception '「%」的加成必須是數字', v_key; end if;
    if jsonb_typeof(v_value) = 'number' and ((v_value #>> '{}')::numeric < 0 or (v_value #>> '{}')::numeric > 1000) then
      raise exception '「%」的加成須介於 0～1000%%', v_key;
    end if;
  end loop;
  delete from app_private.price_markups where true;
  insert into app_private.price_markups(category, percent, updated_by)
    select key, round((value #>> '{}')::numeric, 2), auth.uid() from jsonb_each(p_markups) where jsonb_typeof(value) = 'number';
  insert into public.audit_logs(actor_id, action, target_type, target_id, summary)
    values (auth.uid(), 'pricing.markups_saved', 'price_markups', null, p_markups);
end;
$$;

create or replace function public.get_price_markups() returns jsonb
  language sql security invoker set search_path = '' as $$ select app_private.get_price_markups() $$;
create or replace function public.save_price_markups(p_markups jsonb) returns void
  language sql security invoker set search_path = '' as $$ select app_private.save_price_markups(p_markups) $$;

revoke all on function app_private.markup_price_for(text, numeric), app_private.get_price_markups(),
  app_private.save_price_markups(jsonb), public.get_price_markups(), public.save_price_markups(jsonb) from public, anon;
grant execute on function app_private.markup_price_for(text, numeric), app_private.get_price_markups(),
  app_private.save_price_markups(jsonb), public.get_price_markups(), public.save_price_markups(jsonb) to authenticated;

CREATE OR REPLACE FUNCTION public.receive_purchase(p_purchase_id uuid, p_serial_numbers_by_item jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_purchase public.purchases%rowtype;
  v_line public.purchase_lines%rowtype;
  v_item public.items%rowtype;
  v_numbers jsonb;
  v_number jsonb;
  v_count integer;
  v_now timestamptz := now();
begin
  if not app_private.is_admin() then raise exception '管理員權限不足'; end if;
  select * into v_purchase from public.purchases where id = p_purchase_id for update;
  if not found or v_purchase.status <> 'draft' then raise exception '進貨單不存在或已收貨'; end if;
  if jsonb_typeof(p_serial_numbers_by_item) is distinct from 'object' then raise exception '收貨序號格式無效'; end if;
  if exists (select 1 from jsonb_object_keys(p_serial_numbers_by_item) key
    where not exists (select 1 from public.purchase_lines where purchase_id = p_purchase_id and item_id::text = key)) then
    raise exception '收貨序號品項不在進貨單';
  end if;
  if not exists (select 1 from public.purchase_lines where purchase_id = p_purchase_id) then raise exception '進貨單沒有明細'; end if;
  for v_line in select * from public.purchase_lines where purchase_id = p_purchase_id order by item_id loop
    select * into v_item from public.items where id = v_line.item_id for update;
    if not found or v_item.supplier_id is distinct from v_purchase.supplier_id then raise exception '品項供應商已變更，請修改草稿'; end if;
    v_numbers := coalesce(p_serial_numbers_by_item->(v_item.id::text), '[]'::jsonb);
    if jsonb_typeof(v_numbers) is distinct from 'array' then raise exception '收貨序號格式無效'; end if;
    v_count := jsonb_array_length(v_numbers);
    if v_item.category in ('車身', '電池') then
      if v_count <> v_line.quantity then raise exception '收貨序號數量不符'; end if;
      if (select count(*) from public.inventory_serials where item_id = v_item.id and status = 'in_stock') <> v_item.stock then
        raise exception '在庫序號尚未補齊';
      end if;
    elsif v_count <> 0 then raise exception '非序號品項不可填寫序號'; end if;
    for v_number in select value from jsonb_array_elements(v_numbers) loop
      if jsonb_typeof(v_number) <> 'string' or nullif(trim(v_number #>> '{}'), '') is null then
        raise exception '原廠序號無效';
      end if;
    end loop;
  end loop;
  for v_line in select * from public.purchase_lines where purchase_id = p_purchase_id order by item_id loop
    update public.items set stock = stock + v_line.quantity where id = v_line.item_id;
    insert into public.item_costs (item_id, cost, updated_by) values (v_line.item_id, v_line.unit_cost, auth.uid())
      on conflict (item_id) do update set cost = excluded.cost, updated_by = excluded.updated_by, updated_at = v_now;
    -- 售價加成：該分類有設定加成、且品項沒有勾「固定售價」時，用這次進貨單價重算售價（無條件進位到 10 元）。
    update public.items i set price = app_private.markup_price_for(i.category, v_line.unit_cost)
      where i.id = v_line.item_id and not i.price_locked
        and app_private.markup_price_for(i.category, v_line.unit_cost) is not null;
    insert into public.inventory_transactions (item_id, type, quantity, note, purchase_id, created_by)
      values (v_line.item_id, 'in', v_line.quantity, '進貨收貨：' || v_purchase.purchase_number, p_purchase_id, auth.uid());
    for v_number in select value from jsonb_array_elements(coalesce(p_serial_numbers_by_item->(v_line.item_id::text), '[]'::jsonb)) loop
      insert into public.inventory_serials (item_id, serial_number, status, purchase_id, created_by)
      values (v_line.item_id, trim(v_number #>> '{}'), 'in_stock', p_purchase_id, auth.uid());
    end loop;
  end loop;
  update public.purchases set status = 'received', received_by = auth.uid(), received_at = v_now where id = p_purchase_id;
  return p_purchase_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.create_serialized_item(p_item jsonb, p_cost numeric, p_serials jsonb)
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
    or p_serials is null or jsonb_typeof(p_serials) <> 'array' or jsonb_array_length(p_serials) <> v_stock then
    raise exception '品項與原廠序號數量不相符';
  end if;
  insert into public.items (id, name, category, sku, barcode, price, stock, minimum_stock,
    warranty_months, notes, supplier_id, price_locked, created_by)
  values (v_id, p_item->>'name', p_item->>'category', coalesce(p_item->>'sku', ''),
    coalesce(p_item->>'barcode', ''), (p_item->>'price')::numeric, v_stock,
    (p_item->>'minimum_stock')::integer, coalesce((p_item->>'warranty_months')::integer, 0),
    coalesce(p_item->>'notes', ''), nullif(p_item->>'supplier_id', '')::uuid,
    coalesce((p_item->>'price_locked')::boolean, false), auth.uid());
  insert into public.item_costs (item_id, cost, updated_by) values (v_id, p_cost, auth.uid());
  perform public.register_inventory_serials(v_id, p_serials);
  return v_id;
end;
$function$
;
