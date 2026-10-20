-- 優惠代碼：店長設定，店員在銷售結帳輸入代碼取得折扣。
--
-- 規則（店長已確認）：
--   折扣方式：每組代碼可選「折抵固定金額」或「打折百分比」。
--   使用次數：可設總使用上限（不填＝不限）；另有期間（含頭尾，台北日期）與啟用開關。
--   併用：可與特惠組合併用，先扣組合再算代碼；一張銷售單限用一組代碼。
--   範圍：只用在銷售結帳。
-- 折扣金額：
--   折抵金額＝min(設定金額, 組合折扣後的訂單金額)；打折＝訂單金額 × 百分比，無條件捨去到元。
--   攤到各明細的方式和特惠組合相同（依金額占比、捨去到元、差額給金額最大的明細）。
--
-- 代碼本身放在 app_private（網頁無法直接讀表），避免店員或外人列出全部代碼；
-- 店員只能透過 check_coupon 檢查「自己輸入的這一組」能不能用。

create table app_private.coupons (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9_-]{3,30}$'),
  description text not null default '' check (length(description) <= 100),
  kind text not null check (kind in ('amount', 'percent')),
  value numeric(12,2) not null check (value > 0 and (kind <> 'percent' or value < 100)),
  starts_on date not null,
  ends_on date not null,
  usage_limit integer check (usage_limit is null or usage_limit between 1 and 100000),
  active boolean not null default true,
  created_by uuid references public.profiles(id) default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_on >= starts_on)
);
alter table app_private.coupons enable row level security;
revoke all on app_private.coupons from public, anon, authenticated;

-- 每張銷售單用了哪組代碼（代碼、折扣方式與數值都存快照，之後店長改代碼也不影響舊單）。
create table public.sale_coupons (
  sale_id uuid primary key references public.sales(id) on delete cascade,
  coupon_id uuid not null references app_private.coupons(id) on delete restrict,
  code text not null,
  kind text not null check (kind in ('amount', 'percent')),
  value numeric(12,2) not null,
  discount numeric(12,2) not null check (discount > 0)
);
create index sale_coupons_coupon_id_idx on public.sale_coupons(coupon_id);
alter table public.sale_coupons enable row level security;
create policy "active staff read sale coupons" on public.sale_coupons
  for select to authenticated using ((select app_private.is_active_staff()));
revoke all on public.sale_coupons from anon, authenticated;
grant select on public.sale_coupons to authenticated;

-- 代碼一律去頭尾空白並轉大寫，所以輸入 oct10 和 OCT10 是同一組。
create or replace function app_private.normalize_coupon_code(p_code text)
returns text language sql immutable set search_path = '' as $$ select upper(trim(coalesce(p_code, ''))) $$;

-- 檢查代碼現在能不能用；可以就回傳代碼資料，不行就丟出原因。p_lock＝結帳時鎖住這組代碼（避免同時超用）。
create or replace function app_private.usable_coupon(p_code text, p_lock boolean)
returns app_private.coupons language plpgsql security definer set search_path = '' as $$
declare
  v_code text := app_private.normalize_coupon_code(p_code);
  v_today date := (now() at time zone 'Asia/Taipei')::date;
  v_coupon app_private.coupons%rowtype;
  v_used integer;
begin
  if v_code = '' then raise exception '請輸入優惠代碼'; end if;
  if p_lock then select * into v_coupon from app_private.coupons where code = v_code for update;
  else select * into v_coupon from app_private.coupons where code = v_code; end if;
  if not found then raise exception '查無優惠代碼「%」', v_code; end if;
  if not v_coupon.active then raise exception '優惠代碼「%」已停用', v_code; end if;
  if v_today < v_coupon.starts_on then raise exception '優惠代碼「%」尚未開始（% 起）', v_code, to_char(v_coupon.starts_on, 'YYYY/MM/DD'); end if;
  if v_today > v_coupon.ends_on then raise exception '優惠代碼「%」已過期', v_code; end if;
  if v_coupon.usage_limit is not null then
    select count(*) into v_used from public.sale_coupons where coupon_id = v_coupon.id;
    if v_used >= v_coupon.usage_limit then raise exception '優惠代碼「%」已達使用上限', v_code; end if;
  end if;
  return v_coupon;
end;
$$;

-- 店員輸入代碼時先檢查（結帳時資料庫會再檢查一次）。
create or replace function app_private.check_coupon(p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_coupon app_private.coupons%rowtype;
begin
  if not app_private.is_active_staff() then raise exception '帳號權限不足' using errcode = '42501'; end if;
  v_coupon := app_private.usable_coupon(p_code, false);
  return jsonb_build_object('code', v_coupon.code, 'description', v_coupon.description, 'kind', v_coupon.kind, 'value', v_coupon.value);
end;
$$;

-- 套用到剛建立的銷售單（特惠組合已經扣好之後）。回傳折扣金額（元）。
create or replace function app_private.apply_sale_coupon(p_sale_id uuid, p_code text)
returns numeric language plpgsql security definer set search_path = '' as $$
declare
  v_coupon app_private.coupons%rowtype;
  v_line_ids uuid[];
  v_grosses bigint[];
  v_shares bigint[];
  v_base bigint := 0;
  v_discount bigint;
  v_rest bigint;
  v_move bigint;
  i integer;
begin
  if app_private.normalize_coupon_code(p_code) = '' then return 0; end if;
  v_coupon := app_private.usable_coupon(p_code, true);
  -- 各明細目前的實收（已扣組合折扣），金額大的排前面；同金額依品項 ID（和前端相同）。
  select array_agg(id order by g desc, item_id, id), array_agg(g order by g desc, item_id, id)
    into v_line_ids, v_grosses
    from (select id, item_id, round(subtotal * 100)::bigint as g from public.sale_lines where sale_id = p_sale_id) l
    where g > 0;
  if v_line_ids is null then raise exception '訂單金額為 0，無法使用優惠代碼'; end if;
  for i in 1 .. array_length(v_line_ids, 1) loop v_base := v_base + v_grosses[i]; end loop;
  if v_coupon.kind = 'amount' then v_discount := least(round(v_coupon.value * 100)::bigint, v_base);
  else v_discount := floor(v_base::numeric * v_coupon.value / 100 / 100)::bigint * 100; end if;
  if v_discount <= 0 then raise exception '訂單金額太小，優惠代碼「%」折扣為 0 元', v_coupon.code; end if;

  v_shares := array_fill(0::bigint, array[array_length(v_line_ids, 1)]);
  v_rest := v_discount;
  for i in 2 .. array_length(v_line_ids, 1) loop
    v_shares[i] := floor(v_discount::numeric * v_grosses[i] / v_base / 100)::bigint * 100;
    v_rest := v_rest - v_shares[i];
  end loop;
  v_shares[1] := least(v_rest, v_grosses[1]);
  v_rest := v_rest - v_shares[1];
  i := 2;
  while v_rest > 0 and i <= array_length(v_line_ids, 1) loop
    v_move := least(v_rest, v_grosses[i] - v_shares[i]);
    v_shares[i] := v_shares[i] + v_move;
    v_rest := v_rest - v_move;
    i := i + 1;
  end loop;

  for i in 1 .. array_length(v_line_ids, 1) loop
    update public.sale_lines set discount = discount + v_shares[i] / 100.0, subtotal = subtotal - v_shares[i] / 100.0
      where id = v_line_ids[i];
  end loop;
  update public.sales set total = (select coalesce(sum(subtotal), 0) from public.sale_lines where sale_id = p_sale_id)
    where id = p_sale_id;
  insert into public.sale_coupons (sale_id, coupon_id, code, kind, value, discount)
    values (p_sale_id, v_coupon.id, v_coupon.code, v_coupon.kind, v_coupon.value, v_discount / 100.0);
  return v_discount / 100.0;
end;
$$;

-- 店長：列出、新增／修改、刪除代碼。
create or replace function app_private.get_coupons()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not app_private.is_admin() then raise exception '只有店長可以查看優惠代碼' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'code', c.code, 'description', c.description, 'kind', c.kind,
      'value', c.value, 'startsOn', c.starts_on, 'endsOn', c.ends_on, 'usageLimit', c.usage_limit, 'active', c.active,
      'usedCount', (select count(*) from public.sale_coupons s where s.coupon_id = c.id),
      'usedDiscount', (select coalesce(sum(s.discount), 0) from public.sale_coupons s where s.coupon_id = c.id))
    order by c.starts_on desc, c.code) from app_private.coupons c), '[]'::jsonb);
end;
$$;

-- p_coupon：{ id, code, description, kind, value, startsOn, endsOn, usageLimit, active }；id 為 null 時新增。
create or replace function app_private.save_coupon(p_coupon jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := nullif(p_coupon->>'id', '')::uuid;
  v_code text := app_private.normalize_coupon_code(p_coupon->>'code');
  v_description text := trim(coalesce(p_coupon->>'description', ''));
  v_kind text := p_coupon->>'kind';
  v_value numeric := (p_coupon->>'value')::numeric;
  v_starts date := (p_coupon->>'startsOn')::date;
  v_ends date := (p_coupon->>'endsOn')::date;
  v_limit integer := nullif(p_coupon->>'usageLimit', '')::integer;
  v_active boolean := coalesce((p_coupon->>'active')::boolean, true);
begin
  if not app_private.is_admin() then raise exception '只有店長可以設定優惠代碼' using errcode = '42501'; end if;
  if v_code !~ '^[A-Z0-9_-]{3,30}$' then raise exception '代碼須為 3～30 個英文字母、數字、- 或 _'; end if;
  if length(v_description) > 100 then raise exception '說明請在 100 字以內'; end if;
  if v_kind not in ('amount', 'percent') or v_kind is null then raise exception '請選擇折扣方式'; end if;
  if v_value is null or v_value <= 0 or v_value * 100 <> trunc(v_value * 100) then raise exception '折扣數值須大於 0、最多兩位小數'; end if;
  if v_kind = 'percent' and v_value >= 100 then raise exception '打折百分比須小於 100'; end if;
  if v_starts is null or v_ends is null or v_ends < v_starts then raise exception '請填寫正確的期間（結束日不可早於開始日）'; end if;
  if v_limit is not null and (v_limit < 1 or v_limit > 100000) then raise exception '使用上限須為 1～100000 次，或留空表示不限'; end if;
  if exists (select 1 from app_private.coupons where code = v_code and id is distinct from v_id) then
    raise exception '代碼「%」已經存在', v_code;
  end if;
  if v_id is null then
    insert into app_private.coupons (code, description, kind, value, starts_on, ends_on, usage_limit, active, created_by)
      values (v_code, v_description, v_kind, v_value, v_starts, v_ends, v_limit, v_active, auth.uid()) returning id into v_id;
  else
    update app_private.coupons set code = v_code, description = v_description, kind = v_kind, value = v_value,
      starts_on = v_starts, ends_on = v_ends, usage_limit = v_limit, active = v_active, updated_at = now() where id = v_id;
    if not found then raise exception '優惠代碼不存在'; end if;
  end if;
  insert into public.audit_logs (actor_id, action, target_type, target_id, summary)
    values (auth.uid(), 'coupon.saved', 'coupon', v_id, jsonb_build_object('code', v_code, 'kind', v_kind, 'value', v_value,
      'starts_on', v_starts, 'ends_on', v_ends, 'usage_limit', v_limit, 'active', v_active));
  return v_id;
end;
$$;

create or replace function app_private.delete_coupon(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_code text;
begin
  if not app_private.is_admin() then raise exception '只有店長可以刪除優惠代碼' using errcode = '42501'; end if;
  if exists (select 1 from public.sale_coupons where coupon_id = p_id) then
    raise exception '這組代碼已有銷售紀錄，不能刪除；請改用「編輯」取消勾選「啟用」';
  end if;
  delete from app_private.coupons where id = p_id returning code into v_code;
  if not found then raise exception '優惠代碼不存在'; end if;
  insert into public.audit_logs (actor_id, action, target_type, target_id, summary)
    values (auth.uid(), 'coupon.deleted', 'coupon', p_id, jsonb_build_object('code', v_code));
end;
$$;

-- 結帳：再多一個 p_coupon_code。舊的 5 個參數版本移除（避免同名兩版本），新版的後兩個參數都有預設值，
-- 舊網頁用 4 或 5 個參數呼叫都照常可以結帳。
drop function public.create_sale_with_serials(jsonb, uuid, uuid, uuid, jsonb);
drop function app_private.create_sale_with_serials_logged(jsonb, uuid, uuid, uuid, jsonb);

create function app_private.create_sale_with_serials_logged(
  p_lines jsonb, p_customer_id uuid, p_salesperson_id uuid, p_checkout_id uuid, p_promotions jsonb, p_coupon_code text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_name text;
  v_sale_id uuid;
  v_existing_by uuid;
  v_discount numeric;
  v_coupon_discount numeric;
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
  -- 先套特惠組合，再套優惠代碼；任何一項不符合規則就整筆結帳取消（同一個交易）。
  v_discount := app_private.apply_sale_promotions(v_sale_id, coalesce(p_promotions, '[]'::jsonb));
  v_coupon_discount := app_private.apply_sale_coupon(v_sale_id, p_coupon_code);
  insert into public.audit_logs (actor_id, action, target_type, target_id, summary)
    select auth.uid(), 'sale_created', 'sale', v_sale_id,
      jsonb_build_object('sale_number', sale_number, 'total', total)
        || case when v_discount > 0 then jsonb_build_object('promotion_discount', v_discount,
             'promotions', coalesce(p_promotions, '[]'::jsonb)) else '{}'::jsonb end
        || case when v_coupon_discount > 0 then jsonb_build_object('coupon_discount', v_coupon_discount,
             'coupon_code', app_private.normalize_coupon_code(p_coupon_code)) else '{}'::jsonb end
    from public.sales where id = v_sale_id;
  insert into app_private.sale_salesperson_attributions(sale_id, salesperson_id, salesperson_name)
    values (v_sale_id, p_salesperson_id, v_name);
  -- 機車獎金：以台數計算，不受折扣影響；重送同一個 checkout id 會在上面提早 return，所以不會重複記帳。
  perform app_private.record_motorcycle_bonus(v_sale_id);
  return v_sale_id;
end;
$$;

create function public.create_sale_with_serials(
  p_lines jsonb, p_customer_id uuid, p_salesperson_id uuid, p_checkout_id uuid,
  p_promotions jsonb default '[]'::jsonb, p_coupon_code text default null)
returns uuid language sql security invoker set search_path = '' as $$
  select app_private.create_sale_with_serials_logged(p_lines, p_customer_id, p_salesperson_id, p_checkout_id, p_promotions, p_coupon_code)
$$;

create or replace function public.check_coupon(p_code text) returns jsonb
  language sql security invoker set search_path = '' as $$ select app_private.check_coupon(p_code) $$;
create or replace function public.get_coupons() returns jsonb
  language sql security invoker set search_path = '' as $$ select app_private.get_coupons() $$;
create or replace function public.save_coupon(p_coupon jsonb) returns uuid
  language sql security invoker set search_path = '' as $$ select app_private.save_coupon(p_coupon) $$;
create or replace function public.delete_coupon(p_id uuid) returns void
  language sql security invoker set search_path = '' as $$ select app_private.delete_coupon(p_id) $$;

-- 內部函式不開放直接呼叫；網頁只能用下面這幾個。
revoke all on function app_private.normalize_coupon_code(text), app_private.usable_coupon(text, boolean),
  app_private.apply_sale_coupon(uuid, text) from public, anon, authenticated;
revoke all on function app_private.check_coupon(text), app_private.get_coupons(), app_private.save_coupon(jsonb),
  app_private.delete_coupon(uuid), app_private.create_sale_with_serials_logged(jsonb, uuid, uuid, uuid, jsonb, text),
  public.check_coupon(text), public.get_coupons(), public.save_coupon(jsonb), public.delete_coupon(uuid),
  public.create_sale_with_serials(jsonb, uuid, uuid, uuid, jsonb, text) from public, anon;
grant execute on function app_private.check_coupon(text), app_private.get_coupons(), app_private.save_coupon(jsonb),
  app_private.delete_coupon(uuid), app_private.create_sale_with_serials_logged(jsonb, uuid, uuid, uuid, jsonb, text),
  public.check_coupon(text), public.get_coupons(), public.save_coupon(jsonb), public.delete_coupon(uuid),
  public.create_sale_with_serials(jsonb, uuid, uuid, uuid, jsonb, text) to authenticated;
