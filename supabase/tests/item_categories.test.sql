-- 2026-10 品項分類改版：資料庫只接受五種新分類，函式裡不再出現舊分類名稱。
do $$
declare v_left integer;
begin
  begin
    insert into public.items(id, name, category, sku, barcode, created_by)
    values (gen_random_uuid(), '舊分類品項', '零件', 'CAT-OLD', 'CAT-OLD', gen_random_uuid());
    raise exception 'old category should be rejected';
  exception when check_violation then null;
  end;

  select count(*) into v_left
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'app_private') and p.prosrc ~ '''(機車|零件|用品)''';
  if v_left <> 0 then raise exception '% functions still use old category names', v_left; end if;

  if (select column_default from information_schema.columns
      where table_schema = 'public' and table_name = 'items' and column_name = 'category') <> '''電控元件''::text' then
    raise exception 'unexpected category default';
  end if;
end $$;
