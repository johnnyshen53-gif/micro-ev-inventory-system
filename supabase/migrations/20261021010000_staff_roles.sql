-- 店員身分：同一位店員可同時是「業務員」與「維修員」。分紅原則不變。
-- 原本的業務員名單（public.salespeople）升級為店員名單；原本獨立的維修人員名單併入。

-- 1. 店員身分欄位。既有業務員預設為「業務員」。
alter table public.salespeople
  add column is_sales boolean not null default true,
  add column is_technician boolean not null default false;

-- 2. 維修人員改指向店員名單：先拿掉舊的外鍵，搬完資料再接回新的外鍵。
alter table public.repair_orders drop constraint repair_orders_technician_id_fkey;
alter table app_private.repair_bonus_records drop constraint repair_bonus_records_technician_id_fkey;

-- 3. 搬移維修人員：姓名（去除前後空白）與「唯一一位」店員相同就視為同一人並合併；
--    其他人以原本的 ID 新增為只有「維修員」身分的店員（ID 不變，維修單與分紅紀錄不用改）。
do $$
declare
  v_tech record;
  v_count integer;
  v_match uuid;
begin
  for v_tech in select * from public.repair_technicians order by created_at, id loop
    select count(*), min(id::text)::uuid into v_count, v_match from public.salespeople
      where trim(name) = trim(v_tech.name) and id <> v_tech.id;
    if v_count = 1 then
      -- 合併：保留兩份名單原本的在職狀態（UPDATE 右側讀到的都是更新前的值）。
      --   業務在職＋維修在職 → 在職、兩個身分；業務在職＋維修停用 → 在職、只有業務員；
      --   業務停用＋維修在職 → 在職、只有維修員（不會回到結帳選單）；兩邊都停用 → 停用、保留兩個身分。
      update public.salespeople set
        is_technician = case when active = v_tech.active then true else v_tech.active end,
        is_sales = case when active = v_tech.active then is_sales else active end,
        active = active or v_tech.active
        where id = v_match;
      update public.repair_orders set technician_id = v_match where technician_id = v_tech.id;
      update app_private.repair_bonus_records set technician_id = v_match where technician_id = v_tech.id;
    else
      insert into public.salespeople(id, name, active, is_sales, is_technician, created_by, created_at, updated_at)
        values (v_tech.id, v_tech.name, v_tech.active, false, true, v_tech.created_by, v_tech.created_at, v_tech.updated_at);
    end if;
  end loop;
end $$;

-- 4. 至少一個身分；維修人員外鍵改指向店員。
alter table public.salespeople add constraint salespeople_role_check check (is_sales or is_technician);
alter table public.repair_orders add constraint repair_orders_technician_id_fkey
  foreign key (technician_id) references public.salespeople(id);
alter table app_private.repair_bonus_records add constraint repair_bonus_records_technician_id_fkey
  foreign key (technician_id) references public.salespeople(id);

-- 5. 舊的維修人員表移到私有區封存（保留原始資料，不刪除），原位置改成唯讀檢視，
--    讓部署空檔中還沒更新的網頁仍讀得到維修人員。檢視以呼叫者權限執行，沿用店員名單的讀取權限。
alter table public.repair_technicians set schema app_private;
alter table app_private.repair_technicians rename to repair_technicians_archived;
revoke all on app_private.repair_technicians_archived from public, anon, authenticated;
create view public.repair_technicians with (security_invoker = true) as
  select id, name, active from public.salespeople where is_technician;
revoke all on public.repair_technicians from public, anon, authenticated;
grant select on public.repair_technicians to authenticated;

-- 6. 維修人員改由店員管理頁維護，原本的店長 RPC 移除。
drop function public.save_repair_technician(uuid, text, boolean);
drop function app_private.save_repair_technician(uuid, text, boolean);

-- 7. 以下函式內容與前一版相同，只把「維修人員名單」換成「勾選維修員身分的店員」，
--    並要求業務員必須勾選「業務員」身分。
create or replace function app_private.save_repair_order(p_order jsonb, p_lines jsonb, p_expected_updated_at timestamptz default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := nullif(p_order->>'id','')::uuid;
  v_customer_id uuid := nullif(p_order->>'customerId','')::uuid;
  v_customer_name text := trim(coalesce(p_order->>'customerName',''));
  v_customer_phone text := trim(coalesce(p_order->>'customerPhone',''));
  v_plate text := trim(coalesce(p_order->>'plateNumber',''));
  v_serial text := trim(coalesce(p_order->>'originalSerialNumber',''));
  v_vehicle text := trim(coalesce(p_order->>'vehicleName',''));
  v_issue text := trim(coalesce(p_order->>'issue',''));
  v_diagnosis text := trim(coalesce(p_order->>'diagnosis',''));
  v_labor numeric(12,2) := coalesce((p_order->>'laborAmount')::numeric,0);
  v_status text := coalesce(p_order->>'status','intake');
  v_technician uuid := nullif(p_order->>'technicianId','')::uuid;
  v_old public.repair_orders%rowtype;
  v_item public.items%rowtype;
  v_line jsonb;
  v_quantity integer;
  v_price numeric(12,2);
  v_total numeric(12,2);
  v_number bigint;
begin
  if not app_private.is_active_staff() then raise exception '帳號權限不足' using errcode = '42501'; end if;
  if jsonb_typeof(p_lines) is distinct from 'array' or v_plate = '' and v_serial = ''
    or v_vehicle = '' or v_issue = '' or v_labor < 0 or v_status not in ('intake','quoted') then
    raise exception '維修單資料無效';
  end if;
  if v_customer_id is not null then
    select name, phone into v_customer_name, v_customer_phone from public.customers
      where id = v_customer_id and active;
    if not found then raise exception '會員不存在或已停用'; end if;
  end if;
  if v_customer_name = '' or v_customer_phone = '' then raise exception '請填客戶姓名與電話'; end if;
  if v_id is null then
    if v_status <> 'intake' then raise exception '新維修單必須先接修'; end if;
    -- 維修人員儲存時可空白（完工時才必選）；有選就必須在職。
    if v_technician is not null then
      perform 1 from public.salespeople where id = v_technician and active and is_technician;
      if not found then raise exception '維修人員不存在、已停用或未勾選維修員身分，請重新選擇'; end if;
    end if;
    v_id := gen_random_uuid();
    v_number := nextval('public.repair_order_number_seq');
    insert into public.repair_orders(id,repair_number,customer_id,customer_name,customer_phone,
      plate_number,original_serial_number,vehicle_name,issue,diagnosis,labor_amount,technician_id,created_by,updated_by)
    values (v_id,'R-' || to_char(now() at time zone 'Asia/Taipei','YYYYMMDD') || '-' ||
      lpad(v_number::text,greatest(4,length(v_number::text)),'0'),v_customer_id,v_customer_name,v_customer_phone,
      v_plate,v_serial,v_vehicle,v_issue,v_diagnosis,v_labor,v_technician,auth.uid(),auth.uid());
  else
    select * into v_old from public.repair_orders where id = v_id for update;
    if not found or v_old.status not in ('intake','quoted') then raise exception '維修單不存在或已鎖定'; end if;
    if p_expected_updated_at is null or v_old.updated_at <> p_expected_updated_at then
      raise exception '維修單已由其他人修改，請重新載入';
    end if;
    if v_old.status = 'quoted' and v_status = 'intake' then raise exception '已報價維修單不可退回接修中'; end if;
    -- 維修人員同理：換人時才檢查在職。
    if v_technician is not null and v_technician is distinct from v_old.technician_id then
      perform 1 from public.salespeople where id = v_technician and active and is_technician;
      if not found then raise exception '維修人員不存在、已停用或未勾選維修員身分，請重新選擇'; end if;
    end if;
    update public.repair_orders set customer_id=v_customer_id,customer_name=v_customer_name,customer_phone=v_customer_phone,
      plate_number=v_plate,original_serial_number=v_serial,vehicle_name=v_vehicle,issue=v_issue,
      diagnosis=v_diagnosis,labor_amount=v_labor,technician_id=v_technician,status=v_status,updated_by=auth.uid(),updated_at=clock_timestamp(),
      quoted_by=case when v_old.status='intake' and v_status='quoted' then auth.uid() else quoted_by end,
      quoted_at=case when v_old.status='intake' and v_status='quoted' then clock_timestamp() else quoted_at end
      where id=v_id;
    delete from public.repair_lines where repair_order_id=v_id;
  end if;
  v_total := v_labor;
  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_quantity := (v_line->>'quantity')::integer;
    v_price := (v_line->>'unitPrice')::numeric;
    select * into v_item from public.items where id = (v_line->>'itemId')::uuid;
    if not found or v_item.category not in ('零件','用品','電池') or v_quantity is null or v_quantity <= 0
      or v_price is null or v_price < 0 then raise exception '維修用料資料無效'; end if;
    insert into public.repair_lines(repair_order_id,item_id,item_name,item_sku,quantity,unit_price,subtotal)
      values(v_id,v_item.id,v_item.name,v_item.sku,v_quantity,v_price,v_quantity*v_price);
    v_total := v_total + v_quantity*v_price;
  end loop;
  update public.repair_orders set total=v_total where id=v_id;
  return v_id;
end;
$$;

create or replace function app_private.record_repair_bonus()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_name text;
  v_active boolean;
  v_percent numeric(5,2);
  v_unconfirmed text;
  v_cost numeric(12,2);
  v_lines jsonb;
  v_net numeric(12,2);
begin
  if new.technician_id is null then raise exception '請先指定維修人員再確認完工'; end if;
  -- 維修人員＝勾選「維修員」身分的在職店員。
  select name, active and is_technician into v_name, v_active from public.salespeople where id = new.technician_id;
  if not coalesce(v_active, false) then raise exception '維修人員已停用或未勾選維修員身分，請重新指定'; end if;
  select repair_bonus_percent into v_percent from app_private.bonus_settings where id;
  -- 百分比未設定＝功能未啟用：不記帳、也不檢查成本。
  if v_percent is null then return null; end if;
  select l.item_name into v_unconfirmed
    from public.repair_lines l left join public.item_costs c on c.item_id = l.item_id
    where l.repair_order_id = new.id and not coalesce(c.cost_confirmed, false)
    order by l.item_name limit 1;
  if found then
    raise exception '用料「%」成本尚未確認，請店長在分紅管理確認後再完工', v_unconfirmed;
  end if;
  select coalesce(sum(l.quantity * c.cost), 0),
    coalesce(jsonb_agg(jsonb_build_object('itemId', l.item_id, 'itemName', l.item_name,
      'quantity', l.quantity, 'unitCost', c.cost) order by l.id), '[]'::jsonb)
    into v_cost, v_lines
    from public.repair_lines l join public.item_costs c on c.item_id = l.item_id
    where l.repair_order_id = new.id;
  v_net := greatest(new.total - v_cost, 0);
  insert into app_private.repair_bonus_records(repair_order_id, repair_number, technician_id, technician_name,
    repair_total, parts_cost, net_amount, bonus_percent, bonus_amount, cost_lines, occurred_at)
  values (new.id, new.repair_number, new.technician_id, v_name, new.total, v_cost, v_net, v_percent,
    round(v_net * v_percent / 100, 2), v_lines, coalesce(new.completed_at, clock_timestamp()));
  return null;
end;
$$;

create or replace function app_private.record_motorcycle_bonus(p_sale_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_amount numeric(12,2);
  v_units integer;
  v_lines jsonb;
  v_sale public.sales%rowtype;
begin
  select motorcycle_bonus_amount into v_amount from app_private.bonus_settings where id;
  -- 未設定（null）不記帳；設定為 0 視為明確不發，也不寫紀錄。
  if v_amount is null or v_amount = 0 then return; end if;
  select coalesce(sum(l.quantity), 0)::integer,
    coalesce(jsonb_agg(jsonb_build_object('itemId', l.item_id, 'itemName', l.item_name, 'quantity', l.quantity) order by l.id), '[]'::jsonb)
    into v_units, v_lines
    from public.sale_lines l join app_private.motorcycle_bonus_items b on b.item_id = l.item_id
    where l.sale_id = p_sale_id;
  if v_units = 0 then return; end if;
  select * into v_sale from public.sales where id = p_sale_id;
  insert into app_private.sale_bonus_records(sale_id, sale_number, salesperson_id, salesperson_name,
    units, unit_amount, bonus_amount, lines, occurred_at)
  select p_sale_id, v_sale.sale_number, s.id, s.name, v_units, v_amount, round(v_units * v_amount, 2), v_lines, v_sale.created_at
    from app_private.motorcycle_bonus_recipients r join public.salespeople s on s.id = r.salesperson_id and s.active and s.is_sales;
end;
$$;

create or replace function app_private.create_sale_with_serials_logged(
  p_lines jsonb, p_customer_id uuid, p_salesperson_id uuid, p_checkout_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_name text;
  v_sale_id uuid;
  v_existing_by uuid;
begin
  if not app_private.is_active_staff() then raise exception '帳號權限不足' using errcode = '42501'; end if;
  if p_checkout_id is null then raise exception '結帳識別碼不可空白'; end if;
  -- 交易層級的 advisory lock：同一個 checkout id 同時送兩次時，第二次會等第一次結束後才往下檢查。
  perform pg_advisory_xact_lock(hashtextextended('sale_checkout:' || p_checkout_id::text, 0));
  select created_by into v_existing_by from public.sales where id = p_checkout_id;
  if found then
    if v_existing_by is distinct from auth.uid() then
      raise exception '結帳識別碼已被使用' using errcode = '23505';
    end if;
    return p_checkout_id;
  end if;
  if p_salesperson_id is null then raise exception '結帳時請選擇業務員'; end if;
  select name into v_name from public.salespeople
    where id = p_salesperson_id and active and is_sales for share;
  if not found then raise exception '業務員不存在、已停用或未勾選業務員身分，請重新選擇'; end if;
  -- 先依 ID 排序鎖住所有品項與序號，多台同時結帳時鎖定順序一致，不會互相卡死（deadlock）。
  perform app_private.lock_sale_rows(p_lines);
  v_sale_id := app_private.create_sale_with_serials(p_lines, p_customer_id, p_checkout_id);
  insert into public.audit_logs (actor_id, action, target_type, target_id, summary)
    select auth.uid(), 'sale_created', 'sale', v_sale_id,
      jsonb_build_object('sale_number', sale_number, 'total', total)
    from public.sales where id = v_sale_id;
  insert into app_private.sale_salesperson_attributions(sale_id, salesperson_id, salesperson_name)
    values (v_sale_id, p_salesperson_id, v_name);
  -- 機車獎金：重送同一個 checkout id 會在上面提早 return，所以不會重複記帳。
  perform app_private.record_motorcycle_bonus(v_sale_id);
  return v_sale_id;
end;
$$;

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
      from public.salespeople where is_technician), '[]'::jsonb));
end;
$$;
