-- The first explicitly ordered column identifies records, independently of semantic roles.
-- No rows or existing metadata are rewritten. Keep existing RPC privileges.
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
  if p_schema ? 'hiddenKpis' then
    if jsonb_typeof(p_schema->'hiddenKpis') is distinct from 'array' then raise sqlstate 'PT400' using message = 'Invalid hidden dashboard KPIs.'; end if;
    if jsonb_array_length(p_schema->'hiddenKpis') > 120 or exists (
      select 1 from jsonb_array_elements(p_schema->'hiddenKpis') where jsonb_typeof(value) <> 'string' or (value #>> '{}') !~ '^kpi_[a-z0-9_]{1,100}$'
    ) or (select count(*) <> count(distinct value) from jsonb_array_elements(p_schema->'hiddenKpis')) then
      raise sqlstate 'PT400' using message = 'Invalid hidden dashboard KPIs.';
    end if;
  end if;
  if p_schema ? 'columnOrder' then
    if jsonb_typeof(p_schema->'columnOrder') is distinct from 'array' then raise sqlstate 'PT400' using message = 'Invalid column order.'; end if;
    if jsonb_array_length(p_schema->'columnOrder') > 120 or exists (
      select 1 from jsonb_array_elements(p_schema->'columnOrder') where jsonb_typeof(value) <> 'string' or (value #>> '{}') !~ '^[a-z][a-z0-9_]{0,64}$'
    ) or (select count(*) <> count(distinct value) from jsonb_array_elements(p_schema->'columnOrder')) then
      raise sqlstate 'PT400' using message = 'Invalid column order.';
    end if;
  end if;
  if not ('primary' = any(roles)) and coalesce(jsonb_array_length(p_schema->'columnOrder'),0) = 0 then raise sqlstate 'PT400' using message = 'Choose one field to identify records.'; end if;
  return jsonb_build_object('status','ready','useCase',p_schema->>'useCase','title',title,'recordLabel',record_label,
    'description',p_schema->>'description','fields',fields) || case when is_legacy then '{"legacy":true}'::jsonb else '{}'::jsonb end || case when spreadsheet then '{"source":"spreadsheet"}'::jsonb else '{}'::jsonb end || case when p_schema ? 'kpis' then jsonb_build_object('kpis',pipechat.validate_kpis(p_schema->'kpis')) else '{}'::jsonb end || case when p_schema ? 'hiddenKpis' then jsonb_build_object('hiddenKpis',p_schema->'hiddenKpis') else '{}'::jsonb end || case when p_schema ? 'columnOrder' then jsonb_build_object('columnOrder',p_schema->'columnOrder') else '{}'::jsonb end;
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
  if jsonb_array_length(p_fields) > 20 then raise sqlstate 'PT400' using message = 'A CRM supports up to 20 custom fields.'; end if;
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
      fid !~ '^cf_[a-z0-9_]{1,60}$' or fid = any(ids) or coalesce(f->>'type','') not in ('text','choice','date') then
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
    else result := result || jsonb_build_array(jsonb_build_object('id',fid,'name',name,'type',f->>'type')); end if;
  end loop;
  if coalesce(jsonb_array_length(p_schema->'columnOrder'),0) > 0 and not exists (
    select 1 from jsonb_array_elements(coalesce(p_schema->'fields','[]'::jsonb) || result)
    where value->>'id' = p_schema->'columnOrder'->>0
  ) then raise sqlstate 'PT400' using message = 'The first column no longer exists.'; end if;
  return result;
end
$$;

notify pgrst, 'reload schema';
commit;
