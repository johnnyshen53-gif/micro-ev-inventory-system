-- Applied through the connected Supabase management API; filename matches its live version.

create table if not exists public.suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  contact text not null default '',
  phone text not null default '',
  address text not null default '',
  tax_id text not null default '' check (tax_id = '' or tax_id ~ '^[0-9]{8}$'),
  note text not null default '',
  active boolean not null default true,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.items add column if not exists supplier_id uuid references public.suppliers(id);

create table if not exists public.purchases (
  id uuid primary key default gen_random_uuid(),
  purchase_number text not null unique,
  supplier_id uuid not null references public.suppliers(id),
  supplier_snapshot jsonb not null,
  status text not null default 'draft' check (status in ('draft', 'received')),
  payment_status text not null default 'unpaid' check (payment_status in ('unpaid', 'paid')),
  total numeric(12,2) not null default 0 check (total >= 0),
  note text not null default '',
  created_by uuid not null references public.profiles(id),
  received_by uuid references public.profiles(id),
  paid_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  received_at timestamptz,
  paid_at timestamptz
);

create table if not exists public.purchase_lines (
  id uuid primary key default gen_random_uuid(),
  purchase_id uuid not null references public.purchases(id) on delete cascade,
  item_id uuid not null references public.items(id),
  item_name text not null,
  item_sku text not null default '',
  quantity integer not null check (quantity > 0),
  unit_cost numeric(12,2) not null check (unit_cost >= 0),
  subtotal numeric(12,2) not null check (subtotal >= 0)
);

create table if not exists public.inventory_serials (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.items(id),
  serial_number text not null unique check (length(trim(serial_number)) > 0),
  status text not null check (status in ('in_stock', 'sold', 'removed', 'warranty_out')),
  purchase_id uuid references public.purchases(id),
  sale_id uuid references public.sales(id),
  customer_id uuid references public.customers(id),
  warranty_id uuid references public.warranties(id),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  sold_at timestamptz
);

create table if not exists public.app_migrations (
  module text primary key check (module in ('cloud_operations')),
  migrated_by uuid not null references public.profiles(id),
  migrated_at timestamptz not null default now(),
  source_fingerprint text not null
);

create index if not exists items_supplier_id_idx on public.items(supplier_id);
create index if not exists purchases_supplier_id_idx on public.purchases(supplier_id);
create index if not exists purchases_status_idx on public.purchases(status, payment_status);
create index if not exists purchase_lines_purchase_id_idx on public.purchase_lines(purchase_id);
create index if not exists inventory_serials_item_id_idx on public.inventory_serials(item_id);
create index if not exists inventory_serials_purchase_id_idx on public.inventory_serials(purchase_id);

drop trigger if exists suppliers_updated on public.suppliers;
create trigger suppliers_updated before update on public.suppliers for each row execute procedure public.touch_updated_at();
drop trigger if exists purchases_updated on public.purchases;
create trigger purchases_updated before update on public.purchases for each row execute procedure public.touch_updated_at();
drop trigger if exists suppliers_created_by_immutable on public.suppliers;
create trigger suppliers_created_by_immutable before update on public.suppliers for each row execute procedure public.keep_created_by();
drop trigger if exists purchases_created_by_immutable on public.purchases;
create trigger purchases_created_by_immutable before update on public.purchases for each row execute procedure public.keep_created_by();

alter table public.suppliers enable row level security;
alter table public.purchases enable row level security;
alter table public.purchase_lines enable row level security;
alter table public.inventory_serials enable row level security;
alter table public.app_migrations enable row level security;

revoke all on public.suppliers, public.purchases, public.purchase_lines, public.inventory_serials, public.app_migrations from public, anon, authenticated;
grant select, insert, update, delete on public.suppliers, public.purchases, public.purchase_lines, public.inventory_serials, public.app_migrations to authenticated;

drop policy if exists "admins manage suppliers" on public.suppliers;
create policy "admins manage suppliers" on public.suppliers for all to authenticated
  using ((select app_private.is_admin())) with check ((select app_private.is_admin()));
drop policy if exists "admins manage purchases" on public.purchases;
create policy "admins manage purchases" on public.purchases for all to authenticated
  using ((select app_private.is_admin())) with check ((select app_private.is_admin()));
drop policy if exists "admins manage purchase lines" on public.purchase_lines;
create policy "admins manage purchase lines" on public.purchase_lines for all to authenticated
  using ((select app_private.is_admin())) with check ((select app_private.is_admin()));
drop policy if exists "active staff read inventory serials" on public.inventory_serials;
create policy "active staff read inventory serials" on public.inventory_serials for select to authenticated
  using ((select app_private.is_active_staff()));
drop policy if exists "admins manage inventory serials" on public.inventory_serials;
create policy "admins manage inventory serials" on public.inventory_serials for all to authenticated
  using ((select app_private.is_admin())) with check ((select app_private.is_admin()));
drop policy if exists "admins manage app migrations" on public.app_migrations;
create policy "admins manage app migrations" on public.app_migrations for all to authenticated
  using ((select app_private.is_admin())) with check ((select app_private.is_admin()));
