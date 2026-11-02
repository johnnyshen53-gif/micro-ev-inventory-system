-- 銷售日期：結帳時可選「今天或以前」的日期，月報表、業務員績效、保固起算都以這個日期為準。
-- 1. public.sales.sale_date：新欄位。舊銷售單維持空白，月份改用「建立時間的台灣日期」計算（和以前相同）。
-- 2. create_sale_with_serials 新增 7 個參數的版本（多 p_sale_date）；舊的 6 參數版本保留，舊畫面照常可用。
-- 3. 業務員績效與銷售歸屬的月份，改用 coalesce(sale_date, 建立時間的台灣日期)。
alter table public.sales add column sale_date date;
comment on column public.sales.sale_date is '銷售日期（台灣日期）；空白＝舊單，以 created_at 的台灣日期為準';

-- 有效銷售日期：sale_date 優先，空白時用建立時間換算台灣日期。
create or replace function app_private.effective_sale_date(p_sale_date date, p_created_at timestamptz)
returns date language sql immutable set search_path = '' as $$
  select coalesce(p_sale_date, (p_created_at at time zone 'Asia/Taipei')::date)
$$;

create function app_private.create_sale_with_serials_logged(
  p_lines jsonb, p_customer_id uuid, p_salesperson_id uuid, p_checkout_id uuid, p_promotions jsonb, p_coupon_code text, p_sale_date date
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_today date := (now() at time zone 'Asia/Taipei')::date;
  v_existed boolean;
  v_sale_id uuid;
begin
  if p_sale_date is null then raise exception '請填寫銷售日期'; end if;
  if p_sale_date > v_today then raise exception '銷售日期不可晚於今天'; end if;
  if p_sale_date < date '2000-01-01' then raise exception '銷售日期無效'; end if;
  -- 同一個結帳識別碼重送時，原本的函式會直接回傳舊單；舊單的日期不再更動。
  v_existed := exists (select 1 from public.sales where id = p_checkout_id);
  v_sale_id := app_private.create_sale_with_serials_logged(p_lines, p_customer_id, p_salesperson_id, p_checkout_id, p_promotions, p_coupon_code);
  if not v_existed then
    update public.sales set sale_date = p_sale_date where id = v_sale_id;
    -- 保固從銷售日期起算（原本以結帳當天起算）。
    update public.warranties w
      set purchased_at = p_sale_date, expires_at = (p_sale_date + make_interval(months => i.warranty_months))::date
      from public.items i
      where w.sale_id = v_sale_id and i.id = w.item_id and w.purchased_at is distinct from p_sale_date;
  end if;
  return v_sale_id;
end;
$$;

create function public.create_sale_with_serials(
  p_lines jsonb, p_customer_id uuid, p_salesperson_id uuid, p_checkout_id uuid, p_promotions jsonb, p_coupon_code text, p_sale_date date
) returns uuid language sql security invoker set search_path = '' as $$
  select app_private.create_sale_with_serials_logged(p_lines, p_customer_id, p_salesperson_id, p_checkout_id, p_promotions, p_coupon_code, p_sale_date)
$$;

revoke all on function app_private.effective_sale_date(date, timestamptz),
  app_private.create_sale_with_serials_logged(jsonb, uuid, uuid, uuid, jsonb, text, date),
  public.create_sale_with_serials(jsonb, uuid, uuid, uuid, jsonb, text, date) from public, anon;
grant execute on function app_private.effective_sale_date(date, timestamptz),
  app_private.create_sale_with_serials_logged(jsonb, uuid, uuid, uuid, jsonb, text, date),
  public.create_sale_with_serials(jsonb, uuid, uuid, uuid, jsonb, text, date) to authenticated;

create or replace function app_private.get_monthly_sale_assignments(p_month text)
returns table(sale_number text, salesperson_id uuid, salesperson_name text)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_first date;
begin
  if not app_private.is_admin() then
    raise exception '只有店長可以查看銷售歸屬' using errcode = '42501';
  end if;
  if p_month is null or p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception '月份格式必須為 YYYY-MM';
  end if;
  v_first := make_date(left(p_month, 4)::integer, right(p_month, 2)::integer, 1);
  return query
    select s.sale_number, a.salesperson_id, p.name
    from public.sales s
    left join app_private.sale_salesperson_attributions a on a.sale_id = s.id
    left join public.salespeople p on p.id = a.salesperson_id
    where app_private.effective_sale_date(s.sale_date, s.created_at) >= v_first
      and app_private.effective_sale_date(s.sale_date, s.created_at) < (v_first + interval '1 month')::date
    order by app_private.effective_sale_date(s.sale_date, s.created_at), s.created_at, s.sale_number;
end;
$$;

create or replace function app_private.get_monthly_salesperson_performance(p_month text)
returns table(salesperson_id uuid, salesperson_name text, quantity bigint, total numeric)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_first date;
begin
  if not app_private.is_admin() then
    raise exception '只有店長可以查看業務員績效' using errcode = '42501';
  end if;
  if p_month is null or p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception '月份格式必須為 YYYY-MM';
  end if;
  v_first := make_date(left(p_month, 4)::integer, right(p_month, 2)::integer, 1);
  return query
    select p.id, coalesce(p.name, '未歸屬'), coalesce(sum(lines.quantity), 0)::bigint, sum(s.total)
    from public.sales s
    left join app_private.sale_salesperson_attributions a on a.sale_id = s.id
    left join public.salespeople p on p.id = a.salesperson_id
    join lateral (
      select sum(sl.quantity)::bigint as quantity from public.sale_lines sl where sl.sale_id = s.id
    ) lines on true
    where app_private.effective_sale_date(s.sale_date, s.created_at) >= v_first
      and app_private.effective_sale_date(s.sale_date, s.created_at) < (v_first + interval '1 month')::date
    group by p.id, p.name
    order by (p.id is null), sum(s.total) desc, p.name;
end;
$$;
