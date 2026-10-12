-- All identity correspondence is server-only. No plaintext credentials.
alter table public.profiles add column username text;
-- Newly registered identities cannot use staff access until manager provisioning completes.
alter table public.profiles alter column active set default false;
revoke update on public.profiles from authenticated;
create table app_private.staff_logins (
  user_id uuid primary key references public.profiles(id),
  username text not null unique check (username ~ '^[a-z0-9_-]{3,32}$'),
  ready boolean not null default false
);
create table app_private.staff_account_requests (
  request_id uuid primary key,
  actor_id uuid not null references public.profiles(id),
  username text not null unique check (username ~ '^[a-z0-9_-]{3,32}$'),
  reserved_user_id uuid not null unique default gen_random_uuid(),
  user_id uuid unique references public.profiles(id),
  status text not null default 'pending' check (status in ('pending','complete','failed'))
);
create table app_private.staff_login_limits (
  key text primary key,
  started_at timestamptz not null default now(),
  attempts integer not null default 0 check (attempts>=0)
);
alter table app_private.staff_logins enable row level security;
alter table app_private.staff_account_requests enable row level security;
alter table app_private.staff_login_limits enable row level security;
revoke all on app_private.staff_logins, app_private.staff_account_requests, app_private.staff_login_limits from public,anon,authenticated;
grant usage on schema app_private to service_role;
grant all on app_private.staff_logins, app_private.staff_account_requests, app_private.staff_login_limits to service_role;

create function app_private.normalize_staff_username() returns trigger
language plpgsql set search_path='' as $$ begin
  new.username:=lower(btrim(new.username));
  return new;
end $$;
create trigger staff_username_normalized before insert or update on app_private.staff_logins
for each row execute function app_private.normalize_staff_username();
create function app_private.project_staff_username() returns trigger
language plpgsql set search_path='' as $$ begin
  update public.profiles set username=new.username where id=new.user_id;
  return new;
end $$;
create trigger staff_username_projected after insert or update on app_private.staff_logins
for each row execute function app_private.project_staff_username();

-- One lock row serializes admin membership changes, including concurrent demotions.
create table app_private.staff_admin_guard (id boolean primary key default true check(id));
alter table app_private.staff_admin_guard enable row level security;
insert into app_private.staff_admin_guard values(true);
revoke all on app_private.staff_admin_guard from public,anon,authenticated;
grant all on app_private.staff_admin_guard to service_role;
create function app_private.protect_last_admin() returns trigger
language plpgsql set search_path='' as $$ begin
  perform 1 from app_private.staff_admin_guard for update;
  if old.role='admin' and old.active and
     (tg_op='DELETE' or new.role<>'admin' or not new.active) and
     not exists(select 1 from public.profiles where role='admin' and active and id<>old.id) then
    raise exception '最後一位啟用店長不可停用或降級' using errcode='23514';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
create trigger profiles_last_admin before update of role,active or delete on public.profiles
for each row execute function app_private.protect_last_admin();

-- Reservations count in-flight checks as failures until released on success.
create function public.reserve_staff_login(p_username text) returns boolean
language plpgsql security invoker set search_path='' as $$
declare k text; count_now integer; allowed boolean:=true;
begin
  for k in select unnest(array['global','user:'||p_username]) order by 1 loop
    insert into app_private.staff_login_limits(key,attempts) values(k,1)
    on conflict(key) do update set
      attempts=case when staff_login_limits.started_at<=now()-interval '15 minutes' then 1 else staff_login_limits.attempts+1 end,
      started_at=case when staff_login_limits.started_at<=now()-interval '15 minutes' then now() else staff_login_limits.started_at end
    returning attempts into count_now;
    if count_now>(case when k='global' then 50 else 10 end) then allowed:=false; end if;
  end loop;
  delete from app_private.staff_login_limits where started_at<now()-interval '1 day';
  return allowed;
end $$;
create function public.finish_staff_login(p_username text,p_success boolean) returns void
language plpgsql security invoker set search_path='' as $$ begin
  if p_success then
    update app_private.staff_login_limits set attempts=greatest(0,attempts-1) where key='user:'||p_username;
  end if;
end $$;
revoke all on function public.reserve_staff_login(text),public.finish_staff_login(text,boolean) from public,anon,authenticated;
grant execute on function public.reserve_staff_login(text),public.finish_staff_login(text,boolean) to service_role;

-- Service-only bridge: private schema stays unexposed to PostgREST.
create function public.staff_identity(p_username text) returns table(user_id uuid,email text,ready boolean,active boolean)
language sql security definer set search_path='' as $$
  select l.user_id,u.email,l.ready,p.active from app_private.staff_logins l
  join public.profiles p on p.id=l.user_id join auth.users u on u.id=l.user_id where l.username=p_username
$$;
revoke all on function public.staff_identity(text) from public,anon,authenticated;
grant execute on function public.staff_identity(text) to service_role;

create function public.staff_session_valid(p_user_id uuid,p_session_id uuid) returns boolean
language sql security definer set search_path='' as $$
  select exists(select 1 from auth.sessions s join public.profiles p on p.id=s.user_id
    where s.id=p_session_id and s.user_id=p_user_id and p.active)
$$;
revoke all on function public.staff_session_valid(uuid,uuid) from public,anon,authenticated;
grant execute on function public.staff_session_valid(uuid,uuid) to service_role;
create function public.current_staff_session_valid() returns boolean
language sql security definer set search_path='' as $$
  select public.staff_session_valid(auth.uid(),(auth.jwt()->>'session_id')::uuid)
$$;
revoke all on function public.current_staff_session_valid() from public,anon;
grant execute on function public.current_staff_session_valid() to authenticated;
create or replace function app_private.is_active_staff() returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.profiles p join auth.sessions s on s.user_id=p.id
    where p.id=auth.uid() and p.active and s.id=(auth.jwt()->>'session_id')::uuid)
$$;
create or replace function app_private.is_admin() returns boolean
language sql stable security definer set search_path='' as $$
  select app_private.is_active_staff() and exists(select 1 from public.profiles where id=auth.uid() and role='admin')
$$;
alter policy "active staff read their own profile or admins read all" on public.profiles
using ((select app_private.is_admin()) or (id=(select auth.uid()) and (select app_private.is_active_staff())));
revoke all on function app_private.normalize_staff_username(),app_private.project_staff_username(),app_private.protect_last_admin() from public,anon,authenticated;

create function public.prepare_staff_account(p_actor uuid,p_request uuid,p_username text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare r app_private.staff_account_requests;
begin
  if not exists(select 1 from public.profiles where id=p_actor and active and role='admin') then
    raise exception '僅店長可管理帳號' using errcode='42501';
  end if;
  if exists(select 1 from app_private.staff_logins where username=p_username) and
     not exists(select 1 from app_private.staff_account_requests where request_id=p_request and actor_id=p_actor and username=p_username and status='complete') then
    raise exception '帳號已存在' using errcode='23505';
  end if;
  insert into app_private.staff_account_requests(request_id,actor_id,username)
  values(p_request,p_actor,p_username) on conflict(request_id) do nothing;
  select * into r from app_private.staff_account_requests where request_id=p_request for update;
  if r.actor_id<>p_actor or r.username<>p_username then raise exception '請求識別不符' using errcode='42501'; end if;
  return to_jsonb(r);
end $$;

create function public.complete_staff_account(p_actor uuid,p_request uuid,p_display_name text) returns uuid
language plpgsql security invoker set search_path='' as $$
declare r app_private.staff_account_requests;
begin
  if not exists(select 1 from public.profiles where id=p_actor and active and role='admin') then raise exception '僅店長可管理帳號' using errcode='42501'; end if;
  select * into r from app_private.staff_account_requests where request_id=p_request and actor_id=p_actor for update;
  if not found then raise exception '建立請求不存在'; end if;
  if r.status='complete' then return r.user_id; end if;
  update public.profiles set display_name=p_display_name,role='clerk',active=true where id=r.reserved_user_id;
  if not found then raise exception '登入身分尚未建立'; end if;
  insert into app_private.staff_logins(user_id,username,ready) values(r.reserved_user_id,r.username,true);
  update app_private.staff_account_requests set user_id=r.reserved_user_id,status='complete' where request_id=p_request;
  insert into public.audit_logs(actor_id,action,target_type,target_id) values(p_actor,'staff.create','profile',r.reserved_user_id);
  return r.reserved_user_id;
end $$;

create function public.link_staff_account(p_actor uuid,p_user_id uuid,p_username text) returns void
language plpgsql security invoker set search_path='' as $$ begin
  if not exists(select 1 from public.profiles where id=p_actor and active and role='admin') then raise exception '僅店長可管理帳號' using errcode='42501'; end if;
  insert into app_private.staff_account_requests(request_id,actor_id,username,reserved_user_id,user_id,status)
  values(gen_random_uuid(),p_actor,p_username,p_user_id,p_user_id,'complete');
  insert into app_private.staff_logins(user_id,username,ready) values(p_user_id,p_username,true);
  insert into public.audit_logs(actor_id,action,target_type,target_id) values(p_actor,'staff.link','profile',p_user_id);
end $$;

create function public.control_staff_account(p_actor uuid,p_user_id uuid,p_action text) returns void
language plpgsql security invoker set search_path='' as $$ begin
  if not exists(select 1 from public.profiles where id=p_actor and active and role='admin') then raise exception '僅店長可管理帳號' using errcode='42501'; end if;
  if p_action='deactivate' then
    update public.profiles set active=false where id=p_user_id;
    if not found then raise exception '帳號不存在'; end if;
    -- Target-scoped session deletion cascades to refresh_tokens in Supabase Auth.
    delete from auth.sessions where user_id=p_user_id;
  elsif p_action<>'reset-password' then raise exception '不支援的操作'; end if;
  insert into public.audit_logs(actor_id,action,target_type,target_id) values(p_actor,'staff.'||p_action,'profile',p_user_id);
end $$;
revoke all on function public.prepare_staff_account(uuid,uuid,text),public.complete_staff_account(uuid,uuid,text),public.link_staff_account(uuid,uuid,text),public.control_staff_account(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.prepare_staff_account(uuid,uuid,text),public.complete_staff_account(uuid,uuid,text),public.link_staff_account(uuid,uuid,text),public.control_staff_account(uuid,uuid,text) to service_role;
