-- 特惠組合（第 1 步）：組合的資料表與店長專用的新增／修改／刪除函式。
-- 結帳與報價套用組合價在之後的遷移加入；這一步只建立組合本身。
--
-- promotions：組合名稱、有效期間（含開始與結束當天，台北日期）、組合價、是否啟用。
-- promotion_items：組合內容（品項＋數量）。
-- 所有在職店員都能讀（結帳時要列出組合）；寫入一律透過下面的店長專用函式，畫面無法直接改表。

create table public.promotions (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 100),
  starts_on date not null,
  ends_on date not null,
  combo_price numeric(12,2) not null check (combo_price >= 0),
  active boolean not null default true,
  created_by uuid not null references public.profiles(id) default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_on >= starts_on)
);

create table public.promotion_items (
  promotion_id uuid not null references public.promotions(id) on delete cascade,
  item_id uuid not null references public.items(id),
  quantity integer not null check (quantity between 1 and 999),
  primary key (promotion_id, item_id)
);
create index promotion_items_item_id_idx on public.promotion_items(item_id);

alter table public.promotions enable row level security;
alter table public.promotion_items enable row level security;
create policy "active staff read promotions" on public.promotions
  for select to authenticated using ((select app_private.is_active_staff()));
create policy "active staff read promotion items" on public.promotion_items
  for select to authenticated using ((select app_private.is_active_staff()));
revoke all on public.promotions, public.promotion_items from anon, authenticated;
grant select on public.promotions, public.promotion_items to authenticated;

-- 新增或修改組合（p_promotion.id 為 null 時新增）。
-- p_promotion：{ id, name, startsOn, endsOn, comboPrice, active, items: [{ itemId, quantity }] }
-- 規則：至少 2 件商品（可同一品項 2 件）；同一品項不可重複列；組合價要低於目前原價合計。
create or replace function app_private.save_promotion(p_promotion jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := nullif(p_promotion->>'id', '')::uuid;
  v_name text := trim(coalesce(p_promotion->>'name', ''));
  v_starts date := (p_promotion->>'startsOn')::date;
  v_ends date := (p_promotion->>'endsOn')::date;
  v_price numeric := (p_promotion->>'comboPrice')::numeric;
  v_active boolean := coalesce((p_promotion->>'active')::boolean, true);
  v_items jsonb := p_promotion->'items';
  v_item jsonb;
  v_item_id uuid;
  v_quantity integer;
  v_list_total numeric := 0;
  v_pieces integer := 0;
  v_price_each numeric;
begin
  if not app_private.is_admin() then raise exception '只有店長可以設定特惠組合' using errcode = '42501'; end if;
  if v_name = '' or length(v_name) > 100 then raise exception '請填寫組合名稱（100 字以內）'; end if;
  if v_starts is null or v_ends is null or v_ends < v_starts then raise exception '請填寫正確的期間（結束日不可早於開始日）'; end if;
  if v_price is null or v_price < 0 or v_price * 100 <> trunc(v_price * 100) then raise exception '組合價須為 0 以上、最多兩位小數'; end if;
  if jsonb_typeof(v_items) is distinct from 'array' or jsonb_array_length(v_items) = 0 then raise exception '請至少加入一個品項'; end if;
  if (select count(distinct value->>'itemId') from jsonb_array_elements(v_items)) <> jsonb_array_length(v_items) then
    raise exception '同一個品項請合併成一列，用數量表示';
  end if;
  for v_item in select value from jsonb_array_elements(v_items) loop
    v_item_id := nullif(v_item->>'itemId', '')::uuid;
    v_quantity := (v_item->>'quantity')::integer;
    if v_quantity is null or v_quantity < 1 or v_quantity > 999 then raise exception '品項數量須為 1～999'; end if;
    select price into v_price_each from public.items where id = v_item_id;
    if not found then raise exception '組合中的品項不存在'; end if;
    v_list_total := v_list_total + v_price_each * v_quantity;
    v_pieces := v_pieces + v_quantity;
  end loop;
  if v_pieces < 2 then raise exception '組合至少要有 2 件商品'; end if;
  if v_price >= v_list_total then
    raise exception '組合價（%）須低於目前原價合計（%）', to_char(v_price, 'FM999,999,990.##'), to_char(v_list_total, 'FM999,999,990.##');
  end if;

  if v_id is null then
    insert into public.promotions (name, starts_on, ends_on, combo_price, active, created_by)
      values (v_name, v_starts, v_ends, round(v_price, 2), v_active, auth.uid()) returning id into v_id;
  else
    update public.promotions set name = v_name, starts_on = v_starts, ends_on = v_ends, combo_price = round(v_price, 2),
      active = v_active, updated_at = now() where id = v_id;
    if not found then raise exception '特惠組合不存在'; end if;
    delete from public.promotion_items where promotion_id = v_id;
  end if;
  insert into public.promotion_items (promotion_id, item_id, quantity)
    select v_id, (value->>'itemId')::uuid, (value->>'quantity')::integer from jsonb_array_elements(v_items);
  insert into public.audit_logs (actor_id, action, target_type, target_id, summary)
    values (auth.uid(), 'promotion.saved', 'promotion', v_id, jsonb_build_object('name', v_name, 'starts_on', v_starts,
      'ends_on', v_ends, 'combo_price', v_price, 'active', v_active, 'items', v_items));
  return v_id;
end;
$$;

-- 刪除組合：只用在建錯的組合。已經被銷售或報價使用過的組合，之後的遷移會用外鍵擋下，請改用「停用」。
create or replace function app_private.delete_promotion(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_name text;
begin
  if not app_private.is_admin() then raise exception '只有店長可以刪除特惠組合' using errcode = '42501'; end if;
  delete from public.promotions where id = p_id returning name into v_name;
  if not found then raise exception '特惠組合不存在'; end if;
  insert into public.audit_logs (actor_id, action, target_type, target_id, summary)
    values (auth.uid(), 'promotion.deleted', 'promotion', p_id, jsonb_build_object('name', v_name));
end;
$$;

create or replace function public.save_promotion(p_promotion jsonb) returns uuid
  language sql security invoker set search_path = '' as $$ select app_private.save_promotion(p_promotion) $$;
create or replace function public.delete_promotion(p_id uuid) returns void
  language sql security invoker set search_path = '' as $$ select app_private.delete_promotion(p_id) $$;

revoke all on function app_private.save_promotion(jsonb), app_private.delete_promotion(uuid),
  public.save_promotion(jsonb), public.delete_promotion(uuid) from public, anon;
grant execute on function app_private.save_promotion(jsonb), app_private.delete_promotion(uuid),
  public.save_promotion(jsonb), public.delete_promotion(uuid) to authenticated;
