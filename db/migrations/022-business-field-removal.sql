-- Explicit, isolated removal of unused optional entity fields.
-- Existing CAS ownership, versions, grant handling and transactional audit stay intact.
begin;
create function pipechat.business_assert_field_removal(p_before jsonb, p_after jsonb) returns void
language plpgsql set search_path = pg_catalog as $$
declare
  old_type jsonb; after_type jsonb; identity_id text; removed_ids text[];
  projected jsonb := p_before; has_removal boolean := false;
begin
  for old_type in select value from jsonb_array_elements(p_before->'entityTypes') loop
    select value into after_type from jsonb_array_elements(p_after->'entityTypes')
      where value->>'id'=old_type->>'id';
    if after_type is null then continue; end if;
    select coalesce(array_agg(f->>'id'),'{}') into removed_ids
      from jsonb_array_elements(old_type->'fields') f
      where not exists (select 1 from jsonb_array_elements(after_type->'fields') n where n->>'id'=f->>'id');
    if cardinality(removed_ids)=0 then continue; end if;
    has_removal := true;
    select f->>'id' into identity_id
      from jsonb_array_elements(old_type->'fields') with ordinality fields(f,position)
      order by case when f->>'type'='text' and f->'required'='true'::jsonb then 0
        when f->>'type'='text' then 1 else 2 end,position limit 1;
    if identity_id=any(removed_ids) or exists (select 1 from jsonb_array_elements(old_type->'fields') f
      where f->>'id'=any(removed_ids) and f->'required'='true'::jsonb) then
      raise sqlstate 'PT400' using message = 'Identifying and required entity fields cannot be removed.';
    end if;
    -- Match JavaScript trim blank semantics; zero and false are stored dependencies.
    if exists (
      select 1 from jsonb_array_elements(p_before->'entities') e
      cross join unnest(removed_ids) field_id
      where e->>'typeId'=old_type->>'id' and e->'values' ? field_id
        and e->'values'->field_id <> 'null'::jsonb
        and not (jsonb_typeof(e->'values'->field_id)='string' and
          btrim(e->'values'->>field_id,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')='')
    ) then
      raise sqlstate 'PT400' using message = 'Entity field still has stored values. No field or value was removed.';
    end if;
    projected := jsonb_set(projected,'{entityTypes}',(
      select jsonb_agg(case when t->>'id'=old_type->>'id' then jsonb_set(t,'{fields}',
        coalesce((select jsonb_agg(f order by ordinal) from jsonb_array_elements(t->'fields') with ordinality fields(f,ordinal)
          where not (f->>'id'=any(removed_ids))),'[]'::jsonb)) else t end order by position)
      from jsonb_array_elements(projected->'entityTypes') with ordinality types(t,position)));
    projected := jsonb_set(projected,'{entities}',coalesce((
      select jsonb_agg(case when e->>'typeId'=old_type->>'id' then
        jsonb_set(e,'{values}',(e->'values')-removed_ids) else e end order by position)
      from jsonb_array_elements(projected->'entities') with ordinality entities(e,position)),'[]'::jsonb));
  end loop;
  if has_removal and projected is distinct from p_after then
    raise sqlstate 'PT400' using message = 'Field removal must preserve all unrelated schema, entities, values, relationships and views.';
  end if;
end $$;
revoke all on function pipechat.business_assert_field_removal(jsonb,jsonb) from public,anon,authenticated,service_role;

create or replace function pipechat.business_validate(p_workspace uuid, p_state jsonb, p_before jsonb) returns void
language plpgsql set search_path = pg_catalog as $$
declare
  k text; v jsonb; f jsonb; e jsonb; r jsonb; old jsonb; after_item jsonb; cell jsonb;
  defs jsonb := '{}'; relations jsonb := '{}'; refs jsonb; typ text; fid text; ids text[]; n numeric;
begin
  if octet_length(p_state::text) > 8388608 then raise sqlstate 'PT400' using message = 'Business state exceeds 8 MiB.'; end if;
  perform pipechat.business_object(p_state,array['formatVersion','primary','entityTypes','relationshipTypes','entities','relationships','views']);
  if p_state->'formatVersion' is distinct from '1'::jsonb or
    p_state->'primary' is distinct from '{"typeId":"primary","source":"crm_records"}'::jsonb then
    raise sqlstate 'PT400' using message = 'Unsupported business workspace format.';
  end if;
  foreach k in array array['entityTypes','relationshipTypes','entities','relationships','views'] loop
    if jsonb_typeof(p_state->k) is distinct from 'array' then raise sqlstate 'PT400' using message = 'Invalid business collection.'; end if;
    if jsonb_array_length(p_state->k) > (case k when 'entityTypes' then 40 when 'relationshipTypes' then 80
      when 'entities' then 5000 when 'relationships' then 10000 else 100 end) or
      exists (select 1 from jsonb_array_elements(p_state->k) x group by x->>'id' having count(*) > 1) then
      raise sqlstate 'PT400' using message = 'Duplicate ID or business collection limit exceeded.';
    end if;
  end loop;
  for v in select value from jsonb_array_elements(p_state->'entityTypes') loop
    perform pipechat.business_object(v,array['id','name','fields']);
    typ := pipechat.business_id(v->'id'); perform pipechat.label(v->'name',120);
    if jsonb_typeof(v->'fields') is distinct from 'array' then raise sqlstate 'PT400' using message = 'Invalid entity fields.'; end if;
    if jsonb_array_length(v->'fields') > 40 then raise sqlstate 'PT400' using message = 'Too many entity fields.'; end if;
    ids := '{}';
    for f in select value from jsonb_array_elements(v->'fields') loop
      perform pipechat.business_object(f,array['id','name','type','required','options']);
      fid := pipechat.business_id(f->'id'); perform pipechat.label(f->'name',120);
      if fid = any(ids) or coalesce(f->>'type','') not in ('text','number','boolean','date','choice') or
        jsonb_typeof(f->'required') is distinct from 'boolean' or jsonb_typeof(f->'options') is distinct from 'array' then
        raise sqlstate 'PT400' using message = 'Invalid entity field.';
      end if;
      ids := array_append(ids,fid);
      if jsonb_array_length(f->'options') > 100 or ((f->>'type' = 'choice') <> (jsonb_array_length(f->'options') > 0)) or
        exists (select 1 from jsonb_array_elements(f->'options') x group by x having count(*) > 1) then
        raise sqlstate 'PT400' using message = 'Invalid choice options.';
      end if;
      for cell in select value from jsonb_array_elements(f->'options') loop perform pipechat.label(cell,120); end loop;
    end loop;
    defs := defs || jsonb_build_object(typ,v);
  end loop;
  for e in select value from jsonb_array_elements(p_state->'entities') loop
    perform pipechat.business_object(e,array['id','typeId','values']); perform pipechat.business_id(e->'id','ent');
    typ := pipechat.business_id(e->'typeId');
    if not (defs ? typ) or jsonb_typeof(e->'values') is distinct from 'object' then raise sqlstate 'PT400' using message = 'Unknown entity type or invalid values.'; end if;
    if exists (select 1 from jsonb_object_keys(e->'values') key where not exists (
      select 1 from jsonb_array_elements(defs->typ->'fields') field where field->>'id' = key)) then
      raise sqlstate 'PT400' using message = 'Unknown entity field.';
    end if;
    for f in select value from jsonb_array_elements(defs->typ->'fields') loop
      cell := e->'values'->(f->>'id');
      if cell is null or cell in ('null'::jsonb,'""'::jsonb) then
        if f->'required' = 'true'::jsonb then raise sqlstate 'PT400' using message = 'A required entity field is empty.'; end if;
        continue;
      end if;
      case f->>'type'
        when 'number' then
          if jsonb_typeof(cell) <> 'number' then raise sqlstate 'PT400' using message = 'Invalid entity number.'; end if;
          n := (cell #>> '{}')::numeric;
          if abs(n) > 1e12 then raise sqlstate 'PT400' using message = 'Entity number is out of range.'; end if;
        when 'boolean' then
          if jsonb_typeof(cell) <> 'boolean' then raise sqlstate 'PT400' using message = 'Invalid entity boolean.'; end if;
        else
          if jsonb_typeof(cell) <> 'string' or pipechat.js_length(cell #>> '{}') > 12000 then raise sqlstate 'PT400' using message = 'Invalid entity text.'; end if;
          if f->>'type' = 'choice' and not (f->'options' @> jsonb_build_array(cell)) then raise sqlstate 'PT400' using message = 'Invalid entity choice.'; end if;
          if f->>'type' = 'date' then
            if (cell #>> '{}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or (cell #>> '{}') < '0100-01-01' then raise sqlstate 'PT400' using message = 'Invalid entity date.'; end if;
            perform (cell #>> '{}')::date;
          end if;
      end case;
    end loop;
  end loop;
  refs := pipechat.business_refs(p_workspace,p_state);
  for v in select value from jsonb_array_elements(p_state->'relationshipTypes') loop
    perform pipechat.business_object(v,array['id','name','fromType','toType','cardinality']);
    typ := pipechat.business_id(v->'id'); perform pipechat.label(v->'name',120);
    if jsonb_typeof(v->'fromType') is distinct from 'string' or jsonb_typeof(v->'toType') is distinct from 'string' or
      not (v->>'fromType' = 'primary' or defs ? (v->>'fromType')) or
      not (v->>'toType' = 'primary' or defs ? (v->>'toType')) or
      coalesce(v->>'cardinality','') not in ('one_to_one','one_to_many','many_to_one','many_to_many') then
      raise sqlstate 'PT400' using message = 'Invalid relationship type.';
    end if;
    relations := relations || jsonb_build_object(typ,v);
  end loop;
  for r in select value from jsonb_array_elements(p_state->'relationships') loop
    perform pipechat.business_object(r,array['id','typeId','fromId','toId']); perform pipechat.business_id(r->'id','lnk');
    v := relations->(r->>'typeId');
    if v is null or jsonb_typeof(r->'fromId') is distinct from 'string' or jsonb_typeof(r->'toId') is distinct from 'string' or
      refs->>(r->>'fromId') is distinct from v->>'fromType' or refs->>(r->>'toId') is distinct from v->>'toType' then
      raise sqlstate 'PT400' using message = 'Invalid or cross-workspace relationship endpoint.';
    end if;
  end loop;
  if exists (select 1 from jsonb_array_elements(p_state->'relationships') link group by link->>'typeId',link->>'fromId',link->>'toId' having count(*) > 1) or
    exists (select 1 from jsonb_array_elements(p_state->'relationships') link
      where relations->(link->>'typeId')->>'cardinality' in ('one_to_one','many_to_one') group by link->>'typeId',link->>'fromId' having count(*) > 1) or
    exists (select 1 from jsonb_array_elements(p_state->'relationships') link
      where relations->(link->>'typeId')->>'cardinality' in ('one_to_one','one_to_many') group by link->>'typeId',link->>'toId' having count(*) > 1) then
    raise sqlstate 'PT400' using message = 'Relationship cardinality exceeded.';
  end if;
  for v in select value from jsonb_array_elements(p_state->'views') loop
    perform pipechat.business_object(v,array['id','name','entityIds']); perform pipechat.business_id(v->'id','view'); perform pipechat.label(v->'name',120);
    if jsonb_typeof(v->'entityIds') is distinct from 'array' then raise sqlstate 'PT400' using message = 'Invalid view members.'; end if;
    if jsonb_array_length(v->'entityIds') > 7000 or exists (
      select 1 from jsonb_array_elements(v->'entityIds') x where jsonb_typeof(x) <> 'string' or not (refs ? (x #>> '{}'))) or
      exists (select 1 from jsonb_array_elements(v->'entityIds') x group by x having count(*) > 1) then
      raise sqlstate 'PT400' using message = 'Invalid or cross-workspace view member.';
    end if;
  end loop;
  perform pipechat.business_assert_field_removal(p_before,p_state);
  for old in select value from jsonb_array_elements(p_before->'entityTypes') loop
    after_item := defs->(old->>'id');
    if after_item is null or exists (select 1 from jsonb_array_elements(old->'fields') previous_field
      join jsonb_array_elements(after_item->'fields') next_field on next_field->>'id'=previous_field->>'id'
      where next_field->>'type'<>previous_field->>'type') then
      raise sqlstate 'PT400' using message = 'Removing entity types or retyping existing schema is not supported.';
    end if;
  end loop;
  for old in select value from jsonb_array_elements(p_before->'relationshipTypes') loop
    after_item := relations->(old->>'id');
    if after_item is null or (after_item - 'name') is distinct from (old - 'name') then
      raise sqlstate 'PT400' using message = 'Existing relationship contracts are immutable.';
    end if;
  end loop;
  if exists (select 1 from jsonb_array_elements(p_before->'entities') previous_item join jsonb_array_elements(p_state->'entities') next_item
    on previous_item->>'id'=next_item->>'id' where previous_item->>'typeId' <> next_item->>'typeId') or
    exists (select 1 from jsonb_array_elements(p_before->'relationships') previous_item join jsonb_array_elements(p_state->'relationships') next_item
    on previous_item->>'id'=next_item->>'id' where previous_item <> next_item) then
    raise sqlstate 'PT400' using message = 'Existing entity types and relationship identities are immutable.';
  end if;
exception when invalid_text_representation or datetime_field_overflow or numeric_value_out_of_range then
  raise sqlstate 'PT400' using message = 'Invalid typed entity value.';
end $$;
revoke all on function pipechat.business_validate(uuid,jsonb,jsonb) from public,anon,authenticated,service_role;
notify pgrst, 'reload schema';
commit;

