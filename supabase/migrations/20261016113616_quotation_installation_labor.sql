create table public.shop_settings (
  id integer primary key check (id = 1),
  hourly_rate numeric(12,2) not null default 0 check (hourly_rate >= 0)
);
insert into public.shop_settings(id,hourly_rate) values (1,0);
alter table public.shop_settings enable row level security;
revoke all on public.shop_settings from public,anon,authenticated;
grant select,update(hourly_rate) on public.shop_settings to authenticated;
create policy "active staff read shop settings" on public.shop_settings for select to authenticated
  using ((select app_private.is_active_staff()));
create policy "admins update shop settings" on public.shop_settings for update to authenticated
  using ((select app_private.is_admin())) with check ((select app_private.is_admin()));

alter table public.quotation_lines
  add column installation_required boolean not null default false,
  add column labor_hours numeric(8,2) not null default 0 check (labor_hours >= 0),
  add column hourly_rate numeric(12,2) not null default 0 check (hourly_rate >= 0),
  add column labor_amount numeric(12,2) not null default 0 check (labor_amount >= 0),
  add constraint quotation_labor_consistency check (
    (not installation_required and labor_hours = 0 and hourly_rate = 0 and labor_amount = 0)
    or (installation_required and labor_hours > 0 and hourly_rate > 0 and labor_amount = round(labor_hours * hourly_rate,2))
  );

create function app_private.save_quotation(p_quotation jsonb, p_lines jsonb)
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
  if v_total is distinct from (p_quotation->>'total')::numeric then raise exception '報價總額無效'; end if;
  insert into public.quotations (id,quote_number,customer_id,salesperson_id,total,note,created_by)
  values (v_id,trim(p_quotation->>'number'),v_customer_id,v_salesperson_id,v_total,coalesce(p_quotation->>'note',''),auth.uid());
  for v_line in select value from jsonb_array_elements(p_lines) loop
    select * into v_item from public.items where id=(v_line->>'itemId')::uuid;
    v_quantity := (v_line->>'quantity')::integer;
    v_installed := coalesce((v_line->>'installationRequired')::boolean,false);
    v_hours := coalesce((v_line->>'laborHours')::numeric,0);
    v_rate := coalesce((v_line->>'hourlyRate')::numeric,0);
    v_labor := coalesce((v_line->>'laborAmount')::numeric,0);
    insert into public.quotation_lines(quotation_id,item_id,item_name,quantity,unit_price,subtotal,
      installation_required,labor_hours,hourly_rate,labor_amount)
    values (v_id,v_item.id,v_item.name,v_quantity,v_item.price,v_quantity*v_item.price,
      v_installed,v_hours,v_rate,v_labor);
  end loop;
  return v_id;
end;
$$;

create or replace function public.save_quotation(p_quotation jsonb, p_lines jsonb)
returns uuid language sql security invoker set search_path = '' as $$
  select app_private.save_quotation(p_quotation,p_lines)
$$;

revoke insert,update on public.quotations,public.quotation_lines from authenticated;
revoke all on function app_private.save_quotation(jsonb,jsonb) from public,anon,authenticated;
grant execute on function app_private.save_quotation(jsonb,jsonb) to authenticated;
