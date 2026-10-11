'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const Business = require('../public/business-workspace');
const Inspector = require('../public/inspector-core');
const source = fs.readFileSync(require.resolve('../public/pipechat'), 'utf8').replace(/\r\n/g, '\n');
const inspectorSource = fs.readFileSync(require.resolve('../public/inspector-ui'), 'utf8');
const draftKey = 'pipechat.inspector-drafts.v1';
const user = id => ({ id, name: 'QA ' + id, email: id + '@example.invalid' });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Minimal DOM for the real inspector and business panels; no browser or network.
class Element {
  constructor(tag, document) {
    this.tagName = tag; this.ownerDocument = document; this.nodeType = 1;
    this.children = []; this.parentNode = null; this.dataset = {}; this.attributes = {};
    this.handlers = {}; this.disabled = false; this.open = false;
    this.classList = { add() {}, remove() {}, toggle() {} };
    this._text = ''; this._html = ''; this.value = '';
  }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set innerHTML(value) { this.replaceChildren(); this._html = String(value); }
  get innerHTML() { return this._html; }
  get isConnected() { return this.root === true || Boolean(this.parentNode?.isConnected); }
  append(...children) {
    for (const child of children) { child.remove(); child.parentNode = this; this.children.push(child); }
  }
  replaceChildren(...children) {
    for (const child of this.children) child.parentNode = null;
    this.children = []; this._text = ''; this._html = ''; this.append(...children);
  }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = null;
  }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  addEventListener(name, handler) { (this.handlers[name] ||= []).push(handler); }
  async fire(name) {
    const event = { target: this, preventDefault() {} };
    for (const handler of this.handlers[name] || []) await handler(event);
    if (this['on' + name]) await this['on' + name](event);
  }
  querySelectorAll(selector) {
    const matches = element => selector === '[data-business-status]' ? Object.hasOwn(element.dataset, 'businessStatus') :
      selector.split(',').includes(element.tagName);
    return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() {}
}

function harness({ storage = new Map(), handler, inspector = {} } = {}) {
  const nodes = new Map();
  const document = { createElement: tag => new Element(tag, document), querySelectorAll: () => [],
    body: { classList: { add() {}, remove() {} } } };
  const node = id => {
    if (!nodes.has(id)) { const element = document.createElement(id.endsWith('Dialog') ? 'dialog' : 'div'); element.root = true; nodes.set(id, element); }
    return nodes.get(id);
  };
  document.getElementById = node;
  const window = { PipelineCore: require('../public/pipeline-core'), PipeChatSchema: require('../public/table-schema'),
    PipeChatTodo: require('../public/todo-core'), PipeChatInspector: Inspector, PipeChatIcons: {},
    PipeChatBusinessWorkspaceUI: require('../public/business-workspace-ui'), addEventListener() {} };
  const defaultApi = async path => {
    if (path === '/api/crm-data') return { deals: [{ id: 1, account: 'Account ' + window.test.S.user.id, history: [] }],
      customFields: [], todoCards: [], tableSchema: null, updatedAt: 'v1' };
    if (path === '/api/health') return { storageProvider: 'json' };
    if (path === '/api/chat-usage' || path === '/api/auth/logout') return {};
    if (path === '/api/crm-reset') return { deals: [], customFields: [], tableSchema: { status: 'pending' }, updatedAt: 'v2' };
    throw new Error('Unexpected offline API call: ' + path);
  };
  let apiHandler = handler || defaultApi;
  const context = { window, document, crypto, Intl, Date, TextEncoder, setTimeout, clearTimeout, inspector,
    handler: (...args) => apiHandler(...args),
    sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) } };
  vm.runInNewContext(inspectorSource, context);
  const hook = '  wire();\n  restoreSession();'; assert(source.includes(hook));
  vm.runInNewContext(source.replace(hook, `
    render=()=>{};say=()=>{};updateUsage=()=>{};syncShareFields=()=>{};
    loadChat=async()=>true;restoreDurableUndo=async()=>{};api=handler;
    inspectorUI=window.PipeChatInspectorUI.create({S,esc,icon:()=>'',rowName:r=>r.account,clearActivity,
      persist:async()=>false,refresh:async()=>{},editRecord:async()=>false,toast:()=>{},...inspector});
    businessUI=window.PipeChatBusinessWorkspaceUI.mount({element:$('businessContent'),
      api:{read:id=>api('/api/business/workspace'+(id?'?workspaceId='+encodeURIComponent(id):'')),
        commit:async()=>{throw new Error('Unexpected business write');}}});
    window.test={S,loadWorkspace,loadBusinessView,logout,openResetDialog,resetWorkspace,inspectorUI,businessUI,
      getLoading:()=>businessLoading};`), context);
  return { ...window.test, node, storage, defaultApi, setHandler: next => { apiHandler = next; } };
}

async function enterNote(h, text = 'Private A note') {
  h.inspectorUI.open(1); h.node('inspectorNote').value = text; await h.node('inspectorNote').fire('input');
  return h.storage.get(draftKey);
}

test('same-account loadWorkspace restores a persisted inspector note after startup and reload', async () => {
  const first = harness(); await first.loadWorkspace(user('A'));
  const saved = await enterNote(first);
  const fresh = harness({ storage: first.storage });
  assert.equal(fresh.S.user, null);
  await fresh.loadWorkspace(user('A'));
  assert.equal(fresh.S.loaded, true); assert.equal(fresh.storage.get(draftKey), saved);
  fresh.inspectorUI.open(1);
  assert.equal(fresh.node('inspectorNote').value, 'Private A note');
  assert.equal(fresh.node('inspectorNoteStatus').textContent, 'Unsaved draft restored');
  await fresh.loadWorkspace(user('A'));
  assert.equal(fresh.node('inspectorDialog').open, false); assert.equal(fresh.node('inspectorNote').value, '');
  fresh.inspectorUI.open(1); assert.equal(fresh.node('inspectorNote').value, 'Private A note');
});

test('failed same-account load and retry do not discard the persisted note', async () => {
  const h = harness(); await h.loadWorkspace(user('A')); const saved = await enterNote(h);
  h.setHandler(async () => { throw new Error('Offline'); }); await h.loadWorkspace(user('A'));
  assert.equal(h.S.loaded, false); assert.equal(h.node('inspectorDialog').open, false);
  assert.equal(h.node('inspectorNote').value, ''); assert.equal(h.storage.get(draftKey), saved);
  h.setHandler(h.defaultApi); await h.loadWorkspace(user('A')); h.inspectorUI.open(1);
  assert.equal(h.node('inspectorNote').value, 'Private A note');
});

test('account switch clears inspector UI immediately and never restores another identity draft', async () => {
  const h = harness(); await h.loadWorkspace(user('A'));
  h.S.records = Inspector.addNote(h.S.records, 1, 'Private A history', 'A', 'note-1');
  const saved = await enterNote(h);
  await h.node('inspectorEditName').fire('click');
  h.node('inspectorNameInput').value = 'Private A name draft';
  const pending = deferred(); h.setHandler(path => path === '/api/crm-data' ? pending.promise : h.defaultApi(path));
  const loading = h.loadWorkspace(user('B'));
  assert.equal(h.node('inspectorDialog').open, false);
  for (const id of ['inspectorTitle', 'inspectorRecordType', 'inspectorTimeline', 'inspectorNoteStatus', 'inspectorError', 'inspectorNameLabel', 'inspectorNameError']) {
    assert.equal(h.node(id).textContent, '', id); assert.equal(h.node(id).innerHTML, '', id);
  }
  assert.equal(h.node('inspectorNote').value, ''); assert.equal(h.node('inspectorNote').placeholder, '');
  assert.equal(h.node('inspectorNameInput').value, ''); assert.equal(h.storage.get(draftKey), saved);
  pending.resolve(await h.defaultApi('/api/crm-data')); await loading;
  h.inspectorUI.open(1); assert.equal(h.node('inspectorTitle').textContent, 'Account B');
  assert.equal(h.node('inspectorNote').value, ''); assert.doesNotMatch(h.node('inspectorTimeline').innerHTML, /Private A/);
});

test('draft restoration requires matching email and storage provider as well as user ID', async () => {
  const h = harness(); await h.loadWorkspace(user('A')); await enterNote(h);
  for (const [account, provider] of [[{ ...user('A'), email: 'different@example.invalid' }, 'json'], [user('A'), 'supabase']]) {
    const fresh = harness({ storage: h.storage });
    fresh.setHandler(path => path === '/api/health' ? { storageProvider: provider } : fresh.defaultApi(path));
    await fresh.loadWorkspace(account); fresh.inspectorUI.open(1);
    assert.equal(fresh.node('inspectorNote').value, '');
  }
});

for (const operation of ['logout', 'reset']) {
  test(`explicit ${operation} still removes persisted and rendered inspector drafts`, async () => {
    const h = harness(); await h.loadWorkspace(user('A')); await enterNote(h);
    if (operation === 'logout') { await h.logout(); assert.equal(h.S.user, null); }
    else { h.S.settingsOpen = true; h.openResetDialog(); await h.resetWorkspace(); assert.equal(h.S.tableSchema.status, 'pending'); }
    assert.equal(h.storage.has(draftKey), false); assert.equal(h.node('inspectorDialog').open, false);
    assert.equal(h.node('inspectorNote').value, ''); assert.equal(h.node('inspectorTimeline').innerHTML, '');
  });
}

for (const operation of ['save', 'refresh']) {
  test(`late inspector ${operation} failure cannot repopulate the next account's error UI`, async () => {
    const response = deferred();
    const h = harness({ inspector: { [operation === 'save' ? 'persist' : 'refresh']: () => response.promise } });
    await h.loadWorkspace(user('A')); await enterNote(h);
    const pending = h.node(operation === 'save' ? 'inspectorForm' : 'inspectorReload').fire(operation === 'save' ? 'submit' : 'click');
    await h.loadWorkspace(user('B')); h.inspectorUI.open(1);
    response.reject(new Error('Private A failure')); await pending;
    assert.equal(h.node('inspectorError').textContent, ''); assert.equal(h.node('inspectorNote').value, '');
    assert.equal(h.node('inspectorTitle').textContent, 'Account B');
  });
}

function businessSnapshot(workspaceId, name) {
  return { workspaceId, version: 0, role: 'owner', scope: 'workspace', state: Business.empty(),
    access: { memberships: [], grants: [] }, primary: { updatedAt: null, customFields: [],
      tableSchema: { title: 'Records', fields: [{ id: 'name', name: 'Name', type: 'text', role: 'primary' }] },
      records: [{ recordId: 1, entityId: Business.legacyId(workspaceId, 1), values: { name } }] } };
}

for (const fail of [false, true]) for (const oldFirst of [false, true]) {
  test(`real business panel discards late second-read ${fail ? 'failure' : 'success'} ${oldFirst ? 'before' : 'after'} new account data`, async () => {
    const a = businessSnapshot('00000000-0000-4000-8000-000000000001', 'PRIVATE A');
    const b = businessSnapshot('00000000-0000-4000-8000-000000000002', 'Current B');
    const oldRead = deferred(), newRead = deferred(), reachedOld = deferred(), reachedNew = deferred();
    const h = harness(); await h.loadWorkspace(user('A')); h.businessUI.setSnapshot(a);
    h.setHandler(path => {
      if (path === '/api/business/workspaces') {
        const snapshot = h.S.user.id === 'A' ? a : b;
        return { workspaces: [{ workspaceId: snapshot.workspaceId, role: 'owner', title: snapshot === a ? 'PRIVATE A' : 'Current B' }] };
      }
      if (path === '/api/business/workspace') {
        if (h.S.user.id === 'A') { reachedOld.resolve(); return oldRead.promise; }
        reachedNew.resolve(); return newRead.promise;
      }
      return h.defaultApi(path);
    });
    h.S.tab = 'entities'; const oldLoad = h.loadBusinessView(); await reachedOld.promise;
    await h.loadWorkspace(user('B'));
    assert.equal(h.businessUI.getSnapshot(), null); assert.equal(h.node('businessWorkspace').innerHTML, '');
    assert.doesNotMatch(h.node('businessContent').textContent, /PRIVATE A/);
    h.S.tab = 'entities'; const newLoad = h.loadBusinessView(); await reachedNew.promise;
    const finishOld = async () => {
      if (fail) oldRead.reject(Object.assign(new Error('PRIVATE A failure'), { status: 403 })); else oldRead.resolve(a);
      await oldLoad;
    };
    if (oldFirst) {
      await finishOld(); assert.equal(h.getLoading(), true); assert.equal(h.businessUI.getSnapshot(), null);
      assert.equal(h.node('businessStatus').textContent, 'Loading...');
    }
    newRead.resolve(b); await newLoad;
    if (!oldFirst) await finishOld();
    assert.equal(h.getLoading(), false); assert.equal(h.S.ownBusinessWorkspaceId, b.workspaceId);
    assert.equal(h.businessUI.getSnapshot().workspaceId, b.workspaceId);
    assert.equal(h.node('businessWorkspace').value, b.workspaceId); assert.equal(h.node('businessStatus').textContent, '');
    assert.match(h.node('businessContent').textContent, /Current B/);
    assert.doesNotMatch(h.node('businessContent').textContent + h.node('businessWorkspace').innerHTML, /PRIVATE A/);
  });
}
