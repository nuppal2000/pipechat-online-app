'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createSupabaseBackend, BackendError } = require('../lib/supabase-backend');
const Workflows = require('../lib/business-workflows');
const { legacySchema } = require('../public/table-schema');
const at = '2026-01-01T00:00:00.000Z';
const spec = { version: 2, scope: { type: 'all_records' }, name: 'Follow up', timezone: 'America/New_York',
  trigger: { type: 'field_changes_to', field: 'stage', to: 'Won' },
  conditions: [{ type: 'no_open_qualifying_task', match: { field: 'nextAction', operator: 'contains', value: 'Follow up' } }],
  action: { type: 'create_linked_task', nextAction: 'Follow up', notes: '', due: { anchor: 'event_date', offsetDays: 2 } } };
function fixture({ user = { id: 'owner', email: 'owner@example.test' }, response } = {}) {
  const calls = [], schema = legacySchema();
  const workflow = Workflows.apply(Workflows.plan({ action: 'create_workflow', spec }, { schema }),
    { workflows: [], id: 'workflow_test', schema, now: at }).workflow;
  const saved = { deals: [], todoCards: [], customFields: [], tableSchema: schema, workflows: [workflow], updatedAt: at };
  const backend = createSupabaseBackend({ url: 'https://test.supabase.co', publishableKey: 'sb_publishable_offline_1234567890',
    createClient: () => ({ rpc() { throw new Error('No health or shared client usage'); } }),
    createServerClient: () => ({ auth: { getUser: async () => ({ data: { user }, error: null }) },
      rpc: async (name, args) => {
        calls.push({ name, args });
        if (response) return response(name, args, saved);
        const data = name === 'pipechat_read_workflows' ? { workflows: saved.workflows, updatedAt: saved.updatedAt } :
          { snapshot: saved, workflow, workflows: saved.workflows, updatedAt: saved.updatedAt, replayed: false,
            receipt: { formatVersion: 1, actionId: args.p_action_id, requestId: args.p_request_id, conversationId: null,
              planId: null, undoOf: null, importReceipt: null, beforeVersion: args.p_expected_updated_at, afterVersion: saved.updatedAt } };
        return { data, error: null };
      } }) });
  return { adapter: backend.forRequest({ headers: {} }, { getHeader() {}, setHeader() {} }), calls, saved };
}
const input = () => ({ actionId: randomUUID(), requestId: randomUUID(), expectedUpdatedAt: null, workflowId: 'workflow_test', spec });
const status = expected => error => error instanceof BackendError && error.status === expected;

test('workflow adapter uses authenticated RPC/service and preserves the final journal snapshot', async () => {
  const { adapter, calls, saved } = fixture(), args = input();
  assert.deepEqual(await adapter.readWorkflows(), { workflows: saved.workflows, updatedAt: at });
  const result = await adapter.createWorkflow(args);
  assert.deepEqual(result.snapshot.workflows, saved.workflows); assert.equal(result.receipt.actionId, args.actionId);
  assert.deepEqual(calls.at(-1), { name: 'pipechat_create_workflow', args: { p_action_id: args.actionId,
    p_request_id: args.requestId, p_expected_updated_at: null, p_workflow_id: 'workflow_test', p_spec: spec } });
  assert.equal((await adapter.readWorkflowHistory('workflow_test')).history[0].type, 'created');
  await assert.rejects(() => adapter.readWorkflowHistory('workflow_absent'), status(404));
  await assert.rejects(() => adapter.readWorkflowHistory('workflow_test', 201), status(400));
  const count = calls.length;
  await assert.rejects(() => adapter.setWorkflowActivation({ ...args, active: 'true', revision: 1 }), status(400));
  assert.equal(calls.length, count, 'invalid mutation never reaches RPC');
});

test('workflow adapter refuses unsigned, mismatched, and partial acknowledgements', async () => {
  for (const patch of [() => ({}), data => ({ ...data, receipt: {} }), data => ({ ...data, workflow: { ...data.workflow, status: 'active' } }),
    data => ({ ...data, snapshot: { ...data.snapshot, todoCards: undefined } })]) {
    const f = fixture({ response: (name, args, saved) => {
      const result = { snapshot: saved, workflow: saved.workflows[0], replayed: false,
        receipt: { formatVersion: 1, actionId: args.p_action_id, requestId: args.p_request_id, conversationId: null,
          planId: null, undoOf: null, importReceipt: null, beforeVersion: null, afterVersion: at } };
      return { data: patch(result), error: null };
    } });
    await assert.rejects(() => f.adapter.createWorkflow(input()), status(503));
  }
});

test('workflow adapter rejects unauthenticated and revoked sessions with no fallback', async () => {
  const absent = fixture({ user: null });
  await assert.rejects(() => absent.adapter.readWorkflows(), status(401)); assert.equal(absent.calls.length, 0);
  for (const code of ['PT401', 'PT403', 'PT409']) {
    const revoked = fixture({ response: () => ({ data: null, error: { code, message: 'Private database detail' } }) });
    await assert.rejects(() => revoked.adapter.createWorkflow(input()), error => {
      assert.equal(error.status, Number(code.slice(2))); assert.ok(!error.message.includes('Private')); return true;
    });
  }
});
