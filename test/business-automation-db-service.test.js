'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { legacySchema } = require('../public/table-schema');
const Workflow = require('../lib/business-workflows');
const { createBusinessAutomationService } = require('../lib/business-automation-service');

function fixture() {
  const spec = { version: 2, scope: { type: 'all_records' }, name: 'Won', timezone: 'UTC', trigger: { type: 'field_changes_to', field: 'stage', to: 'Won' },
    conditions: [{ type: 'no_open_qualifying_task', match: { field: 'nextAction', operator: 'equals', value: 'Call' } }],
    action: { type: 'create_linked_task', nextAction: 'Call', notes: '', due: { anchor: 'event_date', offsetDays: 1 } } };
  const input = { actionId: randomUUID(), requestId: randomUUID(), workflowId: 'workflow_one',
    expectedUpdatedAt: '2026-10-10T00:00:00.000000Z', spec };
  const workflow = Workflow.apply(Workflow.plan({ action: 'create_workflow', spec }, { schema: legacySchema() }),
    { workflows: [], id: input.workflowId, now: '2026-10-10T00:00:01.000Z', schema: legacySchema() }).workflow;
  const snapshot = { deals: [], todoCards: [], tableSchema: legacySchema(), customFields: [],
    workflows: [workflow], updatedAt: '2026-10-10T00:00:01.000000Z' };
  const result = { snapshot, workflow, replayed: false, receipt: { formatVersion: 1, actionId: input.actionId,
    requestId: input.requestId, conversationId: null, planId: null, undoOf: null, importReceipt: null,
    beforeVersion: input.expectedUpdatedAt, afterVersion: snapshot.updatedAt } };
  return { input, result };
}

test('automation service binds named SQL parameters and requires durable correlated receipt', async () => {
  const { input, result } = fixture(), calls = [];
  const service = createBusinessAutomationService({ rpc: async (name, args) => { calls.push({ name, args }); return result; } });
  assert.deepEqual(await service.create(input), result);
  assert.deepEqual(calls, [{ name: 'pipechat_create_workflow', args: { p_action_id: input.actionId, p_request_id: input.requestId,
    p_expected_updated_at: input.expectedUpdatedAt, p_workflow_id: input.workflowId, p_spec: input.spec } }]);
  for (const change of [r => { delete r.receipt; }, r => { r.receipt.actionId = randomUUID(); },
    r => { r.receipt.requestId = randomUUID(); }, r => { r.receipt.afterVersion = input.expectedUpdatedAt; },
    r => { r.snapshot.workflows = []; }, r => { r.snapshot.workflows[0].spec.name = 'Different saved name'; },
    r => { r.workflow.status = 'active'; }, r => { delete r.snapshot.todoCards; }, r => { r.replayed = 'true'; }]) {
    const bad = structuredClone(result); change(bad);
    await assert.rejects(createBusinessAutomationService({ rpc: async () => bad }).create(input));
  }
});

test('automation service does not swallow transport failures or synthesize success', async () => {
  const { input } = fixture(), failure = new Error('lost acknowledgement');
  await assert.rejects(createBusinessAutomationService({ rpc: async () => { throw failure; } }).create(input), e => e === failure);
  await assert.rejects(createBusinessAutomationService({ rpc: async () => ({ data: null, error: null }) }).create(input));
});

test('automation service validates mutations locally and history remains read-only when detached', async () => {
  const { input, result } = fixture(); let calls = 0;
  const service = createBusinessAutomationService({ rpc: async name => {
    calls++; assert.equal(name, 'pipechat_read_workflows'); return { workflows: result.snapshot.workflows, updatedAt: result.snapshot.updatedAt };
  } });
  assert.throws(() => service.create({ ...input, actionId: '' }));
  assert.throws(() => service.create({ ...input, spec: { ...input.spec, timezone: '' } }));
  assert.throws(() => service.setActivation({ ...input, revision: 1, active: 'true' }));
  assert.throws(() => service.retry({ ...input, eventId: '\nforged' }));
  assert.equal(calls, 0);
  const { history } = service;
  assert.equal((await history(input.workflowId)).history[0].type, 'created');
  assert.equal(calls, 1);
});
