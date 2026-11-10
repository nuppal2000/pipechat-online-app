'use strict';

// A valid visual plan can have a bad citation. Repair the citations against the
// same snapshot; never re-plan, remove an obligation, or clear a review issue here.
function eligible(action,review,coverage,computed){
  const numeric=action?.action==='workspace_plan'&&Array.isArray(action.steps)&&Array.isArray(computed?.numericAssignmentEvidence)&&
    action.steps.some(s=>s.op==='add_field')&&action.steps.every(s=>s.op==='select_records'||
      ['add_field','update_records'].includes(s.op)&&computed.numericAssignmentEvidence.some(e=>e.stepId===s.id));
  return (action?.action==='dashboard_plan'||numeric)&&!coverage?.ok&&coverage?.mappingReasons?.unsupported_required_output>0&&
    review?.answerIntent==='canonical'&&!review.answerSelection&&!review.clarificationQuestion&&
    review.issues?.length===0&&review.requirements?.length>0&&review.requirements.every(r=>r.satisfied);
}
function sameObligations(before,after){
  if(!after||after.clarificationQuestion||after.issues?.length!==0||after.answerSelection||
    after.answerIntent!=='canonical'||!Array.isArray(after.requirements)||before.requirements.length!==after.requirements.length)return false;
  return before.requirements.every((r,i)=>{
    const next=after.requirements[i];
    return next?.satisfied&&next.description===r.description&&next.evidenceKind===r.evidenceKind&&Array.isArray(next.requiredOutputs)&&Array.isArray(r.requiredOutputs)&&
      JSON.stringify([...next.requiredOutputs].sort())===JSON.stringify([...r.requiredOutputs].sort());
  });
}
module.exports={eligible,sameObligations};
