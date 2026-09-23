-- Additive: existing records, schemas and usage are unchanged; boards start empty.
begin;
alter table pipechat.workspace_metadata add column todo_cards jsonb not null default '[]'::jsonb check(jsonb_typeof(todo_cards)='array');

create function pipechat.validate_todo(p_cards jsonb,p_deals jsonb,p_defs jsonb) returns jsonb
language plpgsql immutable set search_path=pg_catalog as $$
declare c jsonb; k text; ids text[]:='{}'; raw_id numeric; d date;
begin
  if jsonb_typeof(p_cards) is distinct from 'array' then raise sqlstate 'PT400' using message='Invalid To Do board.'; end if;
  if jsonb_array_length(p_cards)>2000 then raise sqlstate 'PT400' using message='A To Do board supports up to 2,000 cards.'; end if;
  for c in select value from jsonb_array_elements(p_cards) loop
    if jsonb_typeof(c) is distinct from 'object' then raise sqlstate 'PT400' using message='Invalid To Do card.'; end if;
    if (select count(*) from jsonb_object_keys(c))<>8 or not c ?& array['id','recordId','status','nextAction','dueDate','nextField','followField','ownerField'] or
       jsonb_typeof(c->'id') is distinct from 'string' or c->>'id' !~ '^todo_[a-z0-9_]{1,60}$' or c->>'id'=any(ids) or
       jsonb_typeof(c->'recordId') is distinct from 'number' or coalesce(c->>'status','') not in ('To Do','In Progress','Done') or
       jsonb_typeof(c->'nextAction') is distinct from 'string' or pipechat.js_length(c->>'nextAction')>500 or (c->>'nextAction') ~ U&'[\0001-\0008\000b\000c\000e-\001f\007f]' or
       jsonb_typeof(c->'dueDate') is distinct from 'string' then raise sqlstate 'PT400' using message='Invalid To Do card.'; end if;
    raw_id:=(c->>'recordId')::numeric;
    if raw_id<1 or raw_id>9007199254740991 or raw_id<>trunc(raw_id) or not exists(select 1 from jsonb_array_elements(p_deals) where value->'id'=c->'recordId') then raise sqlstate 'PT400' using message='Missing linked CRM record.'; end if;
    if c->>'dueDate'<>'' then
      if c->>'dueDate' !~ '^\d{4}-\d{2}-\d{2}$' then raise sqlstate 'PT400' using message='Invalid card due date.'; end if;
      begin d:=(c->>'dueDate')::date; exception when others then raise sqlstate 'PT400' using message='Invalid card due date.'; end;
      if to_char(d,'YYYY-MM-DD')<>c->>'dueDate' then raise sqlstate 'PT400' using message='Invalid card due date.'; end if;
    end if;
    foreach k in array array['nextField','followField','ownerField'] loop
      if c->k<>'null'::jsonb and not exists(select 1 from jsonb_array_elements(p_defs) where value->'id'=c->k and (value->>'type' in ('text','choice') or k='followField' and value->>'type'='date')) then raise sqlstate 'PT400' using message='Invalid linked To Do field.'; end if;
    end loop;
    ids:=array_append(ids,c->>'id');
  end loop;
  return p_cards;
end $$;

create function pipechat.todo_definitions(p_schema jsonb,p_custom jsonb) returns jsonb
language sql immutable set search_path=pg_catalog as $$
  select coalesce(p_schema->'fields',case when p_schema is null or p_schema='null'::jsonb then
    '[{"id":"account","type":"text"},{"id":"stage","type":"choice"},{"id":"value","type":"currency"},{"id":"close","type":"date"},{"id":"owner","type":"text"},{"id":"next","type":"text"},{"id":"follow","type":"text"},{"id":"notes","type":"text"}]'::jsonb
    else '[]'::jsonb end)||p_custom
$$;

-- Prune stored links as well as read projections, so reusing a deleted record ID
-- cannot resurrect an old card. Older four-argument clients retain valid cards.
create function pipechat.prune_todo() returns trigger
language plpgsql set search_path=pg_catalog as $$
declare cards jsonb:='[]'; c jsonb; k text; defs jsonb:=pipechat.todo_definitions(new.table_schema,new.custom_fields);
begin
  for c in select value from jsonb_array_elements(new.todo_cards) loop
    if not exists(select 1 from pipechat.crm_records r where r.workspace_id=new.workspace_id and to_jsonb(r.record_id)=c->'recordId') then continue; end if;
    foreach k in array array['nextField','followField','ownerField'] loop
      if not exists(select 1 from jsonb_array_elements(defs) f where f->'id'=c->k and (f->>'type' in ('text','choice') or k='followField' and f->>'type'='date')) then c:=jsonb_set(c,array[k],'null'::jsonb); end if;
    end loop;
    cards:=cards||jsonb_build_array(c);
  end loop;
  new.todo_cards:=cards;return new;
end $$;
create trigger prune_todo before update on pipechat.workspace_metadata for each row execute function pipechat.prune_todo();
revoke all on function pipechat.todo_definitions(jsonb,jsonb),pipechat.prune_todo() from public,anon,authenticated,service_role;

-- Project only surviving records/fields, including writes from an older app tab.
create or replace function pipechat.crm_snapshot(p_workspace uuid) returns jsonb
language sql stable set search_path=pg_catalog as $$
  select jsonb_build_object(
    'deals',coalesce((select jsonb_agg(r.cells||jsonb_build_object('id',r.record_id,'history',r.history,'activity',r.activity,'health',r.health) order by r.position) from pipechat.crm_records r where r.workspace_id=w.id),'[]'::jsonb),
    'customFields',m.custom_fields,'tableSchema',m.table_schema,'updatedAt',pipechat.timestamp_text(w.updated_at),
    'todoCards',coalesce((select jsonb_agg(c.value||jsonb_build_object(
      'nextField',case when exists(select 1 from jsonb_array_elements(pipechat.todo_definitions(m.table_schema,m.custom_fields)) f where f->'id'=c.value->'nextField' and f->>'type' in ('text','choice')) then c.value->'nextField' else 'null'::jsonb end,
      'followField',case when exists(select 1 from jsonb_array_elements(pipechat.todo_definitions(m.table_schema,m.custom_fields)) f where f->'id'=c.value->'followField' and f->>'type' in ('text','choice','date')) then c.value->'followField' else 'null'::jsonb end,
      'ownerField',case when exists(select 1 from jsonb_array_elements(pipechat.todo_definitions(m.table_schema,m.custom_fields)) f where f->'id'=c.value->'ownerField' and f->>'type' in ('text','choice')) then c.value->'ownerField' else 'null'::jsonb end) order by c.ordinality)
      from jsonb_array_elements(m.todo_cards) with ordinality c where exists(select 1 from pipechat.crm_records r where r.workspace_id=w.id and to_jsonb(r.record_id)=c.value->'recordId')),'[]'::jsonb))
  from pipechat.workspaces w join pipechat.workspace_metadata m on m.workspace_id=w.id where w.id=p_workspace
$$;

-- The existing RPC owns the workspace lock and CAS version. This wrapper runs
-- in the same transaction, so a late card-validation failure rolls back rows too.
create function public.pipechat_write_workspace(p_deals jsonb,p_custom_fields jsonb,p_table_schema jsonb,p_expected_updated_at text,p_todo_cards jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare uid uuid:=pipechat.require_user(); wid uuid:=pipechat.workspace_for(uid); result jsonb; cards jsonb;
begin
  if octet_length(jsonb_build_object('deals',p_deals,'customFields',p_custom_fields,'tableSchema',p_table_schema,'todoCards',p_todo_cards)::text)>16777216 then raise sqlstate 'PT400' using message='The workspace exceeds 16 MiB.'; end if;
  result:=public.pipechat_write_crm(p_deals,p_custom_fields,p_table_schema,p_expected_updated_at);
  cards:=pipechat.validate_todo(p_todo_cards,result->'deals',pipechat.todo_definitions(result->'tableSchema',result->'customFields'));
  update pipechat.workspace_metadata set todo_cards=cards where workspace_id=wid;
  result:=pipechat.crm_snapshot(wid);
  if octet_length(result::text)>16777216 then raise sqlstate 'PT400' using message='The workspace exceeds 16 MiB.'; end if;
  return result;
end $$;
revoke all on function pipechat.validate_todo(jsonb,jsonb,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.pipechat_write_workspace(jsonb,jsonb,jsonb,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.pipechat_write_workspace(jsonb,jsonb,jsonb,text,jsonb) to authenticated;

create or replace function public.pipechat_reset_crm(p_expected_updated_at text,p_confirm boolean) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare uid uuid:=pipechat.require_user(); wid uuid:=pipechat.workspace_for(uid); version timestamptz;
begin
  if p_confirm is distinct from true then raise sqlstate 'PT400' using message='Explicit reset confirmation is required.'; end if;
  if p_expected_updated_at is not null and (pipechat.js_length(p_expected_updated_at)>256 or p_expected_updated_at='' or p_expected_updated_at ~ U&'[\0001-\001f\007f]') then raise sqlstate 'PT400' using message='Invalid CRM version.'; end if;
  select updated_at into version from pipechat.workspaces where id=wid and owner_id=uid for update;
  if not found then raise sqlstate 'PT403' using message='Only the workspace owner can reset it.'; end if;
  if p_expected_updated_at is distinct from pipechat.timestamp_text(version) then raise sqlstate 'PT409' using message='This CRM changed in another window. Refresh before resetting.'; end if;
  delete from pipechat.crm_records where workspace_id=wid;
  update pipechat.workspace_metadata set table_schema='{"status":"pending"}'::jsonb,custom_fields='[]'::jsonb,todo_cards='[]'::jsonb where workspace_id=wid;
  update pipechat.workspaces set updated_at=greatest(clock_timestamp(),version+interval '1 microsecond') where id=wid;
  return pipechat.crm_snapshot(wid);
end $$;
notify pgrst,'reload schema';
commit;
