'use strict';
const { createHash, randomUUID } = require('node:crypto');
const { canonical } = require('./action-lifecycle');
const Actions = require('../public/business-actions');
const Workflows = require('./business-workflows');
const { BackendError } = require('./backend-contract');
const fail = (message, status = 400) => { throw new BackendError(message, status); };
const version = value => value === null || typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const digest = (userId, proposal) => createHash('sha256').update(canonical({ userId, proposal })).digest('hex');

// Hash the complete reviewed command and preview, scoped to the authenticated
// owner. This is an integrity/idempotency identity, not a client authorization token.
function prepare(userId, input, current, collection, retry = false) {
  if (!Actions.exact(input, retry ? ['workflowId', 'eventId', 'expectedUpdatedAt'] : ['action', 'expectedUpdatedAt']) ||
    !version(input.expectedUpdatedAt)) fail('Provide a workflow request and the current workspace version.');
  if (input.expectedUpdatedAt !== current.updatedAt || collection.updatedAt !== current.updatedAt) {
    fail('The workspace changed. Refresh the workflows and review a new proposal.', 409);
  }
  const workflows = collection.workflows.map(Workflows.validateState);
  let action = input.action, operation, workflowId, revision = null, preview;
  if (retry) {
    if (!Actions.workflowId(input.workflowId) || !Actions.text(input.eventId, 200) || /[\r\n\t]/.test(input.eventId)) fail('Choose a saved failed execution.');
    const workflow = workflows.find(w => w.id === input.workflowId);
    const execution = workflow?.executions.find(e => e.event.eventId === input.eventId);
    if (!execution) fail('The saved workflow execution is unavailable.', 404);
    if (execution.status !== 'failed') fail('Only failed executions can be retried. Refresh workflow history.', 409);
    action = { action: 'retry_workflow_event', workflowId: workflow.id, eventId: input.eventId };
    operation = 'retry'; workflowId = workflow.id; revision = workflow.revision;
    preview = { ...Actions.workflowPreview(workflow.spec), kind: 'workflow_retry', status: workflow.status,
      event: execution.event, reason: execution.reason, attempts: execution.attempts };
  } else {
    if (!['create_workflow', 'set_workflow_activation'].includes(action?.action)) fail('Choose draft creation or workflow activation.');
    let plan;
    try { plan = Workflows.plan(action, { workflows, schema: current.tableSchema, customFields: current.customFields }); }
    catch (error) { fail(error.message); }
    operation = plan.operation; preview = plan.preview;
    workflowId = operation === 'create' ? 'workflow_' + randomUUID().replaceAll('-', '') : plan.workflowId;
    revision = plan.baseRevision ?? null;
    if (operation === 'activation') {
      const workflow = workflows.find(w => w.id === workflowId);
      preview = { ...Actions.workflowPreview(workflow.spec), ...preview, previousStatus: workflow.status };
    }
  }
  const proposal = { version: 1, operation, action, workflowId, revision, expectedUpdatedAt: current.updatedAt, requestId: randomUUID(), preview };
  return { ...proposal, actionId: digest(userId, proposal) };
}

// Do not read current state before dispatch: the DB must be able to replay an
// already-committed action whose original expectedUpdatedAt is now stale.
function confirmation(userId, input) {
  if (!Actions.exact(input, ['proposal', 'confirm']) || input.confirm !== true) fail('Explicit workflow confirmation is required.');
  const p = input.proposal;
  if (!Actions.exact(p, ['version', 'operation', 'action', 'workflowId', 'revision', 'expectedUpdatedAt', 'requestId', 'preview', 'actionId']) ||
    p.version !== 1 || !Actions.workflowId(p.workflowId) || !version(p.expectedUpdatedAt) || !uuid(p.requestId) ||
    typeof p.actionId !== 'string' || !/^[a-f0-9]{64}$/.test(p.actionId)) fail('Invalid reviewed workflow proposal.');
  const { actionId, ...body } = p;
  if (digest(userId, body) !== actionId) fail('The workflow proposal changed. Review it again.', 409);
  const inputArgs = { actionId, requestId: p.requestId, expectedUpdatedAt: p.expectedUpdatedAt, workflowId: p.workflowId };
  if (p.operation === 'create' && Actions.exact(p.action, ['action', 'spec']) && p.action.action === 'create_workflow' && p.revision === null) {
    try { Actions.validateWorkflowSpec(p.action.spec); } catch (error) { fail(error.message); }
    return { method: 'createWorkflow', input: { ...inputArgs, spec: p.action.spec } };
  }
  if (!Number.isSafeInteger(p.revision) || p.revision < 1 || p.action?.workflowId !== p.workflowId) fail('Invalid workflow revision.');
  if (p.operation === 'activation' && Actions.exact(p.action, ['action', 'workflowId', 'active']) &&
    p.action.action === 'set_workflow_activation' && typeof p.action.active === 'boolean') {
    return { method: 'setWorkflowActivation', input: { ...inputArgs, revision: p.revision, active: p.action.active } };
  }
  if (p.operation === 'retry' && Actions.exact(p.action, ['action', 'workflowId', 'eventId']) && p.action.action === 'retry_workflow_event' &&
    Actions.text(p.action.eventId, 200) && !/[\r\n\t]/.test(p.action.eventId)) {
    return { method: 'retryWorkflowEvent', input: { ...inputArgs, eventId: p.action.eventId } };
  }
  fail('Invalid reviewed workflow action.');
}

module.exports = { prepare, confirmation };
