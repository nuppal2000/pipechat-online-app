-- Linked cards retain their six-key contract. Standalone cards add customTitle.
begin;
create or replace function pipechat.validate_todo_v2(p_cards jsonb,p_deals jsonb) returns jsonb
language plpgsql immutable set search_path=pg_catalog as $$
declare c jsonb; ids text[]:='{}'; raw_id numeric; d date; k text; standalone boolean;
begin
  if jsonb_typeof(p_cards) is distinct from 'array' then raise sqlstate 'PT400' using message='Invalid To Do board.'; end if;
  if jsonb_array_length(p_cards)>2000 then raise sqlstate 'PT400' using message='A To Do board supports up to 2,000 cards.'; end if;
  for c in select value from jsonb_array_elements(p_cards) loop
    if jsonb_typeof(c) is distinct from 'object' then raise sqlstate 'PT400' using message='Invalid To Do card.'; end if;
    standalone:=jsonb_typeof(c->'recordId')='null';
    if not c ?& array['id','recordId','status','nextAction','notes','dueDate'] or
       (select count(*) from jsonb_object_keys(c))<>(case when standalone then 7 else 6 end) or
       jsonb_typeof(c->'id') is distinct from 'string' or c->>'id' !~ '^todo_[a-z0-9_]{1,60}$' or c->>'id'=any(ids) or
       coalesce(c->>'status','') not in ('To Do','In Progress','Done') then raise sqlstate 'PT400' using message='Invalid To Do card.'; end if;
    if standalone then
      if jsonb_typeof(c->'customTitle') is distinct from 'string' or c->>'customTitle' !~ '[^[:space:]\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]' or
         pipechat.js_length(c->>'customTitle')>500 or (c->>'customTitle') ~ U&'[\0001-\0008\000b\000c\000e-\001f\007f]' then raise sqlstate 'PT400' using message='Invalid custom card title.'; end if;
    else
      if jsonb_typeof(c->'recordId') is distinct from 'number' then raise sqlstate 'PT400' using message='Missing linked CRM record.'; end if;
      raw_id:=(c->>'recordId')::numeric;
      if raw_id<1 or raw_id>9007199254740991 or raw_id<>trunc(raw_id) or not exists(select 1 from jsonb_array_elements(p_deals) where value->'id'=c->'recordId') then raise sqlstate 'PT400' using message='Missing linked CRM record.'; end if;
    end if;
    foreach k in array array['nextAction','notes','dueDate'] loop
      if jsonb_typeof(c->k) is distinct from 'string' or (c->>k) ~ U&'[\0001-\0008\000b\000c\000e-\001f\007f]' then raise sqlstate 'PT400' using message='Invalid card text.'; end if;
    end loop;
    if pipechat.js_length(c->>'nextAction')>12000 or pipechat.js_length(c->>'notes')>16000 then raise sqlstate 'PT400' using message='Card text is too long.'; end if;
    if c->>'dueDate'<>'' then
      if c->>'dueDate' !~ '^\d{4}-\d{2}-\d{2}$' then raise sqlstate 'PT400' using message='Invalid card due date.'; end if;
      begin d:=(c->>'dueDate')::date; exception when others then raise sqlstate 'PT400' using message='Invalid card due date.'; end;
      if to_char(d,'YYYY-MM-DD')<>c->>'dueDate' then raise sqlstate 'PT400' using message='Invalid card due date.'; end if;
    end if;
    ids:=array_append(ids,c->>'id');
  end loop;
  return p_cards;
end $$;

create or replace function pipechat.prune_todo_v2() returns trigger
language plpgsql set search_path=pg_catalog as $$
begin
  select coalesce(jsonb_agg(c.value order by c.ordinality),'[]'::jsonb) into new.todo_cards_v2
    from jsonb_array_elements(new.todo_cards_v2) with ordinality c
    where c.value->'recordId'='null'::jsonb or exists(select 1 from pipechat.crm_records r where r.workspace_id=new.workspace_id and to_jsonb(r.record_id)=c.value->'recordId');
  return new;
end $$;

create or replace function public.pipechat_reset_crm(p_expected_updated_at text,p_confirm boolean) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare uid uuid:=pipechat.require_user(); wid uuid:=pipechat.workspace_for(uid); version timestamptz;
begin
  if p_confirm is distinct from true then raise sqlstate 'PT400' using message='Explicit reset confirmation is required.'; end if;
  if p_expected_updated_at is not null and (pipechat.js_length(p_expected_updated_at)>256 or p_expected_updated_at='' or p_expected_updated_at ~ U&'[\0001-\001f\007f]') then raise sqlstate 'PT400' using message='Invalid CRM version.'; end if;
  select updated_at into version from pipechat.workspaces where id=wid and owner_id=uid for update;
  if not found then raise sqlstate 'PT403' using message='Only the workspace owner can reset it.'; end if;
  if p_expected_updated_at is distinct from pipechat.timestamp_text(version) then raise sqlstate 'PT409' using message='This CRM changed in another window. Refresh before resetting.'; end if;
  delete from pipechat.crm_records where workspace_id=wid;
  update pipechat.workspace_metadata set table_schema='{"status":"pending"}'::jsonb,custom_fields='[]'::jsonb,todo_cards='[]'::jsonb,todo_cards_v2='[]'::jsonb where workspace_id=wid;
  update pipechat.workspaces set updated_at=greatest(clock_timestamp(),version+interval '1 microsecond') where id=wid;
  return pipechat.crm_snapshot_v2(wid);
end $$;
revoke all on function pipechat.validate_todo_v2(jsonb,jsonb),pipechat.prune_todo_v2() from public,anon,authenticated,service_role;
revoke all on function public.pipechat_reset_crm(text,boolean) from public,anon,authenticated,service_role;
grant execute on function public.pipechat_reset_crm(text,boolean) to authenticated;
notify pgrst,'reload schema';
commit;
