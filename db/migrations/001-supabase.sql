-- Fresh-install migration. Apply once as the trusted database migration owner.
-- Deliberately independent of the obsolete db/supabase-schema.sql and Xano data.
begin;

create schema pipechat;
revoke all on schema pipechat from public, anon, authenticated, service_role;
alter default privileges in schema pipechat revoke execute on functions from public;
alter default privileges in schema pipechat revoke all on tables from public, anon, authenticated, service_role;
alter default privileges in schema pipechat revoke all on sequences from public, anon, authenticated, service_role;

create table pipechat.schema_version (
  singleton boolean primary key default true check (singleton),
  version integer not null check (version = 1)
);
insert into pipechat.schema_version(version) values (1);

create table pipechat.workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null unique references auth.users(id) on delete cascade,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz
);
create table pipechat.memberships (
  workspace_id uuid not null references pipechat.workspaces(id) on delete cascade,
  user_id uuid not null unique references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'member')),
  primary key (workspace_id, user_id)
);
create unique index memberships_one_owner on pipechat.memberships(workspace_id) where role = 'owner';
create table pipechat.workspace_metadata (
  workspace_id uuid primary key references pipechat.workspaces(id) on delete cascade,
  table_schema jsonb not null default '{"status":"pending"}' check (jsonb_typeof(table_schema) = 'object'),
  custom_fields jsonb not null default '[]' check (jsonb_typeof(custom_fields) = 'array')
);
create table pipechat.crm_records (
  workspace_id uuid not null references pipechat.workspaces(id) on delete cascade,
  record_id bigint not null check (record_id between 1 and 9007199254740991),
  position integer not null check (position between 0 and 1999),
  cells jsonb not null check (jsonb_typeof(cells) = 'object'),
  history jsonb not null default '[]' check (jsonb_typeof(history) = 'array'),
  activity text not null default '',
  health text not null default '',
  primary key (workspace_id, record_id),
  unique (workspace_id, position)
);
create table pipechat.usage_counters (
  user_id uuid primary key references auth.users(id) on delete cascade,
  used bigint not null default 0 check (used between 0 and 9007199254740991),
  quota_limit bigint not null default 1000 check (quota_limit between 0 and 9007199254740991),
  reserved bigint not null default 0 check (reserved between 0 and 9007199254740991),
  updated_at timestamptz not null default clock_timestamp(),
  check (used + reserved <= 9007199254740991)
);
create table pipechat.usage_reservations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references pipechat.usage_counters(user_id) on delete cascade,
  request_id uuid not null,
  state text not null default 'reserved' check (state in ('reserved', 'commit', 'release', 'expired')),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  finished_at timestamptz,
  unique (user_id, request_id),
  check (expires_at = created_at + interval '5 minutes'),
  check ((state = 'reserved') = (finished_at is null))
);
create index usage_reservations_expiry on pipechat.usage_reservations(user_id, expires_at) where state = 'reserved';

-- No browser policies: table ACLs and RLS both deny direct access. Only the
-- trusted migration owner and the narrowly granted RPCs operate these tables.
alter table pipechat.schema_version enable row level security;
alter table pipechat.workspaces enable row level security;
alter table pipechat.memberships enable row level security;
alter table pipechat.workspace_metadata enable row level security;
alter table pipechat.crm_records enable row level security;
alter table pipechat.usage_counters enable row level security;
alter table pipechat.usage_reservations enable row level security;

create function pipechat.timestamp_text(p_value timestamptz) returns text
language sql immutable strict set search_path = pg_catalog as $$
  select to_char(p_value at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
$$;

-- JavaScript String.trim/length semantics, including non-BMP characters.
create function pipechat.trim_text(p_value text) returns text
language sql immutable strict set search_path = pg_catalog as $$
  select regexp_replace(p_value, U&'^[\0009-\000d\0020\00a0\1680\2000-\200a\2028\2029\202f\205f\3000\feff]+|[\0009-\000d\0020\00a0\1680\2000-\200a\2028\2029\202f\205f\3000\feff]+$', '', 'g')
$$;
create function pipechat.js_length(p_value text) returns integer
language sql immutable strict set search_path = pg_catalog as $$
  select char_length(p_value) + char_length(regexp_replace(p_value, U&'[^\+010000-\+10ffff]', '', 'g'))
$$;
create function pipechat.name_key(p_value text, p_accents boolean default false) returns text
language sql immutable strict set search_path = pg_catalog as $$
  select regexp_replace(lower(pipechat.trim_text(case when p_accents
    then regexp_replace(normalize(p_value, NFKD), U&'[\0300-\036f]', '', 'g')
    else p_value end)), U&'[\0009-\000d\0020\00a0\1680\2000-\200a\2028\2029\202f\205f\3000\feff]+', ' ', 'g')
$$;
create function pipechat.label(p_value jsonb, p_max integer default 60) returns text
language plpgsql immutable set search_path = pg_catalog as $$
declare v text;
begin
  if jsonb_typeof(p_value) is distinct from 'string' then
    raise sqlstate 'PT400' using message = 'Invalid table or field label.';
  end if;
  v := pipechat.trim_text(p_value #>> '{}');
  if v = '' or pipechat.js_length(v) > p_max or (p_value #>> '{}') ~ U&'[\0001-\001f\007f]' then
    raise sqlstate 'PT400' using message = 'Invalid table or field label.';
  end if;
  return v;
end
$$;

create function pipechat.validate_schema(p_schema jsonb) returns jsonb
language plpgsql immutable set search_path = pg_catalog as $$
declare
  f jsonb; opt jsonb; name text; key text; title text; record_label text;
  fid text; typ text; role_name text; option_label text;
  ids text[] := '{}'; names text[] := '{}'; roles text[] := '{}'; option_keys text[];
  fields jsonb := '[]'; options jsonb; is_legacy boolean := p_schema->'legacy' = 'true'::jsonb;
begin
  if jsonb_typeof(p_schema) is distinct from 'object' then
    raise sqlstate 'PT400' using message = 'Invalid workspace setup.';
  end if;
  if p_schema->>'status' = 'pending' then return '{"status":"pending"}'; end if;
  if p_schema->>'status' is distinct from 'ready' or
    coalesce(p_schema->>'useCase', '') not in ('Sales', 'Recruiting', 'Real Estate', 'Other') then
    raise sqlstate 'PT400' using message = 'Invalid workspace setup.';
  end if;
  title := pipechat.label(p_schema->'title');
  record_label := pipechat.label(p_schema->'recordLabel');
  if jsonb_typeof(p_schema->'description') is distinct from 'string' or pipechat.js_length(p_schema->>'description') > 2000 then
    raise sqlstate 'PT400' using message = 'Workflow description must be at most 2,000 characters.';
  end if;
  if jsonb_typeof(p_schema->'fields') is distinct from 'array' then
    raise sqlstate 'PT400' using message = 'Invalid table fields.';
  end if;
  if jsonb_array_length(p_schema->'fields') not between 1 and 30 then
    raise sqlstate 'PT400' using message = 'A table needs between 1 and 30 fields.';
  end if;
  for f in select value from jsonb_array_elements(p_schema->'fields') loop
    fid := f->>'id'; typ := f->>'type'; role_name := f->>'role';
    if jsonb_typeof(f) is distinct from 'object' or jsonb_typeof(f->'id') is distinct from 'string' or
      not (fid ~ '^(f_|cf_)[a-z0-9_]{1,60}$' or coalesce(is_legacy, false) and fid in ('account','stage','value','close','owner','next','follow','notes')) or
      fid = any(ids) or coalesce(typ, '') not in ('text','number','currency','date','choice') or
      coalesce(role_name, '') not in ('primary','owner','status','followup','none') then
      raise sqlstate 'PT400' using message = 'Invalid table field.';
    end if;
    name := pipechat.label(f->'name'); key := pipechat.name_key(name);
    if key = any(names) or key in ('__proto__','constructor','prototype','id','history','activity','health') then
      raise sqlstate 'PT400' using message = 'Duplicate or reserved field name.';
    end if;
    if role_name <> 'none' and role_name = any(roles) then
      raise sqlstate 'PT400' using message = 'Each table role can be assigned only once.';
    end if;
    if (role_name in ('primary','owner') and typ <> 'text') or
      (role_name = 'followup' and typ <> 'date' and not (coalesce(is_legacy, false) and fid = 'follow' and typ = 'text')) or
      (role_name = 'status' and typ not in ('text','choice')) then
      raise sqlstate 'PT400' using message = 'Field type does not match its role.';
    end if;
    if jsonb_typeof(f->'options') is distinct from 'array' then
      raise sqlstate 'PT400' using message = 'Invalid choice options.';
    end if;
    if jsonb_array_length(f->'options') > 30 or
      (typ = 'choice' and jsonb_array_length(f->'options') = 0) or
      (typ <> 'choice' and jsonb_array_length(f->'options') <> 0) then
      raise sqlstate 'PT400' using message = 'Invalid choice options.';
    end if;
    options := '[]'; option_keys := '{}';
    for opt in select value from jsonb_array_elements(f->'options') loop
      option_label := pipechat.label(opt, 80); key := pipechat.name_key(option_label);
      if key = any(option_keys) then raise sqlstate 'PT400' using message = 'Duplicate choice options.'; end if;
      option_keys := array_append(option_keys, key); options := options || jsonb_build_array(option_label);
    end loop;
    ids := array_append(ids, fid); names := array_append(names, pipechat.name_key(name)); roles := array_append(roles, role_name);
    fields := fields || jsonb_build_array(jsonb_build_object('id',fid,'name',name,'type',typ,'role',role_name,'options',options));
  end loop;
  if not ('primary' = any(roles)) then raise sqlstate 'PT400' using message = 'Choose one text field to identify records.'; end if;
  return jsonb_build_object('status','ready','useCase',p_schema->>'useCase','title',title,'recordLabel',record_label,
    'description',p_schema->>'description','fields',fields) || case when is_legacy then '{"legacy":true}'::jsonb else '{}'::jsonb end;
end
$$;

create function pipechat.validate_custom_fields(p_fields jsonb, p_schema jsonb) returns jsonb
language plpgsql immutable set search_path = pg_catalog as $$
declare
  f jsonb; fid text; name text; key text; ids text[] := '{}'; names text[] := '{}';
  reserved text[] := array['id','activity','health','history','__proto__','prototype','constructor'];
  result jsonb := '[]';
begin
  if jsonb_typeof(p_fields) is distinct from 'array' then raise sqlstate 'PT400' using message = 'Invalid custom field definitions.'; end if;
  if jsonb_array_length(p_fields) > 20 then raise sqlstate 'PT400' using message = 'A CRM supports up to 20 custom text fields.'; end if;
  if p_schema->>'status' = 'ready' then
    for f in select value from jsonb_array_elements(p_schema->'fields') loop
      ids := array_append(ids, f->>'id'); names := array_append(names, pipechat.name_key(f->>'name', true));
      reserved := array_append(reserved, f->>'id');
    end loop;
  else
    ids := array['account','stage','value','close','owner','next','follow','notes'];
    names := array['company','stage','value','close date','owner','next step','follow-up','notes'];
    reserved := reserved || ids || array['name','status','amount','close_date','next_step','follow_up','note','rep','salesperson'];
  end if;
  for f in select value from jsonb_array_elements(p_fields) loop
    fid := f->>'id';
    if jsonb_typeof(f) is distinct from 'object' or jsonb_typeof(f->'id') is distinct from 'string' or
      fid !~ '^cf_[a-z0-9_]{1,60}$' or fid = any(ids) or f->>'type' is distinct from 'text' then
      raise sqlstate 'PT400' using message = 'Invalid custom field definition.';
    end if;
    name := pipechat.label(f->'name'); key := pipechat.name_key(name, true);
    if key = any(names) or key = any(reserved) or
      (p_schema->>'status' <> 'ready' and regexp_replace(key, '[ -]+', '_', 'g') = any(reserved)) then
      raise sqlstate 'PT400' using message = 'Duplicate or reserved custom field name.';
    end if;
    ids := array_append(ids, fid); names := array_append(names, key);
    result := result || jsonb_build_array(jsonb_build_object('id',fid,'name',name,'type','text'));
  end loop;
  return result;
end
$$;

create function pipechat.validate_cell(p_field jsonb, p_value jsonb, p_legacy boolean) returns jsonb
language plpgsql immutable set search_path = pg_catalog as $$
declare
  typ text := p_field->>'type'; v text; n double precision; exact_number numeric; base integer; digit integer;
  parts text[]; year integer; month integer; day integer; parsed date; opt jsonb;
begin
  if p_value is null or p_value = 'null'::jsonb or p_value = '""'::jsonb then
    return case when typ in ('number','currency') then 'null'::jsonb else '""'::jsonb end;
  end if;
  if typ in ('number','currency') then
    if jsonb_typeof(p_value) not in ('number','string') then raise sqlstate 'PT400' using message = 'Invalid numeric cell.'; end if;
    v := pipechat.trim_text(p_value #>> '{}');
    if v ~ '^0[xX][0-9a-fA-F]+$' or v ~ '^0[bB][01]+$' or v ~ '^0[oO][0-7]+$' then
      base := case lower(substr(v,2,1)) when 'x' then 16 when 'b' then 2 else 8 end;
      exact_number := 0;
      for i in 3..length(v) loop
        digit := strpos('0123456789abcdef', lower(substr(v,i,1))) - 1;
        exact_number := exact_number * base + digit;
        if exact_number > 1e12 then raise sqlstate 'PT400' using message = 'Invalid numeric cell.'; end if;
      end loop;
    elsif v ~ '^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?$' then
      exact_number := v::numeric;
    else raise sqlstate 'PT400' using message = 'Invalid numeric cell.';
    end if;
    if abs(exact_number) > 1e12 then raise sqlstate 'PT400' using message = 'Invalid numeric cell.'; end if;
    -- PostgreSQL raises for floating-point underflow where JS Number returns zero.
    if abs(exact_number) < 2.4703282292062327e-324 then n := 0; else n := exact_number::double precision; end if;
    if p_legacy and p_field->>'id' = 'value' and n < 0 then raise sqlstate 'PT400' using message = 'Value must not be negative.'; end if;
    if typ = 'currency' then n := floor(n * 100 + 0.5) / 100; end if;
    return to_jsonb(n);
  end if;
  if jsonb_typeof(p_value) is distinct from 'string' or pipechat.js_length(p_value #>> '{}') > 12000 then
    raise sqlstate 'PT400' using message = 'Enter text of at most 12,000 characters.';
  end if;
  v := pipechat.trim_text(p_value #>> '{}');
  if typ = 'date' then
    parts := regexp_match(v, '^([0-9]{4})-([0-9]{2})-([0-9]{2})$');
    if parts is not null then
      year := parts[1]::integer; month := parts[2]::integer; day := parts[3]::integer;
      if year < 100 then raise sqlstate 'PT400' using message = 'Enter a complete, valid date.'; end if;
    else
      parts := regexp_match(v, '^(Jan(uary)?|Feb(ruary)?|Mar(ch)?|Apr(il)?|May|Jun(e)?|Jul(y)?|Aug(ust)?|Sep(tember)?|Oct(ober)?|Nov(ember)?|Dec(ember)?)[[:space:]]+([0-9]{1,2}),?[[:space:]]+([0-9]{4})$', 'i');
      if parts is null then raise sqlstate 'PT400' using message = 'Enter a complete, valid date.'; end if;
      month := (strpos('janfebmaraprmayjunjulaugsepoctnovdec', lower(substr(parts[1],1,3))) + 2) / 3;
      day := parts[13]::integer; year := parts[14]::integer;
      if year < 100 then year := year + 1900; end if;
    end if;
    parsed := make_date(year, month, day);
    return to_jsonb(to_char(parsed, 'YYYY-MM-DD'));
  elsif typ = 'choice' then
    for opt in select value from jsonb_array_elements(p_field->'options') loop
      if pipechat.name_key(opt #>> '{}', true) = pipechat.name_key(v, true) then return opt; end if;
    end loop;
    raise sqlstate 'PT400' using message = 'Choose one of this field''s options.';
  end if;
  return to_jsonb(v);
exception when invalid_text_representation or numeric_value_out_of_range or datetime_field_overflow then
  raise sqlstate 'PT400' using message = 'Invalid typed cell value.';
end
$$;

create function pipechat.require_user() returns uuid
language plpgsql security definer set search_path = pg_catalog as $$
declare uid uuid; sid uuid;
begin
  begin
    uid := auth.uid(); sid := (auth.jwt()->>'session_id')::uuid;
  exception when invalid_text_representation then
    raise sqlstate 'PT401' using message = 'Your session has expired. Please sign in again.';
  end;
  -- Supabase's documented sign-out revocation pattern, also binding session to user:
  -- https://supabase.com/docs/guides/auth/sessions#how-to-ensure-an-access-token-jwt-cannot-be-used-after-a-user-signs-out
  if uid is null or sid is null or not exists (select 1 from auth.sessions s where s.id = sid and s.user_id = uid) then
    raise sqlstate 'PT401' using message = 'Your session has expired. Please sign in again.';
  end if;
  return uid;
end
$$;
create function pipechat.workspace_for(p_user uuid) returns uuid
language plpgsql set search_path = pg_catalog as $$
declare wid uuid;
begin
  select m.workspace_id into wid from pipechat.memberships m where m.user_id = p_user;
  if wid is null then raise sqlstate 'PT401' using message = 'Workspace access is unavailable.'; end if;
  return wid;
end
$$;
create function pipechat.on_auth_user_created() returns trigger
language plpgsql security definer set search_path = pg_catalog as $$
declare wid uuid;
begin
  insert into pipechat.workspaces(owner_id) values (new.id) returning id into wid;
  insert into pipechat.memberships(workspace_id,user_id,role) values (wid,new.id,'owner');
  insert into pipechat.workspace_metadata(workspace_id) values (wid);
  insert into pipechat.usage_counters(user_id) values (new.id);
  return new;
end
$$;
create trigger pipechat_auth_user_created after insert on auth.users
for each row execute function pipechat.on_auth_user_created();

create function pipechat.crm_snapshot(p_workspace uuid) returns jsonb
language sql stable set search_path = pg_catalog as $$
  select jsonb_build_object(
    'deals', coalesce((select jsonb_agg(r.cells || jsonb_build_object('id',r.record_id,'history',r.history,'activity',r.activity,'health',r.health) order by r.position)
      from pipechat.crm_records r where r.workspace_id = w.id), '[]'::jsonb),
    'customFields', m.custom_fields, 'tableSchema', m.table_schema, 'updatedAt', pipechat.timestamp_text(w.updated_at))
  from pipechat.workspaces w join pipechat.workspace_metadata m on m.workspace_id = w.id where w.id = p_workspace
$$;

create function public.pipechat_health() returns jsonb
language plpgsql security definer set search_path = pg_catalog as $$
declare v integer;
begin
  select version into strict v from pipechat.schema_version where singleton;
  return jsonb_build_object('ok',true,'contract','pipechat-supabase-v1','database','ok','schemaVersion',v);
end
$$;
create function public.pipechat_read_crm() returns jsonb
language plpgsql security definer set search_path = pg_catalog as $$
declare uid uuid := pipechat.require_user(); wid uuid := pipechat.workspace_for(uid);
begin
  perform 1 from pipechat.workspaces where id = wid for share;
  return pipechat.crm_snapshot(wid);
end
$$;
create function public.pipechat_write_crm(p_deals jsonb, p_custom_fields jsonb, p_table_schema jsonb, p_expected_updated_at text) returns jsonb
language plpgsql security definer set search_path = pg_catalog as $$
declare
  uid uuid := pipechat.require_user(); wid uuid := pipechat.workspace_for(uid);
  version timestamptz; before_schema jsonb; before_custom jsonb; next_schema jsonb; next_custom jsonb;
  defs jsonb; f jsonb; old_field jsonb; row_value jsonb; cells jsonb; key text; result jsonb;
  ids bigint[] := '{}'; rid bigint; raw_id numeric; pos integer := 0;
begin
  -- RPC callers can bypass Node. Bound both raw input and canonical output;
  -- jsonb's serialized whitespace makes this slightly conservative vs JS JSON.
  if octet_length(jsonb_build_object('deals',p_deals,'customFields',p_custom_fields,
    'tableSchema',p_table_schema,'updatedAt',p_expected_updated_at)::text) > 16777216 then
    raise sqlstate 'PT400' using message = 'The CRM snapshot exceeds 16 MiB.';
  end if;
  if p_expected_updated_at is not null and (pipechat.js_length(p_expected_updated_at) > 256 or p_expected_updated_at ~ U&'[\0001-\001f\007f]') then
    raise sqlstate 'PT400' using message = 'Invalid CRM version.';
  end if;
  select updated_at into version from pipechat.workspaces where id = wid for update;
  if p_expected_updated_at is distinct from pipechat.timestamp_text(version) then
    raise sqlstate 'PT409' using message = 'This CRM changed in another window. Refresh before saving.';
  end if;
  if jsonb_typeof(p_deals) is distinct from 'array' then raise sqlstate 'PT400' using message = 'Invalid CRM records.'; end if;
  if jsonb_array_length(p_deals) > 2000 then raise sqlstate 'PT400' using message = 'A CRM supports up to 2,000 records.'; end if;
  next_schema := pipechat.validate_schema(p_table_schema);
  next_custom := pipechat.validate_custom_fields(p_custom_fields, next_schema);
  select table_schema, custom_fields into before_schema, before_custom from pipechat.workspace_metadata where workspace_id = wid;
  if before_schema->>'status' = 'ready' and next_schema->>'status' <> 'ready' then
    raise sqlstate 'PT400' using message = 'A configured table cannot return to setup.';
  end if;
  if before_schema->>'status' = 'pending' and jsonb_array_length(p_deals) <> 0 then
    raise sqlstate 'PT400' using message = 'Create the empty table before adding records.';
  end if;
  defs := coalesce(next_schema->'fields', '[]'::jsonb) || next_custom;
  for f in select value from jsonb_array_elements(defs) loop
    select value into old_field from jsonb_array_elements(coalesce(before_schema->'fields','[]'::jsonb) || before_custom) where value->>'id' = f->>'id';
    if old_field is not null and old_field->>'type' <> f->>'type' then
      raise sqlstate 'PT400' using message = 'Changing an existing field type is not supported.';
    end if;
  end loop;
  -- Replace individual rows under the workspace lock; any validation failure
  -- rolls back metadata, rows and version together, including partial inserts.
  delete from pipechat.crm_records where workspace_id = wid;
  for row_value in select value from jsonb_array_elements(p_deals) loop
    if jsonb_typeof(row_value) is distinct from 'object' or jsonb_typeof(row_value->'id') is distinct from 'number' then
      raise sqlstate 'PT400' using message = 'Invalid record ID.';
    end if;
    raw_id := (row_value->>'id')::numeric;
    if raw_id < 1 or raw_id > 9007199254740991 or raw_id <> trunc(raw_id) then raise sqlstate 'PT400' using message = 'Invalid record ID.'; end if;
    rid := raw_id::bigint;
    if rid = any(ids) then raise sqlstate 'PT400' using message = 'Duplicate record ID.'; end if;
    ids := array_append(ids, rid);
    for key in select jsonb_object_keys(row_value) loop
      if (left(key,2) = 'f_' or left(key,3) = 'cf_') and not exists (select 1 from jsonb_array_elements(defs) where value->>'id' = key) then
        raise sqlstate 'PT400' using message = 'Unknown table field. Refresh before saving.';
      end if;
    end loop;
    cells := '{}';
    for f in select value from jsonb_array_elements(defs) loop
      cells := cells || jsonb_build_object(f->>'id', pipechat.validate_cell(f, row_value->(f->>'id'), coalesce(next_schema->'legacy' = 'true'::jsonb, false)));
    end loop;
    if jsonb_typeof(row_value->'history') is distinct from 'array' then raise sqlstate 'PT400' using message = 'Invalid record history.'; end if;
    -- A change message can contain two 12,000-character cells plus actor/label.
    -- Keep enough room for complete app-generated messages; reject, never truncate.
    if jsonb_array_length(row_value->'history') > 10000 or exists (
      select 1 from jsonb_array_elements(row_value->'history')
      where jsonb_typeof(value) <> 'string' or pipechat.js_length(value #>> '{}') > 32768) then
      raise sqlstate 'PT400' using message = 'Invalid record history.';
    end if;
    if (jsonb_typeof(row_value->'activity') = 'string' and pipechat.js_length(row_value->>'activity') > 12000) or
      (jsonb_typeof(row_value->'health') = 'string' and pipechat.js_length(row_value->>'health') > 12000) then
      raise sqlstate 'PT400' using message = 'Record activity text is too long.';
    end if;
    insert into pipechat.crm_records(workspace_id,record_id,position,cells,history,activity,health)
    values (wid,rid,pos,cells,row_value->'history',
      case when jsonb_typeof(row_value->'activity') = 'string' then row_value->>'activity' else '' end,
      case when jsonb_typeof(row_value->'health') = 'string' then row_value->>'health' else '' end);
    pos := pos + 1;
  end loop;
  update pipechat.workspace_metadata set table_schema = next_schema, custom_fields = next_custom where workspace_id = wid;
  update pipechat.workspaces set updated_at = greatest(clock_timestamp(), version + interval '1 microsecond') where id = wid;
  result := pipechat.crm_snapshot(wid);
  if octet_length(result::text) > 16777216 then
    raise sqlstate 'PT400' using message = 'The CRM snapshot exceeds 16 MiB.';
  end if;
  return result;
end
$$;

-- Caller must hold the user's counter lock for expiry, snapshots and transitions.
create function pipechat.expire_usage(p_user uuid, p_now timestamptz) returns void
language plpgsql set search_path = pg_catalog as $$
declare expired_count bigint;
begin
  update pipechat.usage_reservations set state = 'expired', finished_at = p_now
    where user_id = p_user and state = 'reserved' and expires_at <= p_now;
  get diagnostics expired_count = row_count;
  if expired_count > 0 then
    update pipechat.usage_counters set reserved = reserved - expired_count, updated_at = greatest(p_now, updated_at + interval '1 microsecond') where user_id = p_user;
  end if;
end
$$;
create function pipechat.usage_snapshot(p_user uuid) returns jsonb
language sql stable set search_path = pg_catalog as $$
  select jsonb_build_object('used',used,'limit',quota_limit,'reserved',reserved,
    'remaining',greatest(quota_limit-used-reserved,0),'paymentRequired',quota_limit-used-reserved <= 0,
    'updatedAt',pipechat.timestamp_text(updated_at)) from pipechat.usage_counters where user_id = p_user
$$;
create function pipechat.lock_usage(p_user uuid) returns void
language plpgsql set search_path = pg_catalog as $$
begin
  perform 1 from pipechat.usage_counters where user_id = p_user for update;
  if not found then raise sqlstate 'PT401' using message = 'Usage account is unavailable.'; end if;
end
$$;
create function public.pipechat_read_usage() returns jsonb
language plpgsql security definer set search_path = pg_catalog as $$
declare uid uuid := pipechat.require_user();
begin
  perform pipechat.lock_usage(uid);
  perform pipechat.expire_usage(uid, clock_timestamp());
  return pipechat.usage_snapshot(uid);
end
$$;
create function public.pipechat_reserve_usage(p_request_id uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog as $$
declare uid uuid := pipechat.require_user(); reservation pipechat.usage_reservations%rowtype; meter jsonb; now_at timestamptz;
begin
  if p_request_id is null then raise sqlstate 'PT400' using message = 'A request ID is required.'; end if;
  perform pipechat.lock_usage(uid);
  now_at := clock_timestamp();
  perform pipechat.expire_usage(uid, now_at);
  select * into reservation from pipechat.usage_reservations where user_id = uid and request_id = p_request_id;
  if found then
    if reservation.state <> 'reserved' then raise sqlstate 'PT409' using message = 'This usage request is no longer available.'; end if;
    return jsonb_build_object('reservationId',reservation.id,'usage',pipechat.usage_snapshot(uid));
  end if;
  meter := pipechat.usage_snapshot(uid);
  if (meter->>'remaining')::bigint = 0 then
    raise sqlstate 'PT402' using message = 'Free chatbot usage limit reached. Manual CRM editing is still available.', detail = meter::text;
  end if;
  insert into pipechat.usage_reservations(user_id,request_id,created_at,expires_at)
    values (uid,p_request_id,now_at,now_at + interval '5 minutes') returning * into reservation;
  update pipechat.usage_counters set reserved = reserved + 1, updated_at = greatest(now_at,updated_at + interval '1 microsecond') where user_id = uid;
  return jsonb_build_object('reservationId',reservation.id,'usage',pipechat.usage_snapshot(uid));
end
$$;
create function public.pipechat_finish_usage(p_reservation_id uuid, p_outcome text) returns jsonb
language plpgsql security definer set search_path = pg_catalog as $$
declare uid uuid := pipechat.require_user(); reservation pipechat.usage_reservations%rowtype; now_at timestamptz;
begin
  if p_reservation_id is null or p_outcome is null or p_outcome not in ('commit','release') then
    raise sqlstate 'PT400' using message = 'Invalid reservation or outcome.';
  end if;
  perform pipechat.lock_usage(uid);
  now_at := clock_timestamp();
  perform pipechat.expire_usage(uid, now_at);
  select * into reservation from pipechat.usage_reservations where id = p_reservation_id and user_id = uid;
  if not found then raise sqlstate 'PT409' using message = 'This usage reservation is no longer available.'; end if;
  if reservation.state = p_outcome or (reservation.state = 'expired' and p_outcome = 'release') then return pipechat.usage_snapshot(uid); end if;
  if reservation.state <> 'reserved' then raise sqlstate 'PT409' using message = 'This usage reservation is no longer available.'; end if;
  update pipechat.usage_reservations set state = p_outcome, finished_at = now_at where id = reservation.id;
  update pipechat.usage_counters set reserved = reserved - 1, used = used + case when p_outcome = 'commit' then 1 else 0 end,
    updated_at = greatest(now_at,updated_at + interval '1 microsecond') where user_id = uid;
  return pipechat.usage_snapshot(uid);
end
$$;

revoke all on all tables in schema pipechat from public, anon, authenticated, service_role;
revoke all on all sequences in schema pipechat from public, anon, authenticated, service_role;
revoke all on all functions in schema pipechat from public, anon, authenticated, service_role;
-- Revoke explicitly before grants, including installations with Supabase default ACLs.
revoke all on function public.pipechat_health() from public, anon, authenticated, service_role;
revoke all on function public.pipechat_read_crm() from public, anon, authenticated, service_role;
revoke all on function public.pipechat_write_crm(jsonb,jsonb,jsonb,text) from public, anon, authenticated, service_role;
revoke all on function public.pipechat_read_usage() from public, anon, authenticated, service_role;
revoke all on function public.pipechat_reserve_usage(uuid) from public, anon, authenticated, service_role;
revoke all on function public.pipechat_finish_usage(uuid,text) from public, anon, authenticated, service_role;
grant usage on schema public to anon, authenticated;
grant execute on function public.pipechat_health() to anon, authenticated;
grant execute on function public.pipechat_read_crm() to authenticated;
grant execute on function public.pipechat_write_crm(jsonb,jsonb,jsonb,text) to authenticated;
grant execute on function public.pipechat_read_usage() to authenticated;
grant execute on function public.pipechat_reserve_usage(uuid) to authenticated;
grant execute on function public.pipechat_finish_usage(uuid,text) to authenticated;

commit;
