const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {randomUUID}=require('node:crypto'),{PGlite}=require('@electric-sql/pglite');
const P=require('../public/workspace-plan.js'),F=require('./fixtures/workspace-plans.cjs');
test('one workspace transaction saves schema, cells and tasks; late errors roll all back, CAS/isolation and full Undo hold',{timeout:120000},async t=>{
  const db=new PGlite();t.after(()=>db.close());const run=async name=>db.exec(await fs.readFile(path.join(__dirname,'../db',name),'utf8'));
  await run('tests/mock-supabase.sql');for(const file of (await fs.readdir(path.join(__dirname,'../db/migrations'))).filter(f=>/^\d{3}-.*\.sql$/.test(f)).sort())await run('migrations/'+file);
  async function user(){const u={id:randomUUID(),session_id:randomUUID()};await db.query('insert into auth.users(id) values ($1)',[u.id]);await db.query('insert into auth.sessions(id,user_id) values ($1,$2)',[u.session_id,u.id]);return u;}
  async function rpc(u,name,args=[]){await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:u.id,session_id:u.session_id,role:'authenticated'})]);await db.exec('set role authenticated');try{return (await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) result`,args)).rows[0].result;}finally{await db.exec('reset role');}}
  const read=u=>rpc(u,'pipechat_read_workspace'),write=(u,s)=>rpc(u,'pipechat_write_workspace_v2',[JSON.stringify(s.deals),JSON.stringify(s.customFields),JSON.stringify(s.tableSchema),s.updatedAt,JSON.stringify(s.todoCards)]);
  const a=await user(),b=await user(),other=await read(b),quota=(await db.query('select * from pipechat.usage_counters')).rows;
  let saved=await write(a,{...await read(a),tableSchema:F.schema,deals:[],customFields:[],todoCards:[]});saved=await write(a,{...saved,deals:F.records});const original=structuredClone(saved);
  const action=F.risk();action.steps.push(F.tasks('tasks','medium'));action.goals.push({description:'Create tasks for Medium risk deals',stepIds:['tasks']});
  const p=P.prepare({records:saved.deals,customFields:saved.customFields,tableSchema:saved.tableSchema,todoCards:saved.todoCards},action,{today:'2026-09-25',nonce:'sql'});
  const proposed={deals:p.next.records,customFields:p.next.customFields,tableSchema:p.next.tableSchema,todoCards:p.next.todoCards,updatedAt:saved.updatedAt};
  await assert.rejects(()=>write(a,{...proposed,todoCards:[...proposed.todoCards,{...proposed.todoCards[0],id:'todo_invalid',recordId:999999}]}),e=>e.code==='PT400');assert.deepEqual(await read(a),original);
  saved=await write(a,proposed);assert.deepEqual(await read(a),saved);assert.equal(saved.todoCards.length,2);assert.equal(saved.customFields[0].name,'Risk Level');assert.equal(saved.deals[0][saved.customFields[0].id],'Medium');
  await assert.rejects(()=>write(a,proposed),e=>e.code==='PT409');assert.deepEqual(await read(a),saved);
  saved=await write(a,{...original,updatedAt:saved.updatedAt});assert.deepEqual(saved.deals,original.deals);assert.deepEqual(saved.customFields,original.customFields);assert.deepEqual(saved.todoCards,original.todoCards);assert.deepEqual(saved.tableSchema,original.tableSchema);
  assert.deepEqual(await read(b),other);assert.deepEqual((await db.query('select * from pipechat.usage_counters')).rows,quota);await run('tests/security.sql');
});
