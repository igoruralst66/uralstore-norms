-- URALSTORE repairs v1.0: drafts and reliable history.
-- Safe to apply once after supabase-repairs.sql.
begin;

alter table public.repairs
  alter column client set default '',
  alter column device set default '',
  alter column reason set default '',
  alter column owner set default '';

alter table public.repairs
  drop constraint if exists repairs_client_check,
  drop constraint if exists repairs_device_check,
  drop constraint if exists repairs_reason_check,
  drop constraint if exists repairs_owner_check,
  drop constraint if exists repair_wait_reason,
  drop constraint if exists repair_next_step;

alter table public.repairs
  add constraint repairs_client_length check(length(client)<=300),
  add constraint repairs_device_length check(length(device)<=300),
  add constraint repairs_reason_length check(length(reason)<=5000),
  add constraint repairs_owner_length check(length(owner)<=300);

create or replace function public.get_repair_history(p_repair_id bigint)
returns setof public.repair_events
language sql
security definer
set search_path=''
stable
as $$
  select e.*
  from public.repair_events e
  where e.repair_id=p_repair_id
    and exists(
      select 1 from public.repair_members m
      where m.user_id=auth.uid() and m.active
    )
  order by e.id desc
  limit 100;
$$;

revoke all on function public.get_repair_history(bigint) from public,anon,authenticated;
grant execute on function public.get_repair_history(bigint) to authenticated;
notify pgrst,'reload schema';
commit;
