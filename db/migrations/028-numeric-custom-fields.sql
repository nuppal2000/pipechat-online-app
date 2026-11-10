begin;
-- Preserve the current name, option and primary-order checks; numeric cells use validate_cell.
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
      fid !~ '^cf_[a-z0-9_]{1,60}$' or fid = any(ids) or coalesce(f->>'type','') not in ('text','choice','date','number') then
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
