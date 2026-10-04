'use strict';

function models(env = process.env) {
  return {simple: env.PIPECHAT_SIMPLE_MODEL || 'gpt-5.4-mini', complex: env.PIPECHAT_COMPLEX_MODEL || env.PIPECHAT_MODEL || 'gpt-5.2'};
}

function route(payload, configured = models()) {
  const choose = (tier, reason) => ({tier, model: configured[tier], reason});
  if (payload.tableBuild || payload.spreadsheetBuild || payload.csvImport) return choose('complex', 'schema_or_import');
  const pending = payload.pendingClarification;
  const command = [pending?.originalCommand, ...(pending?.answers || []).map(a => a.answer), payload.userCommand].filter(Boolean).join('\n').toLowerCase();
  if (payload.pendingAction?.action === 'workspace_plan' || payload.pendingAction?.action === 'dashboard_plan') return choose('complex', 'compound_continuation');
  if (command.length > 650) return choose('complex', 'long_request');
  if (/\b(all|both|every|multiple)\b/.test(command) && /\b(set|update|assign|delete|move|change|edit|populate)\b/.test(command)) return choose('complex', 'bulk_mutation');
  if (/\b(each|for every|for each|business days?|percent(?:age)?|ratio|difference|audit|median|rank|highest|lowest|top \d+|bottom \d+)\b/.test(command)) return choose('complex', 'dependent_selection_or_analysis');
  if (/\b(two|three|four|five|multiple|several|\d+)\s+(?:different\s+)?(?:graphs?|charts?|tasks?|cards?|records?|deals?|kpis?)\b/.test(command)) return choose('complex', 'multiple_objects');
  const verbs = command.match(/\b(?:add|create|set|update|change|delete|remove|move|rename|convert|populate|build|show|compare|calculate|report|summarize|explain|identify)\b/g) || [];
  if (verbs.length > 1 && /\b(and|then|also|after|before|while)\b|[;\n]/.test(command)) return choose('complex', 'multiple_operations');
  if (/\b(if|unless|otherwise|depending|at least|at most)\b/.test(command) && /\b(set|populate|assign|create|add|update)\b/.test(command)) return choose('complex', 'conditional_write');
  if (/\b(graphs|charts|elements)\b/.test(command) && (payload.pipeline?.dashboard?.board?.elements?.length || 0) > 1) return choose('complex', 'multi_graph_context');
  return choose('simple', 'single_request');
}

function needsEscalation(result) {
  const action = result?.crmAction;
  return action?.action === 'workspace_plan' || action?.action === 'analyze_dashboard' ||
    action?.action === 'dashboard_plan' && (action.operations?.length > 1 || action.questions?.length > 1) ||
    action?.action === 'audit_records' && action.groups?.length > 1;
}

module.exports = {models, route, needsEscalation};
