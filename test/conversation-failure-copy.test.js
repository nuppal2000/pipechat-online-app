'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');

test('019 changes only public validation copy while preserving failure authority and private privileges', {timeout:180000}, async t=>{
  const db=new PGlite();t.after(()=>db.close());
  const run=async file=>db.exec(await fs.readFile(path.join(__dirname,'../db',file),'utf8'));
  await run('tests/mock-supabase.sql');
  for(const file of (await fs.readdir(path.join(__dirname,'../db/migrations'))).filter(file=>/^(00[1-9]|01[0-8])-/.test(file)).sort())await run('migrations/'+file);
  const functions=()=>db.query("select p.oid,p.proname,p.proacl,p.prosecdef,p.proconfig,pg_get_functiondef(p.oid) as definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','pipechat') order by p.oid");
  const payload=async (status,error,content=null,receipt=null)=>(await db.query('select pipechat.conversation_terminal_payload($1,$2,$3,$4::jsonb) as result',[status,error,content,receipt])).rows[0].result;
  const errors=['unknown','timeout','unavailable','invalid_response','validation','conflict','unauthorized','quota'];
  const before=await functions(),old=await Promise.all(errors.map(e=>payload('failed',e)));
  await run('migrations/019-conversation-failure-copy.sql');
  const after=await functions();assert.equal(after.rows.length,before.rows.length);
  for(const fn of before.rows){
    const next=after.rows.find(item=>item.oid===fn.oid);
    if(fn.proname==='conversation_terminal_payload'){const {definition,...meta}=fn;const {definition:nextDefinition,...nextMeta}=next;assert.deepEqual(nextMeta,meta);assert.notEqual(nextDefinition,definition);}
    else assert.deepEqual(next,fn);
  }
  for(const [index,error] of errors.entries()){
    const next=await payload('failed',error);assert.equal(next.status,'failed');assert.equal(next.publicErrorCode,error);assert.equal(next.resultReceipt,null);
    if(['invalid_response','validation'].includes(error))assert.match(next.content,/^Sorry, I couldn't prepare/);
    else assert.deepEqual(next,old[index]);
  }
  for(const args of [['failed','validation','raw private output',null],['failed','private error',null,null],['failed','validation',null,'{"saved":true}'],['succeeded','validation','Wrong status',null]])
    await assert.rejects(()=>payload(...args),e=>e.code==='PT400');
  for(const role of ['anon','authenticated']){
    await db.exec('set role '+role);
    await assert.rejects(()=>payload('failed','validation'),e=>e.code==='42501');
    await db.exec('reset role');
  }
});
