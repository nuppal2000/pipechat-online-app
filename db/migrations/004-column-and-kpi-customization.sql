-- Adds validated KPI metadata and choice conversions. No account data is changed.
begin;
create or replace function pipechat.validate_kpis(p_kpis jsonb, p_defs jsonb default null) returns jsonb
language plpgsql immutable set search_path = pg_catalog as $$
declare
  k jsonb; c jsonb; f jsonb; result jsonb := '[]'; conditions jsonb; ids text[] := '{}';
  kid text; title text; metric text; fid text; op text; v jsonb; typ text;
begin
  if jsonb_typeof(p_kpis) is distinct from 'array' then raise sqlstate 'PT400' using message = 'Invalid dashboard KPIs.'; end if;
  if jsonb_array_length(p_kpis) > 120 then raise sqlstate 'PT400' using message = 'Too many dashboard KPIs.'; end if;
  for k in select value from jsonb_array_elements(p_kpis) loop
    kid := k->>'id'; metric := k->>'metric'; fid := k->>'field';
    if jsonb_typeof(k) is distinct from 'object' or jsonb_typeof(k->'id') is distinct from 'string' or kid !~ '^kpi_[a-z0-9_]{1,100}$' or kid = any(ids) or coalesce(metric,'') not in ('count','sum','average') or
      not (k->'field' = 'null'::jsonb or jsonb_typeof(k->'field') = 'string' and fid ~ '^[a-z][a-z0-9_]{0,64}$') or not (k ? 'field') then
      raise sqlstate 'PT400' using message = 'Invalid dashboard KPI.';
    end if;
    title := pipechat.label(k->'title',120); ids := array_append(ids,kid);
    if p_defs is not null then
      select value into f from jsonb_array_elements(p_defs) where value->>'id' = fid;
      if metric = 'count' and fid is not null or metric <> 'count' and coalesce(f->>'type','') not in ('number','currency') then
        raise sqlstate 'PT400' using message = 'Invalid KPI numeric field.';
      end if;
    end if;
    if jsonb_typeof(k->'conditions') is distinct from 'array' then raise sqlstate 'PT400' using message = 'Invalid KPI conditions.'; end if;
    if jsonb_array_length(k->'conditions') > 10 then raise sqlstate 'PT400' using message = 'Too many KPI conditions.'; end if;
    conditions := '[]';
    for c in select value from jsonb_array_elements(k->'conditions') loop
      fid := c->>'field'; op := c->>'operator'; v := c->'value';
      if jsonb_typeof(c) is distinct from 'object' or jsonb_typeof(c->'field') is distinct from 'string' or fid !~ '^[a-z][a-z0-9_]{0,64}$' or coalesce(op,'') not in ('equals','not_equals','is_blank','is_not_blank','gt','gte','lt','lte','before_today','older_than_days') or
        coalesce(jsonb_typeof(v),'') not in ('null','string','number') then raise sqlstate 'PT400' using message = 'Invalid KPI condition.'; end if;
      if jsonb_typeof(v) = 'string' and pipechat.js_length(v #>> '{}') > 12000 or jsonb_typeof(v) = 'number' and abs((v #>> '{}')::numeric) > 1e12 then raise sqlstate 'PT400' using message = 'Invalid KPI condition value.'; end if;
      if p_defs is not null then
        select value into f from jsonb_array_elements(p_defs) where value->>'id' = fid;
        if f is null then raise sqlstate 'PT400' using message = 'A KPI references a missing column.'; end if;
        typ := f->>'type';
        if op in ('is_blank','is_not_blank') then
          if v <> 'null'::jsonb then raise sqlstate 'PT400' using message = 'Blank checks need no value.'; end if;
        elsif op in ('before_today','older_than_days') then
          if typ <> 'date' and not (f->>'role' = 'followup' and typ = 'text') then raise sqlstate 'PT400' using message = 'Stale-date conditions need a date column.'; end if;
          if op = 'before_today' and v <> 'null'::jsonb then raise sqlstate 'PT400' using message = 'Invalid date cutoff.'; end if;
          if op = 'older_than_days' then
            if jsonb_typeof(v) <> 'number' then raise sqlstate 'PT400' using message = 'Invalid stale days.'; end if;
            if (v #>> '{}')::numeric not between 0 and 36500 or (v #>> '{}')::numeric <> trunc((v #>> '{}')::numeric) then raise sqlstate 'PT400' using message = 'Invalid stale days.'; end if;
          end if;
        elsif op in ('gt','gte','lt','lte') then
          if typ = 'date' then
            if v in ('null'::jsonb,'""'::jsonb) then raise sqlstate 'PT400' using message = 'Invalid date comparison.'; end if;
            perform pipechat.validate_cell(f,v,false);
          elsif typ not in ('number','currency') or jsonb_typeof(v) <> 'number' then raise sqlstate 'PT400' using message = 'Invalid KPI comparison.';
          end if;
        elsif v = 'null'::jsonb then raise sqlstate 'PT400' using message = 'Specify a KPI comparison value.';
        end if;
      end if;
      conditions := conditions || jsonb_build_array(jsonb_build_object('field',fid,'operator',op,'value',v));
    end loop;
    result := result || jsonb_build_array(jsonb_build_object('id',kid,'title',title,'metric',metric,'field',k->'field','conditions',conditions));
  end loop;
  return result;
end
$$;
revoke all on function pipechat.validate_kpis(jsonb,jsonb) from public,anon,authenticated,service_role;

-- Replaced validators below.
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
    if (role_name in ('primary','owner') and typ not in ('text','choice')) or
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
    'description',p_schema->>'description','fields',fields) || case when is_legacy then '{"legacy":true}'::jsonb else '{}'::jsonb end || case when spreadsheet then '{"source":"spreadsheet"}'::jsonb else '{}'::jsonb end || case when p_schema ? 'kpis' then jsonb_build_object('kpis',pipechat.validate_kpis(p_schema->'kpis')) else '{}'::jsonb end;
end
$$;

create or replace function pipechat.validate_custom_fields(p_fields jsonb, p_schema jsonb) returns jsonb
language plpgsql immutable set search_path = pg_catalog as $$
declare
  f jsonb; fid text; name text; key text; ids text[] := '{}'; names text[] := '{}';
  reserved text[] := array['id','activity','health','history','__proto__','prototype','constructor'];
  result jsonb := '[]'; opt jsonb; options jsonb; option_keys text[]; option_name text;
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
      fid !~ '^cf_[a-z0-9_]{1,60}$' or fid = any(ids) or coalesce(f->>'type','') not in ('text','choice') then
      raise sqlstate 'PT400' using message = 'Invalid custom field definition.';
    end if;
    name := pipechat.label(f->'name'); key := pipechat.name_key(name, true);
    if key = any(names) or key = any(reserved) or
      (p_schema->>'status' <> 'ready' and regexp_replace(key, '[ -]+', '_', 'g') = any(reserved)) then
      raise sqlstate 'PT400' using message = 'Duplicate or reserved custom field name.';
    end if;
    ids := array_append(ids, fid); names := array_append(names, key);
    if f->>'type' = 'choice' then
      if jsonb_typeof(f->'options') is distinct from 'array' then raise sqlstate 'PT400' using message = 'Invalid dropdown options.'; end if;
      if jsonb_array_length(f->'options') not between 1 and 30 then raise sqlstate 'PT400' using message = 'Invalid dropdown options.'; end if;
      options := '[]'; option_keys := '{}';
      for opt in select value from jsonb_array_elements(f->'options') loop
        option_name := pipechat.label(opt,80); key := pipechat.name_key(option_name,true);
        if key = any(option_keys) then raise sqlstate 'PT400' using message = 'Duplicate dropdown option.'; end if;
        option_keys := array_append(option_keys,key); options := options || jsonb_build_array(option_name);
      end loop;
      result := result || jsonb_build_array(jsonb_build_object('id',fid,'name',name,'type','choice','options',options));
    else result := result || jsonb_build_array(jsonb_build_object('id',fid,'name',name,'type','text')); end if;
  end loop;
  return result;
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
  perform pipechat.validate_kpis(coalesce(next_schema->'kpis','[]'::jsonb),defs);
  for f in select value from jsonb_array_elements(defs) loop
    select value into old_field from jsonb_array_elements(coalesce(before_schema->'fields','[]'::jsonb) || before_custom) where value->>'id' = f->>'id';
    if old_field is not null and old_field->>'type' <> f->>'type' and old_field->>'type' <> 'choice' and f->>'type' <> 'choice' then
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
