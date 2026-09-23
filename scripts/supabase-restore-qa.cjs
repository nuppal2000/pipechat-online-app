'use strict';

const fs = require('node:fs/promises');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const tls = require('node:tls');
const { spawn } = require('node:child_process');
const { createHash, randomUUID, X509Certificate } = require('node:crypto');
const { Client } = require('pg');

const SOURCE = Object.freeze({ ref: 'nzktondjxxxiezkbrhdo', host: 'aws-0-us-east-1.pooler.supabase.com' });
const TARGET = Object.freeze({ ref: 'pznjcsscfthondvvdljq', host: 'aws-0-ca-central-1.pooler.supabase.com' });
const RUN = '60abf0b7-1d6c-402b-8297-dbce9727580b';
const EMAILS = ['a', 'b'].map(x => `supabase-qa-${RUN}-${x}@example.invalid`);
const ROOT = path.resolve(__dirname, '..');
const BIN = path.resolve(ROOT, '../work/pgsql/bin');
const CA_FINGERPRINT = '80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA';
const sha = value => createHash('sha256').update(value).digest('hex');
const quote = value => '"' + String(value).replaceAll('"', '""') + '"';
const fail = (message, code) => { throw Object.assign(new Error(message), { code }); };
const pass = message => console.log(`PASS: ${message}`);

function validateInput(input, expectedAuthorization = 'RESTORE') {
  if (!['RESTORE','CHECK','VERIFY','ROLLBACK'].includes(expectedAuthorization) || input?.authorization !== expectedAuthorization || input.sourceRef !== SOURCE.ref || input.targetRef !== TARGET.ref || SOURCE.ref === TARGET.ref) fail('Fixed restore consent/project check failed.');
  for (const name of ['sourcePassword', 'targetPassword']) {
    if (typeof input[name] !== 'string' || input[name].length < 8 || input[name].length > 512 || /[\r\n\0]/.test(input[name])) fail('Invalid private database password input.');
  }
  return input;
}

function cleanEnvironment() {
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key];
  return env;
}

function pgEnvironment(project, password, caFile, readOnly = false) {
  if (project !== SOURCE && project !== TARGET) fail('Unknown database destination.');
  return { ...cleanEnvironment(), PGHOST: project.host, PGPORT: '5432', PGDATABASE: 'postgres',
    PGUSER: `postgres.${project.ref}`, PGPASSWORD: password, PGSSLMODE: 'verify-full', PGSSLROOTCERT: caFile,
    PGCONNECT_TIMEOUT: '20', PGAPPNAME: 'pipechat-private-restore-qa',
    PGOPTIONS: `-c statement_timeout=120000 -c lock_timeout=10000${readOnly ? ' -c default_transaction_read_only=on' : ''}` };
}

async function command(executable, args, env, timeout = 180000) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; let size = 0, failed = false;
    const diagnostic = createToolDiagnostic();
    const timer = setTimeout(() => { failed = true; child.kill(); }, timeout);
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 16 * 1024 * 1024) { failed = true; child.kill(); } else chunks.push(chunk); });
    // Never retain/relay provider messages, COPY values or statement text.
    child.stderr.on('data', chunk => diagnostic.feed(chunk));
    child.once('error', () => { clearTimeout(timer); reject(new Error('Database tool could not start.')); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0 || failed) reject(Object.assign(new Error('Database tool failed; raw details withheld.'), { safeDiagnostic: diagnostic.finish() }));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

function databaseFailure(code) {
  return new Map([
    ['42501','DATABASE_PERMISSION_DENIED'], ['23505','UNIQUE_CONSTRAINT'],
    ['23503','FOREIGN_KEY_CONSTRAINT'], ['23502','NOT_NULL_CONSTRAINT'], ['23514','CHECK_CONSTRAINT'],
    ['42P01','MISSING_TABLE'], ['42704','MISSING_OBJECT'], ['42710','DUPLICATE_OBJECT'],
    ['42P07','DUPLICATE_TABLE'], ['42601','SQL_SYNTAX'], ['P0001','DATABASE_ASSERTION'],
    ['57014','QUERY_CANCELLED'], ['55P03','LOCK_UNAVAILABLE'], ['25P02','TRANSACTION_ABORTED'],
    ['QA_MANIFEST','INVALID_BACKUP_MANIFEST'], ['QA_ARCHIVE','BACKUP_ARCHIVE_HASH_MISMATCH'],
    ['QA_INVENTORY','RESTORED_TABLE_INVENTORY_MISMATCH'], ['QA_AUTH','RESTORED_AUTH_DATA_MISMATCH'],
    ['QA_CRM','RESTORED_CRM_DATA_MISMATCH'], ['QA_SEQUENCE','RESTORED_SEQUENCE_MISMATCH'],
    ['QA_BASELINE','SOURCE_SCHEMA_CHANGED_SINCE_BACKUP'], ['QA_SCHEMA','RESTORED_SCHEMA_OR_GRANTS_MISMATCH'],
    ['QA_DEFAULTS','MANAGED_DEFAULT_PRIVILEGES_MISMATCH'], ['QA_LOCK','ANOTHER_RECOVERY_RUN_IS_ACTIVE'],
    ['QA_IDENTITIES','UNEXPECTED_RESTORE_QA_IDENTITIES'], ['QA_PROBE','EXPECTED_LATE_FAILURE_NOT_OBSERVED'],
    ['QA_CLEANUP','ROLLBACK_CLEANUP_MISMATCH']
  ]).get(code) || 'UNCLASSIFIED_DATABASE_ERROR';
}

function createToolDiagnostic() {
  let pending = '', truncated = false, result = 'UNCLASSIFIED_DATABASE_ERROR';
  const phases = new Map([
    ['target-guard.sql','DESTINATION_GUARD'], ['pre-data.sql','SCHEMA'], ['data.sql','DATA'],
    ['post-data.sql','CONSTRAINTS_AND_GRANTS'], ['signup-trigger.sql','SIGNUP_TRIGGER'], ['security.sql','SECURITY_CHECK']
  ]);
  function line(value) {
    const match = /^(?:psql:(.*?):[0-9]+:\s*)?(?:ERROR|FATAL|PANIC):\s+([0-9A-Z]{5})\s*$/.exec(value.trim());
    if (!match || result !== 'UNCLASSIFIED_DATABASE_ERROR') return;
    const phase = phases.get(path.win32.basename(match[1] || '')) || 'DATABASE_COMMAND';
    result = `${phase}; ${databaseFailure(match[2])}`;
  }
  return {
    feed(chunk) {
      for (const part of chunk.toString('utf8').split(/(?<=\n)/)) {
        if (!truncated && pending.length + part.length <= 2048) pending += part;
        else { pending = ''; truncated = true; }
        if (part.endsWith('\n')) { if (!truncated) line(pending); pending = ''; truncated = false; }
      }
    },
    finish() { if (!truncated) line(pending); pending = ''; return result; }
  };
}

function verifyDatabaseCa(pem, now = Date.now()) {
  const cert = new X509Certificate(pem);
  if (cert.fingerprint256 !== CA_FINGERPRINT || !cert.ca || !cert.verify(cert.publicKey) ||
    !Number.isFinite(now) || now < Date.parse(cert.validFrom) || now >= Date.parse(cert.validTo)) fail('Official database CA validation failed.');
  return pem;
}

function databaseCa() {
  const pem = verifyDatabaseCa(readFileSync(path.join(__dirname,'certs/supabase-prod-ca-2021.crt'),'utf8'));
  return [...tls.rootCertificates,pem];
}

function connectionConfig(project, password) {
  if (project !== SOURCE && project !== TARGET) fail('Unknown database destination.');
  return { host: project.host, port: 5432, database: 'postgres', user: `postgres.${project.ref}`, password,
    ssl: { rejectUnauthorized: true, ca: databaseCa() }, connectionTimeoutMillis: 20000,
    statement_timeout: 120000, lock_timeout: 10000, application_name: 'pipechat-private-restore-qa' };
}

function connectionFailure(error) {
  const categories = new Map([
    ['28P01','DATABASE_PASSWORD_REJECTED'], ['28000','DATABASE_AUTHORIZATION_REJECTED'],
    ['ENOTFOUND','DNS_LOOKUP_FAILED'], ['EAI_AGAIN','DNS_LOOKUP_FAILED'],
    ['ECONNREFUSED','CONNECTION_REFUSED'], ['ETIMEDOUT','CONNECTION_TIMEOUT'],
    ['ECONNRESET','CONNECTION_RESET'], ['ENETUNREACH','NETWORK_UNREACHABLE'], ['EHOSTUNREACH','NETWORK_UNREACHABLE'],
    ['SELF_SIGNED_CERT_IN_CHAIN','TLS_CA_NOT_TRUSTED'], ['DEPTH_ZERO_SELF_SIGNED_CERT','TLS_CA_NOT_TRUSTED'],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE','TLS_CA_NOT_TRUSTED'], ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY','TLS_CA_NOT_TRUSTED'],
    ['CERT_HAS_EXPIRED','TLS_CERTIFICATE_EXPIRED'], ['ERR_TLS_CERT_ALTNAME_INVALID','TLS_HOSTNAME_MISMATCH'],
    ['53300','DATABASE_CONNECTION_LIMIT'], ['57P03','DATABASE_NOT_READY'], ['42501','DATABASE_PERMISSION_DENIED']
  ]);
  return categories.get(error?.code) || (error?.message === 'Connection terminated due to connection timeout' ? 'CONNECTION_TIMEOUT' : 'UNCLASSIFIED_CONNECTION_ERROR');
}

async function connectChecked(db) {
  await db.connect();
  const result = await db.query('select 1 as healthy');
  if (result.rows?.[0]?.healthy !== 1) fail('Database read check failed.');
}

function filterSchemaList(list, managedDefaultsVerified = false) {
  if (!list.includes('SCHEMA - pipechat ') || !list.includes('FUNCTION public pipechat_read_crm()')) fail('Unexpected schema archive.');
  return list.split(/\r?\n/).filter(line => {
    if (/^\d+; \d+ \d+ (?:SCHEMA - public |COMMENT - SCHEMA public )/.test(line)) return false;
    // Supabase owns these defaults. They must already match; never try to impersonate its admin role.
    if (/^\d+; \d+ \d+ DEFAULT ACL public DEFAULT PRIVILEGES FOR (?:SEQUENCES|FUNCTIONS|TABLES) supabase_admin$/.test(line)) {
      if (managedDefaultsVerified !== true) fail('Managed default privileges were not verified.');
      return false;
    }
    return true;
  }).join('\n');
}

async function managedPublicDefaults(db) {
  return (await db.query(`select d.defaclobjtype as type,
    jsonb_agg(jsonb_build_object('grantor',pg_get_userbyid(a.grantor),
      'grantee',case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
      'privilege',a.privilege_type,'grantable',a.is_grantable)
      order by a.grantee=0,pg_get_userbyid(a.grantee),a.privilege_type,pg_get_userbyid(a.grantor),a.is_grantable) as grants
    from pg_default_acl d join pg_namespace n on n.oid=d.defaclnamespace
    cross join lateral aclexplode(d.defaclacl) a
    where n.nspname='public' and d.defaclrole='supabase_admin'::regrole
    group by d.defaclobjtype order by d.defaclobjtype`)).rows;
}

async function verifyManagedDefaults(source, target, expected) {
  const before = expected || await managedPublicDefaults(source);
  if (!before.length || JSON.stringify(before) !== JSON.stringify(await managedPublicDefaults(target))) {
    fail('Managed default privileges differ; provider review required.', 'QA_DEFAULTS');
  }
  return before;
}

async function tableInventory(db, schemas) {
  return (await db.query(`select n.nspname as schema,c.relname as name from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname=any($1::text[]) and c.relkind='r' and not(n.nspname='auth' and c.relname='schema_migrations') order by 1,2`, [schemas])).rows;
}

async function fingerprints(db, tables) {
  const result = [];
  for (const table of tables) {
    const qualified = `${quote(table.schema)}.${quote(table.name)}`;
    const { rows } = await db.query(`select count(*)::int as count, coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb)::text as data from ${qualified} t`);
    result.push({ ...table, count: rows[0].count, sha256: sha(rows[0].data) });
  }
  return result;
}

async function sequenceState(db) {
  const sequences=(await db.query("select schemaname,sequencename from pg_sequences where schemaname in ('auth','pipechat') order by 1,2")).rows;
  const result=[];
  for(const seq of sequences) {
    const state=(await db.query(`select last_value::text,is_called from ${quote(seq.schemaname)}.${quote(seq.sequencename)}`)).rows[0];
    result.push({...seq,...state});
  }
  return result;
}

function aclExpression(acl, owner, type) {
  return `(select coalesce(jsonb_agg(jsonb_build_object(
    'grantor',pg_get_userbyid(a.grantor),'grantee',case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
    'privilege',a.privilege_type,'grantable',a.is_grantable)
    order by a.grantee=0,pg_get_userbyid(a.grantee),a.privilege_type,pg_get_userbyid(a.grantor),a.is_grantable),'[]'::jsonb)
    from aclexplode(coalesce(${acl},acldefault('${type}',${owner}))) a)`;
}

async function definitions(db, { canonicalAcls = false } = {}) {
  // A null ACL means built-in defaults, not an empty grant set. Preserve all
  // effective grants and grant options while ignoring their storage/order.
  const functionAcl = canonicalAcls ? aclExpression('p.proacl','p.proowner','f') : 'p.proacl::text';
  const tableAcl = canonicalAcls ? aclExpression('c.relacl','c.relowner','r') : 'c.relacl::text';
  const schemaAcl = canonicalAcls ? `jsonb_build_object('owner',pg_get_userbyid(nspowner),'grants',${aclExpression('nspacl','nspowner','n')})` : 'nspacl::text';
  const { rows } = await db.query(`select jsonb_build_object(
    'functions',(select jsonb_agg(jsonb_build_object('schema',n.nspname,'name',p.proname,'args',pg_get_function_identity_arguments(p.oid),
      'definition',pg_get_functiondef(p.oid),'owner',pg_get_userbyid(p.proowner),'acl',${functionAcl}) order by n.nspname,p.proname,pg_get_function_identity_arguments(p.oid))
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='pipechat' or (n.nspname='public' and p.proname like 'pipechat_%')),
    'columns',(select jsonb_agg(jsonb_build_object('table',c.relname,'name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'null',a.attnotnull,
      'default',pg_get_expr(d.adbin,d.adrelid)) order by c.relname,a.attnum) from pg_attribute a join pg_class c on c.oid=a.attrelid
      join pg_namespace n on n.oid=c.relnamespace left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum
      where n.nspname='pipechat' and c.relkind='r' and a.attnum>0 and not a.attisdropped),
    'tables',(select jsonb_agg(jsonb_build_object('name',c.relname,'rls',c.relrowsecurity,'forced',c.relforcerowsecurity,
      'owner',pg_get_userbyid(c.relowner),'acl',${tableAcl}) order by c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='pipechat' and c.relkind='r'),
    'constraints',(select jsonb_agg(jsonb_build_object('table',c.relname,'name',con.conname,'def',pg_get_constraintdef(con.oid)) order by c.relname,con.conname)
      from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='pipechat'),
    'indexes',(select jsonb_agg(jsonb_build_object('name',indexname,'def',indexdef) order by indexname) from pg_indexes where schemaname='pipechat'),
    'schemaAcl',(select ${schemaAcl} from pg_namespace where nspname='pipechat'),
    'trigger',(select pg_get_triggerdef(oid) from pg_trigger where tgrelid='auth.users'::regclass and tgname='pipechat_auth_user_created')
  )::text as data`);
  return sha(rows[0].data);
}

function validateManifest(manifest) {
  const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const identifier = value => typeof value === 'string' && /^[a-z_][a-z0-9_]{0,62}$/.test(value);
  if (!manifest || manifest.source !== SOURCE.ref || manifest.target !== TARGET.ref ||
      ![1,2].includes(manifest.schemaFingerprintVersion ?? 1) || !hash(manifest.schemaHash) ||
      !hash(manifest.archives?.schema) || !hash(manifest.archives?.data) ||
      !Array.isArray(manifest.tables) || manifest.tables.length < 7 || manifest.tables.length > 100 ||
      !Array.isArray(manifest.sequences) || manifest.sequences.length > 100 ||
      !Array.isArray(manifest.managedDefaults) || !manifest.managedDefaults.length || manifest.managedDefaults.length > 10) {
    fail('Unexpected backup manifest.', 'QA_MANIFEST');
  }
  const names = new Set();
  for (const table of manifest.tables) {
    const key = `${table.schema}.${table.name}`;
    if (!['auth','pipechat'].includes(table.schema) || !identifier(table.name) || key === 'auth.schema_migrations' ||
        names.has(key) || !Number.isSafeInteger(table.count) || table.count < 0 || !hash(table.sha256)) fail('Invalid table inventory.', 'QA_MANIFEST');
    names.add(key);
  }
  const sequences = new Set();
  for (const seq of manifest.sequences) {
    const key = `${seq.schemaname}.${seq.sequencename}`;
    if (!['auth','pipechat'].includes(seq.schemaname) || !identifier(seq.sequencename) || sequences.has(key) ||
        typeof seq.last_value !== 'string' || !/^-?[0-9]{1,20}$/.test(seq.last_value) || typeof seq.is_called !== 'boolean') fail('Invalid sequence inventory.', 'QA_MANIFEST');
    sequences.add(key);
  }
  return manifest;
}

async function loadVerificationManifest(directory) {
  const base = path.resolve(os.homedir(), 'AppData', 'Local', 'PipeChat', 'Recovery');
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) fail('Private backup directory required.', 'QA_MANIFEST');
  const resolved = path.resolve(directory);
  if (path.dirname(resolved).toLowerCase() !== base.toLowerCase() || !/^supabase-restore-[A-Za-z0-9]{6}$/.test(path.basename(resolved)) ||
      (await fs.lstat(resolved)).isSymbolicLink() || (await fs.realpath(resolved)).toLowerCase() !== resolved.toLowerCase()) fail('Unexpected backup directory.', 'QA_MANIFEST');
  async function read(name, maxBytes) {
    const file = path.join(resolved,name), stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) fail('Unexpected backup file.', 'QA_MANIFEST');
    return fs.readFile(file);
  }
  const manifest = validateManifest(JSON.parse((await read('manifest.json',1024*1024)).toString('utf8')));
  for (const name of ['schema','data']) {
    if (sha(await read(name+'.dump',128*1024*1024)) !== manifest.archives[name]) fail('Archive integrity failed.', 'QA_ARCHIVE');
  }
  return manifest;
}

async function verifyRestoredSnapshot(source, target, manifest, log = pass) {
  validateManifest(manifest);
  const tables = await tableInventory(target,['auth','pipechat']);
  const expectedNames = manifest.tables.map(t=>`${t.schema}.${t.name}`).sort();
  if (JSON.stringify(tables.map(t=>`${t.schema}.${t.name}`).sort()) !== JSON.stringify(expectedNames)) fail('Restored table inventory differs.', 'QA_INVENTORY');
  const actual = new Map((await fingerprints(target,tables)).map(t=>[`${t.schema}.${t.name}`,t]));
  for (const schema of ['auth','pipechat']) {
    const expected = manifest.tables.filter(t=>t.schema===schema);
    if (expected.some(t=>{ const found=actual.get(`${t.schema}.${t.name}`); return found.count!==t.count || found.sha256!==t.sha256; })) {
      fail('Restored table data differs from the captured snapshot.', schema==='auth'?'QA_AUTH':'QA_CRM');
    }
    log(`${schema === 'auth' ? 'Auth' : 'PipeChat CRM'} full-field read-back matches the backup snapshot.`);
  }
  if (JSON.stringify(manifest.sequences) !== JSON.stringify(await sequenceState(target))) fail('Restored sequence counters differ.', 'QA_SEQUENCE');
  log('Restored sequence counters match the backup.');
  let expectedSchema = manifest.schemaHash;
  if ((manifest.schemaFingerprintVersion ?? 1) === 1) {
    // Legacy manifests stored raw ACL text. Only use the live source as a
    // canonical baseline when its original fingerprint still matches the backup.
    if (!source || manifest.schemaHash !== await definitions(source)) fail('Source schema no longer matches the original backup.', 'QA_BASELINE');
    expectedSchema = await definitions(source,{canonicalAcls:true});
    log('Original source schema still matches the backup; comparing normalized effective grants.');
  }
  if (expectedSchema !== await definitions(target,{canonicalAcls:true})) fail('Restored definitions or effective grants differ.', 'QA_SCHEMA');
  log('Function bodies, columns, constraints, indexes, ownership, RLS, effective grants and signup trigger match.');
  await verifyManagedDefaults(null,target,manifest.managedDefaults);
  log('Provider-managed default privileges remain unchanged.');
  // Normalize only in memory for post-probe checks after disconnecting the source.
  return {...manifest,schemaFingerprintVersion:2,schemaHash:expectedSchema};
}

async function verifyExistingRestore(source, target, directory) {
  const manifest = await loadVerificationManifest(directory);
  pass('Private backup manifest and both native archive hashes verified; no backup contents printed.');
  await source.query('begin isolation level repeatable read read only');
  await target.query('begin isolation level repeatable read read only');
  let verified;
  try {
    verified = await verifyRestoredSnapshot(source,target,manifest);
    await target.query(await fs.readFile(path.join(ROOT,'db/tests/security.sql'),'utf8'));
    pass('Restored database security assertions passed inside a read-only transaction.');
  } finally {
    await target.query('rollback');
    await source.query('rollback');
  }
  pass('Read-only restore verification complete. No restore replay, database writes, rollback probes or deployment performed.');
  return verified;
}

async function authColumns(db) {
  return (await db.query(`select c.relname,a.attname,format_type(a.atttypid,a.atttypmod) as type,a.attnotnull,a.attgenerated
    from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='auth' and c.relkind='r' and c.relname<>'schema_migrations' and a.attnum>0 and not a.attisdropped order by c.relname,a.attnum`)).rows;
}

async function assertEmptyTarget(db) {
  const { rows } = await db.query(`select to_regnamespace('pipechat') is null as empty_schema,
    not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'pipechat_%') as empty_rpc,
    not exists(select 1 from storage.objects) and not exists(select 1 from storage.buckets) as empty_storage,
    not exists(select 1 from pg_trigger where tgrelid='auth.users'::regclass and tgname='pipechat_auth_user_created') as empty_trigger,
    not exists(select 1 from pg_tables where schemaname='public') as empty_public,
    not exists(select 1 from vault.secrets) as empty_vault`);
  if (!rows[0].empty_schema || !rows[0].empty_rpc || !rows[0].empty_storage || !rows[0].empty_trigger || !rows[0].empty_public || !rows[0].empty_vault) fail('Restore destination is not empty. Nothing may be overwritten.');
  const auth = await fingerprints(db, await tableInventory(db, ['auth']));
  if (auth.some(t => t.count !== 0)) fail('Restore destination contains Auth data. Nothing may be overwritten.');
}

async function forcedRollback(db, log=pass) {
  const tables = await tableInventory(db, ['pipechat']);
  const before = await fingerprints(db, tables);
  await db.query('begin');
  try {
    const users = (await db.query('select id,email from auth.users order by email')).rows;
    if (JSON.stringify(users.map(user=>user.email)) !== JSON.stringify(EMAILS)) fail('Restore target must contain only the two fixed QA identities.', 'QA_IDENTITIES');
    const uid = users[0].id, sid = randomUUID();
    await db.query('insert into auth.sessions(id,user_id,created_at,updated_at) values ($1,$2,now(),now())', [sid, uid]);
    await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: uid, session_id: sid, role: 'authenticated' })]);
    // Inject an actual constraint violation after the real RPC has written records,
    // metadata or a reservation. The outer transaction removes all test hooks.
    await db.query(`create function pipechat.qa_force_rollback() returns trigger language plpgsql set search_path=pg_catalog as $$
      begin
        if current_setting('pipechat.qa_failure',true)='on' then
          insert into pipechat.schema_version(singleton,version) values(true,1);
        end if;
        return new;
      end $$;
      create trigger qa_crm_rollback after update on pipechat.workspaces for each row execute function pipechat.qa_force_rollback();
      create trigger qa_usage_rollback after update on pipechat.usage_counters for each row execute function pipechat.qa_force_rollback();`);
    const rpc = async (sql, values = []) => {
      await db.query('set local role authenticated');
      return (await db.query(sql, values)).rows[0].result;
    };
    const snapshot = await rpc('select public.pipechat_read_crm() as result');
    await db.query('reset role');
    async function expectRollback(label, sql, values) {
      const start = await fingerprints(db, tables);
      await db.query('savepoint forced_failure');
      let expected = false;
      try {
        await db.query("set local pipechat.qa_failure='on'");
        await rpc(sql, values);
      } catch (error) { expected = error.code === '23505' && error.constraint === 'schema_version_pkey'; }
      await db.query('rollback to savepoint forced_failure');
      await db.query('release savepoint forced_failure');
      if (!expected) fail(`${label}: the expected late constraint failure did not occur.`, 'QA_PROBE');
      if (JSON.stringify(start) !== JSON.stringify(await fingerprints(db, tables))) fail(`${label}: partial writes detected.`, 'QA_CLEANUP');
      log(`${label}; all application rows, metadata, versions and counters unchanged.`);
    }
    const changed = structuredClone(snapshot.deals);
    if (!changed.length) fail('Restored QA A has no rows.');
    changed[0].activity = 'QA forced rollback must not persist';
    await expectRollback('Late CRM rollback', 'select public.pipechat_write_crm($1,$2,$3,$4) as result',
      [JSON.stringify(changed), JSON.stringify(snapshot.customFields), JSON.stringify(snapshot.tableSchema), snapshot.updatedAt]);
    await expectRollback('Late reservation rollback', 'select public.pipechat_reserve_usage($1) as result', [randomUUID()]);
    const reserve = await rpc('select public.pipechat_reserve_usage($1) as result', [randomUUID()]);
    await db.query('reset role');
    await expectRollback('Late usage commit rollback', 'select public.pipechat_finish_usage($1,$2) as result', [reserve.reservationId, 'commit']);
    const fresh=randomUUID();
    await db.query('insert into auth.users(id,email) values($1,$2)',[fresh,`restore-trigger-${fresh}@example.invalid`]);
    const provisioned=(await db.query(`select m.table_schema,c.used,c.reserved,c.quota_limit,
      (select count(*)::int from pipechat.crm_records r where r.workspace_id=w.id) as records
      from pipechat.workspaces w join pipechat.memberships membership on membership.workspace_id=w.id and membership.user_id=w.owner_id and membership.role='owner'
      join pipechat.workspace_metadata m on m.workspace_id=w.id join pipechat.usage_counters c on c.user_id=w.owner_id where w.owner_id=$1`,[fresh])).rows;
    if(provisioned.length!==1 || provisioned[0].table_schema.status!=='pending'||Number(provisioned[0].used)!==0||Number(provisioned[0].reserved)!==0||Number(provisioned[0].quota_limit)!==1000||provisioned[0].records!==0) fail('Restored signup trigger did not provision an empty workspace correctly.');
    log('Restored signup trigger provisioned empty onboarding, owner membership and 1000-chat allowance inside the rollback-only transaction.');
  } finally { await db.query('rollback'); }
  if (JSON.stringify(before) !== JSON.stringify(await fingerprints(db, tables))) fail('Rollback test cleanup differs from restored data.', 'QA_CLEANUP');
  const hooks = await db.query("select count(*)::int as n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='pipechat' and p.proname='qa_force_rollback'");
  if (hooks.rows[0].n !== 0) fail('Rollback hook remained.', 'QA_CLEANUP');
  log('Rollback test hooks, temporary session and temporary signup removed; no chat charged. Database-level test only, not a live HTTP signup.');
}

async function main(input, { connectionsOnly = false, verifyOnly = false, rollbackOnly = false } = {}) {
  if ([connectionsOnly,verifyOnly,rollbackOnly].filter(Boolean).length > 1) fail('Choose only one private runner mode.');
  validateInput(input, connectionsOnly ? 'CHECK' : verifyOnly ? 'VERIFY' : rollbackOnly ? 'ROLLBACK' : 'RESTORE');
  if (process.platform !== 'win32') fail('This private runner is restricted to the reviewed Windows setup.');
  let stage = 'private connection setup', checkingConnections = true;
  let dir, source, target, restoreAttempted = false, targetSequencesBefore;
  try {
    source = new Client(connectionConfig(SOURCE, input.sourcePassword));
    target = new Client(connectionConfig(TARGET, input.targetPassword));
    stage = 'source database connection';
    await connectChecked(source);
    pass('Source verified TLS, database login and read-only health query.');
    stage = 'restore QA database connection';
    await connectChecked(target);
    pass('Restore QA verified TLS, database login and read-only health query.');
    if (connectionsOnly) {
      pass('Connection-only check complete. No backup, restore, database writes or deployment performed.');
      return;
    }
    checkingConnections = false;
    if (verifyOnly) {
      stage = 'read-only existing restore verification';
      await verifyExistingRestore(source,target,input.backupDirectory);
      return;
    }
    if (rollbackOnly) {
      stage = 'exclusive QA recovery runner guard';
      const lock = await target.query("select pg_try_advisory_lock(hashtext('pipechat-restore-qa')) as acquired");
      if (lock.rows[0]?.acquired !== true) fail('Another recovery runner holds the QA lock.', 'QA_LOCK');
      stage = 'read-only pre-rollback backup verification';
      const manifest = await verifyExistingRestore(source,target,input.backupDirectory);
      stage = 'source disconnect before QA probes';
      await source.end();
      source = null;
      input.sourcePassword = '';
      pass('Source database disconnected. All fault probes are restricted to the fixed Restore QA project.');
      stage = 'forced rollback in existing restored QA database';
      await forcedRollback(target);
      stage = 'post-rollback full restored snapshot and security verification';
      await target.query('begin isolation level repeatable read read only');
      try {
        await verifyRestoredSnapshot(null,target,manifest);
        await target.query(await fs.readFile(path.join(ROOT,'db/tests/security.sql'),'utf8'));
      } finally { await target.query('rollback'); }
      pass('Post-rollback Auth, CRM, sequences, schema, grants and security checks match the original backup.');
      pass('HOSTED ROLLBACK CHECKS PASSED. No restore replay, persistent QA edits, source writes, OpenAI calls or deployment.');
      return;
    }
    stage = 'read-only snapshot setup';
    await source.query('begin isolation level repeatable read read only');
    await target.query("select pg_advisory_lock(hashtext('pipechat-restore-qa'))");
    stage = 'empty destination and source inventory';
    await assertEmptyTarget(target);
    const users = (await source.query('select email from auth.users order by email')).rows.map(x => x.email);
    if (JSON.stringify(users) !== JSON.stringify(EMAILS)) fail('Source is no longer the two disposable QA accounts.');
    const counts = (await source.query(`select (select count(*) from storage.objects)::int as objects,
      (select count(*) from storage.buckets)::int as buckets,(select count(*) from vault.secrets)::int as secrets,
      (select count(*) from pg_tables where schemaname='public')::int as public_tables`)).rows[0];
    if (Object.values(counts).some(n => n !== 0)) fail('Source scope expanded; review storage/vault/public tables before backup.');
    if (JSON.stringify(await authColumns(source)) !== JSON.stringify(await authColumns(target))) fail('Managed Auth schemas differ; review provider versions first.');
    const customRoles = await source.query(`select rolname from pg_roles where rolname not like 'pg_%' order by rolname`);
    const targetRoles = await target.query(`select rolname from pg_roles where rolname not like 'pg_%' order by rolname`);
    if (JSON.stringify(customRoles.rows) !== JSON.stringify(targetRoles.rows)) fail('Role inventory differs; no automatic role creation is permitted.');
    const managedDefaults = await verifyManagedDefaults(source, target);
    pass('Source and destination managed public defaults match; provider-owned defaults will remain untouched.');
    const tables = await tableInventory(source, ['pipechat','auth']);
    const expected = await fingerprints(source, tables);
    const expectedSequences = await sequenceState(source);
    const schemaHash = await definitions(source,{canonicalAcls:true});
    const trigger = (await source.query("select pg_get_triggerdef(oid) as ddl from pg_trigger where tgrelid='auth.users'::regclass and tgname='pipechat_auth_user_created'")).rows[0]?.ddl;
    if (!trigger || !trigger.includes('pipechat.on_auth_user_created()')) fail('Expected signup trigger missing.');
    const snapshot = (await source.query('select pg_export_snapshot() as id')).rows[0].id;
    if (!/^[A-F0-9-]+$/i.test(snapshot)) fail('Invalid exported snapshot.');
    pass('Fixed source/empty restore project verified; TLS verified; read-only coherent source snapshot opened.');

    stage = 'private backup directory';
    const base = path.join(os.homedir(), 'AppData', 'Local', 'PipeChat', 'Recovery');
    await fs.mkdir(base, { recursive: true });
    dir = await fs.mkdtemp(path.join(base, 'supabase-restore-'));
    const identity = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
    if (!process.env.USERDOMAIN || !process.env.USERNAME) fail('Cannot restrict backup directory to the current user.');
    await command('icacls.exe', [dir, '/inheritance:r', '/grant:r', `${identity}:(OI)(CI)F`], cleanEnvironment());
    const file = name => path.join(dir, name);
    const caFile = file('public-root-certificates.pem');
    await fs.writeFile(caFile, databaseCa().join('\n') + '\n', { flag: 'wx' });
    const srcEnv = pgEnvironment(SOURCE, input.sourcePassword, caFile, true);
    const dstEnv = pgEnvironment(TARGET, input.targetPassword, caFile);
    const dump = path.join(BIN,'pg_dump.exe'), restore = path.join(BIN,'pg_restore.exe'), psql = path.join(BIN,'psql.exe');
    stage = 'native PostgreSQL backup';
    await command(dump, ['--no-password','--format=custom','--schema-only','--schema=pipechat','--schema=public',`--snapshot=${snapshot}`,`--file=${file('schema.dump')}`], srcEnv);
    await command(dump, ['--no-password','--format=custom','--data-only','--schema=pipechat','--schema=auth','--exclude-table-data=auth.schema_migrations',`--snapshot=${snapshot}`,`--file=${file('data.dump')}`], srcEnv);
    const list = filterSchemaList(await command(restore,['--list',file('schema.dump')],cleanEnvironment()), true);
    await fs.writeFile(file('schema.list'),list,{flag:'wx'});
    for (const section of ['pre-data','post-data']) await command(restore,[`--section=${section}`,`--use-list=${file('schema.list')}`,`--file=${file(section+'.sql')}`,file('schema.dump')],cleanEnvironment());
    await command(restore,[`--file=${file('data.sql')}`,file('data.dump')],cleanEnvironment());
    await fs.writeFile(file('signup-trigger.sql'),trigger+';\n',{flag:'wx'});
    await fs.writeFile(file('target-guard.sql'),`do $$ begin
      if to_regnamespace('pipechat') is not null or exists(select 1 from auth.users) then
        raise exception 'Restore destination is not empty';
      end if;
    end $$;\n`,{flag:'wx'});
    await fs.copyFile(path.join(ROOT,'db/tests/security.sql'),file('security.sql'));
    const manifest = {source:SOURCE.ref,target:TARGET.ref,timestamp:new Date().toISOString(),tables:expected,sequences:expectedSequences,schemaHash,schemaFingerprintVersion:2,
      archives:{schema:sha(await fs.readFile(file('schema.dump'))),data:sha(await fs.readFile(file('data.dump')))},managedDefaults,
      scope:'PipeChat schema/functions/ACLs/trigger plus Auth and all PipeChat data. Managed Auth schema is provided by destination. No storage objects or Vault secrets exist. Project settings/API keys/SMTP/edge functions are not included.'};
    await fs.writeFile(file('manifest.json'),JSON.stringify(manifest,null,2),{flag:'wx'});
    await source.query('rollback');
    pass('Native schema/data archives created from one source snapshot; private backup includes Auth password hashes.');

    stage = 'atomic restore into QA destination';
    await assertEmptyTarget(target);
    await verifyManagedDefaults(null, target, managedDefaults);
    targetSequencesBefore = await sequenceState(target);
    restoreAttempted = true;
    await command(psql,['-X','--no-password','--single-transaction','--set=ON_ERROR_STOP=1','--set=VERBOSITY=sqlstate','--set=SHOW_CONTEXT=never',
      `--file=${file('target-guard.sql')}`,'--command=SET LOCAL session_replication_role = replica',`--file=${file('pre-data.sql')}`,`--file=${file('data.sql')}`,
      `--file=${file('post-data.sql')}`,`--file=${file('signup-trigger.sql')}`,'--command=SET LOCAL session_replication_role = origin',
      `--file=${file('security.sql')}`],dstEnv);
    stage = 'restored read-back and permissions';
    await target.query('begin isolation level repeatable read read only');
    try { await verifyRestoredSnapshot(null,target,manifest); }
    finally { await target.query('rollback'); }
    stage = 'forced rollback in restored QA database';
    await forcedRollback(target);
    console.log(`BACKUP: ${dir}`);
    console.log('RESTORE DATABASE CHECKS PASSED. Browser login/signup/email/project-settings checks are separate. No live app settings changed.');
  } catch (error) {
    if (checkingConnections) console.log(`FAIL: ${stage}; ${connectionFailure(error)}. No backup or restore started.`);
    else {
      console.log(`FAIL: ${stage}; ${error.safeDiagnostic || databaseFailure(error.code)}. Raw database output withheld. Do not rerun into a nonempty destination.`);
      if (restoreAttempted && stage === 'atomic restore into QA destination') {
        try {
          await assertEmptyTarget(target);
          pass('Failure read-back: no PipeChat schema/RPC/trigger, public tables, Auth rows, Storage data or Vault secrets remain.');
          if (JSON.stringify(targetSequencesBefore) === JSON.stringify(await sequenceState(target))) pass('Destination sequence state unchanged.');
          else console.log('FAIL: Destination sequence state changed; sequence setters are not transactional. No automatic reset performed.');
        } catch { console.log('FAIL: Destination emptiness could not be verified. Do not rerun or reset it.'); }
      }
    }
    if (dir) console.log(`BACKUP: ${dir}`);
    process.exitCode = 1;
  } finally {
    input.sourcePassword = ''; input.targetPassword = '';
    if (source) await source.end().catch(()=>{});
    if (target) await target.end().catch(()=>{});
  }
}

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    if (args[0] !== '--approved-qa' || !(args.length === 1 || args.length === 2 && ['--connections-only','--verify-only','--rollback-only'].includes(args[1]))) fail('Explicit opt-in required.');
    let input=''; for await (const chunk of process.stdin) { input+=chunk; if(input.length>8192) fail('Input too large.'); }
    const parsed=JSON.parse(input); input=''; await main(parsed,{connectionsOnly:args.includes('--connections-only'),verifyOnly:args.includes('--verify-only'),rollbackOnly:args.includes('--rollback-only')});
  })().catch(()=>{ console.log('FAIL: Restore runner refused input. No raw details printed.'); process.exitCode=1; });
}
module.exports={SOURCE,TARGET,EMAILS,validateInput,pgEnvironment,filterSchemaList,forcedRollback,main,
  verifyDatabaseCa,databaseCa,connectionConfig,connectionFailure,connectChecked,
  databaseFailure,createToolDiagnostic,managedPublicDefaults,verifyManagedDefaults,
  definitions,tableInventory,fingerprints,sequenceState,validateManifest,loadVerificationManifest,verifyRestoredSnapshot,verifyExistingRestore};
