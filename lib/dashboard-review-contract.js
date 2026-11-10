'use strict';
const Reports=require('../public/report-engine');
const {canonical}=require('./action-lifecycle');
const object=properties=>({type:'object',properties,additionalProperties:false,required:Object.keys(properties)});
const str={type:'string'},nullable={type:['string','null']},one=(...values)=>({type:'string',enum:values});
const list=(items,minItems,maxItems)=>({type:'array',items,minItems,maxItems});
const kinds=['element','plottedLayout','widgetLayout','preserve','unmet'];
const outputFor=m=>m==='count_distinct'?'distinct':m==='percentage'?'percentages':m;
const plotTypes=['bar','line','stage'],measureKinds=Reports.metrics.map(outputFor);
const componentOutputs=[...measureKinds,'scalar_kpi','groups','names'];
const savedOutputs=['unchanged_kpis','unchanged_graphs','preview_only'];
const scalar={type:['string','number','null']};
const where=list(list(object({field:str,operator:one(...Reports.operators),value:scalar,values:list(scalar,0,2000)}),1,20),0,12);
const measure=object({metric:one(...Reports.metrics),field:nullable,where});
const intent=object({chart:one('plot',...plotTypes,'kpi'),measures:list(measure,1,6),groupBy:nullable,splitBy:nullable,
  bucket:one(...Reports.buckets),scope:one('all','visible'),where,limit:{type:['integer','null']}});
const instruction='For a dashboard creation review derive requested elements from the user, not from the proposal. Use one element per requested new chart or KPI: name its metric, field, chart (plot if unspecified), grouping, split and effective cohort, including filters. Use one layout for a requested composition; list the required chart kinds and their graph IDs in corresponding order, including retained components, not unrelated existing widgets. Layout outputs belong ONLY to the layout. Use preserve:layout_member for retained graphs explicitly requested in that comparison. Use preserve:verified_constraint for preservation alone; it adds no layout members. If any requested element, filter, layout, statistic or other intent is absent, ambiguous or unsupported, use unmet with satisfied:false; never shrink the request to fit the evidence.';
const tag=r=>kinds.find(key=>Object.hasOwn(r,key));
function composition(action,computed,proofs){
  if(action?.action!=='dashboard_plan'||!Array.isArray(action.operations)||!Array.isArray(action.questions)||action.questions.length||
    !proofs.length||proofs.some(p=>!savedOutputs.includes(p.output))||!computed?.displayEvidence)return false;
  let ops=action.operations;
  // Clearing an empty board has no separate effect. Actual replacements and
  // edits need the generic review, which can evaluate more than final widgets.
  if(ops[0]?.op==='clear'&&computed.preservation?.elements.every(e=>e.before===null))ops=ops.slice(1);
  if(!ops.length||!ops.every(op=>op?.op==='add'))return false;
  // Selections are not where clauses. Top-N also depends on the sort, not just
  // the limit. Do not try to prove these requests with a partial descriptor.
  return computed.board.elements.every(({spec})=>spec.accounts==null&&spec.owners==null&&spec.limit===null);
}

function specialize(schema,action,computed,proofs){
  if(!composition(action,computed,proofs))return;
  const old=schema.properties.requirements.items.properties,branches=[];
  const elements=computed.displayEvidence.elements,ids=elements.map(e=>e.stepId);
  function branch(key,detail,evidenceKind,stepIds,requiredOutputs){
    branches.push(object({[key]:detail,description:str,evidenceKind:one(evidenceKind),stepIds,requiredOutputs,satisfied:{type:'boolean',enum:[key!=='unmet']}}));
  }
  if(ids.length)branch('element',intent,'computed_read',list(one(...ids),1,1),list(one(...componentOutputs),1,componentOutputs.length));
  const plots=elements.filter(e=>plotTypes.includes(e.chart)).map(e=>e.stepId);
  if(plots.length>=2)branch('plottedLayout',list(one('plot',...plotTypes),2,12),'computed_read',list(one(...plots),2,plots.length),list(one('separate_graphs'),1,1));
  if(ids.length>=2&&plots.length<ids.length)branch('widgetLayout',list(one('plot',...plotTypes,'kpi'),2,12),'computed_read',list(one(...ids),2,ids.length),list(one('separate_widgets'),1,1));
  const invariants=proofs.filter(p=>savedOutputs.includes(p.output)).map(p=>p.id);
  if(invariants.length)branch('preserve',one('verified_constraint','layout_member'),'constraint',list(one(...invariants),1,160),list(one(...savedOutputs),1,savedOutputs.length));
  branch('unmet',{...str,description:'Describe the requested outcome independently, including missing components or evidence. Use issues or clarificationQuestion as appropriate.'},'unavailable',list(str,0,0),list(old.requiredOutputs.items,0,old.requiredOutputs.maxItems));
  schema.properties.requirements.items={description:instruction,anyOf:branches};
  schema.properties.requirements.minItems=1;
}

const same=(a,b)=>canonical(a)===canonical(b);
const sortedUnique=values=>[...new Set(values)].sort();
function predicates(a,b=[]){
  // where is OR-of-AND; ignore branch/condition order and duplicate predicates.
  return sortedUnique((a.length?a:[[]]).flatMap(left=>(b.length?b:[[]]).map(right=>
    canonical(sortedUnique([...left,...right].map(c=>canonical(c)))))));
}
const chartMatches=(wanted,actual)=>wanted===actual||wanted==='plot'&&plotTypes.includes(actual);
function elementMatches(desired,spec,shown){
  if(!desired||!spec||!shown||!chartMatches(desired.chart,spec.chart)||spec.accounts!=null||spec.owners!=null||
    !['scope','groupBy','splitBy','bucket','limit'].every(k=>Object.hasOwn(desired,k)&&desired[k]===spec[k])||
    !Array.isArray(desired.where)||!Array.isArray(desired.measures)||desired.measures.length!==spec.measures.length)return false;
  const common=shown.commonMeasureWhere;
  if(!same(predicates(desired.where),predicates(shown.baseWhere,common)))return false;
  const key=m=>canonical([m.metric,m.field,predicates(m.where)]);
  return same(desired.measures.map(key).sort(),spec.measures.map(m=>key(common.length?{...m,where:[]}:m)).sort());
}
const typedIntent=new WeakMap();
const signatureOf=rs=>canonical(rs.map(r=>[tag(r),r[tag(r)],r.description,r.evidenceKind,[...r.requiredOutputs].sort()]));
function lockFailedIntent(review,computed){
  if(computed&&!typedIntent.has(computed)&&review.requirements.every(r=>tag(r)&&r.satisfied===true&&Array.isArray(r.requiredOutputs)))
    typedIntent.set(computed,signatureOf(review.requirements));
}
function checkReview(review,action,computed,proofs){
  const rs=review.requirements;
  const typed=rs.some(tag),previous=typedIntent.get(computed);
  if(!typed&&!previous)return null; // legacy callers do not return this wire format
  const invalid=new Set(),failAll=()=>new Set(rs);
  if(!typed||!composition(action,computed,proofs))return failAll();
  try{
    // The existing bounded citation retry may change IDs, not the requested
    // chart, predicates or layout. Keep these extra intent fields snapshot-local.
    if(previous&&signatureOf(rs)!==previous)return failAll();
    const board=new Map(computed.board.elements.map(e=>['graph:'+e.id,e])),shown=new Map(computed.displayed.map(e=>['graph:'+e.id,e]));
    const requested=new Set(),individual=new Set(),layouts=[];
    for(const r of rs){
      const k=tag(r),ids=r.stepIds,out=r.requiredOutputs;
      if(!k||kinds.filter(key=>Object.hasOwn(r,key)).length!==1||!Array.isArray(ids)||!Array.isArray(out)||new Set(ids).size!==ids.length||!r.satisfied){invalid.add(r);continue;}
      if(k==='element'){
        const id=ids[0];
        if(r.evidenceKind!=='computed_read'||ids.length!==1||individual.has(id)||!out.length||out.some(o=>!componentOutputs.includes(o))||
          !elementMatches(r.element,board.get(id)?.spec,shown.get(id))||
          !r.element.measures.every(m=>out.includes(outputFor(m.metric))))invalid.add(r);
        requested.add(id);individual.add(id);
      }else if(k==='preserve'){
        if(r.evidenceKind!=='constraint'||!['verified_constraint','layout_member'].includes(r.preserve)||!out.length||out.some(o=>!savedOutputs.includes(o)))invalid.add(r);
        if(r.preserve==='layout_member')for(const id of ids){
          const proof=proofs.find(p=>p.id===id);
          if(proof?.output==='unchanged_graphs'&&proof.graphId)requested.add('graph:'+proof.graphId);else invalid.add(r);
        }
      }else if(k==='plottedLayout'||k==='widgetLayout')layouts.push(r);
      else invalid.add(r);
    }
    // Every newly displayed add needs an independent element review. Existing
    // widgets join the requested set only by explicit element/preservation ID.
    if(action.operations.some(op=>op.op==='add'&&board.has('graph:'+op.id)&&!individual.has('graph:'+op.id)))return failAll();
    if(layouts.length!==(requested.size>=2?1:0))return failAll();
    for(const r of layouts){
      const k=tag(r),mixed=k==='widgetLayout',ids=r.stepIds,types=r[k];
      if(r.evidenceKind!=='computed_read'||!same(r.requiredOutputs,[mixed?'separate_widgets':'separate_graphs'])||
        !Array.isArray(types)||types.length!==ids.length||ids.length!==requested.size||ids.length<2||
        ids.some((id,i)=>!requested.has(id)||!chartMatches(types[i],board.get(id)?.spec.chart))||types.includes('kpi')!==mixed)invalid.add(r);
    }
    return invalid;
  }catch{return failAll();}
}
module.exports={specialize,checkReview,lockFailedIntent};
