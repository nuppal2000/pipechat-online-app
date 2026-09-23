-- Freeze linked card values once. Original v1 cards remain as a private archive.
begin;
alter table pipechat.workspace_metadata add column todo_cards_v2 jsonb not null default '[]'::jsonb check(jsonb_typeof(todo_cards_v2)='array');

create function pipechat.validate_todo_v2(p_cards jsonb,p_deals jsonb) returns jsonb
language plpgsql immutable set search_path=pg_catalog as $$
declare c jsonb; ids text[]:='{}'; raw_id numeric; d date; k text;
begin
  if jsonb_typeof(p_cards) is distinct from 'array' then raise sqlstate 'PT400' using message='Invalid To Do board.'; end if;
  if jsonb_array_length(p_cards)>2000 then raise sqlstate 'PT400' using message='A To Do board supports up to 2,000 cards.'; end if;
  for c in select value from jsonb_array_elements(p_cards) loop
    if jsonb_typeof(c) is distinct from 'object' then raise sqlstate 'PT400' using message='Invalid To Do card.'; end if;
    if (select count(*) from jsonb_object_keys(c))<>6 or not c ?& array['id','recordId','status','nextAction','notes','dueDate'] or
       jsonb_typeof(c->'id') is distinct from 'string' or c->>'id' !~ '^todo_[a-z0-9_]{1,60}$' or c->>'id'=any(ids) or
       jsonb_typeof(c->'recordId') is distinct from 'number' or coalesce(c->>'status','') not in ('To Do','In Progress','Done') then raise sqlstate 'PT400' using message='Invalid To Do card.'; end if;
    raw_id:=(c->>'recordId')::numeric;
    if raw_id<1 or raw_id>9007199254740991 or raw_id<>trunc(raw_id) or not exists(select 1 from jsonb_array_elements(p_deals) where value->'id'=c->'recordId') then raise sqlstate 'PT400' using message='Missing linked CRM record.'; end if;
    foreach k in array array['nextAction','notes','dueDate'] loop
      if jsonb_typeof(c->k) is distinct from 'string' or (c->>k) ~ U&'[\0001-\0008\000b\000c\000e-\001f\007f]' then raise sqlstate 'PT400' using message='Invalid card text.'; end if;
    end loop;
    if pipechat.js_length(c->>'nextAction')>12000 or pipechat.js_length(c->>'notes')>16000 then raise sqlstate 'PT400' using message='Card text is too long.'; end if;
    if c->>'dueDate'<>'' then
      if c->>'dueDate' !~ '^\d{4}-\d{2}-\d{2}$' then raise sqlstate 'PT400' using message='Invalid card due date.'; end if;
      begin d:=(c->>'dueDate')::date; exception when others then raise sqlstate 'PT400' using message='Invalid card due date.'; end;
      if to_char(d,'YYYY-MM-DD')<>c->>'dueDate' then raise sqlstate 'PT400' using message='Invalid card due date.'; end if;
    end if;
    ids:=array_append(ids,c->>'id');
  end loop;
  return p_cards;
end $$;

do $$
declare m record; c jsonb; cells jsonb; cards jsonb; action text; due text; valid_date boolean; d date;
begin
  for m in select * from pipechat.workspace_metadata loop
    cards:='[]';
    for c in select value from jsonb_array_elements(m.todo_cards) loop
      select r.cells into cells from pipechat.crm_records r where r.workspace_id=m.workspace_id and to_jsonb(r.record_id)=c->'recordId';
      if not found then continue; end if;
      action:=case when c->>'nextField' is not null then coalesce(cells->>(c->>'nextField'),'') else c->>'nextAction' end;
      due:=case when c->>'followField' is not null then coalesce(cells->>(c->>'followField'),'') else c->>'dueDate' end;
      valid_date:=due='';
      if due ~ '^\d{4}-\d{2}-\d{2}$' then
        begin d:=due::date; valid_date:=to_char(d,'YYYY-MM-DD')=due; exception when others then valid_date:=false; end;
      end if;
      cards:=cards||jsonb_build_array(jsonb_build_object('id',c->'id','recordId',c->'recordId','status',c->'status','nextAction',action,'notes',case when valid_date then '' else 'Previous due information: '||due end,'dueDate',case when valid_date then due else '' end));
    end loop;
    perform pipechat.validate_todo_v2(cards,(pipechat.crm_snapshot(m.workspace_id))->'deals');
    update pipechat.workspace_metadata set todo_cards_v2=cards where workspace_id=m.workspace_id;
  end loop;
end $$;

drop trigger prune_todo on pipechat.workspace_metadata;
create function pipechat.prune_todo_v2() returns trigger
language plpgsql set search_path=pg_catalog as $$
begin
  select coalesce(jsonb_agg(c.value order by c.ordinality),'[]'::jsonb) into new.todo_cards_v2
    from jsonb_array_elements(new.todo_cards_v2) with ordinality c
    where exists(select 1 from pipechat.crm_records r where r.workspace_id=new.workspace_id and to_jsonb(r.record_id)=c.value->'recordId');
  return new;
end $$;
create trigger prune_todo_v2 before update on pipechat.workspace_metadata for each row execute function pipechat.prune_todo_v2();

create function pipechat.crm_snapshot_v2(p_workspace uuid) returns jsonb
language sql stable set search_path=pg_catalog as $$
  select pipechat.crm_snapshot(p_workspace)||jsonb_build_object('todoCards',m.todo_cards_v2)
  from pipechat.workspace_metadata m where m.workspace_id=p_workspace
$$;
create function public.pipechat_read_workspace() returns jsonb
language sql security definer set search_path=pg_catalog as $$
  select pipechat.crm_snapshot_v2(pipechat.workspace_for(pipechat.require_user()))
$$;

create function public.pipechat_write_workspace_v2(p_deals jsonb,p_custom_fields jsonb,p_table_schema jsonb,p_expected_updated_at text,p_todo_cards jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare uid uuid:=pipechat.require_user(); wid uuid:=pipechat.workspace_for(uid); result jsonb; cards jsonb;
begin
  if octet_length(jsonb_build_object('deals',p_deals,'customFields',p_custom_fields,'tableSchema',p_table_schema,'todoCards',p_todo_cards)::text)>16777216 then raise sqlstate 'PT400' using message='The workspace exceeds 16 MiB.'; end if;
  result:=public.pipechat_write_crm(p_deals,p_custom_fields,p_table_schema,p_expected_updated_at);
  cards:=pipechat.validate_todo_v2(p_todo_cards,result->'deals');
  update pipechat.workspace_metadata set todo_cards_v2=cards where workspace_id=wid;
  result:=pipechat.crm_snapshot_v2(wid);
  if octet_length(result::text)>16777216 then raise sqlstate 'PT400' using message='The workspace exceeds 16 MiB.'; end if;
  return result;
end $$;

-- Card edits never write CRM rows, history, columns or allowance counters.
create function public.pipechat_write_todo(p_todo_cards jsonb,p_expected_updated_at text) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare uid uuid:=pipechat.require_user(); wid uuid:=pipechat.workspace_for(uid); version timestamptz; current_data jsonb; cards jsonb; result jsonb;
begin
  select updated_at into version from pipechat.workspaces where id=wid and owner_id=uid for update;
  if not found then raise sqlstate 'PT403' using message='Only the workspace owner can edit it.'; end if;
  if p_expected_updated_at is distinct from pipechat.timestamp_text(version) then raise sqlstate 'PT409' using message='This workspace changed in another window. Refresh before saving.'; end if;
  if octet_length(p_todo_cards::text)>16777216 then raise sqlstate 'PT400' using message='The board exceeds 16 MiB.'; end if;
  current_data:=pipechat.crm_snapshot_v2(wid);
  cards:=pipechat.validate_todo_v2(p_todo_cards,current_data->'deals');
  if exists(select 1 from jsonb_array_elements(cards) n join jsonb_array_elements(current_data->'todoCards') o on n->'id'=o->'id' where n->'recordId'<>o->'recordId') then raise sqlstate 'PT400' using message='An existing card cannot be relinked.'; end if;
  update pipechat.workspace_metadata set todo_cards_v2=cards where workspace_id=wid;
  update pipechat.workspaces set updated_at=greatest(clock_timestamp(),version+interval '1 microsecond') where id=wid;
  result:=pipechat.crm_snapshot_v2(wid);
  if octet_length(result::text)>16777216 then raise sqlstate 'PT400' using message='The workspace exceeds 16 MiB.'; end if;
  return result;
end $$;

-- A stale browser must reload instead of silently writing the old linked model.
create or replace function public.pipechat_write_workspace(p_deals jsonb,p_custom_fields jsonb,p_table_schema jsonb,p_expected_updated_at text,p_todo_cards jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
begin
  perform pipechat.require_user();
  raise sqlstate 'PT409' using message='The To Do board has been updated. Reload PipeChat before saving.';
end $$;
revoke all on function pipechat.validate_todo_v2(jsonb,jsonb),pipechat.prune_todo_v2(),pipechat.crm_snapshot_v2(uuid) from public,anon,authenticated,service_role;
revoke all on function public.pipechat_read_workspace(),public.pipechat_write_workspace_v2(jsonb,jsonb,jsonb,text,jsonb),public.pipechat_write_todo(jsonb,text) from public,anon,authenticated,service_role;
grant execute on function public.pipechat_read_workspace(),public.pipechat_write_workspace_v2(jsonb,jsonb,jsonb,text,jsonb),public.pipechat_write_todo(jsonb,text) to authenticated;
notify pgrst,'reload schema';
commit;
