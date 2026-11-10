'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Review=require('../lib/action-review'),F=require('./fixtures/workspace-plans.cjs');
const where=[[F.where('f_deal','starts_with','QA1105')]],graph=id=>'graph:'+id;
const add=(id,chart,metric,groupBy)=>({op:'add',id,spec:{version:1,title:id,chart,groupBy,splitBy:null,bucket:'none',
  scope:'all',where:[],sort:'label_asc',limit:null,measures:[{label:id,metric,field:metric==='count'?null:'f_value',where:[]}]}});
const stage=add('stage','stage','sum','f_stage'),mean=add('mean','kpi','average',null),owner=add('owner','bar','average','f_owner');
const plan=(...ops)=>({action:'dashboard_plan',requestScope:{scope:'all',where},operations:structuredClone(ops),questions:[]});
function fixture(action=plan(stage,mean),prior){
  const pipeline={...F.workspace(),currentDate:'2026-11-05',...(prior?{dashboard:{board:prior}}:{})};
  const result={crmAction:action},computed=Review.evidence({pipeline},result),context={pipeline,computed};
  const schema=JSON.parse(JSON.stringify(Review.schemaFor(action,context)));
  return {result,context,schema,check:requirements=>Review.validateReview(envelope(requirements),result,context).ok};
}
const envelope=requirements=>({requirements,issues:[],clarificationQuestion:null,answerIntent:'canonical',answerSelection:null});
const req=(shape,stepIds,requiredOutputs,evidenceKind='computed_read')=>({...shape,description:'user obligation',evidenceKind,stepIds,requiredOutputs,satisfied:true});
const element=op=>{
  const {chart,groupBy,splitBy,bucket,scope,limit,measures}=op.spec;
  return req({element:{chart,groupBy,splitBy,bucket,scope,where,limit,measures:measures.map(({metric,field,where})=>({metric,field,where}))}},
    [graph(op.id)],[measures[0].metric,...(groupBy?['groups']:chart==='kpi'?['scalar_kpi']:[])]);
};
const layout=(ops,mixed)=>req({[mixed?'widgetLayout':'plottedLayout']:ops.map(o=>o.spec.chart)},ops.map(o=>graph(o.id)),[mixed?'separate_widgets':'separate_graphs']);
const preserve=(ids,out)=>req({preserve:'verified_constraint'},ids,[out],'constraint');
const mixed=()=>[element(stage),element(mean),layout([stage,mean],true),preserve(['unchanged:kpis'],'unchanged_kpis')];
// Exercise values against the serialized union, independently of validateReview.
function accepts(s,v){
  if(s.anyOf)return s.anyOf.some(b=>accepts(b,v));
  const type=v===null?'null':Array.isArray(v)?'array':typeof v,t=[s.type].flat();
  if(!t.includes(type)&&!(Number.isInteger(v)&&t.includes('integer')))return false;
  if(s.enum&&!s.enum.includes(v))return false;
  if(type==='object')return s.required.every(k=>Object.hasOwn(v,k))&&Object.keys(v).every(k=>Object.hasOwn(s.properties,k)&&accepts(s.properties[k],v[k]));
  if(type==='array')return v.length>=(s.minItems||0)&&v.length<=(s.maxItems??Infinity)&&v.every(i=>accepts(s.items,i));
  return true;
}
test('serialized F04v schema admits the entire valid review, not the two PR77 per-widget layout claims',()=>{
  const f=fixture(),ok=mixed(),item=f.schema.properties.requirements.items;
  assert(item.anyOf&&!item.properties);assert(accepts(f.schema,envelope(ok)));assert(f.check(ok));
  for(const [id,outputs] of [['stage',['separate_graphs']],['mean',['separate_widgets','scalar_kpi']]]){
    const legacy=req({},[graph(id)],outputs,'compiled_action');
    assert(!accepts(item,legacy));
    for(const sample of [ok[id==='stage'?0:1],ok[2]])assert(!accepts(item,{...sample,stepIds:[graph(id)],requiredOutputs:outputs}));
  }
  const ids=context=>Review.allowedStepIdsFor(f.result.crmAction,context);
  assert(ids(f.context).includes('unchanged:kpis'));
  assert.deepEqual(ids({...f.context,computed:structuredClone(f.context.computed)}),['root','graph:stage','graph:mean']);
  f.context.pipeline.records[0].f_value++;assert(!ids(f.context).includes('unchanged:kpis'));assert(!f.check(ok));
});
test('unmet outcomes can describe absent or unsupported user intent without citing the proposed charts',()=>{
  const f=fixture(plan(mean)),missing={...req({unmet:'Requested an owner graph on another cohort, not present'},[],['groups','sum'],'unavailable'),satisfied:false};
  const review=envelope([element(mean),missing]);review.clarificationQuestion='Which cohort?';
  assert(accepts(f.schema,review));assert(!Review.validateReview(review,f.result,f.context).ok);
  assert(!accepts(f.schema,envelope([])));assert(!accepts(f.schema,envelope([{...element(mean),stepIds:[]}])));
  assert(!f.check([preserve(['unchanged:kpis'],'unchanged_kpis')]));
});
test('element matches typed intent, not planner title, record count, another component or repaired intent',()=>{
  for(const change of [r=>r.element.scope='visible',r=>r.element.where=[],r=>r.element.where=[[F.where('f_owner','equals','QA1105')]],
    r=>r.element.measures[0].field='f_deal',r=>r.element.measures[0].metric='sum',r=>r.element.groupBy='f_owner',
    r=>r.element.chart='line',r=>r.stepIds=[graph('stage')],r=>r.stepIds=[],r=>r.element.limit=1]){
    const f=fixture(),rs=structuredClone(mixed());change(rs[1]);assert(!f.check(rs));
    if(rs[1].stepIds[0]==='graph:mean')assert(!f.check(mixed()),'citation repair cannot rewrite requested component properties');
  }
  const wrongPlan=plan(stage,mean);wrongPlan.operations[1].spec.where=[[F.where('f_owner','equals','Someone')]];
  assert(!fixture(wrongPlan).check(mixed()));
});
test('one complete layout of three plots or two retained widgets and the new owner plot',()=>{
  const count=add('count','bar','count','f_owner'),three=[count,stage,owner],requests=[...three.map(element),layout(three,false)];
  const f=fixture(plan(...three));assert(accepts(f.schema,envelope(requests)));assert(f.check(requests));
  const prior=fixture().context.computed.board,inc=()=>fixture(plan(owner),prior);
  const kept=preserve(['unchanged:graph:stage','unchanged:graph:mean'],'unchanged_graphs');
  assert(inc().check([element(owner),kept]),'leaving old charts untouched does not request a comparison');
  kept.preserve='layout_member';
  const incremental=[element(owner),kept,layout([stage,mean,owner],true)];
  assert(accepts(inc().schema,envelope(incremental)));assert(inc().check(incremental));
  for(const change of [r=>r.pop(),r=>r.push(r[2]),r=>r[2]=layout([stage,owner],false),
    r=>r[2].stepIds[0]=graph('owner'),r=>r[2].widgetLayout[1]='plot',r=>r[2]=layout([stage,mean,owner],false)]){
    const rs=structuredClone(incremental);change(rs);assert(!inc().check(rs));
  }
  const absent=fixture(plan(count,stage));assert(!absent.check(requests));
});
test('only pure compositions specialize: an empty reset is a no-op, real resets and mixed board edits use generic review',()=>{
  const clear={op:'clear'},initial=fixture(plan(clear,stage,mean));assert(initial.check(mixed()));assert(initial.schema.properties.requirements.items.anyOf);
  const prior=initial.context.computed.board,filter={op:'set_shared_filter',id:'prefix',targets:['stage'],where};
  for(const op of [clear,{op:'remove',ids:['stage']},{op:'update',ids:['mean'],mode:'add_filter',where,replaceFields:[],changes:[]},filter]){
    const f=fixture(plan(op,owner),prior);assert(f.schema.properties.requirements.items.properties);
    assert(f.check([req({},[graph('owner')],['average','groups'])]));
  }
  const filtered=fixture(plan(filter,owner),prior).context.computed.board;
  const f=fixture(plan({op:'remove_shared_filter',id:'prefix'},add('total','bar','sum','f_owner')),filtered);
  assert(f.schema.properties.requirements.items.properties);
});
test('selected accounts/owners, ranked subsets and explicit differences/extrema retain the full generic contract',()=>{
  for(const selection of [{accounts:['Summit Insurance Partners']},{owners:['Alex']},{limit:2,sort:'value_desc'}]){
    const a=plan(owner);a.requestScope=null;Object.assign(a.operations[0].spec,selection);
    const f=fixture(a);assert(f.schema.properties.requirements.items.properties);
    assert(f.check([req({},[graph('owner')],['average','groups'])]));
  }
  const a=plan(stage,add('total','bar','sum','f_owner'));a.requestScope=null;
  const ref=(elementId,stat)=>({elementId,measure:0,stat});
  a.questions=[{kind:'difference',label:'Difference',left:ref('stage','maximum'),right:ref('total','maximum')},
    {kind:'value',label:'Smallest nonzero',reference:ref('total','minimum_nonzero')}];
  const f=fixture(a);assert(f.schema.properties.requirements.items.properties);
  assert(f.check([req({},['root'],['max','min','sum'])]));
});
test('wire schema is strict, bounded, and does not enumerate dashboard subsets',()=>{
  const ops=Array.from({length:12},(_,i)=>add('g'+i,i%2?'bar':'kpi','sum',i%2?'f_owner':null)),{schema}=fixture(plan(...ops));
  let enums=0,props=0;
  function visit(s,depth=0){
    assert(depth<=10);assert(!s.uniqueItems&&!s.oneOf&&!s.allOf);
    if(s.enum){assert(s.enum.length);enums+=s.enum.length;}
    if(s.anyOf)s.anyOf.forEach(x=>visit(x,depth));
    if(s.properties){assert.equal(s.additionalProperties,false);assert.deepEqual(s.required,Object.keys(s.properties));props+=s.required.length;Object.values(s.properties).forEach(x=>visit(x,depth+1));}
    if(s.items)visit(s.items,depth+1);
  }
  visit(schema);assert(enums<1000&&props<5000);assert.equal(schema.type,'object');assert(!schema.anyOf);
});
