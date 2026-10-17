-- 機車獎金：結帳時在同一筆交易內記帳。
-- 每台適用機車 × 每台獎金，名單內每位在職業務員各一筆、同額。
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
    from app_private.motorcycle_bonus_recipients r join public.salespeople s on s.id = r.salesperson_id and s.active;
end;
$$;
revoke all on function app_private.record_motorcycle_bonus(uuid) from public, anon, authenticated;

-- 內容與 20261017090000 相同，只在寫完業務員歸屬後加上機車獎金記帳。
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
    where id = p_salesperson_id and active for share;
  if not found then raise exception '業務員不存在或已停用，請重新選擇'; end if;
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
