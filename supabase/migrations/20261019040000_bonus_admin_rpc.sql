-- 分紅管理：店長專用 RPC。每個函式開頭都檢查店長身分，一般員工直接呼叫也會得到 42501。

-- 1. 讀取設定頁需要的全部資料。
create or replace function app_private.get_bonus_admin_state()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not app_private.is_admin() then raise exception '只有店長可以查看分紅設定' using errcode = '42501'; end if;
  return jsonb_build_object(
    'motorcycleBonusAmount', (select motorcycle_bonus_amount from app_private.bonus_settings where id),
    'repairBonusPercent', (select repair_bonus_percent from app_private.bonus_settings where id),
    'recipientIds', coalesce((select jsonb_agg(salesperson_id order by salesperson_id) from app_private.motorcycle_bonus_recipients), '[]'::jsonb),
    'motorcycleItemIds', coalesce((select jsonb_agg(item_id order by item_id) from app_private.motorcycle_bonus_items), '[]'::jsonb),
    'partCosts', coalesce((select jsonb_agg(jsonb_build_object('itemId', i.id, 'name', i.name, 'category', i.category,
        'cost', c.cost, 'confirmed', coalesce(c.cost_confirmed, false)) order by i.category, i.name)
      from public.items i left join public.item_costs c on c.item_id = i.id
      where i.category in ('零件','用品','電池')), '[]'::jsonb),
    'technicians', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'active', active) order by active desc, name)
      from public.repair_technicians), '[]'::jsonb));
end;
$$;

-- 2. 儲存設定：金額／百分比 null＝未設定；名單與適用品項整批取代。只影響之後成立的分紅。
create or replace function app_private.save_bonus_settings(p_motorcycle_amount numeric, p_repair_percent numeric,
  p_recipient_ids uuid[], p_motorcycle_item_ids uuid[])
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not app_private.is_admin() then raise exception '只有店長可以修改分紅設定' using errcode = '42501'; end if;
  if p_motorcycle_amount < 0 then raise exception '每台機車獎金不可為負數'; end if;
  if p_repair_percent < 0 or p_repair_percent > 100 then raise exception '維修分紅百分比須介於 0～100'; end if;
  update app_private.bonus_settings set motorcycle_bonus_amount = round(p_motorcycle_amount, 2),
    repair_bonus_percent = round(p_repair_percent, 2), updated_by = auth.uid(), updated_at = clock_timestamp() where id;
  delete from app_private.motorcycle_bonus_recipients;
  insert into app_private.motorcycle_bonus_recipients(salesperson_id)
    select distinct unnest(coalesce(p_recipient_ids, '{}'));
  delete from app_private.motorcycle_bonus_items;
  insert into app_private.motorcycle_bonus_items(item_id)
    select distinct unnest(coalesce(p_motorcycle_item_ids, '{}'));
  insert into public.audit_logs(actor_id, action, target_type, target_id, summary)
    values (auth.uid(), 'bonus.settings_saved', 'bonus_settings', null, jsonb_build_object(
      'motorcycle_bonus_amount', p_motorcycle_amount, 'repair_bonus_percent', p_repair_percent,
      'recipients', coalesce(array_length(p_recipient_ids, 1), 0), 'items', coalesce(array_length(p_motorcycle_item_ids, 1), 0)));
end;
$$;

-- 3. 確認（或取消確認）用料成本。沒有成本資料列的品項以 0 元建立。
create or replace function app_private.set_item_costs_confirmed(p_item_ids uuid[], p_confirmed boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not app_private.is_admin() then raise exception '只有店長可以確認成本' using errcode = '42501'; end if;
  insert into public.item_costs(item_id, cost, cost_confirmed, updated_by)
    select i.id, 0, coalesce(p_confirmed, false), auth.uid() from public.items i where i.id = any(coalesce(p_item_ids, '{}'))
  on conflict (item_id) do update set cost_confirmed = excluded.cost_confirmed, updated_by = auth.uid(), updated_at = now();
end;
$$;

-- 4. 新增／修改／停用維修人員（p_id 為 null 時新增）。
create or replace function app_private.save_repair_technician(p_id uuid, p_name text, p_active boolean)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid := p_id;
begin
  if not app_private.is_admin() then raise exception '只有店長可以管理維修人員' using errcode = '42501'; end if;
  if length(trim(coalesce(p_name, ''))) = 0 then raise exception '請填維修人員姓名'; end if;
  if v_id is null then
    insert into public.repair_technicians(name, active, created_by) values (trim(p_name), coalesce(p_active, true), auth.uid())
      returning id into v_id;
  else
    update public.repair_technicians set name = trim(p_name), active = coalesce(p_active, true), updated_at = clock_timestamp()
      where id = v_id;
    if not found then raise exception '維修人員不存在'; end if;
  end if;
  return v_id;
end;
$$;

-- 5. 月份報表：直接加總已記帳快照，不依目前設定重算。月份以台灣時間歸屬。
create or replace function app_private.get_monthly_bonus_report(p_month text)
returns table(kind text, person_id uuid, person_name text, source_number text, occurred_at timestamptz,
  base_amount numeric, bonus_amount numeric)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_first date;
  v_start timestamptz;
  v_end timestamptz;
begin
  if not app_private.is_admin() then raise exception '只有店長可以查看分紅' using errcode = '42501'; end if;
  if p_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then raise exception '月份格式須為 YYYY-MM'; end if;
  v_first := (p_month || '-01')::date;
  v_start := v_first::timestamp at time zone 'Asia/Taipei';
  v_end := (v_first + interval '1 month')::timestamp at time zone 'Asia/Taipei';
  return query
    select 'motorcycle'::text, s.salesperson_id, s.salesperson_name, s.sale_number, s.occurred_at,
      (s.units * s.unit_amount)::numeric, s.bonus_amount::numeric
      from app_private.sale_bonus_records s where s.occurred_at >= v_start and s.occurred_at < v_end
    union all
    select 'repair'::text, r.technician_id, r.technician_name, r.repair_number, r.occurred_at,
      r.net_amount::numeric, r.bonus_amount::numeric
      from app_private.repair_bonus_records r where r.occurred_at >= v_start and r.occurred_at < v_end
    order by 5, 4;
end;
$$;

-- public 包裝（security invoker）：只有登入者可呼叫，實際權限由上面的店長檢查決定。
create or replace function public.get_bonus_admin_state() returns jsonb
  language sql security invoker set search_path = '' as $$ select app_private.get_bonus_admin_state() $$;
create or replace function public.save_bonus_settings(p_motorcycle_amount numeric, p_repair_percent numeric,
  p_recipient_ids uuid[], p_motorcycle_item_ids uuid[]) returns void
  language sql security invoker set search_path = '' as $$
  select app_private.save_bonus_settings(p_motorcycle_amount, p_repair_percent, p_recipient_ids, p_motorcycle_item_ids) $$;
create or replace function public.set_item_costs_confirmed(p_item_ids uuid[], p_confirmed boolean) returns void
  language sql security invoker set search_path = '' as $$ select app_private.set_item_costs_confirmed(p_item_ids, p_confirmed) $$;
create or replace function public.save_repair_technician(p_id uuid, p_name text, p_active boolean) returns uuid
  language sql security invoker set search_path = '' as $$ select app_private.save_repair_technician(p_id, p_name, p_active) $$;
create or replace function public.get_monthly_bonus_report(p_month text)
  returns table(kind text, person_id uuid, person_name text, source_number text, occurred_at timestamptz,
    base_amount numeric, bonus_amount numeric)
  language sql security invoker set search_path = '' as $$ select * from app_private.get_monthly_bonus_report(p_month) $$;

revoke all on function
  app_private.get_bonus_admin_state(), app_private.save_bonus_settings(numeric, numeric, uuid[], uuid[]),
  app_private.set_item_costs_confirmed(uuid[], boolean), app_private.save_repair_technician(uuid, text, boolean),
  app_private.get_monthly_bonus_report(text),
  public.get_bonus_admin_state(), public.save_bonus_settings(numeric, numeric, uuid[], uuid[]),
  public.set_item_costs_confirmed(uuid[], boolean), public.save_repair_technician(uuid, text, boolean),
  public.get_monthly_bonus_report(text)
  from public, anon;
grant execute on function
  app_private.get_bonus_admin_state(), app_private.save_bonus_settings(numeric, numeric, uuid[], uuid[]),
  app_private.set_item_costs_confirmed(uuid[], boolean), app_private.save_repair_technician(uuid, text, boolean),
  app_private.get_monthly_bonus_report(text),
  public.get_bonus_admin_state(), public.save_bonus_settings(numeric, numeric, uuid[], uuid[]),
  public.set_item_costs_confirmed(uuid[], boolean), public.save_repair_technician(uuid, text, boolean),
  public.get_monthly_bonus_report(text)
  to authenticated;
