const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {randomUUID}=require('node:crypto'),{PGlite}=require('@electric-sql/pglite');
const P=require('../lib/agent-persona');

test('persona RPCs isolate owners, preserve pins, reject stale contexts and reset without touching usage',{timeout:120000},async t=>{
  const db=new PGlite();t.after(()=>db.close());
  const run=async name=>db.exec(await fs.readFile(path.join(__dirname,'../db',name),'utf8'));
  await run('tests/mock-supabase.sql');
  for(const file of (await fs.readdir(path.join(__dirname,'../db/migrations'))).filter(f=>/^\d{3}-.*\.sql$/.test(f)).sort())await run('migrations/'+file);
  async function user(){const u={id:randomUUID(),session_id:randomUUID()};await db.query('insert into auth.users(id) values ($1)',[u.id]);await db.query('insert into auth.sessions(id,user_id) values ($1,$2)',[u.session_id,u.id]);return u;}
  async function rpc(u,name,args=[]){await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:u.id,session_id:u.session_id,role:'authenticated'})]);await db.exec('set role authenticated');try{return (await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) result`,args)).rows[0].result;}finally{await db.exec('reset role');}}
  const a=await user(),b=await user(),read=u=>rpc(u,'pipechat_read_agent_profile'),crm=u=>rpc(u,'pipechat_read_workspace');
  const original=await crm(a),quota=(await db.query('select * from pipechat.usage_counters order by user_id')).rows;
  assert.equal(await read(a),null);assert.equal(await read(b),null);
  const context=P.assemble(null,{useCase:'Other',description:'We place finance executives.'});
  const profile=P.resolved(context,{personaId:'recruiting',certainty:'clear',subtype:'executive search'});
  const save=(p,version=original.updatedAt)=>rpc(a,'pipechat_save_agent_profile',[JSON.stringify(p),version]);
  assert.deepEqual(await save(profile),profile);assert.deepEqual(await read(a),profile);assert.equal(await read(b),null);assert.deepEqual(await crm(a),original);
  assert.deepEqual(await save({...profile,personaId:'sales'}),profile,'cannot silently replace an existing pin');
  await assert.rejects(()=>save({...profile,version:'v2'}),e=>e.code==='PT400');
  await assert.rejects(()=>save(profile,'stale'),e=>e.code==='PT409');
  const schema={status:'ready',useCase:'Other',description:profile.description,title:'Searches',recordLabel:'search',fields:[{id:'f_name',name:'Search',type:'text',role:'primary',options:[]}]};
  const saved=await rpc(a,'pipechat_write_workspace_v2',[JSON.stringify([]),JSON.stringify([]),JSON.stringify(schema),original.updatedAt,JSON.stringify([])]);
  assert.deepEqual(await read(a),profile);await assert.rejects(()=>save({...profile,description:'different'},saved.updatedAt),e=>e.code==='PT400');
  const renamed={...schema,fields:[{...schema.fields[0],name:'Assignments'}]};
  const next=await rpc(a,'pipechat_write_workspace_v2',['[]','[]',JSON.stringify(renamed),saved.updatedAt,'[]']);assert.deepEqual(await read(a),profile);
  await rpc(a,'pipechat_reset_crm',[next.updatedAt,true]);assert.equal(await read(a),null);assert.equal(await read(b),null);
  assert.deepEqual((await db.query('select * from pipechat.usage_counters order by user_id')).rows,quota);
  await db.exec('set role authenticated');await assert.rejects(()=>db.exec('select * from pipechat.workspace_agent_profiles'),e=>e.code==='42501');await db.exec('reset role');
  await db.query('delete from auth.sessions where id=$1',[a.session_id]);await assert.rejects(()=>read(a),e=>e.code==='PT401');
});
