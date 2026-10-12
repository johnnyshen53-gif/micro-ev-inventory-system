revoke all on function public.create_profile_for_new_user() from public, anon, authenticated;
revoke all on function public.create_sale(jsonb) from public, anon, authenticated;
grant execute on function public.create_sale(jsonb) to authenticated;
