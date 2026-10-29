-- 車種：每個品項指定一個車種（新品項必填），店長在「庫存操作」頁維護車種清單。
--
-- 1. public.vehicle_models：車種清單。內建一筆「通用」（全部車款都能用的電池、零件選它），
--    「通用」不能改名或停用。車種不提供刪除，不再使用就「停用」，舊品項的車種仍保留可查。
--    店員只能讀，店長可以新增、改名、停用／啟用。
-- 2. public.items.vehicle_model_id：品項的車種。舊品項先留空（畫面顯示「未設定」），
--    店長下次編輯該品項時，網頁會要求補選。
-- 3. 觸發器 app_private.check_item_vehicle_model：
--    ‧網站（authenticated 角色）新增品項一定要選車種，而且必須是啟用中的車種。
--    ‧已設定的車種不能清空；改成別的車種時，新車種必須啟用中。
--    ‧只改庫存、售價等其他欄位時不檢查，舊品項照常銷售、進貨、收貨。
--    ‧資料庫管理者直接操作（維運腳本、測試資料）不受「新增必填」限制。
-- 4. create_serialized_item：新增車身／電池（含序號）時一併存車種。

create table public.vehicle_models (
  id uuid primary key default gen_random_uuid(),
  name text not null check (name = btrim(name) and char_length(name) between 1 and 30),
  is_universal boolean not null default false,
  active boolean not null default true,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- 名稱不分大小寫不可重複（避免「Vespa」「vespa」變成兩個車種）；「通用」只能有一筆。
create unique index vehicle_models_name_key on public.vehicle_models (lower(name));
create unique index vehicle_models_one_universal on public.vehicle_models (is_universal) where is_universal;

insert into public.vehicle_models (name, is_universal) values ('通用', true);

-- 保護「通用」：不能改名、停用或取消通用；也不能再新增第二筆通用（唯一索引之外再給清楚的訊息）。
create or replace function app_private.protect_vehicle_model()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.is_universal then raise exception '「通用」車種已存在，不能再新增'; end if;
  elsif old.is_universal and (new.name <> old.name or not new.active or not new.is_universal) then
    raise exception '「通用」車種不能改名或停用';
  elsif new.is_universal and not old.is_universal then
    raise exception '不能把其他車種改成「通用」';
  end if;
  new.updated_at := now();
  if tg_op = 'UPDATE' then new.created_by := old.created_by; end if;
  return new;
end;
$$;
create trigger vehicle_models_protect before insert or update on public.vehicle_models
  for each row execute function app_private.protect_vehicle_model();

alter table public.vehicle_models enable row level security;
revoke all on public.vehicle_models from public, anon, authenticated;
grant select, insert, update on public.vehicle_models to authenticated;
create policy "active staff read vehicle models" on public.vehicle_models
  for select to authenticated using ((select app_private.is_active_staff()));
create policy "admins add vehicle models" on public.vehicle_models
  for insert to authenticated with check ((select app_private.is_admin()));
create policy "admins update vehicle models" on public.vehicle_models
  for update to authenticated using ((select app_private.is_admin())) with check ((select app_private.is_admin()));

alter table public.items add column vehicle_model_id uuid references public.vehicle_models(id);
create index items_vehicle_model_id_idx on public.items (vehicle_model_id);

create or replace function app_private.check_item_vehicle_model()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.vehicle_model_id is null then
      -- 只有從網站（authenticated）新增時強制；資料庫管理者的維運腳本與測試資料不受限。
      if current_user = 'authenticated' then raise exception '請選擇車種'; end if;
      return new;
    end if;
  elsif new.vehicle_model_id is null then
    if old.vehicle_model_id is not null then raise exception '車種不可清空，請選擇車種'; end if;
    return new;
  elsif new.vehicle_model_id = old.vehicle_model_id then
    return new;
  end if;
  if not exists (select 1 from public.vehicle_models where id = new.vehicle_model_id and active) then
    raise exception '車種已停用或不存在，請重新選擇車種';
  end if;
  return new;
end;
$$;
create trigger items_vehicle_model_check before insert or update of vehicle_model_id on public.items
  for each row execute function app_private.check_item_vehicle_model();

revoke all on function app_private.protect_vehicle_model(), app_private.check_item_vehicle_model() from public, anon, authenticated;

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
    warranty_months, notes, supplier_id, price_locked, vehicle_model_id, created_by)
  values (v_id, p_item->>'name', p_item->>'category', coalesce(p_item->>'sku', ''),
    coalesce(p_item->>'barcode', ''), (p_item->>'price')::numeric, v_stock,
    (p_item->>'minimum_stock')::integer, coalesce((p_item->>'warranty_months')::integer, 0),
    coalesce(p_item->>'notes', ''), nullif(p_item->>'supplier_id', '')::uuid,
    coalesce((p_item->>'price_locked')::boolean, false), nullif(p_item->>'vehicle_model_id', '')::uuid, auth.uid());
  insert into public.item_costs (item_id, cost, updated_by) values (v_id, p_cost, auth.uid());
  perform public.register_inventory_serials(v_id, p_serials);
  return v_id;
end;
$function$
;
