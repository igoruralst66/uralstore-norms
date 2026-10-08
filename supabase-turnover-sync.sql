-- URALSTORE: isolated shared turnover registry. Run once in Supabase SQL Editor.
-- Only creates turnover tables/functions/policies. Existing sections are untouched.
begin;

create table public.turnover_shared_state (
  id smallint primary key check(id=1),
  state jsonb not null,
  version bigint not null default 0 check(version>=0),
  deleted_item_ids jsonb not null default '[]',
  deleted_category_ids jsonb not null default '[]',
  imports jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);
create table public.turnover_events (
  id bigint generated always as identity primary key,
  version bigint not null,
  action text not null,
  actor_name text not null,
  actor_id uuid references auth.users(id),
  created_at timestamptz not null default now(),
  details jsonb not null default '{}',
  before_state jsonb not null,
  after_state jsonb not null
);
alter table public.turnover_shared_state enable row level security;
alter table public.turnover_events enable row level security;
revoke all on public.turnover_shared_state,public.turnover_events from anon,authenticated;
grant select on public.turnover_shared_state,public.turnover_events to authenticated;
create policy turnover_read on public.turnover_shared_state for select to authenticated using(public.has_app_access());
create policy turnover_history_read on public.turnover_events for select to authenticated using(public.has_app_access());

insert into public.turnover_shared_state(id,state) values(1,
  '{"categories":[{"id":"phones","name":"Телефоны"},{"id":"laptops","name":"Ноутбуки"},{"id":"watches","name":"Часы"},{"id":"audio","name":"Наушники"},{"id":"tablets","name":"Планшеты"},{"id":"other","name":"Другое"}],"items":[]}'::jsonb);

create function public.validate_turnover_state(p_state jsonb)
returns void language plpgsql set search_path='' as $$
declare v_entry jsonb;
begin
  if p_state is null or jsonb_typeof(p_state)<>'object'
    or jsonb_typeof(p_state->'categories') is distinct from 'array'
    or jsonb_typeof(p_state->'items') is distinct from 'array' then
    raise exception 'Некорректная структура контроля товаров' using errcode='22023';
  end if;
  if pg_column_size(p_state)>10000000 or jsonb_array_length(p_state->'categories')>1000 or jsonb_array_length(p_state->'items')>10000 then
    raise exception 'Копия контроля товаров слишком большая' using errcode='22023';
  end if;
  if exists(select 1 from jsonb_array_elements(p_state->'categories') c group by c->>'id' having count(*)>1)
    or exists(select 1 from jsonb_array_elements(p_state->'items') i group by i->>'id' having count(*)>1) then
    raise exception 'Повторяющиеся идентификаторы в копии' using errcode='22023';
  end if;
  for v_entry in select * from jsonb_array_elements(p_state->'categories') loop
    if jsonb_typeof(v_entry)<>'object' or coalesce(v_entry->>'id','') !~ '^[A-Za-z0-9_-]{1,160}$'
      or length(trim(coalesce(v_entry->>'name',''))) not between 1 and 100 then
      raise exception 'Некорректная категория' using errcode='22023';
    end if;
  end loop;
  for v_entry in select * from jsonb_array_elements(p_state->'items') loop
    if jsonb_typeof(v_entry)<>'object' or coalesce(v_entry->>'id','') !~ '^[A-Za-z0-9_-]{1,160}$'
      or length(trim(coalesce(v_entry->>'name',''))) not between 1 and 180
      or coalesce(v_entry->>'status','') not in ('attention','in_progress','sold')
      or coalesce(v_entry->>'condition','') not in ('new','used')
      or not exists(select 1 from jsonb_array_elements(p_state->'categories') c where c->>'id'=v_entry->>'category') then
      raise exception 'Некорректная позиция или её категория' using errcode='22023';
    end if;
    if v_entry ? 'saleBonus' and (jsonb_typeof(v_entry->'saleBonus')<>'number' or (v_entry->>'saleBonus')::numeric<0 or (v_entry->>'saleBonus')::numeric>1000000000) then
      raise exception 'Некорректная сумма бонуса' using errcode='22023';
    end if;
  end loop;
end;
$$;
revoke all on function public.validate_turnover_state(jsonb) from public,anon,authenticated;

-- Every write is an atomic comparison of versions and appends immutable history.
-- Imports append missing IDs only, preserving all existing shared data even when
-- an old local copy has a newer-looking timestamp. Tombstones stop resurrection.
create function public.save_turnover_state(
  p_state jsonb,
  p_expected_version bigint,
  p_actor text,
  p_action text,
  p_import_key text default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  current_row public.turnover_shared_state;
  next_state jsonb;
  categories jsonb;
  items jsonb;
  entry jsonb;
  receipt jsonb;
  skipped integer:=0;
  added_categories integer:=0;
  added_items integer:=0;
  deleted_items jsonb;
  deleted_categories jsonb;
  actor text:=trim(coalesce(p_actor,''));
begin
  if not public.has_app_access() or auth.uid() is null then
    raise exception 'Нет доступа к приложению' using errcode='42501';
  end if;
  if length(actor) not between 2 and 120 or p_action is null or p_action not in ('create','edit','sold','return','delete','category','import') then
    raise exception 'Некорректное имя или действие' using errcode='22023';
  end if;
  perform public.validate_turnover_state(p_state);
  select * into strict current_row from public.turnover_shared_state where id=1 for update;

  if p_import_key is not null then
    if p_action<>'import' or length(p_import_key) not between 8 and 160 then
      raise exception 'Некорректный ключ переноса' using errcode='22023';
    end if;
    if current_row.imports ? p_import_key then
      return jsonb_build_object('state',current_row.state,'version',current_row.version,'receipt',current_row.imports->p_import_key);
    end if;
  elsif p_action='import' then
    raise exception 'Для переноса нужен ключ' using errcode='22023';
  end if;

  if p_expected_version is null or current_row.version<>p_expected_version then
    raise exception 'Данные изменены с другого устройства. Обновите список.' using errcode='PT409';
  end if;
  deleted_items:=current_row.deleted_item_ids;
  deleted_categories:=current_row.deleted_category_ids;

  if p_import_key is not null then
    categories:=current_row.state->'categories';items:=current_row.state->'items';
    for entry in select * from jsonb_array_elements(p_state->'categories') loop
      if deleted_categories ? (entry->>'id') then skipped:=skipped+1;
      elsif exists(select 1 from jsonb_array_elements(categories) c where c->>'id'=entry->>'id') then
        if not exists(select 1 from jsonb_array_elements(categories) c where c=entry) then skipped:=skipped+1;end if;
      else categories:=categories||jsonb_build_array(entry);added_categories:=added_categories+1;
      end if;
    end loop;
    for entry in select * from jsonb_array_elements(p_state->'items') loop
      if deleted_items ? (entry->>'id')
        or exists(select 1 from jsonb_array_elements(items) i where i->>'id'=entry->>'id')
        or not exists(select 1 from jsonb_array_elements(categories) c where c->>'id'=entry->>'category')
        or exists(select 1 from jsonb_array_elements(p_state->'categories') lc join jsonb_array_elements(categories) rc on rc->>'id'=lc->>'id' where lc->>'id'=entry->>'category' and lc->>'name'<>rc->>'name') then
        skipped:=skipped+1;
      else items:=items||jsonb_build_array(entry);added_items:=added_items+1;
      end if;
    end loop;
    next_state:=jsonb_build_object('categories',categories,'items',items);
    receipt:=jsonb_build_object('addedCategories',added_categories,'addedItems',added_items,'skipped',skipped,'at',now());
  else
    next_state:=p_state;
    -- Omitting an ID is deletion, so role checks are enforced on the server.
    for entry in select * from jsonb_array_elements(current_row.state->'items') loop
      if not exists(select 1 from jsonb_array_elements(next_state->'items') i where i->>'id'=entry->>'id') then
        if not public.is_app_admin() then raise exception 'Удаление доступно администратору' using errcode='42501';end if;
        if not deleted_items ? (entry->>'id') then deleted_items:=deleted_items||jsonb_build_array(entry->>'id');end if;
      end if;
    end loop;
    for entry in select * from jsonb_array_elements(current_row.state->'categories') loop
      if not exists(select 1 from jsonb_array_elements(next_state->'categories') c where c->>'id'=entry->>'id') then
        if not public.is_app_admin() then raise exception 'Удаление доступно администратору' using errcode='42501';end if;
        if not deleted_categories ? (entry->>'id') then deleted_categories:=deleted_categories||jsonb_build_array(entry->>'id');end if;
      end if;
    end loop;
    if exists(select 1 from jsonb_array_elements(next_state->'items') i where deleted_items ? (i->>'id'))
      or exists(select 1 from jsonb_array_elements(next_state->'categories') c where deleted_categories ? (c->>'id')) then
      raise exception 'Удалённую запись нельзя вернуть устаревшей копией' using errcode='PT409';
    end if;
  end if;
  perform public.validate_turnover_state(next_state);
  update public.turnover_shared_state
  set state=next_state,version=current_row.version+1,deleted_item_ids=deleted_items,deleted_category_ids=deleted_categories,
    imports=case when p_import_key is null then imports else imports||jsonb_build_object(p_import_key,receipt) end,
    updated_at=now(),updated_by=auth.uid()
  where id=1;
  insert into public.turnover_events(version,action,actor_name,actor_id,details,before_state,after_state)
  values(current_row.version+1,p_action,actor,auth.uid(),coalesce(receipt,'{}'::jsonb),current_row.state,next_state);
  return jsonb_build_object('state',next_state,'version',current_row.version+1,'receipt',receipt);
end;
$$;
revoke all on function public.save_turnover_state(jsonb,bigint,text,text,text) from public,anon,authenticated;
grant execute on function public.save_turnover_state(jsonb,bigint,text,text,text) to authenticated;

alter publication supabase_realtime add table public.turnover_shared_state;
notify pgrst,'reload schema';
commit;
