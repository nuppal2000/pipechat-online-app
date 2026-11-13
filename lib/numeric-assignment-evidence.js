'use strict';

const Core=require('../public/pipeline-core');
const definition='numeric_field_definition',assignment='literal_numeric_assignment';
const outputs=Object.freeze([definition,assignment]);
const instructions='Numeric column creation and supplied literal numeric assignments are compiled_action outcomes, not saved-data reads. Use numeric_field_definition at the add_field step for the exact new column name and type number. A standalone blank column needs only that definition proof, with zero populated cells and every existing row blank; do not invent a requirement for record names or numeric assignments. For assignments to either a new or existing number field, map each supplied record name/ID and amount to literal_numeric_assignment at its update_records step in computed.numericAssignmentEvidence. Compare the complete selected cells (original primary name, ID, name match count, field ID, before and final numeric after) to the request; zero is not blank. A no-op numeric assignment still has a cell proof, even when it has no patch. For a name without an explicit ID require an unambiguous original name. Check for missing, extra or swapped assignments, including nonvisible records; the definition gives the full final blank and populated counts for a new column. A request to leave the other cells in the new column blank is a condition on these final values, not a claim that whole records or the schema stayed unchanged. Existing-field edits must preserve the schema and every unmentioned cell; do not clear populated cells merely to satisfy a leave-blank instruction. Reject mismatches or missing proofs; do not use planner labels, selection IDs, generic empty outputs, or names/fields read projections to prove the write. Independently requested saved-data answers still require real read evidence.';

// Only called after Plan.prepare, with its complete materialized result. Step
// labels, goal text, display names on selections and patch summaries are not inputs.
function collect(action,pipeline,review,next){
  const core=Core.create(pipeline.tableSchema),finalCore=Core.create(next.tableSchema);
  const primary=core.role('primary'),fields=new Map(finalCore.definitions(next.customFields).map(f=>[f.id,f]));
  if(primary!==finalCore.role('primary')||!action.steps.some(s=>s.op==='add_field'&&s.type==='number'||
    s.op==='update_records'&&s.assignments.some(a=>a.operation==='set'&&fields.get(a.field)?.type==='number')))return [];
  const originalFields=new Set(core.definitions(pipeline.customFields||[]).map(f=>f.id));
  const before=new Map(pipeline.records.map(r=>[r.id,r])),after=new Map(next.records.map(r=>[r.id,r]));
  if(before.size!==pipeline.records.length||after.size!==next.records.length||before.size!==after.size||
    [...before.keys()].some(id=>!Number.isSafeInteger(id)||!after.has(id)))return [];
  const nameCounts=new Map();
  for(const row of before.values()){
    const key=core.normalize(row[primary]);nameCounts.set(key,(nameCounts.get(key)||0)+1);
  }
  const steps=new Map(review.map(s=>[s.id,s])),added=new Map(),proofs=new Map();
  for(const s of action.steps.filter(s=>s.op==='add_field')){
    const created=steps.get(s.id)?.field,field=fields.get(created?.id);
    if(!field||field.type!=='number'||created.type!==field.type||created.name!==field.name||originalFields.has(field.id))continue;
    if(pipeline.records.some(row=>Object.hasOwn(row,field.id))||next.records.some(row=>!Object.hasOwn(row,field.id)||row[field.id]!==null&&!Number.isFinite(row[field.id])))continue;
    added.set(s.id,field.id);
    const blankCount=next.records.filter(row=>row[field.id]===null).length;
    proofs.set(s.id,{stepId:s.id,output:definition,fieldId:field.id,fieldName:field.name,fieldType:field.type,
      recordCount:after.size,blankCount,populatedCount:after.size-blankCount});
  }

  // Final equality alone is insufficient: an intervening write can overwrite
  // and later restore a value. Attribute a cell only to its last writer.
  const written=new Map(),newIds=new Set(added.values());
  for(const step of action.steps.filter(s=>s.op==='update_records').reverse()){
    const selection=steps.get(step.selection),selected=selection?.records,cells=[];
    if(selection?.op!=='select_records'||!Array.isArray(selected)||selected.length!==steps.get(step.id)?.count||
      new Set(selected.map(r=>r.id)).size!==selected.length||selected.some(r=>!before.has(r.id)))return [];
    // Do not expose a truncated sample as proof of a complete assignment.
    let eligible=selected.length>0&&selected.length*step.assignments.length<=200;
    for(const a of [...step.assignments].reverse()){
      const id=a.field.startsWith('@')?added.get(a.field.slice(1)):a.field,field=fields.get(id);
      if(field?.type!=='number'||!originalFields.has(id)&&!newIds.has(id)){eligible=false;continue;}
      const literal=a.operation==='set'&&['number','string'].includes(typeof a.value)
        ?finalCore.validateStoredValue(id,a.value,next.customFields):null;
      if(!Number.isFinite(literal))eligible=false;
      if(!written.has(id))written.set(id,new Set());
      const touched=written.get(id);
      for(const {id:recordId} of selected){
        const original=before.get(recordId),final=after.get(recordId);
        if(touched.has(recordId)||!original||!final||original[primary]!==final[primary]||final[id]!==literal)eligible=false;
        touched.add(recordId);
        if(eligible)cells.push({recordId,primaryName:original[primary]??null,nameMatchCount:nameCounts.get(core.normalize(original[primary])),
          fieldId:id,fieldName:field.name,fieldType:field.type,before:original[id]??null,after:final[id]});
      }
    }
    if(eligible)proofs.set(step.id,{stepId:step.id,output:assignment,selection:step.selection,primaryField:primary,cells});
  }
  return action.steps.flatMap(s=>proofs.has(s.id)?[proofs.get(s.id)]:[]);
}

function supports(evidence,ids,required){
  return Array.isArray(evidence)&&ids.length>0&&new Set(ids).size===ids.length&&required.length>0&&required.every(o=>outputs.includes(o))&&
    ids.every(id=>evidence.some(p=>p.stepId===id&&required.includes(p.output)))&&required.every(o=>evidence.some(p=>p.output===o&&ids.includes(p.stepId)));
}

module.exports={outputs,instructions,collect,supports};
