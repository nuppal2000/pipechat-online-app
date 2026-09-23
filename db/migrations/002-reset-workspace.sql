-- Additive migration. Defining this RPC does not reset any workspace.
begin;
create function public.pipechat_reset_crm(p_expected_updated_at text, p_confirm boolean) returns jsonb
language plpgsql security definer set search_path = pg_catalog as $$
declare
  uid uuid := pipechat.require_user(); wid uuid := pipechat.workspace_for(uid);
  version timestamptz;
begin
  if p_confirm is distinct from true then
    raise sqlstate 'PT400' using message = 'Explicit reset confirmation is required.';
  end if;
  if p_expected_updated_at is not null and (pipechat.js_length(p_expected_updated_at) > 256 or p_expected_updated_at = '' or p_expected_updated_at ~ U&'[\0001-\001f\007f]') then
    raise sqlstate 'PT400' using message = 'Invalid CRM version.';
  end if;
  select updated_at into version from pipechat.workspaces where id = wid and owner_id = uid for update;
  if not found then raise sqlstate 'PT403' using message = 'Only the workspace owner can reset it.'; end if;
  if p_expected_updated_at is distinct from pipechat.timestamp_text(version) then
    raise sqlstate 'PT409' using message = 'This CRM changed in another window. Refresh before resetting.';
  end if;
  delete from pipechat.crm_records where workspace_id = wid;
  update pipechat.workspace_metadata set table_schema = '{"status":"pending"}'::jsonb, custom_fields = '[]'::jsonb where workspace_id = wid;
  update pipechat.workspaces set updated_at = greatest(clock_timestamp(), version + interval '1 microsecond') where id = wid;
  return pipechat.crm_snapshot(wid);
end
$$;
revoke all on function public.pipechat_reset_crm(text, boolean) from public, anon, service_role;
grant execute on function public.pipechat_reset_crm(text, boolean) to authenticated;
notify pgrst, 'reload schema';
commit;
