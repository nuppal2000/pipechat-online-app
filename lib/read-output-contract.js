'use strict';

const kinds=Object.freeze(['count','names','fields','sum','average','median','distinct','min','max','groups','percentages','history','notes']);
const schema=Object.freeze({type:'array',maxItems:kinds.length,items:Object.freeze({type:'string',enum:kinds})});
const metrics=new Map(['count','sum','average','median','min','max'].map(kind=>[kind,kind])
  .concat([['count_distinct','distinct'],['percentage','percentages']]));
const graphId=value=>'graph:'+value;
const refinements=new Set(['title','chart','scope','groupBy','bucket','splitBy','measures','sort','limit']);
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const text=value=>typeof value==='string'&&value.length>0&&value.length<=256;
const id=value=>typeof value==='string'&&/^[a-z][a-z0-9_-]{0,63}$/.test(value);
const list=(value,max,min=0)=>Array.isArray(value)&&value.length>=min&&value.length<=max&&Array.from(value).every(item=>item!==undefined);
const exact=(value,keys)=>record(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const check=value=>{if(!value)throw new Error('Unsupported read output contract.');};
function ids(value,max=12){
  check(list(value,max,1)&&value.every(id)&&new Set(value).size===value.length);
  return value;
}
function merge(target,source){for(const value of source)target.add(value);return target;}

function measures(spec){
  check(record(spec)&&list(spec.measures,6,1));
  for(const measure of spec.measures){
    check(record(measure)&&metrics.has(measure.metric));
    check(['count','percentage'].includes(measure.metric)?measure.field===null:text(measure.field));
  }
  return spec.measures;
}
function graph(board,elementId){check(id(elementId)&&board.has(elementId));return measures(board.get(elementId));}
function measureAt(board,elementId,index){
  const values=graph(board,elementId);
  check(Number.isInteger(index)&&index>=0&&index<values.length);
  return values[index];
}
function boardFrom(pipeline){
  const board=new Map(),current=pipeline?.dashboard?.board;
  if(current==null)return board;
  check(record(current)&&list(current.elements,12));
  for(const element of current.elements){
    check(record(element)&&id(element.id)&&!board.has(element.id));
    measures(element.spec);board.set(element.id,element.spec);
  }
  return board;
}
function refined(spec,operation){
  check(['add_filter','replace_filter','remove_filter'].includes(operation.mode)&&list(operation.changes,9));
  const next={...spec},seen=new Set();
  for(const change of operation.changes){
    check(exact(change,['field','value'])&&refinements.has(change.field)&&!seen.has(change.field));
    seen.add(change.field);next[change.field]=change.value;
  }
  measures(next);return next;
}
function applyDashboard(board,action){
  check(action?.action==='dashboard_plan'&&list(action.operations,24,1));
  const next=new Map(board);
  for(const operation of action.operations){
    check(record(operation));
    switch(operation.op){
      case 'clear':next.clear();break;
      case 'add':
        check(id(operation.id)&&!next.has(operation.id));measures(operation.spec);
        next.set(operation.id,operation.spec);break;
      case 'update':
        for(const elementId of ids(operation.ids)){
          check(next.has(elementId));next.set(elementId,refined(next.get(elementId),operation));
        }
        break;
      case 'remove':
        for(const elementId of ids(operation.ids)){check(next.has(elementId));next.delete(elementId);}
        break;
      // Filters change populations, not the typed measures. The compiler validates them.
      case 'set_shared_filter':
        check(id(operation.id));for(const elementId of ids(operation.targets))check(next.has(elementId));break;
      case 'remove_shared_filter':check(id(operation.id));break;
      default:check(false);
    }
    check(next.size<=12);
  }
  return next;
}
function referenceOutputs(reference,board){
  check(exact(reference,reference?.stat==='group'?['elementId','measure','stat','group','series']:['elementId','measure','stat']));
  const measure=measureAt(board,reference.elementId,reference.measure);
  check(['records','aggregate','maximum','minimum_nonzero','group'].includes(reference.stat));
  if(reference.stat==='group')check(typeof reference.group==='string'&&reference.group.length<=300&&
    (reference.series===null||typeof reference.series==='string'&&reference.series.length<=300));
  const output=reference.stat==='records'?'count':reference.stat==='maximum'?'max':
    reference.stat==='minimum_nonzero'?'min':metrics.get(measure.metric);
  const outputs=new Set(['count',output]);
  if(reference.stat!=='records')outputs.add(metrics.get(measure.metric));
  // Extrema return the selected aggregate AND every tied group label.
  if(['maximum','minimum_nonzero','group'].includes(reference.stat)&&text(board.get(reference.elementId).groupBy))outputs.add('names');
  return {unit:reference.stat==='records'?'records':JSON.stringify([measure.metric,measure.field]),outputs};
}
function questionOutputs(questions,board){
  check(list(questions,20));
  const outputs=new Set();
  for(const question of questions){
    check(record(question));
    if(question.kind==='summary'){
      check(exact(question,['kind','elementIds']));
      for(const elementId of ids(question.elementIds)){
        for(const measure of graph(board,elementId))outputs.add(metrics.get(measure.metric));
        outputs.add('count');
      }
    }else if(question.kind==='groups'||question.kind==='group_percentages'){
      const percentages=question.kind==='group_percentages';
      check(exact(question,percentages?['kind','elementId','measure','denominator']:['kind','elementId','measure']));
      const measure=measureAt(board,question.elementId,question.measure);
      outputs.add('groups');outputs.add('count');
      if(text(board.get(question.elementId).groupBy))outputs.add('names');
      if(percentages){
        check(['matching_records','measure_total'].includes(question.denominator));
        check(question.denominator!=='measure_total'||['count','sum'].includes(measure.metric));
        outputs.add('percentages');
      }
      if(!percentages||question.denominator==='measure_total')outputs.add(metrics.get(measure.metric));
    }else if(question.kind==='value'){
      check(exact(question,['kind','label','reference'])&&typeof question.label==='string'&&question.label.length<=200);
      merge(outputs,referenceOutputs(question.reference,board).outputs);
    }else if(question.kind==='difference'||question.kind==='percentage'){
      check(exact(question,['kind','label','left','right'])&&typeof question.label==='string'&&question.label.length<=200);
      const left=referenceOutputs(question.left,board),right=referenceOutputs(question.right,board);
      check(left.unit===right.unit);merge(outputs,left.outputs);merge(outputs,right.outputs);
      if(question.kind==='percentage')outputs.add('percentages');
    }else check(false);
  }
  return outputs;
}
function displayedOutputs(spec){
  const outputs=new Set(['count']);
  for(const measure of measures(spec))outputs.add(metrics.get(measure.metric));
  if(text(spec.groupBy)){outputs.add('groups');outputs.add('names');}
  return outputs;
}
function questionComponents(questions,board){
  const outputs=questionOutputs(questions,board),components=new Map();
  const add=(elementId,values)=>{
    const key=graphId(elementId);if(!components.has(key))components.set(key,new Set());
    merge(components.get(key),values);
  };
  for(const question of questions){
    if(question.kind==='summary'){
      for(const elementId of question.elementIds)add(elementId,questionOutputs([{kind:'summary',elementIds:[elementId]}],board));
    }else if(question.kind==='value')add(question.reference.elementId,referenceOutputs(question.reference,board).outputs);
    else if(question.kind==='difference'||question.kind==='percentage'){
      // Cross-graph arithmetic belongs to the action, not either operand alone.
      add(question.left.elementId,referenceOutputs(question.left,board).outputs);
      add(question.right.elementId,referenceOutputs(question.right,board).outputs);
      if(question.left.elementId===question.right.elementId)add(question.left.elementId,questionOutputs([question],board));
    }else add(question.elementId,questionOutputs([question],board));
  }
  return {outputs,components};
}
function dashboardOutputs(action,board){
  check(list(action.questions,20));
  const next=applyDashboard(board,action);
  const questions=action.questions.length?action.questions:next.size?[{kind:'summary',elementIds:[...next.keys()]}]:[];
  const {outputs,components}=questionComponents(questions,next);
  // A displayed graph is itself computed output, even with summary-only questions.
  // Analysis-only actions below deliberately do not gain these display outputs.
  for(const [elementId,spec] of next){
    const key=graphId(elementId),shown=displayedOutputs(spec);
    if(!components.has(key))components.set(key,new Set());
    merge(components.get(key),shown);merge(outputs,shown);
  }
  return {board:next,outputs,components};
}
function directOutputs(outputs){
  check(list(outputs,40,1));
  const result=new Set();
  for(const output of outputs){
    check(exact(output,['kind','field'])&&kinds.slice(0,9).includes(output.kind));
    check(['count','names'].includes(output.kind)?output.field===null:text(output.field));
    result.add(output.kind);
  }
  return result;
}
function historyOutputs(step){
  check(exact(step,['op','id','label','selection','kind','from','to','limit']));
  check(['all','note','activity'].includes(step.kind)&&id(step.selection)&&typeof step.label==='string');
  const date=value=>value===null||typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&
    Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
  check(date(step.from)&&date(step.to)&&(step.from===null||step.to===null||step.from<=step.to));
  check(Number.isInteger(step.limit)&&step.limit>=1&&step.limit<=500);
  const outputs=new Set(['count','names','fields','history']);
  if(step.kind!=='activity')outputs.add('notes');
  return outputs;
}
function workspaceOutputs(action,stepIds,pipeline){
  check(list(action.steps,30,1));
  const available=new Set();
  for(const step of action.steps){check(record(step)&&id(step.id)&&!available.has(step.id));available.add(step.id);}
  const components=new Map();let board=boardFrom(pipeline);
  for(const step of action.steps){
    let current=new Set();
    if(step.op==='read_records')current=directOutputs(step.outputs);
    else if(step.op==='read_history')current=historyOutputs(step);
    else if(step.op==='report'){
      measures(step.spec);check(typeof step.showDashboard==='boolean');
      const report=new Map([[step.id,step.spec]]);
      current=questionOutputs(step.questions,report);
      if(step.showDashboard){board=report;merge(current,displayedOutputs(step.spec));}
    }else if(step.op==='dashboard'){
      const result=dashboardOutputs(step.plan,board);board=result.board;current=result.outputs;
      for(const [key,value] of result.components)components.set(step.id+'/'+key,value);
    }else check(['select_records','add_field','rename_choice_option','update_records','add_todos','add_unlinked_task','update_tasks'].includes(step.op));
    components.set(step.id,current);
  }
  if(stepIds===null)return components;
  check(stepIds.every(stepId=>components.has(stepId)));
  const outputs=new Set();for(const stepId of stepIds)merge(outputs,components.get(stepId));
  return outputs;
}

function evidenceIds(action,context={}){
  try{
    check(record(context));
    if(action?.action==='workspace_plan')return [...workspaceOutputs(action,null,context.pipeline).keys()];
    if(action?.action==='query_business_batch'){
      const queryIds=ids(action.queries.map(query=>query.id),20);check(!queryIds.includes('root'));return queryIds.slice();
    }
    if(action?.action==='dashboard_plan')return ['root',...dashboardOutputs(action,boardFrom(context.pipeline)).components.keys()];
    if(action?.action==='analyze_dashboard')return ['root',...questionComponents(action.questions,boardFrom(context.pipeline)).components.keys()];
    return ['root'];
  }catch{return [];}
}

/**
 * Check required output kinds AFTER normal compiler/evidence validation, never prose.
 * stepIds selects workspace steps, business query IDs, or graph:<elementId>.
 * Nested dashboard components use <stepId>/graph:<elementId>. root retains the
 * whole direct-action contract, including cross-graph comparisons. Component
 * references cannot borrow sibling outputs. evidenceIds supplies canonical IDs.
 * Explicit [] passes (noncomputed requirements); missing/malformed arrays fail.
 * This does not prove field/population coverage, numeric values, denominator scope,
 * conflict safety or authorization. Those remain compiler and semantic-review duties.
 * pipeline.dashboard.board supplies current specs; absent/unknown graphs fail closed.
 * Inputs are not mutated. Invalid/unsupported contracts return false, never throw.
 */
function supports(action,stepIds,requiredOutputs,context={}){
  try{
    check(record(context));const {pipeline}=context;
    check(list(requiredOutputs,kinds.length)&&requiredOutputs.every(kind=>kinds.includes(kind))&&new Set(requiredOutputs).size===requiredOutputs.length);
    if(!requiredOutputs.length)return true;
    check(list(stepIds,30,1)&&stepIds.every(text)&&new Set(stepIds).size===stepIds.length);check(record(action));
    let outputs;
    if(action.action==='workspace_plan')outputs=workspaceOutputs(action,stepIds,pipeline);
    else if(action.action==='query_business_batch'){
      check(list(action.queries,20,1));const queryIds=ids(action.queries.map(query=>query?.id),20);
      check(!queryIds.includes('root')&&stepIds.every(stepId=>queryIds.includes(stepId)));
      outputs=new Set(['count','names','fields']);
    }else if(action.action==='dashboard_plan'||action.action==='analyze_dashboard'){
      const board=boardFrom(pipeline),result=action.action==='dashboard_plan'?dashboardOutputs(action,board):questionComponents(action.questions,board);
      outputs=new Set();
      for(const stepId of stepIds){
        check(stepId==='root'||result.components.has(stepId));
        merge(outputs,stepId==='root'?result.outputs:result.components.get(stepId));
      }
    }else{
      check(stepIds.length===1&&stepIds[0]==='root');
      switch(action.action){
        case 'show_kpi':case 'show_report':{
          const spec=action.action==='show_kpi'?action:action.smartReport;
          measures(spec);outputs=questionOutputs([{kind:'summary',elementIds:['answer']}],new Map([['answer',spec]]));break;
        }
        case 'refine_report':{
          const board=boardFrom(pipeline),active=pipeline?.dashboard?.board?.activeId;
          check(board.has(active));board.set(active,refined(board.get(active),action));
          outputs=questionOutputs([{kind:'summary',elementIds:[active]}],board);break;
        }
        case 'query_business':case 'query_todos':outputs=new Set(['count','names','fields']);break;
        case 'audit_records':check(list(action.groups,20,1));outputs=new Set(['count','names','groups']);break;
        case 'query_records':outputs=new Set(['count']);break;
        case 'workflow_history':outputs=new Set(['count','fields']);break;
        default:return false;
      }
    }
    return requiredOutputs.every(kind=>outputs.has(kind));
  }catch{return false;}
}

module.exports={schema,supports,evidenceIds};
