alter table public.customers
  add column plate_numbers text[] not null default '{}'::text[];
