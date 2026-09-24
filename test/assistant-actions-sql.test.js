const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {randomUUID}=require('node:crypto'),{PGlite}=require('@electric-sql/pglite');
const Core=require('../public/pipeline-core'),T=require('../public/todo-core'),fixture=require('./fixtures/assistant-actions.cjs');
test('new dropdown and task batches persist on current Supabase schema with rollback, isolation, Undo and independent CRM changes',{timeout:120000},async t=>{
  const db=new PGlite();t.after(()=>db.close());const run=async name=>db.exec(await fs.readFile(path.join(__dirname,'../db',name),'utf8'));
  await run('tests/mock-supabase.sql');for(const file of (await fs.readdir(path.join(__dirname,'../db/migrations'))).filter(f=>/^\d{3}-.*\.sql$/.test(f)).sort())await run('migrations/'+file);
  async function user(){const u={id:randomUUID(),session_id:randomUUID()};await db.query('insert into auth.users(id) values ($1)',[u.id]);await db.query('insert into auth.sessions(id,user_id) values ($1,$2)',[u.session_id,u.id]);return u;}
  async function rpc(u,name,args=[]){await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:u.id,session_id:u.session_id,role:'authenticated'})]);await db.exec('set role authenticated');try{return (await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) result`,args)).rows[0].result;}finally{await db.exec('reset role');}}
  const read=u=>rpc(u,'pipechat_read_workspace'),write=(u,s)=>rpc(u,'pipechat_write_workspace_v2',[JSON.stringify(s.deals),JSON.stringify(s.customFields),JSON.stringify(s.tableSchema),s.updatedAt,JSON.stringify(s.todoCards)]),todo=(u,s,c)=>rpc(u,'pipechat_write_todo',[JSON.stringify(c),s.updatedAt]);
  const a=await user(),b=await user(),other=await read(b),quota=(await db.query('select * from pipechat.usage_counters')).rows;
  let saved=await write(a,{...await read(a),tableSchema:fixture.schema,deals:[],customFields:[],todoCards:[]});saved=await write(a,{...saved,deals:fixture.records});
  const original=structuredClone(saved),field={id:'cf_test',name:'test',type:'choice',options:['hot','medium','cold']};
  saved=await write(a,{...saved,customFields:[field],deals:saved.deals.map(r=>({...r,cf_test:''}))});assert.deepEqual(await read(a),saved);assert.deepEqual(saved.customFields,[field]);assert(saved.deals.every(r=>r.cf_test===''));
  saved=await write(a,{...saved,deals:saved.deals.map((r,i)=>({...r,cf_test:i===0?'hot':''}))});assert.equal((await read(a)).deals[0].cf_test,'hot');
  const beforeCards=structuredClone(saved),proposal=T.plan(saved.todoCards,saved.deals,saved.tableSchema,saved.customFields,fixture.todos,'todo_batch');
  await db.exec("create function pipechat.qa_no_crm() returns trigger language plpgsql as $$ begin raise exception 'CRM write forbidden';end $$;create trigger qa_no_crm before insert or update or delete on pipechat.crm_records for each statement execute function pipechat.qa_no_crm();");
  saved=await todo(a,saved,proposal.cards);assert.deepEqual((await read(a)).todoCards,proposal.cards);assert.deepEqual(saved.deals,beforeCards.deals);assert.equal(saved.todoCards.length,2);
  await assert.rejects(()=>todo(a,beforeCards,[]),e=>e.code==='PT409');
  await assert.rejects(()=>todo(a,saved,[...saved.todoCards,{...T.create('todo_bad',1),dueDate:'2026-02-30'}]),e=>e.code==='PT400');assert.deepEqual(await read(a),saved);
  saved=await todo(a,saved,[]);assert.deepEqual(saved.todoCards,[]);saved=await todo(a,saved,proposal.cards);
  await db.exec('drop trigger qa_no_crm on pipechat.crm_records;drop function pipechat.qa_no_crm();');
  const core=Core.create(saved.tableSchema),changes=core.plan(saved.deals,fixture.crm,saved.customFields);saved=await write(a,{...saved,deals:core.apply(saved.deals,changes,'QA',new Date(),saved.customFields)});
  assert.equal(saved.deals[0].f_source,'Referral');assert.equal(saved.deals[1].f_source,'Website');assert.equal(saved.deals[1].f_stage,'Negotiation');assert.deepEqual(saved.todoCards,proposal.cards);
  saved=await write(a,{...original,updatedAt:saved.updatedAt});assert.deepEqual(saved.deals,original.deals);assert.deepEqual(saved.customFields,[]);assert.deepEqual(saved.todoCards,[]);
  assert.deepEqual(await read(b),other);assert.deepEqual((await db.query('select * from pipechat.usage_counters')).rows,quota);await run('tests/security.sql');
});
