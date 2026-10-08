-- URALSTORE app access v1.
-- Apply once in the existing Supabase project's SQL Editor.
-- Access codes are intentionally not stored in this public file.

begin;

create extension if not exists pgcrypto with schema extensions;

create table public.app_access_secrets (
  access_role text primary key check (access_role in ('staff','admin')),
  code_hash text not null,
  updated_at timestamptz not null default now()
);

create table public.app_access_sessions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  access_role text check (access_role in ('staff','admin')),
  active boolean not null default false,
  failed_attempts integer not null default 0 check (failed_attempts between 0 and 5),
  blocked_until timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.app_access_secrets enable row level security;
alter table public.app_access_sessions enable row level security;
revoke all on public.app_access_secrets from anon, authenticated;
revoke all on public.app_access_sessions from anon, authenticated;

create or replace function public.get_app_access()
returns table(access_role text)
language sql
security definer
set search_path=''
stable
as $$
  select s.access_role
  from public.app_access_sessions s
  where s.user_id=(select auth.uid())
    and s.active
    and s.access_role is not null;
$$;

create or replace function public.unlock_app(p_code text)
returns table(ok boolean,access_role text,message text)
language plpgsql
security definer
set search_path=''
as $$
declare
  actor uuid:=auth.uid();
  session_row public.app_access_sessions;
  matched_role text;
  next_attempts integer;
begin
  if actor is null then
    raise exception 'Не удалось открыть защищённую сессию' using errcode='42501';
  end if;

  if p_code is null or p_code !~ '^[0-9]{4}$' then
    return query select false,null::text,'Введите код из четырёх цифр'::text;
    return;
  end if;

  insert into public.app_access_sessions(user_id)
  values(actor)
  on conflict(user_id) do nothing;

  select * into session_row
  from public.app_access_sessions
  where user_id=actor
  for update;

  if session_row.blocked_until is not null and session_row.blocked_until>now() then
    return query select false,null::text,'Слишком много попыток. Повторите через 15 минут.'::text;
    return;
  end if;

  select s.access_role into matched_role
  from public.app_access_secrets s
  where s.code_hash=extensions.crypt(p_code,s.code_hash)
  limit 1;

  if matched_role is null then
    next_attempts:=case when session_row.blocked_until is not null and session_row.blocked_until<=now() then 1 else session_row.failed_attempts+1 end;
    update public.app_access_sessions
    set active=false,
        access_role=null,
        failed_attempts=least(next_attempts,5),
        blocked_until=case when next_attempts>=5 then now()+interval '15 minutes' else null end,
        updated_at=now()
    where user_id=actor;
    return query select false,null::text,case when next_attempts>=5 then 'Слишком много попыток. Вход заблокирован на 15 минут.' else 'Неверный код доступа.' end;
    return;
  end if;

  update public.app_access_sessions
  set access_role=matched_role,
      active=true,
      failed_attempts=0,
      blocked_until=null,
      updated_at=now()
  where user_id=actor;

  return query select true,matched_role,case when matched_role='admin' then 'Вход администратора выполнен' else 'Вход сотрудника выполнен' end;
end;
$$;

create or replace function public.set_repair_member_name(p_name text)
returns table(ok boolean,message text)
language plpgsql
security definer
set search_path=''
as $$
declare
  actor uuid:=auth.uid();
  clean_name text:=trim(coalesce(p_name,''));
begin
  if actor is null or not exists(
    select 1 from public.app_access_sessions s
    where s.user_id=actor and s.active and s.access_role in ('staff','admin')
  ) then
    raise exception 'Нет доступа к приложению' using errcode='42501';
  end if;
  if length(clean_name) not between 2 and 120 then
    return query select false,'Укажите имя сотрудника.'::text;
    return;
  end if;

  insert into public.repair_members(user_id,display_name,active)
  values(actor,clean_name,true)
  on conflict(user_id) do update
  set display_name=excluded.display_name,active=true;

  return query select true,'Имя сохранено'::text;
end;
$$;

revoke all on function public.get_app_access() from public,anon,authenticated;
revoke all on function public.unlock_app(text) from public,anon,authenticated;
revoke all on function public.set_repair_member_name(text) from public,anon,authenticated;
grant execute on function public.get_app_access() to authenticated;
grant execute on function public.unlock_app(text) to authenticated;
grant execute on function public.set_repair_member_name(text) to authenticated;

-- The authenticated application session may read and edit norms only as admin.
-- The legacy anonymous policy is removed separately when the new login is published.
create or replace function public.is_app_admin()
returns boolean
language sql
security definer
set search_path=''
stable
as $$
  select exists(
    select 1 from public.app_access_sessions s
    where s.user_id=(select auth.uid()) and s.active and s.access_role='admin'
  );
$$;
revoke all on function public.is_app_admin() from public,anon,authenticated;
grant execute on function public.is_app_admin() to authenticated;

grant select,insert,update,delete on public.norms to authenticated;
drop policy if exists norms_admin_access on public.norms;
create policy norms_admin_access on public.norms
for all to authenticated
using(public.is_app_admin())
with check(public.is_app_admin());

notify pgrst,'reload schema';
commit;

-- Configure or rotate the two codes directly in the private SQL Editor after
-- this migration. Do not commit the statements containing the real codes.
