-- 刪除報價單（只有店長）：留一筆操作紀錄（誰、何時、哪一張、客戶、總額、明細），再刪除報價單；
-- 明細與套用的特惠組合會跟著自動刪除（on delete cascade）。
create function app_private.delete_quotation(p_quotation_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_q public.quotations%rowtype;
begin
  if not app_private.is_admin() then raise exception '只有店長可以刪除報價單' using errcode = '42501'; end if;
  select * into v_q from public.quotations where id = p_quotation_id for update;
  if not found then raise exception '找不到報價單，可能已被刪除'; end if;
  insert into public.audit_logs (actor_id, action, target_type, target_id, summary)
  values (auth.uid(), 'quotation_deleted', 'quotation', v_q.id, jsonb_build_object(
    'quote_number', v_q.quote_number,
    'customer_id', v_q.customer_id,
    'customer_name', coalesce(nullif(v_q.customer_name, ''), (select name from public.customers where id = v_q.customer_id)),
    'plate_number', v_q.plate_number,
    'total', v_q.total,
    'lines', (select coalesce(jsonb_agg(jsonb_build_object('item_name', l.item_name, 'quantity', l.quantity, 'subtotal', l.subtotal) order by l.id), '[]'::jsonb)
              from public.quotation_lines l where l.quotation_id = v_q.id)));
  delete from public.quotations where id = v_q.id;
end;
$$;

create function public.delete_quotation(p_quotation_id uuid) returns void
  language sql security invoker set search_path = '' as $$ select app_private.delete_quotation(p_quotation_id) $$;

revoke all on function app_private.delete_quotation(uuid), public.delete_quotation(uuid) from public, anon;
grant execute on function app_private.delete_quotation(uuid), public.delete_quotation(uuid) to authenticated;
