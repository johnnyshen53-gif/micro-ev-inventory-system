-- 最後價格異動時間（items.price_changed_at）：售價、特價、會員價、員工價、成本任何一個改動就更新。
-- 由資料庫的 trigger 維護，不靠各台裝置的時鐘；既有品項沒有過去的紀錄，維持空值（畫面顯示「—」）。
alter table public.items add column price_changed_at timestamptz;

-- 品項：新增時沒指定就記現在（批次匯入可以帶入原資料的異動日期）；修改時三種價格有變才更新。
create function app_private.items_track_price_change()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.price_changed_at := coalesce(new.price_changed_at, now());
  elsif new.price is distinct from old.price or new.special_price is distinct from old.special_price
      or new.member_price is distinct from old.member_price then
    new.price_changed_at := now();
  end if;
  return new;
end;
$$;
create trigger items_track_price_change before insert or update on public.items
  for each row execute function app_private.items_track_price_change();

-- 成本、員工價放在 item_costs：有變就更新對應品項的時間（進貨收貨更新成本也算）。
-- 新增品項時跟著建立的那一列不算異動（品項本身已經記了時間）。
create function app_private.item_costs_track_price_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.cost is distinct from old.cost or new.staff_price is distinct from old.staff_price then
    update public.items set price_changed_at = now() where id = new.item_id;
  end if;
  return new;
end;
$$;
create trigger item_costs_track_price_change after update on public.item_costs
  for each row execute function app_private.item_costs_track_price_change();

revoke all on function app_private.items_track_price_change(), app_private.item_costs_track_price_change() from public, anon, authenticated;
