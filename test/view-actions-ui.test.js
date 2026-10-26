'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Core = require('../public/business-workspace');
const UI = require('../public/business-workspace-ui');
const Papa = require('../public/vendor/papaparse.min');
const workspaceId = '11111111-1111-4111-8111-111111111111';
const viewId = 'view_22222222-2222-4222-8222-222222222222';
const timestamp = '2026-10-26T12:00:00.000Z';
const plain = value => JSON.parse(JSON.stringify(value));
const savedSelection = {source:'saved_view', viewId};
const saveAction = () => ({action:'save_view',name:'Literal > 999999',selection:{source:'visible'}});
const openAction = () => ({action:'open_view',selection:savedSelection});
const exportAction = () => ({action:'export_records',selection:savedSelection,columns:{source:'all'},format:'csv'});
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise,resolve,reject}; }

// The same small DOM surface as the existing form-state tests; no browser or I/O.
class Element {
  constructor(tag, document) {
    Object.assign(this, {tagName:tag,ownerDocument:document,nodeType:1,children:[],parentNode:null,dataset:{},attributes:{},handlers:{},
      disabled:false,checked:false,open:false,_text:'',_value:undefined,classList:{add() {},toggle() {}}});
  }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set value(value) { this._value = String(value); }
  get value() { return this.tagName === 'select' ? this._value === undefined ? this.children[0]?.value || '' :
    this.children.some(child => child.value === this._value) ? this._value : '' : this._value || ''; }
  get selectedOptions() { return this.children.filter(option => option.value === this.value); }
  get isConnected() { return this.root === true || Boolean(this.parentNode?.isConnected); }
  append(...children) { for (const child of children) { child.remove(); child.parentNode = this; this.children.push(child); } }
  replaceChildren(...children) { for (const child of this.children) child.parentNode = null; this.children = []; this._text = ''; this.append(...children); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  addEventListener(name, handler) { (this.handlers[name] ||= []).push(handler); }
  async fire(name) { const event = {target:this,preventDefault() {}}; for (const handler of this.handlers[name] || []) await handler(event); if (this['on' + name]) await this['on' + name](event); }
  querySelectorAll(selector) {
    const matches = child => selector === '[data-business-status]' ? Object.hasOwn(child.dataset, 'businessStatus') : selector.split(',').includes(child.tagName);
    return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  click() { if (this.ownerDocument.clickFailure) throw new Error('Download click failed'); this.ownerDocument.clicked.push({href:this.href,download:this.download}); }
}
function harness(options = {}) {
  const columns = [{id:'f_name',name:'Name',type:'text',role:'primary',options:[]}, {id:'f_amount',name:'Amount',type:'number',role:'none',options:[]},
    {id:'f_notes',name:'Notes',type:'text',role:'none',options:[]}];
  const records = [{id:1,f_name:'First',f_amount:0,f_notes:''},{id:2,f_name:'Second',f_amount:25,f_notes:'hidden row'},
    {id:3,f_name:'Third',f_amount:null,f_notes:'=1+1'}];
  const seed = {workspaceId,version:1,scope:'workspace',role:'owner',state:{...Core.empty(),
    views:[{id:viewId,name:'Saved order',entityIds:[3,1].map(id => Core.legacyId(workspaceId,id))}]},
    primary:{updatedAt:timestamp,customFields:[],tableSchema:{status:'ready',useCase:'Other',title:'Rows',recordLabel:'Row',description:'',fields:columns},
      records:records.map(({id,...values}) => ({recordId:id,entityId:Core.legacyId(workspaceId,id),values}))},
    access:{memberships:[],grants:[{scope:'view',resourceId:viewId,email:'existing@example.invalid'}]}};
  const context = {workspaceId,records,visibleIds:[2,1],columns,revision:'account1:revision1',primaryUpdatedAt:timestamp};
  const document = {clicked:[], createElement:tag => new Element(tag, document)}, element = document.createElement('main'); element.root = true;
  const commits = [], shares = [], opens = [], confirmations = [], changes = [];
  let stored = plain(seed);
  const api = {read:async () => plain(stored), commit:async prepared => {
    commits.push(plain(prepared)); if (options.commit) return options.commit(prepared);
    stored = {...stored,version:stored.version + 1,state:plain(prepared.next)}; return plain(stored);
  }, share:(...args) => { shares.push(args); throw new Error('No sharing is allowed'); }, revoke:(...args) => { shares.push(args); throw new Error('No revocation is allowed'); }};
  const ui = UI.mount({element,api,confirm:async message => { confirmations.push(message); return options.confirm ? options.confirm(message) : true; },
    onChange:value => changes.push(value), getViewContext:options.noContext ? undefined : args => {
      assert.equal(args.workspaceId, workspaceId); return options.context ? options.context(context) : context;
    }, onOpenView:options.noOpen ? undefined : async (patch, guard) => {
      opens.push({patch:plain(patch),guard});
      if (options.open) return options.open(patch, guard);
      assert.equal(guard.workspaceId,workspaceId); assert.equal(guard.isCurrent(),true);
      context.visibleIds = [...patch.filter.ids]; return {applied:true,visibleIds:[...context.visibleIds]};
    }});
  ui.setSnapshot({...seed,...options.seed});
  function button(label) { const result = element.querySelectorAll('button').find(b => b.attributes['aria-label'] === label); assert(result, 'Missing button: ' + label); return result; }
  function control(label) { const dialog = element.querySelector('dialog') || element;
    const caption = dialog.querySelectorAll('label').find(item => item.textContent === label); assert(caption, 'Missing label: ' + label);
    return dialog.querySelectorAll('input,select,textarea').find(item => item.id === caption.htmlFor); }
  return {ui,api,seed,context,element,document,commits,shares,opens,confirmations,changes,button,control,
    submit:() => element.querySelector('form').fire('submit')};
}
function downloads(t) {
  const blobs = new Map(), revoked = [], timers = new Map(); let sequence = 0;
  t.mock.method(URL,'createObjectURL',blob => { const url = 'blob:test-' + ++sequence; blobs.set(url,blob); return url; });
  t.mock.method(URL,'revokeObjectURL',url => { revoked.push(url); blobs.delete(url); });
  t.mock.method(globalThis,'setTimeout',callback => { const id = ++sequence; timers.set(id,callback); return id; });
  t.mock.method(globalThis,'clearTimeout',id => timers.delete(id));
  return {blobs,revoked,timers};
}

test('correct served HTML loads each view dependency once and before its consumer', () => {
  const html = fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');
  const scripts = [...html.matchAll(/<script defer src="([^"]+)"/g)].map(match => match[1]);
  for (const file of ['/business-workspace.js','/vendor/papaparse.min.js','/view-actions.js','/business-workspace-ui.js']) assert.equal(scripts.filter(value => value === file).length,1);
  assert(scripts.indexOf('/business-workspace.js') < scripts.indexOf('/view-actions.js'));
  assert(scripts.indexOf('/vendor/papaparse.min.js') < scripts.indexOf('/view-actions.js'));
  assert(scripts.indexOf('/view-actions.js') < scripts.indexOf('/business-workspace-ui.js'));
  assert(scripts.indexOf('/business-workspace-ui.js') < scripts.findIndex(file => file.startsWith('/pipechat.js')));
});

test('prepare is inert; save confirms exact static visible IDs and verifies one existing CAS', async () => {
  const h = harness(), original = plain(h.seed), preview = h.ui.prepareViewAction(saveAction());
  assert.equal(h.commits.length,0); assert.equal(h.confirmations.length,0);
  assert.deepEqual(preview.selection.recordIds,[2,1]);
  preview.count = 999; preview.view.entityIds = []; preview.commands = [];
  const result = await h.ui.saveView(preview);
  assert.equal(result.status,'saved'); assert.equal(result.count,2);
  assert.equal(h.commits.length,1); assert.equal(h.commits[0].expectedVersion,1); assert.equal(h.commits[0].expectedPrimaryUpdatedAt,timestamp);
  assert.deepEqual(h.commits[0].next.views.at(-1).entityIds,[2,1].map(id => Core.legacyId(workspaceId,id)));
  assert.match(h.confirmations[0],/2 records in this order/); assert.match(h.confirmations[0],/not filter rules/);
  assert.match(result.message,/Saved/); assert.equal(h.changes.length,1); assert.deepEqual(h.shares,[]);
  assert.deepEqual(h.ui.getSnapshot().access,original.access); assert.deepEqual(h.seed,original);
  await assert.rejects(() => h.ui.saveView(preview),/no longer current/);
});

test('save confirmation cancellation, double submission and stale visible order never commit', async () => {
  const cancel = harness({confirm:() => false});
  assert.deepEqual(await cancel.ui.saveView(saveAction()),{status:'cancelled'}); assert.equal(cancel.commits.length,0);
  const waiting = deferred(), h = harness({confirm:() => waiting.promise});
  const pending = h.ui.saveView(saveAction());
  await assert.rejects(() => h.ui.saveView(saveAction()),/Wait/);
  h.context.visibleIds.reverse(); waiting.resolve(true);
  await assert.rejects(() => pending,/order changed/); assert.equal(h.commits.length,0);
  assert.equal(h.element.querySelector('section').attributes['aria-busy'],'false');
});

test('all data/column/account revisions and primary timestamp changes invalidate a prepared action', async () => {
  for (const change of [h => h.context.revision = 'account2:revision1', h => h.context.primaryUpdatedAt = 'new',
    h => h.context.workspaceId = '33333333-3333-4333-8333-333333333333', h => h.context.columns.reverse(),
    h => h.context.records.pop(), h => h.ui.setSnapshot(h.seed)]) {
    const h = harness(), prepared = h.ui.prepareViewAction(saveAction()); change(h);
    await assert.rejects(() => h.ui.saveView(prepared)); assert.equal(h.commits.length,0); assert.equal(h.confirmations.length,0);
  }
});

test('new view methods are owner-only and reject missing integration or forged metadata actions', async () => {
  for (const seed of [{role:'editor'}, {role:'viewer'}, {role:'viewer',scope:'shared'}]) {
    const h = harness({seed});
    for (const action of [saveAction(),openAction(),exportAction()]) await assert.rejects(() => h.ui.handleViewAction(action),/owner workspace/);
    assert.deepEqual(h.shares,[]); assert.equal(h.commits.length,0);
  }
  const h = harness({noContext:true}); await assert.rejects(() => h.ui.saveView(saveAction()),/context callback/);
  const noOpen = harness({noOpen:true}); await assert.rejects(() => noOpen.ui.openView(openAction()),/open callback/);
  for (const action of [null,{action:'constructor'},{action:'share_view'},{action:'revoke'}]) await assert.rejects(() => h.ui.handleViewAction(action),/Unsupported/);
});

test('save rejects incomplete, wrong-version, changed-primary or grant-changing CAS receipts', async () => {
  for (const modify of [result => result.version--, result => result.state.views.pop(), result => result.primary.records[0].values.f_name = 'Changed',
    result => result.access.grants.push({scope:'view',resourceId:'new',email:'bad@example.invalid'}), result => result.workspaceId = '33333333-3333-4333-8333-333333333333']) {
    let h; h = harness({commit:prepared => { const result = {...plain(h.seed),version:2,state:plain(prepared.next)}; modify(result); return result; }});
    await assert.rejects(() => h.ui.saveView(saveAction()));
    assert.deepEqual(h.ui.getSnapshot(),h.seed); assert.equal(h.changes.length,0); assert.doesNotMatch(h.element.textContent,/Saved "/);
  }
});

test('save accepts equivalent JSON key ordering from the database, and failed CAS keeps the form draft', async () => {
  let h; h = harness({commit:prepared => JSON.parse(JSON.stringify({...h.seed,version:2,state:prepared.next}), (key,value) =>
    value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).reverse()) : value)});
  assert.equal((await h.ui.saveView(saveAction())).status,'saved');
  const failed = harness({commit:() => { throw Object.assign(new Error('Workspace changed; reload'),{status:409}); }});
  failed.ui.show('Sharing'); await failed.button('Save current table view').fire('click'); failed.control('View name').value = 'Keep draft';
  await failed.submit(); assert.match(failed.element.querySelector('form').textContent,/Workspace changed/);
  assert.equal(failed.control('View name').value,'Keep draft'); assert.equal(failed.button('Save view').disabled,false);
});

test('clear/destroy invalidates pending confirmations and late save receipts without private notices', async () => {
  for (const kind of ['confirmation','commit']) for (const lifecycle of ['clear','destroy']) {
    const pending = deferred(); const options = kind === 'confirmation' ? {confirm:() => pending.promise} : {commit:() => pending.promise};
    const h = harness(options), work = h.ui.saveView(saveAction());
    await new Promise(resolve => setImmediate(resolve));
    h.ui[lifecycle]();
    pending.resolve(kind === 'confirmation' ? true : {...h.seed,version:2,state:h.commits[0].next});
    assert.deepEqual(await work,{status:'stale'}); assert.equal(h.changes.length,0);
    assert.doesNotMatch(h.element.textContent,/Saved "Literal/); assert.equal(h.commits.length,kind === 'commit' ? 1 : 0);
  }
});

test('open callback receives the exact patch and cannot report success until actual IDs/order match', async () => {
  const h = harness(), before = plain(h.seed), result = await h.ui.handleViewAction(openAction());
  assert.equal(result.status,'applied'); assert.equal(result.visibleCount,2); assert.deepEqual(result.recordIds,[3,1]);
  assert.deepEqual(h.opens[0].patch,{scope:'all',search:'',filter:{where:[],ids:[3,1]},sort:null});
  assert.equal(h.commits.length,0); assert.equal(h.confirmations.length,0); assert.deepEqual(h.shares,[]); assert.deepEqual(h.ui.getSnapshot(),before);
  for (const receipt of [undefined, {applied:false,visibleIds:[3,1]}, {applied:true,visibleIds:[1,3]}, {applied:true,visibleIds:[3]}, {applied:true,visibleCount:2}]) {
    const invalid = harness({open:() => receipt}); await assert.rejects(() => invalid.ui.openView(openAction()),/not applied/);
    assert.doesNotMatch(invalid.element.textContent,/Opened "/);
  }
});

test('open guard stops a delayed parent apply after table changes, clear, or destroy', async () => {
  for (const invalidate of [h => h.context.revision = 'new', h => h.ui.clear(), h => h.ui.destroy()]) {
    const wait = deferred(); let applied = false;
    const h = harness({open:async (patch, guard) => { await wait.promise; if (!guard.isCurrent()) return {applied:false,visibleIds:[]}; applied = true; return {applied:true,visibleIds:patch.filter.ids}; }});
    const work = h.ui.openView(openAction()); invalidate(h); wait.resolve();
    try { const result = await work; assert.equal(result.status,'stale'); } catch (error) { assert.match(error.message,/changed/); }
    assert.equal(applied,false); assert.doesNotMatch(h.element.textContent,/Opened "/);
  }
});

test('open authorization failures clear private data and restore usable controls', async () => {
  const h = harness({open:() => { throw Object.assign(new Error('Revoked'),{status:403}); }});
  await assert.rejects(() => h.ui.openView(openAction()),/Revoked/);
  assert.equal(h.ui.getSnapshot(),null); assert.equal(h.button('Reload workspace').disabled,false);
  assert.doesNotMatch(h.element.textContent,/Third|Saved order/);
});

test('CSV creates an actual scoped UTF-8 Blob download, protects formula cells, and revokes URLs', async t => {
  const files = downloads(t), h = harness(), before = plain(h.seed);
  const result = await h.ui.handleViewAction(exportAction());
  assert.equal(result.status,'download_started'); assert.equal(result.count,2); assert.equal(result.protectedCellCount,1);
  assert.match(h.confirmations[0],/apostrophe/); assert.match(result.disclosure,/Anyone with the file/);
  assert.equal(h.document.clicked.length,1); const downloaded = h.document.clicked[0], blob = files.blobs.get(downloaded.href);
  assert.equal(downloaded.download,'pipechat-Saved-order.csv'); assert.equal(blob.type,'text/csv; charset=utf-8');
  const text = Buffer.from(await blob.arrayBuffer()).toString('utf8'); assert.equal(text[0],'\ufeff');
  assert.deepEqual(Papa.parse(text).data,[['Name','Amount','Notes'],['Third','',"'=1+1"],['First','0','']]);
  assert.deepEqual(h.ui.getSnapshot(),before); assert.equal(h.commits.length,0); assert.deepEqual(h.shares,[]);
  assert.equal(h.element.querySelectorAll('a').length,0);
  h.ui.clear(); assert.equal(files.blobs.size,0); assert.equal(files.timers.size,0); assert.deepEqual(files.revoked,[downloaded.href]);
});

test('CSV cancellation, stale confirmation, click failure and delayed expiry leave no false success or URL leak', async t => {
  const files = downloads(t), cancel = harness({confirm:() => false});
  assert.deepEqual(await cancel.ui.exportCsv(exportAction()),{status:'cancelled'}); assert.equal(files.blobs.size,0);
  const wait = deferred(), stale = harness({confirm:() => wait.promise}), work = stale.ui.exportCsv(exportAction());
  stale.context.columns.pop(); wait.resolve(true); await assert.rejects(() => work,/columns changed/); assert.equal(files.blobs.size,0);
  const failure = harness(); failure.document.clickFailure = true;
  await assert.rejects(() => failure.ui.exportCsv(exportAction()),/click failed/); assert.equal(files.blobs.size,0); assert.equal(files.timers.size,0);
  assert.doesNotMatch(failure.element.textContent,/download started/);
  const expiry = harness(); await expiry.ui.exportCsv(exportAction()); [...files.timers.values()][0]();
  assert.equal(files.blobs.size,0); assert.equal(files.timers.size,0);
});

test('saved-view row buttons and existing form events save, open and export selected columns without grants', async t => {
  const files = downloads(t), h = harness(); h.ui.show('Sharing');
  await h.button('Save current table view').fire('click'); h.control('View name').value = '<img src=x> literal name';
  h.control('Records').value = 'all'; await h.submit(); assert.equal(h.commits.length,1);
  assert.equal(h.ui.getSnapshot().state.views.at(-1).entityIds.length,3); assert.equal(h.element.querySelectorAll('img').length,0);
  await h.button('Open Saved order').fire('click'); assert.deepEqual(h.context.visibleIds,[3,1]);
  await h.button('Export Saved order as CSV').fire('click'); h.control('Columns').value = 'selected'; await h.control('Columns').fire('change');
  h.control('Amount').checked = false; h.control('Notes').checked = false; await h.submit();
  const blob = files.blobs.get(h.document.clicked[0].href);
  assert.deepEqual(Papa.parse(await blob.text()).data,[['Name'],['Third'],['First']]);
  assert.deepEqual(h.shares,[]); assert.equal(h.commits.length,1); h.ui.destroy(); assert.equal(files.blobs.size,0);
});

test('forms retain their original selection while open and reject zero columns without download', async t => {
  const files = downloads(t), h = harness(); h.ui.show('Sharing');
  await h.button('Save current table view').fire('click'); h.control('View name').value = 'Stale form'; h.context.visibleIds.reverse();
  await h.submit(); assert.match(h.element.querySelector('form').textContent,/order changed/); assert.equal(h.commits.length,0);
  await h.button('Cancel').fire('click'); await h.button('Export CSV').fire('click'); h.control('Columns').value = 'selected';
  for (const checkbox of h.element.querySelectorAll('input').filter(item => item.type === 'checkbox')) checkbox.checked = false;
  await h.submit(); assert.match(h.element.querySelector('form').textContent,/at least one/); assert.equal(files.blobs.size,0);
});
