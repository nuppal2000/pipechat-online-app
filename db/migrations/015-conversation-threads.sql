-- Requires 010/012; compatible with 013/014 without redefining their functions.
-- The legacy active slot and all four conversation RPC signatures stay intact.
-- Logical IDs are durable. Epochs are activation leases and are NEVER restored.
-- Parent integration: authenticate actor/session, flush the user message, await
-- begin, and call the provider ONLY for shouldRun=true. Build input from stored
-- text, not an unverified retry body. Await finish even after HTTP disconnect.
-- Set a lease longer than the provider timeout and run the server-only recovery
-- recovery on authenticated reads after crashes. Usage and telemetry
-- are separate caller-owned ledgers, not atomic effects of these turn RPCs.
-- As in 010, owners can author their own transcript. Receipts are untrusted
-- history, NOT proof of model provenance or authority to apply a CRM action.
begin;

create table pipechat.conversation_archives (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references pipechat.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'New chat' check (pipechat.trim_text(title) <> '' and pipechat.js_length(title) <= 160),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  snapshot jsonb check (jsonb_typeof(snapshot) = 'object'),
  reset_invalidated boolean not null default false,
  unique(workspace_id,user_id,id)
);
create index conversation_archives_owner on pipechat.conversation_archives(workspace_id,user_id,updated_at desc,id);
create table pipechat.conversation_epochs (
  epoch uuid primary key,
  archive_id uuid not null references pipechat.conversation_archives(id) on delete cascade
);
create index conversation_epochs_archive on pipechat.conversation_epochs(archive_id);
create table pipechat.conversation_completions (
  archive_id uuid not null references pipechat.conversation_archives(id) on delete cascade,
  request_id uuid not null,
  message_id uuid not null,
  primary key (archive_id,request_id),
  unique (archive_id,message_id)
);
create table pipechat.conversation_turns (
  workspace_id uuid not null,
  user_id uuid not null,
  request_id uuid not null,
  thread_id uuid not null,
  epoch uuid not null references pipechat.conversation_epochs(epoch) on delete cascade,
  user_message_id uuid not null,
  assistant_message_id uuid not null,
  attempt integer not null default 1 check(attempt=1),
  status text not null check(status in ('accepted','running','succeeded','failed','cancelled','interrupted')),
  accepted_at timestamptz not null default clock_timestamp(),
  lease_until timestamptz not null,
  finished_at timestamptz,
  thread_version bigint not null check(thread_version between 0 and 9007199254740991),
  terminal_payload jsonb,
  assistant_message jsonb,
  primary key(workspace_id,user_id,request_id),
  unique(workspace_id,user_id,assistant_message_id),
  unique(thread_id,user_message_id),
  foreign key(workspace_id,user_id,thread_id) references pipechat.conversation_archives(workspace_id,user_id,id) on delete cascade,
  check(user_message_id<>assistant_message_id)
);
create index conversation_turns_recovery on pipechat.conversation_turns(workspace_id,user_id,lease_until)
  where status in ('accepted','running');
alter table pipechat.conversation_archives enable row level security;
alter table pipechat.conversation_epochs enable row level security;
alter table pipechat.conversation_completions enable row level security;
alter table pipechat.conversation_turns enable row level security;
alter table pipechat.conversation_threads add column conversation_id uuid not null default gen_random_uuid();

-- Backfill only metadata; active history, state, CAS counters and epochs are unchanged.
insert into pipechat.conversation_archives(id,workspace_id,user_id,created_at)
  select t.conversation_id,t.workspace_id,t.user_id,coalesce(min(m.created_at),clock_timestamp())
  from pipechat.conversation_threads t left join pipechat.conversation_messages m on m.thread_id=t.epoch
  group by t.conversation_id,t.workspace_id,t.user_id;
insert into pipechat.conversation_epochs(epoch,archive_id)
  select epoch,conversation_id from pipechat.conversation_threads;

create function pipechat.conversation_snapshot(p_thread pipechat.conversation_threads) returns jsonb
language sql stable set search_path=pg_catalog as $$
  select jsonb_build_object('epoch',p_thread.epoch,'version',p_thread.version,'nextSeq',p_thread.next_seq,
    'state',p_thread.state,'summary',p_thread.summary,'summaryThrough',p_thread.summary_through,
    'messages',coalesce((select jsonb_agg(pipechat.conversation_message_json(m) order by m.seq)
      from pipechat.conversation_messages m where m.thread_id=p_thread.epoch),'[]'::jsonb))
$$;

create function pipechat.touch_conversation_archive() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
begin
  insert into pipechat.conversation_archives(id,workspace_id,user_id) values(new.conversation_id,new.workspace_id,new.user_id)
    on conflict(id) do update set updated_at=clock_timestamp();
  insert into pipechat.conversation_epochs(epoch,archive_id) values(new.epoch,new.conversation_id) on conflict(epoch) do nothing;
  return new;
end $$;
create trigger touch_conversation_archive after insert or update on pipechat.conversation_threads
  for each row execute function pipechat.touch_conversation_archive();

create function pipechat.archive_departing_conversation() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
begin
  -- BEFORE DELETE precedes the message FK cascade. Account/workspace deletion is
  -- still deletion, not a reason to recreate data during a parent FK cascade.
  update pipechat.conversation_archives set snapshot=pipechat.conversation_snapshot(old),updated_at=clock_timestamp()
    where id=old.conversation_id;
  return old;
end $$;
create trigger archive_departing_conversation before delete on pipechat.conversation_threads
  for each row execute function pipechat.archive_departing_conversation();

create function pipechat.invalidate_conversation_archives() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
begin
  update pipechat.conversation_archives set reset_invalidated=true where workspace_id=new.workspace_id;
  return new;
end $$;
-- Runs after 010's reset trigger. Keep historical snapshots, but do not restore
-- selections/reports tied to a CRM which has since been reset.
create trigger zz_invalidate_conversation_archives after update of table_schema on pipechat.workspace_metadata
  for each row when(new.table_schema->>'status'='pending') execute function pipechat.invalidate_conversation_archives();

create function public.pipechat_list_conversation_threads() returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare uid uuid:=pipechat.require_user(); wid uuid:=pipechat.workspace_for(uid);
  t pipechat.conversation_threads%rowtype; items jsonb;
begin
  perform public.pipechat_read_conversation();
  select * into strict t from pipechat.conversation_threads where workspace_id=wid and user_id=uid for update;
  select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'title',case when a.title='New chat' then coalesce(
    nullif(left(regexp_replace(case when a.id=t.conversation_id then
      (select m.content from pipechat.conversation_messages m where m.thread_id=t.epoch and m.role='user' order by m.seq limit 1)
      else (select v->>'content' from jsonb_array_elements(a.snapshot->'messages') v where v->>'role'='user' order by (v->>'seq')::bigint limit 1)
      end,'\s+',' ','g'),80),''),a.title) else a.title end,
    'createdAt',pipechat.timestamp_text(a.created_at),'updatedAt',pipechat.timestamp_text(a.updated_at),
    'messageCount',case when a.id=t.conversation_id then t.next_seq-1 else jsonb_array_length(a.snapshot->'messages') end,
    'active',a.id=t.conversation_id) order by a.updated_at desc,a.id),'[]'::jsonb) into items
    from pipechat.conversation_archives a where a.workspace_id=wid and a.user_id=uid;
  return jsonb_build_object('activeThreadId',t.conversation_id,'epoch',t.epoch,'version',t.version,'threads',items);
end $$;

create function pipechat.select_conversation_thread(p_uid uuid,p_wid uuid,p_epoch uuid,p_version bigint,p_target uuid,p_title text) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare t pipechat.conversation_threads%rowtype; target pipechat.conversation_archives%rowtype;
  fresh_epoch uuid:=gen_random_uuid(); s jsonb; restored_state jsonb;
begin
  -- Match 010/014 lock order: workspace, active slot, then private archive.
  perform 1 from pipechat.workspaces where id=p_wid for share;
  select * into t from pipechat.conversation_threads where workspace_id=p_wid and user_id=p_uid for update;
  if not found or t.epoch is distinct from p_epoch or t.version is distinct from p_version then
    raise sqlstate 'PT409' using message='This conversation changed. Reload before switching.';
  end if;
  if p_target is null then
    if p_title is null or pipechat.trim_text(p_title)='' or pipechat.js_length(p_title)>160 or p_title ~ U&'[\0001-\001f\007f]' then
      raise sqlstate 'PT400' using message='Invalid conversation title.';
    end if;
    insert into pipechat.conversation_archives(workspace_id,user_id,title) values(p_wid,p_uid,pipechat.trim_text(p_title)) returning * into target;
  else
    select * into target from pipechat.conversation_archives where id=p_target and workspace_id=p_wid and user_id=p_uid for update;
    if not found then raise sqlstate 'PT404' using message='Conversation unavailable.'; end if;
    if target.id=t.conversation_id then
      return jsonb_build_object('threadId',target.id,'conversation',public.pipechat_read_conversation());
    end if;
  end if;
  s:=target.snapshot;
  -- Keep the complete suspended state in its snapshot, but never reactivate a
  -- previously proposed action or pending clarification on a new epoch.
  restored_state:=case when target.reset_invalidated then null else nullif(s->'state','null'::jsonb)
    - array['clarification','sourceAction','originalCommand','workspaceVersion','savedAt'] end;
  restored_state:=pipechat.validate_conversation_state(restored_state);
  delete from pipechat.conversation_threads where workspace_id=p_wid and user_id=p_uid;
  insert into pipechat.conversation_threads(workspace_id,user_id,conversation_id,epoch,version,next_seq,state,summary,summary_through)
    values(p_wid,p_uid,target.id,fresh_epoch,coalesce((s->>'version')::bigint,0),coalesce((s->>'nextSeq')::bigint,1),
      restored_state,coalesce(s->>'summary',''),coalesce((s->>'summaryThrough')::bigint,0));
  insert into pipechat.conversation_messages(thread_id,id,seq,role,content,created_at)
    select fresh_epoch,(v->>'id')::uuid,(v->>'seq')::bigint,v->>'role',v->>'content',(v->>'createdAt')::timestamptz
    from jsonb_array_elements(coalesce(s->'messages','[]'::jsonb)) v;
  update pipechat.conversation_archives set reset_invalidated=false where id=target.id;
  return jsonb_build_object('threadId',target.id,'conversation',public.pipechat_read_conversation());
end $$;

create function public.pipechat_new_conversation_thread(p_epoch uuid,p_expected_version bigint,p_title text default 'New chat') returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare uid uuid:=pipechat.require_user(); wid uuid:=pipechat.workspace_for(uid);
begin
  return pipechat.select_conversation_thread(uid,wid,p_epoch,p_expected_version,null,p_title);
end $$;
create function public.pipechat_switch_conversation_thread(p_epoch uuid,p_expected_version bigint,p_thread_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare uid uuid:=pipechat.require_user(); wid uuid:=pipechat.workspace_for(uid);
begin
  if p_thread_id is null then raise sqlstate 'PT400' using message='Choose a conversation.'; end if;
  return pipechat.select_conversation_thread(uid,wid,p_epoch,p_expected_version,p_thread_id,null);
end $$;

-- Private append primitive. Public wrappers validate the current JWT session. The
-- epoch locates the originating chat even after switching/reset. This appends only
-- assistant text; it cannot restore pending state, focus, or authorize CRM writes.
create function pipechat.append_terminal_reply(p_wid uuid,p_user_id uuid,p_epoch uuid,
  p_request_id uuid,p_message_id uuid,p_content text) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare wid uuid:=p_wid; t pipechat.conversation_threads%rowtype; target pipechat.conversation_archives%rowtype;
  receipt pipechat.conversation_completions%rowtype; old_message jsonb; item jsonb; s jsonb;
  is_active boolean; inserted boolean; seq_no bigint; ver bigint;
begin
  if p_request_id is null or p_message_id is null or p_content is null or pipechat.trim_text(p_content)='' or pipechat.js_length(p_content)>32000 then
    raise sqlstate 'PT400' using message='Invalid terminal reply.';
  end if;
  perform 1 from pipechat.workspaces where id=wid for share;
  select * into t from pipechat.conversation_threads where workspace_id=wid and user_id=p_user_id for update;
  select a.* into target from pipechat.conversation_archives a join pipechat.conversation_epochs e on e.archive_id=a.id
    where e.epoch=p_epoch and a.workspace_id=wid and a.user_id=p_user_id for update of a;
  if not found then raise sqlstate 'PT404' using message='Conversation unavailable.'; end if;
  is_active:=coalesce(t.conversation_id=target.id,false);
  s:=target.snapshot;
  if is_active then
    select pipechat.conversation_message_json(m) into old_message from pipechat.conversation_messages m where m.thread_id=t.epoch and m.id=p_message_id;
    seq_no:=t.next_seq; ver:=t.version;
  else
    select v into old_message from jsonb_array_elements(s->'messages') v where v->>'id'=p_message_id::text;
    seq_no:=(s->>'nextSeq')::bigint; ver:=(s->>'version')::bigint;
  end if;
  select * into receipt from pipechat.conversation_completions where archive_id=target.id and request_id=p_request_id;
  if (found and receipt.message_id<>p_message_id) or exists(select 1 from pipechat.conversation_completions
      where archive_id=target.id and message_id=p_message_id and request_id<>p_request_id) or
    (old_message is not null and (old_message->>'role'<>'assistant' or old_message->>'content' is distinct from p_content)) then
    raise sqlstate 'PT409' using message='Terminal reply identity already used.';
  end if;
  if receipt.request_id is not null and old_message is null then raise sqlstate 'PT409' using message='Incomplete terminal reply receipt.'; end if;
  inserted:=old_message is null;
  if inserted then
    if seq_no is null or ver is null or seq_no>=9007199254740991 or ver>=9007199254740991 then
      raise sqlstate 'PT400' using message='Conversation sequence or version limit reached.';
    end if;
    if is_active then
      insert into pipechat.conversation_messages(thread_id,id,seq,role,content) values(t.epoch,p_message_id,seq_no,'assistant',p_content);
      update pipechat.conversation_threads set next_seq=next_seq+1,version=version+1 where workspace_id=wid and user_id=p_user_id;
    else
      item:=jsonb_build_object('id',p_message_id,'seq',seq_no,'role','assistant','content',p_content,'createdAt',pipechat.timestamp_text(clock_timestamp()));
      update pipechat.conversation_archives set snapshot=s||jsonb_build_object('version',ver+1,'nextSeq',seq_no+1,
        'messages',(s->'messages')||jsonb_build_array(item)),updated_at=clock_timestamp() where id=target.id;
    end if;
    ver:=ver+1;
  else seq_no:=(old_message->>'seq')::bigint;
  end if;
  insert into pipechat.conversation_completions(archive_id,request_id,message_id) values(target.id,p_request_id,p_message_id)
    on conflict(archive_id,request_id) do nothing;
  return jsonb_build_object('threadId',target.id,'messageId',p_message_id,'seq',seq_no,'version',ver,'active',is_active,'inserted',inserted);
end $$;

-- Untracked server notices only. Accepted turns MUST use finish below.
create function public.pipechat_complete_conversation_turn(p_epoch uuid,
  p_request_id uuid,p_message_id uuid,p_content text) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare p_user_id uuid:=pipechat.require_user(); wid uuid:=pipechat.workspace_for(p_user_id);
begin
  perform 1 from pipechat.workspaces where id=wid for update;
  if exists(select 1 from pipechat.conversation_turns where workspace_id=wid and user_id=p_user_id and
    (request_id=p_request_id or assistant_message_id=p_message_id)) then
    raise sqlstate 'PT409' using message='Use finish_conversation_turn for an accepted turn.';
  end if;
  return pipechat.append_terminal_reply(wid,p_user_id,p_epoch,p_request_id,p_message_id,p_content);
end $$;

create function pipechat.conversation_terminal_payload(p_status text,p_error text,p_content text,p_receipt jsonb) returns jsonb
language plpgsql immutable set search_path=pg_catalog as $$
declare content text;
begin
  if p_status is null or p_status not in ('succeeded','failed','cancelled','interrupted') then raise sqlstate 'PT400' using message='Invalid terminal status.'; end if;
  p_receipt:=nullif(p_receipt,'null'::jsonb);
  if p_status='succeeded' then
    if p_error is distinct from 'none' or p_content is null or pipechat.trim_text(p_content)='' or pipechat.js_length(p_content)>32000 then
      raise sqlstate 'PT400' using message='Invalid successful turn.';
    end if;
    perform pipechat.validate_conversation_state(jsonb_build_object('sourceAction',p_receipt));
    content:=p_content;
  else
    if p_content is not null or p_receipt is not null or p_error is null or
      (p_status='failed' and p_error not in ('unknown','timeout','unavailable','invalid_response','validation','conflict','unauthorized','quota')) or
      (p_status='cancelled' and p_error<>'cancelled') or (p_status='interrupted' and p_error<>'timeout') then
      raise sqlstate 'PT400' using message='Failures require a public error code, not raw provider text.';
    end if;
    content:=case when p_status='interrupted' then 'This request was interrupted before a durable result was saved. It was not rerun.'
      when p_status='cancelled' then 'The request was cancelled. Check saved activity for any completed changes.'
      else case p_error
        when 'unknown' then 'The request could not be completed. Check saved activity before trying again.'
        when 'timeout' then 'The request timed out before a durable reply was saved.'
        when 'unavailable' then 'The assistant is temporarily unavailable.'
        when 'invalid_response' then 'The assistant returned a response that could not be validated.'
        when 'validation' then 'The request could not be validated.'
        when 'conflict' then 'The workspace changed while this request was running.'
        when 'unauthorized' then 'The request could not be completed because access changed.'
        when 'quota' then 'The chat usage limit was reached.' end end;
  end if;
  return jsonb_build_object('status',p_status,'publicErrorCode',p_error,'content',content,'resultReceipt',p_receipt);
end $$;

create function pipechat.conversation_turn_receipt(p_turn pipechat.conversation_turns) returns jsonb
language sql stable set search_path=pg_catalog as $$
  select jsonb_build_object('requestId',p_turn.request_id,'threadId',p_turn.thread_id,'epoch',p_turn.epoch,
    'userMessageId',p_turn.user_message_id,'assistantMessageId',p_turn.assistant_message_id,'attempt',p_turn.attempt,'status',p_turn.status,
    'acceptedAt',pipechat.timestamp_text(p_turn.accepted_at),'leaseUntil',pipechat.timestamp_text(p_turn.lease_until),
    'finishedAt',pipechat.timestamp_text(p_turn.finished_at),'publicErrorCode',p_turn.terminal_payload->'publicErrorCode',
    'threadVersion',p_turn.thread_version,'resultReceipt',p_turn.terminal_payload->'resultReceipt','assistantMessage',p_turn.assistant_message)
$$;

create function pipechat.guard_turn_assistant_message() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
declare accepted pipechat.conversation_turns%rowtype;
begin
  select r.* into accepted from pipechat.conversation_turns r join pipechat.conversation_threads t on t.conversation_id=r.thread_id
    where t.epoch=new.thread_id and r.assistant_message_id=new.id;
  if found and (accepted.status in ('accepted','running') or new.role<>'assistant' or new.content is distinct from accepted.terminal_payload->>'content') then
    raise sqlstate 'PT409' using message='This assistant message is reserved for its accepted turn.';
  end if;
  return new;
end $$;
create trigger guard_turn_assistant_message before insert on pipechat.conversation_messages
  for each row execute function pipechat.guard_turn_assistant_message();

create function pipechat.finish_conversation_turn(p_wid uuid,p_uid uuid,p_thread uuid,p_request uuid,p_payload jsonb) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare turn pipechat.conversation_turns%rowtype; appended jsonb; message jsonb; at_time timestamptz;
begin
  perform 1 from pipechat.workspaces where id=p_wid for update;
  perform 1 from pipechat.conversation_threads where workspace_id=p_wid and user_id=p_uid for update;
  select * into turn from pipechat.conversation_turns where workspace_id=p_wid and user_id=p_uid and request_id=p_request for update;
  if not found or turn.thread_id is distinct from p_thread then raise sqlstate 'PT404' using message='Turn unavailable.'; end if;
  if turn.status not in ('accepted','running') then
    if turn.terminal_payload is distinct from p_payload then raise sqlstate 'PT409' using message='Terminal turn outcome already recorded.'; end if;
    return pipechat.conversation_turn_receipt(turn);
  end if;
  at_time:=clock_timestamp();
  if turn.lease_until<=at_time then p_payload:=pipechat.conversation_terminal_payload('interrupted','timeout',null,null); end if;
  -- Marker first permits the guarded message insert; both roll back together.
  update pipechat.conversation_turns set status=p_payload->>'status',terminal_payload=p_payload,finished_at=at_time
    where workspace_id=p_wid and user_id=p_uid and request_id=p_request;
  appended:=pipechat.append_terminal_reply(p_wid,p_uid,turn.epoch,p_request,turn.assistant_message_id,p_payload->>'content');
  if (appended->>'active')::boolean then
    select pipechat.conversation_message_json(m) into message from pipechat.conversation_messages m join pipechat.conversation_threads t on t.epoch=m.thread_id
      where t.workspace_id=p_wid and t.user_id=p_uid and m.id=turn.assistant_message_id;
  else
    select v into message from pipechat.conversation_archives a cross join lateral jsonb_array_elements(a.snapshot->'messages') v
      where a.id=p_thread and v->>'id'=turn.assistant_message_id::text;
  end if;
  update pipechat.conversation_turns set thread_version=(appended->>'version')::bigint,assistant_message=message
    where workspace_id=p_wid and user_id=p_uid and request_id=p_request returning * into turn;
  return pipechat.conversation_turn_receipt(turn);
end $$;

-- Acceptance and the one model-call claim commit together. Replays
-- return shouldRun=false, including after a lost begin response. There is no
-- lease reclaim API: expired work becomes interrupted, never another model call.
-- Bind caller-owned usage/telemetry to requestId; 001/014 are not rewritten here.
create function public.pipechat_begin_conversation_turn(p_thread_id uuid,p_epoch uuid,
  p_expected_version bigint,p_request_id uuid,p_user_message_id uuid,p_assistant_message_id uuid,p_lease_seconds integer default 120) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare p_user_id uuid:=pipechat.require_user(); wid uuid:=pipechat.workspace_for(p_user_id); t pipechat.conversation_threads%rowtype;
  turn pipechat.conversation_turns%rowtype; at_time timestamptz;
begin
  if p_thread_id is null or p_epoch is null or p_request_id is null or p_user_message_id is null or p_assistant_message_id is null or
    p_user_message_id=p_assistant_message_id or p_expected_version is null or p_expected_version not between 0 and 9007199254740991 or
    p_lease_seconds is null or p_lease_seconds not between 1 and 3600 then raise sqlstate 'PT400' using message='Invalid turn identity or lease.'; end if;
  perform 1 from pipechat.workspaces where id=wid for update;
  select * into t from pipechat.conversation_threads where workspace_id=wid and user_id=p_user_id for update;
  select * into turn from pipechat.conversation_turns where workspace_id=wid and user_id=p_user_id and request_id=p_request_id for update;
  if found then
    if turn.thread_id<>p_thread_id or turn.epoch<>p_epoch or turn.user_message_id<>p_user_message_id or turn.assistant_message_id<>p_assistant_message_id then
      raise sqlstate 'PT409' using message='Turn identity already used.';
    end if;
    if turn.status in ('accepted','running') and turn.lease_until<=clock_timestamp() then
      return pipechat.finish_conversation_turn(wid,p_user_id,p_thread_id,p_request_id,pipechat.conversation_terminal_payload('interrupted','timeout',null,null))||'{"shouldRun":false}'::jsonb;
    end if;
    return pipechat.conversation_turn_receipt(turn)||'{"shouldRun":false}'::jsonb;
  end if;
  if t.epoch is distinct from p_epoch or t.version is distinct from p_expected_version or t.conversation_id is distinct from p_thread_id then
    raise sqlstate 'PT409' using message='This conversation changed. Reload before starting a turn.';
  end if;
  if not exists(select 1 from pipechat.conversation_messages where thread_id=t.epoch and id=p_user_message_id and role='user') then
    raise sqlstate 'PT409' using message='Flush the user message before beginning its turn.';
  end if;
  if exists(select 1 from pipechat.conversation_messages where thread_id=t.epoch and id=p_assistant_message_id) or
    exists(select 1 from pipechat.conversation_turns where workspace_id=wid and user_id=p_user_id and
      (assistant_message_id=p_assistant_message_id or thread_id=p_thread_id and user_message_id=p_user_message_id)) or
    exists(select 1 from pipechat.conversation_completions c join pipechat.conversation_archives a on a.id=c.archive_id
      where a.workspace_id=wid and a.user_id=p_user_id and c.request_id=p_request_id) then
    raise sqlstate 'PT409' using message='Turn message or request identity already used.';
  end if;
  at_time:=clock_timestamp();
  insert into pipechat.conversation_turns(workspace_id,user_id,request_id,thread_id,epoch,user_message_id,assistant_message_id,status,accepted_at,lease_until,thread_version)
    values(wid,p_user_id,p_request_id,p_thread_id,p_epoch,p_user_message_id,p_assistant_message_id,'running',at_time,
      at_time+make_interval(secs=>p_lease_seconds),t.version) returning * into turn;
  return pipechat.conversation_turn_receipt(turn)||'{"shouldRun":true}'::jsonb;
end $$;

create function public.pipechat_finish_conversation_turn(p_thread_id uuid,p_request_id uuid,
  p_status text,p_public_error_code text,p_content text,p_result_receipt jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare p_user_id uuid:=pipechat.require_user(); wid uuid:=pipechat.workspace_for(p_user_id);
begin
  return pipechat.finish_conversation_turn(wid,p_user_id,p_thread_id,p_request_id,
    pipechat.conversation_terminal_payload(p_status,p_public_error_code,p_content,p_result_receipt));
end $$;

create function public.pipechat_read_conversation_turn(p_thread_id uuid,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare uid uuid:=pipechat.require_user(); wid uuid:=pipechat.workspace_for(uid); turn pipechat.conversation_turns%rowtype;
begin
  select * into turn from pipechat.conversation_turns where workspace_id=wid and user_id=uid and thread_id=p_thread_id and request_id=p_request_id;
  if not found then raise sqlstate 'PT404' using message='Turn unavailable.'; end if;
  return pipechat.conversation_turn_receipt(turn);
end $$;

-- Recovery needs a live owner session, like every other RPC in this application.
-- After logout/process death it runs on the owner's next authenticated read.
create function public.pipechat_recover_conversation_turns(p_limit integer default 50) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare p_user_id uuid:=pipechat.require_user(); p_workspace_id uuid:=pipechat.workspace_for(p_user_id);
  turn pipechat.conversation_turns%rowtype; recovered jsonb:='[]'::jsonb;
begin
  if p_workspace_id is null or p_user_id is null or p_limit is null or p_limit not between 1 and 100 then raise sqlstate 'PT400' using message='Invalid recovery scope.'; end if;
  perform 1 from pipechat.workspaces where id=p_workspace_id for update;
  perform 1 from pipechat.conversation_threads where workspace_id=p_workspace_id and user_id=p_user_id for update;
  for turn in select * from pipechat.conversation_turns where workspace_id=p_workspace_id and user_id=p_user_id
    and status in ('accepted','running') and lease_until<=clock_timestamp() order by lease_until,request_id limit p_limit for update loop
    recovered:=recovered||jsonb_build_array(pipechat.finish_conversation_turn(p_workspace_id,p_user_id,turn.thread_id,turn.request_id,
      pipechat.conversation_terminal_payload('interrupted','timeout',null,null)));
  end loop;
  return jsonb_build_object('recovered',recovered);
end $$;

revoke all on table pipechat.conversation_archives,pipechat.conversation_epochs,pipechat.conversation_completions,pipechat.conversation_turns
  from public,anon,authenticated,service_role;
revoke all on function pipechat.conversation_snapshot(pipechat.conversation_threads),pipechat.touch_conversation_archive(),
  pipechat.archive_departing_conversation(),pipechat.invalidate_conversation_archives(),
  pipechat.select_conversation_thread(uuid,uuid,uuid,bigint,uuid,text),pipechat.append_terminal_reply(uuid,uuid,uuid,uuid,uuid,text),
  pipechat.conversation_terminal_payload(text,text,text,jsonb),
  pipechat.conversation_turn_receipt(pipechat.conversation_turns),pipechat.guard_turn_assistant_message(),
  pipechat.finish_conversation_turn(uuid,uuid,uuid,uuid,jsonb)
  from public,anon,authenticated,service_role;
revoke all on function public.pipechat_list_conversation_threads(),public.pipechat_new_conversation_thread(uuid,bigint,text),
  public.pipechat_switch_conversation_thread(uuid,bigint,uuid),public.pipechat_complete_conversation_turn(uuid,uuid,uuid,text),
  public.pipechat_begin_conversation_turn(uuid,uuid,bigint,uuid,uuid,uuid,integer),
  public.pipechat_finish_conversation_turn(uuid,uuid,text,text,text,jsonb),
  public.pipechat_read_conversation_turn(uuid,uuid),public.pipechat_recover_conversation_turns(integer)
  from public,anon,authenticated,service_role;
grant execute on function public.pipechat_list_conversation_threads(),public.pipechat_new_conversation_thread(uuid,bigint,text),
  public.pipechat_switch_conversation_thread(uuid,bigint,uuid),public.pipechat_read_conversation_turn(uuid,uuid) to authenticated;
grant execute on function public.pipechat_complete_conversation_turn(uuid,uuid,uuid,text),
  public.pipechat_begin_conversation_turn(uuid,uuid,bigint,uuid,uuid,uuid,integer),
  public.pipechat_finish_conversation_turn(uuid,uuid,text,text,text,jsonb),public.pipechat_recover_conversation_turns(integer) to authenticated;
notify pgrst,'reload schema';
commit;
