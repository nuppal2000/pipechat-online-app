-- Additive business graph. No legacy membership, CRM row or route is migrated.
-- Apply as the same trusted owner as 001. All APIs use require_user(), including
-- session revocation. State never contains owners, members, grants or CRM cells.
begin;

create table pipechat.business_workspaces (
  workspace_id uuid primary key references pipechat.workspaces(id) on delete cascade,
  version bigint not null default 0 check (version between 0 and 9007199254740991),
  state jsonb not null default '{"formatVersion":1,"primary":{"typeId":"primary","source":"crm_records"},"entityTypes":[],"relationshipTypes":[],"entities":[],"relationships":[],"views":[]}'
);
create table pipechat.business_memberships (
  workspace_id uuid not null references pipechat.business_workspaces(workspace_id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('viewer','editor')),
  primary key (workspace_id,user_id)
);
create table pipechat.business_grants (
  workspace_id uuid not null references pipechat.business_workspaces(workspace_id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  scope text not null check (scope in ('record','view')),
  resource_id text not null,
  primary key (workspace_id,user_id,scope,resource_id)
);
-- Append-only through trusted SQL. Audit data is deliberately outside the
-- model-editable canonical state; legacy CRM cell values are never copied here.
create table pipechat.business_audit (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references pipechat.business_workspaces(workspace_id) on delete cascade,
  entity_id text not null,
  actor_id uuid references auth.users(id) on delete set null,
  workspace_version bigint not null,
  kind text not null check (kind in ('create','update','delete','link','unlink')),
  occurred_at timestamptz not null default clock_timestamp(),
  before_value jsonb,
  after_value jsonb,
  relationship jsonb,
  check ((kind in ('link','unlink')) = (relationship is not null))
);
create index business_audit_entity on pipechat.business_audit(workspace_id,entity_id,id);
alter table pipechat.business_workspaces enable row level security;
alter table pipechat.business_memberships enable row level security;
alter table pipechat.business_grants enable row level security;
alter table pipechat.business_audit enable row level security;
revoke all on pipechat.business_workspaces, pipechat.business_memberships, pipechat.business_grants,
  pipechat.business_audit from public, anon, authenticated, service_role;
revoke all on sequence pipechat.business_audit_id_seq from public, anon, authenticated, service_role;

create function pipechat.business_object(p_value jsonb, p_keys text[]) returns void
language plpgsql immutable set search_path = pg_catalog as $$
begin
  if jsonb_typeof(p_value) is distinct from 'object' or not (p_value ?& p_keys) or
    exists (select 1 from jsonb_object_keys(p_value) k where not (k = any(p_keys))) then
    raise sqlstate 'PT400' using message = 'Invalid business workspace object.';
  end if;
end $$;

create function pipechat.business_id(p_value jsonb, p_kind text default 'schema') returns text
language plpgsql immutable set search_path = pg_catalog as $$
declare v text := p_value #>> '{}'; pattern text;
begin
  pattern := case when p_kind = 'schema' then '^[a-z][a-z0-9_]{0,63}$'
    else '^' || p_kind || '_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' end;
  if jsonb_typeof(p_value) is distinct from 'string' or v !~ pattern or v in ('primary','constructor','prototype','__proto__') then
    raise sqlstate 'PT400' using message = 'Invalid business identifier.';
  end if;
  return v;
end $$;

create function pipechat.business_refs(p_workspace uuid, p_state jsonb) returns jsonb
language sql stable set search_path = pg_catalog as $$
  select coalesce(jsonb_object_agg(id,typ), '{}'::jsonb) from (
    select e->>'id' id, e->>'typeId' typ from jsonb_array_elements(p_state->'entities') e
    union all
    select 'legacy:' || p_workspace::text || ':' || r.record_id::text, 'primary'
    from pipechat.crm_records r where r.workspace_id = p_workspace
  ) refs
$$;

create function pipechat.business_validate(p_workspace uuid, p_state jsonb, p_before jsonb) returns void
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
  -- Schema changes are additive; data/type migrations need a separate contract.
  for old in select value from jsonb_array_elements(p_before->'entityTypes') loop
    after_item := defs->(old->>'id');
    if after_item is null or exists (select 1 from jsonb_array_elements(old->'fields') previous_field where not exists (
      select 1 from jsonb_array_elements(after_item->'fields') next_field where next_field->>'id'=previous_field->>'id' and next_field->>'type'=previous_field->>'type')) then
      raise sqlstate 'PT400' using message = 'Removing or retyping existing schema is not supported.';
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

create function pipechat.business_audit_diff(p_workspace uuid, p_before jsonb, p_after jsonb,
  p_actor uuid, p_version bigint) returns void
language plpgsql set search_path = pg_catalog as $$
declare event_time timestamptz := clock_timestamp();
begin
  insert into pipechat.business_audit(workspace_id,entity_id,actor_id,workspace_version,kind,occurred_at,before_value,after_value)
    select p_workspace,coalesce(prior.value->>'id',later.value->>'id'),p_actor,p_version,
      case when prior.value is null then 'create' when later.value is null then 'delete' else 'update' end,
      event_time,prior.value,later.value
    from jsonb_array_elements(p_before->'entities') prior(value)
    full join jsonb_array_elements(p_after->'entities') later(value) on prior.value->>'id'=later.value->>'id'
    where prior.value is distinct from later.value
    order by coalesce(prior.value->>'id',later.value->>'id');
  insert into pipechat.business_audit(workspace_id,entity_id,actor_id,workspace_version,kind,occurred_at,relationship)
    select p_workspace,endpoints.entity_id,p_actor,p_version,changes.kind,event_time,changes.relationship
    from (
      select coalesce(prior.value,later.value) relationship,
        case when prior.value is null then 'link' else 'unlink' end kind
      from jsonb_array_elements(p_before->'relationships') prior(value)
      full join jsonb_array_elements(p_after->'relationships') later(value) on prior.value->>'id'=later.value->>'id'
      where prior.value is null or later.value is null
    ) changes cross join lateral (
      select distinct entity_id from unnest(array[changes.relationship->>'fromId',changes.relationship->>'toId']) entity_id
    ) endpoints order by changes.relationship->>'id',endpoints.entity_id;
end $$;

create function pipechat.business_role(p_workspace uuid, p_user uuid) returns text
language sql stable set search_path = pg_catalog as $$
  select case when w.owner_id = p_user then 'owner' else
    (select m.role from pipechat.business_memberships m where m.workspace_id=w.id and m.user_id=p_user) end
  from pipechat.workspaces w where w.id=p_workspace
$$;

create function pipechat.business_snapshot(p_workspace uuid, p_user uuid) returns jsonb
language plpgsql stable set search_path = pg_catalog as $$
declare
  s jsonb; v bigint; role_name text; allowed text[]; view_ids text[]; visible jsonb; edges jsonb; views jsonb;
  primary_rows jsonb; schema_value jsonb; fields jsonb; primary_version text; full_access boolean; access_value jsonb;
begin
  role_name := pipechat.business_role(p_workspace,p_user); full_access := role_name is not null;
  select b.state,b.version into s,v from pipechat.business_workspaces b where b.workspace_id=p_workspace;
  if s is null or not full_access and not exists (select 1 from pipechat.business_grants g where g.workspace_id=p_workspace and g.user_id=p_user) then
    raise sqlstate 'PT403' using message = 'Business workspace access denied.';
  end if;
  if not full_access then
    select coalesce(array_agg(g.resource_id),'{}') into view_ids from pipechat.business_grants g
      where g.workspace_id=p_workspace and g.user_id=p_user and g.scope='view';
    select coalesce(array_agg(distinct id),'{}') into allowed from (
      select g.resource_id id from pipechat.business_grants g where g.workspace_id=p_workspace and g.user_id=p_user and g.scope='record'
      union all select x #>> '{}' from jsonb_array_elements(s->'views') view_value,
        lateral jsonb_array_elements(view_value->'entityIds') x where view_value->>'id'=any(view_ids)
    ) ids;
    select coalesce(jsonb_agg(e),'[]') into visible from jsonb_array_elements(s->'entities') e where e->>'id'=any(allowed);
    -- Sharing never walks edges or expands a view into related records.
    select coalesce(jsonb_agg(r),'[]') into edges from jsonb_array_elements(s->'relationships') r
      where r->>'fromId'=any(allowed) and r->>'toId'=any(allowed);
    select coalesce(jsonb_agg(view_value),'[]') into views from jsonb_array_elements(s->'views') view_value where view_value->>'id'=any(view_ids);
    s := jsonb_set(jsonb_set(jsonb_set(s,'{entities}',visible),'{relationships}',edges),'{views}',views);
    s := jsonb_set(s,'{entityTypes}',coalesce((select jsonb_agg(t) from jsonb_array_elements(s->'entityTypes') t
      where exists (select 1 from jsonb_array_elements(visible) e where e->>'typeId'=t->>'id')), '[]'));
    s := jsonb_set(s,'{relationshipTypes}',coalesce((select jsonb_agg(t) from jsonb_array_elements(s->'relationshipTypes') t
      where exists (select 1 from jsonb_array_elements(edges) e where e->>'typeId'=t->>'id')), '[]'));
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('entityId','legacy:'||p_workspace::text||':'||r.record_id::text,
    'recordId',r.record_id,'values',r.cells) order by r.position),'[]') into primary_rows
    from pipechat.crm_records r where r.workspace_id=p_workspace and
      (full_access or 'legacy:'||p_workspace::text||':'||r.record_id::text=any(allowed));
  select case when full_access or jsonb_array_length(primary_rows)>0 then m.table_schema else null end,
    case when full_access or jsonb_array_length(primary_rows)>0 then m.custom_fields else '[]'::jsonb end,
    pipechat.timestamp_text(w.updated_at) into schema_value,fields,primary_version
    from pipechat.workspaces w join pipechat.workspace_metadata m on m.workspace_id=w.id where w.id=p_workspace;
  if role_name='owner' then
    access_value := jsonb_build_object('memberships',coalesce((select jsonb_agg(jsonb_build_object(
      'userId',m.user_id,'email',to_jsonb(u)->>'email','role',m.role) order by m.user_id)
      from pipechat.business_memberships m join auth.users u on u.id=m.user_id where m.workspace_id=p_workspace),'[]'),
      'grants',coalesce((select jsonb_agg(jsonb_build_object('userId',g.user_id,'email',to_jsonb(u)->>'email',
        'scope',g.scope,'resourceId',g.resource_id,'role','viewer') order by g.user_id,g.scope,g.resource_id)
        from pipechat.business_grants g join auth.users u on u.id=g.user_id where g.workspace_id=p_workspace),'[]'));
  end if;
  return jsonb_build_object('workspaceId',p_workspace,'version',v,'role',coalesce(role_name,'viewer'),
    'scope',case when full_access then 'workspace' else 'shared' end,'state',s,'access',access_value,
    'primary',jsonb_build_object('records',primary_rows,'tableSchema',schema_value,'customFields',fields,'updatedAt',primary_version));
end $$;

-- Name these RPCs business_workspace_* so the legacy RPC inventory is unchanged.
create function public.business_workspace_get(p_workspace uuid default null) returns jsonb
language plpgsql security definer set search_path = pg_catalog as $$
declare uid uuid := pipechat.require_user(); wid uuid; owner_value uuid;
begin
  if p_workspace is null then select id into wid from pipechat.workspaces where owner_id=uid; else wid := p_workspace; end if;
  select owner_id into owner_value from pipechat.workspaces where id=wid for share;
  if owner_value=uid then insert into pipechat.business_workspaces(workspace_id) values(wid) on conflict do nothing; end if;
  return pipechat.business_snapshot(wid,uid);
end $$;

create function public.business_workspace_list() returns jsonb
language plpgsql security definer set search_path = pg_catalog as $$
declare uid uuid := pipechat.require_user();
begin
  return coalesce((select jsonb_agg(jsonb_build_object('workspaceId',w.id,
    'title',coalesce(nullif(m.table_schema->>'title',''),'Workspace'),
    'role',coalesce(pipechat.business_role(w.id,uid),'viewer'),
    'scope',case when pipechat.business_role(w.id,uid) is null then 'shared' else 'workspace' end) order by w.id)
    from pipechat.workspaces w join pipechat.workspace_metadata m on m.workspace_id=w.id where w.owner_id=uid or
      exists(select 1 from pipechat.business_memberships m where m.workspace_id=w.id and m.user_id=uid) or
      exists(select 1 from pipechat.business_grants g where g.workspace_id=w.id and g.user_id=uid)), '[]');
end $$;

-- Chronological, cursor-paged history. Full members can inspect deleted records;
-- scoped recipients must still hold access to the current entity and BOTH ends
-- of historical links. A record grant cannot reveal a hidden related entity.
create function public.business_workspace_history(p_workspace uuid, p_entity_id text, p_after bigint default 0) returns jsonb
language plpgsql security definer set search_path = pg_catalog as $$
declare uid uuid := pipechat.require_user(); visible jsonb; allowed text[]; full_access boolean;
begin
  p_after := coalesce(p_after,0);
  if p_after < 0 or p_entity_id is null or length(p_entity_id)>100 then
    raise sqlstate 'PT400' using message = 'Invalid entity history cursor or identity.';
  end if;
  perform 1 from pipechat.workspaces where id=p_workspace for share;
  visible := pipechat.business_snapshot(p_workspace,uid);
  full_access := visible->>'scope'='workspace';
  select coalesce(array_agg(id),'{}') into allowed from (
    select item->>'id' id from jsonb_array_elements(visible->'state'->'entities') item
    union all select item->>'entityId' from jsonb_array_elements(visible->'primary'->'records') item
  ) ids;
  if not full_access and not (p_entity_id=any(allowed)) then
    raise sqlstate 'PT403' using message = 'Entity history access denied.';
  end if;
  return (with selected as (
    select a.* from pipechat.business_audit a where a.workspace_id=p_workspace and a.entity_id=p_entity_id and a.id>p_after
      and (full_access or a.relationship is null or
        a.relationship->>'fromId'=any(allowed) and a.relationship->>'toId'=any(allowed))
    order by a.id limit 51
  ), bounded as (
    select selected.*,row_number() over(order by id) ordinal,
      sum(octet_length(to_jsonb(selected)::text)) over(order by id) bytes from selected
  ), page as (select * from bounded where ordinal<=50 and (bytes<=4194304 or ordinal=1))
  select jsonb_build_object('workspaceId',p_workspace,'entityId',p_entity_id,
    'events',coalesce((select jsonb_agg(jsonb_build_object('id',a.id::text,'version',a.workspace_version,
      'kind',a.kind,'at',pipechat.timestamp_text(a.occurred_at),'actorId',a.actor_id,
      'before',a.before_value,'after',a.after_value,'relationship',a.relationship) order by a.id) from page a),'[]'),
    'nextAfter',case when (select count(*) from selected)>(select count(*) from page) then (select max(id)::text from page) else null end));
end $$;

create function public.business_workspace_cas(p_workspace uuid, p_expected_version bigint, p_state jsonb,
  p_expected_primary_updated_at text) returns jsonb
language plpgsql security definer set search_path = pg_catalog as $$
declare uid uuid := pipechat.require_user(); role_name text; old jsonb; v bigint; primary_version text; refs jsonb;
begin
  -- Same lock order as legacy writes: lock the legacy workspace first. This also
  -- serializes grants/revocations with reads and commits, avoiding an ACL race.
  select pipechat.timestamp_text(updated_at) into primary_version from pipechat.workspaces where id=p_workspace for update;
  role_name := pipechat.business_role(p_workspace,uid);
  if coalesce(role_name,'') not in ('owner','editor') then raise sqlstate 'PT403' using message = 'Business workspace is read-only or unavailable.'; end if;
  select state,version into old,v from pipechat.business_workspaces where workspace_id=p_workspace for update;
  if v is null or p_expected_version is distinct from v or p_expected_primary_updated_at is distinct from primary_version then
    raise sqlstate 'PT409' using message = 'Workspace or primary records changed. Reload before saving.';
  end if;
  perform pipechat.business_validate(p_workspace,p_state,old);
  if role_name <> 'owner' and (p_state->'entityTypes' is distinct from old->'entityTypes' or
    p_state->'relationshipTypes' is distinct from old->'relationshipTypes' or p_state->'views' is distinct from old->'views') then
    raise sqlstate 'PT403' using message = 'Only the owner can change schema or shared views.';
  end if;
  refs := pipechat.business_refs(p_workspace,p_state);
  delete from pipechat.business_grants g where g.workspace_id=p_workspace and
    (g.scope='record' and not (refs ? g.resource_id) or g.scope='view' and not exists (
      select 1 from jsonb_array_elements(p_state->'views') x where x->>'id'=g.resource_id));
  update pipechat.business_workspaces set state=p_state,version=version+1 where workspace_id=p_workspace;
  perform pipechat.business_audit_diff(p_workspace,old,p_state,uid,v+1);
  return pipechat.business_snapshot(p_workspace,uid);
end $$;

create function public.business_workspace_share(p_workspace uuid, p_email text, p_scope text,
  p_resource_id text, p_role text, p_expected_version bigint) returns jsonb
language plpgsql security definer set search_path = pg_catalog as $$
declare uid uuid := pipechat.require_user(); target uuid; v bigint; s jsonb;
begin
  perform 1 from pipechat.workspaces where id=p_workspace for update;
  if pipechat.business_role(p_workspace,uid) is distinct from 'owner' then raise sqlstate 'PT403' using message = 'Only the owner can share this workspace.'; end if;
  select state,version into s,v from pipechat.business_workspaces where workspace_id=p_workspace for update;
  if v is null or p_expected_version is distinct from v then raise sqlstate 'PT409' using message = 'Workspace changed. Review access again.'; end if;
  if p_email is null or length(p_email)>320 or btrim(p_email) !~ '^[^[:space:]@]+@[^[:space:]@]+$' or
    coalesce(p_scope,'') not in ('workspace','record','view') or coalesce(p_role,'') not in ('viewer','editor') or
    (p_scope='workspace' and p_resource_id is not null) or (p_scope<>'workspace' and (p_role<>'viewer' or p_resource_id is null)) then
    raise sqlstate 'PT400' using message = 'Choose an existing user email and an explicit workspace, record or view scope. Scoped shares are read-only.';
  end if;
  -- to_jsonb also permits the minimal local auth fixture, which has no email.
  select u.id into target from auth.users u where lower(to_jsonb(u)->>'email')=lower(btrim(p_email));
  if target is null or (select count(*) from auth.users u where lower(to_jsonb(u)->>'email')=lower(btrim(p_email)))<>1 then
    raise sqlstate 'PT400' using message = 'A unique existing account with that email is required. No invitation was sent.';
  end if;
  if target=uid then raise sqlstate 'PT400' using message = 'Owner access cannot be granted or changed.'; end if;
  if p_scope='record' and not (pipechat.business_refs(p_workspace,s) ? p_resource_id) or
    p_scope='view' and not exists(select 1 from jsonb_array_elements(s->'views') x where x->>'id'=p_resource_id) then
    raise sqlstate 'PT400' using message = 'The shared resource does not exist in this workspace.';
  end if;
  if p_scope='workspace' then
    insert into pipechat.business_memberships(workspace_id,user_id,role) values(p_workspace,target,p_role)
      on conflict(workspace_id,user_id) do update set role=excluded.role;
  else
    insert into pipechat.business_grants(workspace_id,user_id,scope,resource_id) values(p_workspace,target,p_scope,p_resource_id) on conflict do nothing;
  end if;
  update pipechat.business_workspaces set version=version+1 where workspace_id=p_workspace returning version into v;
  return jsonb_build_object('workspaceId',p_workspace,'version',v,'userId',target,'scope',p_scope,'resourceId',p_resource_id,'role',p_role,
    'effectiveRole',coalesce(pipechat.business_role(p_workspace,target),'viewer'),
    'effectiveScope',case when pipechat.business_role(p_workspace,target) is null then 'shared' else 'workspace' end,'emailSent',false);
end $$;

create function public.business_workspace_revoke(p_workspace uuid, p_email text, p_scope text,
  p_resource_id text, p_expected_version bigint) returns jsonb
language plpgsql security definer set search_path = pg_catalog as $$
declare uid uuid := pipechat.require_user(); target uuid; v bigint;
begin
  perform 1 from pipechat.workspaces where id=p_workspace for update;
  if pipechat.business_role(p_workspace,uid) is distinct from 'owner' then raise sqlstate 'PT403' using message = 'Only the owner can revoke access.'; end if;
  select version into v from pipechat.business_workspaces where workspace_id=p_workspace for update;
  if v is null or p_expected_version is distinct from v then raise sqlstate 'PT409' using message = 'Workspace changed. Review access again.'; end if;
  if coalesce(p_scope,'') not in ('workspace','record','view') or
    (p_scope='workspace' and p_resource_id is not null) or (p_scope<>'workspace' and p_resource_id is null) or
    p_email is null or length(p_email)>320 or btrim(p_email) !~ '^[^[:space:]@]+@[^[:space:]@]+$' then
    raise sqlstate 'PT400' using message = 'Invalid revocation scope.';
  end if;
  select u.id into target from auth.users u where lower(to_jsonb(u)->>'email')=lower(btrim(p_email));
  if target is null or target=uid or (select count(*) from auth.users u where lower(to_jsonb(u)->>'email')=lower(btrim(p_email)))<>1 then
    raise sqlstate 'PT400' using message = 'A unique existing non-owner account is required.';
  end if;
  -- Workspace revocation removes ALL access, including any narrower grants.
  if p_scope='workspace' then delete from pipechat.business_memberships where workspace_id=p_workspace and user_id=target; end if;
  delete from pipechat.business_grants where workspace_id=p_workspace and user_id=target and
    (p_scope='workspace' or scope=p_scope and resource_id=p_resource_id);
  update pipechat.business_workspaces set version=version+1 where workspace_id=p_workspace returning version into v;
  return jsonb_build_object('workspaceId',p_workspace,'version',v,'revoked',true);
end $$;

-- Legacy snapshots replace every row before updating workspaces.updated_at.
-- Prune only genuinely removed IDs at that final boundary, not on row DELETE.
-- This avoids copying CRM data and prevents deleted IDs from reviving shares.
create function pipechat.business_primary_changed() returns trigger
language plpgsql security definer set search_path = pg_catalog as $$
declare s jsonb; next_state jsonb; refs jsonb; removed integer; next_version bigint;
begin
  select state into s from pipechat.business_workspaces where workspace_id=new.id for update;
  if s is null then return new; end if;
  refs := pipechat.business_refs(new.id,s);
  next_state := jsonb_set(s,'{relationships}',coalesce((select jsonb_agg(r) from jsonb_array_elements(s->'relationships') r
    where refs ? (r->>'fromId') and refs ? (r->>'toId')), '[]'));
  next_state := jsonb_set(next_state,'{views}',coalesce((select jsonb_agg(jsonb_set(v,'{entityIds}',coalesce((
    select jsonb_agg(id) from jsonb_array_elements(v->'entityIds') id where refs ? (id #>> '{}')), '[]')))
    from jsonb_array_elements(s->'views') v), '[]'));
  delete from pipechat.business_grants where workspace_id=new.id and scope='record' and not (refs ? resource_id);
  get diagnostics removed = row_count;
  if s is distinct from next_state or removed>0 then
    update pipechat.business_workspaces set state=next_state,version=version+1 where workspace_id=new.id returning version into next_version;
    perform pipechat.business_audit_diff(new.id,s,next_state,auth.uid(),next_version);
  end if;
  return new;
end $$;
create trigger business_primary_changed after update of updated_at on pipechat.workspaces
for each row execute function pipechat.business_primary_changed();

-- Explicitly override permissive installation defaults, including service-role
-- execute. Helpers stay private; no direct table/RLS policy widens legacy access.
revoke all on function pipechat.business_object(jsonb,text[]), pipechat.business_id(jsonb,text),
  pipechat.business_refs(uuid,jsonb), pipechat.business_validate(uuid,jsonb,jsonb), pipechat.business_role(uuid,uuid),
  pipechat.business_snapshot(uuid,uuid), pipechat.business_primary_changed(), pipechat.business_audit_diff(uuid,jsonb,jsonb,uuid,bigint)
  from public, anon, authenticated, service_role;
revoke all on function public.business_workspace_get(uuid), public.business_workspace_list(),
  public.business_workspace_cas(uuid,bigint,jsonb,text), public.business_workspace_share(uuid,text,text,text,text,bigint),
  public.business_workspace_revoke(uuid,text,text,text,bigint), public.business_workspace_history(uuid,text,bigint) from public, anon, authenticated, service_role;
grant execute on function public.business_workspace_get(uuid), public.business_workspace_list(),
  public.business_workspace_cas(uuid,bigint,jsonb,text), public.business_workspace_share(uuid,text,text,text,text,bigint),
  public.business_workspace_revoke(uuid,text,text,text,bigint), public.business_workspace_history(uuid,text,bigint) to authenticated;
commit;
