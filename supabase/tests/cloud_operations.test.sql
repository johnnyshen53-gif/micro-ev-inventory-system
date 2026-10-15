begin;

do $$
declare
  v_table text;
begin
  foreach v_table in array array['suppliers', 'purchases', 'purchase_lines', 'inventory_serials', 'app_migrations'] loop
    if to_regclass('public.' || v_table) is null then
      raise exception 'missing public.%', v_table;
    end if;
    if not (select relrowsecurity from pg_class where oid = to_regclass('public.' || v_table)) then
      raise exception 'RLS is disabled on public.%', v_table;
    end if;
    if has_table_privilege('anon', 'public.' || v_table, 'SELECT,INSERT,UPDATE,DELETE') then
      raise exception 'anon has data access to public.%', v_table;
    end if;
  end loop;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'suppliers' and cmd = 'ALL'
      and qual like '%app_private.is_admin()%'
  ) then
    raise exception 'supplier admin policy is missing';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'purchases' and cmd = 'ALL'
      and qual like '%app_private.is_admin()%'
  ) then
    raise exception 'purchase admin policy is missing';
  end if;

  if to_regprocedure('public.create_or_update_supplier(jsonb)') is null
    or to_regprocedure('public.save_quotation(jsonb,jsonb)') is null then
    raise exception 'supplier or quotation RPC is missing';
  end if;
  if has_function_privilege('anon', 'public.create_or_update_supplier(jsonb)', 'EXECUTE')
    or has_function_privilege('anon', 'public.save_quotation(jsonb,jsonb)', 'EXECUTE') then
    raise exception 'anonymous users can invoke operational RPCs';
  end if;
  if not has_function_privilege('authenticated', 'public.create_or_update_supplier(jsonb)', 'EXECUTE')
    or not has_function_privilege('authenticated', 'public.save_quotation(jsonb,jsonb)', 'EXECUTE') then
    raise exception 'authenticated staff cannot invoke operational RPCs';
  end if;

  if to_regprocedure('public.save_purchase(jsonb,jsonb)') is null
    or to_regprocedure('public.receive_purchase(uuid,jsonb)') is null
    or to_regprocedure('public.mark_purchase_paid(uuid)') is null then
    raise exception 'purchase RPC is missing';
  end if;
  if has_function_privilege('anon', 'public.save_purchase(jsonb,jsonb)', 'EXECUTE')
    or has_function_privilege('anon', 'public.receive_purchase(uuid,jsonb)', 'EXECUTE')
    or has_function_privilege('anon', 'public.mark_purchase_paid(uuid)', 'EXECUTE')
    or has_function_privilege('anon', 'public.delete_purchase_draft(uuid)', 'EXECUTE') then
    raise exception 'anonymous users can invoke purchase RPCs';
  end if;

  if to_regprocedure('public.save_warranty(jsonb)') is null
    or to_regprocedure('public.save_warranty_case(jsonb)') is null
    or to_regprocedure('public.delete_warranty(uuid)') is null
    or to_regprocedure('public.delete_warranty_case(uuid)') is null
    or to_regprocedure('public.create_sale_with_serials(jsonb,uuid)') is null
    or to_regprocedure('public.issue_warranty_replacement(uuid,integer,uuid,uuid[],text)') is null then
    raise exception 'warranty or serialized-sale RPC is missing';
  end if;
  if has_function_privilege('anon', 'public.save_warranty(jsonb)', 'EXECUTE')
    or has_function_privilege('anon', 'public.save_warranty_case(jsonb)', 'EXECUTE')
    or has_function_privilege('anon', 'public.delete_warranty(uuid)', 'EXECUTE')
    or has_function_privilege('anon', 'public.delete_warranty_case(uuid)', 'EXECUTE')
    or has_function_privilege('anon', 'public.create_sale_with_serials(jsonb,uuid)', 'EXECUTE')
    or has_function_privilege('anon', 'public.issue_warranty_replacement(uuid,integer,uuid,uuid[],text)', 'EXECUTE') then
    raise exception 'anonymous users can invoke warranty operations';
  end if;
end $$;

rollback;
