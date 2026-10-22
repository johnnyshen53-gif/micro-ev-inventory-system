-- 官網車款頁：店長在庫存系統勾選「顯示在官網」，官網 voltbuddys.com 自動列出。
--
-- 範圍：只有「車身」「電池」兩個分類可以上官網（車身單價含配件、電池另購）。
-- item_web：每個品項一列官網設定（是否顯示、續航、最高時速、電池規格、簡介、照片路徑）。
--   和 items 分開放：官網設定不影響庫存、銷售與快照比對，刪除品項時一併刪除。
-- website-photos：公開讀取的照片空間（Supabase Storage），只有店長能上傳、替換、刪除。
-- get_public_items()：未登入訪客（官網）讀取「已勾選顯示」的品項；不含價格、成本、庫存、料號、id。

create table public.item_web (
  item_id uuid primary key references public.items(id) on delete cascade,
  visible boolean not null default false,
  range_km integer check (range_km between 1 and 999),
  top_speed integer check (top_speed between 1 and 99),
  battery_spec text not null default '' check (length(battery_spec) <= 60),
  summary text not null default '' check (length(summary) <= 300),
  -- 照片在 website-photos 裡的路徑：「品項 id／檔名」，例如 1f…/1730000000000.webp
  photo_path text check (photo_path ~ '^[0-9a-f-]{36}/[A-Za-z0-9._-]{1,80}$' and split_part(photo_path, '/', 1) = item_id::text),
  updated_by uuid references public.profiles(id) default auth.uid(),
  updated_at timestamptz not null default now()
);

alter table public.item_web enable row level security;
create policy "admins read item web" on public.item_web
  for select to authenticated using ((select app_private.is_admin()));
revoke all on public.item_web from anon, authenticated;
grant select on public.item_web to authenticated;

-- 儲存某品項的官網設定（沒有就新增，有就整筆取代）。
-- p_web：{ itemId, visible, rangeKm, topSpeed, batterySpec, summary, photoPath }；數字欄位留空＝不顯示。
create or replace function app_private.save_item_web(p_web jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_item_id uuid := nullif(p_web->>'itemId', '')::uuid;
  v_category text;
  v_name text;
  v_visible boolean := coalesce((p_web->>'visible')::boolean, false);
  v_range integer := nullif(p_web->>'rangeKm', '')::integer;
  v_speed integer := nullif(p_web->>'topSpeed', '')::integer;
  v_battery text := trim(coalesce(p_web->>'batterySpec', ''));
  v_summary text := trim(coalesce(p_web->>'summary', ''));
  v_photo text := nullif(trim(coalesce(p_web->>'photoPath', '')), '');
begin
  if not app_private.is_admin() then raise exception '只有店長可以設定官網商品' using errcode = '42501'; end if;
  select category, name into v_category, v_name from public.items where id = v_item_id;
  if not found then raise exception '品項不存在'; end if;
  if v_category not in ('車身', '電池') then raise exception '只有車身、電池可以顯示在官網'; end if;
  if v_range is not null and (v_range < 1 or v_range > 999) then raise exception '續航請填 1～999 公里，或留空'; end if;
  if v_speed is not null and (v_speed < 1 or v_speed > 99) then raise exception '最高時速請填 1～99 公里，或留空'; end if;
  if length(v_battery) > 60 then raise exception '電池規格最多 60 字'; end if;
  if length(v_summary) > 300 then raise exception '簡介最多 300 字'; end if;
  if v_photo is not null and (v_photo !~ '^[0-9a-f-]{36}/[A-Za-z0-9._-]{1,80}$' or split_part(v_photo, '/', 1) <> v_item_id::text) then
    raise exception '照片路徑不正確';
  end if;

  insert into public.item_web (item_id, visible, range_km, top_speed, battery_spec, summary, photo_path, updated_by, updated_at)
    values (v_item_id, v_visible, v_range, v_speed, v_battery, v_summary, v_photo, auth.uid(), now())
  on conflict (item_id) do update set visible = excluded.visible, range_km = excluded.range_km, top_speed = excluded.top_speed,
    battery_spec = excluded.battery_spec, summary = excluded.summary, photo_path = excluded.photo_path,
    updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  insert into public.audit_logs (actor_id, action, target_type, target_id, summary)
    values (auth.uid(), 'item_web.saved', 'item', v_item_id, jsonb_build_object('name', v_name, 'visible', v_visible,
      'range_km', v_range, 'top_speed', v_speed, 'battery_spec', v_battery, 'summary', v_summary, 'photo_path', v_photo));
end;
$$;

create or replace function public.save_item_web(p_web jsonb) returns void
  language sql security invoker set search_path = '' as $$ select app_private.save_item_web(p_web) $$;
revoke all on function app_private.save_item_web(jsonb), public.save_item_web(jsonb) from public, anon;
grant execute on function app_private.save_item_web(jsonb), public.save_item_web(jsonb) to authenticated;

-- 官網讀取：只回傳已勾選顯示的車身／電池；不含價格（官網顯示「歡迎洽詢」）。
create or replace function public.get_public_items()
returns table (
  name text,
  category text,
  range_km integer,
  top_speed integer,
  battery_spec text,
  summary text,
  photo_path text
)
language sql stable security definer set search_path = '' as $$
  select i.name, i.category, w.range_km, w.top_speed, w.battery_spec, w.summary, w.photo_path
  from public.item_web w
  join public.items i on i.id = w.item_id
  where w.visible and i.category in ('車身', '電池')
  order by case i.category when '車身' then 0 else 1 end, i.name
  limit 200
$$;
revoke all on function public.get_public_items() from public;
grant execute on function public.get_public_items() to anon, authenticated;

-- 照片空間：公開讀取（官網用網址直接顯示），單檔 2 MB 以內，只收 webp／jpeg／png。
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('website-photos', 'website-photos', true, 2097152, array['image/webp', 'image/jpeg', 'image/png'])
  on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- 只有店長能上傳／替換／刪除。公開 bucket 的讀取走公開網址，不需要 select 權限；
-- 但替換（upsert）與刪除時 Storage 需要先查到檔案，所以給店長 select。
create policy "admins read website photos" on storage.objects
  for select to authenticated using (bucket_id = 'website-photos' and (select app_private.is_admin()));
create policy "admins upload website photos" on storage.objects
  for insert to authenticated with check (bucket_id = 'website-photos' and (select app_private.is_admin()));
create policy "admins update website photos" on storage.objects
  for update to authenticated using (bucket_id = 'website-photos' and (select app_private.is_admin()))
  with check (bucket_id = 'website-photos' and (select app_private.is_admin()));
create policy "admins delete website photos" on storage.objects
  for delete to authenticated using (bucket_id = 'website-photos' and (select app_private.is_admin()));
