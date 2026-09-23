const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {randomUUID}=require('node:crypto'),{PGlite}=require('@electric-sql/pglite'),Types=require('../public/spreadsheet-types'),Duplicates=require('../public/import-duplicates');
test('typed spreadsheet onboarding and merged append persist on current Supabase schema without changing another account or quota',{timeout:120000},async t=>{
  const db=new PGlite();t.after(()=>db.close());
  const run=async file=>db.exec(await fs.readFile(path.join(__dirname,'../db',file),'utf8'));
  await run('tests/mock-supabase.sql');
  for(const file of (await fs.readdir(path.join(__dirname,'../db/migrations'))).filter(f=>/^00[1-9]-.*\.sql$/.test(f)).sort())await run('migrations/'+file);
  await run('tests/security.sql');
  async function user(){const u={id:randomUUID(),session_id:randomUUID()};await db.query('insert into auth.users(id) values ($1)',[u.id]);await db.query('insert into auth.sessions(id,user_id) values ($1,$2)',[u.session_id,u.id]);return u;}
  async function rpc(u,name,args=[]){await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:u.id,session_id:u.session_id,role:'authenticated'})]);await db.exec('set role authenticated');try{return (await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) result`,args)).rows[0]?.result;}finally{await db.exec('reset role');}}
  const read=u=>rpc(u,'pipechat_read_workspace'),write=(u,s)=>rpc(u,'pipechat_write_workspace_v2',[JSON.stringify(s.deals),JSON.stringify(s.customFields),JSON.stringify(s.tableSchema),s.updatedAt,JSON.stringify(s.todoCards)]);
  const a=await user(),b=await user(),other=await read(b),empty=await read(a);
  const matrix=[['Name','Status','Amount','Date'],['A','Warm','$1,200','Oct 5 2026'],['B','Warm','0','2026-11-02']];
  const built=Types.build(matrix,{useCase:'Sales',primary:0,idPrefix:'qa'},{columns:['text','choice','currency','date'].map((type,index)=>({index,type,reason:'Synthetic'}))});
  let s=await write(a,{...empty,tableSchema:built.schema,deals:built.records});assert.deepEqual(s.deals,built.records);assert.deepEqual(s.tableSchema,built.schema);assert.deepEqual(await read(a),s);
  const incoming=[{...s.deals[0],id:3,f_qa_2:999},{...s.deals[1],id:4,f_qa_0:'New'},{...s.deals[1],id:5,f_qa_0:'NEW'}];
  const merged=Duplicates.review(s.deals,incoming,'f_qa_0');assert.equal(merged.records.length,1);
  const before=s;s=await write(a,{...s,deals:[...s.deals,...merged.records]});assert.deepEqual(s.deals.slice(0,2),before.deals);assert.equal(s.deals.length,3);assert.deepEqual(await read(a),s);
  await assert.rejects(()=>write(a,before),e=>e.code==='PT409');assert.deepEqual(await read(b),other);
  s=await write(a,{...before,updatedAt:s.updatedAt});assert.deepEqual(s.deals,built.records);
  assert.equal((await db.query('select used from pipechat.usage_counters where user_id=$1',[a.id])).rows[0].used,0);
});
