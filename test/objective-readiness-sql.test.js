'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const {createSupabaseBackend,BackendError}=require('../lib/supabase-backend.js');
const legacyHealth={ok:true,contract:'pipechat-supabase-v1',database:'ok',schemaVersion:1};
function backendFor(read){
  return createSupabaseBackend({url:'https://pipechat-test.supabase.co',publishableKey:'sb_publishable_offline_readiness_123456789',
    createClient:()=>({rpc:async name=>{assert.equal(name,'pipechat_health');return {data:await read(),error:null,status:200};}}),
    createServerClient:()=>assert.fail('Health must not construct a session client')});
}
const rejectsReadiness=error=>{assert(error instanceof BackendError);assert.equal(error.status,503);assert.match(error.message,/migration/);return true;};

test('startup and readiness require numeric featureVersion 2 but preserve the legacy app-facing health shape',async()=>{
  for(const featureVersion of [undefined,null,0,1,3,'2',true]){
    const raw={...legacyHealth,...(featureVersion===undefined?{}:{featureVersion})},backend=backendFor(async()=>raw);
    await assert.rejects(()=>backend.check(),rejectsReadiness);
    await assert.rejects(()=>backend.check({requireDatabase:true}),rejectsReadiness);
  }
  const raw={...legacyHealth,featureVersion:2,privateDiagnostic:'not public'},backend=backendFor(async()=>raw);
  assert.deepEqual(await backend.check(),legacyHealth);assert.deepEqual(await backend.check({requireDatabase:true}),legacyHealth);
  assert.equal(raw.featureVersion,2);
});

test('migration 018 gates current versus incomplete schemas without new RPCs, grants or sensitive output', {timeout:120000},async t=>{
  const db=new PGlite();t.after(()=>db.close());
  const directory=path.join(__dirname,'../db/migrations');
  const files=(await fs.readdir(directory)).filter(file=>/^\d{3}-.*\.sql$/.test(file)).sort();
  assert(files.includes('018-objective-readiness.sql'));
  const run=file=>fs.readFile(path.join(directory,file),'utf8').then(sql=>db.exec(sql));
  const catalog=async()=> (await db.query(`select n.nspname||'.'||p.proname||'('||oidvectortypes(p.proargtypes)||')' as signature,
    pg_get_functiondef(p.oid) as definition,p.proacl,p.prosecdef,p.proconfig
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','pipechat') order by 1`)).rows;
  async function health(role='anon'){
    assert(['anon','authenticated','service_role'].includes(role));await db.exec('set role '+role);
    try{return (await db.query('select public.pipechat_health() as result')).rows[0].result;}
    finally{await db.exec('reset role');}
  }
  await db.exec(await fs.readFile(path.join(__dirname,'../db/tests/mock-supabase.sql'),'utf8'));
  for(const file of files.filter(file=>Number(file.slice(0,3))<=12))await run(file);
  const baseline=await catalog(),oldHealth=baseline.find(row=>row.signature==='public.pipechat_health()');
  assert.deepEqual(await health(),legacyHealth);
  await assert.rejects(()=>backendFor(health).check(),rejectsReadiness);

  await t.test('out-of-order readiness installation cannot advertise missing objective features',async()=>{
    await run('018-objective-readiness.sql');
    assert.deepEqual(await health(),{...legacyHealth,featureVersion:1});
    await assert.rejects(()=>backendFor(health).check(),rejectsReadiness);
  });

  let featureFunctions,beforeFinal;
  for(const file of files.filter(file=>Number(file.slice(0,3))>12)){
    const version=Number(file.slice(0,3));
    if(version===18)beforeFinal=await catalog();
    await run(file);
    if(version===16)featureFunctions=(await catalog()).filter(row=>row.signature.startsWith('public.')&&!baseline.some(old=>old.signature===row.signature));
    if(version<16){
      assert.deepEqual(await health(),{...legacyHealth,featureVersion:1},file);
      await assert.rejects(()=>backendFor(health).check(),rejectsReadiness);
    }
  }
  assert(featureFunctions&&featureFunctions.length>=25,'Migrations 013-016 introduce the required public feature entry points');

  await t.test('all migrations including 018 retain old-app compatibility and permit the new app',async()=>{
    const expected={...legacyHealth,featureVersion:2};
    assert.deepEqual(await health(),expected);assert.deepEqual(await health('authenticated'),expected);
    assert.deepEqual(await backendFor(health).check(),legacyHealth);
    assert.deepEqual(await backendFor(health).check({requireDatabase:true}),legacyHealth);
    const after=await catalog();
    assert.deepEqual(after.filter(row=>row.signature!=='public.pipechat_health()'),beforeFinal.filter(row=>row.signature!=='public.pipechat_health()'));
    const currentHealth=after.find(row=>row.signature==='public.pipechat_health()');
    assert.deepEqual(currentHealth.proacl,oldHealth.proacl);assert.equal(currentHealth.prosecdef,true);assert.deepEqual(currentHealth.proconfig,['search_path=pg_catalog']);
    await assert.rejects(()=>health('service_role'),error=>error.code==='42501');
    const privileges=(await db.query(`select has_function_privilege('anon','public.pipechat_health()','execute') as anon,
      has_function_privilege('authenticated','public.pipechat_health()','execute') as authenticated,
      has_function_privilege('service_role','public.pipechat_health()','execute') as service_role`)).rows[0];
    assert.deepEqual(privileges,{anon:true,authenticated:true,service_role:false});
    const once=await catalog();await run('018-objective-readiness.sql');assert.deepEqual(await catalog(),once);
  });

  await t.test('each required feature signature fails closed if individually missing',async()=>{
    const signatures=[...featureFunctions.map(row=>row.signature),
      'public.pipechat_read_workspace()','public.pipechat_write_workspace_v2(jsonb, jsonb, jsonb, text, jsonb)','public.pipechat_write_crm(jsonb, jsonb, jsonb, text)'];
    for(const signature of signatures){
      assert(/^public\.[a-z_][a-z0-9_]*\([a-z, ]*\)$/.test(signature),signature);
      await db.exec('begin');
      try{
        await db.exec(`alter function ${signature} rename to objective_missing_signature`);
        assert.deepEqual(await health(),{...legacyHealth,featureVersion:1},signature);
        await assert.rejects(()=>backendFor(health).check(),rejectsReadiness);
      }finally{await db.exec('rollback');}
      assert.equal((await health()).featureVersion,2,signature);
    }
  });

  await t.test('an overload with the same name cannot stand in for the required signature',async()=>{
    await db.exec('begin');
    try{
      await db.exec(`alter function public.pipechat_read_workflows() rename to objective_missing_signature;
        create function public.pipechat_read_workflows(integer) returns jsonb language sql as $$ select '{}'::jsonb $$;`);
      assert.deepEqual(await health(),{...legacyHealth,featureVersion:1});
      await assert.rejects(()=>backendFor(health).check(),rejectsReadiness);
    }finally{await db.exec('rollback');}
  });
});
