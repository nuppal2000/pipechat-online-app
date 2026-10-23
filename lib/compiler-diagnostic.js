'use strict';

// Only fixed categories cross the operational-log boundary. Error messages and
// model-authored step labels may contain private business data.
const reasons = [
  ['goal_shape_invalid', 'Please list every requested outcome in the plan.'],
  ['field_unavailable', 'A step refers to an unavailable field.'],
  ['selection_dependency', 'Select records before using that selection'],
  ['record_selection_stale', 'A selected record no longer exists.'],
  ['task_selection_stale', 'A previously selected card no longer exists.'],
  ['task_reference_missing', 'No task matches '],
  ['task_reference_ambiguous', 'More than one task matches '],
  ['task_selection_invalid', 'Please specify the complete card selection.'],
  ['task_focus_unavailable', 'the previous card selection is unavailable.'],
  ['task_selection_empty', 'No cards match that selection.'],
  ['task_write_conflict', 'Two edits target the same card field '],
  ['task_no_changes', 'Every selected card already has the requested values.'],
  ['date_invalid', 'complete, valid calendar date'],
  ['date_offset_invalid', 'Choose a date offset of up to 366 days.'],
  ['numeric_field_required', 'Choose a numeric field for calculations.'],
  ['step_reference_invalid', 'Every requested outcome must refer to valid plan steps.'],
  ['goal_coverage_invalid', 'Some plan steps are not included in the requested-outcomes review.'],
  ['entity_reference_missing', 'That linked entity does not exist.'],
  ['primary_reference_missing', 'That primary record does not exist.'],
  ['entity_type_unavailable', 'Choose an existing entity type and identity field.'],
  ['entity_alias_unresolved', 'A relationship refers to an entity that has not been created or resolved.']
];
const actions = new Set(['workspace_plan','business_plan','query_business','query_business_batch','undo_action','dashboard_plan','analyze_dashboard','query_todos','audit_records','add_record','add_records','create_workflow','set_workflow_activation','workflow_history','create_document','clarify']);
const operations = new Set(['select_records','read_records','read_history','update_records','update_tasks','add_todos','add_unlinked_task','add_field','rename_choice_option','report','dashboard']);
const reasonCodes=new Set(reasons.map(([reason])=>reason));

function describe(error, action) {
  const message = typeof error?.message === 'string' ? error.message : '';
  const type = ['TypeError','RangeError','SyntaxError','TimeoutError'].includes(error?.name) ? error.name : 'Error';
  const reason=reasonCodes.has(error?.reasonCode)?error.reasonCode:reasons.find(([, fragment]) => message.includes(fragment))?.[0] || (type === 'Error' ? 'unclassified' : 'runtime_' + type.toLowerCase());
  const count=value=>Number.isSafeInteger(value)&&value>=0?Math.min(value,30):0;
  return {
    action: actions.has(action?.action) ? action.action : action == null ? 'none' : 'other',
    operation: operations.has(error?.compilerStep) ? error.compilerStep : null,
    reason,
    ...(['step_reference_invalid','goal_coverage_invalid'].includes(reason)&&error?.goalCoverage?{goalCoverage:{
      unknownReferences:count(error.goalCoverage.unknownReferences),uncoveredSelections:count(error.goalCoverage.uncoveredSelections),uncoveredOperations:count(error.goalCoverage.uncoveredOperations)
    }}:{})
  };
}
module.exports = {describe};
