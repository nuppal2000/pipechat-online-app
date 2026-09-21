const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const net=require('node:net');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('Xano proxy: isolation, cookies, CAS saves, reservations, quota, outages, no disk fallback', {timeout:30000}, async()=>{
  const listener=net.createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
  const temp=await fs.mkdtemp(path.join(__dirname,'test-data-'));
  const dataDir=path.join(temp,'must-not-exist');
  const child=spawn(process.execPath,['--require',path.join(__dirname,'mock-xano.cjs'),path.join(__dirname,'../server.js')],{
    env:{...process.env,PORT:String(port),PIPECHAT_STORAGE_PROVIDER:'xano',XANO_API_BASE_URL:'https://xano.example.test/api:pipechat',XANO_SERVER_KEY:'test-only-private-server-key-123456789',PIPECHAT_DATA_DIR:dataDir,OPENAI_API_KEY:'TEST_KEY_NEVER_SENT_TO_OPENAI',NODE_ENV:'production',PIPECHAT_PUBLIC_ORIGIN:'https://pipechat.test'},
    windowsHide:true,stdio:['ignore','pipe','pipe']
  });
  let output='';child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>output+=data);
  async function request(route,{method='GET',body,cookie='',headers={}}={}){
    const response=await fetch(`http://127.0.0.1:${port}${route}`,{method,headers:{'Content-Type':'application/json',Cookie:cookie,...headers},...(body?{body:JSON.stringify(body)}:{})});
    assert.match(response.headers.get('x-request-id'),/^[a-f0-9-]{36}$/);
    assert.equal(response.headers.get('access-control-allow-origin'),null);
    assert.equal(response.headers.get('cache-control'),'no-store');
    assert.equal(response.headers.get('strict-transport-security'),'max-age=31536000');
    assert.equal(response.headers.get('x-content-type-options'),'nosniff');
    assert.equal(response.headers.get('x-frame-options'),'DENY');
    return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie'),cache:response.headers.get('cache-control')};
  }
  const signup=async email=>request('/api/auth/signup',{method:'POST',body:{email,password:'test-password-123',name:'Test User'}});
  try{
    for(let i=0;i<80;i++){try{await request('/api/health');break;}catch{await delay(75);}}
    const health=await request('/api/health');assert.equal(health.body.storageProvider,'xano',output);assert.equal(health.cache,'no-store');
    assert.equal((await request('/api/crm-data')).status,401);
    const a=await signup('a@example.test'),b=await signup('b@example.test');assert.equal(a.status,200);assert.equal(b.status,200);
    assert.match(a.cookie,/pipechat_xano_session=/);assert.match(a.cookie,/HttpOnly/);assert.match(a.cookie,/Secure/);assert.match(a.cookie,/SameSite=Lax/);assert.match(a.cookie,/Max-Age=86400/);
    assert.equal(a.body.authToken,undefined);assert.equal(a.body.user.password,undefined);
    const cookieA=a.cookie.split(';')[0],cookieB=b.cookie.split(';')[0];
    assert.equal((await request('/api/crm-data',{cookie:cookieA})).body.seedDemoData,false);
    const row={id:1,account:'Only A',owner:'Jordan',stage:'Warm',value:300,close:'2026-11-30',next:'Review',follow:'Today',notes:'Private',history:[]};
    const first=await request('/api/crm-data',{method:'PUT',cookie:cookieA,body:{deals:[row],expectedUpdatedAt:null,user_id:b.body.user.id}});assert.equal(first.status,200);
    assert.deepEqual((await request('/api/crm-data',{cookie:cookieB})).body.deals,[]);
    const wrongOrigin=await request('/api/crm-data',{method:'PUT',cookie:cookieA,body:{deals:[],expectedUpdatedAt:first.body.updatedAt},headers:{Origin:'https://attacker.test'}});assert.equal(wrongOrigin.status,403);
    assert.equal((await request('/api/crm-data',{method:'PUT',cookie:cookieA,body:{deals:[]}})).status,400);
    const writes=await Promise.all(['Alpha','Beta'].map(owner=>request('/api/crm-data',{method:'PUT',cookie:cookieA,body:{deals:[{...row,owner}],expectedUpdatedAt:first.body.updatedAt}})));
    assert.deepEqual(writes.map(r=>r.status).sort(),[200,409]);
    const failed=await request('/api/pipechat-ai',{method:'POST',cookie:cookieB,body:{userCommand:'fail model'}});assert.equal(failed.status,502);
    const afterFailure=await request('/api/chat-usage',{cookie:cookieB});assert.equal(afterFailure.body.used,0);assert.equal(afterFailure.body.reserved,0);
    const chats=await Promise.all([1,2].map(()=>request('/api/pipechat-ai',{method:'POST',cookie:cookieA,body:{userCommand:'Hello'}})));
    assert.deepEqual(chats.map(r=>r.status).sort(),[200,402]);
    const meter=await request('/api/chat-usage',{cookie:cookieA});assert.equal(meter.body.used,1);assert.equal(meter.body.reserved,0);assert.equal(meter.body.remaining,0);
    const current=await request('/api/crm-data',{cookie:cookieA});
    const empty=await request('/api/crm-data',{method:'PUT',cookie:cookieA,body:{deals:[],expectedUpdatedAt:current.body.updatedAt}});assert.equal(empty.status,200);
    assert.deepEqual((await request('/api/crm-data',{cookie:cookieA})).body.deals,[]);
    const outage=await signup('outage@example.test');const failedRead=await request('/api/crm-data',{cookie:outage.cookie.split(';')[0]});assert.equal(failedRead.status,503);assert.equal(failedRead.body.deals,undefined);assert(!failedRead.body.error.includes('secret backend'));
    const logout=await request('/api/auth/logout',{method:'POST',cookie:cookieA,body:{}});assert.match(logout.cookie,/Max-Age=0/);
    assert.equal((await request('/api/crm-data',{cookie:cookieA})).status,401);
    const login=await request('/api/auth/login',{method:'POST',body:{email:'a@example.test',password:'test-password-123'}});assert.equal(login.status,200);
    assert.deepEqual((await request('/api/crm-data',{cookie:login.cookie.split(';')[0]})).body.deals,[]);
    await assert.rejects(fs.stat(dataDir),{code:'ENOENT'});
    assert(!output.includes('test-only-private-server-key'));assert(!output.includes('test-password-123'));
    assert(!output.includes('test-xano-'));assert(!output.includes('secret backend'));assert(!output.includes('a@example.test'));
    const events=output.split(/\r?\n/).filter(line=>line.startsWith('{')).map(line=>JSON.parse(line));
    for(const status of [200,401,402,403,409,502,503])assert(events.some(event=>event.status===status),`Missing sanitized status ${status}`);
  }finally{
    const exited=once(child,'exit');child.kill();await exited;
    if(path.dirname(temp)===__dirname&&path.basename(temp).startsWith('test-data-'))await fs.rm(temp,{recursive:true,force:true});
  }
});
