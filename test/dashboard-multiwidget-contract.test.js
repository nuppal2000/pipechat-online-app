'use strict';

const test=require('node:test'),assert=require('node:assert/strict');
const Dashboard=require('../public/dashboard-board'),Core=require('../public/pipeline-core');
const Plan=require('../public/workspace-plan'),Read=require('../lib/read-output-contract');
const Review=require('../lib/action-review'),Conversation=require('../lib/conversation-core');
const Customize=require('../public/workspace-customization');
const F=require('./fixtures/workspace-plans.cjs');
const today='2026-10-23';
const spec=(metric,extra={})=>({version:1,title:metric+' by stage',chart:'bar',scope:'all',groupBy:'f_stage',
  bucket:'none',splitBy:null,where:[],sort:'label_asc',limit:null,
  measures:[{label:metric,metric,field:metric==='count'?null:'f_value',where:[]}],...extra});
const add=(id,spec)=>({op:'add',id,spec});
const workspace=()=>{
  const w=F.workspace();
  w.tableSchema=Customize.addKpi(w.tableSchema,[],'kpi_user_retained',{title:'Retained saved value',metric:'sum',field:'f_value',conditions:[]}).tableSchema;
  w.records=Array.from({length:45},(_,i)=>({...w.records[0],id:i+1,f_deal:'Deal '+(i+1),
    f_owner:i<20?'Alex':'Sam',f_stage:i<17?'Qualified':i<28?'Closed Won':i<37?'Closed Lost':'',f_value:(i+1)*1000}));
  return w;
};
const apply=(w,action,board=null)=>Dashboard.apply(board,action,w.records,Core.create(w.tableSchema),w.customFields,{today});
const dashboard=(questions=[])=>({action:'dashboard_plan',operations:[add('stage_counts',spec('count')),add('stage_average',spec('average'))],questions});
const requirement=(description,requiredOutputs,stepIds=['root'],evidenceKind='computed_read')=>({description,requiredOutputs,stepIds,evidenceKind,satisfied:true});

// These are typed actions for the reproduced request, not fake model acceptance.
for(const [command,questions] of [
  ['Show the number of deals by stage and the average deal value by stage side by side.',[]],
  ['Put stage deal counts beside average deal values.',[{kind:'summary',elementIds:['stage_counts','stage_average']}]],
  ['Add separate stage count and mean deal-value graphs, keeping existing cards.',[
    {kind:'groups',elementId:'stage_counts',measure:0},{kind:'groups',elementId:'stage_average',measure:0}]]
])test('F19 typed contract: '+command,()=>{
  const w=workspace(),before=structuredClone(w),core=Core.create(w.tableSchema);
  const prior=apply(w,{action:'dashboard_plan',operations:[add('existing_kpi',spec('sum',{chart:'kpi',groupBy:null,title:'Existing total'}))],questions:[]}).board;
  const action=dashboard(questions),pipeline={...w,currentDate:today,visibleIds:[1],dashboard:{board:prior}},payload={userCommand:command,pipeline};
  const result={crmAction:action,assistantMessage:'Untrusted planner commentary'};
  const compiled=apply(w,action,prior),computed=Review.evidence(payload,result);
  assert.deepEqual(compiled.board.elements.map(e=>e.id),['existing_kpi','stage_counts','stage_average']);
  assert.deepEqual(compiled.board.elements[0],prior.elements[0]);
  assert.deepEqual(w.tableSchema.kpis,before.tableSchema.kpis);
  assert.equal(Customize.calculate(w.tableSchema.kpis[0],w.records,w.tableSchema,[],today).value,1035000);
  assert.equal(compiled.board.elements.filter(e=>e.spec.chart!=='kpi').length,2);
  const count=compiled.views.find(v=>v.id==='stage_counts').snapshot;
  const average=compiled.views.find(v=>v.id==='stage_average').snapshot;
  assert.equal(count.table.reduce((sum,row)=>sum+row.value,0),45);
  assert.deepEqual(Object.fromEntries(count.table.map(row=>[row.group,row.value])),{'Closed Lost':9,'Closed Won':11,'Not set':8,Qualified:17});
  assert.equal(count.recordCount,45);assert.equal(average.recordCount,45);
  assert.deepEqual(Object.fromEntries(average.table.map(row=>[row.group,row.value])),{'Closed Lost':33000,'Closed Won':23000,'Not set':41500,Qualified:9000});
  assert.equal(average.summaries[0].value,23000,'Overall average is weighted by records');
  const context={pipeline,computed};
  const review={requirements:[requirement('Stage counts',['count','groups'],['graph:stage_counts']),requirement('Average by stage',['average','groups'],['graph:stage_average']),
    requirement('Separate graphs',['separate_graphs'],['graph:stage_counts','graph:stage_average']),
    requirement('Retain existing card',['unchanged_graphs'],['unchanged:graph:existing_kpi'])],issues:[],clarificationQuestion:null};
  const allowed=Review.schemaFor(action,context).properties.requirements.items.properties.stepIds.items.enum;
  assert.deepEqual([...allowed].sort(),['root','graph:existing_kpi','graph:stage_counts','graph:stage_average','unchanged:graph:existing_kpi','lifecycle:preview_only'].sort());
  assert(review.requirements.every(item=>item.stepIds.every(id=>allowed.includes(id))));
  assert.deepEqual(Review.validateReview(review,result,context),{ok:true,requested:4,compiled:4,mappingIssues:[]});
  for(const stepIds of [['root'],['graph:existing_kpi'],[]]){
    const invalid=structuredClone(review);invalid.requirements[3].stepIds=stepIds;
    assert.equal(Review.validateReview(invalid,result,context).ok,false);
  }
  assert.equal(Read.supports(action,['graph:stage_counts'],['count','groups'],{pipeline}),true);
  assert.equal(Read.supports(action,['graph:stage_counts'],['average'],{pipeline}),false);
  assert.equal(Read.supports(action,['graph:stage_average'],['average','groups'],{pipeline}),true);
  assert.deepEqual(computed.board,compiled.board);
  assert.equal(Review.renderAnswer(payload,result,computed),compiled.answer);
  const state=Conversation.validateState({view:'dashboard',report:{...compiled.board.elements[2].spec,dashboard:compiled.board}});
  const reloaded=JSON.parse(JSON.stringify(state)).report.dashboard;
  assert.deepEqual(reloaded,compiled.board);
  assert.deepEqual(Dashboard.evaluate(reloaded,w.records,core,w.customFields,{today}),compiled.views);
  const changed=apply(w,{action:'dashboard_plan',operations:[{op:'update',ids:['stage_average'],mode:'add_filter',where:[],replaceFields:[],changes:[{field:'chart',value:'line'}]}],questions:[]},reloaded);
  assert.deepEqual(changed.board.elements.slice(0,2),compiled.board.elements.slice(0,2));
  assert.deepEqual(w,before);
});

test('count-only or ungrouped replacements cannot satisfy the average-by-stage component',()=>{
  for(const wrong of [spec('count'),spec('average',{groupBy:null,chart:'kpi'})]){
    const action=dashboard();action.operations[1].spec=wrong;
    const w=workspace();apply(w,action);
    assert.equal(Read.supports(action,['graph:stage_average'],['average','groups']),false);
  }
  const w=workspace(),action=dashboard(),prior=apply(w,{action:'dashboard_plan',operations:[add('stage_counts',spec('count'))],questions:[]}).board;
  const before=structuredClone(prior);
  assert.throws(()=>apply(w,action,prior),/unique ID/);assert.deepEqual(prior,before);
  action.operations[0].spec.measures[0].metric='invented';
  assert.throws(()=>apply(w,action));
  assert.equal(Read.supports(action,['root'],['count']),false);
});

test('maximum grouped sums return the underlying metric and every tied owner name without a dashboard change',()=>{
  const w=workspace();w.records=w.records.slice(0,4).map((r,i)=>({...r,f_owner:i<2?'Alex':'Sam',f_value:i%2?200:100}));
  const report={op:'report',id:'owner_totals',label:'Highest owner total',selection:null,spec:spec('sum',{groupBy:'f_owner'}),showDashboard:false,
    questions:[{kind:'value',label:'Highest total deal value',reference:{elementId:'owner_totals',measure:0,stat:'maximum'}}]};
  const action=F.plan([report]),pipeline={...w,currentDate:today,visibleIds:w.records.map(r=>r.id)};
  const result={crmAction:action},computed=Review.evidence({userCommand:'Who has the highest total deal value?',pipeline},result);
  assert.match(computed.answers[0],/Alex, Sam/);assert.match(computed.answers[0],/\$300\.00/);
  assert.equal(computed.effects.some(effect=>effect.kind==='dashboard'),false);
  assert.equal(Plan.prepare(w,action,{today,nonce:'extrema'}).mutates,false);
  const review={requirements:[requirement('Highest total',['sum','max'],['owner_totals']),requirement('Every tied owner',['names'],['owner_totals'])],issues:[],clarificationQuestion:null};
  assert.equal(Review.validateReview(review,result,{pipeline}).ok,true);
  report.questions=[{kind:'summary',elementIds:['owner_totals']}];
  assert.equal(Read.supports(action,['owner_totals'],['max','names'],{pipeline}),false);
});

test('colliding split-series labels remain isolated in groups, extrema and selected cells',()=>{
  const w=workspace();w.records=w.records.slice(0,3).map((r,i)=>({...r,f_stage:i<2?'Qualified':'Closed Won',f_owner:i<2?'X':'X / A',f_value:i<2?10:1000}));
  const combined=spec('sum',{splitBy:'f_owner',measures:[{label:'B',metric:'sum',field:'f_value',where:[[F.where('f_stage','equals','Qualified')]]},{label:'A / B',metric:'average',field:'f_value',where:[]}]});
  const compiled=apply(w,{action:'dashboard_plan',operations:[add('combined',combined)],questions:[]});
  assert.equal(compiled.views[0].result.datasets.filter(d=>d.label==='X / A / B').length,2);
  const extrema=Dashboard.context(compiled.board,compiled.views).displayed[0].extrema.filter(row=>row.series==='X / A / B');
  assert.deepEqual(extrema.map(row=>row.measure),[1,0]);
  assert.deepEqual(extrema.map(row=>row.maximum),[10,null]);
  const groups=Dashboard.analyze([{kind:'groups',elementId:'combined',measure:0}],compiled.views);
  assert.match(groups,/Qualified \/ X \/ B: \$20\.00/);assert.doesNotMatch(groups,/1,000|\$10/);
  const minimum=Dashboard.analyze([{kind:'value',label:'Smallest total',reference:{elementId:'combined',measure:0,stat:'minimum_nonzero'}}],compiled.views);
  assert.match(minimum,/Smallest total: \$20\.00/);assert.match(minimum,/Qualified/);assert.doesNotMatch(minimum,/Closed Won/);
  const cell=Dashboard.analyze([{kind:'value',label:'Average',reference:{elementId:'combined',measure:1,stat:'group',group:'Qualified',series:'X / A / B'}}],compiled.views);
  assert.match(cell,/Average: \$10\.00/);
});

test('context and analysis agree on signed minimum-nonzero values',()=>{
  const w=workspace();w.records=w.records.slice(0,2).map((row,i)=>({...row,f_stage:i?'Closed Won':'Qualified',f_value:i?10:-5}));
  const compiled=apply(w,{action:'dashboard_plan',operations:[add('signed',spec('sum'))],questions:[]});
  const context=Dashboard.context(compiled.board,compiled.views).displayed[0];
  assert.equal(context.extrema[0].minimumNonzero,-5);
  assert.deepEqual(context.extrema[0].smallestNonzero,['Qualified']);
  assert.match(Dashboard.analyze([{kind:'value',label:'Minimum',reference:{elementId:'signed',measure:0,stat:'minimum_nonzero'}}],compiled.views),/Minimum: -\$5\.00/);
});

test('review schema and validation isolate two computed widgets and reject malformed evidence references',()=>{
  const action=dashboard(),pipeline={...workspace(),currentDate:today},result={crmAction:action};
  const before=structuredClone({action,pipeline});
  assert.equal(Review.evidence({pipeline},result).displayed.length,2);
  const allowed=Review.schemaFor(action,{pipeline}).properties.requirements.items.properties.stepIds.items.enum;
  assert.deepEqual(allowed,['root','graph:stage_counts','graph:stage_average']);
  const counts=requirement('Stage counts',['count','groups'],['graph:stage_counts']);
  const average=requirement('Stage averages',['average','groups'],['graph:stage_average']);
  const check=(...requirements)=>Review.validateReview({requirements,issues:[],clarificationQuestion:null},result,{pipeline});
  assert.deepEqual(check(counts,average),{ok:true,requested:2,compiled:2,mappingIssues:[]});
  const borrowed=check(counts,{...average,stepIds:['graph:stage_counts']});
  assert.equal(borrowed.ok,false);assert.equal(borrowed.compiled,1);assert.equal(borrowed.mappingIssues.length,1);
  for(const stepIds of [['stage_average'],['graph:missing'],['graph:stage_average/extra'],['graph:stage_average '],
    ['graphs/graph:stage_average'],['graph:stage_average','graph:missing'],['graph:stage_average','graph:stage_average'],
    [null],[{}],[],'graph:stage_average']){
    const invalid=check({...average,stepIds});
    assert.equal(invalid.ok,false,JSON.stringify(stepIds));assert.equal(invalid.compiled,0);
  }
  assert.equal(check(requirement('Retain removed component',[],['graph:missing'],'compiled_action')).ok,false);
  assert.deepEqual({action,pipeline},before);
  assert.equal(Review.schema.properties.requirements.items.properties.stepIds.items.enum,undefined);
});

test('nested dashboard evidence is scoped to both the workspace step and the element',()=>{
  const action=F.plan([
    {op:'dashboard',id:'first',label:'Counts',plan:{action:'dashboard_plan',operations:[add('same',spec('count'))],questions:[]}},
    {op:'dashboard',id:'second',label:'Averages',plan:{action:'dashboard_plan',operations:[{op:'clear'},add('same',spec('average'))],questions:[]}}
  ]);
  const pipeline={...workspace(),currentDate:today},result={crmAction:action};
  const computed=Review.evidence({pipeline},result);assert.equal(computed.effects.length,2);
  const allowed=Review.schemaFor(action,{pipeline}).properties.requirements.items.properties.stepIds.items.enum;
  assert.deepEqual(allowed,['first/graph:same','first','second/graph:same','second']);
  const check=(...requirements)=>Review.validateReview({requirements,issues:[],clarificationQuestion:null},result,{pipeline});
  const counts=requirement('Count by stage',['count','groups'],['first/graph:same']);
  const average=requirement('Average by stage',['average','groups'],['second/graph:same']);
  assert.deepEqual(check(counts,average),{ok:true,requested:2,compiled:2,mappingIssues:[]});
  assert.equal(check({...average,stepIds:['first/graph:same']}).ok,false);
  assert.equal(check({...average,stepIds:['second']}).ok,true,'The containing step retains its action-level contract');
  for(const stepId of ['root','same','graph:same','first/graph:missing','second/graph:same/extra','first_more/graph:same','second/graph:']){
    assert(!allowed.includes(stepId));
    assert.equal(check({...average,stepIds:[stepId]}).ok,false,stepId);
  }
});

test('review schema uses the supplied persisted board for updates and analysis, never stale component IDs',()=>{
  const w=workspace(),board=apply(w,dashboard()).board,pipeline={...w,currentDate:today,dashboard:{board}};
  const action={action:'dashboard_plan',operations:[{op:'update',ids:['stage_average'],mode:'add_filter',where:[],replaceFields:[],
    changes:[{field:'measures',value:spec('sum').measures}]}],questions:[]};
  const result={crmAction:action},computed=Review.evidence({pipeline},result),context={pipeline,computed};
  assert.equal(computed.displayed[1].summaries[0].metric,'sum');
  const allowed=Review.schemaFor(action,context).properties.requirements.items.properties.stepIds.items.enum;
  assert.deepEqual(allowed,['root','graph:stage_counts','graph:stage_average','unchanged:graph:stage_counts','lifecycle:preview_only']);
  const review={requirements:[requirement('Updated total',['sum','groups'],['graph:stage_average']),
    requirement('Retain counts',['unchanged_graphs'],['unchanged:graph:stage_counts'])],issues:[],clarificationQuestion:null};
  assert.equal(Review.validateReview(review,result,context).ok,true);
  assert.deepEqual(Review.schemaFor(action).properties.requirements.items.properties.stepIds.items.enum,[]);
  assert.equal(Review.validateReview(review,result).ok,false);
  const analysis={action:'analyze_dashboard',questions:[{kind:'groups',elementId:'stage_counts',measure:0}]};
  Review.evidence({pipeline},{crmAction:analysis});
  assert.deepEqual(Review.schemaFor(analysis,{pipeline}).properties.requirements.items.properties.stepIds.items.enum,['root','graph:stage_counts']);
  assert.equal(Review.validateReview(review,{crmAction:analysis},{pipeline}).ok,false);
  const remove={action:'dashboard_plan',operations:[{op:'remove',ids:['stage_average']}],questions:[]};
  const removed={pipeline,computed:Review.evidence({pipeline},{crmAction:remove})};
  assert.deepEqual(Review.schemaFor(remove,removed).properties.requirements.items.properties.stepIds.items.enum,['root','graph:stage_counts','unchanged:graph:stage_counts','lifecycle:preview_only']);
  assert.equal(Review.validateReview(review,{crmAction:remove},removed).ok,false);
  const malformed={action:'dashboard_plan',operations:[{op:'update',ids:['missing'],mode:'add_filter',where:[],replaceFields:[],changes:[]}],questions:[]};
  assert.throws(()=>Review.evidence({pipeline},{crmAction:malformed}),/existing graph/);
  assert.deepEqual(Review.schemaFor(malformed,{pipeline}).properties.requirements.items.properties.stepIds.items.enum,[]);
  assert.equal(Review.validateReview(review,{crmAction:malformed},{pipeline}).ok,false);
});

test('cross-graph percentage evidence belongs to root, not either operand or their union',()=>{
  const action={action:'dashboard_plan',operations:[add('left',spec('count')),add('right',spec('count'))],questions:[
    {kind:'percentage',label:'Record ratio',left:{elementId:'left',measure:0,stat:'records'},right:{elementId:'right',measure:0,stat:'records'}}]};
  const pipeline={...workspace(),currentDate:today},result={crmAction:action};
  assert.match(Review.evidence({pipeline},result).answer,/Record ratio: 100%/);
  assert.deepEqual(Review.schemaFor(action,{pipeline}).properties.requirements.items.properties.stepIds.items.enum,['root','graph:left','graph:right']);
  const review={requirements:[requirement('Record ratio',['percentages'])],issues:[],clarificationQuestion:null};
  assert.equal(Review.validateReview(review,result,{pipeline}).ok,true);
  for(const stepIds of [['graph:left'],['graph:right'],['graph:left','graph:right']]){
    review.requirements[0].stepIds=stepIds;assert.equal(Review.validateReview(review,result,{pipeline}).ok,false);
  }
});
