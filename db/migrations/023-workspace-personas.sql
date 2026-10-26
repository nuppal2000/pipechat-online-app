-- Persona metadata only. No existing records, task data, quotas or assignments are changed.
begin;
create function pipechat.validate_agent_profile(p jsonb) returns void
language plpgsql set search_path=pg_catalog as $$
begin
  if jsonb_typeof(p) is distinct from 'object' or
    (select array_agg(k order by k) from jsonb_object_keys(p) k) is distinct from array['description','personaId','source','subtype','useCase','version'] or
    coalesce(p->>'personaId','') not in ('neutral','sales','recruiting','real_estate','insurance') or
    p->>'version' is distinct from 'v1' or
    coalesce(p->>'useCase','') not in ('Sales','Recruiting','Real Estate','Other') or
    coalesce(p->>'source','') not in ('onboarding','inferred','neutral','fallback') or
    jsonb_typeof(p->'description') is distinct from 'string' or pipechat.js_length(p->>'description')>2000 or
    jsonb_typeof(p->'subtype') is distinct from 'string' or pipechat.js_length(p->>'subtype')>120 or
    p->>'subtype' ~ '[[:cntrl:]]' then
    raise sqlstate 'PT400' using message='Invalid workspace persona assignment.';
  end if;
  if (p->>'useCase'<>'Other' and (p->>'personaId' is distinct from case p->>'useCase' when 'Sales' then 'sales' when 'Recruiting' then 'recruiting' when 'Real Estate' then 'real_estate' end or p->>'source'<>'onboarding' or p->>'subtype'<>'')) or
    (p->>'useCase'='Other' and (p->>'source'='onboarding' or (p->>'source' in ('neutral','fallback') and p->>'personaId'<>'neutral'))) then
    raise sqlstate 'PT400' using message='Persona does not match the onboarding selection.';
  end if;
end $$;

create table pipechat.workspace_agent_profiles (
  workspace_id uuid primary key references pipechat.workspaces(id) on delete cascade,
  assignment jsonb not null,
  updated_at timestamptz not null default clock_timestamp()
);
alter table pipechat.workspace_agent_profiles enable row level security;
revoke all on pipechat.workspace_agent_profiles from public,anon,authenticated,service_role;

create function public.pipechat_read_agent_profile() returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare uid uuid:=pipechat.require_user(); wid uuid:=pipechat.workspace_for(uid); result jsonb;
begin
  if not exists(select 1 from pipechat.workspaces where id=wid and owner_id=uid) then raise sqlstate 'PT403' using message='Workspace access denied.'; end if;
  select assignment into result from pipechat.workspace_agent_profiles where workspace_id=wid;
  return result;
end $$;

create function public.pipechat_save_agent_profile(p_assignment jsonb,p_expected_updated_at text) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare uid uuid:=pipechat.require_user(); wid uuid:=pipechat.workspace_for(uid); revision timestamptz; schema_value jsonb; previous jsonb;
begin
  perform pipechat.validate_agent_profile(p_assignment);
  select updated_at into revision from pipechat.workspaces where id=wid and owner_id=uid for update;
  if not found then raise sqlstate 'PT403' using message='Workspace access denied.'; end if;
  if pipechat.timestamp_text(revision) is distinct from p_expected_updated_at then raise sqlstate 'PT409' using message='The workspace changed. Reload before continuing.'; end if;
  select table_schema into schema_value from pipechat.workspace_metadata where workspace_id=wid;
  if schema_value->>'status'='ready' and (p_assignment->>'useCase' is distinct from schema_value->>'useCase' or p_assignment->>'description' is distinct from schema_value->>'description') then
    raise sqlstate 'PT400' using message='Persona business context does not match this workspace.';
  end if;
  select assignment into previous from pipechat.workspace_agent_profiles where workspace_id=wid;
  -- Same business context keeps its exact pinned version. Only an unclassified fallback can be refined.
  if previous->>'useCase'=p_assignment->>'useCase' and previous->>'description'=p_assignment->>'description' and previous->>'source'<>'fallback' then return previous; end if;
  insert into pipechat.workspace_agent_profiles(workspace_id,assignment) values(wid,p_assignment)
    on conflict(workspace_id) do update set assignment=excluded.assignment,updated_at=clock_timestamp();
  return p_assignment;
end $$;

create function pipechat.sync_agent_profile() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
declare use_case text:=new.table_schema->>'useCase'; description text:=coalesce(new.table_schema->>'description',''); previous jsonb; persona text;
begin
  if new.table_schema->>'status'='pending' and old.table_schema->>'status'='ready' then
    delete from pipechat.workspace_agent_profiles where workspace_id=new.workspace_id;
  elsif new.table_schema->>'status'='ready' and use_case in ('Sales','Recruiting','Real Estate','Other') then
    select assignment into previous from pipechat.workspace_agent_profiles where workspace_id=new.workspace_id;
    if previous is null or previous->>'useCase' is distinct from use_case or previous->>'description' is distinct from description then
      persona:=case use_case when 'Sales' then 'sales' when 'Recruiting' then 'recruiting' when 'Real Estate' then 'real_estate' else 'neutral' end;
      insert into pipechat.workspace_agent_profiles(workspace_id,assignment) values(new.workspace_id,
        jsonb_build_object('personaId',persona,'version','v1','subtype','','useCase',use_case,'description',description,'source',case when use_case='Other' then 'fallback' else 'onboarding' end))
        on conflict(workspace_id) do update set assignment=excluded.assignment,updated_at=clock_timestamp();
    end if;
  end if;
  return new;
end $$;
create trigger workspace_persona_lifecycle after update of table_schema on pipechat.workspace_metadata for each row execute function pipechat.sync_agent_profile();
revoke all on function pipechat.validate_agent_profile(jsonb),pipechat.sync_agent_profile() from public,anon,authenticated,service_role;
revoke all on function public.pipechat_read_agent_profile(),public.pipechat_save_agent_profile(jsonb,text) from public,anon,service_role;
grant execute on function public.pipechat_read_agent_profile(),public.pipechat_save_agent_profile(jsonb,text) to authenticated;
notify pgrst,'reload schema';
commit;
