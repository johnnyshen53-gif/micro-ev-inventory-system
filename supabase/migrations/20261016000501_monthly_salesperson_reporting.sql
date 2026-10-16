create or replace function app_private.get_monthly_salesperson_performance(p_month text)
returns table (salesperson_id uuid, salesperson_name text, quantity bigint, total numeric)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_start timestamptz;
  v_end timestamptz;
  v_first date;
begin
  if not app_private.is_admin() then
    raise exception '只有店長可以查看業務員績效' using errcode = '42501';
  end if;
  if p_month is null or p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception '月份格式必須為 YYYY-MM';
  end if;
  v_first := make_date(left(p_month, 4)::integer, right(p_month, 2)::integer, 1);
  v_start := v_first::timestamp at time zone 'Asia/Taipei';
  v_end := (v_first + interval '1 month')::timestamp at time zone 'Asia/Taipei';
  return query
    select p.id, coalesce(p.name, '未歸屬'), coalesce(sum(lines.quantity), 0)::bigint, sum(s.total)
    from public.sales s
    left join app_private.sale_salesperson_attributions a on a.sale_id = s.id
    left join public.salespeople p on p.id = a.salesperson_id
    join lateral (
      select sum(sl.quantity)::bigint as quantity from public.sale_lines sl where sl.sale_id = s.id
    ) lines on true
    where s.created_at >= v_start and s.created_at < v_end
    group by p.id, p.name
    order by (p.id is null), sum(s.total) desc, p.name;
end;
$$;

create or replace function public.get_monthly_salesperson_performance(p_month text)
returns table (salesperson_id uuid, salesperson_name text, quantity bigint, total numeric)
language sql stable security invoker set search_path = '' as $$
  select * from app_private.get_monthly_salesperson_performance(p_month)
$$;

revoke all on function app_private.get_monthly_salesperson_performance(text),
  public.get_monthly_salesperson_performance(text) from public, anon, authenticated;
grant execute on function app_private.get_monthly_salesperson_performance(text),
  public.get_monthly_salesperson_performance(text) to authenticated;
