-- 修正：Supabase 透過 API 執行的 DELETE 必須有 WHERE 條件（pg_safeupdate 安全機制），
-- 否則店長儲存分紅設定會出現「DELETE requires a WHERE clause」。
-- 內容與 20261019040000 相同，只在清空名單的兩行 DELETE 加上 where true（意思仍是清空整份名單）。
create or replace function app_private.save_bonus_settings(p_motorcycle_amount numeric, p_repair_percent numeric,
  p_recipient_ids uuid[], p_motorcycle_item_ids uuid[])
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not app_private.is_admin() then raise exception '只有店長可以修改分紅設定' using errcode = '42501'; end if;
  if p_motorcycle_amount < 0 then raise exception '每台機車獎金不可為負數'; end if;
  if p_repair_percent < 0 or p_repair_percent > 100 then raise exception '維修分紅百分比須介於 0～100'; end if;
  update app_private.bonus_settings set motorcycle_bonus_amount = round(p_motorcycle_amount, 2),
    repair_bonus_percent = round(p_repair_percent, 2), updated_by = auth.uid(), updated_at = clock_timestamp() where id;
  delete from app_private.motorcycle_bonus_recipients where true;
  insert into app_private.motorcycle_bonus_recipients(salesperson_id)
    select distinct unnest(coalesce(p_recipient_ids, '{}'));
  delete from app_private.motorcycle_bonus_items where true;
  insert into app_private.motorcycle_bonus_items(item_id)
    select distinct unnest(coalesce(p_motorcycle_item_ids, '{}'));
  insert into public.audit_logs(actor_id, action, target_type, target_id, summary)
    values (auth.uid(), 'bonus.settings_saved', 'bonus_settings', null, jsonb_build_object(
      'motorcycle_bonus_amount', p_motorcycle_amount, 'repair_bonus_percent', p_repair_percent,
      'recipients', coalesce(array_length(p_recipient_ids, 1), 0), 'items', coalesce(array_length(p_motorcycle_item_ids, 1), 0)));
end;
$$;
