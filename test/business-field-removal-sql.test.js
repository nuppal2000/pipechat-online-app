'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {randomUUID}=require('node:crypto'),{PGlite}=require('@electric-sql/pglite');
const B=require('../public/business-workspace');
const field=(id,name,type='text',required=false)=>({id,name,type,required,options:[]});

test('migration 022: isolated unused entity-field removal, dependencies, CAS, roles and rollback', {timeout:120000}, async t=>{
  const db=new PGlite();t.after(()=>db.close());
  const run=async name=>db.exec(await fs.readFile(path.join(__dirname,'../db',name),'utf8'));
  await run('tests/mock-supabase.sql');await db.exec('alter table auth.users add column email text');
  const files=(await fs.readdir(path.join(__dirname,'../db/migrations'))).filter(name=>/^\d{3}-.*\.sql$/.test(name)).sort();
  for(const name of files.filter(name=>name<'014'))await run('migrations/'+name);
  // Deliberately omit unpublished 020 and the independent workflow migration.
  await run('migrations/022-business-field-removal.sql');
  async function user(){
    const u={id:randomUUID(),session_id:randomUUID(),email:randomUUID()+'@example.test'};
    await db.query('insert into auth.users(id,email) values($1,$2)',[u.id,u.email]);
    await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[u.session_id,u.id]);return u;
  }
  async function rpc(u,name,args=[]){
    await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:u.id,session_id:u.session_id,role:'authenticated'})]);
    await db.exec('set role authenticated');
    try{return (await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) result`,args)).rows[0].result;}
    finally{await db.exec('reset role');}
  }
  const get=(u,wid=null)=>rpc(u,'business_workspace_get',[wid]);
  const cas=(u,s,next)=>rpc(u,'business_workspace_cas',[s.workspaceId,s.version,next,s.primary.updatedAt]);
  const share=(u,s,target,scope,resource=null,role='viewer')=>rpc(u,'business_workspace_share',[s.workspaceId,target.email,scope,resource,role,s.version]);
  const rejected=(run,code='PT400')=>assert.rejects(run,error=>error.code===code);
  const remove=(state,fieldId='temporary')=>{
    const next=structuredClone(state);next.entityTypes[0].fields=next.entityTypes[0].fields.filter(f=>f.id!==fieldId);
    next.entities.filter(e=>e.typeId==='contacts').forEach(e=>delete e.values[fieldId]);return next;
  };
  async function seed(){
    const owner=await user(),legacy=await rpc(owner,'pipechat_read_workspace');
    const tableSchema={status:'ready',useCase:'Other',title:'Primary',recordLabel:'Record',description:'',fields:[{id:'f_name',name:'Name',type:'text',role:'primary',options:[]}]};
    const empty=await rpc(owner,'pipechat_write_workspace_v2',[[],[],tableSchema,legacy.updatedAt,[]]);
    await rpc(owner,'pipechat_write_workspace_v2',[[{id:1,f_name:'Keep primary',history:[],activity:'',health:''}],[],tableSchema,empty.updatedAt,[]]);
    let s=await get(owner);const state=B.empty(),one='ent_'+randomUUID(),two='ent_'+randomUUID(),other='ent_'+randomUUID(),view='view_'+randomUUID();
    state.entityTypes=[{id:'contacts',name:'Contact',fields:[field('identity','Name','text',true),field('mail','Email'),field('temporary','QAE Temporary'),field('score','Score','number'),field('active','Active','boolean')]},
      {id:'other',name:'Other',fields:[field('identity','Name','text',true),field('temporary','QAE Temporary')]}];
    state.entities=[{id:one,typeId:'contacts',values:{identity:'QAE Morgan Lane',mail:'morgan@example.com',temporary:null,score:0,active:false}},
      {id:two,typeId:'contacts',values:{identity:'Other Contact',temporary:' \t\u00a0\ufeff'}},
      {id:other,typeId:'other',values:{identity:'Unrelated',temporary:'Keep'}}];
    state.relationshipTypes=[{id:'works_at',name:'QAE Temporary',fromType:'contacts',toType:'primary',cardinality:'many_to_many'}];
    state.relationships=[{id:'lnk_'+randomUUID(),typeId:'works_at',fromId:one,toId:B.legacyId(s.workspaceId,1)}];
    state.views=[{id:view,name:'QAE Temporary',entityIds:[one,two]}];
    s=await cas(owner,s,state);return {owner,s,one,two,other,view};
  }
  async function access(wid){
    const result={};for(const table of ['business_grants','business_memberships'])result[table]=(await db.query(`select * from pipechat.${table} where workspace_id=$1 order by user_id`,[wid])).rows;
    return result;
  }

  await t.test('unused field commits while preserving unrelated types, similarly named views, links, grants and primary records',async()=>{
    const f=await seed(),reader=await user();await share(f.owner,f.s,reader,'view',f.view);const s=await get(f.owner);
    const beforeAccess=await access(s.workspaceId),beforeAudit=(await db.query('select * from pipechat.business_audit where workspace_id=$1 order by id',[s.workspaceId])).rows;
    const next=B.prepare(s,[{op:'remove_field',typeId:'contacts',fieldId:'temporary'}]).next;
    const saved=await cas(f.owner,s,next);assert.deepEqual(saved.state,next);assert.equal(saved.version,s.version+1);
    assert.deepEqual(saved.primary,s.primary);assert.deepEqual(saved.state.entities.map(e=>e.id),s.state.entities.map(e=>e.id));
    assert.deepEqual(saved.state.views,s.state.views);assert.deepEqual(saved.state.relationships,s.state.relationships);
    assert.deepEqual(saved.state.entityTypes[1],s.state.entityTypes[1]);assert.deepEqual(saved.state.entities[2],s.state.entities[2]);
    assert.deepEqual(await access(s.workspaceId),beforeAccess);
    const audit=(await db.query('select * from pipechat.business_audit where workspace_id=$1 order by id',[s.workspaceId])).rows;
    assert.deepEqual(audit.slice(0,beforeAudit.length),beforeAudit);assert.equal(audit.length,beforeAudit.length+2);
    assert.equal((await get(reader,s.workspaceId)).state.entities.length,2);
    await rejected(()=>cas(f.owner,s,next),'PT409');assert.deepEqual(await get(f.owner),saved);
  });

  await t.test('populated, zero, false and identity dependencies reject raw CAS attempts without loss',async()=>{
    const f=await seed();
    for(const fieldId of ['mail','score','active','identity']){
      await rejected(()=>cas(f.owner,f.s,remove(f.s.state,fieldId)));assert.deepEqual(await get(f.owner),f.s);
    }
    const populated=structuredClone(f.s.state);populated.entities[1].values.temporary='Must retain';
    const s=await cas(f.owner,f.s,populated);await rejected(()=>cas(f.owner,s,remove(s.state)));assert.deepEqual(await get(f.owner),s);
  });

  await t.test('a concurrent value addition fences an already prepared field removal',async()=>{
    const f=await seed(),next=remove(f.s.state),populated=structuredClone(f.s.state);populated.entities[1].values.temporary='Arrived after preview';
    const current=await cas(f.owner,f.s,populated);
    await rejected(()=>cas(f.owner,f.s,next),'PT409');assert.deepEqual(await get(f.owner),current);
    await rejected(()=>cas(f.owner,current,remove(current.state)));assert.deepEqual(await get(f.owner),current);
  });

  await t.test('deletion cannot bundle unrelated changes or primary replacement',async()=>{
    const f=await seed(),next=remove(f.s.state);
    for(const change of [s=>{s.entities[0].values.mail='Changed';},s=>{s.entities.pop();},s=>{s.views=[];},s=>{s.relationships=[];},s=>{s.entityTypes[1].name='Changed';},s=>{s.primary={typeId:'contacts',source:'crm_records'};}]){
      const bad=structuredClone(next);change(bad);await rejected(()=>cas(f.owner,f.s,bad));assert.deepEqual(await get(f.owner),f.s);
    }
    for(const extra of [{conditions:[[{field:'QAE Temporary',operator:'equals',value:'x'}]]},{rules:{all:[{conditions:[{field:'temporary',value:'x'}]}]}}]){
      const bad=structuredClone(next);Object.assign(bad.views[0],extra);await rejected(()=>cas(f.owner,f.s,bad));
    }
    assert.deepEqual(await get(f.owner),f.s);
  });

  await t.test('owner-only schema removal and tenant isolation remain enforced',async()=>{
    const f=await seed(),editor=await user(),viewer=await user(),foreign=await user();
    await share(f.owner,f.s,editor,'workspace',null,'editor');let s=await get(f.owner);
    await share(f.owner,s,viewer,'workspace');s=await get(f.owner);const next=remove(s.state);
    for(const actor of [editor,viewer,foreign])await rejected(()=>cas(actor,s,next),'PT403');
    assert.deepEqual(await get(f.owner),s);
  });

  await t.test('audit failure rolls back field removal, access and workspace version atomically',async()=>{
    const f=await seed(),next=remove(f.s.state),beforeAccess=await access(f.s.workspaceId);
    await db.exec(`create function public.fail_field_removal_audit() returns trigger language plpgsql set search_path=pg_catalog as $$
      begin raise sqlstate 'PT400' using message='Injected field-removal failure'; end $$;
      create trigger fail_field_removal_audit after insert on pipechat.business_audit for each row execute function public.fail_field_removal_audit();`);
    try{await rejected(()=>cas(f.owner,f.s,next));assert.deepEqual(await get(f.owner),f.s);assert.deepEqual(await access(f.s.workspaceId),beforeAccess);}
    finally{await db.exec('drop trigger fail_field_removal_audit on pipechat.business_audit; drop function public.fail_field_removal_audit();');}
    assert.deepEqual((await cas(f.owner,f.s,next)).state,next);
  });

  await t.test('internal helper ACLs stay closed and schema reload is transactionally declared',async()=>{
    for(const role of ['anon','authenticated','service_role'])for(const signature of ['pipechat.business_assert_field_removal(jsonb,jsonb)','pipechat.business_validate(uuid,jsonb,jsonb)']){
      assert.equal((await db.query("select has_function_privilege($1,$2,'EXECUTE') ok",[role,signature])).rows[0].ok,false);
    }
    const sql=await fs.readFile(path.join(__dirname,'../db/migrations/022-business-field-removal.sql'),'utf8');
    assert.match(sql,/\nbegin;\s/);assert.match(sql,/notify pgrst, 'reload schema';\s+commit;\s*$/i);
    assert.doesNotMatch(sql,/020-|business_automations/);
  });
});
