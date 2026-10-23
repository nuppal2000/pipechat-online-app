'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const UI = require('../public/workflow-ui');
const Actions = require('../public/business-actions');
const HTTP = require('../lib/business-automation-http');
const Workflows = require('../lib/business-workflows');

const version = '2026-01-01T00:00:00.000Z';
function fixture(kind = 'schema', to = 'Proposal Sent') {
  const field = { id: kind === 'schema' ? 'f_b8fe1234_2' : 'cf_gate', name: kind === 'schema' ? 'Stage' : 'Sales gate', type: 'choice', options: [to] };
  const tableSchema = kind === 'schema' ? { status: 'ready', useCase: 'Sales', description: '', title: 'Sales', recordLabel: 'deal', fields: [
    { id: 'f_company', name: 'Company', type: 'text', role: 'primary', options: [] }, { ...field, role: 'status' }
  ] } : null;
  const customFields = kind === 'schema' ? [] : [field];
  const spec = { version: 2, scope: { type: 'all_records' }, name: 'Proposal follow-up', timezone: 'America/New_York',
    trigger: { type: 'field_changes_to', field: field.id, to },
    conditions: [{ type: 'no_open_qualifying_task', match: { field: 'nextAction', operator: 'contains', value: 'Follow up' } }],
    action: { type: 'create_linked_task', nextAction: 'Follow up', notes: '', due: { anchor: 'event_date', offsetDays: 2 } } };
  const context = { schema: tableSchema, customFields };
  const workflow = Workflows.apply(Workflows.plan({ action: 'create_workflow', spec }, context),
    { ...context, workflows: [], id: 'workflow_labels', now: version }).workflow;
  return { updatedAt: version, tableSchema, customFields, workflows: [workflow] };
}
function setStatus(snapshot, status) {
  const context = { workflows: snapshot.workflows, schema: snapshot.tableSchema, customFields: snapshot.customFields };
  const plan = Workflows.plan({ action: 'set_workflow_activation', workflowId: context.workflows[0].id, active: status === 'active' }, context);
  snapshot.workflows = Workflows.apply(plan, { ...context, now: version }).workflows;
}
function renderList(snapshot) {
  const S = { user: { id: 'owner' }, generation: 1, updatedAt: version, tableSchema: structuredClone(snapshot.tableSchema),
    customFields: structuredClone(snapshot.customFields), records: structuredClone(snapshot.deals) };
  const element = { innerHTML: '', handlers: {}, addEventListener(name, fn) { this.handlers[name] = fn; }, removeEventListener() {} };
  const prepared = [];
  const controller = UI.create({ element, S, prepare: action => prepared.push(action) });
  controller.setSnapshot({ updatedAt: snapshot.updatedAt, workflows: snapshot.workflows });
  return { element, S, controller, prepared };
}
function prepare(snapshot, active) {
  return HTTP.prepare('owner', { action: { action: 'set_workflow_activation', workflowId: snapshot.workflows[0].id, active }, expectedUpdatedAt: version }, snapshot, snapshot);
}
function fieldDefinition(snapshot, kind) {
  return kind === 'schema' ? snapshot.tableSchema.fields[1] : snapshot.customFields[0];
}
function removeField(snapshot, kind) {
  if (kind === 'schema') snapshot.tableSchema.fields.splice(1, 1);
  else snapshot.customFields = [];
}

for (const kind of ['schema', 'custom']) {
  test(`${kind} workflow list resolves current labels, renames and deleted fields without changing saved IDs`, () => {
    const snapshot = fixture(kind), original = structuredClone(snapshot);
    const { element, S, controller } = renderList(snapshot);
    assert.ok(element.innerHTML.includes(`<p>${fieldDefinition(snapshot, kind).name} changes to Proposal Sent</p>`));
    assert.ok(!element.innerHTML.includes(snapshot.workflows[0].spec.trigger.field));
    fieldDefinition(S, kind).name = 'Current phase';
    controller.draw();
    assert.match(element.innerHTML, /<p>Current phase changes to Proposal Sent<\/p>/);
    removeField(S, kind);
    controller.draw();
    assert.ok(element.innerHTML.includes(`<p>Unavailable field (${snapshot.workflows[0].spec.trigger.field}) changes to Proposal Sent</p>`));
    assert.deepEqual(snapshot, original);
    assert.deepEqual(controller.getSnapshot().workflows, original.workflows);
  });

  for (const active of [true, false]) {
    test(`${kind} ${active ? 'activation' : 'deactivation'} review resolves the current label from an ID-only saved spec`, () => {
      const snapshot = fixture(kind);
      if (!active) setStatus(snapshot, 'active');
      fieldDefinition(snapshot, kind).name = 'Current phase';
      const original = structuredClone(snapshot), proposal = prepare(snapshot, active), unchanged = structuredClone(proposal);
      assert.equal(proposal.preview.trigger, 'Current phase changes to Proposal Sent');
      const html = UI.review(proposal);
      assert.match(html, /<dt>Trigger<\/dt><dd>Current phase changes to Proposal Sent<\/dd>/);
      assert.ok(html.includes(active ? 'Activate workflow' : 'Pause workflow'));
      assert.ok(html.includes(active ? 'draft to active' : 'active to paused'));
      assert.match(html, /data-confirm/);
      assert.match(html, /data-cancel/);
      assert.deepEqual(snapshot, original);
      assert.deepEqual(proposal, unchanged);
      assert.equal(HTTP.confirmation('owner', { proposal, confirm: true }).input.active, active);
      assert.throws(() => HTTP.confirmation('owner', { proposal, confirm: false }), /Explicit workflow confirmation/);
      const changed = structuredClone(proposal);
      changed.preview.trigger = 'Different field changes to Proposal Sent';
      assert.throws(() => HTTP.confirmation('owner', { proposal: changed, confirm: true }), /proposal changed/);
    });
  }

  test(`${kind} deleted trigger remains pausable but cannot be activated`, () => {
    const snapshot = fixture(kind);
    setStatus(snapshot, 'active');
    removeField(snapshot, kind);
    const original = structuredClone(snapshot), proposal = prepare(snapshot, false);
    const trigger = `Unavailable field (${snapshot.workflows[0].spec.trigger.field}) changes to Proposal Sent`;
    assert.equal(proposal.preview.trigger, trigger);
    assert.ok(UI.review(proposal).includes(`<dt>Trigger</dt><dd>${trigger}</dd>`));
    assert.match(UI.review(proposal), /Pause workflow/);
    assert.equal(HTTP.confirmation('owner', { proposal, confirm: true }).input.active, false);
    assert.throws(() => prepare(snapshot, true), /no longer exists/);
    assert.deepEqual(snapshot, original);
  });

  test(`${kind} list and activation review escape field labels and trigger values`, () => {
    const snapshot = fixture(kind, 'Proposal <sent> & "approved"');
    fieldDefinition(snapshot, kind).name = 'Stage <img src=x> & "phase"';
    const expected = 'Stage &lt;img src=x&gt; &amp; &quot;phase&quot; changes to Proposal &lt;sent&gt; &amp; &quot;approved&quot;';
    for (const html of [renderList(snapshot).element.innerHTML, UI.review(prepare(snapshot, true))]) {
      assert.ok(html.includes(expected));
      assert.ok(!html.includes('<img'));
      assert.ok(!html.includes('<sent>'));
    }
  });
}

test('legacy Stage label resolves without a configured table schema', () => {
  const snapshot = fixture('custom');
  snapshot.customFields = [];
  snapshot.workflows[0].spec.trigger.field = 'stage';
  assert.match(renderList(snapshot).element.innerHTML, /<p>Stage changes to Proposal Sent<\/p>/);
  assert.match(UI.review(prepare(snapshot, true)), /<dt>Trigger<\/dt><dd>Stage changes to Proposal Sent<\/dd>/);
});

test('draft creation keeps its resolved label and stable field ID', () => {
  const snapshot = fixture(), spec = snapshot.workflows[0].spec, original = structuredClone(spec);
  const proposal = HTTP.prepare('owner', { action: { action: 'create_workflow', spec }, expectedUpdatedAt: version }, snapshot, snapshot);
  assert.match(UI.review(proposal), /<dt>Trigger<\/dt><dd>Stage changes to Proposal Sent<\/dd>/);
  assert.equal(HTTP.confirmation('owner', { proposal, confirm: true }).input.spec.trigger.field, original.trigger.field);
  assert.deepEqual(spec, original);
  assert.deepEqual(Actions.validateWorkflowSpec(spec, snapshot.tableSchema), original);
});

test('draft, active and paused switches show an action label and still require confirmation', async () => {
  for (const status of ['draft', 'active', 'paused']) {
    const snapshot = fixture();
    if (status !== 'draft') setStatus(snapshot, 'active');
    if (status === 'paused') setStatus(snapshot, 'paused');
    const { element, controller, prepared, S } = renderList(snapshot);
    assert.ok(element.innerHTML.includes(`class="wf-status wf-${status}">${status}</span>`));
    const toggle = element.innerHTML.match(/<label class="wf-toggle">([\s\S]*?)<\/label>/)[1];
    assert.match(toggle, />Enable workflow$/);
    assert.match(toggle, /aria-label="Enable Proposal follow-up"/);
    assert.equal(/\schecked(?:\s|>)/.test(toggle), status === 'active');
    const input = { dataset: { wfActivation: snapshot.workflows[0].id }, checked: status !== 'active' };
    await element.handlers.change({ target: input });
    assert.equal(input.checked, status === 'active');
    assert.deepEqual(prepared, [{ action: 'set_workflow_activation', workflowId: snapshot.workflows[0].id, active: status !== 'active' }]);
    assert.equal(controller.getSnapshot().workflows[0].status, status);
    S.pending = {};
    controller.draw();
    assert.match(element.innerHTML, /role="switch"[^>]*disabled/);
    await element.handlers.change({ target: { ...input, checked: status !== 'active' } });
    assert.equal(prepared.length, 1);
  }
});

for (const kind of ['schema','custom']) {
  test(`${kind} scoped previews and list show escaped current names while IDs alone control membership`, () => {
    const snapshot = fixture(kind), primary = kind === 'schema' ? 'f_company' : 'account';
    snapshot.deals = [{id:43,[primary]:'Acorn <img src=x> & "Co"'}, {id:44,[primary]:'Acorn <img src=x> & "Co"'}];
    snapshot.workflows[0].spec.scope = {type:'record_ids',recordIds:[43,44]};
    const original = structuredClone(snapshot), action = {action:'create_workflow',spec:snapshot.workflows[0].spec};
    const proposal = HTTP.prepare('owner',{action,expectedUpdatedAt:version},snapshot,snapshot);
    const expected = 'Only records: Acorn &lt;img src=x&gt; &amp; &quot;Co&quot; (#43), Acorn &lt;img src=x&gt; &amp; &quot;Co&quot; (#44)';
    const {element,S,controller} = renderList(snapshot);
    for (const html of [element.innerHTML,UI.review(proposal),UI.review(prepare(snapshot,true)),UI.review(prepare(snapshot,false))]) {
      assert.ok(html.includes(expected)); assert.ok(!html.includes('<img'));
    }
    S.records[0][primary] = 'Renamed Acorn';
    controller.draw();
    assert.match(element.innerHTML, /Renamed Acorn \(#43\)/);
    S.records = S.records.filter(r => r.id !== 43);
    controller.draw();
    assert.match(element.innerHTML, /Unavailable record \(#43\)/);
    assert.deepEqual(controller.getSnapshot().workflows[0].spec.scope,original.workflows[0].spec.scope);
    assert.deepEqual(snapshot,original);
    snapshot.deals[0][primary] = 'Renamed Acorn';
    assert.match(prepare(snapshot,true).preview.scope,/Renamed Acorn \(#43\)/);
    assert.ok(proposal.preview.scope.includes('Acorn <img'), 'a reviewed preview remains bound to its original version');
    const changed = structuredClone(proposal); changed.preview.scope = 'Only records: Someone else (#43)';
    assert.throws(() => HTTP.confirmation('owner',{proposal:changed,confirm:true}), /proposal changed/);
    removeField(snapshot,kind);
    snapshot.deals = [];
    assert.match(UI.review(prepare(snapshot,false)), /Unavailable record \(#43\)/);
  });
}
