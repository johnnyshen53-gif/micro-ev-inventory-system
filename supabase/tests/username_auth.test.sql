-- Transaction rolled back: dedicated fixture identities only.
begin;
do $$ begin
  assert to_regclass('app_private.staff_logins') is not null, 'username login schema missing';
end $$;
insert into auth.users(id,email) values
 ('10000000-0000-4000-8000-000000000001','auth-test-admin@example.invalid'),
 ('10000000-0000-4000-8000-000000000002','auth-test-clerk@example.invalid'),
 ('10000000-0000-4000-8000-000000000003','auth-test-existing@example.invalid');
do $$ begin
  assert not (select active from public.profiles where id='10000000-0000-4000-8000-000000000003'), 'unprovisioned signup is active';
end $$;
update public.profiles set active=true where id in ('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002');
update public.profiles set role='admin' where id='10000000-0000-4000-8000-000000000001';
insert into app_private.staff_logins(user_id,username,ready) values
 ('10000000-0000-4000-8000-000000000001',' Johnny ',true),
 ('10000000-0000-4000-8000-000000000002','sales_01',false);
do $$ begin
  assert (select username from app_private.staff_logins where user_id='10000000-0000-4000-8000-000000000001')='johnny';
  assert (select username from public.profiles where id='10000000-0000-4000-8000-000000000001')='johnny';
  begin
    update app_private.staff_logins set username='JOHNNY' where user_id='10000000-0000-4000-8000-000000000002';
    raise exception 'duplicate accepted';
  exception when unique_violation then null; end;
  begin
    update app_private.staff_logins set username='ab' where user_id='10000000-0000-4000-8000-000000000002';
    raise exception 'short accepted';
  exception when check_violation then null; end;
  begin
    update app_private.staff_logins set username=repeat('a',33) where user_id='10000000-0000-4000-8000-000000000002';
    raise exception 'long accepted';
  exception when check_violation then null; end;
  begin
    update app_private.staff_logins set username='email@example.com' where user_id='10000000-0000-4000-8000-000000000002';
    raise exception 'email accepted';
  exception when check_violation then null; end;
  assert not has_table_privilege('anon','app_private.staff_logins','select');
  assert not has_table_privilege('authenticated','app_private.staff_logins','select');
  assert not has_column_privilege('authenticated','public.profiles','username','update');
  assert not has_column_privilege('authenticated','public.profiles','role','update');
  assert not (select ready from app_private.staff_logins where username='sales_01');
end $$;
-- A single enabled admin cannot be disabled or demoted.
update public.profiles set active=false where role='admin' and id<>'10000000-0000-4000-8000-000000000001';
do $$ begin
  begin
    update public.profiles set active=false where id='10000000-0000-4000-8000-000000000001';
    raise exception 'last admin disabled';
  exception when check_violation then null; end;
  begin
    update public.profiles set role='clerk' where id='10000000-0000-4000-8000-000000000001';
    raise exception 'last admin demoted';
  exception when check_violation then null; end;
end $$;
-- Limiter reservations count concurrent attempts until completion.
do $$ declare allowed boolean; begin
  for i in 1..10 loop
    assert public.reserve_staff_login('sales_01');
    perform public.finish_staff_login('sales_01',false);
  end loop;
  assert not public.reserve_staff_login('sales_01');
  for i in 1..39 loop
    assert public.reserve_staff_login('new_'||i);
    perform public.finish_staff_login('new_'||i,true);
  end loop;
  assert not public.reserve_staff_login('last_user');
  update app_private.staff_login_limits set started_at=now()-interval '16 minutes';
  assert public.reserve_staff_login('sales_01');
  assert not has_function_privilege('anon','public.reserve_staff_login(text)','execute');
  assert not has_function_privilege('authenticated','public.reserve_staff_login(text)','execute');
end $$;
-- Preparing/retrying a create request does not allocate another identity.
do $$ declare r jsonb; begin
  r:=public.prepare_staff_account('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','new_staff');
  assert r->>'status'='pending';
  assert public.prepare_staff_account('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','new_staff')=r;
  begin
    perform public.prepare_staff_account('10000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002','another_staff');
    raise exception 'clerk managed accounts';
  exception when insufficient_privilege then null; end;
  assert not has_function_privilege('authenticated','public.prepare_staff_account(uuid,uuid,text)','execute');
  begin
    perform public.link_staff_account('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000003','new_staff');
    raise exception 'reserved username reused';
  exception when unique_violation then null; end;
  insert into auth.sessions(id,user_id) values('30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002');
  assert public.staff_session_valid('10000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000001');
  perform public.control_staff_account('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','deactivate');
  assert not exists(select 1 from auth.sessions where user_id='10000000-0000-4000-8000-000000000002');
end $$;
-- An active profile is not enough after session revocation (password reset).
update public.profiles set active=true where id='10000000-0000-4000-8000-000000000002';
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',true);
select set_config('request.jwt.claims','{"session_id":"30000000-0000-4000-8000-000000000001"}',true);
do $$ begin
  assert not app_private.is_active_staff(), 'revoked JWT still authorizes business access';
end $$;
rollback;
