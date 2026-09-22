const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {spawn}=require('node:child_process'),{once}=require('node:events');
test('new-user setup, AI metering, empty confirmation, persistence, isolation, schema removal and CAS',{timeout:30000},async()=>{
  const dataDir=await fs.mkdtemp(path.join(__dirname,'test-table-'));
  const child=spawn(process.execPath,['--require',path.join(__dirname,'fixtures/table-model.cjs'),path.join(__dirname,'../server.js')],{windowsHide:true,env:{...process.env,PORT:'0',PIPECHAT_AI_PORT:'0',PIPECHAT_HOST:'127.0.0.1',PIPECHAT_STORAGE_PROVIDER:'json',PIPECHAT_DATA_DIR:dataDir,PIPECHAT_FREE_CHAT_LIMIT:'1',OPENAI_API_KEY:'TEST_ONLY',PIPECHAT_PUBLIC_ORIGIN:'http://127.0.0.1',NODE_ENV:'test',PIPECHAT_COOKIE_SECURE:'false'},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',chunk=>output+=chunk);let root;
  try{
    for(let i=0;i<100;i++){const found=output.match(/QA_LISTEN_PORT=(\d+)/);if(found){root='http://127.0.0.1:'+found[1];break;}await new Promise(r=>setTimeout(r,50));}
    assert(root,'test server listening');
    async function req(route,method='GET',body,cookie=''){
      const response=await fetch(root+route,{method,headers:{'Content-Type':'application/json',Cookie:cookie},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
    }
    const a=await req('/api/auth/signup','POST',{email:'setup-a@example.invalid',name:'QA',password:'local-only-123'}),b=await req('/api/auth/signup','POST',{email:'setup-b@example.invalid',name:'QA',password:'local-only-123'});
    const initial=await req('/api/crm-data','GET',null,a.cookie);assert.deepEqual(initial.data.deals,[]);assert.deepEqual(initial.data.tableSchema,{status:'pending'});assert.equal(initial.data.seedDemoData,false);
    assert.equal((await req('/api/pipechat-ai','POST',{tableBuild:{useCase:'Other',description:''}},a.cookie)).status,400);
    assert.equal((await req('/api/chat-usage','GET',null,a.cookie)).data.used,0);
    const build=await req('/api/pipechat-ai','POST',{tableBuild:{useCase:'Recruiting',description:''}},a.cookie);assert.equal(build.status,200);assert.equal(build.data.usage.used,1);
    const schema=build.data.tableSchema;assert.equal(schema.status,'ready');assert(!Object.hasOwn(build.data,'deals'));
    assert.equal((await req('/api/crm-data','GET',null,a.cookie)).data.tableSchema.status,'pending');
    const confirm=await req('/api/crm-data','PUT',{deals:[],customFields:[],tableSchema:schema,expectedUpdatedAt:null},a.cookie);assert.equal(confirm.status,200);assert.deepEqual(confirm.data.deals,[]);
    const [name,amount]=schema.fields,record={id:1,[name.id]:'Synthetic candidate',[amount.id]:125,history:[]};
    const added=await req('/api/crm-data','PUT',{deals:[record],customFields:[],tableSchema:schema,expectedUpdatedAt:confirm.data.updatedAt},a.cookie);assert.equal(added.status,200);
    assert.equal((await req('/api/crm-data','PUT',{deals:[],customFields:[],tableSchema:schema,expectedUpdatedAt:confirm.data.updatedAt},a.cookie)).status,409);
    assert.equal((await req('/api/crm-data','GET',null,b.cookie)).data.tableSchema.status,'pending');
    const removed={...schema,fields:[name]},row={id:1,[name.id]:'Synthetic candidate',history:[]};
    const deletion=await req('/api/crm-data','PUT',{deals:[row],customFields:[],tableSchema:removed,expectedUpdatedAt:added.data.updatedAt},a.cookie);assert.equal(deletion.status,200);
    const undo=await req('/api/crm-data','PUT',{deals:added.data.deals,customFields:[],tableSchema:schema,expectedUpdatedAt:deletion.data.updatedAt},a.cookie);assert.equal(undo.status,200);assert.equal(undo.data.deals[0][amount.id],125);
    assert.equal((await req('/api/chat-usage','GET',null,a.cookie)).data.used,1);
    await req('/api/auth/logout','POST',{},a.cookie);const login=await req('/api/auth/login','POST',{email:'setup-a@example.invalid',password:'local-only-123'});
    const loaded=await req('/api/crm-data','GET',null,login.cookie);assert.deepEqual(loaded.data.tableSchema,schema);assert.equal(loaded.data.deals[0][amount.id],125);
    assert.equal((await req('/api/crm-data','PUT',{deals:[],expectedUpdatedAt:loaded.data.updatedAt},login.cookie)).status,409);
    assert.equal((await req('/api/pipechat-ai','POST',{tableBuild:{useCase:'Sales',description:''}},login.cookie)).status,409);
    const invalid=await req('/api/pipechat-ai','POST',{tableBuild:{useCase:'Other',description:'invalid-schema-test'}},b.cookie);assert.equal(invalid.status,500);
    assert.equal((await req('/api/chat-usage','GET',null,b.cookie)).data.used,0);
  }finally{child.kill();await once(child,'exit').catch(()=>{});if(path.dirname(dataDir)===__dirname&&path.basename(dataDir).startsWith('test-table-'))await fs.rm(dataDir,{recursive:true,force:true});}
});
