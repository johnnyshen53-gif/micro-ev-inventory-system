create or replace function app_private.get_monthly_sale_assignments(p_month text)
returns table (sale_number text, salesperson_id uuid, salesperson_name text)
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
    where s.created_at >= v_first::timestamp at time zone 'Asia/Taipei'
      and s.created_at < (v_first + interval '1 month')::timestamp at time zone 'Asia/Taipei'
    order by s.created_at, s.sale_number;
end;
$$;

create or replace function public.get_monthly_sale_assignments(p_month text)
returns table (sale_number text, salesperson_id uuid, salesperson_name text)
language sql stable security invoker set search_path = '' as $$
  select * from app_private.get_monthly_sale_assignments(p_month)
$$;

create or replace function app_private.assign_sale_salesperson(p_sale_number text, p_salesperson_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_sale_id uuid;
  v_name text;
begin
  if not app_private.is_admin() then
    raise exception '只有店長可以補登業務員' using errcode = '42501';
  end if;
  select id into v_sale_id from public.sales where sale_number = p_sale_number for share;
  if not found then raise exception '銷售單不存在，請重新整理'; end if;
  select name into v_name from public.salespeople
    where id = p_salesperson_id and active for share;
  if not found then raise exception '業務員不存在或已停用，請重新選擇'; end if;
  insert into app_private.sale_salesperson_attributions(sale_id, salesperson_id, salesperson_name)
    values (v_sale_id, p_salesperson_id, v_name)
    on conflict (sale_id) do nothing;
  if not found then raise exception '這張銷售單已歸屬業務員，不能重複補登'; end if;
  insert into public.audit_logs(actor_id, action, target_type, target_id, summary)
    values (auth.uid(), 'sale_salesperson_attributed', 'sale', v_sale_id,
      jsonb_build_object('sale_number', p_sale_number, 'salesperson_id', p_salesperson_id));
end;
$$;

create or replace function public.assign_sale_salesperson(p_sale_number text, p_salesperson_id uuid)
returns void language sql security invoker set search_path = '' as $$
  select app_private.assign_sale_salesperson(p_sale_number, p_salesperson_id)
$$;

revoke all on function app_private.get_monthly_sale_assignments(text),
  public.get_monthly_sale_assignments(text),
  app_private.assign_sale_salesperson(text,uuid),
  public.assign_sale_salesperson(text,uuid) from public, anon, authenticated;
grant execute on function app_private.get_monthly_sale_assignments(text),
  public.get_monthly_sale_assignments(text),
  app_private.assign_sale_salesperson(text,uuid),
  public.assign_sale_salesperson(text,uuid) to authenticated;
