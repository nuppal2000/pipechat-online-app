const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process'),{once}=require('node:events'),net=require('node:net');
test('archive API persists across sessions, bounds real model input, rolls memory without extra calls, and resets privately',{timeout:20000},async()=>{
  const listener=net.createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
  const directory=await fs.mkdtemp(path.join(__dirname,'conversation-data-')),capture=path.join(directory,'model-input.jsonl');
  const child=spawn(process.execPath,['--require',path.join(__dirname,'fixtures/conversation-model.cjs'),path.join(__dirname,'../server.js')],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,PORT:String(port),PIPECHAT_STORAGE_PROVIDER:'json',PIPECHAT_DATA_DIR:directory,PIPECHAT_FREE_CHAT_LIMIT:'2',OPENAI_API_KEY:'OFFLINE_TEST_ONLY',CONVERSATION_CAPTURE:capture}});
  let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
  async function call(route,method='GET',body,cookie=''){
    const response=await fetch(`http://127.0.0.1:${port}`+route,{method,headers:{'Content-Type':'application/json',Cookie:cookie},...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
  }
  try{
    for(let i=0;i<80;i++){try{await call('/api/health');break;}catch{await new Promise(resolve=>setTimeout(resolve,50));}}
    assert.equal((await call('/api/conversation')).status,401,output);
    const a=await call('/api/auth/signup','POST',{name:'Archive A',email:'archive-a@example.invalid',password:'offline-only-123'});
    const b=await call('/api/auth/signup','POST',{name:'Archive B',email:'archive-b@example.invalid',password:'offline-only-456'});
    let page=(await call('/api/conversation','GET',null,a.cookie)).body;
    const first={epoch:page.epoch,version:page.version};
    for(let batch=0;batch<4;batch++){
      const messages=Array.from({length:20},(_,i)=>({id:crypto.randomUUID(),role:i%2?'assistant':'user',content:`Earlier sales follow-ups ${batch*20+i}. `+'Long original text. '.repeat(100)}));
      const saved=await call('/api/conversation','PUT',{epoch:page.epoch,version:page.version,messages,state:null},a.cookie);
      assert.equal(saved.status,200,JSON.stringify(saved.body));page={...page,...saved.body};
    }
    const latest=(await call('/api/conversation','GET',null,a.cookie)).body;
    assert.equal(latest.messages.length,50);assert.equal(latest.before,31);assert.equal(latest.messages.at(-1).seq,80);
    assert.equal((await call('/api/conversation?before=31','GET',null,a.cookie)).body.messages.length,30);
    assert.equal((await call('/api/conversation','GET',null,b.cookie)).body.messages.length,0);
    assert.equal((await call('/api/conversation','PUT',{...first,messages:[],state:null},a.cookie)).status,409);
    assert.equal((await call('/api/pipechat-ai','POST',{userCommand:'Old tab',conversation:first},a.cookie)).status,409);
    for(let i=0;i<2;i++){
      const reply=await call('/api/pipechat-ai','POST',{userCommand:'Remember earlier sales follow-ups?',conversation:{epoch:latest.epoch,version:latest.version},conversationHistory:[{role:'user',content:'CLIENT_HISTORY_MUST_NOT_BE_SENT'}]},a.cookie);
      assert.equal(reply.status,200,JSON.stringify(reply.body));assert.equal(reply.body.usage.used,i+1);assert.equal(reply.body.memoryNote,null);
    }
    const inputs=(await fs.readFile(capture,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(inputs.length,2);
    for(const input of inputs){const {conversationHistory,conversationMemory,recalledMessages,memoryUpdate}=input;assert(conversationHistory.length<=12);assert(Buffer.byteLength(JSON.stringify({conversationHistory,conversationMemory,recalledMessages,memoryUpdate}))<=12000);assert(!JSON.stringify(input).includes('CLIENT_HISTORY_MUST_NOT_BE_SENT'));assert(memoryUpdate);}
    assert.match(inputs[1].conversationMemory,/Prefers concise replies/);
    const remembered=(await call('/api/conversation','GET',null,a.cookie)).body;assert(remembered.summaryThrough>0);assert.equal(remembered.messages.at(-1).content,latest.messages.at(-1).content);
    const manual=await call('/api/conversation','PUT',{epoch:remembered.epoch,version:remembered.version,messages:[{id:crypto.randomUUID(),role:'assistant',content:'Manual change saved.'}],state:null},a.cookie);assert.equal(manual.status,200);
    await call('/api/auth/logout','POST',{},a.cookie);assert.equal((await call('/api/conversation','GET',null,a.cookie)).status,401);
    const relogin=await call('/api/auth/login','POST',{email:'archive-a@example.invalid',password:'offline-only-123'});
    assert.equal((await call('/api/conversation','GET',null,relogin.cookie)).body.messages.at(-1).content,'Manual change saved.');
    const reset=await call('/api/crm-reset','POST',{confirm:true,expectedUpdatedAt:null},relogin.cookie);assert.equal(reset.status,200);
    const empty=(await call('/api/conversation','GET',null,relogin.cookie)).body;assert.equal(empty.messages.length,0);assert.equal(empty.summary,'');assert.notEqual(empty.epoch,latest.epoch);
    assert.equal((await call('/api/conversation','PUT',{...manual.body,messages:[],state:null},relogin.cookie)).status,409);
    assert.equal((await call('/api/chat-usage','GET',null,relogin.cookie)).body.used,2);
  }finally{
    child.kill();await once(child,'exit').catch(()=>{});
    if(path.dirname(directory)===__dirname&&path.basename(directory).startsWith('conversation-data-'))await fs.rm(directory,{recursive:true,force:true});
  }
});
