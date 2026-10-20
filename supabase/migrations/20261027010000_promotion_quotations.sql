-- 特惠組合（第 3 步）：報價單套用組合價。
--
-- 報價明細的 subtotal 維持「原價 × 數量」（材料原價小計），另外新增 discount 記錄這一列分到的組合折扣；
-- 報價總額＝Σ（材料原價小計 − 組合折扣 ＋ 工資）。工資不打折。
-- 折扣規則和銷售結帳完全相同（見 20261026010000_promotion_checkout.sql）：
--   依原價占比分配、捨去到元、差額給金額最大的品項。
-- 報價單可以把同一個品項分成好幾列（例如一列需安裝、一列免安裝）：同一品項先合併計算，
-- 再把這個品項分到的折扣依明細順序往下扣，每列最多扣到材料小計為 0。

alter table public.quotation_lines add column discount numeric(12,2) not null default 0
  check (discount >= 0 and discount <= subtotal);

create table public.quotation_promotions (
  id uuid primary key default gen_random_uuid(),
  quotation_id uuid not null references public.quotations(id) on delete cascade,
  promotion_id uuid not null references public.promotions(id) on delete restrict,
  promotion_name text not null,
  times integer not null check (times between 1 and 99),
  combo_price numeric(12,2) not null check (combo_price >= 0),
  list_total numeric(12,2) not null check (list_total > 0),
  discount numeric(12,2) not null check (discount > 0),
  unique (quotation_id, promotion_id)
);
create index quotation_promotions_promotion_id_idx on public.quotation_promotions(promotion_id);
alter table public.quotation_promotions enable row level security;
create policy "active staff read quotation promotions" on public.quotation_promotions
  for select to authenticated using ((select app_private.is_active_staff()));
revoke all on public.quotation_promotions from anon, authenticated;
grant select on public.quotation_promotions to authenticated;

-- 共用的組合折扣計算（報價單使用）。
-- p_lines：[{ itemId, unitPrice, quantity }]，同一品項只能一列（呼叫端先合併）。
-- p_promotions：[{ promotionId, times }]。
-- 回傳 { byItem: { 品項ID: 折扣（分） }, entries: [{ promotionId, name, times, comboPrice, listTotal, discount }], total: 總折扣（分） }。
create or replace function app_private.calc_promotion_discounts(p_lines jsonb, p_promotions jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_today date := (now() at time zone 'Asia/Taipei')::date;
  v_entry jsonb;
  v_promo public.promotions%rowtype;
  v_times integer;
  v_item_ids uuid[];
  v_grosses bigint[];
  v_needs integer[];
  v_missing integer;
  v_shares bigint[];
  v_list bigint;
  v_discount bigint;
  v_rest bigint;
  v_move bigint;
  v_total bigint := 0;
  v_by_item jsonb := '{}'::jsonb;
  v_need_by_item jsonb := '{}'::jsonb;
  v_entries jsonb := '[]'::jsonb;
  v_key text;
  i integer;
begin
  if p_promotions is null or jsonb_typeof(p_promotions) = 'null' then p_promotions := '[]'::jsonb; end if;
  if jsonb_typeof(p_promotions) <> 'array' then raise exception '特惠組合格式無效'; end if;
  if jsonb_array_length(p_promotions) = 0 then return jsonb_build_object('byItem', '{}'::jsonb, 'entries', '[]'::jsonb, 'total', 0); end if;
  if jsonb_array_length(p_promotions) > 20 then raise exception '一張單最多套用 20 種組合'; end if;
  if (select count(distinct value->>'promotionId') from jsonb_array_elements(p_promotions)) <> jsonb_array_length(p_promotions) then
    raise exception '同一個組合請用組數表示，不要重複加入';
  end if;
  if (select count(distinct value->>'itemId') from jsonb_array_elements(p_lines)) <> jsonb_array_length(p_lines) then
    raise exception '組合計算時同一品項只能一列';
  end if;

  for v_entry in select value from jsonb_array_elements(p_promotions) loop
    select * into v_promo from public.promotions where id = nullif(v_entry->>'promotionId', '')::uuid for share;
    if not found then raise exception '特惠組合不存在，請重新整理後再試'; end if;
    if not v_promo.active or v_today < v_promo.starts_on or v_today > v_promo.ends_on then
      raise exception '「%」不在優惠期間或已停用，請重新整理後再試', v_promo.name;
    end if;
    v_times := (v_entry->>'times')::integer;
    if v_times is null or v_times < 1 or v_times > 99 then raise exception '組合組數須為 1～99'; end if;

    select array_agg(pi.item_id order by g.gross desc, pi.item_id),
           array_agg(g.gross order by g.gross desc, pi.item_id),
           array_agg(pi.quantity * v_times order by g.gross desc, pi.item_id),
           count(*) filter (where l.value is null)
      into v_item_ids, v_grosses, v_needs, v_missing
      from public.promotion_items pi
      left join lateral (select value from jsonb_array_elements(p_lines) where value->>'itemId' = pi.item_id::text) l on true
      cross join lateral (select coalesce(round((l.value->>'unitPrice')::numeric * 100), 0)::bigint * pi.quantity * v_times as gross) g
      where pi.promotion_id = v_promo.id;
    if v_item_ids is null then raise exception '「%」沒有設定商品', v_promo.name; end if;
    if v_missing > 0 then raise exception '明細缺少「%」的商品', v_promo.name; end if;

    v_list := 0;
    for i in 1 .. array_length(v_item_ids, 1) loop v_list := v_list + v_grosses[i]; end loop;
    v_discount := v_list - round(v_promo.combo_price * 100)::bigint * v_times;
    if v_discount <= 0 then raise exception '「%」目前原價合計已不高於組合價，無法套用', v_promo.name; end if;

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
      v_by_item := jsonb_set(v_by_item, array[v_key], to_jsonb(coalesce((v_by_item->>v_key)::bigint, 0) + v_shares[i]));
      v_need_by_item := jsonb_set(v_need_by_item, array[v_key], to_jsonb(coalesce((v_need_by_item->>v_key)::integer, 0) + v_needs[i]));
    end loop;
    v_total := v_total + v_discount;
    v_entries := v_entries || jsonb_build_array(jsonb_build_object('promotionId', v_promo.id, 'name', v_promo.name, 'times', v_times,
      'comboPrice', v_promo.combo_price, 'listTotal', v_list / 100.0, 'discount', v_discount / 100.0));
  end loop;

  for v_key in select jsonb_object_keys(v_need_by_item) loop
    if (select (value->>'quantity')::integer from jsonb_array_elements(p_lines) where value->>'itemId' = v_key)
       < (v_need_by_item->>v_key)::integer then
      raise exception '明細數量不足以套用所選組合，請確認組數';
    end if;
  end loop;
  return jsonb_build_object('byItem', v_by_item, 'entries', v_entries, 'total', v_total);
end;
$$;
revoke all on function app_private.calc_promotion_discounts(jsonb, jsonb) from public, anon, authenticated;

-- 建立報價單：p_quotation.promotions＝[{ promotionId, times }]（沒有＝不套組合，舊網頁照常可用）。
-- 以下與原本版本相同，只多了組合折扣的計算、總額檢查與寫入。
create or replace function app_private.save_quotation(p_quotation jsonb, p_lines jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := (p_quotation->>'id')::uuid;
  v_customer_id uuid := (p_quotation->>'customerId')::uuid;
  v_salesperson_id uuid := (p_quotation->>'salespersonId')::uuid;
  v_line jsonb;
  v_item public.items%rowtype;
  v_quantity integer;
  v_installed boolean;
  v_hours numeric;
  v_rate numeric;
  v_labor numeric;
  v_shop_rate numeric(12,2);
  v_total numeric(12,2) := 0;
  v_calc jsonb;
  v_left jsonb;
  v_key text;
  v_line_discount bigint;
  v_entry jsonb;
begin
  if not app_private.is_active_staff() then raise exception '帳號權限不足'; end if;
  if v_id is null or nullif(trim(p_quotation->>'number'), '') is null or
     jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception '報價資料不完整';
  end if;
  if exists (select 1 from public.quotations where id = v_id) then raise exception '報價已存在，不能覆寫'; end if;
  if not exists (select 1 from public.customers where id = v_customer_id and active) then raise exception '報價客戶不存在或已停用'; end if;
  if v_salesperson_id is not null and not exists (select 1 from public.salespeople where id = v_salesperson_id and active) then
    raise exception '報價業務不存在或已停用';
  end if;
  select hourly_rate into v_shop_rate from public.shop_settings where id=1;
  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_quantity := (v_line->>'quantity')::integer;
    if v_quantity is null or v_quantity <= 0 then raise exception '報價數量無效'; end if;
    select * into v_item from public.items where id = (v_line->>'itemId')::uuid;
    if not found then raise exception '報價品項不存在'; end if;
    if (v_line->>'itemName') is distinct from v_item.name or (v_line->>'unitPrice')::numeric is distinct from v_item.price then
      raise exception '報價品項資料已變更，請重新整理';
    end if;
    if v_line ? 'installationRequired' and jsonb_typeof(v_line->'installationRequired') <> 'boolean' then raise exception '安裝選項無效'; end if;
    v_installed := coalesce((v_line->>'installationRequired')::boolean,false);
    v_hours := coalesce((v_line->>'laborHours')::numeric,0);
    v_rate := coalesce((v_line->>'hourlyRate')::numeric,0);
    v_labor := coalesce((v_line->>'laborAmount')::numeric,0);
    if v_installed then
      if v_shop_rate is null or v_shop_rate <= 0 or v_hours <= 0 or v_hours <> round(v_hours,2)
        or v_rate <> round(v_rate,2) or v_labor <> round(v_labor,2)
        or v_rate is distinct from v_shop_rate or v_labor is distinct from round(v_hours*v_rate,2) then
        raise exception '工時或工資費率無效，請重新整理報價';
      end if;
    elsif v_hours <> 0 or v_rate <> 0 or v_labor <> 0 then
      raise exception '免安裝品項不可計收工資';
    end if;
    v_total := v_total + v_quantity * v_item.price + v_labor;
  end loop;

  -- 特惠組合：同一品項的數量先合併，以目前售價計算折扣。
  v_calc := app_private.calc_promotion_discounts(
    (select jsonb_agg(jsonb_build_object('itemId', i.id, 'unitPrice', i.price, 'quantity', a.quantity))
       from (select (value->>'itemId')::uuid as item_id, sum((value->>'quantity')::integer) as quantity
               from jsonb_array_elements(p_lines) group by 1) a
       join public.items i on i.id = a.item_id),
    p_quotation->'promotions');
  v_total := v_total - (v_calc->>'total')::bigint / 100.0;
  if v_total is distinct from (p_quotation->>'total')::numeric then raise exception '報價總額無效'; end if;

  insert into public.quotations (id,quote_number,customer_id,salesperson_id,total,note,created_by)
  values (v_id,trim(p_quotation->>'number'),v_customer_id,v_salesperson_id,v_total,coalesce(p_quotation->>'note',''),auth.uid());
  v_left := v_calc->'byItem';
  for v_line in select value from jsonb_array_elements(p_lines) loop
    select * into v_item from public.items where id=(v_line->>'itemId')::uuid;
    v_quantity := (v_line->>'quantity')::integer;
    v_installed := coalesce((v_line->>'installationRequired')::boolean,false);
    v_hours := coalesce((v_line->>'laborHours')::numeric,0);
    v_rate := coalesce((v_line->>'hourlyRate')::numeric,0);
    v_labor := coalesce((v_line->>'laborAmount')::numeric,0);
    -- 這個品項還沒扣完的折扣，依明細順序往下扣，每列最多扣到材料小計為 0。
    v_key := v_item.id::text;
    v_line_discount := least(coalesce((v_left->>v_key)::bigint, 0), round(v_item.price * 100)::bigint * v_quantity);
    if v_line_discount > 0 then v_left := jsonb_set(v_left, array[v_key], to_jsonb((v_left->>v_key)::bigint - v_line_discount)); end if;
    insert into public.quotation_lines(quotation_id,item_id,item_name,quantity,unit_price,subtotal,
      installation_required,labor_hours,hourly_rate,labor_amount,discount)
    values (v_id,v_item.id,v_item.name,v_quantity,v_item.price,v_quantity*v_item.price,
      v_installed,v_hours,v_rate,v_labor,v_line_discount / 100.0);
  end loop;
  for v_entry in select value from jsonb_array_elements(v_calc->'entries') loop
    insert into public.quotation_promotions (quotation_id, promotion_id, promotion_name, times, combo_price, list_total, discount)
      values (v_id, (v_entry->>'promotionId')::uuid, v_entry->>'name', (v_entry->>'times')::integer,
        (v_entry->>'comboPrice')::numeric, (v_entry->>'listTotal')::numeric, (v_entry->>'discount')::numeric);
  end loop;
  return v_id;
end;
$$;

-- 刪除組合：已被銷售或報價使用過的組合不能刪除。
create or replace function app_private.delete_promotion(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_name text;
begin
  if not app_private.is_admin() then raise exception '只有店長可以刪除特惠組合' using errcode = '42501'; end if;
  if exists (select 1 from public.sale_promotions where promotion_id = p_id) then
    raise exception '這個組合已有銷售紀錄，不能刪除；請改用「編輯」取消勾選「啟用」';
  end if;
  if exists (select 1 from public.quotation_promotions where promotion_id = p_id) then
    raise exception '這個組合已用在報價單，不能刪除；請改用「編輯」取消勾選「啟用」';
  end if;
  delete from public.promotions where id = p_id returning name into v_name;
  if not found then raise exception '特惠組合不存在'; end if;
  insert into public.audit_logs (actor_id, action, target_type, target_id, summary)
    values (auth.uid(), 'promotion.deleted', 'promotion', p_id, jsonb_build_object('name', v_name));
end;
$$;
