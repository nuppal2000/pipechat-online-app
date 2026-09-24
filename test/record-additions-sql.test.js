const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {randomUUID}=require('node:crypto'),{PGlite}=require('@electric-sql/pglite');
const Core=require('../public/pipeline-core'),fixture=require('./fixtures/record-additions.cjs');
test('three-deal additions round-trip atomically through Supabase RPCs; stale/invalid batches reject and Undo/isolation/usage remain intact',{timeout:120000},async t=>{
  const db=new PGlite();t.after(()=>db.close());
  const run=async name=>db.exec(await fs.readFile(path.join(__dirname,'../db',name),'utf8'));
  await run('tests/mock-supabase.sql');
  for(const file of (await fs.readdir(path.join(__dirname,'../db/migrations'))).filter(f=>/^\d{3}-.*\.sql$/.test(f)).sort())await run('migrations/'+file);
  async function user(){const u={id:randomUUID(),session_id:randomUUID()};await db.query('insert into auth.users(id) values ($1)',[u.id]);await db.query('insert into auth.sessions(id,user_id) values ($1,$2)',[u.session_id,u.id]);return u;}
  async function rpc(u,name,args=[]){await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:u.id,session_id:u.session_id,role:'authenticated'})]);await db.exec('set role authenticated');try{return (await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) result`,args)).rows[0].result;}finally{await db.exec('reset role');}}
  const read=u=>rpc(u,'pipechat_read_workspace'),write=(u,s)=>rpc(u,'pipechat_write_workspace_v2',[JSON.stringify(s.deals),JSON.stringify(s.customFields),JSON.stringify(s.tableSchema),s.updatedAt,JSON.stringify(s.todoCards)]);
  const a=await user(),b=await user(),other=await read(b),quota=(await db.query('select * from pipechat.usage_counters')).rows;
  let saved=await write(a,{...await read(a),tableSchema:fixture.schema,customFields:[],todoCards:[]});
  const original=structuredClone(saved),proposal=Core.create(fixture.schema).additions(saved.deals,{action:'add_records',records:fixture.records});
  saved=await write(a,{...saved,deals:proposal.records});assert.deepEqual(await read(a),saved);
  fixture.records.forEach((row,i)=>{for(const [key,value]of Object.entries(row))assert.equal(saved.deals[i][key],value);});
  const invalid=structuredClone(saved);invalid.deals.push({...saved.deals[0],id:4},{...saved.deals[1],id:5,f_follow:'not a date'});
  await assert.rejects(()=>write(a,invalid),e=>e.code==='PT400');assert.deepEqual(await read(a),saved);
  await assert.rejects(()=>write(a,{...original,deals:proposal.records}),e=>e.code==='PT409');assert.deepEqual(await read(a),saved);
  saved=await write(a,{...original,updatedAt:saved.updatedAt});assert.deepEqual(saved.deals,[]);assert.deepEqual(await read(b),other);
  assert.deepEqual((await db.query('select * from pipechat.usage_counters')).rows,quota);await run('tests/security.sql');
});
