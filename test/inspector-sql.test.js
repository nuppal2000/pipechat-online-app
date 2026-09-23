const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {randomUUID}=require('node:crypto'),{PGlite}=require('@electric-sql/pglite'),H=require('../public/inspector-core.js'),Schema=require('../public/table-schema.js');
test('inspector notes persist through the existing authenticated workspace RPC, isolate users and respect stale writes',{timeout:120000},async t=>{
  const db=new PGlite();t.after(()=>db.close());
  for(const file of ['tests/mock-supabase.sql','migrations/001-supabase.sql','migrations/002-reset-workspace.sql','migrations/003-spreadsheet-setup.sql','migrations/004-column-and-kpi-customization.sql','migrations/005-kpi-lifecycle.sql','migrations/006-todo-board.sql'])await db.exec(await fs.readFile(path.join(__dirname,'../db',file),'utf8'));
  async function user(){const u={id:randomUUID(),session_id:randomUUID()};await db.query('insert into auth.users(id) values ($1)',[u.id]);await db.query('insert into auth.sessions(id,user_id) values ($1,$2)',[u.session_id,u.id]);return u;}
  async function rpc(u,sql,args=[]){await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:u.id,session_id:u.session_id,role:'authenticated'})]);await db.exec('set role authenticated');try{return(await db.query(sql,args)).rows[0]?.result;}finally{await db.exec('reset role');}}
  const read=u=>rpc(u,'select public.pipechat_read_crm() result');
  const write=(u,s)=>rpc(u,'select public.pipechat_write_workspace($1::jsonb,$2::jsonb,$3::jsonb,$4,$5::jsonb) result',[JSON.stringify(s.deals),JSON.stringify(s.customFields),JSON.stringify(s.tableSchema),s.updatedAt,JSON.stringify(s.todoCards)]);
  const a=await user(),b=await user(),beforeB=await read(b);
  const schema=Schema.legacySchema();let saved=await write(a,{deals:[],customFields:[],tableSchema:schema,updatedAt:null,todoCards:[]});
  const row={id:1,account:'Acme',owner:'Sarah',next:'Call',follow:'Tomorrow',notes:'Existing table notes',stage:'Discovery',value:0,close:'',history:[],activity:'',health:''};
  saved=await write(a,{...saved,deals:[row]});const original=saved;
  const next=H.addNote(saved.deals,1,'Inspector note\nwith complete text <b>','QA','n1');
  saved=await write(a,{...saved,deals:next});assert.deepEqual((await read(a)).deals,next);assert.equal(saved.deals[0].notes,'Existing table notes');
  await assert.rejects(()=>write(a,original),e=>e.code==='PT409');assert.deepEqual(await read(b),beforeB);
  assert.equal((await db.query('select used from pipechat.usage_counters where user_id=$1',[a.id])).rows[0].used,0);
  const invalid={...saved,deals:[{...saved.deals[0],history:[{private:true}]}]};await assert.rejects(()=>write(a,invalid),e=>e.code==='PT400');assert.deepEqual(await read(a),saved);
});
