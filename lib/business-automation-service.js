'use strict';

const Actions = require('../public/business-actions');
const Workflows = require('./business-workflows');
const { validateReceipt } = require('./action-journal');
const { isDeepStrictEqual } = require('node:util');

/* Bind rpc(name, namedArguments) to the current authenticated session. It must
 * return the RPC's JSON result or throw, not a successful transport envelope.
 * Do not perform another CRM save after a result: SQL already committed the
 * cards, workflow state, event receipt and journal in the same transaction.
 * Replayed mutations return their ORIGINAL snapshot; reload before new edits.
 * CRM writes continue through the journal adapter's ordinary write path.
 */
function createBusinessAutomationService({ rpc }) {
  if (typeof rpc !== 'function') throw new TypeError('Provide an authenticated RPC transport.');
  function collection(result) {
    if (!result || !Array.isArray(result.workflows) ||
      !(result.updatedAt === null || typeof result.updatedAt === 'string')) throw new Error('Invalid saved workflow response.');
    const workflows = result.workflows.map(Workflows.validateState);
    if (new Set(workflows.map(w => w.id)).size !== workflows.length) throw new Error('Repeated saved workflow ID.');
    return { ...result, workflows };
  }
  function correlation(input) {
    if (!input || typeof input.actionId !== 'string' || !/^(?:[a-f0-9]{64}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.test(input.actionId) ||
      typeof input.requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.requestId) ||
      !Actions.workflowId(input.workflowId) || !(input.expectedUpdatedAt === null || typeof input.expectedUpdatedAt === 'string')) {
      throw new Error('Provide workflow identity, action/request IDs and the reviewed workspace version.');
    }
    return { p_action_id: input.actionId, p_request_id: input.requestId,
      p_expected_updated_at: input.expectedUpdatedAt, p_workflow_id: input.workflowId };
  }
  async function mutation(name, args) {
    const result = await rpc(name, args);
    const receipt = validateReceipt(result?.receipt);
    if (receipt.actionId !== args.p_action_id || receipt.requestId !== args.p_request_id ||
      receipt.beforeVersion !== args.p_expected_updated_at || receipt.undoOf !== null ||
      receipt.conversationId !== null || receipt.planId !== null || receipt.importReceipt !== null ||
      typeof result.replayed !== 'boolean' ||
      !result.snapshot || !Array.isArray(result.snapshot.todoCards)) throw new Error('Workflow save did not return a durable receipt.');
    const snapshot = collection(result.snapshot), workflow = Workflows.validateState(result.workflow);
    if (snapshot.updatedAt !== receipt.afterVersion || snapshot.updatedAt === receipt.beforeVersion ||
      workflow.id !== args.p_workflow_id || !snapshot.workflows.some(w => isDeepStrictEqual(w, workflow))) {
      throw new Error('Saved workflow and receipt snapshot disagree.');
    }
    if (name === 'pipechat_create_workflow' && (workflow.status !== 'draft' || workflow.revision !== 1 ||
      !isDeepStrictEqual(workflow.spec, args.p_spec)) ||
      name === 'pipechat_set_workflow_activation' && (workflow.status !== (args.p_active ? 'active' : 'paused') ||
        ![args.p_revision, args.p_revision + 1].includes(workflow.revision)) ||
      name === 'pipechat_retry_workflow_event' && !workflow.executions.some(e => e.event.eventId === args.p_event_id &&
        isDeepStrictEqual(e, result.execution))) throw new Error('The saved workflow does not confirm the requested action.');
    return { ...result, receipt, workflow, snapshot };
  }
  return {
    async read() { return collection(await rpc('pipechat_read_workflows', {})); },
    create(input) {
      const args = correlation(input);
      return mutation('pipechat_create_workflow', { ...args, p_spec: Actions.validateWorkflowSpec(input.spec) });
    },
    setActivation(input) {
      const args = correlation(input);
      if (!Number.isSafeInteger(input.revision) || input.revision < 1 || typeof input.active !== 'boolean') throw new Error('Invalid workflow activation.');
      return mutation('pipechat_set_workflow_activation', { ...args, p_revision: input.revision, p_active: input.active });
    },
    retry(input) {
      const args = correlation(input);
      if (!Actions.text(input.eventId, 200) || /[\r\n\t]/.test(input.eventId)) throw new Error('Provide a saved event ID.');
      return mutation('pipechat_retry_workflow_event', { ...args, p_event_id: input.eventId });
    },
    async history(workflowId, limit = 50) {
      const { workflows } = collection(await rpc('pipechat_read_workflows', {}));
      return Workflows.plan({ action: 'workflow_history', workflowId, limit }, { workflows });
    }
  };
}

module.exports = { createBusinessAutomationService };
