-- 機車銷售獎金與維修分紅：資料表。
-- 設定、名單與分紅快照都放在 app_private（Data API 不公開），只能經由店長專用 RPC 讀寫。

-- 1. 維修人員：獨立名單，不與業務員或登入帳號混用。在職員工可讀姓名以便在維修單選擇；寫入只能透過店長 RPC。
create table public.repair_technicians (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  active boolean not null default true,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.repair_technicians enable row level security;
revoke all on public.repair_technicians from public, anon, authenticated;
grant select on public.repair_technicians to authenticated;
create policy "active staff read repair technicians" on public.repair_technicians for select to authenticated
  using ((select app_private.is_active_staff()));

alter table public.repair_orders add column technician_id uuid references public.repair_technicians(id);
create index repair_orders_technician_idx on public.repair_orders(technician_id);

-- 2. 成本已確認：item_costs.cost 預設 0，無法分辨「沒填」與「真的 0 元」，由店長明確確認。
alter table public.item_costs add column cost_confirmed boolean not null default false;

-- 3. 全店設定（單列）。null＝未設定（不記帳）；0＝明確不發。
create table app_private.bonus_settings (
  id boolean primary key default true check (id),
  motorcycle_bonus_amount numeric(12,2) check (motorcycle_bonus_amount >= 0),
  repair_bonus_percent numeric(5,2) check (repair_bonus_percent between 0 and 100),
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);
insert into app_private.bonus_settings (id) values (true);

-- 4. 機車獎金受領業務員名單、適用品項。
create table app_private.motorcycle_bonus_recipients (
  salesperson_id uuid primary key references public.salespeople(id)
);
create table app_private.motorcycle_bonus_items (
  item_id uuid primary key references public.items(id) on delete cascade
);

-- 5. 分紅快照：成立當下的金額、百分比、數量、成本與姓名，之後改設定也不重算。
create table app_private.sale_bonus_records (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id),
  sale_number text not null,
  salesperson_id uuid not null references public.salespeople(id),
  salesperson_name text not null,
  units integer not null check (units > 0),
  unit_amount numeric(12,2) not null check (unit_amount >= 0),
  bonus_amount numeric(12,2) not null check (bonus_amount >= 0),
  lines jsonb not null default '[]'::jsonb,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (sale_id, salesperson_id)
);
create index sale_bonus_records_occurred_idx on app_private.sale_bonus_records(occurred_at);

create table app_private.repair_bonus_records (
  repair_order_id uuid primary key references public.repair_orders(id),
  repair_number text not null,
  technician_id uuid not null references public.repair_technicians(id),
  technician_name text not null,
  repair_total numeric(12,2) not null,
  parts_cost numeric(12,2) not null,
  net_amount numeric(12,2) not null check (net_amount >= 0),
  bonus_percent numeric(5,2) not null,
  bonus_amount numeric(12,2) not null check (bonus_amount >= 0),
  cost_lines jsonb not null default '[]'::jsonb,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index repair_bonus_records_occurred_idx on app_private.repair_bonus_records(occurred_at);

revoke all on app_private.bonus_settings, app_private.motorcycle_bonus_recipients, app_private.motorcycle_bonus_items,
  app_private.sale_bonus_records, app_private.repair_bonus_records from public, anon, authenticated;
