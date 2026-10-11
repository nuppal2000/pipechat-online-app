(function(root, factory) {
  const Core = typeof module === 'object' && module.exports ? require('./pipeline-core.js') : root.PipelineCore;
  const api = factory(Core);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PipeChatBusinessActions = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(Core) {
  'use strict';

  const object = properties => ({type:'object', additionalProperties:false, properties, required:Object.keys(properties)});
  const literal = value => ({type:typeof value, enum:[value]});
  const string = maxLength => ({type:'string', minLength:1, maxLength});
  const clone = value => JSON.parse(JSON.stringify(value));
  const norm = value => value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
  const fail = message => { throw new Error(message); };
  function exact(value, keys) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) &&
      Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
  }
  function text(value, max, blank = false) {
    return typeof value === 'string' && value.length <= max && (blank || !!value.trim()) &&
      !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
  }
  const recordId = value => Number.isSafeInteger(value) && value > 0;
  const workflowId = value => typeof value === 'string' && /^workflow_[a-z0-9_]{1,60}$/.test(value);
  const fieldId = value => typeof value === 'string' && /^[a-z][a-z0-9_]{0,64}$/.test(value) && !['constructor','prototype','__proto__'].includes(value);
  const terms = Object.freeze({
    provider:'Provider', scope:'Scope and deliverables', price:'Price', currency:'Currency',
    paymentTerms:'Payment terms', timeline:'Delivery timeline', validUntil:'Proposal validity',
    taxes:'Taxes', exclusions:'Exclusions'
  });

  function actionSchemas() {
    const match = object({field:literal('nextAction'), operator:{type:'string', enum:['equals','contains']}, value:string(12000)});
    const spec = object({
      version:literal(1), name:string(120), timezone:string(100),
      trigger:object({type:literal('field_changes_to'), field:string(65), to:string(80)}),
      conditions:{type:'array', minItems:1, maxItems:1, items:object({type:literal('no_open_qualifying_task'), match})},
      action:object({type:literal('create_linked_task'), nextAction:string(12000), notes:{type:'string', maxLength:16000},
        due:object({anchor:literal('event_date'), offsetDays:{type:'integer', minimum:0, maximum:3650}})})
    });
    return [
      object({action:literal('create_document'), recordId:{type:'integer', minimum:1}, documentType:literal('proposal'), format:literal('html')}),
      object({action:literal('create_workflow'), spec}),
      object({action:literal('set_workflow_activation'), workflowId:string(69), active:{type:'boolean'}}),
      object({action:literal('workflow_history'), workflowId:string(69), limit:{type:'integer', minimum:1, maximum:200}})
    ];
  }

  function validateDocumentAction(action) {
    if (!exact(action, ['action','recordId','documentType','format']) || action.action !== 'create_document' ||
      !recordId(action.recordId) || action.documentType !== 'proposal' || action.format !== 'html') {
      fail('Choose one canonical record and a proposal in HTML format. Document prose and commercial terms must come from its fact bundle.');
    }
    return clone(action);
  }

  // Caller builds this curated bundle from its authorized canonical record. Term values
  // are fact references, not model-written prose or guesses based on column labels.
  function validateFactBundle(input) {
    if (!exact(input, ['recordId','recordName','revision','facts','terms']) || !recordId(input.recordId) ||
      !text(input.recordName, 500) || !text(input.revision, 200) || !Array.isArray(input.facts) || input.facts.length > 120 ||
      !input.terms || typeof input.terms !== 'object' || Array.isArray(input.terms) ||
      Object.keys(input.terms).some(key => !Object.hasOwn(terms, key))) fail('Invalid canonical record fact bundle.');
    const ids = new Set();
    const facts = input.facts.map(fact => {
      if (!exact(fact, ['id','label','value']) || !fieldId(fact.id) || ids.has(fact.id) || !text(fact.label, 300) ||
        !(fact.value === null || typeof fact.value === 'number' && Number.isFinite(fact.value) ||
          typeof fact.value === 'boolean' || text(fact.value, 16000, true))) fail('Invalid canonical fact. Use unique IDs and literal scalar values.');
      ids.add(fact.id);
      return {id:fact.id, label:fact.label, value:fact.value};
    });
    const references = Object.fromEntries(Object.keys(terms).map(key => {
      const id = Object.hasOwn(input.terms, key) ? input.terms[key] : null;
      if (id !== null && !ids.has(id)) fail('A commercial term must reference a fact in this canonical bundle.');
      return [key, id];
    }));
    return {recordId:input.recordId, recordName:input.recordName, revision:input.revision, facts, terms:references};
  }

  const display = value => value === null || typeof value === 'string' && !value.trim() ? 'Unknown' : String(value);
  const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  function documentPreview(action, input) {
    validateDocumentAction(action);
    const bundle = validateFactBundle(input);
    if (action.recordId !== bundle.recordId) fail('The document record does not match the canonical fact bundle.');
    const byId = new Map(bundle.facts.map(fact => [fact.id, fact]));
    const commercialTerms = Object.entries(terms).map(([key, label]) => {
      const source = byId.get(bundle.terms[key]);
      const value = source ? display(source.value) : 'Unknown';
      return {key, label, value, sourceFactId:source?.id || null, unknown:value === 'Unknown'};
    });
    return {kind:'document', title:'Proposal', recordId:bundle.recordId, recordName:bundle.recordName,
      sourceRevision:bundle.revision, facts:bundle.facts.map(fact => ({...fact, value:display(fact.value)})),
      terms:commercialTerms, unknownTerms:commercialTerms.filter(term => term.unknown).map(term => term.key)};
  }

  function documentArtifact(action, input) {
    const preview = documentPreview(action, input);
    const rows = values => values.map(value => `<tr><th scope="row">${escapeHtml(value.label)}</th><td>${escapeHtml(value.value)}</td></tr>`).join('\n');
    const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Proposal - ${escapeHtml(preview.recordName)}</title>
<style>body{font:15px/1.5 Arial,sans-serif;color:#172b24;background:#fff;margin:32px auto;padding:0 24px;max-width:800px;overflow-wrap:anywhere}h1{font-size:28px}h2{font-size:19px;margin-top:28px}p,td{white-space:pre-wrap}table{border-collapse:collapse;width:100%;table-layout:fixed}th,td{text-align:left;vertical-align:top;border-bottom:1px solid #ccd4d0;padding:10px 8px}th{width:35%}.meta{font-size:12px;color:#4a5952}@page{size:A4;margin:18mm}@media print{body{margin:0;padding:0;font-size:11pt;max-width:none}h1,h2{break-after:avoid}tr{break-inside:avoid}thead{display:table-header-group}}</style>
</head><body><h1>Proposal</h1><p>${escapeHtml(preview.recordName)}</p>
<p class="meta">Record #${preview.recordId} | Source revision: ${escapeHtml(preview.sourceRevision)}</p>
<p>Draft for review. Unknown terms have not been supplied. No acceptance or external delivery is recorded by this document.</p>
<h2>Commercial terms</h2><table><tbody>${rows(preview.terms)}</tbody></table>
<h2>Provided record facts</h2><table><tbody>${rows(preview.facts)}</tbody></table>
</body></html>`;
    return {filename:`proposal-record-${preview.recordId}.html`, mimeType:'text/html; charset=utf-8', encoding:'utf-8', body};
  }

  function documentDownload(action, bundle, environment = globalThis) {
    const artifact = documentArtifact(action, bundle);
    const url = environment.URL.createObjectURL(new environment.Blob([artifact.body], {type:artifact.mimeType}));
    let revoked = false;
    return {url, filename:artifact.filename, mimeType:artifact.mimeType, revoke() {
      if (!revoked) { environment.URL.revokeObjectURL(url); revoked = true; }
    }};
  }

  function validTimezone(value) {
    if (!text(value, 100) || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+)*$/.test(value)) return false;
    try { new Intl.DateTimeFormat('en-US', {timeZone:value}).format(0); return true; } catch { return false; }
  }
  function taskMatches(task, match) {
    const value = norm(task.nextAction), wanted = norm(match.value);
    return match.operator === 'equals' ? value === wanted : value.includes(wanted);
  }
  function validateWorkflowSpec(input, schema, customFields = []) {
    if (!exact(input, ['version','name','timezone','trigger','conditions','action']) || input.version !== 1 ||
      !text(input.name, 120) || !validTimezone(input.timezone)) fail('A workflow needs a name, version 1 and a valid explicit timezone.');
    const trigger = input.trigger, action = input.action;
    if (!exact(trigger, ['type','field','to']) || trigger.type !== 'field_changes_to' || !fieldId(trigger.field) || !text(trigger.to, 80)) fail('Use a typed field_changes_to trigger with an existing choice option.');
    if (schema !== undefined) {
      if (schema?.status === 'pending') fail('Configure the table before proposing a workflow.');
      const fields = Core.create(schema).definitions(customFields), field = fields.find(item => item.id === trigger.field);
      if (!field || field.type !== 'choice' || !field.options.includes(trigger.to)) fail('The workflow trigger field or choice option no longer exists.');
    }
    if (!Array.isArray(input.conditions) || input.conditions.length !== 1) fail('Specify one no_open_qualifying_task condition.');
    const condition = input.conditions[0], match = condition?.match;
    if (!exact(condition, ['type','match']) || condition.type !== 'no_open_qualifying_task' ||
      !exact(match, ['field','operator','value']) || match.field !== 'nextAction' || !['equals','contains'].includes(match.operator) ||
      !text(match.value, 12000)) fail('Use a literal task-text comparison for the no-open-task condition.');
    if (!exact(action, ['type','nextAction','notes','due']) || action.type !== 'create_linked_task' ||
      !text(action.nextAction, 12000) || !text(action.notes, 16000, true) ||
      !exact(action.due, ['anchor','offsetDays']) || action.due.anchor !== 'event_date' ||
      !Number.isInteger(action.due.offsetDays) || action.due.offsetDays < 0 || action.due.offsetDays > 3650) fail('Create a linked task with an event-date offset of 0 to 3650 calendar days.');
    if (!taskMatches(action, match)) fail('The created task must qualify for the no-open-task condition.');
    return clone(input);
  }

  function workflowTriggerText(trigger, schema, customFields = []) {
    const labels = Core.create(schema).fieldsFor(customFields);
    const label = Object.hasOwn(labels, trigger.field) && labels[trigger.field].trim() ? labels[trigger.field] : `Unavailable field (${trigger.field})`;
    return `${label} changes to ${trigger.to}`;
  }

  function workflowPreview(spec, schema, customFields = []) {
    spec = validateWorkflowSpec(spec, schema, customFields);
    const label = schema === undefined ? spec.trigger.field : Core.create(schema).fieldsFor(customFields)[spec.trigger.field];
    return {kind:'workflow', title:spec.name, activation:'draft',
      trigger:`${label} changes to ${spec.trigger.to}`,
      condition:`No linked To Do or In Progress task whose next action ${spec.conditions[0].match.operator === 'equals' ? 'equals' : 'contains'} "${spec.conditions[0].match.value}"`,
      task:{nextAction:spec.action.nextAction, notes:spec.action.notes, status:'To Do'},
      due:`Event date + ${spec.action.due.offsetDays} calendar days (${spec.timezone})`};
  }

  function plan(action, context = {}) {
    if (action?.action === 'create_document') {
      const preview = documentPreview(action, context.factBundle);
      return {kind:'document', action:validateDocumentAction(action), recordId:preview.recordId, count:1,
        source:validateFactBundle(context.factBundle), artifact:documentArtifact(action, context.factBundle), preview};
    }
    if (action?.action === 'create_workflow') {
      if (!exact(action, ['action','spec'])) fail('A workflow proposal contains only its typed specification.');
      const spec = validateWorkflowSpec(action.spec, context.schema ?? null, context.customFields);
      return {kind:'workflow', operation:'create', spec, count:1, preview:workflowPreview(spec, context.schema ?? null, context.customFields)};
    }
    if (action?.action === 'set_workflow_activation' || action?.action === 'workflow_history') {
      const history = action.action === 'workflow_history';
      if (!exact(action, ['action','workflowId', history ? 'limit' : 'active']) || !workflowId(action.workflowId) ||
        (history ? !Number.isInteger(action.limit) || action.limit < 1 || action.limit > 200 : typeof action.active !== 'boolean')) fail('Invalid workflow activation or history action.');
      const workflow = context.workflows?.find(item => item.id === action.workflowId);
      if (!workflow) fail('That workflow no longer exists.');
      if (history) {
        const attempts = new Map(workflow.history.map((entry, index) => [entry.eventId, index]));
        return {kind:'workflow_history', workflowId:workflow.id, history:clone(workflow.history.slice(-action.limit).reverse()),
          executions:clone([...workflow.executions].sort((a, b) => attempts.get(b.event.eventId) - attempts.get(a.event.eventId)).slice(0, action.limit))};
      }
      if (action.active) validateWorkflowSpec(workflow.spec, context.schema ?? null, context.customFields);
      return {kind:'workflow', operation:'activation', workflowId:workflow.id, baseRevision:workflow.revision,
        active:action.active, count:1, preview:{kind:'workflow_activation', title:workflow.spec.name, active:action.active,
          trigger:workflowTriggerText(workflow.spec.trigger, context.schema, context.customFields)}};
    }
    fail('Unsupported business action.');
  }

  const instructions = [
    'For an actual downloadable proposal, return create_document with the resolved canonical record ID, documentType proposal and format html. Do not return none or claim a file was sent. The application generates the artifact from its trusted fact bundle; never put invented pricing, currency, payment, delivery or validity terms into an action.',
    'For automation, return create_workflow with a typed choice-field transition, one no_open_qualifying_task condition, and create_linked_task with an explicit event_date calendar-day offset and timezone. Use actual current field IDs/options. Open tasks mean To Do or In Progress, excluding Done; this is a fixed application rule, not a question for the user. For a new draft with no explicit timezone use the validated pipeline.timezone when available and disclose it in the review; otherwise ask. Use supplied task wording, or propose a concise task phrase faithful to the requested work when no exact title was specified. Missing trigger identity, business condition or delay still needs clarification. Do not substitute a report or claim the workflow is active.',
    'Workflow proposals create drafts only. set_workflow_activation is a separate reviewable action; workflow_history reads saved executions. Business actions do not email, publish, execute code, or deliver anything externally.'
  ].join('\n');

  return {actionSchemas, instructions, plan, validateDocumentAction, validateFactBundle, documentPreview, documentArtifact,
    documentDownload, validateWorkflowSpec, workflowPreview, workflowTriggerText, taskMatches, validTimezone, escapeHtml, exact, text, recordId, workflowId};
});
