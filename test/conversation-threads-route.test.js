'use strict';
// The same file is an offline provider preload for the disposable child server.
if (process.env.PIPECHAT_TURN_FIXTURE === '1') {
  const fs = require('node:fs/promises');
  global.fetch = async (url,options) => {
    if (url !== 'https://api.openai.com/v1/responses') throw new Error('Offline fixture forbids external requests');
    const request = JSON.parse(options.body), input = JSON.parse(typeof request.input === 'string' ? request.input : request.input[0].content[0].text);
    await fs.appendFile(process.env.CONVERSATION_CAPTURE,JSON.stringify(input)+'\n');
    await new Promise(resolve=>setTimeout(resolve,450));
    if (input.userCommand.includes('fixture failure')) throw new Error('PRIVATE_PROVIDER_EXCEPTION');
    if (input.userCommand.includes('fixture canonical')) {
      const F = require('./fixtures/workspace-plans.cjs');
      const result = request.text.format.name === 'pipechat_action_review'
        ? {requirements:[{description:'Compute requested record statistics',stepIds:input.allowedStepIds,satisfied:true}],issues:[],clarificationQuestion:null}
        : {assistantMessage:'I will calculate those numbers. Count: 99999.',memoryNote:null,crmAction:F.plan([
          F.select('population'),
          {op:'read_records',id:'statistics',label:'Saved amounts',selection:'population',showTable:false,
            outputs:[{kind:'count',field:null},{kind:'sum',field:'f_value'},{kind:'average',field:'f_value'}]}
        ])};
      return {ok:true,json:async()=>({usage:{input_tokens:20,output_tokens:10},output_text:JSON.stringify(result)})};
    }
    return {ok:true,json:async()=>({usage:{input_tokens:20,output_tokens:10},output_text:JSON.stringify({assistantMessage:'Saved reply: '+input.userCommand,crmAction:null,memoryNote:null})})};
  };
} else {
  const test = require('node:test'), assert = require('node:assert/strict');
  const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
  const {spawn} = require('node:child_process'), {once} = require('node:events'), {randomUUID} = require('node:crypto');
  const net = require('node:net');
  async function fixture(t) {
    const listener=net.createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');
    const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
    const directory=await fs.mkdtemp(path.join(os.tmpdir(),'pipechat-turn-route-')),capture=path.join(directory,'model.jsonl');
    const child=spawn(process.execPath,['--require',__filename,path.join(__dirname,'../server.js')],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,
      PORT:String(port),HOST:'127.0.0.1',PIPECHAT_STORAGE_PROVIDER:'json',PIPECHAT_DATA_DIR:directory,PIPECHAT_FREE_CHAT_LIMIT:'40',
      OPENAI_API_KEY:'OFFLINE_TEST_ONLY',PIPECHAT_TURN_FIXTURE:'1',CONVERSATION_CAPTURE:capture}});
    let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
    t.after(async()=>{if(child.exitCode===null){child.kill();await once(child,'exit');}assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));assert(path.basename(directory).startsWith('pipechat-turn-route-'));await fs.rm(directory,{recursive:true,force:true});});
    const base=`http://127.0.0.1:${port}`;
    async function call(route,method='GET',body,cookie='',signal) {
      const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json',Cookie:cookie},...(body?{body:JSON.stringify(body)}:{}),signal});
      return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
    }
    for(let i=0;i<100;i++){try{if((await call('/api/health')).status===200)break;}catch{}await new Promise(resolve=>setTimeout(resolve,30));}
    assert.equal((await call('/api/health')).status,200,output);
    const signup=await call('/api/auth/signup','POST',{name:'Offline user',email:randomUUID()+'@example.invalid',password:'offline-test-password'});
    assert.equal(signup.status,200,JSON.stringify(signup.body));
    const cookie=signup.cookie, user=signup.body.user;
    const api=(route,method,body,signal)=>call(route,method,body,cookie,signal);
    async function prepare(command,state={focus:{ids:[]}}) {
      const page=(await api('/api/conversation')).body, userMessageId=randomUUID();
      const saved=await api('/api/conversation','PUT',{epoch:page.epoch,version:page.version,messages:[{id:userMessageId,role:'user',content:command}],state});
      assert.equal(saved.status,200,JSON.stringify(saved.body));
      const catalog=(await api('/api/conversations')).body;
      return {userCommand:command,conversation:saved.body,turn:{threadId:catalog.activeThreadId,requestId:randomUUID(),userMessageId,assistantMessageId:randomUUID()}};
    }
    const calls=async()=>{try{return (await fs.readFile(capture,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(error){if(error.code==='ENOENT')return [];throw error;}};
    async function until(fn){for(let i=0;i<120;i++){const result=await fn();if(result)return result;await new Promise(resolve=>setTimeout(resolve,30));}throw new Error('Timed out: '+output);}
    const lookup=r=>api(`/api/conversations/${r.turn.threadId}/turns/${r.turn.requestId}`);
    return {base,directory,user,cookie,api,call,prepare,calls,until,lookup};
  }

  test('real AI route durably claims, finishes, replays, isolates threads and survives a disconnected client',{timeout:30000},async t=>{
    const f=await fixture(t), r=await f.prepare('First scoped question');
    const replies=await Promise.all(Array.from({length:4},()=>f.api('/api/pipechat-ai','POST',r)));
    assert.equal(replies.filter(reply=>reply.body.turn?.status==='succeeded').length,1);
    assert(replies.every(reply=>[200,202].includes(reply.status)),JSON.stringify(replies));
    assert.equal((await f.calls()).length,1);
    const receipt=(await f.lookup(r)).body;
    assert.equal(receipt.turn.assistantMessageId,r.turn.assistantMessageId);
    assert.equal(receipt.turn.status,'succeeded');assert.equal(receipt.usage.used,1);
    const retry=await f.api('/api/pipechat-ai','POST',r);assert.deepEqual(retry.body,receipt);assert.equal((await f.calls()).length,1);
    const page=(await f.api('/api/conversation')).body;
    assert.equal(page.messages.filter(message=>message.id===r.turn.assistantMessageId).length,1);
    assert.deepEqual(page.state,{focus:{ids:[]}});
    const bad=await f.prepare('Stored text only');
    const rejected=await f.api('/api/pipechat-ai','POST',{...bad,userCommand:'Forged replacement text'});
    assert.equal(rejected.body.turn.status,'failed');assert.equal(rejected.body.turn.publicErrorCode,'conflict');assert.equal((await f.calls()).length,1);

    const failed=await f.prepare('fixture failure after disconnect'), controller=new AbortController();
    const disconnected=f.api('/api/pipechat-ai','POST',failed,controller.signal).catch(error=>error);
    await f.until(async()=> (await f.calls()).length===2);
    const active=(await f.api('/api/conversation')).body;
    const other=await f.api('/api/conversations','POST',{epoch:active.epoch,version:active.version,title:'Independent chat'});
    assert.equal(other.status,200);controller.abort();await disconnected;
    await f.until(async()=>{const read=await f.lookup(failed);return read.body.turn?.status==='failed'&&read;});
    assert.deepEqual((await f.api('/api/conversation')).body.messages,[]);
    const result=(await f.lookup(failed)).body;assert(!JSON.stringify(result).includes('PRIVATE_PROVIDER_EXCEPTION'));
    assert.equal(result.turn.assistantMessage.id,failed.turn.assistantMessageId);
    const foreign=await f.call(`/api/conversations/${failed.turn.threadId}/turns/${failed.turn.requestId}`);assert.equal(foreign.status,401);
    const second=await f.prepare('Second thread only');await f.api('/api/pipechat-ai','POST',second);
    const modelInput=(await f.calls()).at(-1);assert(!JSON.stringify(modelInput.conversationHistory).includes('First scoped question'));
    const current=(await f.api('/api/conversation')).body;
    const restored=await f.api('/api/conversations/switch','POST',{epoch:current.epoch,version:current.version,threadId:r.turn.threadId});
    assert.equal(restored.body.conversation.messages.at(-1).id,failed.turn.assistantMessageId);
    assert.notEqual(restored.body.conversation.epoch,r.conversation.epoch);
    assert.equal((await f.api('/api/pipechat-ai','POST',failed)).body.turn.status,'failed');assert.equal((await f.calls()).length,3);

    const pending=await f.prepare('Interrupted before provider dispatch');
    const {createConversationStore}=require('../lib/conversation-store');
    const store=createConversationStore(f.directory,(_key,work)=>work(),{clock:()=>new Date('2020-01-01T00:00:00Z')})(f.user.id);
    await store.beginConversationTurn({...pending.turn,...pending.conversation,leaseSeconds:1});
    const recovered=await f.lookup(pending);assert.equal(recovered.body.turn.status,'interrupted');
    const replay=await f.api('/api/pipechat-ai','POST',pending);assert.equal(replay.body.turn.status,'interrupted');assert.equal((await f.calls()).length,3);
  });

  test('durable replies store canonical calculations instead of model draft claims', {timeout:30000}, async t=>{
    const f=await fixture(t), w=require('./fixtures/workspace-plans.cjs').workspace();
    const current=(await f.api('/api/crm-data')).body;
    const setup=await f.api('/api/crm-data','PUT',{deals:[],tableSchema:w.tableSchema,customFields:[],todoCards:[],expectedUpdatedAt:current.updatedAt});
    assert.equal(setup.status,200,JSON.stringify(setup.body));
    const saved=await f.api('/api/crm-data','PUT',{deals:w.records,tableSchema:w.tableSchema,customFields:[],todoCards:[],expectedUpdatedAt:setup.body.updatedAt});
    assert.equal(saved.status,200,JSON.stringify(saved.body));
    const beforeRead=(await f.api('/api/crm-data')).body;
    const r=await f.prepare('fixture canonical: give count, total and average of all records');
    const reply=await f.api('/api/pipechat-ai','POST',r);
    assert.equal(reply.body.turn?.status,'succeeded',JSON.stringify(reply.body));
    assert.match(reply.body.assistantMessage,/295,000\.00/);
    assert.match(reply.body.assistantMessage,/49,166\.67/);
    assert.doesNotMatch(reply.body.assistantMessage,/99999|I will calculate/);
    const page=(await f.api('/api/conversation')).body;
    assert.equal(page.messages.find(m=>m.id===r.turn.assistantMessageId).content,reply.body.assistantMessage);
    const calls=(await f.calls()).length;
    const replay=await f.api('/api/pipechat-ai','POST',r);
    assert.equal(replay.body.assistantMessage,reply.body.assistantMessage);
    assert.equal((await f.calls()).length,calls);
    assert.deepEqual((await f.api('/api/crm-data')).body,beforeRead);
  });

  let playwright;
  try{playwright=require('playwright');}catch{try{playwright=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));}catch{}}
  test('chat UI sends stable IDs after flush, switches history, reloads and recovers a lost HTTP response',{timeout:60000,skip:!playwright},async t=>{
    const f=await fixture(t), crm=(await f.api('/api/crm-data')).body;
    const saved=await f.api('/api/crm-data','PUT',{deals:[],customFields:[],todoCards:[],tableSchema:require('../public/table-schema').legacySchema(),expectedUpdatedAt:crm.updatedAt});
    assert.equal(saved.status,200,JSON.stringify(saved.body));
    const browser=await playwright.chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
    const context=await browser.newContext({viewport:{width:1280,height:900}}), page=await context.newPage(), errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await context.addCookies([{name:f.cookie.split('=')[0],value:f.cookie.slice(f.cookie.indexOf('=')+1),url:f.base}]);
    await page.goto(f.base);await page.locator('#chatInput:enabled').waitFor();
    const first=await page.locator('#chatThreadSelect').inputValue();
    await page.locator('#chatInput').fill('Browser first question');await page.locator('#sendBtn').click();
    await page.getByText('Saved reply: Browser first question',{exact:true}).waitFor();
    await page.locator('#chatInput:enabled').waitFor();
    assert.equal((await f.calls()).length,1);assert.equal(await page.locator('.chat-message.assistant').count(),1);
    await page.locator('#dealSearch').fill('First chat focus');
    await page.locator('#chatNewBtn').click();await page.waitForFunction(id=>document.querySelector('#chatThreadSelect').value!==id,first);
    await page.locator('#chatInput:enabled').waitFor();assert.equal(await page.locator('.chat-message').count(),0);
    assert.equal(await page.locator('#dealSearch').inputValue(),'');
    await page.locator('#chatInput').fill('Browser second question');await page.locator('#sendBtn').click();
    await page.getByText('Saved reply: Browser second question',{exact:true}).waitFor();await page.locator('#chatInput:enabled').waitFor();
    await page.locator('#chatThreadSelect').selectOption(first);await page.getByText('Saved reply: Browser first question',{exact:true}).waitFor();
    assert.equal(await page.locator('#dealSearch').inputValue(),'First chat focus');
    assert.equal(await page.getByText('Browser second question',{exact:true}).count(),0);
    await page.reload();await page.locator('#chatInput:enabled').waitFor();assert.equal(await page.locator('#chatThreadSelect').inputValue(),first);
    await page.route('**/api/pipechat-ai',async route=>{await route.fetch();await route.abort('failed');});
    await page.locator('#chatInput').fill('Recover lost browser response');await page.locator('#sendBtn').click();
    await page.getByText('Saved reply: Recover lost browser response',{exact:true}).waitFor();await page.locator('#chatInput:enabled').waitFor();
    assert.equal((await f.calls()).length,3);assert.equal(await page.getByText('Saved reply: Recover lost browser response',{exact:true}).count(),1);
    await page.unroute('**/api/pipechat-ai');
    await page.locator('#chatInput').fill('Reply to archived browser chat');await page.locator('#sendBtn').click();
    await f.until(async()=> (await f.calls()).length===4);
    await page.locator('#chatNewBtn').click();await page.waitForFunction(id=>document.querySelector('#chatThreadSelect').value!==id,first);
    const newThread=await page.locator('#chatThreadSelect').inputValue();
    await page.waitForTimeout(650);assert.equal(await page.locator('.chat-message').count(),0);
    assert.equal(await page.locator('#chatThreadSelect').inputValue(),newThread);
    await page.locator('#chatThreadSelect').selectOption(first);await page.getByText('Saved reply: Reply to archived browser chat',{exact:true}).waitFor();
    await page.locator('#chatInput:enabled').waitFor();assert.equal((await f.calls()).length,4);
    if(process.env.PIPECHAT_THREAD_SCREENSHOTS){await fs.mkdir(process.env.PIPECHAT_THREAD_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.PIPECHAT_THREAD_SCREENSHOTS,'desktop.png'),fullPage:true});}
    await page.setViewportSize({width:390,height:844});
    const bounds=await page.locator('#chatThreadTools').evaluate(el=>({scroll:el.scrollWidth,width:el.clientWidth}));assert(bounds.scroll<=bounds.width+1);
    if(process.env.PIPECHAT_THREAD_SCREENSHOTS)await page.screenshot({path:path.join(process.env.PIPECHAT_THREAD_SCREENSHOTS,'mobile.png'),fullPage:true});
    assert.deepEqual(errors,[]);
  });
}
