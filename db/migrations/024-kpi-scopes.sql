-- Explicit OR-of-AND KPI scopes and dynamic percentages. No account data writes.
-- Replace only the existing private validator; CREATE OR REPLACE retains its ACL.
begin;
create or replace function pipechat.validate_kpis(p_kpis jsonb, p_defs jsonb default null) returns jsonb
language plpgsql immutable set search_path = pg_catalog as $$
declare
  k jsonb; c jsonb; f jsonb; result jsonb := '[]'; ids text[] := '{}';
  kid text; title text; metric text; fid text; op text; v jsonb; typ text; date_value text;
  scope_key text; scopes jsonb; groups jsonb; branch jsonb; cleaned_groups jsonb; conditions jsonb;
begin
  if jsonb_typeof(p_kpis) is distinct from 'array' then raise sqlstate 'PT400' using message = 'Invalid dashboard KPIs.'; end if;
  if jsonb_array_length(p_kpis) > 120 then raise sqlstate 'PT400' using message = 'Too many dashboard KPIs.'; end if;
  for k in select value from jsonb_array_elements(p_kpis) loop
    if jsonb_typeof(k) is distinct from 'object' then raise sqlstate 'PT400' using message = 'Invalid dashboard KPI.'; end if;
    kid := k->>'id'; metric := k->>'metric'; fid := k->>'field';
    if exists(select 1 from jsonb_object_keys(k) key where key not in ('id','title','metric','field','conditions','where','denominatorWhere')) or
      jsonb_typeof(k->'id') is distinct from 'string' or kid !~ '^kpi_[a-z0-9_]{1,100}$' or kid = any(ids) or coalesce(metric,'') not in ('count','sum','average','percentage') or
      not (k->'field' = 'null'::jsonb or jsonb_typeof(k->'field') = 'string' and fid ~ '^[a-z][a-z0-9_]{0,64}$') or not (k ? 'field') then
      raise sqlstate 'PT400' using message = 'Invalid dashboard KPI.';
    end if;
    title := pipechat.label(k->'title',120); ids := array_append(ids,kid);
    if jsonb_typeof(k->'conditions') is distinct from 'array' then raise sqlstate 'PT400' using message = 'Invalid KPI conditions.'; end if;
    if jsonb_array_length(k->'conditions') > 10 then raise sqlstate 'PT400' using message = 'Too many KPI conditions.'; end if;
    if k ? 'where' and jsonb_array_length(k->'conditions') > 0 then raise sqlstate 'PT400' using message = 'Use either legacy AND conditions or explicit filter groups, not both.'; end if;
    if metric = 'percentage' then
      if k->'field' <> 'null'::jsonb or not (k ? 'where') or not (k ? 'denominatorWhere') then
        raise sqlstate 'PT400' using message = 'Percentage KPIs need explicit numerator and denominator filters and no numeric field.';
      end if;
    elsif k ? 'denominatorWhere' then
      raise sqlstate 'PT400' using message = 'Only percentages have denominator filters.';
    end if;
    if p_defs is not null then
      select value into f from jsonb_array_elements(p_defs) where value->>'id' = fid;
      if metric in ('count','percentage') and fid is not null or metric not in ('count','percentage') and coalesce(f->>'type','') not in ('number','currency') then
        raise sqlstate 'PT400' using message = 'Invalid KPI numeric field.';
      end if;
    end if;
    scopes := '{}';
    foreach scope_key in array array['conditions','where','denominatorWhere'] loop
      if not (k ? scope_key) then continue; end if;
      if scope_key = 'conditions' then
        groups := jsonb_build_array(k->scope_key);
      else
        groups := k->scope_key;
        if jsonb_typeof(groups) is distinct from 'array' then raise sqlstate 'PT400' using message = 'Invalid KPI filter groups.'; end if;
        if jsonb_array_length(groups) > 12 then raise sqlstate 'PT400' using message = 'Too many KPI filter groups.'; end if;
      end if;
      cleaned_groups := '[]';
      for branch in select value from jsonb_array_elements(groups) loop
        if jsonb_typeof(branch) is distinct from 'array' then raise sqlstate 'PT400' using message = 'Invalid KPI filter group.'; end if;
        if scope_key <> 'conditions' and jsonb_array_length(branch) not between 1 and 20 then raise sqlstate 'PT400' using message = 'Each KPI filter group needs one to twenty conditions.'; end if;
        conditions := '[]';
        for c in select value from jsonb_array_elements(branch) loop
          if jsonb_typeof(c) is distinct from 'object' then raise sqlstate 'PT400' using message = 'Invalid KPI condition.'; end if;
          fid := c->>'field'; op := c->>'operator'; v := c->'value';
          if exists(select 1 from jsonb_object_keys(c) key where key not in ('field','operator','value')) or
            jsonb_typeof(c->'field') is distinct from 'string' or fid !~ '^[a-z][a-z0-9_]{0,64}$' or coalesce(op,'') not in ('equals','not_equals','is_blank','is_not_blank','gt','gte','lt','lte','before_today','older_than_days','starts_with') or
            coalesce(jsonb_typeof(v),'') not in ('null','string','number') then raise sqlstate 'PT400' using message = 'Invalid KPI condition.'; end if;
          if jsonb_typeof(v) = 'string' and pipechat.js_length(v #>> '{}') > 12000 or jsonb_typeof(v) = 'number' and abs((v #>> '{}')::numeric) > 1e12 then raise sqlstate 'PT400' using message = 'Invalid KPI condition value.'; end if;
          if p_defs is not null then
            select value into f from jsonb_array_elements(p_defs) where value->>'id' = fid;
            if f is null then raise sqlstate 'PT400' using message = 'A KPI references a missing column.'; end if;
            typ := f->>'type';
            if op in ('is_blank','is_not_blank') then
              if v <> 'null'::jsonb then raise sqlstate 'PT400' using message = 'Blank checks need no value.'; end if;
            elsif op in ('before_today','older_than_days') then
              if typ <> 'date' and not (coalesce(f->>'role','') = 'followup' and typ = 'text') then raise sqlstate 'PT400' using message = 'Stale-date conditions need a date column.'; end if;
              if op = 'before_today' and v <> 'null'::jsonb then raise sqlstate 'PT400' using message = 'Invalid date cutoff.'; end if;
              if op = 'older_than_days' then
                if jsonb_typeof(v) <> 'number' then raise sqlstate 'PT400' using message = 'Invalid stale days.'; end if;
                if (v #>> '{}')::numeric not between 0 and 36500 or (v #>> '{}')::numeric <> trunc((v #>> '{}')::numeric) then raise sqlstate 'PT400' using message = 'Invalid stale days.'; end if;
              end if;
            elsif op in ('gt','gte','lt','lte') then
              if typ = 'date' then
                -- Match JS whitespace, not locale-dependent POSIX space classes.
                -- Normalize only for validation; keep the saved literal intact.
                date_value := pipechat.name_key(v #>> '{}');
                if jsonb_typeof(v) <> 'string' or date_value !~ '^([0-9]{4}-[0-9]{2}-[0-9]{2}|[a-z]+ [0-9]{1,2},? [0-9]{4})$' then
                  raise sqlstate 'PT400' using message = 'Invalid date comparison.';
                end if;
                perform pipechat.validate_cell(f,to_jsonb(date_value),false);
              elsif typ not in ('number','currency') or jsonb_typeof(v) <> 'number' then raise sqlstate 'PT400' using message = 'Invalid KPI comparison.';
              end if;
            elsif op = 'starts_with' then
              if typ not in ('text','choice') or jsonb_typeof(v) <> 'string' or pipechat.name_key(v #>> '{}',true) = '' then raise sqlstate 'PT400' using message = 'Prefix matching needs a text or choice column and nonblank text.'; end if;
            elsif v = 'null'::jsonb then raise sqlstate 'PT400' using message = 'Specify a KPI comparison value.';
            end if;
          end if;
          conditions := conditions || jsonb_build_array(jsonb_build_object('field',fid,'operator',op,'value',v));
        end loop;
        cleaned_groups := cleaned_groups || jsonb_build_array(conditions);
      end loop;
      scopes := scopes || jsonb_build_object(scope_key,case when scope_key = 'conditions' then cleaned_groups->0 else cleaned_groups end);
    end loop;
    result := result || jsonb_build_array(jsonb_build_object('id',kid,'title',title,'metric',metric,'field',k->'field') || scopes);
  end loop;
  return result;
end
$$;
commit;
