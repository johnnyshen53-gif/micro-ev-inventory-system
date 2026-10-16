create table app_private.sale_salesperson_attributions (
  sale_id uuid primary key references public.sales(id) on delete cascade,
  salesperson_id uuid not null references public.salespeople(id),
  salesperson_name text not null check (length(trim(salesperson_name)) > 0)
);

alter table app_private.sale_salesperson_attributions enable row level security;
revoke all on table app_private.sale_salesperson_attributions from public, anon, authenticated;

create or replace function app_private.create_sale_with_serials_logged(
  p_lines jsonb, p_customer_id uuid, p_salesperson_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_name text;
  v_sale_id uuid;
begin
  if p_salesperson_id is null then raise exception '結帳時請選擇業務員'; end if;
  select name into v_name from public.salespeople
    where id = p_salesperson_id and active for share;
  if not found then raise exception '業務員不存在或已停用，請重新選擇'; end if;
  v_sale_id := app_private.create_sale_with_serials_logged(p_lines, p_customer_id);
  insert into app_private.sale_salesperson_attributions(sale_id, salesperson_id, salesperson_name)
    values (v_sale_id, p_salesperson_id, v_name);
  return v_sale_id;
end;
$$;

create or replace function public.create_sale_with_serials(
  p_lines jsonb, p_customer_id uuid, p_salesperson_id uuid)
returns uuid language sql security invoker set search_path = '' as $$
  select app_private.create_sale_with_serials_logged(p_lines, p_customer_id, p_salesperson_id)
$$;

create or replace function public.create_sale_with_serials(p_lines jsonb, p_customer_id uuid)
returns uuid language plpgsql security invoker set search_path = '' as $$
begin
  raise exception '請重新整理頁面並選擇業務員後再結帳';
end;
$$;

create or replace function public.create_sale(p_lines jsonb, p_customer_id uuid)
returns uuid language plpgsql security invoker set search_path = '' as $$
begin
  raise exception '請重新整理頁面並選擇業務員後再結帳';
end;
$$;

create or replace function public.create_sale(p_lines jsonb)
returns uuid language plpgsql security invoker set search_path = '' as $$
begin
  raise exception '請重新整理頁面並選擇業務員後再結帳';
end;
$$;

revoke all on function app_private.create_sale(jsonb), app_private.create_sale(jsonb,uuid),
  app_private.create_sale_with_serials(jsonb,uuid),
  app_private.create_sale_with_serials_logged(jsonb,uuid)
  from public, anon, authenticated;
revoke all on function app_private.create_sale_with_serials_logged(jsonb,uuid,uuid),
  public.create_sale_with_serials(jsonb,uuid,uuid) from public, anon, authenticated;
grant execute on function app_private.create_sale_with_serials_logged(jsonb,uuid,uuid),
  public.create_sale_with_serials(jsonb,uuid,uuid) to authenticated;
