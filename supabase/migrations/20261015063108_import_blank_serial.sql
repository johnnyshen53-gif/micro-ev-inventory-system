-- A warranty without a physical serial uses the existing schema's empty-text
-- representation, not NULL. Keep the original migration immutable in history.
do $$
declare
  v_definition text := pg_get_functiondef('app_private.import_cloud_operations(jsonb)'::regprocedure);
  v_old text := 'nullif(v_row->>''serialNumber'','''')';
begin
  if position(v_old in v_definition) = 0 then return; end if;
  execute replace(v_definition, v_old, 'coalesce(v_row->>''serialNumber'','''')');
end $$;
