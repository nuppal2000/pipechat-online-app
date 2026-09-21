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
    const chat={userCommand:'yes',pendingAction:{action:'update_records'},pendingClarification:{originalCommand:'Change Acme'},currentReport:{groupBy:'owner'},pipeline:{records:[deal]}};
    const responses=await Promise.all([request('/api/pipechat-ai','POST',chat,a.cookie),request('/api/pipechat-ai','POST',chat,a.cookie)]);
    assert.deepEqual(responses.map(r=>r.status).sort(),[200,402],output);
    assert.equal((await request('/api/chat-usage','GET',null,a.cookie)).body.remaining,0);
    assert.equal((await request('/api/chat-usage','GET',null,b.cookie)).body.remaining,1);
    const edit=await request('/api/crm-data','PUT',{deals:[{...deal,owner:'Manual edit after chat limit'}],expectedUpdatedAt:saved.body.updatedAt},a.cookie);
    assert.equal(edit.status,200);assert.equal(edit.body.deals[0].owner,'Manual edit after chat limit');
    const empty=await request('/api/crm-data','PUT',{deals:[],expectedUpdatedAt:edit.body.updatedAt},a.cookie);
    assert.equal(empty.status,200);assert.deepEqual((await request('/api/crm-data','GET',null,a.cookie)).body.deals,[]);
    await request('/api/auth/logout','POST',{},a.cookie);
    assert.equal((await request('/api/crm-data','GET',null,a.cookie)).status,401);
    const login=await request('/api/auth/login','POST',{email:'a@example.test',password:'testing-only-123'});
    assert.deepEqual((await request('/api/crm-data','GET',null,login.cookie)).body.deals,[]);
    const css=await fetch(root+'/pipechat.css');assert.match(css.headers.get('content-type'),/text\/css/);
  } finally {
    child.kill();await once(child,'exit').catch(()=>{});
    // This exact temporary directory was created by this test under its own test folder.
    if(path.dirname(dataDir)===__dirname&&path.basename(dataDir).startsWith('test-data-'))await fs.rm(dataDir,{recursive:true,force:true});
  }
});
