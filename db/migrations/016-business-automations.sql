-- Durable stage-change workflows. Requires 001-014 (and the journal workflow hooks).
-- No scheduled triggers, external delivery, or caller-supplied transition events.
begin;

create table pipechat.business_automations (
  workspace_id uuid not null references pipechat.workspaces(id) on delete cascade,
  id text not null check (id ~ '^workflow_[a-z0-9_]{1,60}$'),
  state jsonb not null,
  primary key(workspace_id,id)
);
-- Execution identities survive undo and task deletion. Never trim this ledger.
create table pipechat.business_automation_events (
  workspace_id uuid not null references pipechat.workspaces(id) on delete cascade,
  workflow_id text not null,
  event_id text not null,
  event jsonb not null,
  execution jsonb not null,
  primary key(workspace_id,workflow_id,event_id)
);
create table pipechat.business_automation_receipts (
  workspace_id uuid not null references pipechat.workspaces(id) on delete cascade,
  action_id text not null,
  receipt jsonb not null,
  primary key(workspace_id,action_id)
);
alter table pipechat.business_automations enable row level security;
alter table pipechat.business_automation_events enable row level security;
alter table pipechat.business_automation_receipts enable row level security;

create function pipechat.automation_object(p_value jsonb,p_keys text[]) returns void
language plpgsql immutable set search_path=pg_catalog as $$
begin
  if jsonb_typeof(p_value) is distinct from 'object' then raise sqlstate 'PT400' using message='Invalid workflow object.'; end if;
  if not p_value ?& p_keys or (select count(*) from jsonb_object_keys(p_value))<>cardinality(p_keys) then
    raise sqlstate 'PT400' using message='Invalid workflow fields.';
  end if;
end $$;

create function pipechat.automation_text(p_value jsonb,p_max integer,p_blank boolean default false) returns void
language plpgsql immutable set search_path=pg_catalog as $$
begin
  if jsonb_typeof(p_value) is distinct from 'string' or pipechat.js_length(p_value#>>'{}')>p_max or
    (p_value#>>'{}') ~ U&'[\0001-\0008\000b\000c\000e-\001f\007f]' or
    not p_blank and pipechat.trim_text(p_value#>>'{}')='' then
    raise sqlstate 'PT400' using message='Invalid workflow text.';
  end if;
end $$;

create function pipechat.automation_normalize(p_value text) returns text
language sql immutable set search_path=pg_catalog as $$
  select lower(regexp_replace(pipechat.trim_text(normalize(p_value,NFKC)),
    '[[:space:]\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+',' ','g'))
$$;
create function pipechat.automation_matches(p_text text,p_match jsonb) returns boolean
language sql immutable set search_path=pg_catalog as $$
  select case when p_match->>'operator'='equals' then
    pipechat.automation_normalize(p_text)=pipechat.automation_normalize(p_match->>'value')
    else strpos(pipechat.automation_normalize(p_text),pipechat.automation_normalize(p_match->>'value'))>0 end
$$;

create function pipechat.automation_validate_spec(p_spec jsonb,p_schema jsonb,p_custom jsonb) returns void
language plpgsql stable set search_path=pg_catalog as $$
declare tr jsonb:=p_spec->'trigger'; act jsonb:=p_spec->'action'; cond jsonb; n numeric;
begin
  perform pipechat.automation_object(p_spec,array['version','name','timezone','trigger','conditions','action']);
  if p_spec->'version' is distinct from '1'::jsonb then raise sqlstate 'PT400' using message='Invalid workflow version.'; end if;
  perform pipechat.automation_text(p_spec->'name',120);
  perform pipechat.automation_text(p_spec->'timezone',100);
  if p_spec->>'timezone' !~ '^[A-Za-z_]+(/[A-Za-z0-9_+\-]+)*$' or not exists
    (select 1 from pg_timezone_names where lower(name)=lower(p_spec->>'timezone')) then
    raise sqlstate 'PT400' using message='Provide an explicit valid timezone.';
  end if;
  perform pipechat.automation_object(tr,array['type','field','to']);
  perform pipechat.automation_text(tr->'field',65);
  perform pipechat.automation_text(tr->'to',80);
  if tr->>'type' is distinct from 'field_changes_to' or tr->>'field' !~ '^[a-z][a-z0-9_]{0,64}$' or
    tr->>'field' in ('constructor','prototype','__proto__') or p_schema->>'status' is distinct from 'ready' or not exists
    (select 1 from jsonb_array_elements(coalesce(p_schema->'fields','[]')||p_custom) f
      where f->'id'=tr->'field' and f->>'type'='choice' and f->'options' @> jsonb_build_array(tr->'to')) then
    raise sqlstate 'PT400' using message='The workflow trigger choice no longer exists.';
  end if;
  if jsonb_typeof(p_spec->'conditions') is distinct from 'array' then raise sqlstate 'PT400' using message='Invalid workflow condition.'; end if;
  if jsonb_array_length(p_spec->'conditions')<>1 then raise sqlstate 'PT400' using message='Use one no-open-task condition.'; end if;
  cond:=p_spec#>'{conditions,0}';
  perform pipechat.automation_object(cond,array['type','match']);
  perform pipechat.automation_object(cond->'match',array['field','operator','value']);
  if cond->>'type' is distinct from 'no_open_qualifying_task' or cond#>>'{match,field}' is distinct from 'nextAction' or
    coalesce(cond#>>'{match,operator}','') not in ('equals','contains') then raise sqlstate 'PT400' using message='Invalid workflow task comparison.'; end if;
  perform pipechat.automation_text(cond#>'{match,value}',12000);
  perform pipechat.automation_object(act,array['type','nextAction','notes','due']);
  perform pipechat.automation_text(act->'nextAction',12000);
  perform pipechat.automation_text(act->'notes',16000,true);
  perform pipechat.automation_object(act->'due',array['anchor','offsetDays']);
  if act->>'type' is distinct from 'create_linked_task' or act#>>'{due,anchor}' is distinct from 'event_date' or
    jsonb_typeof(act#>'{due,offsetDays}') is distinct from 'number' then raise sqlstate 'PT400' using message='Invalid workflow task action.'; end if;
  n:=(act#>>'{due,offsetDays}')::numeric;
  if n<>trunc(n) or n<0 or n>3650 or not pipechat.automation_matches(act->>'nextAction',cond->'match') then
    raise sqlstate 'PT400' using message='Invalid workflow date offset or nonqualifying task.';
  end if;
end $$;

create function pipechat.automation_time(p_at timestamptz) returns text
language sql immutable set search_path=pg_catalog as $$
  select to_char(p_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;
create function pipechat.automation_snapshot(p_workspace uuid) returns jsonb
language sql stable set search_path=pg_catalog as $$
  select coalesce(jsonb_agg(state order by id),'[]'::jsonb) from pipechat.business_automations where workspace_id=p_workspace
$$;
create or replace function pipechat.crm_snapshot_v2(p_workspace uuid) returns jsonb
language sql stable set search_path=pg_catalog as $$
  select pipechat.crm_snapshot(p_workspace)||jsonb_build_object('todoCards',m.todo_cards_v2,
    'workflows',pipechat.automation_snapshot(p_workspace))
  from pipechat.workspace_metadata m where m.workspace_id=p_workspace
$$;
create or replace function public.pipechat_read_workspace() returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare uid uuid:=pipechat.require_user(); wid uuid:=pipechat.workspace_for(uid);
begin
  if not exists(select 1 from pipechat.workspaces where id=wid and owner_id=uid) then
    raise sqlstate 'PT403' using message='Only the workspace owner can read this workspace.';
  end if;
  return pipechat.crm_snapshot_v2(wid);
end $$;

create function pipechat.automation_execute(p_workspace uuid,p_workflow text,p_event jsonb) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare w jsonb; spec jsonb; previous jsonb; old_event jsonb; saved jsonb; cards jsonb; rec jsonb;
  at text; event_hash text; task_id text; due text; card jsonb; execution jsonb; h jsonb;
  status text:='succeeded'; reason text:='task_created'; attempts integer;
  event_from jsonb:=p_event->'from'; event_to jsonb:=p_event->'to'; seen boolean:=false;
begin
  select state into w from pipechat.business_automations where workspace_id=p_workspace and id=p_workflow for update;
  if not found then raise sqlstate 'PT404' using message='Workflow unavailable.'; end if;
  select ev.event,ev.execution into old_event,previous from pipechat.business_automation_events ev
    where workspace_id=p_workspace and workflow_id=p_workflow and event_id=p_event->>'eventId';
  if found then
    if old_event is distinct from p_event then raise sqlstate 'PT409' using message='Workflow event identity already used.'; end if;
    -- Inverses restore visible history, but cannot reopen a consumed event ID.
    if not exists(select 1 from jsonb_array_elements(w->'executions') e where e=previous) then
      raise sqlstate 'PT409' using message='The workflow event was undone.';
    end if;
    if previous->>'status'<>'failed' then return previous; end if;
  end if;
  saved:=pipechat.crm_snapshot_v2(p_workspace); cards:=saved->'todoCards'; spec:=w->'spec';
  if previous is not null then
    for h in select value from jsonb_array_elements(w->'history') loop
      if h->>'type'='execution' and h->'eventId'=p_event->'eventId' then seen:=true;
      elsif seen and h->>'type'='trigger_renamed' and h#>'{change,fieldId}'=p_event->'field' then
        if event_from=h#>'{change,from}' then event_from:=h#>'{change,to}'; end if;
        if event_to=h#>'{change,from}' then event_to:=h#>'{change,to}'; end if;
      end if;
    end loop;
  end if;
  at:=pipechat.automation_time(greatest(clock_timestamp(),(w->>'updatedAt')::timestamptz,(p_event->>'occurredAt')::timestamptz));
  select value into rec from jsonb_array_elements(saved->'deals') where value->'id'=p_event->'recordId';
  -- Serialize the same ordered object/array as JSON.stringify in business-workflows.js.
  event_hash:=encode(sha256(convert_to('{"eventId":'||(p_event->'eventId')::text||',"recordId":'||(p_event->'recordId')::text||
    ',"field":'||(p_event->'field')::text||',"from":'||(p_event->'from')::text||',"to":'||(p_event->'to')::text||
    ',"occurredAt":'||(p_event->'occurredAt')::text||'}','UTF8')),'hex');
  task_id:='todo_wf_'||left(encode(sha256(convert_to('['||to_jsonb(p_workflow)::text||','||(p_event->'eventId')::text||']','UTF8')),'hex'),48);
  if w->>'status'<>'active' then status:='skipped'; reason:='inactive';
  elsif (p_event->>'occurredAt')::timestamptz<(w->>'activatedAt')::timestamptz then status:='skipped'; reason:='before_activation';
  elsif p_event->'field' is distinct from spec#>'{trigger,field}' or event_from=event_to or
    event_to is distinct from spec#>'{trigger,to}' then status:='skipped'; reason:='trigger_not_matched';
  else
    begin perform pipechat.automation_validate_spec(spec,saved->'tableSchema',saved->'customFields');
    exception when sqlstate 'PT400' then status:='failed'; reason:='schema_changed'; end;
    if status='succeeded' then
      if rec is null then status:='skipped'; reason:='record_missing';
      elsif rec->(spec#>>'{trigger,field}') is distinct from spec#>'{trigger,to}' then status:='skipped'; reason:='record_no_longer_matches';
      elsif exists(select 1 from jsonb_array_elements(cards) c where c->'recordId'=rec->'id' and c->>'status'<>'Done' and
        pipechat.automation_matches(c->>'nextAction',spec#>'{conditions,0,match}')) then status:='skipped'; reason:='open_task_exists';
      elsif exists(select 1 from jsonb_array_elements(cards) c where c->>'id'=task_id) then status:='failed'; reason:='task_id_conflict';
      elsif jsonb_array_length(cards)>=2000 then status:='failed'; reason:='board_capacity';
      else
        begin
          due:=to_char(((p_event->>'occurredAt')::timestamptz at time zone (spec->>'timezone'))::date+
            (spec#>>'{action,due,offsetDays}')::integer,'YYYY-MM-DD');
          if due !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or left(due,4)='0000' then raise datetime_field_overflow; end if;
        exception when datetime_field_overflow then status:='failed'; reason:='due_date_out_of_range'; due:=null; end;
      end if;
    end if;
  end if;
  if status='succeeded' then
    card:=jsonb_build_object('id',task_id,'recordId',p_event->'recordId','status','To Do','nextAction',spec#>'{action,nextAction}',
      'notes',spec#>'{action,notes}','dueDate',due);
    cards:=pipechat.validate_todo_v2(cards||jsonb_build_array(card),saved->'deals');
    update pipechat.workspace_metadata set todo_cards_v2=cards where workspace_id=p_workspace;
  else task_id:=null; due:=null; end if;
  attempts:=coalesce((previous->>'attempts')::integer,0)+1;
  execution:=jsonb_build_object('event',p_event,'eventHash',event_hash,'status',status,'attempts',attempts,'reason',reason,
    'taskId',task_id,'dueDate',due,'lastAttemptAt',at);
  h:=jsonb_build_object('type','execution','at',at,'eventId',p_event->'eventId','attempt',attempts,'status',status,'reason',reason,'taskId',task_id);
  w:=w||jsonb_build_object('revision',(w->>'revision')::bigint+1,'updatedAt',at,'history',(w->'history')||jsonb_build_array(h),
    'executions',case when previous is null then (w->'executions')||jsonb_build_array(execution) else
      (select jsonb_agg(case when e#>>'{event,eventId}'=p_event->>'eventId' then execution else e end order by n)
       from jsonb_array_elements(w->'executions') with ordinality a(e,n)) end);
  update pipechat.business_automations set state=w where workspace_id=p_workspace and id=p_workflow;
  insert into pipechat.business_automation_events(workspace_id,workflow_id,event_id,event,execution)
    values(p_workspace,p_workflow,p_event->>'eventId',p_event,execution)
    on conflict(workspace_id,workflow_id,event_id) do update set execution=excluded.execution;
  return execution;
end $$;

-- Preserve the existing atomic validator/writer, but remove its public bypass.
alter function public.pipechat_write_workspace_v2(jsonb,jsonb,jsonb,text,jsonb) set schema pipechat;
alter function pipechat.pipechat_write_workspace_v2(jsonb,jsonb,jsonb,text,jsonb) rename to write_workspace_without_automations;
alter function public.pipechat_write_crm(jsonb,jsonb,jsonb,text) set schema pipechat;
alter function pipechat.pipechat_write_crm(jsonb,jsonb,jsonb,text) rename to write_crm_without_automations;
create or replace function pipechat.write_workspace_without_automations(p_deals jsonb,p_custom_fields jsonb,p_table_schema jsonb,p_expected_updated_at text,p_todo_cards jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare uid uuid:=pipechat.require_user(); wid uuid:=pipechat.workspace_for(uid); result jsonb; cards jsonb;
begin
  if octet_length(jsonb_build_object('deals',p_deals,'customFields',p_custom_fields,'tableSchema',p_table_schema,'todoCards',p_todo_cards)::text)>16777216 then
    raise sqlstate 'PT400' using message='The workspace exceeds 16 MiB.';
  end if;
  result:=pipechat.write_crm_without_automations(p_deals,p_custom_fields,p_table_schema,p_expected_updated_at);
  cards:=pipechat.validate_todo_v2(p_todo_cards,result->'deals');
  update pipechat.workspace_metadata set todo_cards_v2=cards where workspace_id=wid;
  result:=pipechat.crm_snapshot_v2(wid);
  if octet_length(result::text)>16777216 then raise sqlstate 'PT400' using message='The workspace exceeds 16 MiB.'; end if;
  return result;
end $$;
create function pipechat.automation_write_workspace(p_workspace jsonb,p_expected_updated_at text,p_schema_changes jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare uid uuid:=pipechat.require_user(); wid uuid:=pipechat.workspace_for(uid); before_data jsonb; after_data jsonb;
  item record; event jsonb; event_id text; occurred text; c jsonb; old_field jsonb; new_field jsonb; options jsonb; w jsonb; at text;
begin
  perform 1 from pipechat.workspaces where id=wid and owner_id=uid for update;
  if not found then raise sqlstate 'PT403' using message='Only the workspace owner can edit it.'; end if;
  perform pipechat.journal_metadata(jsonb_build_object('schemaChanges',p_schema_changes));
  before_data:=pipechat.crm_snapshot_v2(wid);
  after_data:=pipechat.write_workspace_without_automations(p_workspace->'deals',p_workspace->'customFields',p_workspace->'tableSchema',p_expected_updated_at,p_workspace->'todoCards');
  -- Validate the declared simultaneous rename against canonical snapshots under
  -- the same workspace lock. No positional or record-value inference is allowed.
  for c in select value from jsonb_array_elements(p_schema_changes) loop
    select f into old_field from jsonb_array_elements(coalesce(before_data#>'{tableSchema,fields}','[]')||(before_data->'customFields')) f where f->'id'=c->'fieldId';
    select f into new_field from jsonb_array_elements(coalesce(after_data#>'{tableSchema,fields}','[]')||(after_data->'customFields')) f where f->'id'=c->'fieldId';
    if old_field is null or new_field is null or old_field->>'type'<>'choice' or new_field->>'type'<>'choice' or
      (old_field-'options') is distinct from (new_field-'options') or
      not old_field->'options' @> jsonb_build_array(c->'from') or old_field->'options' @> jsonb_build_array(c->'to') then
      raise sqlstate 'PT409' using message='The choice rename does not match the existing field.';
    end if;
    select jsonb_agg(coalesce((select change->'to' from jsonb_array_elements(p_schema_changes) change
      where change->'fieldId'=c->'fieldId' and change->'from'=option),option) order by n) into options
      from jsonb_array_elements(old_field->'options') with ordinality a(option,n);
    if options is distinct from new_field->'options' or exists(
      select 1 from jsonb_array_elements(before_data->'deals') b
      left join jsonb_array_elements(after_data->'deals') a on a->'id'=b->'id'
      where b->(c->>'fieldId')=c->'from' and a->(c->>'fieldId') is distinct from c->'to') then
      raise sqlstate 'PT409' using message='The choice rename does not match the resulting options and cells.';
    end if;
  end loop;
  for item in select id,state from pipechat.business_automations where workspace_id=wid order by id loop
    w:=item.state;
    select change into c from jsonb_array_elements(p_schema_changes) change
      where change->'fieldId'=w#>'{spec,trigger,field}' and change->'from'=w#>'{spec,trigger,to}';
    if c is not null then
      at:=pipechat.automation_time(greatest((after_data->>'updatedAt')::timestamptz,(w->>'updatedAt')::timestamptz));
      w:=jsonb_set(w,'{spec,trigger,to}',c->'to')||jsonb_build_object('revision',(w->>'revision')::bigint+1,'updatedAt',at,
        'history',(w->'history')||jsonb_build_array(jsonb_build_object('type','trigger_renamed','at',at,'eventId',null,
          'attempt',null,'status',w->'status','reason',null,'taskId',null,'change',c)));
      update pipechat.business_automations set state=w where workspace_id=wid and id=item.id;
    end if;
  end loop;
  -- The old RPC and undeclared destructive schema edits still fail closed.
  if before_data->'tableSchema' is distinct from after_data->'tableSchema' or
    before_data->'customFields' is distinct from after_data->'customFields' then
    for item in select state from pipechat.business_automations where workspace_id=wid loop
      begin
        perform pipechat.automation_validate_spec(item.state->'spec',after_data->'tableSchema',after_data->'customFields');
      exception when sqlstate 'PT400' then
        raise sqlstate 'PT409' using message='A saved workflow references this choice. Review an explicit workflow remap before changing it.';
      end;
    end loop;
  end if;
  occurred:=pipechat.automation_time((after_data->>'updatedAt')::timestamptz);
  -- Only existing canonical records and choice fields can produce transitions.
  for item in select w.id,b->'id' as rid,w.state#>>'{spec,trigger,field}' as field,
      coalesce(b->(w.state#>>'{spec,trigger,field}'),'null') as old_value,
      coalesce(a->(w.state#>>'{spec,trigger,field}'),'null') as new_value
    from pipechat.business_automations w
    cross join jsonb_array_elements(before_data->'deals') b
    join jsonb_array_elements(after_data->'deals') a on a->'id'=b->'id'
    where w.workspace_id=wid and
      b->(w.state#>>'{spec,trigger,field}') is distinct from a->(w.state#>>'{spec,trigger,field}') and
      not exists(select 1 from jsonb_array_elements(p_schema_changes) change where change->>'fieldId'=w.state#>>'{spec,trigger,field}' and
        change->'from'=b->(w.state#>>'{spec,trigger,field}') and change->'to'=a->(w.state#>>'{spec,trigger,field}')) and
      exists(select 1 from jsonb_array_elements(coalesce(before_data#>'{tableSchema,fields}','[]')||(before_data->'customFields')) f
        where f->>'id'=w.state#>>'{spec,trigger,field}' and f->>'type'='choice') and
      exists(select 1 from jsonb_array_elements(coalesce(after_data#>'{tableSchema,fields}','[]')||(after_data->'customFields')) f
        where f->>'id'=w.state#>>'{spec,trigger,field}' and f->>'type'='choice')
    order by (b->>'id')::bigint,w.id loop
    event_id:='crm_'||encode(sha256(convert_to(wid::text||':'||(after_data->>'updatedAt'),'UTF8')),'hex');
    event_id:=event_id||':'||(item.rid#>>'{}')||':'||item.field;
    event:=jsonb_build_object('eventId',event_id,'recordId',item.rid,'field',item.field,'from',item.old_value,'to',item.new_value,'occurredAt',occurred);
    perform pipechat.automation_execute(wid,item.id,event);
  end loop;
  after_data:=pipechat.crm_snapshot_v2(wid);
  if octet_length(after_data::text)>16777216 then raise sqlstate 'PT400' using message='The workspace exceeds 16 MiB.'; end if;
  return after_data;
end $$;

create function public.pipechat_write_workspace_v2(p_deals jsonb,p_custom_fields jsonb,p_table_schema jsonb,p_expected_updated_at text,p_todo_cards jsonb) returns jsonb
language sql security definer set search_path=pg_catalog as $$
  select pipechat.automation_write_workspace(jsonb_build_object('deals',p_deals,'customFields',p_custom_fields,
    'tableSchema',p_table_schema,'todoCards',p_todo_cards),p_expected_updated_at,'[]'::jsonb)
$$;

-- Older CRM-only callers preserve the board, but still execute stage workflows.
create function public.pipechat_write_crm(p_deals jsonb,p_custom_fields jsonb,p_table_schema jsonb,p_expected_updated_at text) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare uid uuid:=pipechat.require_user(); wid uuid:=pipechat.workspace_for(uid); cards jsonb;
begin
  perform 1 from pipechat.workspaces where id=wid and owner_id=uid for update;
  if not found then raise sqlstate 'PT403' using message='Only the workspace owner can edit it.'; end if;
  if jsonb_typeof(p_deals) is distinct from 'array' then raise sqlstate 'PT400' using message='Invalid CRM records.'; end if;
  select coalesce(jsonb_agg(c order by n),'[]') into cards from pipechat.workspace_metadata m,
    jsonb_array_elements(m.todo_cards_v2) with ordinality a(c,n) where m.workspace_id=wid and
    (c->'recordId'='null'::jsonb or exists(select 1 from jsonb_array_elements(p_deals) r where r->'id'=c->'recordId'));
  return public.pipechat_write_workspace_v2(p_deals,p_custom_fields,p_table_schema,p_expected_updated_at,cards);
end $$;

-- Called only by the journal's trusted inverse path, never an authenticated RPC.
create function pipechat.automation_restore_workspace(p_deals jsonb,p_custom_fields jsonb,p_table_schema jsonb,
  p_expected_updated_at text,p_todo_cards jsonb,p_workflows jsonb) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare uid uuid:=pipechat.require_user(); wid uuid:=pipechat.workspace_for(uid);
begin
  perform 1 from pipechat.workspaces where id=wid and owner_id=uid for update;
  if not found then raise sqlstate 'PT403' using message='Only the workspace owner can edit it.'; end if;
  perform pipechat.write_workspace_without_automations(p_deals,p_custom_fields,p_table_schema,p_expected_updated_at,p_todo_cards);
  if p_workflows is not null then
    delete from pipechat.business_automations where workspace_id=wid;
    insert into pipechat.business_automations(workspace_id,id,state)
      select wid,value->>'id',value from jsonb_array_elements(p_workflows);
  end if;
  return pipechat.crm_snapshot_v2(wid);
end $$;

create function pipechat.automation_action(p_action_id text,p_request_id uuid,p_expected_updated_at text,p_command jsonb) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare uid uuid:=pipechat.require_user(); wid uuid:=pipechat.workspace_for(uid); version timestamptz;
  before_data jsonb; after_data jsonb; w jsonb; spec jsonb; at text; h jsonb; e jsonb; result jsonb;
  old pipechat.action_journal%rowtype; event jsonb; execution jsonb; desired text;
  workflow_key text:=p_command->>'workflowId'; operation text:=p_command->>'operation';
  body jsonb:=jsonb_build_object('requestId',p_request_id,'expectedUpdatedAt',p_expected_updated_at,'workflowCommand',p_command);
begin
  if p_action_id is null or p_action_id !~ '^([0-9a-f]{64}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$' or
    p_request_id is null or workflow_key is null or workflow_key !~ '^workflow_[a-z0-9_]{1,60}$' or octet_length(body::text)>100000 then
    raise sqlstate 'PT400' using message='Invalid workflow action.';
  end if;
  select updated_at into version from pipechat.workspaces where id=wid and owner_id=uid for update;
  if not found then raise sqlstate 'PT403' using message='Only the workspace owner can manage workflows.'; end if;
  select * into old from pipechat.action_journal where workspace_id=wid and action_id=p_action_id;
  if found then
    if old.user_id<>uid or old.request_body is distinct from body then raise sqlstate 'PT409' using message='Action ID already used.'; end if;
    select receipt into result from pipechat.business_automation_receipts where workspace_id=wid and action_id=p_action_id;
    if result is null then raise sqlstate 'PT409' using message='Workflow receipt unavailable.'; end if;
    return result||jsonb_build_object('replayed',true,'undoneBy',old.undone_by,'undoInvalidated',old.undo_invalidated);
  end if;
  if p_expected_updated_at is distinct from pipechat.timestamp_text(version) then raise sqlstate 'PT409' using message='The workspace changed.'; end if;
  before_data:=pipechat.crm_snapshot_v2(wid);
  select state into w from pipechat.business_automations where workspace_id=wid and id=workflow_key;
  at:=pipechat.automation_time(greatest(clock_timestamp(),(w->>'updatedAt')::timestamptz));
  if operation='create' then
    if w is not null or exists(select 1 from pipechat.business_automation_receipts r
      where r.workspace_id=wid and r.receipt#>>'{workflow,id}'=workflow_key) then
      raise sqlstate 'PT409' using message='Workflow ID already used.';
    end if;
    if (select count(*) from pipechat.business_automations where workspace_id=wid)>=200 then raise sqlstate 'PT400' using message='A workspace supports up to 200 workflows.'; end if;
    spec:=p_command->'spec';
    perform pipechat.automation_validate_spec(spec,before_data->'tableSchema',before_data->'customFields');
    h:=jsonb_build_object('type','created','at',at,'eventId',null,'attempt',null,'status','draft','reason',null,'taskId',null);
    w:=jsonb_build_object('version',1,'id',workflow_key,'spec',spec,'status','draft','revision',1,'createdAt',at,'updatedAt',at,
      'activatedAt',null,'executions','[]'::jsonb,'history',jsonb_build_array(h));
    insert into pipechat.business_automations(workspace_id,id,state) values(wid,workflow_key,w);
  elsif operation='activation' then
    if w is null then raise sqlstate 'PT404' using message='Workflow unavailable.'; end if;
    if p_command->'revision' is distinct from w->'revision' then raise sqlstate 'PT409' using message='The workflow changed.'; end if;
    if jsonb_typeof(p_command->'active') is distinct from 'boolean' then raise sqlstate 'PT400' using message='Invalid activation.'; end if;
    desired:=case when (p_command->>'active')::boolean then 'active' else 'paused' end;
    if desired='active' then perform pipechat.automation_validate_spec(w->'spec',before_data->'tableSchema',before_data->'customFields'); end if;
    if desired<>w->>'status' then
      h:=jsonb_build_object('type',case when desired='active' then 'activated' else 'paused' end,'at',at,
        'eventId',null,'attempt',null,'status',desired,'reason',null,'taskId',null);
      w:=w||jsonb_build_object('status',desired,'revision',(w->>'revision')::bigint+1,'updatedAt',at,
        'activatedAt',case when desired='active' then to_jsonb(at) else w->'activatedAt' end,'history',(w->'history')||jsonb_build_array(h));
      update pipechat.business_automations set state=w where workspace_id=wid and id=workflow_key;
    end if;
  elsif operation='retry' then
    select ev.event into event from pipechat.business_automation_events ev where ev.workspace_id=wid and ev.workflow_id=workflow_key and ev.event_id=p_command->>'eventId';
    if event is null then raise sqlstate 'PT404' using message='Workflow event unavailable.'; end if;
    execution:=pipechat.automation_execute(wid,workflow_key,event);
    select state into w from pipechat.business_automations where workspace_id=wid and id=workflow_key;
  else raise sqlstate 'PT400' using message='Unsupported workflow action.'; end if;
  update pipechat.workspaces set updated_at=greatest(clock_timestamp(),version+interval '1 microsecond') where workspaces.id=wid;
  after_data:=pipechat.crm_snapshot_v2(wid);
  if octet_length(after_data::text)>16777216 then raise sqlstate 'PT400' using message='The workspace exceeds 16 MiB.'; end if;
  e:=pipechat.journal_entry(p_action_id,p_request_id,null,null,null,before_data,after_data);
  insert into pipechat.action_journal(workspace_id,action_id,user_id,entry,request_body,result_snapshot,metadata)
    values(wid,p_action_id,uid,e,body,after_data,'{}') returning * into old;
  result:=jsonb_build_object('workflow',w,'workflows',after_data->'workflows','updatedAt',after_data->'updatedAt',
    'snapshot',after_data,'receipt',pipechat.journal_receipt(old),'entry',e,'execution',execution,'replayed',false,'undoneBy',null,'undoInvalidated',false);
  insert into pipechat.business_automation_receipts(workspace_id,action_id,receipt) values(wid,p_action_id,result);
  return result;
end $$;

create function public.pipechat_create_workflow(p_action_id text,p_request_id uuid,p_expected_updated_at text,p_workflow_id text,p_spec jsonb) returns jsonb
language sql security definer set search_path=pg_catalog as $$
  select pipechat.automation_action(p_action_id,p_request_id,p_expected_updated_at,
    jsonb_build_object('operation','create','workflowId',p_workflow_id,'spec',p_spec))
$$;
create function public.pipechat_set_workflow_activation(p_action_id text,p_request_id uuid,p_expected_updated_at text,p_workflow_id text,p_revision bigint,p_active boolean) returns jsonb
language sql security definer set search_path=pg_catalog as $$
  select pipechat.automation_action(p_action_id,p_request_id,p_expected_updated_at,
    jsonb_build_object('operation','activation','workflowId',p_workflow_id,'revision',p_revision,'active',p_active))
$$;
create function public.pipechat_retry_workflow_event(p_action_id text,p_request_id uuid,p_expected_updated_at text,p_workflow_id text,p_event_id text) returns jsonb
language sql security definer set search_path=pg_catalog as $$
  select pipechat.automation_action(p_action_id,p_request_id,p_expected_updated_at,
    jsonb_build_object('operation','retry','workflowId',p_workflow_id,'eventId',p_event_id))
$$;
create function public.pipechat_read_workflows() returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare uid uuid:=pipechat.require_user(); wid uuid:=pipechat.workspace_for(uid); result jsonb;
begin
  select jsonb_build_object('workflows',pipechat.automation_snapshot(wid),'updatedAt',pipechat.timestamp_text(updated_at)) into result
    from pipechat.workspaces where id=wid and owner_id=uid;
  if result is null then raise sqlstate 'PT403' using message='Only the workspace owner can read workflows.'; end if;
  return result;
end $$;

-- Reset removes active rules as well as records. Event tombstones are retained.
create function pipechat.automation_reset() returns trigger
language plpgsql set search_path=pg_catalog as $$
begin
  delete from pipechat.business_automations where workspace_id=new.workspace_id;
  return new;
end $$;
create trigger automation_reset after update of table_schema on pipechat.workspace_metadata
  for each row when (new.table_schema->>'status'='pending') execute function pipechat.automation_reset();

revoke all on pipechat.business_automations,pipechat.business_automation_events,pipechat.business_automation_receipts from public,anon,authenticated,service_role;
revoke all on function pipechat.automation_object(jsonb,text[]),pipechat.automation_text(jsonb,integer,boolean),
  pipechat.automation_normalize(text),pipechat.automation_matches(text,jsonb),pipechat.automation_validate_spec(jsonb,jsonb,jsonb),
  pipechat.automation_time(timestamptz),pipechat.automation_snapshot(uuid),pipechat.automation_execute(uuid,text,jsonb),
  pipechat.automation_write_workspace(jsonb,text,jsonb),
  pipechat.automation_restore_workspace(jsonb,jsonb,jsonb,text,jsonb,jsonb),pipechat.automation_action(text,uuid,text,jsonb),
  pipechat.automation_reset(),pipechat.write_workspace_without_automations(jsonb,jsonb,jsonb,text,jsonb),
  pipechat.write_crm_without_automations(jsonb,jsonb,jsonb,text)
  from public,anon,authenticated,service_role;
revoke all on function public.pipechat_create_workflow(text,uuid,text,text,jsonb),
  public.pipechat_set_workflow_activation(text,uuid,text,text,bigint,boolean),public.pipechat_retry_workflow_event(text,uuid,text,text,text),
  public.pipechat_read_workflows(),public.pipechat_write_workspace_v2(jsonb,jsonb,jsonb,text,jsonb),
  public.pipechat_write_crm(jsonb,jsonb,jsonb,text) from public,anon,authenticated,service_role;
grant execute on function public.pipechat_create_workflow(text,uuid,text,text,jsonb),
  public.pipechat_set_workflow_activation(text,uuid,text,text,bigint,boolean),public.pipechat_retry_workflow_event(text,uuid,text,text,text),
  public.pipechat_read_workflows(),public.pipechat_write_workspace_v2(jsonb,jsonb,jsonb,text,jsonb),
  public.pipechat_write_crm(jsonb,jsonb,jsonb,text) to authenticated;
notify pgrst,'reload schema';
commit;
