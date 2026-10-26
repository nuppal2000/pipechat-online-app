-- Preserve the order of surviving saved-view members during primary cleanup.
-- No schema, policy, privilege, grant-creation or sharing behavior is changed.
begin;

create or replace function pipechat.business_primary_changed() returns trigger
language plpgsql security definer set search_path = pg_catalog as $$
declare s jsonb; next_state jsonb; refs jsonb; removed integer; next_version bigint;
begin
  select state into s from pipechat.business_workspaces where workspace_id=new.id for update;
  if s is null then return new; end if;
  refs := pipechat.business_refs(new.id,s);
  next_state := jsonb_set(s,'{relationships}',coalesce((select jsonb_agg(r) from jsonb_array_elements(s->'relationships') r
    where refs ? (r->>'fromId') and refs ? (r->>'toId')), '[]'));
  next_state := jsonb_set(next_state,'{views}',coalesce((
    select jsonb_agg(jsonb_set(v.value,'{entityIds}',coalesce((
      select jsonb_agg(member.value order by member.ordinality)
      from jsonb_array_elements(v.value->'entityIds') with ordinality as member(value,ordinality)
      where refs ? (member.value #>> '{}')), '[]')) order by v.ordinality)
    from jsonb_array_elements(s->'views') with ordinality as v(value,ordinality)), '[]'));
  -- Retain the existing deleted-record grant cleanup, without creating grants.
  delete from pipechat.business_grants where workspace_id=new.id and scope='record' and not (refs ? resource_id);
  get diagnostics removed = row_count;
  if s is distinct from next_state or removed>0 then
    update pipechat.business_workspaces set state=next_state,version=version+1 where workspace_id=new.id returning version into next_version;
    perform pipechat.business_audit_diff(new.id,s,next_state,auth.uid(),next_version);
  end if;
  return new;
end $$;

commit;
