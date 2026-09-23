-- Preserve explicit removals of generated KPI cards. No account data writes.
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
  if not ('primary' = any(roles)) then raise sqlstate 'PT400' using message = 'Choose one text field to identify records.'; end if;
  return jsonb_build_object('status','ready','useCase',p_schema->>'useCase','title',title,'recordLabel',record_label,
    'description',p_schema->>'description','fields',fields) || case when is_legacy then '{"legacy":true}'::jsonb else '{}'::jsonb end || case when spreadsheet then '{"source":"spreadsheet"}'::jsonb else '{}'::jsonb end || case when p_schema ? 'kpis' then jsonb_build_object('kpis',pipechat.validate_kpis(p_schema->'kpis')) else '{}'::jsonb end || case when p_schema ? 'hiddenKpis' then jsonb_build_object('hiddenKpis',p_schema->'hiddenKpis') else '{}'::jsonb end;
end
$$;
notify pgrst, 'reload schema';
commit;
