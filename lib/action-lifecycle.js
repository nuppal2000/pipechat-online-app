'use strict';

const crypto = require('node:crypto');
const readActions = new Set(['query_records','query_todos','audit_records','analyze_dashboard','show_kpi','query_business','workflow_history','create_document']);
const viewActions = new Set(['dashboard_plan','show_report','refine_report','filter_records','clear_table_view']);
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key)+':'+canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function describe(action, computed, workspaceVersion = null) {
  const operation = !action ? 'conversation' : action.action === 'clarify' ? 'clarification' :
    action.action === 'workspace_plan' ? computed.mutates ? 'mutation' : computed.effects?.some(e=>e.kind==='dashboard'||e.show) ? 'view' : 'read' :
    readActions.has(action.action) ? 'read' : viewActions.has(action.action) ? 'view' : 'mutation';
  return {
    phase: 'proposed', operation, executed: false, writesApplied: 0,
    requiresConfirmation: operation === 'mutation',
    confirmation: operation === 'mutation' ? 'not_requested_yet' : 'not_applicable',
    authorization: 'prepare_only', workspaceVersion,
    planId: crypto.createHash('sha256').update(canonical({action:action??null,workspaceVersion})).digest('hex')
  };
}
function normalizeResult(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('The assistant returned an invalid result.');
  const result = {...input};
  const meaningful = value => typeof value === 'string' && value.trim() && !/^(none|null|undefined)$/i.test(value.trim());
  if (result.crmAction?.action === 'clarify') {
    if (!meaningful(result.crmAction.question)) throw new Error('The clarification was empty. Return an explicit supported proposal, a concrete question, or an honest unsupported explanation.');
    result.assistantMessage = result.crmAction.question.trim();
  } else if (!meaningful(result.assistantMessage)) {
    if (!result.crmAction) throw new Error('The assistant returned neither a usable answer nor a supported action.');
    result.assistantMessage = 'Please review the proposed result.';
  }
  return result;
}
module.exports = {canonical,describe,normalizeResult};
