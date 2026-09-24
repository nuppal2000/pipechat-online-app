-- Private per-user archives. No existing workspace data or reset RPC is changed.
begin;

create table pipechat.conversation_threads (
  workspace_id uuid not null references pipechat.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  epoch uuid not null unique default gen_random_uuid(),
  version bigint not null default 0 check (version between 0 and 9007199254740991),
  next_seq bigint not null default 1 check (next_seq between 1 and 9007199254740991),
  state jsonb default null check (jsonb_typeof(state) = 'object' and octet_length(state::text) <= 65536),
  summary text not null default '' check (pipechat.js_length(summary) <= 3200),
  summary_through bigint not null default 0 check (summary_through >= 0 and summary_through <= greatest(0, next_seq - 12)),
  primary key (workspace_id, user_id)
);
create table pipechat.conversation_messages (
  thread_id uuid not null references pipechat.conversation_threads(epoch) on delete cascade,
  id uuid not null,
  seq bigint not null check (seq between 1 and 9007199254740991),
  role text not null check (role in ('user', 'assistant')),
  content text not null check (pipechat.trim_text(content) <> '' and pipechat.js_length(content) <= 32000),
  created_at timestamptz not null default clock_timestamp(),
  primary key (thread_id, id),
  unique (thread_id, seq)
);
create index conversation_messages_search on pipechat.conversation_messages
  using gin (to_tsvector('simple'::regconfig, content));
alter table pipechat.conversation_threads enable row level security;
alter table pipechat.conversation_messages enable row level security;

create function pipechat.validate_conversation_state(p_state jsonb) returns jsonb
language plpgsql immutable set search_path = pg_catalog as $$
declare item record; typ text;
begin
  if p_state is null or p_state = 'null'::jsonb then return null; end if;
  if jsonb_typeof(p_state) <> 'object' or octet_length(p_state::text) > 65536 then
    raise sqlstate 'PT400' using message = 'Conversation state must be an object of at most 65,536 bytes or null.';
  end if;
  for item in select key, value from jsonb_each(p_state) loop
    typ := jsonb_typeof(item.value);
    if item.key not in ('clarification','sourceAction','originalCommand','workspaceVersion','report','view','tableView','savedAt') or
      (item.key in ('clarification','sourceAction','report','tableView') and typ not in ('object','null')) or
      (item.key in ('originalCommand','view') and typ not in ('string','null')) or
      (item.key in ('workspaceVersion','savedAt') and typ not in ('string','number','null')) then
      raise sqlstate 'PT400' using message = 'Invalid conversation state field.';
    end if;
    if item.key in ('workspaceVersion','savedAt') and typ = 'number' then
      if (item.value #>> '{}')::numeric not between 0 and 9007199254740991 or
        (item.value #>> '{}')::numeric <> trunc((item.value #>> '{}')::numeric) then
        raise sqlstate 'PT400' using message = 'Invalid conversation state counter.';
      end if;
    end if;
  end loop;
  -- Stored JSON is inert, never an instruction to mutate CRM data. Also reject
  -- prototype keys at every depth before a browser can later merge this data.
  if exists (
    with recursive nodes(value) as (
      select p_state
      union all
      select child.value from nodes n cross join lateral (
        select e.value from jsonb_each(case when jsonb_typeof(n.value) = 'object' then n.value else '{}'::jsonb end) e
        union all
        select a.value from jsonb_array_elements(case when jsonb_typeof(n.value) = 'array' then n.value else '[]'::jsonb end) a
      ) child
    )
    select 1 from nodes where jsonb_typeof(value) = 'object' and value ?| array['__proto__','prototype','constructor']
  ) then
    raise sqlstate 'PT400' using message = 'Reserved conversation state key.';
  end if;
  return p_state;
end
$$;

create function pipechat.conversation_message_json(p_message pipechat.conversation_messages) returns jsonb
language sql stable set search_path = pg_catalog as $$
  select jsonb_build_object('id',p_message.id,'seq',p_message.seq,'role',p_message.role,
    'content',p_message.content,'createdAt',pipechat.timestamp_text(p_message.created_at))
$$;

create function public.pipechat_read_conversation(p_before bigint default null) returns jsonb
language plpgsql security definer set search_path = pg_catalog as $$
declare
  uid uuid := pipechat.require_user(); wid uuid := pipechat.workspace_for(uid);
  thread pipechat.conversation_threads%rowtype; messages jsonb; memory_messages jsonb := '[]'; first_seq bigint; cursor_seq bigint;
begin
  if p_before is not null and p_before not between 1 and 9007199254740991 then
    raise sqlstate 'PT400' using message = 'Invalid conversation cursor.';
  end if;
  -- All conversation RPCs take the workspace lock before the thread lock.
  -- This serializes them with CRM reset, including first-read initialization.
  perform 1 from pipechat.workspaces where id = wid for share;
  insert into pipechat.conversation_threads(workspace_id,user_id) values (wid,uid)
    on conflict (workspace_id,user_id) do nothing;
  select * into strict thread from pipechat.conversation_threads where workspace_id = wid and user_id = uid for update;
  select coalesce(jsonb_agg(page.message order by page.seq),'[]'::jsonb), min(page.seq) into messages, first_seq
  from (
    select m.seq, pipechat.conversation_message_json(m) as message from pipechat.conversation_messages m
    where m.thread_id = thread.epoch and (p_before is null or m.seq < p_before) order by m.seq desc limit 50
  ) page;
  if exists (select 1 from pipechat.conversation_messages where thread_id = thread.epoch and seq < first_seq) then
    cursor_seq := first_seq;
  end if;
  if p_before is null then
    select coalesce(jsonb_agg(page.message order by page.seq),'[]'::jsonb) into memory_messages
    from (
      select m.seq, pipechat.conversation_message_json(m) as message from pipechat.conversation_messages m
      where m.thread_id = thread.epoch and m.seq > thread.summary_through and m.seq <= thread.next_seq - 12
      order by m.seq limit 20
    ) page;
  end if;
  return jsonb_build_object('epoch',thread.epoch,'version',thread.version,'messages',messages,'before',cursor_seq,
    'state',thread.state,'summary',thread.summary,'summaryThrough',thread.summary_through,'memoryMessages',memory_messages);
end
$$;

create function public.pipechat_write_conversation(p_epoch uuid, p_expected_version bigint, p_messages jsonb, p_state jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog as $$
declare
  uid uuid := pipechat.require_user(); wid uuid := pipechat.workspace_for(uid);
  thread pipechat.conversation_threads%rowtype; previous pipechat.conversation_messages%rowtype;
  item jsonb; client_id uuid; next_state jsonb; changed boolean := false;
begin
  perform 1 from pipechat.workspaces where id = wid for share;
  select * into thread from pipechat.conversation_threads where workspace_id = wid and user_id = uid for update;
  if not found or p_epoch is distinct from thread.epoch or p_expected_version is distinct from thread.version then
    raise sqlstate 'PT409' using message = 'This conversation changed. Reload before saving.';
  end if;
  if jsonb_typeof(p_messages) is distinct from 'array' then
    raise sqlstate 'PT400' using message = 'Invalid conversation messages.';
  end if;
  if jsonb_array_length(p_messages) > 20 then
    raise sqlstate 'PT400' using message = 'Save at most 20 conversation messages at a time.';
  end if;
  next_state := pipechat.validate_conversation_state(p_state);
  for item in select value from jsonb_array_elements(p_messages) loop
    if jsonb_typeof(item) is distinct from 'object' then
      raise sqlstate 'PT400' using message = 'Invalid conversation message.';
    end if;
    if jsonb_typeof(item->'id') is distinct from 'string' or
      (item->>'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or
      coalesce(item->>'role','') not in ('user','assistant') or jsonb_typeof(item->'content') is distinct from 'string' or
      pipechat.trim_text(item->>'content') = '' or pipechat.js_length(item->>'content') > 32000 or
      exists (select 1 from jsonb_object_keys(item) as k(key) where key not in ('id','role','content')) then
      raise sqlstate 'PT400' using message = 'Invalid conversation message.';
    end if;
    client_id := (item->>'id')::uuid;
    select * into previous from pipechat.conversation_messages where thread_id = thread.epoch and id = client_id;
    if found then
      if previous.role is distinct from item->>'role' or previous.content is distinct from item->>'content' then
        raise sqlstate 'PT409' using message = 'A conversation message ID already has different content.';
      end if;
    else
      if thread.next_seq = 9007199254740991 then raise sqlstate 'PT400' using message = 'Conversation sequence limit reached.'; end if;
      insert into pipechat.conversation_messages(thread_id,id,seq,role,content)
        values (thread.epoch,client_id,thread.next_seq,item->>'role',item->>'content');
      thread.next_seq := thread.next_seq + 1;
      changed := true;
    end if;
  end loop;
  if changed or thread.state is distinct from next_state then
    if thread.version = 9007199254740991 then raise sqlstate 'PT400' using message = 'Conversation version limit reached.'; end if;
    update pipechat.conversation_threads set version = version + 1, next_seq = thread.next_seq, state = next_state
      where workspace_id = wid and user_id = uid returning * into thread;
  end if;
  return jsonb_build_object('epoch',thread.epoch,'version',thread.version);
end
$$;

create function public.pipechat_search_conversation(p_query text, p_before bigint default null) returns jsonb
language plpgsql security definer set search_path = pg_catalog as $$
declare
  uid uuid := pipechat.require_user(); wid uuid := pipechat.workspace_for(uid);
  thread_epoch uuid; query tsquery; messages jsonb;
begin
  if p_query is null or char_length(p_query) > 300 or
    (p_before is not null and p_before not between 1 and 9007199254740991) then
    raise sqlstate 'PT400' using message = 'Invalid conversation search.';
  end if;
  perform 1 from pipechat.workspaces where id = wid for share;
  select epoch into thread_epoch from pipechat.conversation_threads where workspace_id = wid and user_id = uid for share;
  query := websearch_to_tsquery('simple'::regconfig, p_query);
  select coalesce(jsonb_agg(page.message order by page.seq),'[]'::jsonb) into messages
  from (
    select m.seq, pipechat.conversation_message_json(m) as message from pipechat.conversation_messages m
    where m.thread_id = thread_epoch and (p_before is null or m.seq < p_before)
      and to_tsvector('simple'::regconfig, m.content) @@ query
    order by m.seq desc limit 6
  ) page;
  return messages;
end
$$;

create function public.pipechat_save_conversation_memory(p_epoch uuid, p_expected_through bigint, p_through bigint, p_summary text) returns jsonb
language plpgsql security definer set search_path = pg_catalog as $$
declare
  uid uuid := pipechat.require_user(); wid uuid := pipechat.workspace_for(uid);
  thread pipechat.conversation_threads%rowtype;
begin
  if p_expected_through is null or p_expected_through not between 0 and 9007199254740991 or
    p_through is null or p_through not between 1 and 9007199254740991 or p_summary is null or pipechat.js_length(p_summary) > 3200 then
    raise sqlstate 'PT400' using message = 'Invalid conversation memory.';
  end if;
  perform 1 from pipechat.workspaces where id = wid for share;
  select * into thread from pipechat.conversation_threads where workspace_id = wid and user_id = uid for update;
  if not found or p_epoch is distinct from thread.epoch or p_expected_through is distinct from thread.summary_through then
    return jsonb_build_object('saved',false);
  end if;
  if p_through <= thread.summary_through or p_through > thread.next_seq - 12 then
    raise sqlstate 'PT400' using message = 'Conversation memory watermark is out of bounds.';
  end if;
  update pipechat.conversation_threads set summary = p_summary, summary_through = p_through
    where workspace_id = wid and user_id = uid;
  return jsonb_build_object('saved',true);
end
$$;

create function pipechat.reset_conversation_history() returns trigger
language plpgsql security definer set search_path = pg_catalog as $$
begin
  delete from pipechat.conversation_threads where workspace_id = new.workspace_id;
  return new;
end
$$;
-- Fire even for pending -> pending: resetting an unconfigured CRM must also
-- invalidate every user's epoch. The existing reset transaction owns the lock.
create trigger reset_conversation_history after update of table_schema on pipechat.workspace_metadata
  for each row when (new.table_schema->>'status' = 'pending') execute function pipechat.reset_conversation_history();

revoke all on table pipechat.conversation_threads, pipechat.conversation_messages from public, anon, authenticated, service_role;
revoke all on function pipechat.validate_conversation_state(jsonb),
  pipechat.conversation_message_json(pipechat.conversation_messages), pipechat.reset_conversation_history()
  from public, anon, authenticated, service_role;
revoke all on function public.pipechat_read_conversation(bigint), public.pipechat_write_conversation(uuid,bigint,jsonb,jsonb),
  public.pipechat_search_conversation(text,bigint), public.pipechat_save_conversation_memory(uuid,bigint,bigint,text)
  from public, anon, authenticated, service_role;
grant execute on function public.pipechat_read_conversation(bigint), public.pipechat_write_conversation(uuid,bigint,jsonb,jsonb),
  public.pipechat_search_conversation(text,bigint), public.pipechat_save_conversation_memory(uuid,bigint,bigint,text) to authenticated;
notify pgrst, 'reload schema';
commit;
