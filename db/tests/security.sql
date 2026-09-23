-- Owner-side assertions, also usable after migration in a disposable local DB.
do $$
declare item record; rpc_count integer;
begin
  select count(*) into rpc_count from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'pipechat_%';
  if rpc_count <> 6 then raise exception 'Expected exactly six public PipeChat RPCs'; end if;
  for item in select p.oid, p.proname, p.prosecdef, p.proconfig, n.nspname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'pipechat' or (n.nspname = 'public' and p.proname like 'pipechat_%') loop
    if not coalesce(item.proconfig @> array['search_path=pg_catalog'], false) then
      raise exception 'Unfixed search_path on %', item.proname;
    end if;
    if item.nspname = 'public' and not item.prosecdef then raise exception 'RPC must be security definer'; end if;
    if exists (select 1 from pg_proc p, lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where p.oid = item.oid and a.grantee = 0 and a.privilege_type = 'EXECUTE') then
      raise exception 'PUBLIC execute on %', item.proname;
    end if;
    if has_function_privilege('service_role', item.oid, 'EXECUTE') then raise exception 'Service role grant on %', item.proname; end if;
    if has_function_privilege('anon', item.oid, 'EXECUTE') <> (item.proname = 'pipechat_health') then
      raise exception 'Unexpected anonymous execute on %', item.proname;
    end if;
    if has_function_privilege('authenticated', item.oid, 'EXECUTE') <> (item.nspname = 'public') then
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
  if has_schema_privilege('anon','pipechat','USAGE') or has_schema_privilege('authenticated','pipechat','USAGE') or
    has_schema_privilege('service_role','pipechat','USAGE') then raise exception 'Private schema is accessible'; end if;
end
$$;

