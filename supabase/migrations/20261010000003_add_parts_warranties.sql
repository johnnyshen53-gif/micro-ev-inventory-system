-- Also embedded in the base migration so a fresh schema has the same warranty contract.
alter table public.items add column if not exists warranty_months integer not null default 0 check (warranty_months >= 0);
alter table public.sales add column if not exists customer_id uuid references public.customers(id);

create table if not exists public.warranties (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id),
  customer_name text not null check (length(trim(customer_name)) > 0),
  item_id uuid not null references public.items(id),
  item_name text not null check (length(trim(item_name)) > 0),
  barcode text not null default '',
  source text not null default 'manual' check (source in ('sale', 'manual')),
  sale_id uuid references public.sales(id),
  sale_line_id uuid unique references public.sale_lines(id),
  sale_number text not null default '',
  purchased_at date not null,
  expires_at date not null check (expires_at >= purchased_at),
  note text not null default '',
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((source = 'sale' and sale_id is not null and sale_line_id is not null)
    or (source = 'manual' and sale_id is null and sale_line_id is null))
);

create table if not exists public.warranty_cases (
  id uuid primary key default gen_random_uuid(),
  warranty_id uuid not null references public.warranties(id) on delete cascade,
  issue text not null check (length(trim(issue)) > 0),
  status text not null default 'pending' check (status in ('pending', 'in_progress', 'completed', 'not_covered')),
  handled_at date,
  resolution_note text not null default '',
  item_name text not null check (length(trim(item_name)) > 0),
  purchased_at date not null,
  expires_at date not null check (expires_at >= purchased_at),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists warranties_customer_id_idx on public.warranties(customer_id);
create index if not exists warranties_item_id_idx on public.warranties(item_id);
create index if not exists warranties_sale_id_idx on public.warranties(sale_id);
create index if not exists warranty_cases_warranty_id_idx on public.warranty_cases(warranty_id);

drop trigger if exists warranties_updated on public.warranties;
create trigger warranties_updated before update on public.warranties for each row execute procedure public.touch_updated_at();
drop trigger if exists warranty_cases_updated on public.warranty_cases;
create trigger warranty_cases_updated before update on public.warranty_cases for each row execute procedure public.touch_updated_at();
drop trigger if exists warranties_created_by_immutable on public.warranties;
create trigger warranties_created_by_immutable before update on public.warranties for each row execute procedure public.keep_created_by();
drop trigger if exists warranty_cases_created_by_immutable on public.warranty_cases;
create trigger warranty_cases_created_by_immutable before update on public.warranty_cases for each row execute procedure public.keep_created_by();

alter table public.warranties enable row level security;
alter table public.warranty_cases enable row level security;
revoke all on public.warranties, public.warranty_cases from public, anon, authenticated;
-- Both staff roles use authenticated; DELETE is restricted to admins by the policies below.
grant select, insert, update, delete on public.warranties, public.warranty_cases to authenticated;

drop policy if exists "active staff read warranties" on public.warranties;
create policy "active staff read warranties" on public.warranties for select to authenticated using ((select app_private.is_active_staff()));
drop policy if exists "active staff create warranties" on public.warranties;
create policy "active staff create warranties" on public.warranties for insert to authenticated with check ((select app_private.is_active_staff()) and created_by = (select auth.uid()));
drop policy if exists "active staff update warranties" on public.warranties;
create policy "active staff update warranties" on public.warranties for update to authenticated using ((select app_private.is_active_staff())) with check ((select app_private.is_active_staff()));
drop policy if exists "admins delete warranties" on public.warranties;
create policy "admins delete warranties" on public.warranties for delete to authenticated using ((select app_private.is_admin()));
drop policy if exists "active staff read warranty cases" on public.warranty_cases;
create policy "active staff read warranty cases" on public.warranty_cases for select to authenticated using ((select app_private.is_active_staff()));
drop policy if exists "active staff create warranty cases" on public.warranty_cases;
create policy "active staff create warranty cases" on public.warranty_cases for insert to authenticated with check ((select app_private.is_active_staff()) and created_by = (select auth.uid()));
drop policy if exists "active staff update warranty cases" on public.warranty_cases;
create policy "active staff update warranty cases" on public.warranty_cases for update to authenticated using ((select app_private.is_active_staff())) with check ((select app_private.is_active_staff()));
drop policy if exists "admins delete warranty cases" on public.warranty_cases;
create policy "admins delete warranty cases" on public.warranty_cases for delete to authenticated using ((select app_private.is_admin()));

create or replace function app_private.create_sale(p_lines jsonb, p_customer_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_sale_id uuid := gen_random_uuid();
  v_sale_number text := 'S' || to_char(now(), 'YYYYMMDDHH24MISSMS') || '-' || substr(replace(v_sale_id::text, '-', ''), 1, 6);
  v_line jsonb;
  v_item public.items%rowtype;
  v_line_id uuid;
  v_customer_name text;
  v_purchased_at date := (now() at time zone 'Asia/Taipei')::date;
  v_quantity integer;
  v_total numeric(12,2) := 0;
begin
  if not app_private.is_active_staff() then raise exception '帳號已停用或沒有權限'; end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then raise exception '銷售品項不可空白'; end if;
  if jsonb_array_length(p_lines) = 0 then raise exception '銷售品項不可空白'; end if;
  if p_customer_id is not null then
    select name into v_customer_name from public.customers where id = p_customer_id;
    if not found then raise exception '找不到客戶'; end if;
  end if;
  -- The parent must exist before sale_lines' immediate foreign key is checked.
  insert into public.sales (id, sale_number, total, customer_id, created_by)
    values (v_sale_id, v_sale_number, 0, p_customer_id, auth.uid());
  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_quantity := (v_line ->> 'quantity')::integer;
    if v_quantity is null or v_quantity <= 0 then raise exception '銷售數量必須大於零'; end if;
    select * into v_item from public.items where id = (v_line ->> 'item_id')::uuid for update;
    if not found then raise exception '找不到品項'; end if;
    if v_item.stock < v_quantity then raise exception '庫存不足：%', v_item.name; end if;
    update public.items set stock = stock - v_quantity where id = v_item.id;
    insert into public.sale_lines (sale_id, item_id, item_name, barcode, quantity, unit_price, subtotal)
      values (v_sale_id, v_item.id, v_item.name, v_item.barcode, v_quantity, v_item.price, v_item.price * v_quantity)
      returning id into v_line_id;
    if p_customer_id is not null and v_item.warranty_months > 0 then
      insert into public.warranties (customer_id, customer_name, item_id, item_name, barcode, source,
        sale_id, sale_line_id, sale_number, purchased_at, expires_at, created_by)
        values (p_customer_id, v_customer_name, v_item.id, v_item.name, v_item.barcode, 'sale',
          v_sale_id, v_line_id, v_sale_number, v_purchased_at,
          (v_purchased_at + make_interval(months => v_item.warranty_months))::date, auth.uid());
    end if;
    insert into public.inventory_transactions (item_id, type, quantity, note, created_by)
      values (v_item.id, 'out', v_quantity, '銷售管理 ' || v_sale_number, auth.uid());
    v_total := v_total + v_item.price * v_quantity;
  end loop;
  update public.sales set total = v_total where id = v_sale_id;
  insert into public.audit_logs (actor_id, action, target_type, target_id, summary)
    values (auth.uid(), 'sale_created', 'sale', v_sale_id, jsonb_build_object('sale_number', v_sale_number, 'total', v_total));
  return v_sale_id;
end;
$$;

create or replace function public.create_sale(p_lines jsonb, p_customer_id uuid)
returns uuid language sql security invoker set search_path = '' as $$
  select app_private.create_sale(p_lines, p_customer_id)
$$;

-- Keep callers and historical migrations using the original signature compatible.
create or replace function app_private.create_sale(p_lines jsonb)
returns uuid language sql security invoker set search_path = '' as $$
  select app_private.create_sale(p_lines, null::uuid)
$$;
create or replace function public.create_sale(p_lines jsonb)
returns uuid language sql security invoker set search_path = '' as $$
  select app_private.create_sale(p_lines, null::uuid)
$$;
revoke all on function app_private.create_sale(jsonb, uuid), public.create_sale(jsonb, uuid),
  app_private.create_sale(jsonb), public.create_sale(jsonb) from public, anon, authenticated;
grant execute on function app_private.create_sale(jsonb, uuid), public.create_sale(jsonb, uuid),
  app_private.create_sale(jsonb), public.create_sale(jsonb) to authenticated;

