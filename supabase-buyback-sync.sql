-- URALSTORE shared buyback state v1.
-- Apply once in the existing Supabase project's SQL Editor.

begin;

create table if not exists public.buyback_shared_state (
  id smallint primary key default 1 check (id = 1),
  state jsonb not null default '{"categories":[]}'::jsonb,
  history jsonb not null default '[]'::jsonb,
  column_order jsonb not null default '{"used":["model","memory","configuration","condition","price","note"],"new":["model","memory","configuration","price","note"]}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

alter table public.buyback_shared_state enable row level security;

grant select,insert,update,delete on public.buyback_shared_state to authenticated;

drop policy if exists buyback_shared_access on public.buyback_shared_state;
create policy buyback_shared_access on public.buyback_shared_state
for all to authenticated
using (public.has_app_access())
with check (public.has_app_access());

do $$
begin
  if not exists(
    select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='buyback_shared_state'
  ) then
    alter publication supabase_realtime add table public.buyback_shared_state;
  end if;
end $$;

notify pgrst,'reload schema';
commit;
