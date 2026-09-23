const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/pipechat.js'), 'utf8');
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness(handler) {
  const nodes = new Map(), classes = new Set(['auth-locked']);
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', textContent: '', innerHTML: '', hidden: false,
      disabled: false, classList: { add() {}, remove() {} } });
    return nodes.get(id);
  };
  const context = { window: { PipelineCore: require('../public/pipeline-core.js'), PipeChatIcons: {} },
    document: { getElementById: node, querySelectorAll: () => [], querySelector:()=>null,
      body: { classList: { add: key => classes.add(key), remove: key => classes.delete(key) } } },
    fetch: async (url, options) => ({ ok: true, json: async () => handler(url, options) }) };
  // Test real controller functions with tiny DOM stubs; no production debug hooks.
  const boot = '  wire();\n  restoreSession();';
  const normalized = source.replace(/\r\n/g, '\n');
  assert(normalized.includes(boot));
  vm.runInNewContext(normalized.replace(boot, `
    render=()=>{};say=()=>{};
    window.test={S,loadWorkspace,restoreSession,authSubmit,loadAuthPolicy,toggleAuthMode};`), context);
  return { ...context.window.test, node, classes };
}
const user = id => ({ id, name: `QA ${id}`, email: `qa-${id}@example.invalid` });
const snapshot = id => ({ deals: [{ id: 1, account: `Account ${id}` }], updatedAt: `version-${id}`, seedDemoData: false });

test('late CRM response cannot replace a newer user workspace', async () => {
  const old = deferred(); let calls = 0;
  const h = harness(url => url === '/api/crm-data' ? (++calls === 1 ? old.promise : snapshot(2)) : {});
  const first = h.loadWorkspace(user(1));
  await h.loadWorkspace(user(2));
  old.resolve(snapshot(1)); await first;
  assert.equal(h.S.user.id, 2); assert.equal(h.S.records[0].account, 'Account 2');
  assert.equal(h.node('accountPill').textContent, 'QA 2');
});

test('late load error does not overwrite the newer login status', async () => {
  const old = deferred(); let calls = 0;
  const h = harness(url => url === '/api/crm-data' ? (++calls === 1 ? old.promise : snapshot(2)) : {});
  const first = h.loadWorkspace(user(1)); await h.loadWorkspace(user(2));
  old.reject(new Error('Old request failed')); await first;
  assert.equal(h.node('authMessage').textContent, ''); assert.equal(h.S.loaded, true);
});

for (const endpoint of ['/api/chat-usage', '/api/health']) {
  test(`late ${endpoint} response cannot publish stale records`, async () => {
    const old = deferred(), reached = deferred(); let crmCalls = 0, delayed = false;
    const h = harness(url => {
      if (url === '/api/crm-data') return snapshot(++crmCalls);
      if (url === endpoint && !delayed) { delayed = true; reached.resolve(); return old.promise; }
      return { used: 2 };
    });
    const first = h.loadWorkspace(user(1)); await reached.promise;
    await h.loadWorkspace(user(2)); old.resolve({ used: 1 }); await first;
    assert.equal(h.S.records[0].account, 'Account 2'); assert.equal(h.S.usage.used, 2);
  });
}

test('explicit sign-in invalidates a pending automatic session restore', async () => {
  const old = deferred(); let crmCalls = 0;
  const h = harness(url => {
    if (url === '/api/auth/me') return old.promise;
    if (url === '/api/auth/login') return { user: user(2) };
    if (url === '/api/crm-data') { crmCalls++; return snapshot(2); }
    return {};
  });
  const restore = h.restoreSession();
  await h.authSubmit({ preventDefault() {} });
  old.resolve({ user: user(1) }); await restore;
  assert.equal(crmCalls, 1); assert.equal(h.S.user.id, 2);
});

test('failed workspace load stays locked and clears previous in-memory records', async () => {
  const h = harness(() => { throw new Error('Synthetic offline failure'); });
  h.S.records = snapshot(1).deals; h.S.loaded = true;
  await h.loadWorkspace(user(2));
  assert.equal(h.S.loaded, false); assert.equal(h.S.records.length, 0);
  assert(h.classes.has('auth-locked')); assert.equal(h.node('authScreen').hidden, false);
});

test('email confirmation leaves the CRM locked and switches back to sign in', async () => {
  const calls=[];
  const h=harness(url=>{calls.push(url);return {confirmationRequired:true,message:'Confirm your email first.'};});
  h.S.signupAllowed=true;h.S.signup=true;h.node('authPassword').value='temporary-password';
  await h.authSubmit({preventDefault(){}});
  assert.deepEqual(calls,['/api/auth/signup']);assert.equal(h.S.user,null);assert.equal(h.S.loaded,false);
  assert(h.classes.has('auth-locked'));assert.equal(h.S.signup,false);assert.equal(h.node('authPassword').value,'');
  assert.equal(h.node('authSubmitBtn').textContent,'Sign in');assert.equal(h.node('authSubmitBtn').disabled,false);
  assert.equal(h.node('authMessage').textContent,'Confirm your email first.');
});

test('an auth response without a user never attempts to open the workspace', async () => {
  const calls=[];const h=harness(url=>{calls.push(url);return {};});
  await h.authSubmit({preventDefault(){}});
  assert.deepEqual(calls,['/api/auth/login']);assert(h.classes.has('auth-locked'));
  assert.match(h.node('authMessage').textContent,/Sign-in was not completed/);
});

test('signup stays hidden unless the server explicitly allows it; existing login remains usable', async () => {
  for(const health of [{signupAllowed:false},{},{signupAllowed:'true'},new Error('offline')]) {
    const calls=[];
    const h=harness(url=>{calls.push(url);if(url==='/api/health'){if(health instanceof Error)throw health;return health;}return {};});
    await h.loadAuthPolicy();
    assert.equal(h.S.signupAllowed,false);assert.equal(h.node('authToggleBtn').hidden,true);
    h.toggleAuthMode();assert.equal(h.S.signup,false);
    h.S.signup=true;await h.authSubmit({preventDefault(){}});
    assert.deepEqual(calls,['/api/health']);assert.match(h.node('authMessage').textContent,/signup is currently closed/);
    h.S.signup=false;await h.authSubmit({preventDefault(){}});
    assert.equal(calls.at(-1),'/api/auth/login');
  }
  const h=harness(()=>({signupAllowed:true}));
  await h.loadAuthPolicy();assert.equal(h.node('authToggleBtn').hidden,false);
  h.toggleAuthMode();assert.equal(h.S.signup,true);assert.equal(h.node('nameField').hidden,false);
});
