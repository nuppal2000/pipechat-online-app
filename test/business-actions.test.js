'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Actions = require('../public/business-actions');
const schema = {status:'ready', useCase:'Other', description:'', title:'Review queue', recordLabel:'item', fields:[
  {id:'f_title', name:'Title', type:'text', role:'primary', options:[]},
  {id:'f_state', name:'Review state', type:'choice', role:'status', options:['Queued','Ready']}
]};
const spec = () => ({version:2, scope:{type:'all_records'}, name:'Review follow-up', timezone:'America/New_York',
  trigger:{type:'field_changes_to', field:'f_state', to:'Ready'},
  conditions:[{type:'no_open_qualifying_task', match:{field:'nextAction', operator:'contains', value:'review'}}],
  action:{type:'create_linked_task', nextAction:'Schedule review', notes:'', due:{anchor:'event_date', offsetDays:2}}});

test('AI union includes actual document, workflow, activation and history action schemas', () => {
  const schemas = Actions.actionSchemas();
  assert.deepEqual(schemas.map(value => value.properties.action.enum[0]),
    ['create_document','create_workflow','set_workflow_activation','workflow_history']);
  function inspect(value) {
    if (!value || typeof value !== 'object') return;
    if (value.type === 'object') {
      assert.equal(value.additionalProperties, false);
      assert.deepEqual(value.required, Object.keys(value.properties));
    }
    Object.values(value).forEach(inspect);
  }
  schemas.forEach(inspect);
  assert.doesNotMatch(JSON.stringify(schemas), /script|callback|sendTo|recipient|email|"body"/);
  assert.match(Actions.instructions, /Do not return none/);
  assert.match(Actions.instructions, /drafts only/);
});

test('typed workflow proposal is explicit and leaves input untouched', () => {
  const action = {action:'create_workflow', spec:spec()}, before = structuredClone(action);
  const result = Actions.plan(action, {schema});
  assert.equal(result.kind, 'workflow');
  assert.equal(result.operation, 'create');
  assert.equal(result.preview.activation, 'draft');
  assert.equal(result.preview.trigger, 'Review state changes to Ready');
  assert.equal(result.preview.due, 'Event date + 2 calendar days (America/New_York)');
  assert.equal(result.preview.task.nextAction, 'Schedule review');
  assert.deepEqual(action, before);
  result.spec.action.notes = 'Changed returned copy';
  assert.equal(action.spec.action.notes, '');
});

test('validates actual field IDs/options, custom choices and explicit timezone', () => {
  const value = spec();
  value.trigger = {type:'field_changes_to', field:'cf_gate', to:'Go'};
  assert.deepEqual(Actions.validateWorkflowSpec(value, schema, [{id:'cf_gate', name:'Gate', type:'choice', options:['Go','Stop']}]), value);
  assert.throws(() => Actions.validateWorkflowSpec(value, schema), /no longer exists/);
  for (const mutate of [
    v => { v.trigger.field = 'f_title'; }, v => { v.trigger.to = 'ready'; },
    v => { v.trigger.field = 'missing'; }, v => { v.timezone = 'Local'; },
    v => { v.timezone = ''; }, v => { v.trigger.to = 'Made up'; }
  ]) { const input = spec(); mutate(input); assert.throws(() => Actions.validateWorkflowSpec(input, schema)); }
  assert.throws(() => Actions.validateWorkflowSpec(spec(), {status:'pending'}), /Configure/);
});

test('strict AST rejects executable conditions, delivery actions and ambiguous dates', () => {
  for (const mutate of [
    v => { v.trigger.expression = 'record.value > 0'; }, v => { v.conditions = []; },
    v => { v.conditions[0].match.operator = 'regex'; }, v => { v.conditions[0].match.value = ' '; },
    v => { v.conditions[0].type = 'eval'; }, v => { v.action.type = 'send_email'; },
    v => { v.action.due.anchor = 'now'; }, v => { v.action.due.offsetDays = 1.5; },
    v => { v.action.due.offsetDays = -1; }, v => { v.action.due.offsetDays = 3651; },
    v => { v.action.nextAction = 'Unrelated work'; }, v => { v.script = 'execute'; }
  ]) { const input = spec(); mutate(input); assert.throws(() => Actions.validateWorkflowSpec(input, schema)); }
});

test('browser UMD preview and Blob download work without network or CommonJS', async () => {
  const urls = new Map(), revoked = [], browser = vm.createContext({Blob, URL:{
    createObjectURL(blob) { urls.set('blob:local-fixture', blob); return 'blob:local-fixture'; },
    revokeObjectURL(url) { revoked.push(url); urls.delete(url); }
  }});
  for (const file of ['table-schema.js','pipeline-core.js','business-actions.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public', file), 'utf8'), browser, {filename:file});
  }
  const api = browser.PipeChatBusinessActions;
  const value = spec();
  assert.deepEqual(JSON.parse(JSON.stringify(api.workflowPreview(value, schema))), Actions.workflowPreview(value, schema));
  const action = {action:'create_document', recordId:11, documentType:'proposal', format:'html'};
  const bundle = {recordId:11, recordName:'Fixture', revision:'r1', facts:[], terms:{}};
  const download = api.documentDownload(action, bundle);
  assert.equal(download.filename, 'proposal-record-11.html');
  assert.equal(urls.size, 1);
  assert.equal(urls.get(download.url).type, 'text/html; charset=utf-8');
  assert.equal(await urls.get(download.url).text(), Actions.documentArtifact(action, bundle).body);
  download.revoke(); download.revoke();
  assert.deepEqual(revoked, ['blob:local-fixture']);
  assert.equal(urls.size, 0);
});

test('history preview is read-only and activation requires a resolved existing ID', () => {
  const workflows = [{id:'workflow_fixture', spec:spec(), revision:3, history:[{status:'draft'},{status:'active'}], executions:[]}];
  const result = Actions.plan({action:'set_workflow_activation', workflowId:'workflow_fixture', active:true}, {workflows, schema});
  assert.equal(result.baseRevision, 3);
  assert.equal(result.active, true);
  const history = Actions.plan({action:'workflow_history', workflowId:'workflow_fixture', limit:1}, {workflows});
  assert.deepEqual(history.history, [{status:'active'}]);
  history.history[0].status = 'mutated';
  assert.equal(workflows[0].history[1].status, 'active');
  assert.throws(() => Actions.plan({action:'set_workflow_activation', workflowId:'workflow_missing', active:true}, {workflows}), /no longer exists/);
  assert.throws(() => Actions.plan({action:'workflow_history', workflowId:'workflow_fixture', limit:0}, {workflows}));
  assert.throws(() => Actions.plan({action:'none'}), /Unsupported/);
});

test('new drafts require explicit scope, canonical owned IDs, and an explicit nullable due policy', () => {
  const value = spec(); value.scope = {type:'record_ids', recordIds:[41, 42]}; value.action.due = null;
  const action = {action:'create_workflow', spec:value}, records = [{id:41,f_title:'Acorn'}, {id:42,f_title:'Birch'}];
  const planned = Actions.plan(action, {schema, records});
  assert.equal(planned.preview.scope, 'Only records: Acorn (#41), Birch (#42)');
  assert.equal(planned.preview.due, 'No due date');
  assert.deepEqual(planned.spec, value);
  assert.throws(() => Actions.plan(action, {schema}), /current workspace/);
  assert.throws(() => Actions.plan(action, {schema, records:[{id:41}]}), /current workspace/);
  const legacy = spec(); legacy.version = 1; delete legacy.scope;
  assert.deepEqual(Actions.validateWorkflowSpec(legacy, schema), legacy);
  assert.equal(Actions.workflowPreview(legacy, schema).scope, 'All records (legacy workflow)');
  assert.throws(() => Actions.plan({action:'create_workflow', spec:legacy}, {schema, records}), /version 2/);
  legacy.action.due = null;
  assert.throws(() => Actions.validateWorkflowSpec(legacy, schema));
  for (const scope of [null, {}, {type:'all_records', recordIds:[41]}, {type:'record_ids'},
    {type:'record_ids', recordIds:[]}, {type:'record_ids', recordIds:[41,41]}, {type:'record_ids', recordIds:['41']},
    ...[0,-1,1.5,9007199254740992].map(id => ({type:'record_ids', recordIds:[id]})),
    {type:'record_ids', recordIds:[41], ownerId:'other'}, {type:'record_ids', recordIds:Array.from({length:2001}, (_,i) => i+1)},
    {type:'expression', expression:'true'}, {type:'record_name', name:'Acorn'}]) {
    assert.throws(() => Actions.validateWorkflowSpec({...value, scope}, schema));
  }
  const missing = structuredClone(value); delete missing.scope;
  assert.throws(() => Actions.validateWorkflowSpec(missing, schema));
  delete missing.action.due; missing.scope = value.scope;
  assert.throws(() => Actions.validateWorkflowSpec(missing, schema));
  const modelSpec = Actions.actionSchemas()[1].properties.spec;
  assert.deepEqual(modelSpec.properties.version.enum, [2]);
  assert.ok(modelSpec.required.includes('scope'));
  assert.equal(modelSpec.properties.action.properties.due.anyOf[0].type, 'null');
  assert.match(Actions.instructions, /workflow name is NOT a predicate/);
  assert.match(Actions.instructions, /never invent offsetDays 0/);
});

test('scope names use the current primary field with IDs retained and honest context fallbacks', () => {
  const value = spec(); value.scope = {type:'record_ids',recordIds:[41,42]};
  const records = [{id:41,f_title:' Acorn ',account:'Not the configured name',f_alias:'Current identity'}, {id:42,f_title:'  '}];
  const before = structuredClone({value,records,schema});
  assert.equal(Actions.workflowScopeText(value,schema,records), 'Only records: Acorn (#41), Unnamed record (#42)');
  assert.equal(Actions.workflowScopeText(value,undefined,records), 'Only records: Record #41, Record #42');
  assert.equal(Actions.workflowScopeText(value,{status:'pending'},records), 'Only records: Record #41, Record #42');
  assert.equal(Actions.workflowScopeText(value,schema), 'Only records: Record #41, Record #42');
  assert.equal(Actions.workflowScopeText(value,schema,[]), 'Only records: Unavailable record (#41), Unavailable record (#42)');
  assert.equal(Actions.workflowScopeText(value,null,[{id:41,account:'Legacy Acorn'},{id:42,account:'Legacy Birch'}]),
    'Only records: Legacy Acorn (#41), Legacy Birch (#42)');
  const reordered = {...schema,fields:[...schema.fields,{id:'f_alias',name:'Alias',type:'text',role:'none',options:[]}],
    columnOrder:['f_alias','f_title','f_state']};
  assert.equal(Actions.workflowScopeText(value,reordered,records), 'Only records: Current identity (#41), Unnamed record (#42)');
  assert.deepEqual({value,records,schema},before);
  assert.equal(Actions.workflowPreview(value,undefined,[],records).scope, 'Only records: Record #41, Record #42');
});
