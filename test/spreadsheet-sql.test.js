const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {randomUUID}=require('node:crypto'),{PGlite}=require('@electric-sql/pglite');
const Sheets=require('../public/spreadsheet-import.js'),Schema=require('../public/table-schema.js');
test('spreadsheet onboarding is atomic, exact, isolated, cap-independent and guarded by existing CAS',{timeout:120000},async t=>{
  const db=new PGlite();t.after(()=>db.close());
  for(const file of ['tests/mock-supabase.sql','migrations/001-supabase.sql','migrations/002-reset-workspace.sql','migrations/003-spreadsheet-setup.sql','tests/security.sql'])await db.exec(await fs.readFile(path.join(__dirname,'../db',file),'utf8'));
  async function user(){const u={id:randomUUID(),session_id:randomUUID()};await db.query('insert into auth.users(id) values ($1)',[u.id]);await db.query('insert into auth.sessions(id,user_id) values ($1,$2)',[u.session_id,u.id]);return u;}
  async function rpc(u,sql,args=[]){await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:u.id,session_id:u.session_id,role:'authenticated'})]);await db.exec('set role authenticated');try{return (await db.query(sql,args)).rows[0]?.result;}finally{await db.exec('reset role');}}
  const read=u=>rpc(u,'select public.pipechat_read_crm() result');
  const write=(u,rows,schema,version)=>rpc(u,'select public.pipechat_write_crm($1::jsonb,$2::jsonb,$3::jsonb,$4) result',[JSON.stringify(rows),'[]',JSON.stringify(schema),version]);
  const a=await user(),b=await user(),before=await read(a),bBefore=await read(b);
  await db.query('update pipechat.usage_counters set used=1,quota_limit=1 where user_id=$1',[a.id]);
  const built=Sheets.build([[' ID ','Owner','Value','Value','', ' Notes\nfull '],['001','Ravi','100',' $1.00 ','false','  line one\nline two  '],['','','0','','',''],['002','Sarah','25','N/A','','']],{useCase:'Sales'});
  await db.exec("create function pipechat.qa_import_fail() returns trigger language plpgsql as $$ begin raise exception 'QA late write failure'; end $$; create trigger qa_import_fail before update on pipechat.workspace_metadata for each row execute function pipechat.qa_import_fail();");
  await assert.rejects(()=>write(a,built.records,built.schema,null),e=>e.code==='P0001');assert.deepEqual(await read(a),before);
  await db.exec('drop trigger qa_import_fail on pipechat.workspace_metadata; drop function pipechat.qa_import_fail();');
  const result=await write(a,built.records,built.schema,null);assert.deepEqual(result.tableSchema,built.schema);assert.deepEqual(result.deals,built.records);assert.deepEqual(await read(a),result);assert.deepEqual(await read(b),bBefore);
  await assert.rejects(()=>write(a,built.records,built.schema,null),e=>e.code==='PT409');
  await assert.rejects(()=>write(a,[],Schema.legacySchema(),result.updatedAt),e=>e.code==='PT400');
  const usage=(await db.query('select used,quota_limit from pipechat.usage_counters where user_id=$1',[a.id])).rows[0];assert.deepEqual(usage,{used:1,quota_limit:1});
  const reset=await rpc(a,'select public.pipechat_reset_crm($1,true) result',[result.updatedAt]);assert.equal(reset.tableSchema.status,'pending');
  assert.equal((await write(a,[],Schema.legacySchema(),reset.updatedAt)).tableSchema.status,'ready');
});
