-- 特惠組合（第 2 步）：銷售結帳套用組合價。
--
-- 做法：結帳照舊建立銷售單（原價），再由 apply_sale_promotions 依「這次套用的組合」把折扣攤到各明細。
--   sale_lines.unit_price 仍是原價；新增 discount（這一列分到的組合折扣），subtotal 改為「原價小計 − 折扣」＝實收。
--   sales.total 是實收合計，所以營運總覽、業務員業績都會自動以折扣後金額計算。
--   sale_promotions 記錄這張單套用了哪個組合、幾組、當時的組合價與折扣（之後組合被修改也不影響舊單）。
--
-- 折扣攤提（前端 inventory.js 的 allocatePromotionDiscount 用同一套規則，畫面金額與資料庫一致）：
--   每個組合：折扣 ＝ 組合內商品原價合計 − 組合價 × 組數。
--   依各商品原價小計占比分配，除了金額最大的那一項，其他都「無條件捨去到元」；
--   剩下的差額全部給金額最大的那一項（同金額時以品項 ID 排序取第一個）。
--   若最大項放不下（只會發生在組合價極低時），多出的部分依序分給其他項，每項最多扣到 0 元。

alter table public.sale_lines add column discount numeric(12,2) not null default 0 check (discount >= 0);

create table public.sale_promotions (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id) on delete cascade,
  -- restrict：用過的組合不能刪除，只能停用，才查得到每張單套用了哪個組合。
  promotion_id uuid not null references public.promotions(id) on delete restrict,
  promotion_name text not null,
  times integer not null check (times between 1 and 99),
  combo_price numeric(12,2) not null check (combo_price >= 0),
  list_total numeric(12,2) not null check (list_total > 0),
  discount numeric(12,2) not null check (discount > 0),
  unique (sale_id, promotion_id)
);
create index sale_promotions_promotion_id_idx on public.sale_promotions(promotion_id);
alter table public.sale_promotions enable row level security;
create policy "active staff read sale promotions" on public.sale_promotions
  for select to authenticated using ((select app_private.is_active_staff()));
revoke all on public.sale_promotions from anon, authenticated;
grant select on public.sale_promotions to authenticated;

-- p_promotions：[{ promotionId, times }]。只在 create_sale_with_serials_logged 內、銷售單剛建立後呼叫。
create or replace function app_private.apply_sale_promotions(p_sale_id uuid, p_promotions jsonb)
returns numeric language plpgsql security definer set search_path = '' as $$
declare
  v_today date := (now() at time zone 'Asia/Taipei')::date;
  v_entry jsonb;
  v_promo public.promotions%rowtype;
  v_times integer;
  v_item_ids uuid[];
  v_grosses bigint[];
  v_needs integer[];
  v_shares bigint[];
  v_list bigint;
  v_discount bigint;
  v_rest bigint;
  v_move bigint;
  v_lines integer;
  v_line_quantity integer;
  v_total_discount bigint := 0;
  v_discount_by_item jsonb := '{}'::jsonb;
  v_need_by_item jsonb := '{}'::jsonb;
  v_key text;
  i integer;
begin
  if p_promotions is null then return 0; end if;
  if jsonb_typeof(p_promotions) <> 'array' then raise exception '特惠組合格式無效'; end if;
  if jsonb_array_length(p_promotions) = 0 then return 0; end if;
  if jsonb_array_length(p_promotions) > 20 then raise exception '一張銷售單最多套用 20 種組合'; end if;
  if (select count(distinct value->>'promotionId') from jsonb_array_elements(p_promotions)) <> jsonb_array_length(p_promotions) then
    raise exception '同一個組合請用組數表示，不要重複加入';
  end if;

  for v_entry in select value from jsonb_array_elements(p_promotions) loop
    -- for share：結帳期間店長不能同時修改這個組合，避免用到改到一半的內容。
    select * into v_promo from public.promotions where id = nullif(v_entry->>'promotionId', '')::uuid for share;
    if not found then raise exception '特惠組合不存在，請重新整理後再試'; end if;
    if not v_promo.active or v_today < v_promo.starts_on or v_today > v_promo.ends_on then
      raise exception '「%」不在優惠期間或已停用，請重新整理後再試', v_promo.name;
    end if;
    v_times := (v_entry->>'times')::integer;
    if v_times is null or v_times < 1 or v_times > 99 then raise exception '組合組數須為 1～99'; end if;

    -- 組合內每個品項：需要的數量、原價小計（以「分」計算，避免小數誤差）。金額大的排前面。
    select array_agg(pi.item_id order by g.gross desc, pi.item_id),
           array_agg(g.gross order by g.gross desc, pi.item_id),
           array_agg(pi.quantity * v_times order by g.gross desc, pi.item_id),
           count(*) filter (where l.id is null)
      into v_item_ids, v_grosses, v_needs, v_lines
      from public.promotion_items pi
      left join lateral (select sl.id, sl.unit_price from public.sale_lines sl
        where sl.sale_id = p_sale_id and sl.item_id = pi.item_id order by sl.id limit 1) l on true
      cross join lateral (select coalesce(round(l.unit_price * 100), 0)::bigint * pi.quantity * v_times as gross) g
      where pi.promotion_id = v_promo.id;
    if v_item_ids is null then raise exception '「%」沒有設定商品', v_promo.name; end if;
    if v_lines > 0 then raise exception '購物車缺少「%」的商品', v_promo.name; end if;

    v_list := 0;
    for i in 1 .. array_length(v_item_ids, 1) loop v_list := v_list + v_grosses[i]; end loop;
    v_discount := v_list - round(v_promo.combo_price * 100)::bigint * v_times;
    if v_discount <= 0 then raise exception '「%」目前原價合計已不高於組合價，無法套用', v_promo.name; end if;

    -- 攤提：第 1 項（金額最大）以外都捨去到元，差額給第 1 項；第 1 項放不下時往後補。
    v_shares := array_fill(0::bigint, array[array_length(v_item_ids, 1)]);
    v_rest := v_discount;
    for i in 2 .. array_length(v_item_ids, 1) loop
      v_shares[i] := floor(v_discount::numeric * v_grosses[i] / v_list / 100)::bigint * 100;
      v_rest := v_rest - v_shares[i];
    end loop;
    v_shares[1] := least(v_rest, v_grosses[1]);
    v_rest := v_rest - v_shares[1];
    i := 2;
    while v_rest > 0 and i <= array_length(v_item_ids, 1) loop
      v_move := least(v_rest, v_grosses[i] - v_shares[i]);
      v_shares[i] := v_shares[i] + v_move;
      v_rest := v_rest - v_move;
      i := i + 1;
    end loop;
    if v_rest > 0 then raise exception '「%」折扣分配失敗', v_promo.name; end if;

    for i in 1 .. array_length(v_item_ids, 1) loop
      v_key := v_item_ids[i]::text;
      v_discount_by_item := jsonb_set(v_discount_by_item, array[v_key],
        to_jsonb(coalesce((v_discount_by_item->>v_key)::bigint, 0) + v_shares[i]));
      v_need_by_item := jsonb_set(v_need_by_item, array[v_key],
        to_jsonb(coalesce((v_need_by_item->>v_key)::integer, 0) + v_needs[i]));
    end loop;
    v_total_discount := v_total_discount + v_discount;
    insert into public.sale_promotions (sale_id, promotion_id, promotion_name, times, combo_price, list_total, discount)
      values (p_sale_id, v_promo.id, v_promo.name, v_times, v_promo.combo_price, v_list / 100.0, v_discount / 100.0);
  end loop;

  -- 數量檢查：所有套用組合需要的同一品項數量加總，不可超過這張單賣出的數量。
  for v_key in select jsonb_object_keys(v_need_by_item) loop
    select count(*), coalesce(sum(quantity), 0) into v_lines, v_line_quantity
      from public.sale_lines where sale_id = p_sale_id and item_id = v_key::uuid;
    if v_lines > 1 then raise exception '組合內的商品請在購物車合併成一列'; end if;
    if v_line_quantity < (v_need_by_item->>v_key)::integer then
      raise exception '購物車數量不足以套用所選組合，請確認組數';
    end if;
    update public.sale_lines set discount = (v_discount_by_item->>v_key)::bigint / 100.0,
      subtotal = unit_price * quantity - (v_discount_by_item->>v_key)::bigint / 100.0
      where sale_id = p_sale_id and item_id = v_key::uuid;
  end loop;
  update public.sales set total = (select coalesce(sum(subtotal), 0) from public.sale_lines where sale_id = p_sale_id)
    where id = p_sale_id;
  return v_total_discount / 100.0;
end;
$$;
revoke all on function app_private.apply_sale_promotions(uuid, jsonb) from public, anon, authenticated;

-- 結帳：多一個 p_promotions。舊的 4 個參數版本整個移除，避免兩個版本同名時資料庫不知道要用哪一個。
-- 公開函式的 p_promotions 預設為空陣列：還沒更新的舊網頁照舊用 4 個參數呼叫，一樣能結帳（不套組合）。
drop function public.create_sale_with_serials(jsonb, uuid, uuid, uuid);
drop function app_private.create_sale_with_serials_logged(jsonb, uuid, uuid, uuid);

create function app_private.create_sale_with_serials_logged(
  p_lines jsonb, p_customer_id uuid, p_salesperson_id uuid, p_checkout_id uuid, p_promotions jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_name text;
  v_sale_id uuid;
  v_existing_by uuid;
  v_discount numeric;
begin
  if not app_private.is_active_staff() then raise exception '帳號權限不足' using errcode = '42501'; end if;
  if p_checkout_id is null then raise exception '結帳識別碼不可空白'; end if;
  -- 交易層級的 advisory lock：同一個 checkout id 同時送兩次時，第二次會等第一次結束後才往下檢查。
  perform pg_advisory_xact_lock(hashtextextended('sale_checkout:' || p_checkout_id::text, 0));
  select created_by into v_existing_by from public.sales where id = p_checkout_id;
  if found then
    if v_existing_by is distinct from auth.uid() then
      raise exception '結帳識別碼已被使用' using errcode = '23505';
    end if;
    return p_checkout_id;
  end if;
  if p_salesperson_id is null then raise exception '結帳時請選擇業務員'; end if;
  select name into v_name from public.salespeople
    where id = p_salesperson_id and active and is_sales for share;
  if not found then raise exception '業務員不存在、已停用或未勾選業務員身分，請重新選擇'; end if;
  -- 先依 ID 排序鎖住所有品項與序號，多台同時結帳時鎖定順序一致，不會互相卡死（deadlock）。
  perform app_private.lock_sale_rows(p_lines);
  v_sale_id := app_private.create_sale_with_serials(p_lines, p_customer_id, p_checkout_id);
  -- 套用特惠組合：任何一個組合不符合規則就整筆結帳取消（同一個交易）。
  v_discount := app_private.apply_sale_promotions(v_sale_id, coalesce(p_promotions, '[]'::jsonb));
  insert into public.audit_logs (actor_id, action, target_type, target_id, summary)
    select auth.uid(), 'sale_created', 'sale', v_sale_id,
      jsonb_build_object('sale_number', sale_number, 'total', total)
        || case when v_discount > 0 then jsonb_build_object('promotion_discount', v_discount,
             'promotions', coalesce(p_promotions, '[]'::jsonb)) else '{}'::jsonb end
    from public.sales where id = v_sale_id;
  insert into app_private.sale_salesperson_attributions(sale_id, salesperson_id, salesperson_name)
    values (v_sale_id, p_salesperson_id, v_name);
  -- 機車獎金：以台數計算，不受折扣影響；重送同一個 checkout id 會在上面提早 return，所以不會重複記帳。
  perform app_private.record_motorcycle_bonus(v_sale_id);
  return v_sale_id;
end;
$$;

create function public.create_sale_with_serials(
  p_lines jsonb, p_customer_id uuid, p_salesperson_id uuid, p_checkout_id uuid, p_promotions jsonb default '[]'::jsonb)
returns uuid language sql security invoker set search_path = '' as $$
  select app_private.create_sale_with_serials_logged(p_lines, p_customer_id, p_salesperson_id, p_checkout_id, p_promotions)
$$;

revoke all on function app_private.create_sale_with_serials_logged(jsonb, uuid, uuid, uuid, jsonb),
  public.create_sale_with_serials(jsonb, uuid, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function app_private.create_sale_with_serials_logged(jsonb, uuid, uuid, uuid, jsonb),
  public.create_sale_with_serials(jsonb, uuid, uuid, uuid, jsonb) to authenticated;

-- 刪除組合：已有銷售紀錄的組合改給清楚的訊息（原本會是外鍵錯誤）。
create or replace function app_private.delete_promotion(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_name text;
begin
  if not app_private.is_admin() then raise exception '只有店長可以刪除特惠組合' using errcode = '42501'; end if;
  if exists (select 1 from public.sale_promotions where promotion_id = p_id) then
    raise exception '這個組合已有銷售紀錄，不能刪除；請改用「編輯」取消勾選「啟用」';
  end if;
  delete from public.promotions where id = p_id returning name into v_name;
  if not found then raise exception '特惠組合不存在'; end if;
  insert into public.audit_logs (actor_id, action, target_type, target_id, summary)
    values (auth.uid(), 'promotion.deleted', 'promotion', p_id, jsonb_build_object('name', v_name));
end;
$$;
