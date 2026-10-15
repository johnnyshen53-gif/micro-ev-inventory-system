-- Supabase grants EXECUTE to anon by default, separately from PUBLIC.
-- Applied through the connected Supabase management API; filename matches its live version.
revoke all on function public.create_or_update_supplier(jsonb), public.save_quotation(jsonb, jsonb) from anon;
