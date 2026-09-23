const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {randomUUID}=require('node:crypto'),{PGlite}=require('@electric-sql/pglite'),T=require('../public/todo-core.js'),Schema=require('../public/table-schema.js');
test('To Do migration is atomic, scoped, versioned, compatible with old clients and reset-safe',{timeout:120000},async t=>{
  const db=new PGlite();t.after(()=>db.close());
  for(const file of ['tests/mock-supabase.sql','migrations/001-supabase.sql','migrations/002-reset-workspace.sql','migrations/003-spreadsheet-setup.sql','migrations/004-column-and-kpi-customization.sql','migrations/005-kpi-lifecycle.sql','migrations/006-todo-board.sql','tests/security.sql'])await db.exec(await fs.readFile(path.join(__dirname,'../db',file),'utf8'));
  async function user(){const u={id:randomUUID(),session_id:randomUUID()};await db.query('insert into auth.users(id) values ($1)',[u.id]);await db.query('insert into auth.sessions(id,user_id) values ($1,$2)',[u.session_id,u.id]);return u;}
  async function rpc(u,sql,args=[]){await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:u.id,session_id:u.session_id,role:'authenticated'})]);await db.exec('set role authenticated');try{return (await db.query(sql,args)).rows[0]?.result;}finally{await db.exec('reset role');}}
  const read=u=>rpc(u,'select public.pipechat_read_crm() result');
  const write=(u,s,cards)=>rpc(u,cards===undefined?'select public.pipechat_write_crm($1::jsonb,$2::jsonb,$3::jsonb,$4) result':'select public.pipechat_write_workspace($1::jsonb,$2::jsonb,$3::jsonb,$4,$5::jsonb) result',[JSON.stringify(s.deals),JSON.stringify(s.customFields),JSON.stringify(s.tableSchema),s.updatedAt,...(cards===undefined?[]:[JSON.stringify(cards)])]);
  const a=await user(),b=await user(),bBefore=await read(b);assert.deepEqual(bBefore.todoCards,[]);
  const row={id:1,account:'Acme',owner:'Sarah',next:'Call',follow:'Tomorrow',notes:'',stage:'Discovery',value:0,close:'',history:[],activity:'',health:''};
  let saved=await write(a,{deals:[],tableSchema:Schema.legacySchema(),customFields:[],updatedAt:null},[]);
  saved=await write(a,{...saved,deals:[row]},[]);
  const card=T.create('todo_one',1,saved.tableSchema),cards=[card];
  saved=await write(a,saved,cards);assert.deepEqual(saved.todoCards,cards);assert.deepEqual((await read(a)).todoCards,cards);
  const before=saved;
  await assert.rejects(()=>write(a,{...saved,deals:[{...row,notes:'must roll back'}]},[{...card,recordId:999}]),e=>e.code==='PT400');assert.deepEqual(await read(a),before);
  await db.exec("create function pipechat.qa_todo_fail() returns trigger language plpgsql as $$ begin if new.todo_cards <> old.todo_cards then raise exception 'Late failure'; end if;return new;end $$;create trigger qa_todo_fail after update on pipechat.workspace_metadata for each row execute function pipechat.qa_todo_fail();");
  await assert.rejects(()=>write(a,{...saved,deals:[{...row,notes:'must roll back too'}]},[{...card,status:'Done'}]),e=>e.code==='P0001');assert.deepEqual(await read(a),before);
  await db.exec('drop trigger qa_todo_fail on pipechat.workspace_metadata;drop function pipechat.qa_todo_fail();');
  saved=await write(a,{...saved,deals:[{...row,follow:'Next week'}]},cards);assert.equal(T.project(saved.todoCards[0],saved.deals,saved.tableSchema).dueDate,'Next week');
  await assert.rejects(()=>write(a,before,[]),e=>e.code==='PT409');
  for(const patch of [{status:'Other'},{dueDate:'2026-02-30'},{ownerField:'missing'},{nextAction:'x'.repeat(501)},{extra:true}])await assert.rejects(()=>write(a,saved,[{...card,...patch}]),e=>e.code==='PT400');
  saved=await write(a,saved);assert.deepEqual(saved.todoCards,cards);
  const deleted=await write(a,{...saved,deals:[]});assert.deepEqual(deleted.todoCards,[]);
  saved=await write(a,{...saved,updatedAt:deleted.updatedAt});assert.deepEqual(saved.todoCards,[],'old client cannot resurrect a deleted card');
  saved=await write(a,saved,cards);assert.deepEqual(saved.todoCards,cards,'undo can explicitly restore cards');
  assert.deepEqual(await read(b),bBefore);
  await assert.rejects(()=>rpc(a,"select pipechat.validate_todo('[]','[]','[]') result"),e=>e.code==='42501');
  await db.exec('set role anon');await assert.rejects(()=>db.query("select public.pipechat_write_workspace('[]','[]','null',null,'[]')"),e=>e.code==='42501');await db.exec('reset role');
  const reset=await rpc(a,'select public.pipechat_reset_crm($1,true) result',[saved.updatedAt]);assert.deepEqual(reset.todoCards,[]);assert.deepEqual(reset.deals,[]);assert.equal(reset.tableSchema.status,'pending');
  assert.equal((await db.query('select used from pipechat.usage_counters where user_id=$1',[a.id])).rows[0].used,0);
  await db.query('delete from auth.sessions where id=$1',[a.session_id]);await assert.rejects(()=>write(a,reset,[]),e=>e.code==='PT401');
});
