const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path');
const { spawn } = require('node:child_process'), { once } = require('node:events');
const { randomUUID, createHash } = require('node:crypto');
const { validateReceipt } = require('../lib/action-journal.js');

// Executed in the child after the existing offline auth/usage fixture. Keep its
// session checks while modelling journal commits as one in-memory state change.
function installJournalHttpFixture(journalPath) {
  const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
  const { isDeepStrictEqual } = require('node:util'), journal = require(journalPath);
  const publicPath = require('node:path').join(require('node:path').dirname(journalPath), '../public');
  const Workspace = require(publicPath + '/business-workspace.js'), Core = require(publicPath + '/pipeline-core.js');
  const offlineFetch = global.fetch, states = new Map(), actions = new Map(), imports = new Map(), workspaces = new Map();
  const response = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const conflict = message => response(409, { code: 'PT409', message });
  global.fetch = async (input, options = {}) => {
    const url = new URL(String(input)), rpc = url.pathname.replace('/rest/v1/rpc/', '');
    if (url.origin !== 'https://pipechat-test.supabase.co') return offlineFetch(input, options);
    assert(!['pipechat_write_workspace_v2', 'pipechat_write_todo'].includes(rpc), 'The adapter must use journaled writes');
    if (!['pipechat_read_workspace', 'pipechat_commit_action', 'pipechat_commit_todo_action', 'pipechat_read_workflows', 'business_workspace_get', 'pipechat_list_actions'].includes(rpc)) return offlineFetch(input, options);
    const auth = await offlineFetch(new URL('/auth/v1/user', url), { headers: options.headers });
    if (!auth.ok) return auth;
    const user = await auth.json();
    const original = await offlineFetch(new URL('/rest/v1/rpc/pipechat_read_workspace', url), { method: 'POST', headers: options.headers, body: '{}' });
    if (!original.ok) return original;
    const current = states.get(user.id) || { todoCards: [], ...await original.json() };
    if (rpc === 'pipechat_read_workspace') return response(200, current);
    const body = JSON.parse(options.body);
    if (rpc === 'pipechat_read_workflows') {
      assert.deepEqual(body, {});return response(200, { workflows: [], updatedAt: current.updatedAt });
    }
    if (rpc === 'business_workspace_get') {
      assert.deepEqual(body, { p_workspace: null });
      if (!workspaces.has(user.id)) workspaces.set(user.id, randomUUID());
      const workspaceId = workspaces.get(user.id), fields = Core.create(current.tableSchema).definitions(current.customFields);
      return response(200, { workspaceId, version: 0, role: 'owner', scope: 'workspace', state: Workspace.empty(),
        primary: { updatedAt: current.updatedAt, tableSchema: current.tableSchema, customFields: current.customFields,
          records: current.deals.map(row => ({ recordId: row.id, entityId: Workspace.legacyId(workspaceId, row.id),
            values: Object.fromEntries(fields.map(field => [field.id, row[field.id]])) })) } });
    }
    if (rpc === 'pipechat_list_actions') {
      assert.deepEqual(Object.keys(body).sort(), ['p_before', 'p_limit']);assert.equal(body.p_before, null);
      assert(Number.isInteger(body.p_limit) && body.p_limit >= 1 && body.p_limit <= 100);
      const all = [...actions.values()].filter(action => action.userId === user.id).reverse(), selected = all.slice(0, body.p_limit);
      return response(200, { actions: selected.map(action => ({ receipt: action.result.receipt, createdAt: action.createdAt,
        undoneBy: null, undoInvalidated: false, paths: action.entry.changes.map(change => change.path) })),
        before: all.length > selected.length ? { createdAt: selected.at(-1).createdAt, actionId: selected.at(-1).result.receipt.actionId } : null });
    }
    const crm = rpc === 'pipechat_commit_action';
    assert.deepEqual(Object.keys(body).sort(), ['p_action_id', 'p_request_id', 'p_conversation_id', 'p_plan_id', 'p_expected_updated_at', 'p_metadata', crm ? 'p_workspace' : 'p_todo_cards'].sort());
    const meta = journal.prepareMetadata({ actionId: body.p_action_id, requestId: body.p_request_id,
      conversationId: body.p_conversation_id, planId: body.p_plan_id, ...body.p_metadata }, {});
    assert.deepEqual(body.p_metadata, meta.importReceipt ? { importReceipt: meta.importReceipt } : {});
    assert(crm || !meta.importReceipt, 'Imports are CRM-only');
    const key = user.id + ':' + meta.actionId, previous = actions.get(key);
    if (previous) return isDeepStrictEqual(previous.body, body) ? response(200, { ...previous.result, replayed: true }) : conflict('Action ID already used.');
    const importKey = meta.importReceipt && user.id + ':' + meta.importReceipt.id;
    if (importKey && imports.has(importKey)) return conflict('Import receipt already used by another action.');
    if (current.updatedAt !== body.p_expected_updated_at) return conflict('The workspace changed.');
    if (crm) assert.deepEqual(Object.keys(body.p_workspace).sort(), ['deals', 'customFields', 'tableSchema', 'todoCards'].sort());
    const next = crm ? { ...body.p_workspace, updatedAt: randomUUID() } : { ...current, todoCards: body.p_todo_cards, updatedAt: randomUUID() };
    const entry = journal.buildActionEntry({ ...meta, before: current, after: next });
    const { changes, dependencies, ...identity } = entry;
    const receipt = journal.validateReceipt({ ...identity, importReceipt: meta.importReceipt });
    const result = { snapshot: next, receipt, replayed: false };
    const createdAt = new Date(Date.UTC(2026, 0, 1) + actions.size).toISOString().replace('Z', '000Z');
    states.set(user.id, next);actions.set(key, { userId: user.id, body, result, entry, createdAt });
    if (importKey) imports.set(importKey, key);
    return response(200, result);
  };
}

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
  const child = spawn(process.execPath, ['--require', path.join(__dirname, 'fixtures/supabase-http.cjs'), '--eval',
    `(${installJournalHttpFixture.toString()})(${JSON.stringify(path.join(__dirname, '../lib/action-journal.js'))});require(${JSON.stringify(path.join(__dirname, '../server.js'))});`], {
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
    const save = (deals, version, tableSchema = schema, customFields = [], metadata = {}) => req('/api/crm-data', 'PUT', { deals, tableSchema, customFields, expectedUpdatedAt: version, ...metadata }, a);
    function assertReceipt(result, beforeVersion, importReceipt = null, replayed = false) {
      assert.equal(result.status, 200, JSON.stringify(result.data));
      const receipt = validateReceipt(result.data.actionReceipt);
      assert.equal(receipt.beforeVersion, beforeVersion);assert.equal(receipt.afterVersion, result.data.updatedAt);
      assert.notEqual(receipt.afterVersion, beforeVersion);assert.equal(receipt.undoOf, null);
      assert.deepEqual(receipt.importReceipt, importReceipt);assert.equal(result.data.replayed, replayed);
      return receipt;
    }
    const confirm = await save([], initial.data.updatedAt); assert.equal(confirm.status, 200, JSON.stringify(confirm.data));
    assertReceipt(confirm, initial.data.updatedAt);
    const row = { id: 1, [name.id]: 'Synthetic candidate', [amount.id]: 125, history: [] };
    const importReceipt = { id: randomUUID(), digest: createHash('sha256').update(JSON.stringify(row)).digest('hex') };
    const added = await save([row], confirm.data.updatedAt, schema, [], { importReceipt }); assert.equal(added.status, 200);
    const addedReceipt = assertReceipt(added, confirm.data.updatedAt, importReceipt);
    assert.deepEqual(added.data.importReceipt, importReceipt);
    const replay = await save([row], confirm.data.updatedAt, schema, [], { importReceipt });
    assert.deepEqual(assertReceipt(replay, confirm.data.updatedAt, importReceipt, true), addedReceipt);
    assert.deepEqual(replay.data.deals, added.data.deals);assert.equal(replay.data.updatedAt, added.data.updatedAt);
    const changed = await save([{ ...row, [amount.id]: 999 }], confirm.data.updatedAt, schema, [], { importReceipt });
    assert.equal(changed.status, 409, 'A matching receipt cannot approve a different payload');
    const changedDigest = { ...importReceipt, digest: createHash('sha256').update('different proposal').digest('hex') };
    assert.equal((await save([row], confirm.data.updatedAt, schema, [], { importReceipt: changedDigest })).status, 409);
    assert.equal((await save([row], added.data.updatedAt, schema, [], { importReceipt: { ...importReceipt, digest: 'invalid' } })).status, 400);
    assert.deepEqual((await req('/api/crm-data', 'GET', undefined, a)).data.deals, added.data.deals);
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
    const capped = await req('/api/pipechat-ai', 'POST', { command: 'hello', pipeline: { deals: undo.data.deals, customFields, tableSchema: schema } }, a);
    assert.equal(capped.status, 402, JSON.stringify(capped.data));
    const journal = await req('/api/actions', 'GET', undefined, a);assert.equal(journal.status, 200, JSON.stringify(journal.data));
    assert(journal.data.actions.some(action => action.receipt.actionId === addedReceipt.actionId));
    assert.equal(journal.data.actions.filter(action => action.receipt.actionId === addedReceipt.actionId).length, 1, 'Replays must not append another journal action');
    const isolatedJournal = await req('/api/actions', 'GET', undefined, b);assert.equal(isolatedJournal.status, 200);assert.deepEqual(isolatedJournal.data.actions, []);
    const manual = await save([{ ...row, [amount.id]: 999, cf_contact: 'Still editable' }], undo.data.updatedAt, schema, customFields);
    assert.equal(manual.status, 200); assert.equal((await req('/api/chat-usage', 'GET', undefined, a)).data.used, 1);
    const card={...require('../public/todo-core.js').create('todo_isolated',1),nextAction:'Task only',notes:'Card-only note',dueDate:'2026-10-01'};
    const task=await req('/api/todo-cards','PUT',{todoCards:[card],expectedUpdatedAt:manual.data.updatedAt},a);
    assert.equal(task.status,200,JSON.stringify(task.data));assert.deepEqual(task.data.deals,manual.data.deals);assert.deepEqual(task.data.tableSchema,manual.data.tableSchema);assert.deepEqual(task.data.todoCards,[card]);
    const taskReceipt=assertReceipt(task,manual.data.updatedAt);
    const taskReplay=await req('/api/todo-cards','PUT',{todoCards:[card],expectedUpdatedAt:manual.data.updatedAt},a);
    assert.deepEqual(assertReceipt(taskReplay,manual.data.updatedAt,null,true),taskReceipt);assert.deepEqual(taskReplay.data.todoCards,[card]);
    assert.equal((await req('/api/todo-cards','PUT',{todoCards:[],expectedUpdatedAt:manual.data.updatedAt},a)).status,409);
    assert.equal((await req('/api/todo-cards','PUT',{todoCards:[],deals:[],expectedUpdatedAt:task.data.updatedAt},a)).status,400);
    assert.equal((await req('/api/todo-cards','PUT',{todoCards:[card],expectedUpdatedAt:null},b)).status,400);
    assert.equal((await req('/api/todo-cards','PUT',{todoCards:[],expectedUpdatedAt:null},new Map())).status,401);
    assert.equal((await req('/api/chat-usage','GET',undefined,a)).data.used,1);
    const revoked = new Map(a);
    assert.equal((await req('/api/auth/logout', 'POST', {}, a)).status, 200); assert.equal(a.size, 0, JSON.stringify([...a.keys()]));
    assert.equal((await req('/api/crm-data', 'GET', undefined, revoked)).status, 401);
    const login = await req('/api/auth/login', 'POST', { email: 'setup-a@example.invalid', password: 'local-only-123' }, a); assert.equal(login.status, 200);
    const reloaded = await req('/api/crm-data', 'GET', undefined, a); assert.equal(reloaded.data.deals[0][amount.id], 999); assert.deepEqual(reloaded.data.customFields, customFields);
    assert.deepEqual(reloaded.data.todoCards,[card]);
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
