-- 2026-11 拿掉「用料成本確認」：店長不用再逐一按「確認成本」。
--
-- 原本：有設定維修分紅百分比時，維修單完工前要求每個用料的成本都「已確認」，否則不能完工。
-- 改成：只檢查用料「有沒有成本資料」（item_costs 有沒有這個品項）。沒有成本資料時仍擋下，
--       因為分紅＝（維修總額－用料成本）× 百分比，成本缺漏會被當成 0，分紅就會算錯。
-- item_costs.cost_confirmed 欄位與 set_item_costs_confirmed 函式先保留（不再使用），避免影響舊資料與舊版網頁。
create or replace function app_private.record_repair_bonus()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare
  v_name text;
  v_active boolean;
  v_percent numeric(5,2);
  v_missing text;
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
  select l.item_name into v_missing
    from public.repair_lines l left join public.item_costs c on c.item_id = l.item_id
    where l.repair_order_id = new.id and c.cost is null
    order by l.item_name limit 1;
  if found then
    raise exception '用料「%」尚未設定成本，請店長在品項編輯填入成本後再完工', v_missing;
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
$function$;
