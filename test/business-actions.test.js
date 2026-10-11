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
const spec = () => ({version:1, name:'Review follow-up', timezone:'America/New_York',
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
