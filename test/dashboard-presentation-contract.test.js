'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Presentation=require('../lib/dashboard-presentation-contract');
const Review=require('../lib/action-review');
const Dashboard=require('../public/dashboard-board');
const Reports=require('../public/report-engine');
const Core=require('../public/pipeline-core');
const F=require('./fixtures/workspace-plans.cjs');
const makePipeline=()=>({...F.workspace(),currentDate:'2026-11-13',workspaceVersion:'qa-v1'});
const spec=(chart='kpi',metric='median',field='f_value',groupBy=null)=>({version:1,title:'Requested statistic',chart,scope:'all',
  groupBy,splitBy:null,bucket:'none',where:[],sort:'label_asc',limit:null,measures:[{label:metric,metric,field,where:[]}]});
const want=s=>({chart:s.chart,groupBy:s.groupBy,splitBy:s.splitBy,bucket:s.bucket,measures:s.measures.map(({metric,field})=>({metric,field}))});
const intent=(...specs)=>({status:'resolved',elements:specs.map(want)});
const add=(id,s)=>({op:'add',id,spec:s});
const dashboard=(...operations)=>({action:'dashboard_plan',requestScope:null,operations,questions:[]});
const report=(id,s,showDashboard)=>({op:'report',id,label:id,selection:null,spec:s,showDashboard,questions:[{kind:'summary',elementIds:[id]}]});
const read=(id,showTable=false)=>({op:'read_records',id,label:id,selection:'selected',showTable,outputs:[{kind:'median',field:'f_value'}]});
const fixture=(action,pipeline=makePipeline())=>({pipeline,computed:Review.evidence({pipeline},{crmAction:action})});
const check=(wanted,action,pipeline)=>Presentation.assess(wanted,action,fixture(action,pipeline));

test('F04 original and metric variants cannot satisfy presentation with chat arithmetic or a hidden report',()=>{
  for(const metric of ['median','sum','average','min','max','count','count_distinct','percentage']){
    const field=['count','percentage'].includes(metric)?null:metric==='count_distinct'?'f_owner':'f_value',s=spec('kpi',metric,field);
    const hidden=F.plan([report('answer',s,false)]),displayed=F.plan([report('answer',s,true)]);
    assert.equal(check(intent(s),hidden).ok,false,metric+' hidden');
    assert.equal(check(intent(s),displayed).ok,true,metric+' displayed');
    const legacy={action:'show_kpi',title:s.title,scope:s.scope,where:s.where,measures:s.measures};
    assert.equal(check(intent(s),legacy).ok,false,metric+' legacy answer');
    assert.equal(check(intent(s),dashboard(add('metric',s))).ok,true,metric+' dashboard');
  }
  const action=F.plan([F.select('selected'),read('answer')]),context=fixture(action);
  assert.match(Review.renderAnswer({pipeline:context.pipeline},{crmAction:action},context.computed),/numeric values/);
  const result=Presentation.assess(intent(spec()),action,context);
  assert.equal(result.ok,false);assert.equal(result.compiled,0);assert.match(result.issues[0],/Missing final displayed element/);
  const schema=Review.schemaFor(action,context);
  assert.match(schema.properties.requirements.items.properties.requiredOutputs.description,/Require this even when the candidate only computes/);
});

test('three independent temporary components must survive together; earlier overwritten reports do not count',()=>{
  const count=spec('stage','count',null,'f_stage'),total=spec('bar','sum','f_value','f_owner'),median=spec();
  const wanted=intent(count,total,median),ops=[add('stages',count),add('owners',total),add('midpoint',median)];
  const valid=dashboard(...ops),p=makePipeline(),before=JSON.stringify(p),good=check(wanted,valid,p);
  assert.equal(good.ok,true);assert.equal(good.requested,3);assert.equal(good.compiled,3);
  assert.deepEqual(good.evidence.map(e=>e.stepId),['graph:stages','graph:owners','graph:midpoint']);assert.equal(JSON.stringify(p),before);
  for(const partial of [dashboard(...ops.slice(0,1)),dashboard(...ops.slice(0,2)),
    dashboard(...ops,{op:'remove',ids:['midpoint']}),F.plan([report('stages',count,true),report('owners',total,true),report('midpoint',median,true)])]){
    const got=check(wanted,partial);assert.equal(got.ok,false);assert(got.compiled<3);
  }
  const nested=F.plan([{op:'dashboard',id:'visuals',label:'Show together',plan:valid}]);
  assert.equal(check(wanted,nested).ok,true);
  assert(check(wanted,nested).evidence.every(e=>e.stepId.startsWith('visuals/graph:')));
  const sequential=F.plan(ops.map((op,i)=>({op:'dashboard',id:'display_'+i,label:'Add visual',plan:dashboard(op)})));
  assert.equal(check(wanted,sequential).ok,true,'multiple dashboard steps can accumulate one final complete view');
  assert(check(wanted,sequential).evidence.every(e=>e.stepId.startsWith('display_2/graph:')));
});

test('a temporary KPI cannot be replaced by a grouped KPI, unrelated field, persistent card, or stale existing card',()=>{
  const s=spec(),wrong=spec('kpi','median','f_value','f_owner');
  assert.equal(check(intent(s),dashboard(add('wrong',wrong))).ok,false);
  assert.equal(check(intent(s),dashboard(add('wrong',spec('kpi','average')))).ok,false);
  const p=makePipeline(),old=dashboard(add('old',s));p.dashboard={board:fixture(old,p).computed.board};
  assert.equal(check(intent(s),dashboard(add('other',spec('bar','count',null,'f_stage'))),p).ok,false);
  const numberField={id:'f_count',name:'Seats',type:'number',role:'none',options:[]};p.tableSchema.fields.push(numberField);
  p.records.forEach(r=>r.f_count=r.f_value);
  assert.equal(check(intent(s),dashboard(add('different',spec('kpi','median','f_count'))),p).ok,false,'same totals do not make fields interchangeable');
  assert.equal(Presentation.assess(intent(s),{action:'add_kpi'},fixture(old)).ok,false,'persistent mutation never supplies an ad hoc display');
});

test('proofs bind to the original compiled action, pipeline, computed object and final visible view',()=>{
  const s=spec(),action=dashboard(add('metric',s));
  for(const alter of [c=>c.computed=structuredClone(c.computed),c=>c.pipeline.records[0].f_value++,
    c=>c.computed.board.elements[0].spec.groupBy='f_owner',c=>c.pipeline.workspaceVersion='qa-v2']){
    const c=fixture(action);assert(Presentation.assess(intent(s),action,c).ok);alter(c);
    assert.equal(Presentation.assess(intent(s),action,c).ok,false);
  }
  const hiddenAfter=F.plan([report('metric',s,true),F.select('selected'),read('answer',true)]);
  assert.equal(check(intent(s),hiddenAfter).ok,false,'a later table display is not a final dashboard display');
  const answerAfter=F.plan([report('metric',s,true),F.select('selected'),read('answer',false)]);
  assert.equal(check(intent(s),answerAfter).ok,true,'answer-only follow-up does not replace the final displayed widget');
  const nested=F.plan([{op:'dashboard',id:'visuals',label:'Visuals',plan:action}]),c=fixture(nested);
  assert.equal(Presentation.assess(intent(s),nested,{...c,computed:structuredClone(c.computed)}).ok,false);
});

test('distinct output obligations cannot borrow one witness, and a wildcard cannot consume a later exact match',()=>{
  const bar=spec('bar','sum','f_value','f_owner'),line={...bar,chart:'line'},wild={...bar,chart:'plot'};
  assert.equal(check(intent(wild,bar),dashboard(add('bar',bar),add('line',line))).ok,true);
  assert.equal(check(intent(bar,bar),dashboard(add('bar',bar))).ok,false);
  assert.equal(check(intent({...spec(),chart:'plot'}),dashboard(add('kpi',spec()))).ok,false);
});

test('presentation extraction is bounded and excludes candidate prose, records, totals and history',()=>{
  const pipeline=makePipeline(),command='Show the median QA1110 deal value as a KPI and tell me how many known values it uses.';
  const payload={pipeline,userCommand:command,compiled:{action:'ignore'},computed:{answer:999},conversationHistory:[{role:'assistant',content:'Do not render'}]};
  const input=Presentation.input(payload);
  assert.deepEqual(Object.keys(input),['userCommand','fields']);assert.equal(input.userCommand,command);
  assert(!JSON.stringify(input).includes('999'));assert(!JSON.stringify(input).includes('Do not render'));
  assert.equal(Presentation.input({...payload,userCommand:'a'.repeat(24001)}),null);
  assert.equal(Presentation.input({...payload,pendingClarification:{question:'Which metric?'}}),null);
  const schema=Presentation.schemaFor(pipeline);
  assert.equal(schema.additionalProperties,false);assert.deepEqual(schema.required,['status','elements']);
  assert.equal(schema.properties.elements.maxItems,12);
  assert.equal(Presentation.eligible(F.plan([F.select('selected'),read('read')])),true);
  assert.equal(Presentation.eligible(null),false);assert.equal(Presentation.eligible(undefined),false);
  assert.equal(Presentation.eligible({action:'clarify'}),false);
  assert.equal(Presentation.eligible({action:'delete_records'}),false);
  for(const status of ['not_requested','unsupported'])assert.equal(Presentation.assess({status,elements:[]},null,{pipeline}).applicable,false);
  assert.equal(Presentation.assess({status:'resolved',elements:[]},null,{pipeline}).ok,false);
  assert.match(Presentation.instructions,/supplemental presentation check/);
});

test('canonical summaries explicitly retain numeric coverage and do not claim an unseen graph was displayed',()=>{
  const p=makePipeline();p.records=[0,5000,6000,9000,15000,30500,''].map((v,i)=>({...p.records[0],id:i+1,f_value:v}));
  const c=fixture(dashboard(add('midpoint',spec())),p);
  assert.match(c.computed.answer,/7 records represented/);assert.match(c.computed.answer,/\$7,500\.00 \(6 numeric values\)/);
  assert.doesNotMatch(c.computed.answer,/displayed graph/);
  p.records.pop();const allKnown=fixture(dashboard(add('midpoint',spec())),p);
  assert.match(allKnown.computed.answer,/6 numeric values/);
  assert.equal(Dashboard.numericDetail({count:0,numericCount:0}),' (0 numeric values)');
  assert.equal(Dashboard.numericDetail({count:2}),'');
  const core=Core.create(p.tableSchema),schema=Reports.readActionSchemas(core,[]).find(s=>s.properties.action.enum.includes('show_kpi'));
  assert.match(schema.properties.action.description,/does NOT render/);
});
