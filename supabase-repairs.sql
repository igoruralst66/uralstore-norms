-- URALSTORE repairs v1. Apply once in the existing project's SQL Editor.
-- Transactional, additive migration. Existing norms and auth users are untouched.
begin;
create table public.repair_members (
  user_id uuid primary key references auth.users(id),
  display_name text not null check(length(trim(display_name)) between 1 and 120),
  active boolean not null default true
);
alter table public.repair_members enable row level security;
revoke all on public.repair_members from anon, authenticated;
grant select on public.repair_members to authenticated;
create policy repair_member_self on public.repair_members for select to authenticated using(user_id=(select auth.uid()));

create table public.repairs (
  id bigint generated always as identity primary key,
  client text not null check(length(trim(client)) between 1 and 300),
  phone text not null default '' check(length(phone)<=100),
  device text not null check(length(trim(device)) between 1 and 300),
  serial text not null default '' check(length(serial)<=100),
  context text not null default '' check(length(context)<=5000),
  reason text not null check(length(trim(reason)) between 1 and 5000),
  service text not null default '' check(length(service)<=300),
  owner text not null check(length(trim(owner)) between 1 and 300),
  approver text not null default '' check(length(approver)<=300),
  status text not null default 'received' check(status in ('received','service','waiting','ready','issued','closed')),
  waiting_reason text not null default '' check(length(waiting_reason)<=1000),
  next_action text not null default '' check(length(next_action)<=3000),
  due_date date,
  client_total numeric(12,2) check(client_total>=0),
  client_paid numeric(12,2) not null default 0 check(client_paid>=0),
  client_paid_date date,
  client_method text not null default '' check(client_method in ('','cash','card','transfer','other')),
  service_total numeric(12,2) check(service_total>=0),
  service_paid numeric(12,2) not null default 0 check(service_paid>=0),
  service_paid_date date,
  fs_recorded boolean not null default false,
  fs_reference text not null default '' check(length(fs_reference)<=1000),
  repeat_of bigint references public.repairs(id),
  notes text not null default '' check(length(notes)<=10000),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id),
  updated_by uuid not null references auth.users(id),
  closed_at timestamptz,
  constraint repair_wait_reason check(status<>'waiting' or length(trim(waiting_reason))>0),
  constraint repair_next_step check(status='closed' or length(trim(next_action))>0),
  constraint repair_client_payment check((client_paid=0 or (client_total is not null and client_paid_date is not null)) and (client_total is null or client_paid<=client_total)),
  constraint repair_service_payment check((service_paid=0 or (service_total is not null and service_paid_date is not null)) and (service_total is null or service_paid<=service_total)),
  constraint repair_close_settled check(status<>'closed' or (client_total is not null and service_total is not null and client_total=client_paid and service_total=service_paid)),
  constraint repair_repeat_not_self check(repeat_of<>id)
);
create index repairs_status_updated on public.repairs(status,updated_at desc);
alter table public.repairs enable row level security;
revoke all on public.repairs from anon, authenticated;
revoke all on sequence public.repairs_id_seq from anon, authenticated;
grant select on public.repairs to authenticated;
create policy repairs_staff_read on public.repairs for select to authenticated using(exists(select 1 from public.repair_members where user_id=(select auth.uid()) and active));

create table public.repair_events (
  id bigint generated always as identity primary key,
  repair_id bigint not null references public.repairs(id),
  actor_id uuid not null references auth.users(id),
  actor_name text not null,
  created_at timestamptz not null default now(),
  note text not null check(length(note)<=5000),
  before_data jsonb,
  after_data jsonb not null
);
create index repair_events_order on public.repair_events(repair_id,id desc);
alter table public.repair_events enable row level security;
revoke all on public.repair_events from anon, authenticated;
revoke all on sequence public.repair_events_id_seq from anon, authenticated;
grant select on public.repair_events to authenticated;
create policy repair_events_staff_read on public.repair_events for select to authenticated using(exists(select 1 from public.repair_members where user_id=(select auth.uid()) and active));

-- Only this authenticated, allowlisted function can write orders and history.
-- Row lock + version prevent one employee overwriting another employee's changes.
create function public.save_repair(p_id bigint,p_version integer,p_data jsonb,p_note text default '')
returns public.repairs language plpgsql security definer set search_path='' as $$
declare
  prev public.repairs; item public.repairs; saved public.repairs;
  actor uuid:=auth.uid(); actor_label text; old_json jsonb;
begin
  select display_name into actor_label from public.repair_members where user_id=actor and active;
  if actor_label is null then raise exception 'Нет доступа к ремонтам' using errcode='42501'; end if;
  if p_data is null or jsonb_typeof(p_data)<>'object' then raise exception 'Неверные данные заказа'; end if;
  if length(coalesce(p_note,''))>5000 then raise exception 'Комментарий слишком длинный'; end if;
  if p_id is not null then
    select * into prev from public.repairs where id=p_id for update;
    if not found then raise exception 'Заказ не найден'; end if;
    if p_version is distinct from prev.version then raise exception 'Заказ уже изменён другим сотрудником. Закройте карточку, обновите список и повторите изменение.' using errcode='40001'; end if;
    old_json:=to_jsonb(prev);
  end if;
  select * into item from jsonb_populate_record(null::public.repairs,coalesce(old_json,'{}'::jsonb)||p_data);
  if item.client_paid_date>(now() at time zone 'Asia/Yekaterinburg')::date or item.service_paid_date>(now() at time zone 'Asia/Yekaterinburg')::date then raise exception 'Дата оплаты не может быть в будущем'; end if;
  if item.repeat_of is not null and (item.repeat_of=p_id or (p_id is not null and item.repeat_of>=p_id)) then raise exception 'Повтор должен ссылаться на более ранний заказ'; end if;
  if item.status='closed' and (p_id is null or prev.status not in ('issued','closed')) then raise exception 'Сначала отметьте устройство как выданное'; end if;
  if p_id is null then
    insert into public.repairs(client,phone,device,serial,context,reason,service,owner,approver,status,waiting_reason,next_action,due_date,client_total,client_paid,client_paid_date,client_method,service_total,service_paid,service_paid_date,fs_recorded,fs_reference,repeat_of,notes,created_by,updated_by)
    values(item.client,item.phone,item.device,item.serial,item.context,item.reason,item.service,item.owner,item.approver,item.status,item.waiting_reason,item.next_action,item.due_date,item.client_total,item.client_paid,item.client_paid_date,item.client_method,item.service_total,item.service_paid,item.service_paid_date,item.fs_recorded,item.fs_reference,item.repeat_of,item.notes,actor,actor) returning * into saved;
  else
    update public.repairs set client=item.client,phone=item.phone,device=item.device,serial=item.serial,context=item.context,reason=item.reason,service=item.service,owner=item.owner,approver=item.approver,status=item.status,waiting_reason=item.waiting_reason,next_action=item.next_action,due_date=item.due_date,client_total=item.client_total,client_paid=item.client_paid,client_paid_date=item.client_paid_date,client_method=item.client_method,service_total=item.service_total,service_paid=item.service_paid,service_paid_date=item.service_paid_date,fs_recorded=item.fs_recorded,fs_reference=item.fs_reference,repeat_of=item.repeat_of,notes=item.notes,version=prev.version+1,updated_at=now(),updated_by=actor,closed_at=case when item.status='closed' then coalesce(prev.closed_at,now()) else null end
    where id=p_id returning * into saved;
  end if;
  insert into public.repair_events(repair_id,actor_id,actor_name,note,before_data,after_data)
  values(saved.id,actor,actor_label,coalesce(nullif(trim(p_note),''),case when p_id is null then 'Заказ создан' else 'Карточка обновлена' end),old_json,to_jsonb(saved));
  return saved;
end;
$$;
revoke all on function public.save_repair(bigint,integer,jsonb,text) from public,anon,authenticated;
grant execute on function public.save_repair(bigint,integer,jsonb,text) to authenticated;
notify pgrst,'reload schema';
commit;
