const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {randomUUID}=require('node:crypto'),{PGlite}=require('@electric-sql/pglite'),T=require('../public/todo-core'),Schema=require('../public/table-schema');
test('standalone card SQL persistence, compatibility, isolation, rollback, pruning, undo and reset',{timeout:120000},async t=>{
  const db=new PGlite();t.after(()=>db.close());
  const run=async file=>db.exec(await fs.readFile(path.join(__dirname,'../db',file),'utf8'));
  await run('tests/mock-supabase.sql');
  for(const file of (await fs.readdir(path.join(__dirname,'../db/migrations'))).filter(f=>/^00[1-7]-.*\.sql$/.test(f)).sort())await run('migrations/'+file);
  async function user(){const u={id:randomUUID(),session_id:randomUUID()};await db.query('insert into auth.users(id) values ($1)',[u.id]);await db.query('insert into auth.sessions(id,user_id) values ($1,$2)',[u.session_id,u.id]);return u;}
  async function rpc(u,name,args=[]){await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:u.id,session_id:u.session_id,role:'authenticated'})]);await db.exec('set role authenticated');try{return (await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) result`,args)).rows[0]?.result;}finally{await db.exec('reset role');}}
  const read=u=>rpc(u,'pipechat_read_workspace'),todo=(u,s,c)=>rpc(u,'pipechat_write_todo',[JSON.stringify(c),s.updatedAt]);
  const write=(u,s)=>rpc(u,'pipechat_write_workspace_v2',[JSON.stringify(s.deals),JSON.stringify(s.customFields),JSON.stringify(s.tableSchema),s.updatedAt,JSON.stringify(s.todoCards)]);
  const a=await user(),b=await user(),bBefore=await read(b),row={id:1,account:'Acme',stage:'Discovery',value:0,close:'',owner:'Sarah',follow:'',next:'',notes:'',history:[],activity:'',health:''};
  let s=await write(a,{...await read(a),deals:[],tableSchema:Schema.legacySchema(),todoCards:[]});
  s=await write(a,{...s,deals:[row],todoCards:[T.create('todo_linked',1)]});
  const before=s;await run('migrations/008-custom-todo-titles.sql');await run('tests/security.sql');assert.deepEqual(await read(a),before);
  const custom=T.create('todo_custom',null,'Weekly review');
  await db.exec("create function pipechat.qa_no_crm() returns trigger language plpgsql as $$ begin raise exception 'CRM write forbidden';end $$;create trigger qa_no_crm before insert or update or delete on pipechat.crm_records for each statement execute function pipechat.qa_no_crm();");
  s=await todo(a,s,[...s.todoCards,custom]);assert.deepEqual(s.deals,before.deals);assert.deepEqual(s.tableSchema,before.tableSchema);
  assert.deepEqual((await read(a)).todoCards,s.todoCards);assert.deepEqual(await read(b),bBefore);
  await assert.rejects(()=>todo(a,before,[]),e=>e.code==='PT409');
  for(const patch of [{customTitle:''},{customTitle:' \n\t\u00a0\ufeff'},{customTitle:'x'.repeat(501)},{customTitle:null},{customTitle:'a\x01'},{recordId:1},{recordId:'1'},{extra:true}])await assert.rejects(()=>todo(a,s,[{...custom,...patch}]),e=>e.code==='PT400');
  const hybrid={...custom,recordId:1};delete hybrid.customTitle;await assert.rejects(()=>todo(a,s,[hybrid]),e=>e.code==='PT400');
  await assert.rejects(()=>todo(b,bBefore,[T.create('todo_linked',1)]),e=>e.code==='PT400');
  assert.deepEqual(await read(a),s);
  await db.exec('drop trigger qa_no_crm on pipechat.crm_records;drop function pipechat.qa_no_crm();');
  const saved=s;s=await write(a,{...s,deals:[],todoCards:[custom]});assert.deepEqual(s.todoCards,[custom]);
  s=await write(a,{...saved,updatedAt:s.updatedAt});assert.deepEqual(s.todoCards,saved.todoCards);
  // Old CRM-only writes must prune linked cards but keep standalone tasks.
  await rpc(a,'pipechat_write_crm',['[]','[]',JSON.stringify(s.tableSchema),s.updatedAt]);s=await read(a);assert.deepEqual(s.todoCards,[custom]);
  const beforeFail=s;
  await assert.rejects(()=>write(a,{...s,deals:[row],todoCards:[{...custom,customTitle:''}]}),e=>e.code==='PT400');assert.deepEqual(await read(a),beforeFail);
  await db.exec('set role anon');await assert.rejects(()=>db.query("select public.pipechat_write_todo('[]',null)"),e=>e.code==='42501');await db.exec('reset role');
  await assert.rejects(()=>rpc(a,'pipechat_reset_crm',[s.updatedAt,false]),e=>e.code==='PT400');
  const reset=await rpc(a,'pipechat_reset_crm',[s.updatedAt,true]);assert.deepEqual(reset.todoCards,[]);assert.deepEqual((await read(a)).tableSchema,{status:'pending'});
  assert.equal((await db.query('select used from pipechat.usage_counters where user_id=$1',[a.id])).rows[0].used,0);assert.deepEqual(await read(b),bBefore);
  await db.query('delete from auth.sessions where id=$1',[a.session_id]);await assert.rejects(()=>todo(a,reset,[custom]),e=>e.code==='PT401');
});
