-- Validate the newly imported physical-unit graph before the RPC transaction
-- returns; an exception here rolls back the rows and migration marker together.
create or replace function app_private.validate_imported_relations(p_state jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare v_row jsonb;
begin
  if not app_private.is_admin() then raise exception '只有店長可以執行首次資料移轉'; end if;
  for v_row in select value from jsonb_array_elements(coalesce(p_state->'serials','[]'::jsonb)) loop
    if exists (
      select 1 from public.inventory_serials s
      left join public.sale_lines l on l.id = s.sale_line_id
      left join public.sales sale on sale.id = l.sale_id
      where s.id = (v_row->>'id')::uuid and (
        (s.sale_line_id is not null and (l.item_id is distinct from s.item_id
          or sale.customer_id is distinct from s.customer_id))
        or (s.status = 'sold' and (s.sale_line_id is null or s.customer_id is null))
        or (s.status <> 'sold' and s.sale_line_id is not null)
        or (s.purchase_id is not null and not exists (
          select 1 from public.purchase_lines pl join public.purchases p on p.id = pl.purchase_id
          where pl.purchase_id = s.purchase_id and pl.item_id = s.item_id and p.status = 'received'))
        or (s.status = 'warranty_out' and (s.warranty_id is null or not exists (
          select 1 from public.warranties w where w.id = s.warranty_id
            and w.customer_id = s.customer_id)))
        or (s.status <> 'warranty_out' and s.warranty_id is not null)
      )
    ) then raise exception '備份實物序號關聯無效：%', v_row->>'id'; end if;
  end loop;
  for v_row in select value from jsonb_array_elements(coalesce(p_state->'warranties','[]'::jsonb)) loop
    if exists (
      select 1 from public.warranties w
      left join public.sale_lines l on l.id = w.sale_line_id
      left join public.sales sale on sale.id = l.sale_id
      left join public.inventory_serials s on s.id = w.serial_id
      where w.id = (v_row->>'id')::uuid and (
        (w.source = 'sale' and (l.item_id is distinct from w.item_id
          or sale.customer_id is distinct from w.customer_id))
        or (w.serial_id is not null and (s.item_id is distinct from w.item_id
          or s.customer_id is distinct from w.customer_id
          or s.sale_line_id is distinct from w.sale_line_id
          or s.serial_number is distinct from w.serial_number or s.status <> 'sold'))
      )
    ) then raise exception '備份保固關聯無效：%', v_row->>'id'; end if;
  end loop;
  if exists (
    select 1 from public.items i
    where i.category in ('機車','電池') and (
      select count(*) from public.inventory_serials s where s.item_id = i.id and s.status = 'in_stock'
    ) > i.stock
  ) then raise exception '在庫序號超過雲端庫存'; end if;
end;
$$;

revoke all on function app_private.validate_imported_relations(jsonb) from public, anon;
grant execute on function app_private.validate_imported_relations(jsonb) to authenticated;
create or replace function public.import_cloud_operations(p_state jsonb)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_imported boolean;
begin
  v_imported := app_private.import_cloud_operations(p_state);
  if v_imported then perform app_private.validate_imported_relations(p_state); end if;
  return v_imported;
end;
$$;
revoke all on function public.import_cloud_operations(jsonb) from public, anon;
grant execute on function public.import_cloud_operations(jsonb) to authenticated;
