'use strict';

const {createHash} = require('node:crypto');
const Actions = require('../public/business-actions');
const Todo = require('../public/todo-core');
const clone = value => JSON.parse(JSON.stringify(value));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = message => { throw new Error(message); };
const outcomes = {
  succeeded:['task_created'],
  skipped:['inactive','before_activation','trigger_not_matched','record_missing','record_no_longer_matches','open_task_exists'],
  failed:['schema_changed','task_id_conflict','board_capacity','due_date_out_of_range']
};

/* Integration contract:
 * - Scope workflow IDs, canonical records, task boards and events to one authenticated
 *   workspace. Pass committed field transitions, not model/browser event assertions.
 * - Store drafts returned by apply only after review; activation is a separate review.
 * - handleEvent is pure. Atomically persist BOTH result.workflow and result.cards,
 *   using baseRevision plus the caller's workspace/board revision or a serializable
 *   lock. On conflict, discard the entire result and recompute from fresh storage.
 * - A committed failed execution can be retried with the SAME eventId/payload.
 *   Succeeded/skipped events are terminal, even if a task is subsequently deleted.
 * - Retain executions (or equivalent durable unique tombstones) indefinitely for
 *   idempotency. Do not trim them when paginating history. This module does no IO.
 */

function instant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value) ||
    !Todo.validDate(value.slice(0, 10))) fail('Provide a valid explicit ISO timestamp with timezone.');
  const date = new Date(value);
  if (isNaN(date) || date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) fail('Timestamp is outside the supported range.');
  return date.toISOString();
}

function validateEvent(input) {
  if (!Actions.exact(input, ['eventId','recordId','field','from','to','occurredAt']) ||
    !Actions.text(input.eventId, 200) || /[\r\n\t]/.test(input.eventId) || !Actions.recordId(input.recordId) ||
    typeof input.field !== 'string' || !/^[a-z][a-z0-9_]{0,64}$/.test(input.field) ||
    ![input.from, input.to].every(value => value === null || Actions.text(value, 12000, true))) fail('Invalid canonical field-change event.');
  return {eventId:input.eventId, recordId:input.recordId, field:input.field, from:input.from, to:input.to, occurredAt:instant(input.occurredAt)};
}

function validateState(input) {
  if (!Actions.exact(input, ['version','id','spec','status','revision','createdAt','updatedAt','activatedAt','executions','history']) ||
    input.version !== 1 || !Actions.workflowId(input.id) || !['draft','active','paused'].includes(input.status) ||
    !Number.isSafeInteger(input.revision) || input.revision < 1 || !Array.isArray(input.executions) || !Array.isArray(input.history) ||
    input.history.length !== input.revision) fail('Invalid persisted workflow state.');
  const spec = Actions.validateWorkflowSpec(input.spec);
  const createdAt = instant(input.createdAt), updatedAt = instant(input.updatedAt);
  const activatedAt = input.activatedAt === null ? null : instant(input.activatedAt);
  if (createdAt !== input.createdAt || updatedAt !== input.updatedAt || activatedAt !== input.activatedAt ||
    updatedAt < createdAt || activatedAt !== null && (activatedAt < createdAt || activatedAt > updatedAt) ||
    input.status === 'active' && activatedAt === null) fail('Invalid workflow lifecycle timestamps.');
  const attemptsByEvent = new Map();
  for (const execution of input.executions) {
    if (!Actions.exact(execution, ['event','eventHash','status','attempts','reason','taskId','dueDate','lastAttemptAt']) ||
      !Object.hasOwn(outcomes, execution.status) || !outcomes[execution.status].includes(execution.reason) ||
      !Number.isSafeInteger(execution.attempts) || execution.attempts < 1) fail('Invalid persisted execution.');
    const event = validateEvent(execution.event);
    const attemptedAt = instant(execution.lastAttemptAt);
    if (attemptsByEvent.has(event.eventId) || execution.eventHash !== hash(event) || event.occurredAt !== execution.event.occurredAt ||
      attemptedAt !== execution.lastAttemptAt || attemptedAt > updatedAt || attemptedAt < event.occurredAt) fail('Invalid persisted execution identity or timestamp.');
    if (execution.status === 'succeeded' ? execution.taskId !== taskId(input.id, event.eventId) ||
      !execution.dueDate || !Todo.validDate(execution.dueDate) : execution.taskId !== null || execution.dueDate !== null) fail('Invalid persisted task result.');
    attemptsByEvent.set(event.eventId, []);
  }
  let previousTime = createdAt, lifecycleStatus = 'draft';
  for (const entry of input.history) {
    if (!Actions.exact(entry, ['type','at','eventId','attempt','status','reason','taskId', ...(entry?.type === 'trigger_renamed' ? ['change'] : [])]) ||
      !['created','activated','paused','execution','trigger_renamed'].includes(entry.type)) fail('Invalid workflow history.');
    const at = instant(entry.at);
    if (at !== entry.at || at < previousTime || at > updatedAt) fail('Invalid workflow history order.');
    previousTime = at;
    if (entry.type === 'execution') {
      if (!attemptsByEvent.has(entry.eventId) || !Number.isSafeInteger(entry.attempt) || entry.attempt < 1 ||
        !Object.hasOwn(outcomes, entry.status) || !outcomes[entry.status].includes(entry.reason) ||
        (entry.status === 'succeeded' ? entry.taskId !== taskId(input.id, entry.eventId) : entry.taskId !== null)) fail('Invalid execution history.');
      attemptsByEvent.get(entry.eventId).push(entry);
    } else {
      if (entry.eventId !== null || entry.attempt !== null || entry.reason !== null || entry.taskId !== null) fail('Invalid lifecycle history.');
      if (entry.type === 'trigger_renamed') {
        require('./schema-changes').validate([entry.change]);
        if (entry.status !== lifecycleStatus || entry.change.fieldId !== spec.trigger.field) fail('Invalid workflow rename history.');
      } else {
        if (entry.status !== ({created:'draft', activated:'active', paused:'paused'})[entry.type]) fail('Invalid activation history.');
        lifecycleStatus = entry.status;
      }
    }
  }
  if (input.history[0].type !== 'created' || input.history[0].at !== createdAt || previousTime !== updatedAt) fail('Invalid workflow history boundary.');
  for (const execution of input.executions) {
    const attempts = attemptsByEvent.get(execution.event.eventId);
    const last = attempts.at(-1);
    if (attempts.length !== execution.attempts || attempts.some((entry, i) => entry.attempt !== i + 1 || i < attempts.length - 1 && entry.status !== 'failed') ||
      last.status !== execution.status || last.reason !== execution.reason || last.at !== execution.lastAttemptAt || last.taskId !== execution.taskId) fail('Execution and history disagree.');
  }
  let renamedOption = spec.trigger.to;
  for (const entry of input.history.filter(entry => entry.type === 'trigger_renamed').reverse()) {
    if (entry.change.to !== renamedOption) fail('Workflow trigger and rename history disagree.');
    renamedOption = entry.change.from;
  }
  const lifecycle = input.history.filter(entry => !['execution','trigger_renamed'].includes(entry.type));
  if (lifecycle.at(-1).status !== input.status || lifecycle.slice(1).some(entry => entry.type === 'created') ||
    (lifecycle.filter(entry => entry.type === 'activated').at(-1)?.at ?? null) !== activatedAt) fail('Activation and history disagree.');
  return {...clone(input), spec};
}

function validateCollection(workflows) {
  if (!Array.isArray(workflows)) fail('Provide the current persisted workflows.');
  const values = workflows.map(validateState);
  if (new Set(values.map(item => item.id)).size !== values.length) fail('Repeated workflow ID.');
  return values;
}

function lifecycleEntry(type, at, status) {
  return {type, at, eventId:null, attempt:null, status, reason:null, taskId:null};
}

function plan(action, {workflows = [], schema = null, customFields = []} = {}) {
  if (!['create_workflow','set_workflow_activation','workflow_history'].includes(action?.action)) fail('Expected a workflow action.');
  return Actions.plan(action, {workflows:validateCollection(workflows), schema, customFields});
}

function apply(proposal, {workflows, id, now, schema = null, customFields = []}) {
  const current = validateCollection(workflows), at = instant(now);
  if (proposal?.kind !== 'workflow') fail('Invalid workflow proposal.');
  let workflow;
  if (proposal.operation === 'create') {
    if (!Actions.workflowId(id) || current.some(item => item.id === id)) fail('Provide a new unique workflow ID.');
    workflow = {version:1, id, spec:Actions.validateWorkflowSpec(proposal.spec, schema, customFields), status:'draft', revision:1,
      createdAt:at, updatedAt:at, activatedAt:null, executions:[], history:[lifecycleEntry('created', at, 'draft')]};
    return {kind:'workflow', workflows:[...current, workflow], workflow, baseRevision:null, count:1};
  }
  if (proposal.operation !== 'activation' || typeof proposal.active !== 'boolean') fail('Invalid workflow activation proposal.');
  const before = current.find(item => item.id === proposal.workflowId);
  if (!before || before.revision !== proposal.baseRevision) fail('The workflow changed. Review a fresh activation proposal.');
  if (at < before.updatedAt) fail('The controlled clock precedes the saved workflow.');
  if (proposal.active) Actions.validateWorkflowSpec(before.spec, schema, customFields);
  const status = proposal.active ? 'active' : 'paused';
  if (before.status === status) return {kind:'workflow', workflows:current, workflow:before, baseRevision:before.revision, count:0};
  workflow = {...before, status, revision:before.revision + 1, updatedAt:at,
    activatedAt:proposal.active ? at : before.activatedAt,
    history:[...before.history, lifecycleEntry(proposal.active ? 'activated' : 'paused', at, status)]};
  return {kind:'workflow', workflows:current.map(item => item.id === workflow.id ? workflow : item), workflow, baseRevision:before.revision, count:1};
}

function taskId(workflowId, eventId) {
  return 'todo_wf_' + hash([workflowId, eventId]).slice(0, 48);
}

function eventDueDate(occurredAt, timezone, offsetDays) {
  const at = instant(occurredAt);
  if (!Actions.validTimezone(timezone) || !Number.isInteger(offsetDays) || offsetDays < 0 || offsetDays > 3650) fail('Invalid event-date offset or timezone.');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone:timezone, calendar:'gregory', numberingSystem:'latn', era:'short', year:'numeric', month:'2-digit', day:'2-digit'
  }).formatToParts(new Date(at)).map(part => [part.type, part.value]));
  const localDate = `${parts.year.padStart(4, '0')}-${parts.month}-${parts.day}`;
  if (parts.era !== 'AD' || !Todo.validDate(localDate)) fail('The event date is outside the supported range.');
  const date = new Date(localDate + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + offsetDays);
  const result = date.toISOString().slice(0, 10);
  if (!Todo.validDate(result)) fail('The task due date is outside the supported range.');
  return result;
}

function handleEvent({workflow:input, event:rawEvent, records, cards, schema = null, customFields = [], now}) {
  const workflow = validateState(input), event = validateEvent(rawEvent), at = instant(now);
  if (!Array.isArray(records) || !Array.isArray(cards) || records.some(record => !Actions.recordId(record?.id)) ||
    new Set(records.map(record => record.id)).size !== records.length) fail('Provide a complete current record and task snapshot.');
  if (at < workflow.updatedAt || at < event.occurredAt) fail('The controlled clock precedes the workflow or event.');
  const previous = workflow.executions.find(item => item.event.eventId === event.eventId), eventHash = hash(event);
  if (previous && previous.eventHash !== eventHash) fail('This eventId was already used for a different event.');
  if (previous && previous.status !== 'failed') {
    return {kind:'workflow_execution', baseRevision:workflow.revision, workflow, cards:clone(cards), additions:[], execution:clone(previous), duplicate:true};
  }
  const all = Todo.validate(cards, records), record = records.find(item => item.id === event.recordId), spec = workflow.spec;
  // Preserve the original event identity/date while interpreting a failed
  // execution through explicit renames committed after its first attempt.
  let from = event.from, to = event.to, seen = false;
  if (previous) for (const entry of workflow.history) {
    if (entry.type === 'execution' && entry.eventId === event.eventId) seen = true;
    else if (seen && entry.type === 'trigger_renamed' && entry.change.fieldId === event.field) {
      if (from === entry.change.from) from = entry.change.to;
      if (to === entry.change.from) to = entry.change.to;
    }
  }
  let nextCards = all, additions = [];
  const finish = (status, reason, task = null) => {
    const execution = {event, eventHash, status, attempts:(previous?.attempts || 0) + 1, reason,
      taskId:task?.id || null, dueDate:task?.dueDate || null, lastAttemptAt:at};
    const history = {type:'execution', at, eventId:event.eventId, attempt:execution.attempts, status, reason, taskId:execution.taskId};
    return {kind:'workflow_execution', baseRevision:workflow.revision,
      workflow:{...workflow, revision:workflow.revision + 1, updatedAt:at,
        executions:previous ? workflow.executions.map(item => item.event.eventId === event.eventId ? execution : item) : [...workflow.executions, execution],
        history:[...workflow.history, history]},
      cards:nextCards, additions, execution, duplicate:false};
  };
  if (workflow.status !== 'active') return finish('skipped', 'inactive');
  if (event.occurredAt < workflow.activatedAt) return finish('skipped', 'before_activation');
  if (event.field !== spec.trigger.field || from === to || to !== spec.trigger.to) return finish('skipped', 'trigger_not_matched');
  try { Actions.validateWorkflowSpec(spec, schema, customFields); }
  catch { return finish('failed', 'schema_changed'); }
  if (!record) return finish('skipped', 'record_missing');
  if (record[spec.trigger.field] !== spec.trigger.to) return finish('skipped', 'record_no_longer_matches');
  if (all.some(card => card.recordId === record.id && card.status !== 'Done' && Actions.taskMatches(card, spec.conditions[0].match))) return finish('skipped', 'open_task_exists');
  const id = taskId(workflow.id, event.eventId);
  if (all.some(card => card.id === id)) return finish('failed', 'task_id_conflict');
  if (all.length >= 2000) return finish('failed', 'board_capacity');
  let dueDate;
  try { dueDate = eventDueDate(event.occurredAt, spec.timezone, spec.action.due.offsetDays); }
  catch { return finish('failed', 'due_date_out_of_range'); }
  const task = {...Todo.create(id, record.id), nextAction:spec.action.nextAction, notes:spec.action.notes, dueDate};
  nextCards = Todo.validate([...all, task], records);
  additions = [task];
  return finish('succeeded', 'task_created', task);
}

module.exports = {plan, apply, handleEvent, validateState, validateEvent, eventDueDate, taskId};
