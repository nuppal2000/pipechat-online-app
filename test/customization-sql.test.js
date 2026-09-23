const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {randomUUID}=require('node:crypto'),{PGlite}=require('@electric-sql/pglite');
const X=require('../public/workspace-customization.js');
test('column/KPI migration preserves atomicity, CAS, rows, isolation and private grants',{timeout:120000},async t=>{
  const db=new PGlite();t.after(()=>db.close());
  for(const file of ['tests/mock-supabase.sql','migrations/001-supabase.sql','migrations/002-reset-workspace.sql','migrations/003-spreadsheet-setup.sql','migrations/004-column-and-kpi-customization.sql','migrations/005-kpi-lifecycle.sql','tests/security.sql'])await db.exec(await fs.readFile(path.join(__dirname,'../db',file),'utf8'));
  async function user(){const u={id:randomUUID(),session_id:randomUUID()};await db.query('insert into auth.users(id) values ($1)',[u.id]);await db.query('insert into auth.sessions(id,user_id) values ($1,$2)',[u.session_id,u.id]);return u;}
  async function rpc(u,sql,args=[]){await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:u.id,session_id:u.session_id,role:'authenticated'})]);await db.exec('set role authenticated');try{return (await db.query(sql,args)).rows[0]?.result;}finally{await db.exec('reset role');}}
  const read=u=>rpc(u,'select public.pipechat_read_crm() result');
  const write=(u,rows,schema,custom,version)=>rpc(u,'select public.pipechat_write_crm($1::jsonb,$2::jsonb,$3::jsonb,$4) result',[JSON.stringify(rows),JSON.stringify(custom),JSON.stringify(schema),version]);
  const a=await user(),b=await user(),bBefore=await read(b);
  const schema={status:'ready',useCase:'Sales',title:'Sales',description:'',recordLabel:'deal',fields:[{id:'f_name',name:'Company',type:'text',role:'primary',options:[]},{id:'f_score',name:'Score',type:'number',role:'none',options:[]}]};
  let saved=await write(a,[],schema,[],null);
  const rows=[{id:1,f_name:'A',f_score:0,cf_status:'warm',history:[],activity:'',health:''},{id:2,f_name:'B',f_score:20,cf_status:'d',history:[],activity:'',health:''}],custom=[{id:'cf_status',name:'Status',type:'text'}];
  saved=await write(a,rows,schema,custom,saved.updatedAt);
  const renamed=X.editColumn(rows,schema,custom,'f_name',{name:'Customer'});
  saved=await write(a,renamed.records,renamed.tableSchema,renamed.customFields,saved.updatedAt);assert.deepEqual(saved.deals,rows);
  const converted=X.editColumn(saved.deals,saved.tableSchema,saved.customFields,'cf_status',{options:['Warm','Won']});
  const before=saved;
  await db.exec("create function pipechat.qa_customize_fail() returns trigger language plpgsql as $$ begin raise exception 'Late QA failure'; end $$; create trigger qa_customize_fail before update on pipechat.workspace_metadata for each row execute function pipechat.qa_customize_fail();");
  await assert.rejects(()=>write(a,converted.records,converted.tableSchema,converted.customFields,saved.updatedAt),e=>e.code==='P0001');assert.deepEqual(await read(a),before);
  await db.exec('drop trigger qa_customize_fail on pipechat.workspace_metadata; drop function pipechat.qa_customize_fail();');
  saved=await write(a,converted.records,converted.tableSchema,converted.customFields,saved.updatedAt);assert.deepEqual(saved.customFields,converted.customFields);assert.deepEqual(saved.deals,converted.records);
  const tuned=X.configure(saved.tableSchema,saved.customFields,'kpi_f_score',{title:'Average score',metric:'average',field:'f_score',conditions:[]});
  saved=await write(a,saved.deals,tuned.tableSchema,saved.customFields,saved.updatedAt);assert.deepEqual((await read(a)).tableSchema,tuned.tableSchema);
  const extra=X.addKpi(saved.tableSchema,saved.customFields,'kpi_user_test',{title:'Total follow-ups',metric:'count',field:null,conditions:[{field:'cf_status',operator:'is_not_blank',value:null}]});
  saved=await write(a,saved.deals,extra.tableSchema,saved.customFields,saved.updatedAt);
  assert.equal(X.kpis((await read(a)).tableSchema,saved.customFields).length,3);
  const removed=X.deleteKpi(saved.tableSchema,saved.customFields,'kpi_f_score');
  saved=await write(a,saved.deals,removed.tableSchema,saved.customFields,saved.updatedAt);
  assert.deepEqual((await read(a)).tableSchema.hiddenKpis,['kpi_f_score']);assert.equal(X.kpis(saved.tableSchema,saved.customFields).length,2);
  assert.deepEqual(saved.deals,converted.records);
  for(const hiddenKpis of [null,'kpi_records',['kpi_records','kpi_records'],['bad'],[null],Array.from({length:121},(_,i)=>'kpi_'+i)]){
    await assert.rejects(()=>write(a,saved.deals,{...saved.tableSchema,hiddenKpis},saved.customFields,saved.updatedAt),e=>e.code==='PT400');assert.deepEqual(await read(a),saved);
  }
  for(const k of [{...tuned.after,field:'missing'},{...tuned.after,conditions:[{field:'f_name',operator:'older_than_days',value:1}]},{...tuned.after,metric:'execute'},{...tuned.after,conditions:[{field:'f_score',operator:'gt',value:'1 OR 1=1'}]}]){
    await assert.rejects(()=>write(a,saved.deals,{...saved.tableSchema,kpis:[k]},saved.customFields,saved.updatedAt),e=>e.code==='PT400');assert.deepEqual(await read(a),saved);
  }
  await assert.rejects(()=>write(a,rows,schema,custom,before.updatedAt),e=>e.code==='PT409');
  saved=await write(a,rows,schema,custom,saved.updatedAt);assert.deepEqual(saved.deals,rows);assert.deepEqual(saved.tableSchema,schema);
  assert.deepEqual(await read(b),bBefore);assert.equal((await db.query('select used from pipechat.usage_counters where user_id=$1',[a.id])).rows[0].used,0);
  await assert.rejects(()=>rpc(a,"select pipechat.validate_kpis('[]'::jsonb) result"),e=>e.code==='42501');
});
