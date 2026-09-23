-- Spreadsheet setup preserves source headers/text and commits schema plus rows atomically.
-- Existing tables are not modified. CREATE OR REPLACE preserves current function grants.
begin;
create or replace function pipechat.validate_schema(p_schema jsonb) returns jsonb
language plpgsql immutable set search_path = pg_catalog as $$
declare
  f jsonb; opt jsonb; name text; key text; title text; record_label text;
  fid text; typ text; role_name text; option_label text;
  ids text[] := '{}'; names text[] := '{}'; roles text[] := '{}'; option_keys text[];
  fields jsonb := '[]'; options jsonb; is_legacy boolean := p_schema->'legacy' = 'true'::jsonb;
  spreadsheet boolean := coalesce(p_schema->>'source' = 'spreadsheet', false);
begin
  if jsonb_typeof(p_schema) is distinct from 'object' then
    raise sqlstate 'PT400' using message = 'Invalid workspace setup.';
  end if;
  if p_schema->>'status' = 'pending' then return '{"status":"pending"}'; end if;
  if p_schema->>'status' is distinct from 'ready' or
    coalesce(p_schema->>'useCase', '') not in ('Sales', 'Recruiting', 'Real Estate', 'Other') then
    raise sqlstate 'PT400' using message = 'Invalid workspace setup.';
  end if;
  if spreadsheet and is_legacy then raise sqlstate 'PT400' using message = 'Invalid spreadsheet workspace.'; end if;
  title := pipechat.label(p_schema->'title');
  record_label := pipechat.label(p_schema->'recordLabel');
  if jsonb_typeof(p_schema->'description') is distinct from 'string' or pipechat.js_length(p_schema->>'description') > 2000 then
    raise sqlstate 'PT400' using message = 'Workflow description must be at most 2,000 characters.';
  end if;
  if jsonb_typeof(p_schema->'fields') is distinct from 'array' then
    raise sqlstate 'PT400' using message = 'Invalid table fields.';
  end if;
  if jsonb_array_length(p_schema->'fields') not between 1 and (case when spreadsheet then 100 else 30 end) then
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
    if spreadsheet then
      if jsonb_typeof(f->'name') is distinct from 'string' or pipechat.js_length(f->>'name') > 300 or (f->>'name') ~ U&'[\0001-\0008\000b\000c\000e-\001f\007f]' then
        raise sqlstate 'PT400' using message = 'Invalid spreadsheet header.';
      end if;
      name := f->>'name';
    else name := pipechat.label(f->'name'); end if;
    key := pipechat.name_key(name);
    if not spreadsheet and (key = any(names) or key in ('__proto__','constructor','prototype','id','history','activity','health')) then
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
    'description',p_schema->>'description','fields',fields) || case when is_legacy then '{"legacy":true}'::jsonb else '{}'::jsonb end || case when spreadsheet then '{"source":"spreadsheet"}'::jsonb else '{}'::jsonb end;
end
$$;

create or replace function pipechat.validate_cell(p_field jsonb, p_value jsonb, p_legacy boolean) returns jsonb
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
  return case when p_field->>'preserveText' = 'true' then p_value else to_jsonb(v) end;
exception when invalid_text_representation or numeric_value_out_of_range or datetime_field_overflow then
  raise sqlstate 'PT400' using message = 'Invalid typed cell value.';
end
$$;

create or replace function public.pipechat_write_crm(p_deals jsonb, p_custom_fields jsonb, p_table_schema jsonb, p_expected_updated_at text) returns jsonb
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
  if before_schema->>'status' = 'pending' and jsonb_array_length(p_deals) <> 0 and (next_schema->>'source' is distinct from 'spreadsheet') then
    raise sqlstate 'PT400' using message = 'Create the empty table before adding records.';
  end if;
  if before_schema->>'status' = 'ready' and (before_schema->>'source') is distinct from (next_schema->>'source') then
    raise sqlstate 'PT400' using message = 'The table source cannot change after setup.';
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
      cells := cells || jsonb_build_object(f->>'id', pipechat.validate_cell(f || jsonb_build_object('preserveText', coalesce(next_schema->>'source' = 'spreadsheet', false)), row_value->(f->>'id'), coalesce(next_schema->'legacy' = 'true'::jsonb, false)));
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
notify pgrst, 'reload schema';
commit;

