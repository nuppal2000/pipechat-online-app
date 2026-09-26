-- Extend inert conversation state without changing existing data or privileges.
begin;

create or replace function pipechat.validate_conversation_state(p_state jsonb) returns jsonb
language plpgsql immutable set search_path = pg_catalog as $$
declare item record; typ text;
begin
  if p_state is null or p_state = 'null'::jsonb then return null; end if;
  if jsonb_typeof(p_state) <> 'object' or octet_length(p_state::text) > 65536 then
    raise sqlstate 'PT400' using message = 'Conversation state must be an object of at most 65,536 bytes or null.';
  end if;
  for item in select key, value from jsonb_each(p_state) loop
    typ := jsonb_typeof(item.value);
    if item.key not in ('clarification','sourceAction','originalCommand','workspaceVersion','report','view','tableView','focus','savedAt') or
      (item.key in ('clarification','sourceAction','report','tableView','focus') and typ not in ('object','null')) or
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

notify pgrst, 'reload schema';
commit;
