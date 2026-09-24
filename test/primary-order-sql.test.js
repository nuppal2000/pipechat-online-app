const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {randomUUID}=require('node:crypto'),{PGlite}=require('@electric-sql/pglite');
const Schema=require('../public/table-schema'),Core=require('../public/pipeline-core');
test('first-column identity persists across base/custom/typed moves, deletion and undo without touching values, cards, quota or other users',{timeout:120000},async t=>{
  const db=new PGlite();t.after(()=>db.close());
  const run=async name=>db.exec(await fs.readFile(path.join(__dirname,'../db',name),'utf8'));
  await run('tests/mock-supabase.sql');
  for(const file of (await fs.readdir(path.join(__dirname,'../db/migrations'))).filter(f=>/^\d{3}-.*\.sql$/.test(f)&&!f.startsWith('011')).sort())await run('migrations/'+file);
  async function user(){const u={id:randomUUID(),session_id:randomUUID()};await db.query('insert into auth.users(id) values ($1)',[u.id]);await db.query('insert into auth.sessions(id,user_id) values ($1,$2)',[u.session_id,u.id]);return u;}
  async function rpc(u,name,args=[]){await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:u.id,session_id:u.session_id,role:'authenticated'})]);await db.exec('set role authenticated');try{return (await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) result`,args)).rows[0].result;}finally{await db.exec('reset role');}}
  const read=u=>rpc(u,'pipechat_read_workspace'),write=(u,s)=>rpc(u,'pipechat_write_workspace_v2',[JSON.stringify(s.deals),JSON.stringify(s.customFields),JSON.stringify(s.tableSchema),s.updatedAt,JSON.stringify(s.todoCards)]);
  const a=await user(),b=await user(),other=await read(b);
  const field=(id,type,role)=>({id,name:id,type,role,options:[]});
  const schema={status:'ready',useCase:'Other',title:'QA',description:'',recordLabel:'record',fields:[field('f_name','text','primary'),field('f_client','text','owner'),field('f_value','number','none'),field('f_date','date','followup')]};
  let s=await write(a,{...await read(a),tableSchema:schema,customFields:[{id:'cf_contact',name:'Contact',type:'text'}],todoCards:[]});
  s=await write(a,{...s,deals:[{id:1,f_name:'A',f_client:'',f_value:0,f_date:'2026-10-05',cf_contact:'Person',history:[]},{id:2,f_name:'B',f_client:'Sarah',f_value:12,f_date:'',cf_contact:'',history:[]}],todoCards:[{id:'todo_qa',recordId:1,status:'To Do',nextAction:'Call',notes:'Independent',dueDate:''}]});
  const original=structuredClone(s),quota=await db.query('select * from pipechat.usage_counters');
  await run('migrations/011-primary-column-order.sql');await run('tests/security.sql');assert.deepEqual(await read(a),s);
  for(const id of ['f_client','f_value','f_date','cf_contact']){
    const first=Schema.orderedFields([...s.tableSchema.fields,...s.customFields],s.tableSchema.columnOrder)[0].id;
    s=await write(a,{...s,tableSchema:Schema.reorder(s.tableSchema,s.customFields,id,first)});
    assert.deepEqual(await read(a),s);assert.equal(Core.create(s.tableSchema).role('primary'),id);assert.equal(Core.create(s.tableSchema).role('owner'),'f_client');assert.deepEqual(s.deals,original.deals);assert.deepEqual(s.todoCards,original.todoCards);
  }
  const change=Core.create(s.tableSchema).deleteColumn(s.deals,'f_name',s.customFields);
  s=await write(a,{...s,deals:change.records,customFields:change.customFields,tableSchema:change.tableSchema});assert.equal(Core.create(s.tableSchema).role('primary'),'cf_contact');assert.deepEqual(await read(a),s);
  const replacement=Core.create(s.tableSchema).deleteColumn(s.deals,'cf_contact',s.customFields,{field:'f_client'});
  s=await write(a,{...s,deals:replacement.records,customFields:replacement.customFields,tableSchema:replacement.tableSchema});assert.equal(s.tableSchema.columnOrder[0],'f_client');assert.equal(s.deals[1].f_client,'Sarah');
  await assert.rejects(()=>write(a,{...s,tableSchema:{...s.tableSchema,columnOrder:['cf_missing']}}),e=>e.code==='PT400');assert.deepEqual(await read(a),s);
  await assert.rejects(()=>write(a,original),e=>e.code==='PT409');s=await write(a,{...original,updatedAt:s.updatedAt});assert.deepEqual(s.deals,original.deals);assert.deepEqual(s.tableSchema,original.tableSchema);
  const deletion=Core.create(s.tableSchema).deletion(s.deals,{action:'delete_records',filter:{field:'f_client',operator:'is_blank',value:null}});
  s=await write(a,{...s,deals:s.deals.filter(r=>!deletion.records.some(d=>d.id===r.id)),todoCards:[]});assert.deepEqual(s.deals.map(r=>r.id),[2]);
  s=await write(a,{...original,updatedAt:s.updatedAt});assert.deepEqual(s.deals,original.deals);assert.deepEqual(s.todoCards,original.todoCards);assert.deepEqual(await read(b),other);assert.deepEqual((await db.query('select * from pipechat.usage_counters')).rows,quota.rows);
});
