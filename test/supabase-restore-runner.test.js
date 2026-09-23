const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const Runner = require('../scripts/supabase-restore-qa.cjs');

test('restore opt-in refuses wrong projects and never places passwords in command arguments', () => {
  const input = { authorization:'RESTORE', sourceRef:Runner.SOURCE.ref, targetRef:Runner.TARGET.ref,sourcePassword:'source-only-private',targetPassword:'target-only-private' };
  assert.equal(Runner.validateInput(input),input);
  for (const change of [{authorization:'TEST'},{targetRef:Runner.SOURCE.ref},{sourceRef:Runner.TARGET.ref},{sourcePassword:''}]) assert.throws(()=>Runner.validateInput({...input,...change}));
  assert.throws(()=>Runner.pgEnvironment({...Runner.TARGET},'hidden','ca.pem'));
  const env=Runner.pgEnvironment(Runner.SOURCE,'hidden','ca.pem',true);
  assert.equal(env.PGSSLMODE,'verify-full');
  assert.match(env.PGOPTIONS,/default_transaction_read_only=on/);
  assert.equal(env.PGUSER,'postgres.'+Runner.SOURCE.ref);
  assert.equal(env.OPENAI_API_KEY,undefined);
  const checkInput={...input,authorization:'CHECK'};
  assert.throws(()=>Runner.validateInput(checkInput));
  assert.throws(()=>Runner.validateInput(input,'CHECK'));
  assert.equal(Runner.validateInput(checkInput,'CHECK'),checkInput);
  const verifyInput={...input,authorization:'VERIFY'};
  assert.throws(()=>Runner.validateInput(verifyInput));
  assert.equal(Runner.validateInput(verifyInput,'VERIFY'),verifyInput);
  const rollbackInput={...input,authorization:'ROLLBACK'};
  assert.throws(()=>Runner.validateInput(rollbackInput));
  assert.throws(()=>Runner.validateInput(rollbackInput,'VERIFY'));
  assert.throws(()=>Runner.validateInput(verifyInput,'ROLLBACK'));
  assert.equal(Runner.validateInput(rollbackInput,'ROLLBACK'),rollbackInput);
});

test('rollback mode rejects conflicting modes or missing explicit ROLLBACK consent before connecting',async()=>{
  const input={authorization:'ROLLBACK',sourceRef:Runner.SOURCE.ref,targetRef:Runner.TARGET.ref,sourcePassword:'private-source',targetPassword:'private-target'};
  for(const modes of [{connectionsOnly:true,rollbackOnly:true},{verifyOnly:true,rollbackOnly:true},{connectionsOnly:true,verifyOnly:true}]) {
    await assert.rejects(Runner.main(input,modes),/only one/);
  }
  for(const authorization of ['RESTORE','VERIFY','CHECK']) {
    await assert.rejects(Runner.main({...input,authorization},{rollbackOnly:true}),/consent/);
  }
});

test('official database CA is pinned, valid and shared by verified Node and PostgreSQL connections', () => {
  const ca=Runner.databaseCa();
  const pem=ca[ca.length-1];
  assert.equal(Runner.verifyDatabaseCa(pem,Date.parse('2026-09-22')),pem);
  assert.throws(()=>Runner.verifyDatabaseCa(pem,Date.parse('2032-01-01')));
  assert.throws(()=>Runner.verifyDatabaseCa(pem,Date.parse('2020-01-01')));
  assert.throws(()=>Runner.verifyDatabaseCa(pem,NaN));
  assert.throws(()=>Runner.verifyDatabaseCa(require('node:tls').rootCertificates[0]));
  assert.throws(()=>Runner.verifyDatabaseCa('not a certificate'));
  for(const project of [Runner.SOURCE,Runner.TARGET]) {
    const config=Runner.connectionConfig(project,'hidden');
    assert.equal(config.host,project.host);
    assert.equal(config.ssl.rejectUnauthorized,true);
    assert.equal(config.ssl.checkServerIdentity,undefined,'Use normal hostname verification');
    assert.deepEqual(config.ssl.ca,ca);
  }
  assert.throws(()=>Runner.connectionConfig({...Runner.SOURCE},'hidden'));
});

test('connection failures produce static categories without printing arbitrary error fields',()=>{
  const secret='NEVER_EXPOSE_PASSWORD_SQL_OR_PROVIDER_DETAIL';
  for(const [code,expected] of [['28P01','DATABASE_PASSWORD_REJECTED'],['SELF_SIGNED_CERT_IN_CHAIN','TLS_CA_NOT_TRUSTED'],['ERR_TLS_CERT_ALTNAME_INVALID','TLS_HOSTNAME_MISMATCH'],['ENOTFOUND','DNS_LOOKUP_FAILED'],['53300','DATABASE_CONNECTION_LIMIT']]) {
    assert.equal(Runner.connectionFailure({code,message:secret,detail:secret,password:secret}),expected);
  }
  for(const error of [undefined,null,{code:'28P01\n'+secret,message:secret},{code:secret},{message:secret}]) {
    assert.equal(Runner.connectionFailure(error),'UNCLASSIFIED_CONNECTION_ERROR');
  }
  assert.equal(Runner.connectionFailure(new Error('Connection terminated due to connection timeout')),'CONNECTION_TIMEOUT');
});

test('connection-only entry point can only connect, SELECT 1 and close, without files or restoration',async()=>{
  const vm=require('node:vm');
  const code=await fs.readFile(path.join(__dirname,'../scripts/supabase-restore-qa.cjs'),'utf8');
  for(const failingHost of [null,Runner.SOURCE.host,Runner.TARGET.host]) {
    const calls=[],logs=[];
    class FakeClient {
      constructor(config){this.host=config.host;assert.equal(config.ssl.rejectUnauthorized,true);}
      async connect(){calls.push(['connect',this.host]);if(this.host===failingHost)throw Object.assign(new Error('PRIVATE'),{code:'28P01'});}
      async query(sql){calls.push(['query',this.host,sql]);assert.equal(sql,'select 1 as healthy');return {rows:[{healthy:1}]};}
      async end(){calls.push(['end',this.host]);}
    }
    const mod={exports:{}};
    const localRequire=name=>name==='pg'?{Client:FakeClient}:name==='node:fs/promises'?new Proxy({},{get(){throw new Error('No file writes/reads expected');}}):require(name);
    const processStub={platform:'win32',exitCode:0};
    vm.runInNewContext(code,{require:localRequire,module:mod,__dirname:path.resolve(__dirname,'../scripts'),process:processStub,console:{log:line=>logs.push(line)}});
    const input={authorization:'CHECK',sourceRef:Runner.SOURCE.ref,targetRef:Runner.TARGET.ref,sourcePassword:'private-source',targetPassword:'private-target'};
    await mod.exports.main(input,{connectionsOnly:true});
    assert.equal(input.sourcePassword,'');assert.equal(input.targetPassword,'');
    assert.equal(calls.filter(c=>c[0]==='end').length,2);
    assert.equal(calls.filter(c=>c[0]==='query').length,failingHost===Runner.SOURCE.host?0:failingHost===Runner.TARGET.host?1:2);
    assert.equal(processStub.exitCode,failingHost?1:0);
    assert(!logs.join('\n').includes('PRIVATE'));
    assert(!logs.join('\n').includes('private-source'));
    if(!failingHost)assert(logs.some(line=>line.includes('Connection-only check complete')));
    else assert(logs.some(line=>line.includes('DATABASE_PASSWORD_REJECTED')));
  }
});

test('archive list retains ownership/ACL entries, excluding only existing public schema creation/comment', () => {
  const list=['1; 2615 1 SCHEMA - public postgres','2; 2615 2 SCHEMA - pipechat postgres','3; 0 0 COMMENT - SCHEMA public postgres',
    '4; 0 0 ACL - SCHEMA public postgres','5; 1255 2 FUNCTION public pipechat_read_crm() postgres','6; 0 0 ACL public FUNCTION pipechat_read_crm() postgres'].join('\n');
  const filtered=Runner.filterSchemaList(list);
  assert(!filtered.includes('1;')); assert(!filtered.includes('3;'));
  assert(filtered.includes('4;')); assert(filtered.includes('5;')); assert(filtered.includes('6;'));
  assert.throws(()=>Runner.filterSchemaList('unknown dump'));
});

test('archive filter omits only verified Supabase-admin public defaults, keeping app ACLs and owner defaults', () => {
  const base='1; 2615 2 SCHEMA - pipechat postgres\n2; 1255 2 FUNCTION public pipechat_read_crm() postgres';
  const managed=['SEQUENCES','FUNCTIONS','TABLES'].map((type,i)=>`${i+3}; 826 ${i+10} DEFAULT ACL public DEFAULT PRIVILEGES FOR ${type} supabase_admin`);
  const retained=[
    '10; 826 99 DEFAULT ACL public DEFAULT PRIVILEGES FOR FUNCTIONS postgres',
    '11; 826 98 DEFAULT ACL pipechat DEFAULT PRIVILEGES FOR FUNCTIONS postgres',
    '12; 0 0 ACL public FUNCTION pipechat_read_crm() postgres',
    '13; 0 0 ACL pipechat TABLE crm_records postgres',
    '14; 826 97 DEFAULT ACL other DEFAULT PRIVILEGES FOR FUNCTIONS supabase_admin',
    '15; 826 96 DEFAULT ACL public DEFAULT PRIVILEGES FOR FUNCTIONS unknown_admin',
    '16; 826 95 DEFAULT ACL public DEFAULT PRIVILEGES FOR TYPES supabase_admin'
  ];
  const list=[base,...managed,...retained].join('\r\n');
  assert.throws(()=>Runner.filterSchemaList(list),/not verified/);
  assert.throws(()=>Runner.filterSchemaList(list,'true'),/not verified/);
  const filtered=Runner.filterSchemaList(list,true);
  for(const line of managed)assert(!filtered.includes(line));
  for(const line of retained)assert(filtered.includes(line));
  assert(filtered.includes(base));
});

test('managed default comparison is read-only, requires equality and fails closed', async()=>{
  const defaults=[{type:'S',grants:[{grantor:'supabase_admin',grantee:'postgres',privilege:'USAGE',grantable:false}]}];
  const db=rows=>({query:async sql=>{
    assert.match(sql,/^select /);assert.match(sql,/pg_default_acl/);assert.match(sql,/supabase_admin/);
    assert(!/\b(?:insert|update|delete|alter|create|grant)\s/i.test(sql));
    return {rows:structuredClone(rows)};
  }});
  assert.deepEqual(await Runner.verifyManagedDefaults(db(defaults),db(defaults)),defaults);
  assert.deepEqual(await Runner.verifyManagedDefaults(null,db(defaults),defaults),defaults);
  await assert.rejects(Runner.verifyManagedDefaults(db(defaults),db([])),/differ/);
  await assert.rejects(Runner.verifyManagedDefaults(db([]),db([])),/differ/);
  const changed=structuredClone(defaults);changed[0].grants[0].grantable=true;
  await assert.rejects(Runner.verifyManagedDefaults(db(defaults),db(changed)),/differ/);
});

test('native restore diagnostics allowlist phase and error category without leaking stderr',()=>{
  const secret='PRIVATE_PASSWORD_HASH_TOKEN_SQL_ROW_VALUE';
  const diag=Runner.createToolDiagnostic();
  diag.feed(Buffer.from(`psql:C:/private/post-data.sql:42: ERROR:  42`));
  diag.feed(Buffer.from(`501\r\nDETAIL: ${secret}\nCONTEXT: COPY users: ${secret}\n`));
  assert.equal(diag.finish(),'CONSTRAINTS_AND_GRANTS; DATABASE_PERMISSION_DENIED');
  const unsafe=Runner.createToolDiagnostic();
  unsafe.feed(Buffer.from(`${secret}\npsql:C:/private/data.sql:42: ERROR:  23505 ${secret}\n`));
  unsafe.feed(Buffer.from(`psql:C:/private/${secret}:42: ERROR:  P0001\n`));
  assert.equal(unsafe.finish(),'DATABASE_COMMAND; DATABASE_ASSERTION');
  const long=Runner.createToolDiagnostic();
  long.feed(Buffer.from('x'.repeat(3000)));
  long.feed(Buffer.from(`psql:C:/private/data.sql:42: ERROR:  42501\n`));
  assert.equal(long.finish(),'UNCLASSIFIED_DATABASE_ERROR');
  const finalLine=Runner.createToolDiagnostic();
  finalLine.feed(Buffer.from('psql:C:\\private\\security.sql:2: ERROR: P0001'));
  assert.equal(finalLine.finish(),'SECURITY_CHECK; DATABASE_ASSERTION');
  assert.equal(Runner.databaseFailure(secret),'UNCLASSIFIED_DATABASE_ERROR');
});

test('managed defaults match by role names and grants rather than cluster-specific OIDs', {timeout:120000}, async t=>{
  const db=new PGlite();t.after(()=>db.close());
  await db.exec('create role supabase_admin; create role anon; alter default privileges for role supabase_admin in schema public grant execute on functions to anon;');
  const first=await Runner.managedPublicDefaults(db);
  assert.equal(first.length,1);assert.equal(first[0].type,'f');
  assert(first[0].grants.some(g=>g.grantee==='anon' && g.privilege==='EXECUTE'));
  assert.deepEqual(await Runner.verifyManagedDefaults(db,db),first);
  await db.exec('alter default privileges for role supabase_admin in schema public grant execute on functions to postgres with grant option;');
  await assert.rejects(Runner.verifyManagedDefaults(null,db,first),/differ/);
});

test('canonical schema verification accepts equivalent null/explicit ACLs but detects real privilege changes', {timeout:120000}, async t=>{
  const db=new PGlite();t.after(()=>db.close());
  await db.exec(await fs.readFile(path.join(__dirname,'../db/tests/mock-supabase.sql'),'utf8'));
  await db.exec(`alter default privileges revoke execute on functions from anon,authenticated,service_role;
    alter default privileges revoke all on tables from anon,authenticated,service_role;
    create schema pipechat; create table pipechat.example(id integer);
    create function public.pipechat_read_crm() returns integer language sql set search_path=pg_catalog as 'select 1';`);
  const raw=await Runner.definitions(db), canonical=await Runner.definitions(db,{canonicalAcls:true});
  await db.exec(`revoke all on schema pipechat from anon;
    revoke all on table pipechat.example from anon;
    grant execute on function public.pipechat_read_crm() to public;`);
  assert.notEqual(await Runner.definitions(db),raw,'Native dumps may recreate defaults as null rather than explicit ACLs');
  assert.equal(await Runner.definitions(db,{canonicalAcls:true}),canonical);
  await db.exec('grant select on pipechat.example to anon,authenticated;');
  const grants=await Runner.definitions(db,{canonicalAcls:true});
  assert.notEqual(grants,canonical);
  await db.exec('revoke select on pipechat.example from anon; grant select on pipechat.example to anon;');
  assert.equal(await Runner.definitions(db,{canonicalAcls:true}),grants,'Grant array order is not a permission change');
  await db.exec('grant select on pipechat.example to anon with grant option;');
  assert.notEqual(await Runner.definitions(db,{canonicalAcls:true}),grants,'Grant options remain significant');
  await db.exec('revoke all on pipechat.example from anon,authenticated; revoke all on pipechat.example from postgres;');
  assert.notEqual(await Runner.definitions(db,{canonicalAcls:true}),canonical,'An empty ACL is not the same as null/default');
  await db.exec('grant all on pipechat.example to postgres; grant usage on schema pipechat to anon;');
  assert.notEqual(await Runner.definitions(db,{canonicalAcls:true}),canonical);
  await db.exec('revoke usage on schema pipechat from anon; revoke execute on function public.pipechat_read_crm() from public;');
  assert.notEqual(await Runner.definitions(db,{canonicalAcls:true}),canonical,'Function PUBLIC defaults are not discarded');
});

test('existing restore verification uses original snapshot data and anchors legacy schema conversion', {timeout:120000}, async t=>{
  const db=new PGlite();t.after(()=>db.close());
  await db.exec(await fs.readFile(path.join(__dirname,'../db/tests/mock-supabase.sql'),'utf8'));
  await db.exec(await fs.readFile(path.join(__dirname,'../db/migrations/001-supabase.sql'),'utf8'));
  await db.exec('create role supabase_admin; alter default privileges for role supabase_admin in schema public grant execute on functions to anon;');
  const manifest={source:Runner.SOURCE.ref,target:Runner.TARGET.ref,
    tables:await Runner.fingerprints(db,await Runner.tableInventory(db,['auth','pipechat'])),
    sequences:await Runner.sequenceState(db),schemaHash:await Runner.definitions(db),
    archives:{schema:'a'.repeat(64),data:'b'.repeat(64)},managedDefaults:await Runner.managedPublicDefaults(db)};
  const originalLegacyHash=manifest.schemaHash;
  await db.exec('begin read only');
  const lines=[];
  const verified=await Runner.verifyRestoredSnapshot(db,db,manifest,line=>lines.push(line));
  assert.equal(verified.schemaFingerprintVersion,2);
  assert.equal(verified.schemaHash,await Runner.definitions(db,{canonicalAcls:true}));
  assert.equal(manifest.schemaFingerprintVersion,undefined,'Legacy manifest is not mutated');
  assert.equal(lines.length,6);
  await db.exec(await fs.readFile(path.join(__dirname,'../db/tests/security.sql'),'utf8'));
  await db.exec('rollback');
  const canonical={...manifest,schemaFingerprintVersion:2,schemaHash:await Runner.definitions(db,{canonicalAcls:true})};
  await Runner.verifyRestoredSnapshot(null,db,canonical,()=>{});
  await assert.rejects(Runner.verifyRestoredSnapshot(null,db,manifest,()=>{}),{code:'QA_BASELINE'});
  const changedSource={query:async()=>({rows:[{data:'changed private schema, never print'}]})};
  await assert.rejects(Runner.verifyRestoredSnapshot(changedSource,db,manifest,()=>{}),{code:'QA_BASELINE'});
  assert.equal(manifest.schemaHash,originalLegacyHash,'Never rewrite the old backup baseline');
  const badData=structuredClone(canonical);badData.tables.find(t=>t.schema==='pipechat').sha256='c'.repeat(64);
  await assert.rejects(Runner.verifyRestoredSnapshot(null,db,badData,()=>{}),{code:'QA_CRM'});
  const badAuth=structuredClone(canonical);badAuth.tables.find(t=>t.schema==='auth').count++;
  await assert.rejects(Runner.verifyRestoredSnapshot(null,db,badAuth,()=>{}),{code:'QA_AUTH'});
  const missing=structuredClone(canonical);missing.tables.pop();
  await assert.rejects(Runner.verifyRestoredSnapshot(null,db,missing,()=>{}),{code:'QA_INVENTORY'});
  const badSequence={...canonical,sequences:[{schemaname:'auth',sequencename:'test_id_seq',last_value:'1',is_called:true}]};
  await assert.rejects(Runner.verifyRestoredSnapshot(null,db,badSequence,()=>{}),{code:'QA_SEQUENCE'});
  await db.exec('grant select on pipechat.crm_records to anon;');
  await assert.rejects(Runner.verifyRestoredSnapshot(null,db,canonical,()=>{}),{code:'QA_SCHEMA'});
  assert.equal(Runner.databaseFailure('QA_SCHEMA'),'RESTORED_SCHEMA_OR_GRANTS_MISMATCH');
});

test('manifest validation rejects wrong projects, malformed names and unversioned comparison changes',()=>{
  const valid={source:Runner.SOURCE.ref,target:Runner.TARGET.ref,schemaHash:'a'.repeat(64),
    archives:{schema:'b'.repeat(64),data:'c'.repeat(64)},managedDefaults:[{type:'f',grants:[]}],sequences:[],
    tables:Array.from({length:7},(_,i)=>({schema:'pipechat',name:'table_'+i,count:0,sha256:'d'.repeat(64)}))};
  assert.equal(Runner.validateManifest(valid),valid);
  for(const change of [{target:Runner.SOURCE.ref},{source:Runner.TARGET.ref},{schemaHash:'secret'},{schemaFingerprintVersion:3},
    {archives:{schema:'a'.repeat(64),data:'bad'}},{tables:[]},{managedDefaults:[]},
    {sequences:[{schemaname:'public',sequencename:'anything',last_value:'1',is_called:true}]}]) {
    assert.throws(()=>Runner.validateManifest({...valid,...change}),{code:'QA_MANIFEST'});
  }
  for(const change of [{schema:'public'},{name:'../../secret'},{count:-1},{sha256:'value'},{name:'table_1'}]) {
    const wrong=structuredClone(valid);Object.assign(wrong.tables[0],change);
    assert.throws(()=>Runner.validateManifest(wrong),{code:'QA_MANIFEST'});
  }
});

test('verify-only entry point cannot replay archives, write files or run rollback probes',async()=>{
  const vm=require('node:vm'),os=require('node:os'),{createHash}=require('node:crypto');
  const code=await fs.readFile(path.join(__dirname,'../scripts/supabase-restore-qa.cjs'),'utf8');
  const security=await fs.readFile(path.join(__dirname,'../db/tests/security.sql'),'utf8');
  const sha=value=>createHash('sha256').update(value).digest('hex');
  const directory=path.join(os.homedir(),'AppData','Local','PipeChat','Recovery','supabase-restore-ABC123');
  const tables=['crm_records','memberships','schema_version','usage_counters','usage_reservations','workspace_metadata','workspaces'].map(name=>({schema:'pipechat',name}));
  tables.unshift({schema:'auth',name:'users'});
  const defaults=[{type:'f',grants:[]}];
  const manifest={source:Runner.SOURCE.ref,target:Runner.TARGET.ref,schemaFingerprintVersion:2,schemaHash:sha('canonical-schema'),
    tables:tables.map(t=>({...t,count:0,sha256:sha('[]')})),sequences:[],managedDefaults:defaults,
    archives:{schema:sha('schema archive'),data:sha('sensitive archive')}};
  for(const badArchive of [false,true]) {
    const calls=[],logs=[];
    class FakeClient {
      constructor(config){this.host=config.host;this.readOnly=false;}
      async connect(){calls.push('connect');}
      async end(){calls.push('end');}
      async query(sql){
        calls.push(sql);
        if(sql==='select 1 as healthy')return {rows:[{healthy:1}]};
        if(sql==='begin isolation level repeatable read read only'){this.readOnly=true;return {};}
        if(sql==='rollback'){this.readOnly=false;return {};}
        assert(this.readOnly,'All verification queries must be inside a read-only transaction');
        if(sql===security){assert.equal(this.host,Runner.TARGET.host);return {};}
        assert.match(sql,/^select /);
        if(sql.includes("c.relkind='r' and not"))return {rows:tables};
        if(sql.includes('jsonb_agg(to_jsonb(t)'))return {rows:[{count:0,data:'[]'}]};
        if(sql.includes('from pg_sequences'))return {rows:[]};
        if(sql.includes("'functions',"))return {rows:[{data:'canonical-schema'}]};
        if(sql.includes('from pg_default_acl'))return {rows:defaults};
        assert.fail('Unexpected query in verification-only mode');
      }
    }
    const fakeFs={
      async lstat(file){assert([directory,...['manifest.json','schema.dump','data.dump'].map(n=>path.join(directory,n))].includes(file));return {isFile:()=>true,isSymbolicLink:()=>false,size:100};},
      async realpath(file){assert.equal(file,directory);return file;},
      async readFile(file,encoding){
        if(file===path.resolve(__dirname,'../db/tests/security.sql'))return security;
        const files={'manifest.json':JSON.stringify(manifest),'schema.dump':'schema archive','data.dump':badArchive?'wrong archive':'sensitive archive'};
        assert.equal(path.dirname(file),directory);assert(Object.hasOwn(files,path.basename(file)));
        return Buffer.from(files[path.basename(file)]);
      }
    };
    const localRequire=name=>name==='pg'?{Client:FakeClient}:name==='node:fs/promises'?new Proxy(fakeFs,{get(obj,key){assert(key in obj,`No file mutation allowed: ${String(key)}`);return obj[key];}}):name==='node:child_process'?{spawn(){assert.fail('No native tool or child process in verification mode');}}:require(name);
    const mod={exports:{}},processStub={platform:'win32',exitCode:0};
    vm.runInNewContext(code,{require:localRequire,module:mod,__dirname:path.resolve(__dirname,'../scripts'),process:processStub,Buffer,console:{log:line=>logs.push(line)}});
    const input={authorization:'VERIFY',sourceRef:Runner.SOURCE.ref,targetRef:Runner.TARGET.ref,sourcePassword:'private-source',targetPassword:'private-target',backupDirectory:directory};
    await mod.exports.main(input,{verifyOnly:true});
    assert.equal(processStub.exitCode,badArchive?1:0);
    assert.equal(input.sourcePassword,'');assert.equal(input.targetPassword,'');
    assert.equal(calls.filter(c=>c==='end').length,2);
    assert.equal(calls.filter(c=>c==='begin isolation level repeatable read read only').length,badArchive?0:2);
    assert.equal(calls.filter(c=>c==='rollback').length,badArchive?0:2);
    assert(!logs.join('\n').includes('private-source'));assert(!logs.join('\n').includes('sensitive archive'));
    assert(logs.some(l=>l.includes(badArchive?'BACKUP_ARCHIVE_HASH_MISMATCH':'Read-only restore verification complete')));
  }
});

test('restore rollback probe executes actual RPCs and removes every fault-injection hook', {timeout:120000}, async t=>{
  const db=new PGlite(); t.after(()=>db.close());
  await db.exec(await fs.readFile(path.join(__dirname,'../db/tests/mock-supabase.sql'),'utf8'));
  await db.exec('alter table auth.users add column email text; alter table auth.sessions add column created_at timestamptz, add column updated_at timestamptz;');
  await db.exec(await fs.readFile(path.join(__dirname,'../db/migrations/001-supabase.sql'),'utf8'));
  for (const email of Runner.EMAILS) await db.query('insert into auth.users(id,email) values ($1,$2)',[randomUUID(),email]);
  const user=(await db.query('select id from auth.users order by email')).rows[0].id;
  const wid=(await db.query('select id from pipechat.workspaces where owner_id=$1',[user])).rows[0].id;
  const schema={status:'ready',useCase:'Recruiting',description:'',title:'QA',recordLabel:'candidate',fields:[{id:'f_name',name:'Candidate',type:'text',role:'primary',options:[]}]};
  await db.query('update pipechat.workspace_metadata set table_schema=$1 where workspace_id=$2',[JSON.stringify(schema),wid]);
  await db.query("insert into pipechat.crm_records(workspace_id,record_id,position,cells) values ($1,1,0,'{\"f_name\":\"QA row\"}')",[wid]);
  // pg sends multi-statement DDL; adapt only that transport difference for PGlite.
  const adapter={query:(sql,values)=>values===undefined && /create function pipechat.qa_force_rollback/.test(sql)?db.exec(sql):db.query(sql,values)};
  const third=randomUUID();
  await db.query('insert into auth.users(id,email) values ($1,$2)',[third,'not-an-approved-qa@example.invalid']);
  await assert.rejects(Runner.forcedRollback(adapter,()=>{}),{code:'QA_IDENTITIES'});
  assert.equal((await db.query('select count(*)::int as n from auth.sessions')).rows[0].n,0);
  await db.query('delete from auth.users where id=$1',[third]);
  const checks=[];
  await Runner.forcedRollback(adapter,message=>checks.push(message));
  assert.equal(checks.length,5);
  assert.equal((await db.query('select count(*)::int as n from auth.sessions')).rows[0].n,0);
  assert.equal((await db.query('select count(*)::int as n from pipechat.usage_reservations')).rows[0].n,0);
  assert.equal((await db.query('select sum(used)::int as n from pipechat.usage_counters')).rows[0].n,0);
  await db.exec(await fs.readFile(path.join(__dirname,'../db/tests/security.sql'),'utf8'));
});

test('rollback-only entry point verifies first, disconnects source, tests actual RPCs and rechecks the entire restored snapshot', {timeout:120000}, async t=>{
  const vm=require('node:vm'),os=require('node:os'),{createHash}=require('node:crypto');
  const sha=value=>createHash('sha256').update(value).digest('hex');
  const db=new PGlite();t.after(()=>db.close());
  await db.exec(await fs.readFile(path.join(__dirname,'../db/tests/mock-supabase.sql'),'utf8'));
  await db.exec('alter table auth.users add column email text; alter table auth.sessions add column created_at timestamptz, add column updated_at timestamptz;');
  await db.exec(await fs.readFile(path.join(__dirname,'../db/migrations/001-supabase.sql'),'utf8'));
  await db.exec('create role supabase_admin; alter default privileges for role supabase_admin in schema public grant execute on functions to anon; create sequence auth.qa_test_seq start 5;');
  for(const email of Runner.EMAILS)await db.query('insert into auth.users(id,email) values ($1,$2)',[randomUUID(),email]);
  const user=(await db.query('select id from auth.users order by email')).rows[0].id;
  const wid=(await db.query('select id from pipechat.workspaces where owner_id=$1',[user])).rows[0].id;
  const schema={status:'ready',useCase:'Recruiting',description:'',title:'QA',recordLabel:'candidate',fields:[{id:'f_name',name:'Candidate',type:'text',role:'primary',options:[]}]};
  await db.query('update pipechat.workspace_metadata set table_schema=$1 where workspace_id=$2',[JSON.stringify(schema),wid]);
  await db.query("insert into pipechat.crm_records(workspace_id,record_id,position,cells) values ($1,1,0,'{\"f_name\":\"QA row\"}')",[wid]);
  const rawSchema=await Runner.definitions(db);
  const code=await fs.readFile(path.join(__dirname,'../scripts/supabase-restore-qa.cjs'),'utf8');
  const security=await fs.readFile(path.join(__dirname,'../db/tests/security.sql'),'utf8');
  const directory=path.join(os.homedir(),'AppData','Local','PipeChat','Recovery','supabase-restore-ABC123');
  const manifest={source:Runner.SOURCE.ref,target:Runner.TARGET.ref,schemaFingerprintVersion:1,schemaHash:rawSchema,
    tables:await Runner.fingerprints(db,await Runner.tableInventory(db,['auth','pipechat'])),
    sequences:await Runner.sequenceState(db),managedDefaults:await Runner.managedPublicDefaults(db),
    archives:{schema:sha('schema archive'),data:sha('private archive')}};
  for(const scenario of ['busy','bad-archive','bad-data','unexpected-fault','post-check-mismatch','success']) {
    const calls=[],logs=[];let sourceClosed=false,wrote=false,writeFinished=false,postChecked=false;
    class FakeClient {
      constructor(config){this.host=config.host;this.readOnly=false;assert.equal(config.ssl.rejectUnauthorized,true);}
      async connect(){calls.push(['connect',this.host]);}
      async end(){calls.push(['end',this.host]);if(this.host===Runner.SOURCE.host)sourceClosed=true;}
      async query(sql,values){
        calls.push([this.host,sql]);
        if(this.host===Runner.SOURCE.host) {
          assert(!sourceClosed,'Never use source after closing it');
          if(sql==='select 1 as healthy')return {rows:[{healthy:1}]};
          if(sql==='begin isolation level repeatable read read only'){this.readOnly=true;return {};}
          if(sql==='rollback'){this.readOnly=false;return {};}
          assert(this.readOnly);assert.match(sql,/^select /);assert(sql.includes("'functions',"));
          return db.query(sql,values);
        }
        if(sql.includes('pg_try_advisory_lock'))return {rows:[{acquired:scenario!=='busy'}]};
        if(sql==='begin isolation level repeatable read read only') {
          this.readOnly=true;
          if(wrote){assert(writeFinished);postChecked=true;}
        } else if(sql==='begin') {
          assert(sourceClosed,'Source must be disconnected before any fault-injection transaction');
          assert(logs.some(l=>l.includes('Read-only restore verification complete')));
          assert(!wrote,'Only one temporary write transaction');
          wrote=true;
        } else if(sql==='rollback') {
          if(wrote && !writeFinished)writeFinished=true;
          this.readOnly=false;
        } else if(sql!== 'select 1 as healthy' && !sql.startsWith('select ')) {
          assert(this.readOnly || wrote,'No writes before backup preverification');
        }
        if(sql===security || /create function pipechat.qa_force_rollback/.test(sql))return db.exec(sql);
        if(scenario==='unexpected-fault' && sql.startsWith('select public.pipechat_finish_usage')) {
          throw Object.assign(new Error('PRIVATE_PROVIDER_MESSAGE'),{code:'42501'});
        }
        if(scenario==='post-check-mismatch' && postChecked && sql.includes('from "auth"."users"'))return {rows:[{count:2,data:'PRIVATE_CHANGED_AUTH'}]};
        return db.query(sql,values);
      }
    }
    const diskManifest=structuredClone(manifest);
    if(scenario==='bad-data')diskManifest.tables.find(t=>t.schema==='pipechat').sha256='c'.repeat(64);
    const fakeFs={
      async lstat(file){assert([directory,...['manifest.json','schema.dump','data.dump'].map(n=>path.join(directory,n))].includes(file));return {isFile:()=>true,isSymbolicLink:()=>false,size:100};},
      async realpath(file){assert.equal(file,directory);return file;},
      async readFile(file){
        if(file===path.resolve(__dirname,'../db/tests/security.sql'))return security;
        const files={'manifest.json':JSON.stringify(diskManifest),'schema.dump':'schema archive','data.dump':scenario==='bad-archive'?'bad archive':'private archive'};
        assert.equal(path.dirname(file),directory);assert(Object.hasOwn(files,path.basename(file)));
        return Buffer.from(files[path.basename(file)]);
      }
    };
    const localRequire=name=>name==='pg'?{Client:FakeClient}:name==='node:fs/promises'?new Proxy(fakeFs,{get(obj,key){assert(key in obj,`No file mutation allowed: ${String(key)}`);return obj[key];}}):name==='node:child_process'?{spawn(){assert.fail('Rollback-only mode cannot replay a restore or create a backup');}}:require(name);
    const mod={exports:{}},processStub={platform:'win32',exitCode:0};
    vm.runInNewContext(code,{require:localRequire,module:mod,__dirname:path.resolve(__dirname,'../scripts'),process:processStub,Buffer,structuredClone,console:{log:line=>logs.push(line)}});
    const input={authorization:'ROLLBACK',sourceRef:Runner.SOURCE.ref,targetRef:Runner.TARGET.ref,sourcePassword:'private-source',targetPassword:'private-target',backupDirectory:directory};
    await mod.exports.main(input,{rollbackOnly:true});
    assert.equal(processStub.exitCode,scenario==='success'?0:1,logs.join('\n'));
    assert.equal(input.sourcePassword,'');assert.equal(input.targetPassword,'');
    assert.equal(calls.filter(c=>c[0]==='end').length,2);
    assert.equal(wrote,['unexpected-fault','post-check-mismatch','success'].includes(scenario));
    assert.equal(postChecked,['post-check-mismatch','success'].includes(scenario));
    assert.equal(logs.some(l=>l.includes('HOSTED ROLLBACK CHECKS PASSED')),scenario==='success');
    assert(!/PRIVATE_|private-source|private-target|private archive/.test(logs.join('\n')));
    if(scenario==='unexpected-fault')assert(logs.some(l=>l.includes('EXPECTED_LATE_FAILURE_NOT_OBSERVED')));
    if(scenario==='post-check-mismatch')assert(logs.some(l=>l.includes('RESTORED_AUTH_DATA_MISMATCH')));
    assert.deepEqual(await Runner.fingerprints(db,await Runner.tableInventory(db,['auth','pipechat'])),manifest.tables,'No Auth/CRM values persist, including on failure');
    assert.deepEqual(await Runner.sequenceState(db),manifest.sequences);
    assert.equal(await Runner.definitions(db),rawSchema,'Fault hooks are removed on success or failure');
    await db.exec(security);
  }
});
