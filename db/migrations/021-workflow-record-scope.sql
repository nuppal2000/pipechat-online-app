-- Explicit record scopes and optional due dates for new workflow drafts.
-- Requires 016; independent of the unrelated, unreleased migration 020.
-- Existing workflow JSON, cards, receipts and event tombstones are not rewritten.
begin;

create or replace function pipechat.automation_validate_spec(p_spec jsonb,p_schema jsonb,p_custom jsonb) returns void
language plpgsql stable set search_path=pg_catalog as $$
declare tr jsonb:=p_spec->'trigger'; act jsonb:=p_spec->'action'; cond jsonb; n numeric; scope jsonb:=p_spec->'scope'; rid jsonb;
begin
  if p_spec->'version'='2'::jsonb then
    perform pipechat.automation_object(p_spec,array['version','name','timezone','scope','trigger','conditions','action']);
    if scope->>'type'='all_records' then
      perform pipechat.automation_object(scope,array['type']);
    elsif scope->>'type'='record_ids' then
      perform pipechat.automation_object(scope,array['type','recordIds']);
      if jsonb_typeof(scope->'recordIds') is distinct from 'array' then
        raise sqlstate 'PT400' using message='Invalid workflow record IDs.';
      end if;
      if jsonb_array_length(scope->'recordIds') not between 1 and 2000 or
        (select count(distinct value) from jsonb_array_elements(scope->'recordIds'))<>jsonb_array_length(scope->'recordIds') then
        raise sqlstate 'PT400' using message='Choose a nonempty unique list of record IDs.';
      end if;
      for rid in select value from jsonb_array_elements(scope->'recordIds') loop
        if jsonb_typeof(rid) is distinct from 'number' then raise sqlstate 'PT400' using message='Invalid workflow record ID.'; end if;
        n:=(rid#>>'{}')::numeric;
        if n<>trunc(n) or n<1 or n>9007199254740991 then raise sqlstate 'PT400' using message='Invalid workflow record ID.'; end if;
      end loop;
    else raise sqlstate 'PT400' using message='Choose an explicit workflow record scope.'; end if;
  elsif p_spec->'version'='1'::jsonb then
    perform pipechat.automation_object(p_spec,array['version','name','timezone','trigger','conditions','action']);
  else raise sqlstate 'PT400' using message='Invalid workflow version.'; end if;
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
  if act->>'type' is distinct from 'create_linked_task' or not pipechat.automation_matches(act->>'nextAction',cond->'match') then
    raise sqlstate 'PT400' using message='Invalid workflow task action or nonqualifying task.';
  end if;
  if p_spec->'version'='1'::jsonb or act->'due' is distinct from 'null'::jsonb then
    perform pipechat.automation_object(act->'due',array['anchor','offsetDays']);
    if act#>>'{due,anchor}' is distinct from 'event_date' or jsonb_typeof(act#>'{due,offsetDays}') is distinct from 'number' then
      raise sqlstate 'PT400' using message='Invalid workflow due date.';
    end if;
    n:=(act#>>'{due,offsetDays}')::numeric;
    if n<>trunc(n) or n<0 or n>3650 then raise sqlstate 'PT400' using message='Invalid workflow date offset.'; end if;
  end if;
end $$;

create or replace function pipechat.automation_execute(p_workspace uuid,p_workflow text,p_event jsonb) returns jsonb
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
      if spec->'version'='2'::jsonb and spec#>>'{scope,type}'='record_ids' and
        not (spec#>'{scope,recordIds}') @> jsonb_build_array(p_event->'recordId') then status:='skipped'; reason:='record_out_of_scope';
      elsif rec is null then status:='skipped'; reason:='record_missing';
      elsif rec->(spec#>>'{trigger,field}') is distinct from spec#>'{trigger,to}' then status:='skipped'; reason:='record_no_longer_matches';
      elsif exists(select 1 from jsonb_array_elements(cards) c where c->'recordId'=rec->'id' and c->>'status'<>'Done' and
        pipechat.automation_matches(c->>'nextAction',spec#>'{conditions,0,match}')) then status:='skipped'; reason:='open_task_exists';
      elsif exists(select 1 from jsonb_array_elements(cards) c where c->>'id'=task_id) then status:='failed'; reason:='task_id_conflict';
      elsif jsonb_array_length(cards)>=2000 then status:='failed'; reason:='board_capacity';
      elsif spec#>'{action,due}' is distinct from 'null'::jsonb then
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
      'notes',spec#>'{action,notes}','dueDate',coalesce(due,''));
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

create or replace function pipechat.automation_action(p_action_id text,p_request_id uuid,p_expected_updated_at text,p_command jsonb) returns jsonb
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
    if spec->'version' is distinct from '2'::jsonb then
      raise sqlstate 'PT400' using message='New workflow drafts require version 2 and an explicit record scope.';
    end if;
    if spec#>>'{scope,type}'='record_ids' and exists(
      select 1 from jsonb_array_elements(spec#>'{scope,recordIds}') rid
      where not exists(select 1 from jsonb_array_elements(before_data->'deals') rec where rec->'id'=rid)) then
      raise sqlstate 'PT400' using message='Choose record IDs from the current workspace.';
    end if;
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

-- CREATE OR REPLACE retains the existing function signatures and ACLs.
revoke all on function pipechat.automation_validate_spec(jsonb,jsonb,jsonb),
  pipechat.automation_execute(uuid,text,jsonb),pipechat.automation_action(text,uuid,text,jsonb)
  from public,anon,authenticated,service_role;
notify pgrst,'reload schema';
commit;

