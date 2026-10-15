-- The public SECURITY INVOKER wrapper needs permission to call its private
-- implementation; the private schema is not exposed through the Data API.
grant execute on function app_private.import_cloud_operations(jsonb) to authenticated;
