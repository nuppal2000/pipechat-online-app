const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const core = require('../public/pipeline-core.js');
const source = fs.readFileSync(path.join(__dirname, '../public/pipechat.js'), 'utf8').replace(/\r\n/g, '\n');
const row = { id: 1, account: 'Acme QA', stage: 'Warm', value: 25, close: '', owner: 'A', next: '', follow: '', notes: '', history: [] };
function harness(handler, storage = new Map()) {
  const nodes = new Map(), calls = [];
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', textContent: '', innerHTML: '', hidden: false,
      classList: { add() {}, remove() {} } });
    return nodes.get(id);
  };
  const context = { window:{PipeChatInspector:require('../public/inspector-core.js'),PipeChatTodo:require('../public/todo-core.js'),PipelineCore: core, PipeChatIcons: {}, confirm: () => true },
    document: { getElementById: node, querySelectorAll: () => [], querySelector:()=>null, body: { classList: { add() {}, remove() {} } } },
    sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    fetch: async (url, options) => { calls.push({ url, options }); return handler(url, options); } };
  const boot = '  wire();\n  restoreSession();'; assert(source.includes(boot));
  vm.runInNewContext(source.replace(boot, `
    render=()=>{};renderTable=()=>{};say=()=>{};toast=()=>{};
    window.test={S,manualEdit,reviewFailedEdit,retryFailedEdit,discardFailedEdit,restoreFailedEdit,renderFailedEdit,logout,loadWorkspace};`), context);
  const h = context.window.test;
  Object.assign(h.S, { user: { id: 1, email: 'a@example.invalid', name: 'A' }, loaded: true,
    records: [structuredClone(row)], updatedAt: 'v1', health: { storageProvider: 'supabase' } });
  const edit = (value, field = 'value') => h.manualEdit({ value, dataset: { field }, closest: () => ({ dataset: { id: '1' } }) });
  return { ...h, node, edit, calls, storage };
}
const response = (status, payload) => ({ ok: status < 400, status, json: async () => payload });
const offline = () => response(503, { error: 'Synthetic outage' });

test('failed inline save retains exact draft and leaves displayed saved records unchanged', async () => {
  const h = harness(offline); await h.edit('$9,999');
  assert.equal(h.S.failedEdit.raw, '$9,999'); assert.equal(h.S.failedEdit.reviewed, false);
  assert.equal(h.S.records[0].value, 25); assert.equal(h.node('saveStatus').textContent, 'Unsaved edit retained');
  assert.equal(h.calls.length, 1); await h.retryFailedEdit(); assert.equal(h.calls.length, 1);
  h.renderFailedEdit(); assert(h.node('trustBody').innerHTML.includes('Confirm retry'));
});
test('same-user reload retains draft; other user or provider never sees it', async () => {
  const first = harness(offline); await first.edit('Retain <script> & notes\nline two', 'notes');
  const restored = harness(offline, first.storage); restored.restoreFailedEdit();
  assert.equal(restored.S.failedEdit.raw, first.S.failedEdit.raw);
  restored.renderFailedEdit(); assert(!restored.node('trustBody').innerHTML.includes('<script>'));
  restored.S.user = { id: 2, email: 'b@example.invalid' }; restored.S.failedEdit = null; restored.restoreFailedEdit();
  assert.equal(restored.S.failedEdit, null); assert.equal(first.storage.size, 0);
  const again = harness(offline); await again.edit('30');
  const provider = harness(offline, again.storage); provider.S.health.storageProvider = 'json'; provider.restoreFailedEdit();
  assert.equal(provider.S.failedEdit, null);
});
test('fresh review then explicit retry patches only intended field against latest version', async () => {
  let writes = 0;
  const h = harness((url, options) => {
    if (!options.method) return response(200, { deals: [{ ...row, owner: 'B', notes: 'New server note' }], updatedAt: 'v2' });
    if (++writes === 1) return response(409, { error: 'Conflict' });
    const body = JSON.parse(options.body); assert.equal(body.expectedUpdatedAt, 'v2');
    assert.equal(body.deals[0].owner, 'B'); assert.equal(body.deals[0].notes, 'New server note');
    assert.equal(body.deals[0].value, 9999); return response(200, { deals: body.deals, updatedAt: 'v3' });
  });
  await h.edit('9999'); await h.reviewFailedEdit(); assert.equal(writes, 1);
  assert.equal(h.S.failedEdit.reviewed, true); await h.retryFailedEdit();
  assert.equal(writes, 2); assert.equal(h.S.failedEdit, null); assert.equal(h.storage.size, 0);
});
test('uncertain write already committed is recognized without replay', async () => {
  const h = harness((url, options) => options.method ? offline() : response(200, { deals: [{ ...row, value: 30 }], updatedAt: 'v2' }));
  await h.edit('30'); await h.reviewFailedEdit(); await h.retryFailedEdit();
  assert.equal(h.calls.filter(call => call.options.method === 'PUT').length, 1);
  assert.equal(h.S.failedEdit, null); assert.equal(h.node('saveStatus').textContent, 'Edit already saved');
});
test('deleted record is not recreated; failed refresh and repeated conflict retain draft', async () => {
  let mode = 'outage';
  const h = harness((url, options) => options.method ? response(409, { error: 'Conflict' }) : mode === 'outage' ? offline() : response(200, { deals: mode === 'deleted' ? [] : [row], updatedAt: 'v2' }));
  await h.edit('30'); await h.reviewFailedEdit(); assert.equal(h.S.failedEdit.reviewed, false);
  mode = 'deleted'; await h.reviewFailedEdit(); await h.retryFailedEdit(); assert.equal(h.calls.length, 3);
  mode = 'present'; await h.reviewFailedEdit(); await h.retryFailedEdit();
  assert.equal(h.S.failedEdit.raw, '30'); assert.equal(h.S.failedEdit.reviewed, false);
});
test('validation failure retains raw input without issuing a write', async () => {
  const h = harness(offline); await h.edit('not money');
  assert.equal(h.S.failedEdit.raw, 'not money'); assert.equal(h.calls.length, 0);
  h.discardFailedEdit(); assert.equal(h.S.failedEdit, null); assert.equal(h.storage.size, 0);
});
test('successful sign out clears retained draft storage', async () => {
  const h = harness((url) => url === '/api/auth/logout' ? response(200, {}) : offline());
  await h.edit('30'); await h.logout(); assert.equal(h.S.user, null); assert.equal(h.storage.size, 0);
});
test('late failed save cannot publish a previous user draft', async () => {
  let finish;
  const h = harness(() => new Promise(resolve => { finish = resolve; }));
  const saving = h.edit('30'); h.S.generation++; h.S.failedEdit = null;
  finish(offline()); await saving; assert.equal(h.S.failedEdit, null); assert.equal(h.storage.size, 0);
});
test('draft remains in memory when browser storage is unavailable', async () => {
  const storage = { set() { throw new Error('Quota'); }, get() { throw new Error('Blocked'); }, delete() {} };
  const h = harness(offline, storage); await h.edit('30'); assert.equal(h.S.failedEdit.raw, '30');
});
test('exhausted chat quota does not block manual draft recovery', async () => {
  let failed = false;
  const h = harness((url, options) => {
    if (!options.method) return response(200, { deals: [row], updatedAt: 'v2' });
    if (!failed) { failed = true; return offline(); }
    return response(200, { deals: JSON.parse(options.body).deals, updatedAt: 'v3' });
  });
  h.S.usage = { used: 1, limit: 1, remaining: 0, paymentRequired: true };
  await h.edit('30'); await h.reviewFailedEdit(); await h.retryFailedEdit();
  assert.equal(h.S.failedEdit, null); assert.equal(h.S.records[0].value, 30);
  assert.equal(h.S.usage.used, 1); assert(h.calls.every(call => call.url === '/api/crm-data'));
});
test('temporary missing health response does not delete a stored same-user draft', async () => {
  const h = harness(offline); await h.edit('30'); const restarted = harness(offline, h.storage);
  restarted.S.health = null; restarted.restoreFailedEdit(); assert.equal(h.storage.size, 1);
  restarted.S.health = { storageProvider: 'supabase' }; restarted.restoreFailedEdit();
  assert.equal(restarted.S.failedEdit.raw, '30');
});
