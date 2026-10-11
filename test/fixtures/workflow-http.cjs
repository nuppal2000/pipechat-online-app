'use strict';
// Offline route fixture. It intentionally refuses all external and AI requests.
const http = require('node:http');
const Workflows = require('../../lib/business-workflows');
const { legacySchema } = require('../../public/table-schema');
const { BackendError } = require('../../lib/backend-contract');
const originalListen = http.Server.prototype.listen;
http.Server.prototype.listen = function (...args) {
  this.once('listening', () => console.log('WORKFLOW_PORT=' + this.address().port));
  return originalListen.apply(this, args);
};
global.fetch = async () => { throw new Error('External and AI calls are forbidden in workflow tests'); };
const clone = value => structuredClone(value), stores = new Map();
const spec = { version: 1, name: 'Follow up', timezone: 'America/New_York',
  trigger: { type: 'field_changes_to', field: 'stage', to: 'Won' },
  conditions: [{ type: 'no_open_qualifying_task', match: { field: 'nextAction', operator: 'contains', value: 'Follow up' } }],
  action: { type: 'create_linked_task', nextAction: 'Follow up', notes: '', due: { anchor: 'event_date', offsetDays: 2 } } };
function store(id) {
  if (!stores.has(id)) {
    const schema = legacySchema(), at = '2026-01-01T00:00:00.000Z';
    const draft = Workflows.apply(Workflows.plan({ action: 'create_workflow', spec }, { schema }),
      { workflows: [], id: 'workflow_failed', now: at, schema });
    const active = Workflows.apply(Workflows.plan({ action: 'set_workflow_activation', workflowId: draft.workflow.id, active: true }, draft),
      { workflows: draft.workflows, now: at, schema });
    const records = [{ id: 1, account: 'A', stage: 'Won', history: [] }];
    const cards = Array.from({ length: 2000 }, (_, i) => ({ id: 'todo_' + i, recordId: 1, status: 'To Do', nextAction: 'Other', notes: '', dueDate: '' }));
    const failed = Workflows.handleEvent({ workflow: active.workflow, schema, records, cards, now: at,
      event: { eventId: 'failed_event', recordId: 1, field: 'stage', from: 'Discovery', to: 'Won', occurredAt: at } });
    stores.set(id, { tick: 0, receipts: new Map(), snapshot: { deals: records, todoCards: [], customFields: [],
      tableSchema: schema, workflows: [failed.workflow], updatedAt: at } });
  }
  return stores.get(id);
}
require.cache[require.resolve('../../lib/supabase-backend')] = { exports: {
  createSupabaseBackend() { return { check: async () => ({ ok: true }), forRequest(req) {
    const id = /(?:^|; )qa=([ab])(?:;|$)/.exec(req.headers.cookie || '')?.[1];
    const state = id && store(id);
    const collection = () => ({ workflows: clone(state.snapshot.workflows), updatedAt: state.snapshot.updatedAt });
    async function mutate(operation, input) {
      const old = state.receipts.get(input.actionId);
      if (old) {
        if (JSON.stringify(old.input) !== JSON.stringify(input)) throw new BackendError('Action ID already used', 409);
        return { ...clone(old.result), replayed: true };
      }
      if (input.expectedUpdatedAt !== state.snapshot.updatedAt) throw new BackendError('The workspace changed', 409);
      const before = state.snapshot, now = new Date(Date.parse('2026-01-01T00:00:00Z') + ++state.tick * 1000).toISOString();
      let workflows, workflow, execution = null, todoCards = before.todoCards;
      if (operation === 'retry') {
        const w = before.workflows.find(w => w.id === input.workflowId);
        const event = w?.executions.find(e => e.event.eventId === input.eventId)?.event;
        if (!event) throw new BackendError('Unavailable', 404);
        const next = Workflows.handleEvent({ workflow: w, event, records: before.deals, cards: before.todoCards, schema: before.tableSchema, now });
        workflow = next.workflow; execution = next.execution; todoCards = next.cards;
        workflows = before.workflows.map(w => w.id === workflow.id ? workflow : w);
      } else {
        const action = operation === 'create' ? { action: 'create_workflow', spec: input.spec } :
          { action: 'set_workflow_activation', workflowId: input.workflowId, active: input.active };
        const proposal = Workflows.plan(action, { workflows: before.workflows, schema: before.tableSchema });
        if (operation === 'activation' && proposal.baseRevision !== input.revision) throw new BackendError('Revision changed', 409);
        ({ workflows, workflow } = Workflows.apply(proposal, { workflows: before.workflows, schema: before.tableSchema, id: input.workflowId, now }));
      }
      state.snapshot = { ...before, workflows, todoCards, updatedAt: now };
      const result = { snapshot: clone(state.snapshot), workflow, workflows, updatedAt: now, execution, replayed: false,
        receipt: { formatVersion: 1, actionId: input.actionId, requestId: input.requestId, conversationId: null, planId: null,
          undoOf: null, importReceipt: null, beforeVersion: before.updatedAt, afterVersion: now } };
      state.receipts.set(input.actionId, { input: clone(input), result: clone(result) });
      if (req.headers['x-test-lose-ack']) throw new BackendError('Synthetic lost acknowledgement', 503);
      return result;
    }
    return { getUser: async () => id ? { id, email: id + '@example.test', name: id } : null,
      readCrm: async () => clone(state.snapshot), readWorkflows: async () => collection(),
      writeCrm: async (token, deals, expectedUpdatedAt, customFields, tableSchema, todoCards, metadata) =>
        ({ deals, customFields, tableSchema, todoCards, updatedAt: expectedUpdatedAt, receivedMetadata: metadata }),
      readWorkflowHistory: async (workflowId, limit) => {
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new BackendError('Invalid limit', 400);
        if (!state.snapshot.workflows.some(w => w.id === workflowId)) throw new BackendError('Unavailable', 404);
        return Workflows.plan({ action: 'workflow_history', workflowId, limit }, collection());
      },
      createWorkflow: input => mutate('create', input), setWorkflowActivation: input => mutate('activation', input),
      retryWorkflowEvent: input => mutate('retry', input)
    };
  } }; }
} };
