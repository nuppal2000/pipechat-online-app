const test = require('node:test'), assert = require('node:assert/strict');
const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID } = require('node:crypto');
const guard = require('../scripts/supabase-browser-qa-guard.cjs');
const { childEnvironment, startupFailureMessage, runtimeFailureMessage } = require('../scripts/start-supabase-browser-qa.js');
const runId = '60abf0b7-1d6c-402b-8297-dbce9727580b';
const key = 'sb_publishable_synthetic_test_only_key';
const accounts = guard.identities(runId);

test('Supabase QA launcher requires opt-in, strips inherited secrets and cannot target production', () => {
  const env = { SUPABASE_URL: guard.BASE, SUPABASE_PUBLISHABLE_KEY: key, PIPECHAT_QA_RUN_ID: runId,
    OPENAI_API_KEY: 'never inherit', XANO_SERVER_KEY: 'never inherit', NODE_OPTIONS: 'never inherit' };
  assert.throws(() => childEnvironment(env, []));
  assert.throws(() => childEnvironment({ ...env, SUPABASE_URL: 'https://other.supabase.co' }, ['--approved-qa']));
  assert.throws(() => childEnvironment({ ...env, SUPABASE_PUBLISHABLE_KEY: 'sb_secret_forbidden' }, ['--approved-qa']));
  const child = childEnvironment(env, ['--approved-qa']);
  assert.equal(child.OPENAI_API_KEY, guard.SIMULATION_KEY);
  assert.equal(child.XANO_SERVER_KEY, undefined); assert.equal(child.NODE_OPTIONS, undefined);
  assert.equal(child.PIPECHAT_HOST, '127.0.0.1'); assert.equal(child.PORT, '0');
  guard.validateEnvironment(child, ['node', '--approved-qa']);
  assert.throws(() => guard.validateEnvironment({ ...child, NODE_ENV: 'production' }, ['node', '--approved-qa']));
  assert.throws(() => guard.identities('../../unsafe'));
});

test('Supabase QA every operation verifies the exact account and pins its user ID', async () => {
  const access = new AsyncLocalStorage(); let candidate = null, writes = 0, authCalls = 0, constructionContext;
  const real = { check: async () => ({ contract: 'real-contract' }), forRequest() {
    constructionContext = access.getStore()?.kind;
    return { getUser: async () => candidate, authenticate: async () => { authCalls++; return { user: candidate }; },
      readCrm: async () => ({ deals: [] }), writeCrm: async () => { writes++; return access.getStore(); },
      readUsage: async () => ({}), reserveUsage: async () => ({}), finishUsage: async () => ({}), logout: async () => {} };
  } };
  const harness = guard.guardedBackend(real, { runId, access, origin: () => 'http://127.0.0.1:9876' });
  const req = { headers: { host: '127.0.0.1:9876' }, socket: { remoteAddress: '127.0.0.1' } };
  const client = () => harness.wrapped.forRequest(req, {}, {});
  assert.throws(() => harness.wrapped.forRequest({ ...req, headers: { host: 'attacker.test' } }, {}, {}));
  assert.throws(() => harness.wrapped.forRequest({ ...req, socket: { remoteAddress: '10.0.0.3' } }, {}, {}));
  assert.equal(await client().getUser(), null); assert.equal(constructionContext, 'verify');
  await assert.rejects(client().writeCrm(), { status: 403 });
  await assert.rejects(client().authenticate('login', { email: 'customer@example.invalid' }), { status: 403 });
  assert.equal(authCalls, 0); assert.equal(writes, 0);
  candidate = { id: randomUUID(), email: accounts[0].email, name: 'QA A' };
  const first = client(), signed = await first.authenticate('login', { email: accounts[0].email });
  assert.equal(signed.user.id, candidate.id);
  assert.deepEqual(await first.writeCrm(), { kind: 'data', userId: candidate.id });
  candidate = { id: randomUUID(), email: accounts[1].email, name: 'QA B' };
  await assert.rejects(first.writeCrm(), { status: 403 });
  assert.equal(writes, 1);
  assert.equal((await client().getUser()).email, accounts[1].email);
  candidate = { id: randomUUID(), email: accounts[0].email, name: 'Replacement identity' };
  await assert.rejects(client().getUser(), { status: 403 });
  harness.close(); assert.throws(client, { status: 403 });
});

test('Supabase QA transport blocks other destinations and unverified RPCs, while AI is entirely local', async () => {
  const access = new AsyncLocalStorage(); let sent = 0;
  const transport = guard.restrictedFetch(async () => { sent++; return Response.json({ ok: true }); }, { runId, publishableKey: key, access });
  const post = body => ({ method: 'POST', headers: { apikey: key }, body: JSON.stringify(body) });
  await transport(guard.BASE + '/rest/v1/rpc/pipechat_health', post({})); assert.equal(sent, 1);
  for (const address of ['https://xano.example.test/api/crm', 'https://attacker.test/', guard.BASE + '/rest/v1/rpc/pipechat_write_crm']) {
    await assert.rejects(transport(address, post({})));
  }
  await assert.rejects(access.run({ kind: 'authenticate', email: accounts[0].email }, () =>
    transport(guard.BASE + '/auth/v1/token?grant_type=password', post({ email: accounts[1].email }))));
  await access.run({ kind: 'authenticate', email: accounts[0].email }, () =>
    transport(guard.BASE + '/auth/v1/token?grant_type=password', post({ email: accounts[0].email })));
  assert.equal(sent, 2);
  for (const useCase of ['Sales', 'Recruiting', 'Real Estate', 'Other']) {
    const input = { input: [{ content: [{ text: JSON.stringify({ useCase }) }] }], text: { format: { schema: { properties: { fields: {} } } } } };
    const result = await (await transport('https://api.openai.com/v1/responses', post(input))).json();
    const design = JSON.parse(result.output_text);
    const schema = require('../public/table-schema.js').validate({ ...design, status: 'ready', useCase, description: '', fields: design.fields.map((f, i) => ({ ...f, id: 'f_qa_' + i })) });
    assert.equal(schema.fields.filter(f => f.role === 'primary').length, 1);
  }
  const result = await (await transport('https://api.openai.com/v1/responses', post({ input: [{ content: [{ text: JSON.stringify({ userCommand: 'not a scripted action' }) }] }] }))).json();
  assert.equal(JSON.parse(result.output_text).crmAction, null);
  assert.match(JSON.parse(result.output_text).assistantMessage, /simulation/i);
  assert.equal(sent, 2, 'No OpenAI network requests');
});

test('Supabase QA outage blocks only verified CRM operations and never alters provider data', async () => {
  let candidate = { id: randomUUID(), email: accounts[0].email }, reads = 0, writes = 0, usage = 0;
  const real = { check: async () => 'healthy', forRequest: () => ({
    getUser: async () => candidate,
    readCrm: async () => { reads++; return { deals: [] }; },
    writeCrm: async () => { writes++; return { saved: true }; },
    readUsage: async () => { usage++; return { used: 7 }; },
    reserveUsage: async () => 'reservation', finishUsage: async () => 'released'
  }) };
  const harness = guard.guardedBackend(real, { runId });
  const client = harness.wrapped.forRequest({}, {}, {});
  harness.setOutage(true);
  await assert.rejects(client.readCrm(), { status: 503 });
  await assert.rejects(client.writeCrm(), { status: 503 });
  assert.equal(reads, 0); assert.equal(writes, 0);
  assert.equal(await harness.wrapped.check(), 'healthy');
  assert.deepEqual(await client.readUsage(), { used: 7 }); assert.equal(usage, 1);
  assert.equal(await client.finishUsage(), 'released');
  candidate = { id: randomUUID(), email: 'customer@example.invalid' };
  await assert.rejects(client.writeCrm(), { status: 403 }, 'identity guard still precedes outage');
  harness.setOutage(false);
  candidate = { id: randomUUID(), email: accounts[1].email };
  const fresh = harness.wrapped.forRequest({}, {}, {});
  assert.deepEqual(await fresh.readCrm(), { deals: [] });
  assert.deepEqual(await fresh.writeCrm(), { saved: true });
  assert.equal(reads, 1); assert.equal(writes, 1);
  assert.throws(() => harness.setOutage('on'));
  harness.close(); assert.throws(() => harness.setOutage(false));
});

test('restored browser QA pins its separate destination, run and public key without weakening the source mode', () => {
  const input={SUPABASE_URL:guard.RESTORE.base,SUPABASE_PUBLISHABLE_KEY:guard.RESTORE.publishableKey,
    PIPECHAT_QA_RUN_ID:runId,PIPECHAT_SUPABASE_RESTORE_QA:'1',OPENAI_API_KEY:'never inherit',DATABASE_URL:'never inherit'};
  const child=childEnvironment(input,['--approved-qa']);
  assert.equal(child.SUPABASE_URL,guard.RESTORE.base);
  assert.equal(child.PIPECHAT_SUPABASE_RESTORE_QA,'1');
  assert.equal(child.DATABASE_URL,undefined);
  assert.equal(child.OPENAI_API_KEY,guard.SIMULATION_KEY);
  guard.validateEnvironment(child,['node','--approved-qa']);
  for(const change of [{SUPABASE_URL:guard.BASE},{SUPABASE_URL:'https://arbitrary.supabase.co'},
    {PIPECHAT_QA_RUN_ID:randomUUID()},{PIPECHAT_QA_RUN_ID:undefined},{SUPABASE_PUBLISHABLE_KEY:key},
    {PIPECHAT_SUPABASE_RESTORE_QA:'true'},{PIPECHAT_SUPABASE_RESTORE_QA:'0'},{PIPECHAT_SUPABASE_RESTORE_QA:undefined}]) {
    assert.throws(()=>childEnvironment({...input,...change},['--approved-qa']));
  }
  for(const change of [{SUPABASE_URL:guard.BASE},{PIPECHAT_QA_RUN_ID:randomUUID()},
    {SUPABASE_PUBLISHABLE_KEY:key},{PIPECHAT_SUPABASE_RESTORE_QA:'0'},{PORT:'8787'},
    {PIPECHAT_HOST:'0.0.0.0'},{OPENAI_API_KEY:'sk-real-must-not-be-used'}]) {
    assert.throws(()=>guard.validateEnvironment({...child,...change},['node','--approved-qa']));
  }
  assert.throws(()=>guard.projectBase('true',runId));
});

test('restored QA transport denies source, signup, all metering, CRM writes and every OpenAI call',async()=>{
  const access=new AsyncLocalStorage(),sent=[];
  const transport=guard.restrictedFetch(async(input,init)=>{sent.push([String(input),init]);return Response.json({ok:true});},
    {runId,publishableKey:guard.RESTORE.publishableKey,restoreOnly:true,access});
  const uid=randomUUID(),jwt='header.'+Buffer.from(JSON.stringify({sub:uid,role:'authenticated'})).toString('base64url')+'.sig';
  const post=body=>({method:'POST',headers:{apikey:guard.RESTORE.publishableKey,authorization:'Bearer '+jwt},body:JSON.stringify(body)});
  const base=guard.RESTORE.base;
  await transport(base+'/rest/v1/rpc/pipechat_health',post({}));
  await access.run({kind:'authenticate',email:accounts[0].email},()=>transport(base+'/auth/v1/token?grant_type=password',post({email:accounts[0].email})));
  await access.run({kind:'verify'},()=>transport(base+'/auth/v1/user',{...post({}),method:'GET',body:undefined}));
  await access.run({kind:'data',userId:uid},()=>transport(base+'/rest/v1/rpc/pipechat_read_crm',post({})));
  await access.run({kind:'verify'},()=>transport(base+'/auth/v1/token?grant_type=refresh_token',post({refresh_token:'private-test'})));
  await access.run({kind:'logout',userId:uid},()=>transport(base+'/auth/v1/logout?scope=local',post({})));
  assert.equal(sent.length,6);
  for(const rpc of ['write_crm','read_usage','reserve_usage','finish_usage']) {
    await assert.rejects(access.run({kind:'data',userId:uid},()=>transport(base+'/rest/v1/rpc/pipechat_'+rpc,post({}))));
  }
  for(const url of [guard.BASE+'/rest/v1/rpc/pipechat_health','https://api.openai.com/v1/responses','https://other.example.test/',
    base+'/rest/v1/pipechat.crm_records',base+'/auth/v1/logout?scope=global']) {
    await assert.rejects(access.run({kind:'data',userId:uid},()=>transport(url,post({}))));
  }
  await assert.rejects(access.run({kind:'authenticate',email:accounts[0].email},()=>transport(base+'/auth/v1/signup',post({email:accounts[0].email}))));
  await assert.rejects(access.run({kind:'authenticate',email:accounts[0].email},()=>transport(base+'/auth/v1/token?grant_type=password',post({email:accounts[1].email}))));
  await assert.rejects(access.run({kind:'data',userId:randomUUID()},()=>transport(base+'/rest/v1/rpc/pipechat_read_crm',post({}))));
  await assert.rejects(transport(base+'/rest/v1/rpc/pipechat_read_crm',post({})));
  assert.equal(sent.length,6,'All denied operations stop before the network');
  assert(sent.every(([url,init])=>url.startsWith(base+'/') && init.redirect==='error'));
});

test('restored QA backend allows existing-account login/read/logout but no edits, signups or quota operations',async()=>{
  let candidate={id:randomUUID(),email:accounts[0].email},authCalls=0,logouts=0,reads=0,usageReads=0,writes=0;
  const real={check:async()=>({ok:true}),forRequest:()=>({
    getUser:async()=>candidate,
    authenticate:async()=>{authCalls++;return {user:candidate};},
    logout:async()=>{logouts++;},readCrm:async()=>{reads++;return {deals:[]};},
    readUsage:async()=>{usageReads++;return {};},writeCrm:async()=>{writes++;},
    reserveUsage:async()=>{writes++;},finishUsage:async()=>{writes++;}
  })};
  const harness=guard.guardedBackend(real,{runId,restoreOnly:true,origin:()=> 'http://127.0.0.1:9876'});
  const req={headers:{host:'127.0.0.1:9876'},socket:{remoteAddress:'127.0.0.1'}};
  const client=harness.wrapped.forRequest(req,{},{});
  await assert.rejects(client.authenticate('signup',{email:accounts[0].email}),{status:403});
  await assert.rejects(client.authenticate('login',{email:'customer@example.invalid'}),{status:403});
  assert.equal(authCalls,0);
  assert.equal((await client.authenticate('login',{email:accounts[0].email})).user.id,candidate.id);
  assert.deepEqual(await client.readCrm(),{deals:[]});
  for(const method of ['writeCrm','readUsage','reserveUsage','finishUsage'])await assert.rejects(client[method](),{status:403});
  assert.equal(usageReads,0,'Even usage reads could expire reservations; do not call them');
  assert.equal(writes,0);assert.equal(reads,1);
  await client.logout();assert.equal(logouts,1);
  await assert.rejects(client.readCrm(),{status:403});
  candidate={id:randomUUID(),email:accounts[1].email};
  const next=harness.wrapped.forRequest(req,{},{});
  assert.equal((await next.authenticate('login',{email:accounts[1].email})).user.email,accounts[1].email);
  assert.deepEqual(await next.readCrm(),{deals:[]});
  harness.close();await assert.rejects(next.readCrm(),{status:403});
});

test('QA startup health failure reports a static IPC event; later readiness failures are not startup failures',async()=>{
  const secret=new Error('PRIVATE_PROVIDER_BODY_OR_CREDENTIAL');
  const messages=[];
  const failed=guard.startupCheck(async()=>{throw secret;},m=>messages.push(m));
  await assert.rejects(failed(),e=>e===secret);
  await assert.rejects(failed(),e=>e===secret);
  assert.deepEqual(messages,[{type:'qa-startup-failed',stage:'backend-health'}]);
  let calls=0;
  const healthy=guard.startupCheck(async()=>{if(calls++)throw secret;return {ok:true};},m=>messages.push(m));
  assert.deepEqual(await healthy(),{ok:true});
  await assert.rejects(healthy(),e=>e===secret);
  assert.equal(messages.length,1);
  const message={type:'qa-startup-failed',stage:'backend-health',error:secret.message};
  assert.match(startupFailureMessage(message,404),/schema cache/);
  for(const status of [undefined,200,401,403,429,503,'__proto__','PRIVATE_PROVIDER_BODY_OR_CREDENTIAL']) {
    const text=startupFailureMessage(message,status);
    assert.match(text,/^FAIL: QA backend health check/);
    assert(!text.includes('PRIVATE_'));assert(!text.includes('[object Object]'));
  }
  assert.equal(startupFailureMessage({type:'unknown',error:secret.message},404),null);
});

test('QA launcher stops a failed startup promptly, clears its timer and never prints raw child errors',async()=>{
  const vm=require('node:vm'),fs=require('node:fs/promises'),path=require('node:path'),{EventEmitter}=require('node:events');
  const code=await fs.readFile(path.join(__dirname,'../scripts/start-supabase-browser-qa.js'),'utf8');
  const timers=[],logs=[],sent=[];
  const child=new EventEmitter();child.connected=true;
  child.send=(message,callback)=>{sent.push(message);callback?.();queueMicrotask(()=>child.emit('exit',1));};
  child.kill=()=>assert.fail('Do not need the force-kill timer for an acknowledged stop');
  const proc=new EventEmitter();
  proc.env={SUPABASE_URL:guard.RESTORE.base,SUPABASE_PUBLISHABLE_KEY:guard.RESTORE.publishableKey,
    PIPECHAT_QA_RUN_ID:runId,PIPECHAT_SUPABASE_RESTORE_QA:'1'};
  proc.argv=['node','runner','--approved-qa'];proc.execPath=process.execPath;proc.exitCode=0;proc.stdin={isTTY:false};
  const mod={exports:{}};
  const localRequire=name=>name==='node:child_process'?{spawn(_exe,_args,options){
    assert.deepEqual(Array.from(options.stdio),['ignore','ignore','ignore','ipc']);
    assert.equal(options.env.SUPABASE_URL,guard.RESTORE.base);
    return child;
  }}:name==='./supabase-browser-qa-guard.cjs'?guard:require(name);
  vm.runInNewContext(code,{require:localRequire,module:mod,process:proc,__dirname:path.resolve(__dirname,'../scripts'),
    console:{log:text=>logs.push(text),error:text=>logs.push(text)},
    setTimeout:(callback,delay)=>{const timer={callback,delay,cleared:false,unref(){}};timers.push(timer);return timer;},
    clearTimeout:timer=>{if(timer)timer.cleared=true;}});
  const running=mod.exports.main();
  child.emit('message',{type:'qa-health-status',status:404,body:'PRIVATE_BODY'});
  child.emit('message',{type:'qa-startup-failed',stage:'backend-health',error:'PRIVATE_ERROR'});
  await running;
  assert.equal(proc.exitCode,1);
  assert.equal(sent.length,1);assert.equal(sent[0].type,'qa-stop');
  assert.equal(logs.length,1);assert.match(logs[0],/HTTP 404/);
  assert(!logs[0].includes('PRIVATE_'));assert(!logs[0].includes('timed out'));
  assert(timers.find(timer=>timer.delay===25000)?.cleared);
  assert(timers.every(timer=>timer.cleared));
});

test('QA fatal diagnostics allow only fixed categories and source locations, never raw errors or credentials',()=>{
  const error={name:'TypeError',code:'ERR_HTTP_HEADERS_SENT',message:'PRIVATE_CREDENTIAL',
    stack:'TypeError: PRIVATE_CREDENTIAL\n    at hidden (C:\\PRIVATE_PATH\\supabase-backend.js:242:31)'};
  const diagnostic=guard.runtimeDiagnostic(error,'unhandledRejection');
  assert.deepEqual(diagnostic,{type:'qa-runtime-failed',origin:'UNHANDLED_REJECTION',kind:'TypeError',
    code:'ERR_HTTP_HEADERS_SENT',site:'supabase-backend.js:242:31'});
  const text=runtimeFailureMessage(diagnostic);
  assert.match(text,/UNHANDLED_REJECTION; TypeError; ERR_HTTP_HEADERS_SENT; supabase-backend\.js:242:31/);
  assert(!text.includes('PRIVATE_'));
  const untrusted=guard.runtimeDiagnostic({name:'PRIVATE_NAME',code:'PRIVATE_CODE',message:'PRIVATE_ERROR',
    stack:'PRIVATE_STACK\n    at /arbitrary-file.js:1:2'},'PRIVATE_ORIGIN');
  assert.equal(untrusted.site,'UNKNOWN');assert.equal(untrusted.kind,'Error');assert.equal(untrusted.code,'UNCLASSIFIED');
  assert(!JSON.stringify(untrusted).includes('PRIVATE_'));
  const forged={type:'qa-runtime-failed',kind:'PRIVATE_NAME',code:'PRIVATE_CODE',origin:'PRIVATE_ORIGIN',site:'server.js:1:1\nPRIVATE_ERROR'};
  assert(!runtimeFailureMessage(forged).includes('PRIVATE_'));
  assert.match(runtimeFailureMessage(forged),/UNCAUGHT_EXCEPTION; Error; UNCLASSIFIED; UNKNOWN/);
  assert.equal(runtimeFailureMessage({type:'other'}),null);
});

test('QA launcher reports post-start fatal errors and unexpected exits, but keeps an intentional stop successful',async()=>{
  const vm=require('node:vm'),fs=require('node:fs/promises'),path=require('node:path'),{EventEmitter}=require('node:events');
  const code=await fs.readFile(path.join(__dirname,'../scripts/start-supabase-browser-qa.js'),'utf8');
  for(const scenario of ['fatal','unexpected','stop']) {
    const timers=[],logs=[],sent=[],child=new EventEmitter(),proc=new EventEmitter();
    child.connected=true;
    child.send=(message,callback)=>{sent.push(message);callback?.();queueMicrotask(()=>child.emit('exit',0));};
    child.kill=()=>assert.fail('Acknowledged stop must not force-kill');
    proc.env={SUPABASE_URL:guard.RESTORE.base,SUPABASE_PUBLISHABLE_KEY:guard.RESTORE.publishableKey,
      PIPECHAT_QA_RUN_ID:runId,PIPECHAT_SUPABASE_RESTORE_QA:'1'};
    proc.argv=['node','runner','--approved-qa'];proc.execPath=process.execPath;proc.exitCode=0;proc.stdin={isTTY:false};
    const mod={exports:{}};
    const localRequire=name=>name==='node:child_process'?{spawn:()=>child}:name==='./supabase-browser-qa-guard.cjs'?guard:require(name);
    vm.runInNewContext(code,{require:localRequire,module:mod,process:proc,__dirname:path.resolve(__dirname,'../scripts'),
      console:{log:text=>logs.push(text),error:text=>logs.push(text)},
      setTimeout:(callback,delay)=>{const timer={callback,delay,cleared:false,unref(){}};timers.push(timer);return timer;},
      clearTimeout:timer=>{if(timer)timer.cleared=true;}});
    const running=mod.exports.main();
    child.emit('message',{type:'qa-ready',port:50000});
    if(scenario==='fatal')child.emit('message',{type:'qa-runtime-failed',origin:'UNHANDLED_REJECTION',kind:'TypeError',code:'ERR_HTTP_HEADERS_SENT',site:'server.js:123:4',error:'PRIVATE_ERROR'});
    else if(scenario==='unexpected')child.emit('exit',1,'PRIVATE_SIGNAL');
    else proc.emit('SIGINT');
    await running;
    assert.equal(proc.exitCode,scenario==='stop'?0:1);
    assert.equal(sent.length,scenario==='unexpected'?0:1);
    if(sent.length)assert.equal(sent[0].type,'qa-stop');
    assert(!logs.some(text=>text.includes('PRIVATE_')||text.includes('timed out')));
    if(scenario==='fatal')assert(logs.some(text=>text.includes('QA runtime stopped; UNHANDLED_REJECTION')));
    if(scenario==='unexpected')assert(logs.some(text=>text.includes('exited unexpectedly; exit=1; signal=none')));
    if(scenario==='stop')assert(!logs.some(text=>text.startsWith('FAIL:')));
    assert(timers.every(timer=>timer.cleared));
    assert.equal(proc.listenerCount('SIGINT'),0);assert.equal(proc.listenerCount('SIGTERM'),0);
  }
});
