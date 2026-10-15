create or replace function app_private.create_sale_with_serials_logged(p_lines jsonb, p_customer_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_sale_id uuid;
begin
  v_sale_id := app_private.create_sale_with_serials(p_lines, p_customer_id);
  insert into public.audit_logs (actor_id, action, target_type, target_id, summary)
    select auth.uid(), 'sale_created', 'sale', v_sale_id,
      jsonb_build_object('sale_number', sale_number, 'total', total)
    from public.sales where id = v_sale_id;
  return v_sale_id;
end;
$$;

create or replace function public.create_sale_with_serials(p_lines jsonb, p_customer_id uuid)
returns uuid language sql security invoker set search_path = '' as $$
  select app_private.create_sale_with_serials_logged(p_lines, p_customer_id)
$$;

revoke all on function app_private.create_sale_with_serials(jsonb,uuid) from authenticated;
revoke all on function app_private.create_sale_with_serials_logged(jsonb,uuid) from public, anon;
grant execute on function app_private.create_sale_with_serials_logged(jsonb,uuid) to authenticated;
