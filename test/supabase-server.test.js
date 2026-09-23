const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path');
const { spawn } = require('node:child_process'), { once } = require('node:events');

for(const signupAllowed of ['true','false','invalid'])test(`signup=${signupAllowed}: public routes cannot refresh stale cookies; revoked sessions clear without crashing`, {timeout:20000}, async()=>{
  const child=spawn(process.execPath,['--unhandled-rejections=strict','--require',path.join(__dirname,'fixtures/supabase-stale-cookie-http.cjs'),path.join(__dirname,'../server.js')],{
    windowsHide:true,stdio:['ignore','pipe','pipe','ipc'],env:{
      ...Object.fromEntries(['SystemRoot','WINDIR','PATH','TEMP','TMP'].filter(k=>process.env[k]).map(k=>[k,process.env[k]])),
      PORT:'0',PIPECHAT_HOST:'127.0.0.1',PIPECHAT_STORAGE_PROVIDER:'supabase',NODE_ENV:'test',PIPECHAT_COOKIE_SECURE:'false',
      PIPECHAT_ALLOW_SIGNUP:signupAllowed,
      SUPABASE_URL:'https://pipechat-test.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_synthetic_test_key_123456789',PIPECHAT_PUBLIC_ORIGIN:'http://127.0.0.1'
    }
  });
  const exit=once(child,'exit');let output='';
  child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);
  function message(type){return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{cleanup();reject(new Error('Bounded test IPC timeout'));},5000);
    const receive=m=>{if(m.type===type){cleanup();resolve(m);}};
    const died=()=>{cleanup();reject(new Error('Test server exited: '+output));};
    function cleanup(){clearTimeout(timer);child.off('message',receive);child.off('exit',died);}
    child.on('message',receive);child.once('exit',died);
  });}
  try {
    const ready=await message('test-ready'),root='http://127.0.0.1:'+ready.port;
    const session={access_token:'eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjF9.synthetic',refresh_token:'synthetic-expired-refresh',expires_at:1,expires_in:3600,token_type:'bearer',user:{id:'synthetic',email:'qa@example.invalid'}};
    const cookie='pipechat_supabase=base64-'+Buffer.from(JSON.stringify(session)).toString('base64url');
    for(const route of ['/','/pipechat.js','/api/health','/api/ready','/api/monitor-status','/api/not-a-route']) {
      const r=await fetch(root+route,{headers:{cookie},signal:AbortSignal.timeout(5000)});
      assert.equal(r.status,route==='/api/not-a-route'?404:200);
      if(route==='/api/health')assert.equal((await r.clone().json()).signupAllowed,signupAllowed==='true');
      await r.arrayBuffer();
      assert.equal(r.headers.getSetCookie().length,0,'Non-auth routes must not update cookies');
    }
    for(const [route,body,extra,status] of [
      ['/api/auth/signup','{}',{},400],
      ['/api/auth/login','{',{},400],
      ['/api/auth/login','{}',{},400],
      ['/api/auth/signup',JSON.stringify({email:'bad@@example.invalid',password:'synthetic-password'}),{},400],
      ['/api/auth/login','{}',{origin:'https://foreign.example.invalid'},403],
      ['/api/auth/login','{}',{'content-type':'text/plain'},415]
    ]) {
      const r=await fetch(root+route,{method:'POST',headers:{cookie,'content-type':'application/json',...extra},body,signal:AbortSignal.timeout(5000)});
      assert.equal(r.status,route==='/api/auth/signup'&&signupAllowed!=='true'?403:status);await r.arrayBuffer();
      assert.equal(r.headers.getSetCookie().length,0,'Rejected input must not start a background session refresh');
    }
    const pending=message('test-count');child.send({type:'test-count'});
    assert.equal((await pending).authCalls,0,'Static/health routes must not construct an auth client');
    const auth=await fetch(root+'/api/auth/me',{headers:{cookie},signal:AbortSignal.timeout(5000)});
    assert.equal(auth.status,200);assert.deepEqual(await auth.json(),{user:null});
    assert(auth.headers.getSetCookie().some(value=>value.startsWith('pipechat_supabase=')&&/Max-Age=0/.test(value)));
    const count=message('test-count');child.send({type:'test-count'});assert.equal((await count).authCalls,1);
    assert.equal((await fetch(root+'/api/health')).status,200);
    assert(!output.includes('synthetic-expired-refresh'));
    child.send({type:'test-stop'});assert.equal((await exit)[0],0);
  } finally {
    if(child.exitCode===null){child.kill();await exit;}
  }
});

test('Supabase HTTP path preserves onboarding, fields, manual edits at cap and account isolation', { timeout: 40000 }, async () => {
  const dataDir = await fs.mkdtemp(path.join(__dirname, 'test-supabase-'));
  const child = spawn(process.execPath, ['--require', path.join(__dirname, 'fixtures/supabase-http.cjs'), path.join(__dirname, '../server.js')], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env, PORT: '0', PIPECHAT_AI_PORT: '0', PIPECHAT_HOST: '127.0.0.1',
      PIPECHAT_STORAGE_PROVIDER: 'supabase', PIPECHAT_DATA_DIR: dataDir,
      SUPABASE_URL: 'https://pipechat-test.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_synthetic_test_only_key',
      OPENAI_API_KEY: 'TEST_ONLY', PIPECHAT_PUBLIC_ORIGIN: 'http://127.0.0.1',
      NODE_ENV: 'test', PIPECHAT_COOKIE_SECURE: 'false'
    }
  });
  let output = '', root;
  child.stdout.on('data', chunk => output += chunk);
  child.stderr.on('data', chunk => output += chunk);
  try {
    for (let i = 0; i < 150; i++) {
      const found = output.match(/QA_LISTEN_PORT=(\d+)/);
      if (found) { root = 'http://127.0.0.1:' + found[1]; break; }
      if (child.exitCode !== null) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert(root, 'test server starts: ' + output);
    async function req(route, method = 'GET', body, jar = new Map()) {
      const response = await fetch(root + route, { method, headers: {
        'Content-Type': 'application/json', Cookie: [...jar].map(([k, v]) => k + '=' + v).join('; ')
      }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      const cookies = response.headers.getSetCookie();
      for (const cookie of cookies) {
        const pair = cookie.split(';')[0], index = pair.indexOf('=');
        if (/Max-Age=0\b/i.test(cookie)) jar.delete(pair.slice(0, index));
        else jar.set(pair.slice(0, index), pair.slice(index + 1));
      }
      return { status: response.status, data: await response.json(), headers: response.headers, cookies };
    }
    const a = new Map(), b = new Map();
    const signup = await req('/api/auth/signup', 'POST', { email: 'setup-a@example.invalid', password: 'local-only-123', name: 'QA A' }, a);
    assert.equal(signup.status, 200, JSON.stringify(signup.data) + '\n' + output);
    assert(signup.data.user.id); assert(!JSON.stringify(signup.data).includes('access_token'));
    assert(signup.cookies.length > 0);
    assert(signup.cookies.every(cookie => /HttpOnly/i.test(cookie) && /SameSite=Lax/i.test(cookie)));
    assert.match(signup.headers.get('cache-control'), /no-store/);
    await req('/api/auth/signup', 'POST', { email: 'setup-b@example.invalid', password: 'local-only-123', name: 'QA B' }, b);
    const initial = await req('/api/crm-data', 'GET', undefined, a);
    assert.deepEqual(initial.data.deals, []); assert.equal(initial.data.tableSchema.status, 'pending');
    const build = await req('/api/pipechat-ai', 'POST', { tableBuild: { useCase: 'Recruiting', description: '' } }, a);
    assert.equal(build.status, 200, JSON.stringify(build.data)); assert.equal(build.data.usage.used, 1);
    const schema = build.data.tableSchema, [name, amount] = schema.fields;
    assert.equal((await req('/api/crm-data', 'GET', undefined, a)).data.tableSchema.status, 'pending');
    const save = (deals, version, tableSchema = schema, customFields = []) => req('/api/crm-data', 'PUT', { deals, tableSchema, customFields, expectedUpdatedAt: version }, a);
    const confirm = await save([], initial.data.updatedAt); assert.equal(confirm.status, 200, JSON.stringify(confirm.data));
    const row = { id: 1, [name.id]: 'Synthetic candidate', [amount.id]: 125, history: [] };
    const added = await save([row], confirm.data.updatedAt); assert.equal(added.status, 200);
    const customFields = [{ id: 'cf_contact', name: 'Contact', type: 'text' }];
    const custom = await save([{ ...row, cf_contact: 'Synthetic contact' }], added.data.updatedAt, schema, customFields);
    assert.equal(custom.status, 200, JSON.stringify(custom.data));
    const primary = require('../public/pipeline-core.js').create(schema).deleteColumn(custom.data.deals, name.id, customFields, { field: 'cf_contact' });
    const replaced = await save(primary.records, custom.data.updatedAt, primary.tableSchema, primary.customFields);
    assert.equal(replaced.status, 200, JSON.stringify(replaced.data));
    assert.equal(replaced.data.deals[0].cf_contact, 'Synthetic contact'); assert.equal(replaced.data.deals[0][name.id], undefined);
    const undo = await save(custom.data.deals, replaced.data.updatedAt, schema, customFields); assert.equal(undo.status, 200);
    const stale = await save([], replaced.data.updatedAt, schema, customFields); assert.equal(stale.status, 409);
    assert.equal((await req('/api/crm-data', 'GET', undefined, b)).data.tableSchema.status, 'pending');
    assert.equal((await req('/api/pipechat-ai', 'POST', { command: 'hello', pipeline: { deals: undo.data.deals, customFields, tableSchema: schema } }, a)).status, 402);
    const manual = await save([{ ...row, [amount.id]: 999, cf_contact: 'Still editable' }], undo.data.updatedAt, schema, customFields);
    assert.equal(manual.status, 200); assert.equal((await req('/api/chat-usage', 'GET', undefined, a)).data.used, 1);
    const revoked = new Map(a);
    assert.equal((await req('/api/auth/logout', 'POST', {}, a)).status, 200); assert.equal(a.size, 0, JSON.stringify([...a.keys()]));
    assert.equal((await req('/api/crm-data', 'GET', undefined, revoked)).status, 401);
    const login = await req('/api/auth/login', 'POST', { email: 'setup-a@example.invalid', password: 'local-only-123' }, a); assert.equal(login.status, 200);
    const reloaded = await req('/api/crm-data', 'GET', undefined, a); assert.equal(reloaded.data.deals[0][amount.id], 999); assert.deepEqual(reloaded.data.customFields, customFields);
    const empty = await save([], reloaded.data.updatedAt, schema, customFields); assert.equal(empty.status, 200);
    assert.deepEqual((await req('/api/crm-data', 'GET', undefined, a)).data.deals, []);
    const confirmation = new Map(), pending = await req('/api/auth/signup', 'POST', { email: 'confirm-c@example.invalid', password: 'local-only-123', name: 'QA C' }, confirmation);
    assert.equal(pending.status, 200); assert.equal(pending.data.confirmationRequired, true);
    assert([...confirmation.keys()].every(key => key.includes('code-verifier')), 'Only temporary PKCE cookies, not a signed-in session');
    assert.equal((await req('/api/crm-data', 'GET', undefined, confirmation)).status, 401);
    const outage = new Map(); await req('/api/auth/signup', 'POST', { email: 'outage-d@example.invalid', password: 'local-only-123', name: 'QA D' }, outage);
    const failed = await req('/api/crm-data', 'GET', undefined, outage); assert(failed.status >= 500);
    assert(!JSON.stringify(failed.data).includes('private provider detail'));
    assert.deepEqual(await fs.readdir(dataDir), [], 'Supabase failures never create local fallback storage');
    assert(!output.includes('local-only-123')); assert(!output.includes('access_token'));
  } finally {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    if (path.dirname(dataDir) === __dirname && path.basename(dataDir).startsWith('test-supabase-')) await fs.rm(dataDir, { recursive: true, force: true });
  }
});
