const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {randomUUID}=require('node:crypto'),{PGlite}=require('@electric-sql/pglite'),Schema=require('../public/table-schema'),X=require('../public/workspace-customization');
test('column ordering and text/date conversions persist with CAS, atomic rollback, isolation, undo and unchanged cards/quota',{timeout:120000},async t=>{
  const db=new PGlite();t.after(()=>db.close());
  const run=async file=>db.exec(await fs.readFile(path.join(__dirname,'../db',file),'utf8'));
  await run('tests/mock-supabase.sql');
  for(const file of (await fs.readdir(path.join(__dirname,'../db/migrations'))).filter(f=>/^00[1-8]-.*\.sql$/.test(f)).sort())await run('migrations/'+file);
  async function user(){const u={id:randomUUID(),session_id:randomUUID()};await db.query('insert into auth.users(id) values ($1)',[u.id]);await db.query('insert into auth.sessions(id,user_id) values ($1,$2)',[u.session_id,u.id]);return u;}
  async function rpc(u,name,args=[]){await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:u.id,session_id:u.session_id,role:'authenticated'})]);await db.exec('set role authenticated');try{return (await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) result`,args)).rows[0]?.result;}finally{await db.exec('reset role');}}
  const read=u=>rpc(u,'pipechat_read_workspace');
  const write=(u,s)=>rpc(u,'pipechat_write_workspace_v2',[JSON.stringify(s.deals),JSON.stringify(s.customFields),JSON.stringify(s.tableSchema),s.updatedAt,JSON.stringify(s.todoCards)]);
  const a=await user(),b=await user(),other=await read(b);
  const schema={status:'ready',useCase:'Other',title:'QA',description:'',recordLabel:'account',fields:[{id:'f_name',name:'Name',type:'text',role:'primary',options:[]},{id:'f_date',name:'Date',type:'text',role:'none',options:[]},{id:'f_status',name:'Status',type:'choice',role:'status',options:['Warm','Won']}]};
  const customFields=[{id:'cf_date',name:'Custom date',type:'text'}];
  let s=await write(a,{...await read(a),tableSchema:schema,customFields,todoCards:[]});
  s=await write(a,{...s,deals:[{id:1,f_name:'Alpha',f_date:'oct 5 2026',f_status:'Warm',cf_date:'2026-11-01',history:[]}],todoCards:[{id:'todo_qa',recordId:1,status:'To Do',nextAction:'Call',notes:'Independent',dueDate:'2026-12-01'}]});
  const original=structuredClone(s);await run('migrations/009-column-order-and-types.sql');await run('tests/security.sql');assert.deepEqual(await read(a),s);assert.deepEqual(await read(b),other);
  s=await write(a,{...s,tableSchema:Schema.reorder(s.tableSchema,s.customFields,'cf_date','f_name')});assert.deepEqual(s.tableSchema.columnOrder,['cf_date','f_name','f_date','f_status']);assert.deepEqual(s.deals,original.deals);
  for(const [field,targetType]of [['f_date','date'],['cf_date','date'],['f_status','text']]){
    const c=X.editColumn(s.deals,s.tableSchema,s.customFields,field,{targetType});s=await write(a,{...s,deals:c.records,customFields:c.customFields,tableSchema:c.tableSchema});assert.deepEqual(await read(a),s);
  }
  assert.equal(s.deals[0].f_date,'2026-10-05');assert.equal(s.deals[0].f_status,'Warm');assert.equal(s.customFields[0].type,'date');assert.deepEqual(s.todoCards,original.todoCards);
  await assert.rejects(()=>write(a,original),e=>e.code==='PT409');
  for(const columnOrder of [null,{},['f_name','f_name'],['<bad>'],Array(121).fill('f_name')])await assert.rejects(()=>write(a,{...s,tableSchema:{...s.tableSchema,columnOrder}}),e=>e.code==='PT400');
  await assert.rejects(()=>write(a,{...s,deals:[{...s.deals[0],f_date:'2026-02-30'}]}),e=>e.code==='PT400');assert.deepEqual(await read(a),s);
  s=await write(a,{...original,updatedAt:s.updatedAt});assert.deepEqual(s.deals,original.deals);assert.deepEqual(s.tableSchema,original.tableSchema);assert.deepEqual(s.customFields,original.customFields);assert.deepEqual(s.todoCards,original.todoCards);
  assert.deepEqual(await read(b),other);assert.equal((await db.query('select used from pipechat.usage_counters where user_id=$1',[a.id])).rows[0].used,0);
  await db.exec('set role anon');await assert.rejects(()=>db.query("select public.pipechat_write_workspace_v2('[]','[]','{}',null,'[]')"),e=>e.code==='42501');await db.exec('reset role');
  await db.query('delete from auth.sessions where id=$1',[a.session_id]);await assert.rejects(()=>write(a,s),e=>e.code==='PT401');
});
