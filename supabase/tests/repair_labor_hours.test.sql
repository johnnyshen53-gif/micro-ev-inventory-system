-- 維修單工時（20261022010000）：工時與費率快照一起儲存，舊格式（只有工資）仍可用。
begin;
insert into auth.users(id, email) values ('72000000-0000-4000-8000-000000000002', 'lh-clerk@example.invalid');
update public.profiles set active = true where id = '72000000-0000-4000-8000-000000000002';
insert into auth.sessions(id, user_id) values ('72000000-0000-4000-8000-000000000012', '72000000-0000-4000-8000-000000000002');
select set_config('request.jwt.claim.sub', '72000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"72000000-0000-4000-8000-000000000002","session_id":"72000000-0000-4000-8000-000000000012"}', true);
set local role authenticated;
do $$
declare
  v_order uuid;
  v_base jsonb := '{"customerName":"客人","customerPhone":"0911000000","plateNumber":"LH-1","vehicleName":"車型","issue":"保養","laborAmount":1200,"laborHours":1.5,"laborRate":800}'::jsonb;
begin
  v_order := public.save_repair_order(v_base, '[]'::jsonb);
  if (select (labor_hours, labor_rate, labor_amount, total) from public.repair_orders where id = v_order) is distinct from (1.5::numeric, 800::numeric, 1200::numeric, 1200::numeric)
    then raise exception 'labor hours and rate snapshot not stored'; end if;
  -- 手動改工資：工時與費率照存，工資以輸入為準。
  perform public.save_repair_order(v_base || jsonb_build_object('id', v_order, 'laborAmount', 1000), '[]'::jsonb, (select updated_at from public.repair_orders where id = v_order));
  if (select labor_amount from public.repair_orders where id = v_order) <> 1000 then raise exception 'manual labor override lost'; end if;
  -- 舊前端只送工資：兩欄維持空白。
  v_order := public.save_repair_order(v_base - 'laborHours' - 'laborRate', '[]'::jsonb);
  if (select labor_hours is null and labor_rate is null from public.repair_orders where id = v_order) is not true then raise exception 'legacy order should keep empty hours'; end if;
  begin
    perform public.save_repair_order(v_base - 'laborRate', '[]'::jsonb);
    raise exception 'hours without rate accepted';
  exception when others then if sqlerrm <> '維修單資料無效' then raise; end if; end;
  begin
    perform public.save_repair_order(v_base || '{"laborHours":-1}', '[]'::jsonb);
    raise exception 'negative hours accepted';
  exception when others then if sqlerrm <> '維修單資料無效' then raise; end if; end;
end $$;
rollback;
