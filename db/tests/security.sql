-- Owner-side assertions, also usable after migration in a disposable local DB.
do $$
declare
  item record; signature text; expected_oids oid[] := '{}'; function_oid oid;
  expected text[] := array[
    'public.pipechat_health()', 'public.pipechat_read_crm()',
    'public.pipechat_write_crm(jsonb,jsonb,jsonb,text)', 'public.pipechat_read_usage()',
    'public.pipechat_reserve_usage(uuid)', 'public.pipechat_finish_usage(uuid,text)'
  ];
begin
  -- Support older disposable fixtures without accepting missing members of an
  -- installed feature. Table/column anchors survive a dropped or renamed RPC.
  if to_regprocedure('public.pipechat_reset_crm(text,boolean)') is not null or
    exists(select 1 from pg_attribute where attrelid='pipechat.workspace_metadata'::regclass
      and attname='todo_cards' and not attisdropped) then
    expected := expected || array['public.pipechat_reset_crm(text,boolean)'];
  end if;
  if exists(select 1 from pg_attribute where attrelid='pipechat.workspace_metadata'::regclass
    and attname='todo_cards' and not attisdropped) then
    expected := expected || array['public.pipechat_write_workspace(jsonb,jsonb,jsonb,text,jsonb)'];
  end if;
  if exists(select 1 from pg_attribute where attrelid='pipechat.workspace_metadata'::regclass
    and attname='todo_cards_v2' and not attisdropped) then
    expected := expected || array['public.pipechat_read_workspace()',
      'public.pipechat_write_workspace_v2(jsonb,jsonb,jsonb,text,jsonb)', 'public.pipechat_write_todo(jsonb,text)'];
  end if;
  if to_regclass('pipechat.conversation_threads') is not null then
    expected := expected || array['public.pipechat_read_conversation(bigint)',
      'public.pipechat_write_conversation(uuid,bigint,jsonb,jsonb)',
      'public.pipechat_search_conversation(text,bigint)',
      'public.pipechat_save_conversation_memory(uuid,bigint,bigint,text)'];
  end if;
  if to_regclass('pipechat.business_workspaces') is not null then
    expected := expected || array['public.business_workspace_get(uuid)', 'public.business_workspace_list()',
      'public.business_workspace_cas(uuid,bigint,jsonb,text)',
      'public.business_workspace_share(uuid,text,text,text,text,bigint)',
      'public.business_workspace_revoke(uuid,text,text,text,bigint)',
      'public.business_workspace_history(uuid,text,bigint)'];
  end if;
  if to_regclass('pipechat.action_journal') is not null then
    expected := expected || array['public.pipechat_commit_action(text,uuid,uuid,text,text,jsonb,jsonb)',
      'public.pipechat_commit_todo_action(text,uuid,uuid,text,text,jsonb,jsonb)',
      'public.pipechat_read_action(text)', 'public.pipechat_list_actions(jsonb,integer)',
      'public.pipechat_undo_action(text,text,uuid,text)', 'public.pipechat_record_beta_event(jsonb)',
      'public.pipechat_list_beta_events(integer,uuid)'];
  end if;
  if to_regclass('pipechat.conversation_archives') is not null then
    expected := expected || array['public.pipechat_list_conversation_threads()',
      'public.pipechat_new_conversation_thread(uuid,bigint,text)',
      'public.pipechat_switch_conversation_thread(uuid,bigint,uuid)',
      'public.pipechat_complete_conversation_turn(uuid,uuid,uuid,text)',
      'public.pipechat_begin_conversation_turn(uuid,uuid,bigint,uuid,uuid,uuid,integer)',
      'public.pipechat_finish_conversation_turn(uuid,uuid,text,text,text,jsonb)',
      'public.pipechat_read_conversation_turn(uuid,uuid)',
      'public.pipechat_recover_conversation_turns(integer)'];
  end if;
  if to_regclass('pipechat.business_automations') is not null then
    expected := expected || array['public.pipechat_create_workflow(text,uuid,text,text,jsonb)',
      'public.pipechat_set_workflow_activation(text,uuid,text,text,bigint,boolean)',
      'public.pipechat_retry_workflow_event(text,uuid,text,text,text)', 'public.pipechat_read_workflows()'];
  end if;
  if to_regclass('pipechat.workspace_agent_profiles') is not null then
    expected := expected || array['public.pipechat_read_agent_profile()', 'public.pipechat_save_agent_profile(jsonb,text)'];
  end if;
  foreach signature in array expected loop
    function_oid := to_regprocedure(signature);
    if function_oid is null then raise exception 'Missing expected public RPC: %', signature; end if;
    expected_oids := array_append(expected_oids,function_oid);
  end loop;
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname ~ '^(pipechat_|business_)' and not p.oid=any(expected_oids)) then
    raise exception 'Unexpected public PipeChat/business RPC signature';
  end if;
  for item in select p.oid, p.proname, p.prosecdef, p.proconfig, p.proowner, n.nspname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'pipechat' or (n.nspname = 'public' and p.proname ~ '^(pipechat_|business_)') loop
    if not coalesce(item.proconfig @> array['search_path=pg_catalog'], false) then
      raise exception 'Unfixed search_path on %', item.proname;
    end if;
    if item.nspname = 'public' and not item.prosecdef then raise exception 'RPC must be security definer'; end if;
    if pg_has_role('anon',item.proowner,'MEMBER') or pg_has_role('authenticated',item.proowner,'MEMBER') or
      pg_has_role('service_role',item.proowner,'MEMBER') then
      raise exception 'Runtime role owns or can assume owner of %', item.proname;
    end if;
    if exists (select 1 from pg_proc p, lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where p.oid = item.oid and a.grantee = 0 and a.privilege_type = 'EXECUTE') then
      raise exception 'PUBLIC execute on %', item.proname;
    end if;
    if has_function_privilege('service_role', item.oid, 'EXECUTE') then raise exception 'Service role grant on %', item.proname; end if;
    if has_function_privilege('anon', item.oid, 'EXECUTE') <> (item.oid = 'public.pipechat_health()'::regprocedure) then
      raise exception 'Unexpected anonymous execute on %', item.proname;
    end if;
    if has_function_privilege('authenticated', item.oid, 'EXECUTE') <> (item.oid = any(expected_oids)) then
      raise exception 'Unexpected authenticated execute on %', item.proname;
    end if;
  end loop;
  for item in select c.oid, c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'pipechat' and c.relkind = 'r' loop
    if not item.relrowsecurity then raise exception 'Missing RLS on %', item.relname; end if;
    if exists (select 1 from pg_policy where polrelid = item.oid) then raise exception 'Unexpected browser RLS policy'; end if;
    if has_table_privilege('anon', item.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or
       has_table_privilege('authenticated', item.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or
       has_table_privilege('service_role', item.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
      raise exception 'Unexpected direct table privileges on %', item.relname;
    end if;
  end loop;
  for item in select c.oid,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='pipechat' and c.relkind='S' loop
    if has_sequence_privilege('anon',item.oid,'USAGE,SELECT,UPDATE') or
      has_sequence_privilege('authenticated',item.oid,'USAGE,SELECT,UPDATE') or
      has_sequence_privilege('service_role',item.oid,'USAGE,SELECT,UPDATE') then
      raise exception 'Unexpected direct sequence privileges on %', item.relname;
    end if;
  end loop;
  if has_schema_privilege('anon','pipechat','USAGE') or has_schema_privilege('authenticated','pipechat','USAGE') or
    has_schema_privilege('service_role','pipechat','USAGE') then raise exception 'Private schema is accessible'; end if;
  if has_schema_privilege('anon','pipechat','CREATE') or has_schema_privilege('authenticated','pipechat','CREATE') or
    has_schema_privilege('service_role','pipechat','CREATE') then raise exception 'Private schema is writable'; end if;
end
$$;
