const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {randomUUID}=require('node:crypto');
const {PGlite}=require('@electric-sql/pglite');
const schema=require('../public/table-schema.js').legacySchema();

test('reset RPC is owner-only, confirmed, atomic and preserves identity and allowance',{timeout:120000},async t=>{
  const db=new PGlite();t.after(()=>db.close());
  for(const file of ['tests/mock-supabase.sql','migrations/001-supabase.sql','migrations/002-reset-workspace.sql'])await db.exec(await fs.readFile(path.join(__dirname,'../db',file),'utf8'));
  await db.exec(await fs.readFile(path.join(__dirname,'../db/tests/security.sql'),'utf8'));
  async function user(){const u={id:randomUUID(),session_id:randomUUID()};await db.query('insert into auth.users(id) values ($1)',[u.id]);await db.query('insert into auth.sessions(id,user_id) values ($1,$2)',[u.session_id,u.id]);return u;}
  async function rpc(u,sql,args=[],role='authenticated'){
    await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify(u?{sub:u.id,session_id:u.session_id,role}:{})]);
    await db.exec('set role '+role);try{return (await db.query(sql,args)).rows[0]?.result;}finally{await db.exec('reset role');}
  }
  const read=u=>rpc(u,'select public.pipechat_read_crm() as result');
  const reset=(u,v,confirm=true,role)=>rpc(u,'select public.pipechat_reset_crm($1,$2) as result',[v,confirm],role);
  const write=(u,rows,version)=>rpc(u,'select public.pipechat_write_crm($1::jsonb,$2::jsonb,$3::jsonb,$4) as result',[JSON.stringify(rows),'[]',JSON.stringify(schema),version]);
  const denied=(fn,code)=>assert.rejects(fn,e=>e.code===code);
  const a=await user(),b=await user();let aData=await write(a,[],null);aData=await write(a,[{id:1,account:'Private A',history:['QA'],activity:'QA',health:''}],aData.updatedAt);
  const bData=await write(b,[],null);
  await db.query('update pipechat.usage_counters set used=1,quota_limit=1 where user_id=$1',[a.id]);
  const preserved=async()=>({users:(await db.query('select * from auth.users order by id')).rows,sessions:(await db.query('select * from auth.sessions order by id')).rows,usage:(await db.query('select * from pipechat.usage_counters order by user_id')).rows});
  const before=await preserved();
  await denied(()=>reset(null,aData.updatedAt,true,'anon'),'42501');
  await denied(()=>reset(a,aData.updatedAt,true,'service_role'),'42501');
  await denied(()=>reset(null,aData.updatedAt),'PT401');
  await denied(()=>reset({...a,session_id:b.session_id},aData.updatedAt),'PT401');
  await denied(()=>reset(a,aData.updatedAt,false),'PT400');await denied(()=>reset(a,aData.updatedAt,null),'PT400');
  await denied(()=>reset(a,null),'PT409');await denied(()=>reset(a,'stale'),'PT409');
  await denied(()=>reset(a,''),'PT400');assert.deepEqual(await read(a),aData);
  await db.exec("create function pipechat.qa_reset_failure() returns trigger language plpgsql as $$ begin raise exception 'QA late reset failure'; end $$; create trigger qa_reset_failure before update on pipechat.workspace_metadata for each row execute function pipechat.qa_reset_failure();");
  await denied(()=>reset(a,aData.updatedAt),'P0001');assert.deepEqual(await read(a),aData);assert.deepEqual(await preserved(),before);
  await db.exec('drop trigger qa_reset_failure on pipechat.workspace_metadata; drop function pipechat.qa_reset_failure();');
  const result=await reset(a,aData.updatedAt);assert.deepEqual(result.deals,[]);assert.deepEqual(result.customFields,[]);assert.deepEqual(result.tableSchema,{status:'pending'});assert(result.updatedAt>aData.updatedAt);
  assert.deepEqual(await read(a),result);assert.deepEqual(await read(b),bData);assert.deepEqual(await preserved(),before);
  await denied(()=>reset(a,aData.updatedAt),'PT409');await denied(()=>write(a,aData.deals,aData.updatedAt),'PT409');
  const ready=await write(a,[],result.updatedAt);assert.equal(ready.tableSchema.status,'ready');
  await db.query('delete from auth.sessions where id=$1',[a.session_id]);await denied(()=>reset(a,ready.updatedAt),'PT401');
  const member=await user();await db.query('delete from pipechat.workspaces where owner_id=$1',[member.id]);await db.query("insert into pipechat.memberships(workspace_id,user_id,role) select workspace_id,$1,'member' from pipechat.memberships where user_id=$2",[member.id,b.id]);
  await denied(()=>reset(member,bData.updatedAt),'PT403');assert.deepEqual(await read(b),bData);
});
