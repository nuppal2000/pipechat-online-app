const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const net = require('node:net');
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
test('server isolation, validation, persistence, schema/context, and usage lock', {timeout:30000}, async () => {
  const listener=net.createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
  const dataDir=await fs.mkdtemp(path.join(__dirname,'test-data-'));
  const child=spawn(process.execPath,['--require',path.join(__dirname,'mock-openai.cjs'),path.join(__dirname,'../server.js')],{env:{...process.env,PORT:String(port),PIPECHAT_STORAGE_PROVIDER:'json',PIPECHAT_DATA_DIR:dataDir,PIPECHAT_FREE_CHAT_LIMIT:'1',OPENAI_API_KEY:'TEST_ONLY_NOT_REAL'},stdio:['ignore','pipe','pipe'],windowsHide:true});
  let output='';child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>output+=data);
  const root=`http://127.0.0.1:${port}`;
  async function request(route,method='GET',body=null,cookie='') {
    const response=await fetch(root+route,{method,headers:{'Content-Type':'application/json',Cookie:cookie},...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
  }
  try {
    for(let i=0;i<80;i++){try{await request('/api/health');break;}catch{await delay(75);}}
    assert.equal((await request('/api/health')).body.prototypeVersion,'product-v2');
    assert.equal((await request('/api/crm-data')).status,401);
    const a=await request('/api/auth/signup','POST',{name:'Test A',email:'a@example.test',password:'testing-only-123'});
    const b=await request('/api/auth/signup','POST',{name:'Test B',email:'b@example.test',password:'testing-only-123'});
    assert.equal(a.status,200);assert.equal(b.status,200);
    const deal={id:1,account:'Private account A',stage:'Proposal',value:100,close:'Nov 30, 2026',owner:'A',notes:'Secret A',next:'',follow:''};
    const saved=await request('/api/crm-data','PUT',{deals:[deal],expectedUpdatedAt:null},a.cookie);
    assert.equal(saved.status,200);assert.equal(saved.body.deals[0].stage,'Proposal Sent');assert.equal(saved.body.deals[0].close,'2026-11-30');assert.equal(saved.body.deals[0].follow,'');
    assert.equal((await request('/api/crm-data','GET',null,b.cookie)).body.deals.length,0);
    assert.equal((await request('/api/crm-data','PUT',{deals:[{...deal,value:-1}]},a.cookie)).status,400);
    assert.equal((await request('/api/crm-data','PUT',{deals:[deal,deal]},a.cookie)).status,400);
    assert.equal((await request('/api/crm-data','PUT',{deals:[{id:2}]},a.cookie)).status,400);
    assert.equal((await request('/api/crm-data','PUT',{deals:[],expectedUpdatedAt:null},a.cookie)).status,409);
    const chat={userCommand:'yes',pendingAction:{action:'update_records'},pendingClarification:{originalCommand:'Change Acme'},currentReport:{groupBy:'owner',owners:['Ravi','Sarah'],accounts:['Alpha','Beta']},pipeline:{records:[deal]}};
    const responses=await Promise.all([request('/api/pipechat-ai','POST',chat,a.cookie),request('/api/pipechat-ai','POST',chat,a.cookie)]);
    assert.deepEqual(responses.map(r=>r.status).sort(),[200,402],output);
    assert.equal((await request('/api/chat-usage','GET',null,a.cookie)).body.remaining,0);
    assert.equal((await request('/api/chat-usage','GET',null,b.cookie)).body.remaining,1);
    const edit=await request('/api/crm-data','PUT',{deals:[{...deal,owner:'Manual edit after chat limit'}],expectedUpdatedAt:saved.body.updatedAt},a.cookie);
    assert.equal(edit.status,200);assert.equal(edit.body.deals[0].owner,'Manual edit after chat limit');
    const partial={...deal,id:2,account:'',stage:'',value:null,close:'',owner:'Known owner'};
    const imported=await request('/api/crm-data','PUT',{deals:[...edit.body.deals,partial],expectedUpdatedAt:edit.body.updatedAt},a.cookie);
    assert.equal(imported.status,200);const readBack=await request('/api/crm-data','GET',null,a.cookie);
    assert.equal(readBack.body.deals[1].account,'');assert.equal(readBack.body.deals[1].stage,'');assert.equal(readBack.body.deals[1].value,null);
    assert.equal((await request('/api/pipechat-ai','POST',{csvImport:{headers:['Business'],totalRows:0}},b.cookie)).status,400);
    assert.equal((await request('/api/chat-usage','GET',null,b.cookie)).body.used,0);
    const mapped=await request('/api/pipechat-ai','POST',{csvImport:require('../public/csv-import.js').describe(['Business'],[{Business:'Acme'}])},b.cookie);
    assert.equal(mapped.status,200);assert.equal(mapped.body.crmAction.columnMap.account,'Business');assert.equal(mapped.body.usage.used,1);
    assert.equal((await request('/api/crm-data','GET',null,b.cookie)).body.deals.length,0);
    const empty=await request('/api/crm-data','PUT',{deals:[],expectedUpdatedAt:imported.body.updatedAt},a.cookie);
    assert.equal(empty.status,200);assert.deepEqual((await request('/api/crm-data','GET',null,a.cookie)).body.deals,[]);
    await request('/api/auth/logout','POST',{},a.cookie);
    assert.equal((await request('/api/crm-data','GET',null,a.cookie)).status,401);
    const login=await request('/api/auth/login','POST',{email:'a@example.test',password:'testing-only-123'});
    assert.deepEqual((await request('/api/crm-data','GET',null,login.cookie)).body.deals,[]);
    const fields=[{id:'cf_contact',name:'Contact',type:'text'}];
    const fieldOnly=await request('/api/crm-data','PUT',{deals:[],customFields:fields,expectedUpdatedAt:empty.body.updatedAt},login.cookie);
    assert.equal(fieldOnly.status,200);assert.deepEqual(fieldOnly.body.customFields,fields);
    const custom=await request('/api/crm-data','PUT',{deals:[{...deal,cf_contact:'Taylor'}],customFields:fields,expectedUpdatedAt:fieldOnly.body.updatedAt},login.cookie);
    assert.equal(custom.status,200);assert.equal(custom.body.deals[0].cf_contact,'Taylor');
    assert.equal((await request('/api/crm-data','PUT',{deals:[deal],expectedUpdatedAt:custom.body.updatedAt},login.cookie)).status,409);
    assert.equal((await request('/api/crm-data','PUT',{deals:[deal],customFields:fields,expectedUpdatedAt:fieldOnly.body.updatedAt},login.cookie)).status,409);
    assert.equal((await request('/api/crm-data','PUT',{deals:[{...deal,cf_contact:{bad:true}}],customFields:fields,expectedUpdatedAt:custom.body.updatedAt},login.cookie)).status,400);
    assert.deepEqual((await request('/api/crm-data','GET',null,b.cookie)).body.customFields,[]);
    await request('/api/auth/logout','POST',{},login.cookie);
    const relogin=await request('/api/auth/login','POST',{email:'a@example.test',password:'testing-only-123'});
    const retained=await request('/api/crm-data','GET',null,relogin.cookie);
    assert.deepEqual(retained.body.customFields,fields);assert.equal(retained.body.deals[0].cf_contact,'Taylor');
    const c=await request('/api/auth/signup','POST',{name:'Test C',email:'c@example.test',password:'testing-only-123'});
    const d=await request('/api/auth/signup','POST',{name:'Test D',email:'d@example.test',password:'testing-only-123'});
    const customChat=await request('/api/pipechat-ai','POST',{userCommand:'Custom schema test',pipeline:{customFields:fields}},c.cookie);
    assert.equal(customChat.status,200,JSON.stringify(customChat.body));assert.equal(customChat.body.crmAction.action,'add_field');
    assert.equal((await request('/api/pipechat-ai','POST',{userCommand:'Clean schema test',pipeline:{customFields:[]}},d.cookie)).status,200);
    const css=await fetch(root+'/pipechat.css');assert.match(css.headers.get('content-type'),/text\/css/);
  } finally {
    child.kill();await once(child,'exit').catch(()=>{});
    // This exact temporary directory was created by this test under its own test folder.
    if(path.dirname(dataDir)===__dirname&&path.basename(dataDir).startsWith('test-data-'))await fs.rm(dataDir,{recursive:true,force:true});
  }
});
