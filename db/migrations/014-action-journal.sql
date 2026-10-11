-- Additive foundations; requires 001-012. No deployment or live writes implied.
-- Only the NEW commit/undo RPCs journal saves. Existing save RPCs stay unchanged.
begin;

create table pipechat.action_journal (
  workspace_id uuid not null references pipechat.workspaces(id) on delete cascade,
  action_id text not null check (action_id ~ '^([0-9a-f]{64}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  entry jsonb not null check (entry->>'formatVersion' = '1'),
  -- Exact request comparison, not a collision-prone hash. Contains private CRM data.
  request_body jsonb not null,
  metadata jsonb not null default '{}',
  result_snapshot jsonb not null,
  undone_by text,
  undo_invalidated boolean not null default false,
  created_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, action_id),
  foreign key (workspace_id, undone_by) references pipechat.action_journal(workspace_id, action_id)
);
create index action_journal_actor on pipechat.action_journal(workspace_id,user_id,created_at desc);
alter table pipechat.action_journal enable row level security;

create table pipechat.import_receipts (
  workspace_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  receipt_id text not null,
  digest text not null check (digest ~ '^[0-9a-f]{64}$'),
  action_id text not null,
  primary key (workspace_id,user_id,receipt_id),
  foreign key (workspace_id,action_id) references pipechat.action_journal(workspace_id,action_id) on delete cascade
);
alter table pipechat.import_receipts enable row level security;

create table pipechat.beta_event_ledger (
  workspace_id uuid not null references pipechat.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  event_id uuid not null,
  request_id uuid not null,
  stage text not null,
  attempt integer not null,
  event jsonb not null,
  recorded_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id,user_id,event_id),
  unique (workspace_id,user_id,request_id,stage,attempt)
);
create index beta_event_ledger_time on pipechat.beta_event_ledger(recorded_at);
create index beta_event_ledger_actor on pipechat.beta_event_ledger(workspace_id,user_id,recorded_at desc,event_id desc);
alter table pipechat.beta_event_ledger enable row level security;

create function pipechat.journal_document(p_snapshot jsonb) returns jsonb
language sql immutable set search_path=pg_catalog as $$
  select jsonb_build_object(
    'records',coalesce((select jsonb_object_agg(v->>'id',v) from jsonb_array_elements(p_snapshot->'deals') v),'{}'::jsonb),
    'tasks',coalesce((select jsonb_object_agg(v->>'id',v) from jsonb_array_elements(p_snapshot->'todoCards') v),'{}'::jsonb),
    'schema',jsonb_build_object('workspace',jsonb_build_object('tableSchema',p_snapshot->'tableSchema','customFields',p_snapshot->'customFields')),
    'workflows',coalesce((select jsonb_object_agg(v->>'id',v) from jsonb_array_elements(coalesce(p_snapshot->'workflows','[]')) v),'{}'::jsonb),
    'order',jsonb_build_object('workspace',jsonb_build_object(
      'records',coalesce((select jsonb_agg(v->>'id' order by n) from jsonb_array_elements(p_snapshot->'deals') with ordinality a(v,n)),'[]'::jsonb),
      'tasks',coalesce((select jsonb_agg(v->>'id' order by n) from jsonb_array_elements(p_snapshot->'todoCards') with ordinality a(v,n)),'[]'::jsonb))))
$$;

create function pipechat.journal_slot(p_doc jsonb,p_path text[]) returns jsonb
language sql immutable set search_path=pg_catalog as $$
  select case when p_doc#>p_path is null then '{"exists":false}'::jsonb
    else jsonb_build_object('exists',true,'value',p_doc#>p_path) end
$$;

create function pipechat.journal_entry(p_action text,p_request uuid,p_conversation uuid,p_plan text,
  p_undo_of text,p_before jsonb,p_after jsonb) returns jsonb
language plpgsql immutable set search_path=pg_catalog as $$
declare l jsonb:=pipechat.journal_document(p_before); r jsonb:=pipechat.journal_document(p_after);
  changes jsonb:='[]'; c text; rid text; paths jsonb; p text[]; a jsonb; b jsonb; schema_needed boolean:=false;
begin
  foreach c in array array['records','tasks','schema','order','workflows'] loop
    for rid in select key from jsonb_object_keys(l->c) key union select key from jsonb_object_keys(r->c) key order by 1 loop
      if c='workflows' or not (l->c ? rid) or not (r->c ? rid) then
        paths:=jsonb_build_array(jsonb_build_array(c,rid));
      else
        select coalesce(jsonb_agg(jsonb_build_array(c,rid,key) order by key),'[]'::jsonb) into paths from
          (select key from jsonb_object_keys(l->c->rid) key union select key from jsonb_object_keys(r->c->rid) key) keys;
      end if;
      for p in select array(select jsonb_array_elements_text(value)) from jsonb_array_elements(paths) loop
        a:=pipechat.journal_slot(l,p); b:=pipechat.journal_slot(r,p);
        if a is distinct from b then
          changes:=changes||jsonb_build_array(jsonb_build_object('path',p,'before',a,'after',b));
          if c in ('records','schema') then schema_needed:=true; end if;
        end if;
      end loop;
    end loop;
  end loop;
  return jsonb_build_object('formatVersion',1,'actionId',p_action,'requestId',p_request,
    'conversationId',p_conversation,'planId',p_plan,'undoOf',p_undo_of,
    'beforeVersion',p_before->'updatedAt','afterVersion',p_after->'updatedAt','changes',changes,
    'dependencies',jsonb_build_object('schema',case when schema_needed then r#>'{schema,workspace}' else 'null'::jsonb end));
end $$;

create function pipechat.journal_inverse(p_entry jsonb,p_current jsonb) returns jsonb
language plpgsql immutable set search_path=pg_catalog as $$
declare doc jsonb:=pipechat.journal_document(p_current); change jsonb; p text[]; c text; ordering jsonb; result jsonb;
begin
  if p_entry->>'formatVersion' is distinct from '1' then raise sqlstate 'PT409' using message='Unsupported action version.'; end if;
  if p_entry#>'{dependencies,schema}' <> 'null'::jsonb and
     p_entry#>'{dependencies,schema}' is distinct from doc#>'{schema,workspace}' then
    raise sqlstate 'PT409' using message='The action schema dependency changed.';
  end if;
  -- Check ALL fields against the untouched current snapshot before applying any.
  for change in select value from jsonb_array_elements(p_entry->'changes') loop
    p:=array(select jsonb_array_elements_text(change->'path'));
    if pipechat.journal_slot(doc,p) is distinct from change->'after' or
      cardinality(p)=3 and doc#>p[1:2] is null then
      raise sqlstate 'PT409' using message='An action field changed. Undo was not applied.';
    end if;
  end loop;
  for change in select value from jsonb_array_elements(p_entry->'changes') loop
    p:=array(select jsonb_array_elements_text(change->'path'));
    if change#>>'{before,exists}'='true' then doc:=jsonb_set(doc,p,change#>'{before,value}',true);
    else doc:=doc#-p; end if;
  end loop;
  if exists(select 1 from jsonb_each(doc->'tasks') t where t.value->'recordId'<>'null'::jsonb
      and not (doc->'records' ? (t.value->>'recordId'))) then
    raise sqlstate 'PT409' using message='A task depends on this record. Undo was not applied.';
  end if;
  foreach c in array array['records','tasks'] loop
    ordering:=doc#>array['order','workspace',c];
    if jsonb_typeof(ordering) is distinct from 'array' then raise sqlstate 'PT409' using message='Saved order changed.'; end if;
    if (select count(*) from jsonb_array_elements_text(ordering))<>(select count(distinct value) from jsonb_array_elements_text(ordering)) or
       (select coalesce(jsonb_agg(value order by value),'[]'::jsonb) from jsonb_array_elements_text(ordering)) is distinct from
       (select coalesce(jsonb_agg(key order by key),'[]'::jsonb) from jsonb_object_keys(doc->c) key) then
      raise sqlstate 'PT409' using message='Saved order dependency changed.';
    end if;
  end loop;
  result:=doc#>'{schema,workspace}';
  return result||jsonb_build_object(
    'deals',coalesce((select jsonb_agg(doc->'records'->v order by n) from jsonb_array_elements_text(doc#>'{order,workspace,records}') with ordinality a(v,n)),'[]'::jsonb),
    'todoCards',coalesce((select jsonb_agg(doc->'tasks'->v order by n) from jsonb_array_elements_text(doc#>'{order,workspace,tasks}') with ordinality a(v,n)),'[]'::jsonb)) ||
    case when p_current ? 'workflows' then jsonb_build_object('workflows',coalesce((select jsonb_agg(value order by key) from jsonb_each(doc->'workflows')),'[]'::jsonb)) else '{}'::jsonb end;
end $$;

create function pipechat.journal_receipt(p_row pipechat.action_journal) returns jsonb
language sql immutable set search_path=pg_catalog as $$
  select (p_row.entry - 'changes' - 'dependencies') || jsonb_build_object('importReceipt',coalesce(p_row.metadata->'importReceipt','null'::jsonb))
$$;

create function pipechat.journal_metadata(p_metadata jsonb) returns jsonb
language plpgsql immutable set search_path=pg_catalog as $$
declare r jsonb:=p_metadata->'importReceipt'; changes jsonb:=p_metadata->'schemaChanges'; c jsonb;
begin
  if jsonb_typeof(p_metadata) is distinct from 'object' or octet_length(p_metadata::text)>32768 or
     exists(select 1 from jsonb_object_keys(p_metadata) k where k not in ('importReceipt','schemaChanges')) then
    raise sqlstate 'PT400' using message='Invalid action metadata.';
  end if;
  if changes is not null then
    if jsonb_typeof(changes) is distinct from 'array' then raise sqlstate 'PT400' using message='Invalid schema changes.'; end if;
    if jsonb_array_length(changes)>64 then raise sqlstate 'PT400' using message='Too many schema changes.'; end if;
    for c in select value from jsonb_array_elements(changes) loop
      if jsonb_typeof(c) is distinct from 'object' then raise sqlstate 'PT400' using message='Invalid schema change.'; end if;
      if (select count(*) from jsonb_object_keys(c))<>4 or not c ?& array['kind','fieldId','from','to'] or
        c->>'kind' is distinct from 'rename_choice_option' or jsonb_typeof(c->'fieldId') is distinct from 'string' or
        c->>'fieldId' !~ '^[a-z][a-z0-9_]{0,64}$' or c->>'fieldId' in ('constructor','prototype','__proto__') or
        jsonb_typeof(c->'from') is distinct from 'string' or jsonb_typeof(c->'to') is distinct from 'string' or
        pipechat.js_length(c->>'from')>80 or pipechat.js_length(c->>'to')>80 or
        pipechat.trim_text(c->>'from')='' or pipechat.trim_text(c->>'to')='' or c->'from'=c->'to' or
        (c->>'from') ~ U&'[\0001-\001f\007f]' or (c->>'to') ~ U&'[\0001-\001f\007f]' then
        raise sqlstate 'PT400' using message='Invalid explicit choice rename.';
      end if;
    end loop;
    if exists(select 1 from jsonb_array_elements(changes) item group by item->'fieldId',item->'from' having count(*)>1) or
      exists(select 1 from jsonb_array_elements(changes) item group by item->'fieldId',item->'to' having count(*)>1) or
      exists(select 1 from jsonb_array_elements(changes) a cross join jsonb_array_elements(changes) b
        where a->'fieldId'=b->'fieldId' and a->'from'=b->'to') then
      raise sqlstate 'PT400' using message='Ambiguous choice rename batch.';
    end if;
  end if;
  if r is not null and r<>'null'::jsonb then
    if jsonb_typeof(r) is distinct from 'object' then raise sqlstate 'PT400' using message='Invalid import receipt.'; end if;
    if (select count(*) from jsonb_object_keys(r))<>2 or not r ?& array['id','digest'] or
       jsonb_typeof(r->'id') is distinct from 'string' or r->>'id' !~ '^[A-Za-z0-9_-]{1,200}$' or
       jsonb_typeof(r->'digest') is distinct from 'string' or r->>'digest' !~ '^[0-9a-f]{64}$' then
      raise sqlstate 'PT400' using message='Invalid import receipt.';
    end if;
  elsif p_metadata ? 'importReceipt' then
    p_metadata:=p_metadata-'importReceipt';
  end if;
  return p_metadata;
end $$;

create function pipechat.apply_journaled(p_kind text,p_action_id text,p_request_id uuid,p_conversation_id uuid,
  p_plan_id text,p_expected_updated_at text,p_workspace jsonb,p_metadata jsonb) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare uid uuid:=pipechat.require_user(); wid uuid:=pipechat.workspace_for(uid); old pipechat.action_journal%rowtype;
  imported pipechat.import_receipts%rowtype; version timestamptz; before_data jsonb; after_data jsonb; e jsonb;
  meta jsonb:=pipechat.journal_metadata(p_metadata); body jsonb;
begin
  if p_action_id is null or p_action_id !~ '^([0-9a-f]{64}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$' or
     p_request_id is null or p_plan_id is not null and p_plan_id !~ '^([0-9a-f]{64}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$' then
    raise sqlstate 'PT400' using message='Invalid action identity.';
  end if;
  body:=jsonb_build_object('kind',p_kind,'requestId',p_request_id,'conversationId',p_conversation_id,'planId',p_plan_id,
    'expectedUpdatedAt',p_expected_updated_at,'workspace',p_workspace,'metadata',meta);
  if octet_length(body::text)>17000000 then raise sqlstate 'PT400' using message='Action is too large.'; end if;
  if p_kind='crm' then
    if jsonb_typeof(p_workspace) is distinct from 'object' then raise sqlstate 'PT400' using message='Invalid action workspace.'; end if;
    if not p_workspace ?& array['deals','todoCards','tableSchema','customFields'] or
       (select count(*) from jsonb_object_keys(p_workspace))<>4 or p_workspace#>>'{tableSchema,status}' is distinct from 'ready' then
      raise sqlstate 'PT400' using message='Invalid action workspace. Use explicit reset for reset.';
    end if;
  elsif p_kind='todo' then
    if jsonb_typeof(p_workspace) is distinct from 'array' or meta<>'{}'::jsonb then raise sqlstate 'PT400' using message='Invalid card action.'; end if;
  else raise sqlstate 'PT400' using message='Invalid action kind.';
  end if;
  select updated_at into version from pipechat.workspaces where id=wid and owner_id=uid for update;
  if not found then raise sqlstate 'PT403' using message='Only the workspace owner can edit it.'; end if;
  select * into old from pipechat.action_journal where workspace_id=wid and action_id=p_action_id;
  if found then
    if old.user_id<>uid or old.request_body is distinct from body then raise sqlstate 'PT409' using message='Action ID already used.'; end if;
    return jsonb_build_object('snapshot',old.result_snapshot,'receipt',pipechat.journal_receipt(old),'replayed',true);
  end if;
  if meta ? 'importReceipt' then
    select * into imported from pipechat.import_receipts where workspace_id=wid and user_id=uid and receipt_id=meta#>>'{importReceipt,id}';
    if found then raise sqlstate 'PT409' using message='Import receipt already used by another action.'; end if;
  end if;
  if p_expected_updated_at is distinct from pipechat.timestamp_text(version) then raise sqlstate 'PT409' using message='The workspace changed.'; end if;
  if p_conversation_id is not null and not exists(select 1 from pipechat.conversation_threads where workspace_id=wid and user_id=uid and epoch=p_conversation_id) then
    raise sqlstate 'PT409' using message='The conversation is unavailable.';
  end if;
  before_data:=pipechat.crm_snapshot_v2(wid);
  if p_kind='crm' then
    if meta ? 'schemaChanges' then
      if to_regprocedure('pipechat.automation_write_workspace(jsonb,text,jsonb)') is null then
        raise sqlstate 'PT409' using message='Explicit schema changes require the workflow migration.';
      end if;
      execute 'select pipechat.automation_write_workspace($1,$2,$3)' into after_data using p_workspace,p_expected_updated_at,meta->'schemaChanges';
    else
      after_data:=public.pipechat_write_workspace_v2(p_workspace->'deals',p_workspace->'customFields',p_workspace->'tableSchema',p_expected_updated_at,p_workspace->'todoCards');
    end if;
  else after_data:=public.pipechat_write_todo(p_workspace,p_expected_updated_at); end if;
  e:=pipechat.journal_entry(p_action_id,p_request_id,p_conversation_id,p_plan_id,null,before_data,after_data);
  insert into pipechat.action_journal(workspace_id,action_id,user_id,entry,request_body,metadata,result_snapshot)
    values(wid,p_action_id,uid,e,body,meta,after_data) returning * into old;
  if meta ? 'importReceipt' then
    insert into pipechat.import_receipts(workspace_id,user_id,receipt_id,digest,action_id)
      values(wid,uid,meta#>>'{importReceipt,id}',meta#>>'{importReceipt,digest}',p_action_id);
  end if;
  return jsonb_build_object('snapshot',after_data,'receipt',pipechat.journal_receipt(old),'replayed',false);
end $$;

create function public.pipechat_commit_action(p_action_id text,p_request_id uuid,p_conversation_id uuid,
  p_plan_id text,p_expected_updated_at text,p_workspace jsonb,p_metadata jsonb default '{}') returns jsonb
language sql security definer set search_path=pg_catalog as $$
  select pipechat.apply_journaled('crm',p_action_id,p_request_id,p_conversation_id,p_plan_id,p_expected_updated_at,p_workspace,p_metadata)
$$;
create function public.pipechat_commit_todo_action(p_action_id text,p_request_id uuid,p_conversation_id uuid,
  p_plan_id text,p_expected_updated_at text,p_todo_cards jsonb,p_metadata jsonb default '{}') returns jsonb
language sql security definer set search_path=pg_catalog as $$
  select pipechat.apply_journaled('todo',p_action_id,p_request_id,p_conversation_id,p_plan_id,p_expected_updated_at,p_todo_cards,p_metadata)
$$;

create function public.pipechat_read_action(p_action_id text) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare uid uuid:=pipechat.require_user(); wid uuid:=pipechat.workspace_for(uid); result jsonb;
begin
  select jsonb_build_object('entry',a.entry,'receipt',pipechat.journal_receipt(a),'undoneBy',a.undone_by,'undoInvalidated',a.undo_invalidated) into result
    from pipechat.action_journal a where workspace_id=wid and user_id=uid and action_id=p_action_id;
  return result;
end $$;

create function pipechat.journal_assert_business_dependencies(p_workspace uuid,p_before jsonb,p_candidate jsonb) returns void
language plpgsql set search_path=pg_catalog as $$
declare removed_ids text[]; business_state jsonb;
begin
  -- The caller already holds the workspace FOR UPDATE lock. Business CAS,
  -- sharing and revocation use that same lock before the business row, so a
  -- dependency cannot appear between this check and the canonical inverse.
  -- 013 is optional for installations using only the journal foundations.
  if to_regclass('pipechat.business_workspaces') is null then return; end if;
  select array_agg('legacy:'||p_workspace::text||':'||(r->>'id')) into removed_ids
    from jsonb_array_elements(p_before->'deals') r where not exists (
      select 1 from jsonb_array_elements(p_candidate->'deals') c where c->'id'=r->'id');
  if coalesce(cardinality(removed_ids),0)=0 then return; end if;
  select state into business_state from pipechat.business_workspaces where workspace_id=p_workspace for update;
  if not found then return; end if;
  -- These references are outside this journal entry. Letting 013's pruning
  -- trigger remove them would undo separately saved business/access changes.
  if exists(select 1 from jsonb_array_elements(business_state->'relationships') r
      where r->>'fromId'=any(removed_ids) or r->>'toId'=any(removed_ids)) or
    exists(select 1 from jsonb_array_elements(business_state->'views') v where (v->'entityIds') ?| removed_ids) or
    exists(select 1 from pipechat.business_grants g where g.workspace_id=p_workspace and g.scope='record'
      and g.resource_id=any(removed_ids)) then
    raise sqlstate 'PT409' using message='Business relationships, views or shares depend on a record. Undo was not applied.';
  end if;
end $$;

create function public.pipechat_undo_action(p_action_id text,p_undo_action_id text,p_request_id uuid,p_expected_updated_at text) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare uid uuid:=pipechat.require_user(); wid uuid:=pipechat.workspace_for(uid); target pipechat.action_journal%rowtype;
  old pipechat.action_journal%rowtype; version timestamptz; before_data jsonb; candidate jsonb; after_data jsonb; e jsonb;
  body jsonb:=jsonb_build_object('undoOf',p_action_id,'requestId',p_request_id,'expectedUpdatedAt',p_expected_updated_at);
begin
  if p_action_id is null or p_undo_action_id is null or p_undo_action_id !~ '^([0-9a-f]{64}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$' or
    p_request_id is null or p_action_id=p_undo_action_id or p_expected_updated_at is null then
    raise sqlstate 'PT400' using message='Invalid undo request.';
  end if;
  select updated_at into version from pipechat.workspaces where id=wid and owner_id=uid for update;
  if not found then raise sqlstate 'PT403' using message='Only the workspace owner can edit it.'; end if;
  select * into old from pipechat.action_journal where workspace_id=wid and action_id=p_undo_action_id;
  if found then
    if old.user_id<>uid or old.request_body is distinct from body then raise sqlstate 'PT409' using message='Action ID already used.'; end if;
    return jsonb_build_object('snapshot',old.result_snapshot,'receipt',pipechat.journal_receipt(old),'replayed',true);
  end if;
  select * into target from pipechat.action_journal where workspace_id=wid and user_id=uid and action_id=p_action_id;
  if not found then raise sqlstate 'PT409' using message='Action unavailable.'; end if;
  if target.undone_by is not null or target.undo_invalidated or target.entry->'undoOf'<>'null'::jsonb then
    raise sqlstate 'PT409' using message='Action is not available for undo.';
  end if;
  if p_expected_updated_at is distinct from pipechat.timestamp_text(version) then raise sqlstate 'PT409' using message='The workspace changed.'; end if;
  before_data:=pipechat.crm_snapshot_v2(wid);
  candidate:=pipechat.journal_inverse(target.entry,before_data);
  perform pipechat.journal_assert_business_dependencies(wid,before_data,candidate);
  -- Validation, trigger effects, compensation and original marker share the transaction.
  begin
    if to_regprocedure('pipechat.automation_restore_workspace(jsonb,jsonb,jsonb,text,jsonb,jsonb)') is not null then
      execute 'select pipechat.automation_restore_workspace($1,$2,$3,$4,$5,$6)' into after_data
        using candidate->'deals',candidate->'customFields',candidate->'tableSchema',p_expected_updated_at,candidate->'todoCards',candidate->'workflows';
    else
      after_data:=public.pipechat_write_workspace_v2(candidate->'deals',candidate->'customFields',candidate->'tableSchema',p_expected_updated_at,candidate->'todoCards');
    end if;
  exception when sqlstate 'PT400' then raise sqlstate 'PT409' using message='Undo dependencies are no longer valid.'; end;
  if pipechat.journal_document(after_data) is distinct from pipechat.journal_document(candidate) then
    raise sqlstate 'PT409' using message='Undo would change unrelated canonical data.';
  end if;
  e:=pipechat.journal_entry(p_undo_action_id,p_request_id,(target.entry->>'conversationId')::uuid,target.entry->>'planId',p_action_id,before_data,after_data);
  insert into pipechat.action_journal(workspace_id,action_id,user_id,entry,request_body,result_snapshot)
    values(wid,p_undo_action_id,uid,e,body,after_data) returning * into old;
  update pipechat.action_journal set undone_by=p_undo_action_id where workspace_id=wid and action_id=p_action_id;
  return jsonb_build_object('snapshot',after_data,'receipt',pipechat.journal_receipt(old),'replayed',false);
end $$;

create function public.pipechat_list_actions(p_before jsonb default null,p_limit integer default 20) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare uid uuid:=pipechat.require_user(); wid uuid:=pipechat.workspace_for(uid); a pipechat.action_journal%rowtype;
  cursor_time timestamptz; cursor_id text; items jsonb:='[]'; last_cursor jsonb:=null; next_cursor jsonb:=null; n integer:=0;
begin
  if p_limit is null or p_limit not between 1 and 100 then raise sqlstate 'PT400' using message='Invalid action page.'; end if;
  if p_before is not null and p_before<>'null'::jsonb then
    if jsonb_typeof(p_before) is distinct from 'object' then raise sqlstate 'PT400' using message='Invalid action cursor.'; end if;
    if (select count(*) from jsonb_object_keys(p_before))<>2 or not p_before ?& array['createdAt','actionId'] or
       jsonb_typeof(p_before->'createdAt') is distinct from 'string' or jsonb_typeof(p_before->'actionId') is distinct from 'string' or
       p_before->>'createdAt' !~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$' or
       p_before->>'actionId' !~ '^([0-9a-f]{64}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$' then
      raise sqlstate 'PT400' using message='Invalid action cursor.';
    end if;
    begin cursor_time:=(p_before->>'createdAt')::timestamptz; exception when others then raise sqlstate 'PT400' using message='Invalid action cursor.'; end;
    cursor_id:=p_before->>'actionId';
  end if;
  for a in select * from pipechat.action_journal where workspace_id=wid and user_id=uid and
    (cursor_time is null or (created_at,action_id)<(cursor_time,cursor_id)) order by created_at desc,action_id desc limit p_limit+1 loop
    n:=n+1;
    if n>p_limit then next_cursor:=last_cursor; exit; end if;
    last_cursor:=jsonb_build_object('createdAt',to_char(a.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'actionId',a.action_id);
    items:=items||jsonb_build_array(jsonb_build_object('receipt',pipechat.journal_receipt(a),'undoneBy',a.undone_by,
      'undoInvalidated',a.undo_invalidated,'createdAt',last_cursor->'createdAt',
      'paths',coalesce((select jsonb_agg(c->'path') from jsonb_array_elements(a.entry->'changes') c),'[]'::jsonb)));
  end loop;
  return jsonb_build_object('actions',items,'before',next_cursor);
end $$;

-- Reset is a workspace boundary: do not resurrect pre-reset values with undo.
create function pipechat.invalidate_action_undo() returns trigger
language plpgsql set search_path=pg_catalog as $$
begin
  update pipechat.action_journal set undo_invalidated=true where workspace_id=new.workspace_id and not undo_invalidated;
  return new;
end $$;
create trigger invalidate_action_undo after update of table_schema on pipechat.workspace_metadata
  for each row when (new.table_schema->>'status'='pending') execute function pipechat.invalidate_action_undo();

create function pipechat.validate_beta_event(p_event jsonb) returns void
language plpgsql immutable set search_path=pg_catalog as $$
declare k text; n numeric; hash text; expected_id text;
begin
  if jsonb_typeof(p_event) is distinct from 'object' then raise sqlstate 'PT400' using message='Invalid telemetry.'; end if;
  if octet_length(p_event::text)>4096 or (select count(*) from jsonb_object_keys(p_event))<>15 or not p_event ?& array[
    'formatVersion','eventId','requestId','conversationId','planId','actionId','stage','attempt','outcome','latencyMs','model','inputTokens','outputTokens','cachedTokens','errorCode'] then
    raise sqlstate 'PT400' using message='Invalid telemetry fields.';
  end if;
  if p_event->'formatVersion' is distinct from '1'::jsonb or
     coalesce(p_event->>'stage','') not in ('request','model','plan','action','undo','turn') or
     coalesce(p_event->>'outcome','') not in ('succeeded','failed','cancelled','conflict','interrupted') or
     coalesce(p_event->>'model','') not in ('primary','fallback','unknown','gpt-5.4-mini','gpt-5.2') or
     coalesce(p_event->>'errorCode','') not in ('none','unknown','timeout','unavailable','invalid_response','validation','conflict','unauthorized','quota','cancelled') then
    raise sqlstate 'PT400' using message='Invalid telemetry values.';
  end if;
  foreach k in array array['eventId','requestId','conversationId','planId','actionId'] loop
    if k not in ('eventId','requestId') and p_event->k='null'::jsonb then continue; end if;
    if k in ('planId','actionId') and jsonb_typeof(p_event->k)='string' and p_event->>k ~ '^[0-9a-f]{64}$' then continue; end if;
    if jsonb_typeof(p_event->k) is distinct from 'string' or p_event->>k !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise sqlstate 'PT400' using message='Invalid telemetry correlation.';
    end if;
  end loop;
  foreach k in array array['attempt','latencyMs','inputTokens','outputTokens','cachedTokens'] loop
    if k in ('inputTokens','outputTokens','cachedTokens') and p_event->k='null'::jsonb then continue; end if;
    if jsonb_typeof(p_event->k) is distinct from 'number' then raise sqlstate 'PT400' using message='Invalid telemetry metric.'; end if;
    n:=(p_event->>k)::numeric;
    if n<0 or n<>trunc(n) or n>(case k when 'attempt' then 10000 when 'latencyMs' then 86400000 else 1000000000 end) then
      raise sqlstate 'PT400' using message='Invalid telemetry metric.';
    end if;
  end loop;
  if p_event->'cachedTokens'<>'null'::jsonb and (p_event->'inputTokens'='null'::jsonb or
      (p_event->>'cachedTokens')::numeric>(p_event->>'inputTokens')::numeric) then
    raise sqlstate 'PT400' using message='Invalid cached token count.';
  end if;
  hash:=encode(sha256(convert_to('["beta-telemetry-v1","'||(p_event->>'requestId')||'","'||(p_event->>'stage')||'",'||
    ((p_event->>'attempt')::numeric::integer)::text||']','UTF8')),'hex');
  expected_id:=substr(hash,1,8)||'-'||substr(hash,9,4)||'-8'||substr(hash,14,3)||'-a'||substr(hash,18,3)||'-'||substr(hash,21,12);
  if p_event->>'eventId' is distinct from expected_id then raise sqlstate 'PT400' using message='Invalid telemetry identity.'; end if;
end $$;

create function public.pipechat_list_beta_events(p_limit integer default 20,p_request_id uuid default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare uid uuid:=pipechat.require_user(); wid uuid:=pipechat.workspace_for(uid); result jsonb;
begin
  if p_limit is null or p_limit not between 1 and 100 then raise sqlstate 'PT400' using message='Invalid telemetry page.'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('event',event,'recordedAt',to_char(recorded_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
    order by recorded_at desc,event_id desc),'[]'::jsonb) into result from
    (select event,event_id,recorded_at from pipechat.beta_event_ledger where workspace_id=wid and user_id=uid and
      (p_request_id is null or request_id=p_request_id) order by recorded_at desc,event_id desc limit p_limit) page;
  return result;
end $$;

create function public.pipechat_record_beta_event(p_event jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare uid uuid:=pipechat.require_user(); wid uuid:=pipechat.workspace_for(uid); old jsonb; inserted integer;
begin
  perform pipechat.validate_beta_event(p_event);
  insert into pipechat.beta_event_ledger(workspace_id,user_id,event_id,request_id,stage,attempt,event)
    values(wid,uid,(p_event->>'eventId')::uuid,(p_event->>'requestId')::uuid,p_event->>'stage',(p_event->>'attempt')::integer,p_event)
    on conflict do nothing;
  get diagnostics inserted=row_count;
  if inserted=0 then
    select event into old from pipechat.beta_event_ledger where workspace_id=wid and user_id=uid and event_id=(p_event->>'eventId')::uuid;
    if old is distinct from p_event then raise sqlstate 'PT409' using message='Telemetry event identity already used.'; end if;
  end if;
  return jsonb_build_object('eventId',p_event->'eventId','inserted',inserted=1);
end $$;

-- Reserve action/undo attempt 0 for the durable commit receipt. latencyMs=0 is
-- deliberately NOT a measured duration; token counts/model usage are unknown.
-- No CRM cells, import digests, request bodies or free-form metadata enter this
-- ledger. Replay does not INSERT a journal row, so it cannot duplicate events.
-- An event failure, or any later receipt/undo-marker failure, rolls back the
-- canonical save, journal and ledger together in the caller's transaction.
create function pipechat.journal_committed_event() returns trigger
language plpgsql set search_path=pg_catalog as $$
declare uid uuid:=pipechat.require_user(); stage_value text; request_value text;
  hash text; event_id text; event_value jsonb;
begin
  if new.user_id is distinct from uid or new.workspace_id is distinct from pipechat.workspace_for(uid) then
    raise sqlstate 'PT403' using message='Journal event actor mismatch.';
  end if;
  stage_value:=case when nullif(new.entry->'undoOf','null'::jsonb) is null then 'action' else 'undo' end;
  request_value:=new.entry->>'requestId';
  hash:=encode(sha256(convert_to('["beta-telemetry-v1","'||request_value||'","'||stage_value||'",0]','UTF8')),'hex');
  event_id:=substr(hash,1,8)||'-'||substr(hash,9,4)||'-8'||substr(hash,14,3)||'-a'||substr(hash,18,3)||'-'||substr(hash,21,12);
  event_value:=jsonb_build_object('formatVersion',1,'eventId',event_id,'requestId',request_value,
    'conversationId',new.entry->'conversationId','planId',new.entry->'planId','actionId',new.action_id,
    'stage',stage_value,'attempt',0,'outcome','succeeded','latencyMs',0,'model','unknown',
    'inputTokens',null,'outputTokens',null,'cachedTokens',null,'errorCode','none');
  perform public.pipechat_record_beta_event(event_value);
  return new;
end $$;
create trigger journal_committed_event after insert on pipechat.action_journal
  for each row execute function pipechat.journal_committed_event();

revoke all on table pipechat.action_journal,pipechat.import_receipts,pipechat.beta_event_ledger from public,anon,authenticated,service_role;
revoke all on function pipechat.journal_document(jsonb),pipechat.journal_slot(jsonb,text[]),
  pipechat.journal_entry(text,uuid,uuid,text,text,jsonb,jsonb),pipechat.journal_inverse(jsonb,jsonb),
  pipechat.journal_receipt(pipechat.action_journal),pipechat.journal_metadata(jsonb),pipechat.apply_journaled(text,text,uuid,uuid,text,text,jsonb,jsonb),
  pipechat.invalidate_action_undo(),pipechat.validate_beta_event(jsonb),pipechat.journal_committed_event(),
  pipechat.journal_assert_business_dependencies(uuid,jsonb,jsonb)
  from public,anon,authenticated,service_role;
revoke all on function public.pipechat_commit_action(text,uuid,uuid,text,text,jsonb,jsonb),public.pipechat_read_action(text),
  public.pipechat_commit_todo_action(text,uuid,uuid,text,text,jsonb,jsonb),public.pipechat_list_actions(jsonb,integer),
  public.pipechat_undo_action(text,text,uuid,text),public.pipechat_record_beta_event(jsonb),public.pipechat_list_beta_events(integer,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.pipechat_commit_action(text,uuid,uuid,text,text,jsonb,jsonb),public.pipechat_read_action(text),
  public.pipechat_commit_todo_action(text,uuid,uuid,text,text,jsonb,jsonb),public.pipechat_list_actions(jsonb,integer),
  public.pipechat_undo_action(text,text,uuid,text),public.pipechat_record_beta_event(jsonb),public.pipechat_list_beta_events(integer,uuid) to authenticated;
notify pgrst,'reload schema';
commit;
