'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Core=require('../public/pipeline-core'),Board=require('../public/dashboard-board');
const Review=require('../lib/action-review'),Presentation=require('../lib/dashboard-presentation-contract');
const F=require('./fixtures/workspace-plans.cjs');
const original='On the dashboard, show three charts for QA1113 deals: deal count by stage as a donut, total value by owner as a bar chart, and median deal value as a KPI. Exclude blank amounts from the median.';
const variant='Keep the dashboard and add a midpoint value indicator, an owner value line graph and a stage distribution for Workshop deals. Unknown amounts must not count toward the midpoint; zeroes must count.';
function pipeline(prefix='QA1113'){
  const p={...F.workspace(),currentDate:'2026-11-13',workspaceVersion:'nov13'};
  p.records=[['Copper Books',11000,'Qualified','Alex'],['Silver Cafe',0,'Prospecting','Sam'],
    ['Gold Repairs','', 'Proposal Sent','Alex'],['Bronze Bikes',2400,'Qualified','Alex']]
    .map(([name,value,stage,owner],i)=>({...p.records[0],id:i+1,f_deal:prefix+' '+name,f_value:value,f_stage:stage,f_owner:owner}));
  p.records.push({...p.records[0],id:5,f_deal:'Outside scope',f_value:999999});
  return p;
}
const add=(id,chart,metric,groupBy)=>({op:'add',id,spec:{version:1,title:id,chart,scope:'all',groupBy,splitBy:null,bucket:'none',
  where:[],sort:'label_asc',limit:null,measures:[{label:metric,metric,field:metric==='count'?null:'f_value',where:[]}]}});
const plan=(prefix,ops)=>({action:'dashboard_plan',requestScope:{scope:'all',where:[[F.where('f_deal','starts_with',prefix)]]},operations:ops,questions:[]});
const envelope=requirements=>({requirements,issues:[],clarificationQuestion:null,answerIntent:'canonical',answerSelection:null});
const req=(shape,stepIds,requiredOutputs,evidenceKind='computed_read')=>({...shape,description:'Requested visual outcome',evidenceKind,stepIds,requiredOutputs,satisfied:true});
const element=(op,cohort='cohort_1')=>req({['graph:'+op.id]:{requestedCohort:cohort}},['graph:'+op.id],
  [op.spec.measures[0].metric,...(op.spec.groupBy?['groups']:['scalar_kpi'])]);
function prepare(action,p,userCommand){
  const result={crmAction:action},computed=Review.evidence({pipeline:p,userCommand},result),context={pipeline:p,computed};
  return {result,computed,context,schema:Review.schemaFor(action,context)};
}
function accepts(s,v){
  if(s.anyOf)return s.anyOf.some(b=>accepts(b,v));
  const type=v===null?'null':Array.isArray(v)?'array':typeof v;
  if(![s.type].flat().includes(type)&&!(Number.isInteger(v)&&s.type==='integer'))return false;
  if(s.enum&&!s.enum.includes(v))return false;
  if(type==='object')return s.required.every(k=>Object.hasOwn(v,k))&&Object.keys(v).every(k=>s.properties[k]&&accepts(s.properties[k],v[k]));
  if(type==='array')return v.length>=(s.minItems||0)&&v.length<=(s.maxItems??Infinity)&&v.every(i=>accepts(s.items,i));
  return true;
}

for(const [prefix,command,chart,order] of [['QA1113',original,'bar',[0,1,2]],['Workshop',variant,'line',[2,1,0]]]){
  test('F13 typed construction and complete review: '+command,()=>{
    const p=pipeline(prefix),base=[add('distribution','stage','count','f_stage'),add('owners',chart,'sum','f_owner'),add('midpoint','kpi','median',null)];
    base[2].spec.measures[0].where=[[F.where('f_value','is_not_blank')]];
    const ops=order.map(i=>base[i]),action=plan(prefix,ops),before=JSON.stringify(p),f=prepare(action,p,command);
    assert(accepts(Board.schemas(Core.create(p.tableSchema))[0],action),'planner schema admits the complete mixed-family action');
    const applied=Board.apply(null,action,p.records,Core.create(p.tableSchema),[],{today:p.currentDate});
    const views=new Map(applied.views.map(v=>[v.id,v]));
    assert.deepEqual(Object.fromEntries(views.get('distribution').snapshot.table.map(r=>[r.group,r.value])),{'Proposal Sent':1,Prospecting:1,Qualified:2});
    assert.deepEqual(Object.fromEntries(views.get('owners').snapshot.table.map(r=>[r.group,r.value])),{Alex:13400,Sam:0});
    const summary=views.get('midpoint').snapshot.summaries[0];assert.equal(summary.value,2400);assert.equal(summary.numericCount,3);
    assert.equal(views.get('distribution').snapshot.recordCount,4);assert.equal(views.get('owners').snapshot.recordCount,4);
    assert.match(applied.answer,/\$2,400\.00 \(3 numeric values\)/);
    const item=f.schema.properties.requirements.items;
    assert(item.anyOf);assert(!item.anyOf.some(branch=>branch.properties.plottedLayout),'mixed adds cannot choose a plots-only layout');
    const layout=item.anyOf.find(branch=>branch.properties.widgetLayout);
    assert.equal(layout.properties.stepIds.minItems,3);assert.equal(layout.properties.widgetLayout.minItems,3);
    const medianBranch=item.anyOf.find(branch=>branch.properties['graph:midpoint']);
    const medianCohort=medianBranch.description.match(/population (cohort_\d+)/)[1];
    const requirements=ops.map(op=>element(op,op.id==='midpoint'?medianCohort:'cohort_1'));
    requirements.push(req({widgetLayout:ops.map(op=>op.spec.chart)},ops.map(op=>'graph:'+op.id),['separate_widgets']));
    const review=envelope(requirements);
    assert(accepts(f.schema,review));assert.equal(Review.validateReview(review,f.result,f.context).ok,true);
    const bad=envelope([...requirements.slice(0,3),req({plottedLayout:['stage',chart]},['graph:distribution','graph:owners'],['separate_graphs'])]);
    assert(!accepts(f.schema,bad));assert.equal(Review.validateReview(bad,f.result,f.context).ok,false);
    assert.equal(JSON.stringify(p),before,'all temporary graphs leave records and saved KPI definitions untouched');
  });
}

test('a local unknown-amount exclusion cannot silently remove records from the other metric families',()=>{
  const p=pipeline(),count=add('count','stage','count','f_stage'),total=add('total','bar','sum','f_owner'),median=add('median','kpi','median',null);
  median.spec.where=[[F.where('f_value','is_not_blank')]];
  const action=plan('QA1113',[count,total,median]),f=prepare(action,p,original);
  assert.deepEqual(f.computed.displayed.map(v=>[v.id,v.recordCount]),[['count',4],['total',4],['median',3]]);
  assert.equal(f.computed.displayed[2].summaries[0].value,2400);
  assert.deepEqual(f.computed.board.elements[0].spec.where,action.requestScope.where);
  assert.deepEqual(f.computed.board.elements[1].spec.where,action.requestScope.where);
});

test('F13 renders three distinct visible elements: donut, owner bar and a scalar median indicator',()=>{
  const p=pipeline(),action=plan('QA1113',[add('distribution','stage','count','f_stage'),add('owners','bar','sum','f_owner'),add('midpoint','kpi','median',null)]);
  const result=Board.apply(null,action,p.records,Core.create(p.tableSchema),[],{today:p.currentDate});
  const root={PipeChatDashboard:Board};
  require('node:vm').runInNewContext(require('node:fs').readFileSync(require.resolve('../public/report-ui'),'utf8'),root);
  const sections=[],configs=[],button=()=>({dataset:{},setAttribute(){}});
  const document={createElement(tag){
    if(tag!=='section')return button();
    const visual={innerHTML:'',style:{},append(){}},actions={prepend(){}},control=button();
    return {dataset:{},classList:{toggle(){}},visual,querySelector:key=>key==='.dashboard-element-visual'?visual:key==='.dashboard-element-actions'?actions:control};
  }};
  const host={dataset:{},append(section){sections.push(section);},querySelectorAll(){return sections;}};
  class Chart{constructor(canvas,config){configs.push(config);}resize(){}}
  root.PipeChatReportsUI.drawBoard({host,views:result.views,board:result.board,esc:String,Chart,document,icon:()=>''});
  assert.deepEqual(sections.map(s=>s.dataset.elementId),['midpoint','distribution','owners']);
  assert(sections.every(s=>!s.hidden));assert.match(sections[0].visual.innerHTML,/<strong>\$2,400\.00<\/strong>/);
  assert.deepEqual(configs.map(c=>c.type),['doughnut','bar']);
  assert.deepEqual(Array.from(configs[0].data.datasets[0].data),[1,1,2]);
  assert.deepEqual(Array.from(configs[1].data.datasets[0].data),[13400,0]);
});

test('mixed metric families remain independent and preserve an existing board without requiring extra model calls',()=>{
  const p=pipeline(),prior=plan('QA1113',[add('existing','line','sum','f_owner')]);
  p.dashboard={board:prepare(prior,p,'Prior view').computed.board};
  const action=plan('QA1113',[add('count','stage','count','f_stage'),add('total','bar','sum','f_owner'),add('median','kpi','median',null)]),f=prepare(action,p,original);
  assert.equal(Presentation.extendReviewSchema(f.schema,action,p),false,'typed composition already inventories every visual and layout');
  assert.equal(f.computed.board.elements.length,4);assert.deepEqual(f.computed.board.elements[0],p.dashboard.board.elements[0]);
  assert.deepEqual(f.computed.preservation.evidenceIds,['unchanged:graph:existing']);
  assert(!Object.hasOwn(f.schema.properties,'presentationIntent'));
  assert.match(Board.planningInstructions,/blank-value exclusion specific to one measure/);
  assert.match(f.schema.properties.requirements.items.description,/composition containing ANY KPI uses widgetLayout/);
});

test('one ordinary completeness review carries F04 presentation intent without a separate witness request',()=>{
  const p=pipeline(),metric=add('midpoint','kpi','median',null).spec;
  const hidden=F.plan([{op:'report',id:'answer',label:'Answer',selection:null,spec:metric,showDashboard:false,questions:[{kind:'summary',elementIds:['answer']}]}]);
  const f=prepare(hidden,p,'Show the median value as a KPI'),s=f.schema;
  assert.equal(Presentation.extendReviewSchema(s,hidden,p),true);assert.equal(Presentation.extendReviewSchema(s,hidden,p),true);
  assert.equal(s.required.filter(k=>k==='presentationIntent').length,1);
  const presentationIntent={status:'resolved',elements:[{chart:'kpi',groupBy:null,splitBy:null,bucket:'none',measures:[{metric:'median',field:'f_value'}]}]};
  const review={...envelope([req({},['answer'],['median'])]),presentationIntent};
  assert(accepts(s,review));assert.equal(Presentation.assess(review.presentationIntent,hidden,f.context).ok,false);
  assert(Presentation.sameReviewIntent(review,structuredClone(review)));
  assert(!Presentation.sameReviewIntent(review,{...review,presentationIntent:{status:'not_requested',elements:[]}}));
  assert(!Presentation.sameReviewIntent(review,envelope(review.requirements)));
  assert(Presentation.sameReviewIntent({},{}));
});

test('F13 diagnostic regression: valid plots-only subset and full mixed layout keep all five supported mappings',()=>{
  const p=pipeline(),ops=[add('distribution','stage','count','f_stage'),add('owners','bar','sum','f_owner'),add('midpoint','kpi','median',null)];
  const action=plan('QA1113',ops),f=prepare(action,p,original);
  const requirements=[
    req({'graph:distribution':{requestedCohort:'cohort_1'}},['graph:distribution'],['count','names','groups']),
    req({'graph:owners':{requestedCohort:'cohort_1'}},['graph:owners'],['names','sum','groups']),
    req({'graph:midpoint':{requestedCohort:'cohort_1'}},['graph:midpoint'],['median','scalar_kpi']),
    req({plottedLayout:['stage','bar']},['graph:distribution','graph:owners'],['separate_graphs']),
    req({widgetLayout:['stage','bar','kpi']},['graph:distribution','graph:owners','graph:midpoint'],['separate_widgets'])
  ];
  const Read=require('../lib/read-output-contract');
  for(const r of requirements)assert.equal(Read.supports(action,r.stepIds,r.requiredOutputs,f.context),true,'component-local outputs really are supported');
  const allowed=new Set(Review.allowedStepIdsFor(action,f.context));
  assert(requirements.every(r=>r.stepIds.every(id=>allowed.has(id))));
  const coverage=Review.validateReview(envelope(requirements),f.result,f.context);
  assert.deepEqual(coverage,{ok:true,requested:5,compiled:5,mappingIssues:[]});
  for(const alter of [
    rs=>rs.pop(),
    rs=>rs.push(structuredClone(rs.at(-1))),
    rs=>rs[4].widgetLayout[2]='bar',
    rs=>rs[3].stepIds=['graph:distribution','graph:midpoint'],
    rs=>rs[4].stepIds=['graph:distribution','graph:owners'],
    rs=>rs[0].stepIds=['graph:owners'],
    rs=>rs[2]['graph:midpoint'].requestedCohort='all_records'
  ]){
    const fresh=prepare(structuredClone(action),pipeline(),original),rs=structuredClone(requirements);alter(rs);
    assert.equal(Review.validateReview(envelope(rs),fresh.result,fresh.context).ok,false);
  }
  const variant=structuredClone(action);variant.operations[1].spec.chart='line';
  const next=prepare(variant,pipeline(),original),rs=structuredClone(requirements);
  rs[3].plottedLayout[1]='line';rs[4].widgetLayout[1]='line';rs.reverse();
  assert.equal(Review.validateReview(envelope(rs),next.result,next.context).ok,true);
});
