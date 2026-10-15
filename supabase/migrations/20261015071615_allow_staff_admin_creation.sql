-- Keep the chosen role with the idempotent request so retries cannot change privileges.
alter table app_private.staff_account_requests
  add column role public.staff_role not null default 'clerk';

create function public.prepare_staff_account(p_actor uuid,p_request uuid,p_username text,p_role public.staff_role) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare r app_private.staff_account_requests;
begin
  if not exists(select 1 from public.profiles where id=p_actor and active and role='admin') then
    raise exception '僅店長可管理帳號' using errcode='42501';
  end if;
  if p_role is null then raise exception '權限不可為空' using errcode='22004'; end if;
  if exists(select 1 from app_private.staff_logins where username=p_username) and
     not exists(select 1 from app_private.staff_account_requests where request_id=p_request and actor_id=p_actor and username=p_username and role=p_role and status='complete') then
    raise exception '帳號已存在' using errcode='23505';
  end if;
  insert into app_private.staff_account_requests(request_id,actor_id,username,role)
  values(p_request,p_actor,p_username,p_role) on conflict(request_id) do nothing;
  select * into r from app_private.staff_account_requests where request_id=p_request for update;
  if r.actor_id<>p_actor or r.username<>p_username or r.role<>p_role then
    raise exception '請求識別不符' using errcode='42501';
  end if;
  return to_jsonb(r);
end $$;

create or replace function public.complete_staff_account(p_actor uuid,p_request uuid,p_display_name text) returns uuid
language plpgsql security invoker set search_path='' as $$
declare r app_private.staff_account_requests;
begin
  if not exists(select 1 from public.profiles where id=p_actor and active and role='admin') then raise exception '僅店長可管理帳號' using errcode='42501'; end if;
  select * into r from app_private.staff_account_requests where request_id=p_request and actor_id=p_actor for update;
  if not found then raise exception '建立請求不存在'; end if;
  if r.status='complete' then return r.user_id; end if;
  update public.profiles set display_name=p_display_name,role=r.role,active=true where id=r.reserved_user_id;
  if not found then raise exception '登入身分尚未建立'; end if;
  insert into app_private.staff_logins(user_id,username,ready) values(r.reserved_user_id,r.username,true);
  update app_private.staff_account_requests set user_id=r.reserved_user_id,status='complete' where request_id=p_request;
  insert into public.audit_logs(actor_id,action,target_type,target_id) values(p_actor,'staff.create','profile',r.reserved_user_id);
  return r.reserved_user_id;
end $$;

revoke all on function public.prepare_staff_account(uuid,uuid,text,public.staff_role) from public,anon,authenticated;
grant execute on function public.prepare_staff_account(uuid,uuid,text,public.staff_role) to service_role;
