'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const Core = require('../public/pipeline-core');
const Schema = require('../public/table-schema');
const Business = require('../public/business-workspace');
const UI = require('../public/business-workspace-ui');
const Views = require('../public/view-actions');
const Conversation = require('../lib/conversation-core');
const Papa = require('../public/vendor/papaparse.min');
const F = require('./fixtures/workspace-plans.cjs');
const workspaceId = '11111111-1111-4111-8111-111111111111';
const viewId = 'view_22222222-2222-4222-8222-222222222222';
const version = '2026-10-26T12:00:00.000Z';
const plain = value => JSON.parse(JSON.stringify(value));
const source = fs.readFileSync(require.resolve('../public/pipechat'), 'utf8').replace(/\r\n/g, '\n');
const serverSource = fs.readFileSync(require.resolve('../server'), 'utf8').replace(/\r\n/g, '\n');
const bindingStart = serverSource.indexOf('  const ai={...selectedRoute,workspaceVersion:pipeline.workspaceVersion};');
const bindingEnd = serverSource.indexOf('\n}\n\nconst savedKpiInstructions',bindingStart);
assert(bindingStart >= 0 && bindingEnd > bindingStart,'Server response-binding test markers changed');
// Run the actual final-return hunk without starting the HTTP server or any AI call.
const boundResponse = new Function('viewActions','pipeline','grounded','selectedRoute',serverSource.slice(bindingStart,bindingEnd));
const saved = {source:'saved_view',viewId};
const save = () => ({action:'save_view',name:'Literal > 100',selection:{source:'visible'}});
const open = () => ({action:'open_view',selection:saved});
const csv = () => ({action:'export_records',selection:saved,columns:{source:'selected',columnIds:['f_deal','f_value']},format:'csv'});
const pipeline = () => ({workspaceVersion:version,records:F.workspace().records,visibleIds:[3,1],
  business:{workspaceId,state:{views:[{id:viewId,name:'Saved order',entityIds:[3,1].map(id => Business.legacyId(workspaceId,id))}]}}});
const response = (action,context = pipeline()) => ({...boundResponse(Views,context,{crmAction:action},{}),turn:{status:'succeeded',epoch:'epoch',threadId:'thread'}});
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return {promise,resolve}; }

// Small DOM surface used by the existing form-state tests. No browser or network.
class Element {
  constructor(tag, document) {
    Object.assign(this,{tagName:tag,ownerDocument:document,children:[],dataset:{},attributes:{},handlers:{},value:'',_text:'',
      classList:{add() {},remove() {},toggle() {}}});
  }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  append(...children) { for (const child of children) { child.remove(); child.parentNode = this; this.children.push(child); } }
  replaceChildren(...children) { for (const child of this.children) child.parentNode = null; this.children = []; this._text = ''; this.append(...children); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; }
  setAttribute(key,value) { this.attributes[key] = String(value); }
  addEventListener(name,handler) { (this.handlers[name] ||= []).push(handler); }
  querySelectorAll(selector) {
    const matches = child => selector === '[data-business-status]' ? Object.hasOwn(child.dataset,'businessStatus') : selector.split(',').includes(child.tagName);
    return this.children.flatMap(child => [...(matches(child) ? [child] : []),...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  click() { if (this.ownerDocument.clickFailure) throw new Error('Download blocked'); this.ownerDocument.clicks.push({href:this.href,download:this.download}); }
}
function harness(t, options = {}) {
  const nodes = new Map(), calls = [], messages = [], states = [], confirmations = [], blobs = new Map(), revoked = [];
  const document = {clicks:[],createElement:tag => new Element(tag,document),getElementById:id => {
    if (!nodes.has(id)) nodes.set(id,document.createElement('div')); return nodes.get(id);
  }};
  const w = F.workspace();
  let stored = {workspaceId,version:7,role:'owner',scope:'workspace',access:{memberships:[],grants:[]},
    state:{...Business.empty(),views:[{id:viewId,name:'Saved order',entityIds:[3,1].map(id => Business.legacyId(workspaceId,id))}]},
    primary:{updatedAt:version,tableSchema:w.tableSchema,customFields:[],records:w.records.map(({id,...values}) => ({recordId:id,entityId:Business.legacyId(workspaceId,id),values}))}};
  const initial = plain(stored);
  const handler = async (url, request) => {
    const body = request?.body ? JSON.parse(request.body) : null; calls.push({url,method:request?.method || 'GET',body});
    assert.equal(url,'/api/business/workspace','View actions must not call sharing or primary-record endpoints');
    if (!body) return options.read ? options.read(plain(stored)) : plain(stored);
    assert.deepEqual(Object.keys(body).sort(),['expectedPrimaryUpdatedAt','expectedVersion','next','workspaceId']);
    if (options.commit) return options.commit(body,plain(stored));
    if (body.workspaceId !== stored.workspaceId || body.expectedVersion !== stored.version || body.expectedPrimaryUpdatedAt !== stored.primary.updatedAt) {
      throw Object.assign(new Error('CAS conflict'),{status:409});
    }
    Business.validate(body.next,{workspaceId,legacyRecordIds:stored.primary.records.map(row => row.recordId)});
    Business.transition(stored.state,body.next);
    stored = {...stored,version:stored.version + 1,state:body.next}; return plain(stored);
  };
  let callbacks, ui, timer = 0;
  t.mock.method(URL,'createObjectURL',blob => { const url = 'blob:integration-' + (blobs.size + 1); blobs.set(url,blob); return url; });
  t.mock.method(URL,'revokeObjectURL',url => { revoked.push(url); });
  t.mock.method(globalThis,'setTimeout',() => ++timer);
  t.mock.method(globalThis,'clearTimeout',() => {});
  const window = {PipelineCore:Core,PipeChatSchema:Schema,PipeChatIcons:{},PipeChatViewActions:Views,PipeChatReports:require('../public/report-engine'),
    PipeChatPlan:require('../public/workspace-plan'),PipeChatTodo:require('../public/todo-core'),
    PipeChatBusinessWorkspaceUI:{mount(value) { callbacks = value; ui = UI.mount({...value,confirm:async message => {
      confirmations.push(message); return options.confirm ? options.confirm(message) : true;
    }}); return ui; }}};
  // Execute the real mount expression inside the parent closure, without wiring unrelated UI.
  const start = source.indexOf('    businessUI=window.PipeChatBusinessWorkspaceUI.mount(');
  const end = source.indexOf("    $('businessWorkspace').onchange=",start);
  const startup = '  wire();\n  restoreSession();';
  assert(start >= 0 && end > start && source.includes(startup),'Parent integration test markers changed');
  vm.runInNewContext(source.replace(startup,`render=()=>{};renderTrust=()=>{};focusTrust=()=>{};updateUsage=()=>{};paintMessage=()=>{};toast=()=>{};api=handler;
    ${source.slice(start,end)}
    window.test={S,useSchema,handleAction,handleViewAction,acceptTurnResponse,reviewRestoredProposal,chatState,saveChatState,visible,
      restore(state){restoredProposal=state;},restored(){return restoredProposal;},connect(value){conversation=value;chatThread='thread';}};`),
  {window,document,crypto,handler,Intl,Date,TextEncoder,setTimeout,clearTimeout,sessionStorage:{removeItem() {},getItem() {return null;},setItem() {}}});
  const h = window.test; h.useSchema(w.tableSchema);
  Object.assign(h.S,{loaded:true,user:{id:'owner',name:'Owner'},records:plain(w.records),updatedAt:version,generation:1,revision:2,
    ownBusinessWorkspaceId:workspaceId,filter:{where:[],ids:[3,1]}});
  const conversation = {ready:true,add(role,content) { messages.push({role,content}); },state(state) { states.push(Conversation.validateState(plain(state))); },
    load:async () => ({epoch:'epoch',messages:[{role:'assistant',content:'Prepared only; no effect completed.'}],state:states.at(-1) || {}})};
  h.connect(conversation); t.after(() => ui.destroy());
  return {...h,ui,callbacks,document,calls,messages,states,confirmations,blobs,revoked,conversation,initial,
    stored:() => plain(stored),setStored:value => { stored = plain(value); },
    run:action => h.handleAction(response(action),'Requested view action'),
    durable:action => h.acceptTurnResponse(response(action),conversation,true,'Requested view action')};
}

test('parent save passes only business CAS fields and verifies ordered static storage without access changes',async t => {
  const h = harness(t); await h.run(save());
  const puts = h.calls.filter(call => call.method === 'PUT'); assert.equal(puts.length,1);
  assert.equal(puts[0].body.expectedVersion,7); assert.equal(puts[0].body.expectedPrimaryUpdatedAt,version);
  assert.deepEqual(h.stored().state.views.at(-1).entityIds,[3,1].map(id => Business.legacyId(workspaceId,id)));
  assert.deepEqual(h.stored().primary,h.initial.primary); assert.deepEqual(h.stored().access,h.initial.access);
  assert.equal(h.ui.getSnapshot().version,8); assert.match(h.messages.at(-1).content,/Saved.*2 records/);
  assert.equal(h.states.at(-1).sourceAction,null); assert.equal(h.document.clicks.length,0);
});

test('parent open applies saved IDs and order before reporting actual count and persists valid table focus',async t => {
  const h = harness(t); Object.assign(h.S,{scope:'mine',search:'no match',sort:{field:'f_deal',direction:'desc'}});
  await h.run(open());
  assert.deepEqual(plain(h.visible().map(row => row.id)),[3,1]); assert.equal(h.S.tab,'table');
  assert.equal(h.S.scope,'all'); assert.equal(h.S.search,''); assert.equal(h.S.sort,null);
  assert.equal(h.document.getElementById('dealSearch').value,'');
  assert.deepEqual(h.states.at(-1).tableView.visibleIds,[3,1]); assert.deepEqual(h.states.at(-1).focus,{kind:'table',ids:[3,1]});
  assert.match(h.messages.at(-1).content,/2 visible records/); assert.equal(h.calls.length,1);
});

test('parent export dispatches real CSV Blob bytes and a safe download filename, without any write',async t => {
  const h = harness(t); h.S.records[2].f_deal = '=1+1'; h.S.records[0].f_deal = 'Quote " and, newline\n\u00e9'; h.S.records[0].f_value = 0;
  await h.run(csv());
  assert.equal(h.document.clicks.length,1); const click = h.document.clicks[0], blob = h.blobs.get(click.href);
  assert(blob instanceof Blob); assert.equal(blob.type,'text/csv; charset=utf-8'); assert.match(click.download,/^[A-Za-z0-9_.-]+\.csv$/);
  const rows = Papa.parse(await blob.text()).data;
  assert.deepEqual(rows.slice(1),[["'=1+1",String(h.S.records[2].f_value)],['Quote " and, newline\n\u00e9','0']]);
  assert.equal(h.calls.length,1); assert.match(h.messages.at(-1).content,/CSV ready/i); assert.match(h.confirmations[0],/formula/i);
  const receipt = h.document.getElementById('businessContent').querySelector('dialog'), link = receipt.querySelector('a');
  assert.equal(receipt.open,true); assert.equal(link.textContent,'Download CSV'); assert.equal(link.href,click.href); assert.equal(link.download,click.download);
  assert.deepEqual(h.stored(),h.initial); h.ui.destroy(); assert.deepEqual(h.revoked,[click.href]);
});

test('parent columns match current core definitions, never inferred record metadata',async t => {
  const h = harness(t); h.useSchema(Schema.legacySchema());
  const context = h.callbacks.getViewContext({workspaceId});
  assert.deepEqual(plain(context.columns),Schema.orderedFields(Core.create(Schema.legacySchema()).definitions([]),undefined));
  assert(!context.columns.some(field => ['id','history','__proto__','constructor','prototype'].includes(field.id)));
  await h.run({...csv(),columns:{source:'all'}}); assert.equal(h.document.clicks.length,1);
});

test('stale primary response, unavailable owner context and changed data during read cause no effects',async t => {
  for (const failure of ['response','primary','revision','owner','workspace','saving']) {
    const gate = deferred(); const h = harness(t,{read:async value => { await gate.promise; return failure === 'primary' ? {...value,primary:{...value.primary,updatedAt:'new'}} : failure === 'owner' ? {...value,role:'viewer'} : value; }});
    const action = response(save()); if (failure === 'response') action.ai.workspaceVersion = 'old';
    if (failure === 'workspace') h.S.ownBusinessWorkspaceId = 'foreign';
    if (failure === 'saving') h.S.saving = true;
    const pending = h.handleAction(action,'Save');
    if (failure === 'revision') h.S.revision++;
    gate.resolve();
    if (failure === 'revision') await pending;
    else if (failure === 'workspace') await pending; // The authenticated owner read establishes the authoritative workspace ID.
    else await assert.rejects(pending);
    if (failure !== 'workspace') { assert.equal(h.confirmations.length,0); assert.equal(h.calls.filter(call => call.method === 'PUT').length,0); assert.equal(h.messages.length,0); }
  }
});

test('CAS conflict and unverified CAS receipt never produce a saved completion',async t => {
  for (const corrupt of [false,true]) {
    const h = harness(t,{commit:(body,current) => { if (corrupt) return {...current,version:current.version + 1}; throw Object.assign(new Error('CAS conflict'),{status:409}); }});
    await assert.rejects(h.run(save()),corrupt ? /not verified/ : /CAS conflict/);
    assert.equal(h.messages.length,0); assert.equal(h.states.length,0); assert.deepEqual(h.stored(),h.initial);
  }
});

test('confirmation rechecks visible order before committing and does not broaden selection',async t => {
  const gate = deferred(), entered = deferred(), h = harness(t,{confirm:() => { entered.resolve(); return gate.promise; }});
  const pending = h.run(save()); await entered.promise; h.S.filter.ids.reverse(); gate.resolve(true);
  await assert.rejects(pending,/changed|stale|selection/i); assert.equal(h.calls.filter(call => call.method === 'PUT').length,0);
  assert.equal(h.messages.length,0);
});

test('blocked automatic download offers a visible manual retry without claiming delivery or saving business data',async t => {
  const h = harness(t); h.document.clickFailure = true;
  await h.run(csv()); assert.equal(h.messages.length,1); assert.match(h.messages[0].content,/CSV ready/);
  assert.doesNotMatch(h.messages[0].content,/download started|downloaded|saved/i); assert.equal(h.document.clicks.length,0);
  const receipt = h.document.getElementById('businessContent').querySelector('dialog'), link = receipt.querySelector('a');
  assert.equal(receipt.open,true); h.document.clickFailure = false; link.click(); assert.equal(h.document.clicks.length,1);
  assert.equal(h.revoked.length,0); assert.equal(h.calls.length,1); assert.deepEqual(h.stored(),h.initial);
});

test('durable successful save adds the application receipt after the server preview',async t => {
  const h = harness(t); await h.durable(save());
  assert.equal(h.stored().version,8); assert.equal(h.messages.length,1);
  assert.match(h.messages[0].content,/Saved.*2 records/); assert.equal(h.states.at(-1).sourceAction,null);
});

test('durable cancellation is recorded without claiming a save or download',async t => {
  const h = harness(t,{confirm:() => false}); await h.durable(csv());
  assert.equal(h.document.clicks.length,0); assert.equal(h.calls.length,1);
  assert.equal(h.messages.length,1); assert.match(h.messages[0].content,/Cancelled/);
});

test('durable download receipt follows one real dispatch and leaves backend UI state valid',async t => {
  const h = harness(t); await h.durable(csv());
  assert.equal(h.document.clicks.length,1); assert.equal(h.messages.length,1);
  assert.match(h.messages[0].content,/CSV ready/i); assert.equal(h.states.at(-1).sourceAction,null);
  assert.equal(h.calls.length,1); assert.deepEqual(h.stored(),h.initial);
});

test('recovered export is inert until review, then uses the view dispatcher and download implementation',async t => {
  const h = harness(t); await h.acceptTurnResponse(response(csv()),h.conversation,false,'Export the saved view');
  assert.equal(h.calls.length,0); assert.equal(h.document.clicks.length,0); assert(h.restored());
  await h.reviewRestoredProposal();
  assert.equal(h.document.clicks.length,1); assert.equal(h.calls.length,1); assert.equal(h.restored(),null);
});

test('recovered visible action must retain the request selection rather than the changed current view',async t => {
  const h = harness(t); h.saveChatState();
  assert.deepEqual(h.states.at(-1).tableView.visibleIds,[3,1]);
  h.S.filter.ids = [2];
  await h.acceptTurnResponse(response(save()),h.conversation,false,'Save the original visible selection');
  assert.equal(h.calls.length,0);
  await h.reviewRestoredProposal();
  assert.equal(h.calls.filter(call => call.method === 'PUT').length,0,'Changed selection must require a fresh request, not save record 2');
  assert.match(h.messages.at(-1).content,/changed|repeat/i);
});

test('visible selection must not be rebound while the parent awaits its business read',async t => {
  const gate = deferred(), entered = deferred(), h = harness(t,{read:async value => { entered.resolve(); await gate.promise; return value; }});
  const pending = h.run(save()); await entered.promise; h.S.filter.ids = [2]; gate.resolve();
  await assert.rejects(pending,/changed|stale|view/i);
  assert.equal(h.calls.filter(call => call.method === 'PUT').length,0); assert.equal(h.messages.length,0);
});

test('server owns selection bindings for visible, all and saved scopes, independently of model metadata',() => {
  for (const selection of [{source:'visible'},{source:'all'},saved,{source:'saved_view',viewName:'Saved order'}]) {
    const context = pipeline(), before = plain(context), grounded = {crmAction:{...save(),selection},
      ai:{viewSelection:{workspaceId:'model',recordIds:[999],count:9000}},viewSelection:{recordIds:[999]}};
    const result = boundResponse(Views,context,grounded,{model:'test'});
    assert.deepEqual(result.ai.viewSelection,{...Views.resolveSelection(selection,{workspaceId,records:context.records,visibleIds:context.visibleIds,views:context.business.state.views}),workspaceVersion:version});
    assert.equal(result.ai.model,'test'); assert.deepEqual(context,before); assert.deepEqual(grounded.ai.viewSelection.recordIds,[999]);
    assert.notEqual(result.ai.viewSelection.recordIds,context.visibleIds);
    const roundTrip = Conversation.validateState({sourceAction:{resultReceipt:result}}).sourceAction.resultReceipt;
    assert.deepEqual(roundTrip.ai.viewSelection,result.ai.viewSelection);
  }
  const context = pipeline(); context.visibleIds = [];
  assert.deepEqual(response(save(),context).ai.viewSelection.recordIds,[]);
  context.business.state.views[0].entityIds.push(Business.legacyId(workspaceId,999));
  assert.throws(() => response(open(),context),/missing|accessible/i);
});

test('missing, mismatched and stale request bindings never fall back to current selection',async t => {
  for (const corrupt of [r => { delete r.ai.viewSelection; },r => { r.ai.viewSelection.workspaceVersion = 'old'; },
    r => { r.ai.viewSelection.workspaceId = '99999999-9999-4999-8999-999999999999'; },r => { r.ai.viewSelection.source = 'all'; },
    r => { r.ai.viewSelection.recordIds = [1,3]; },r => { r.ai.viewSelection.recordIds = [3,999]; }]) {
    const h = harness(t), reply = response(save()); corrupt(reply);
    await assert.rejects(h.handleAction(reply,'Save request'));
    assert.equal(h.calls.filter(call => call.method === 'PUT').length,0); assert.equal(h.confirmations.length,0); assert.equal(h.document.clicks.length,0);
  }
  const h = harness(t), reply = response(save()); delete reply.ai.viewSelection;
  await h.acceptTurnResponse(reply,h.conversation,false,'Old receipt'); await h.reviewRestoredProposal();
  assert.equal(h.calls.length,0); assert.match(h.messages.at(-1).content,/changed|repeat/);
});

test('recovery persists original visible order once and survives a JSON state round trip',async t => {
  const h = harness(t), reply = response(save()); h.S.filter.ids = [1,3];
  await h.acceptTurnResponse(reply,h.conversation,false,'Original order');
  const state = plain(h.states.at(-1)); assert.deepEqual(state.tableView.visibleIds,[3,1]);
  assert.equal(Object.hasOwn(state.tableView.viewSelection,'recordIds'),false);
  assert.equal(state.tableView.viewSelection.workspaceId,workspaceId); assert.equal(state.tableView.viewSelection.workspaceVersion,version);
  h.restore(state); await h.reviewRestoredProposal(); assert.equal(h.calls.length,0); assert.match(h.messages.at(-1).content,/changed/);
  const fresh = harness(t); fresh.restore(state); await fresh.reviewRestoredProposal();
  assert.equal(fresh.calls.filter(call => call.method === 'PUT').length,1);
  assert.deepEqual(fresh.stored().state.views.at(-1).entityIds,[3,1].map(id => Business.legacyId(workspaceId,id)));
});

test('visible export rejects changed membership AND same-count reordered IDs during reload',async t => {
  for (const ids of [[2],[1,3],[]]) {
    const gate = deferred(), entered = deferred(), h = harness(t,{read:async value => { entered.resolve(); await gate.promise; return value; }});
    const pending = h.run({...csv(),selection:{source:'visible'}}); await entered.promise;
    h.S.filter.ids = ids; gate.resolve(); await assert.rejects(pending,/changed/i);
    assert.equal(h.document.clicks.length,0); assert.equal(h.confirmations.length,0);
  }
});

test('saved-view requests reject membership/order changes, deletion and name reuse before confirmation',async t => {
  for (const change of [view => { view.entityIds.reverse(); },view => { view.entityIds[0] = Business.legacyId(workspaceId,2); },
    view => { view.entityIds = []; },view => { view.name = 'Renamed'; },view => { view.id = 'view_33333333-3333-4333-8333-333333333333'; }]) {
    const h = harness(t,{read:value => { change(value.state.views[0]); return value; }});
    await assert.rejects(h.run({...csv(),selection:{source:'saved_view',viewName:'Saved order'}}),/changed|missing|unavailable/i);
    assert.equal(h.document.clicks.length,0); assert.equal(h.confirmations.length,0); assert.equal(h.calls.length,1);
  }
});

test('recovered named-view selection keeps its stored ID and rejects later reuse of its name',async t => {
  const h = harness(t), reply = response({...csv(),selection:{source:'saved_view',viewName:'Saved order'}});
  await h.acceptTurnResponse(reply,h.conversation,false,'Export saved view');
  assert.equal(h.states.at(-1).tableView.viewSelection.viewId,viewId);
  const current = h.stored(); current.state.views[0].id = 'view_33333333-3333-4333-8333-333333333333'; h.setStored(current);
  await h.reviewRestoredProposal(); assert.equal(h.document.clicks.length,0); assert.equal(h.confirmations.length,0);
  assert.match(h.messages.at(-1).content,/missing|unavailable/);
});

test('empty captured visible selection remains empty, not all, after recovery and confirmation',async t => {
  const h = harness(t), context = pipeline(); context.visibleIds = []; h.S.filter.ids = [];
  await h.acceptTurnResponse(response(save(),context),h.conversation,false,'Save empty view'); await h.reviewRestoredProposal();
  assert.deepEqual(h.stored().state.views.at(-1).entityIds,[]); assert.match(h.messages.at(-1).content,/0 records/);
});

test('all-record bindings reject changed order and missing IDs without an effects path',async t => {
  for (const mutate of [records => records.reverse(),records => records.pop()]) {
    const h = harness(t), reply = response({...csv(),selection:{source:'all'}}); mutate(h.S.records);
    await assert.rejects(h.handleAction(reply,'Export all'),/changed|missing|accessible/i);
    assert.equal(h.calls.length,0); assert.equal(h.document.clicks.length,0);
  }
});

test('an unrelated business revision uses latest CAS version without changing bound saved IDs',async t => {
  const h = harness(t), current = h.stored(); current.version++; h.setStored(current);
  await h.run({...save(),selection:saved});
  const put = h.calls.find(call => call.method === 'PUT'); assert.equal(put.body.expectedVersion,8);
  assert.equal(h.stored().version,9); assert.deepEqual(h.stored().state.views.at(-1).entityIds,current.state.views[0].entityIds);
});

test('oversized recovered selections honor the existing state limit without truncation or rebinding',async t => {
  const h = harness(t), context = pipeline();
  context.records = Array.from({length:7000},(_,index) => ({id:index + 1})); context.visibleIds = context.records.map(row => row.id);
  await h.acceptTurnResponse(response(save(),context),h.conversation,false,'Large selection');
  assert.deepEqual(plain(h.restored().tableView.visibleIds),context.visibleIds);
  assert.equal(h.states.at(-1),null); assert.equal(h.calls.length,0); assert.equal(h.document.clicks.length,0);
  await h.reviewRestoredProposal(); assert.equal(h.calls.length,0); assert.match(h.messages.at(-1).content,/changed/);
});

test('mutating the response while its workspace read is pending cannot rebind its captured action',async t => {
  const gate = deferred(), entered = deferred(), h = harness(t,{read:async value => { entered.resolve(); await gate.promise; return value; }});
  const reply = response(save()), pending = h.handleAction(reply,'Original request'); await entered.promise;
  reply.crmAction.selection = {source:'all'}; reply.ai.viewSelection.recordIds = [2]; gate.resolve(); await pending;
  assert.deepEqual(h.stored().state.views.at(-1).entityIds,[3,1].map(id => Business.legacyId(workspaceId,id)));
  assert.equal(h.calls.filter(call => call.method === 'PUT').length,1);
});
