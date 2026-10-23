'use strict';

const test=require('node:test'),assert=require('node:assert/strict');
const Dashboard=require('../public/dashboard-board'),Reports=require('../public/report-engine'),Core=require('../public/pipeline-core');
const Read=require('../lib/read-output-contract'),Review=require('../lib/action-review'),Conversation=require('../lib/conversation-core');
const Plan=require('../public/workspace-plan'),Customize=require('../public/workspace-customization'),F=require('./fixtures/workspace-plans.cjs');
const today='2026-10-23';
const measure=metric=>({label:metric,metric,field:['count','percentage'].includes(metric)?null:'f_value',where:[]});
const spec=(metrics,extra={})=>({version:1,title:metrics.join(' and ')+' by Stage',chart:'bar',scope:'all',groupBy:'f_stage',
  bucket:'none',splitBy:null,where:[],sort:'label_asc',limit:null,measures:metrics.map(measure),...extra});
const add=(id,spec)=>({op:'add',id,spec});
const action=(operations,questions=[])=>({action:'dashboard_plan',operations,questions});
const update=(ids,changes)=>({op:'update',ids,mode:'add_filter',where:[],replaceFields:[],changes});
const workspace=()=>{
  const w=F.workspace(),value=w.tableSchema.fields.find(field=>field.id==='f_value');
  value.type='number';value.name='Deal Value (USD)';
  w.tableSchema=Customize.addKpi(w.tableSchema,[],'kpi_user_retained',{title:'Saved total',metric:'sum',field:'f_value',conditions:[]}).tableSchema;
  const stages=[...w.tableSchema.fields.find(field=>field.id==='f_stage').options,''];
  // Synthetic reproducer: numeric storage, 45 records, seven groups, and a known weighted mean.
  w.records=Array.from({length:45},(_,index)=>({...w.records[0],id:index+1,f_deal:'Deal '+(index+1),
    f_stage:stages[index%stages.length],f_value:36640+(index-22)*100}));
  return w;
};
const apply=(w,a,board=null)=>Dashboard.apply(board,a,w.records,Core.create(w.tableSchema),w.customFields,{today});
const requirement=(description,requiredOutputs,stepIds)=>({description,requiredOutputs,stepIds,evidenceKind:'computed_read',satisfied:true});
const review=requirements=>({requirements,issues:[],clarificationQuestion:null});

test('numeric storage cannot make count and average compatible chart-axis units',()=>{
  const w=workspace(),mixed=spec(['count','average']),a=action([add('by_stage_count_and_avg',mixed)]);
  const raw=Reports.execute(w.records,mixed,Core.create(w.tableSchema),[],{today});
  assert.deepEqual(raw.summaries.map(m=>[m.type,m.value]),[['number',45],['number',36640]]);
  assert.throws(()=>apply(w,a),/separate dashboard_plan add operations/);
  assert.throws(()=>Review.evidence({pipeline:{...w,currentDate:today}},{crmAction:a}),/independent units/);
  assert.deepEqual(Read.evidenceIds(a),[]);
  assert.equal(Read.supports(a,['root'],['count','average','groups']),false);
  assert.equal(Read.supports(a,['graph:by_stage_count_and_avg'],['separate_graphs']),false);
});

for(const command of [
  'Show the number of deals by stage and the average deal value by stage side by side.',
  'Put stage counts beside mean deal values.',
  'Replace the temporary report with two separate graphs side by side: count and average by Stage.'
])test('independent numeric families and component layout: '+command,()=>{
  const w=workspace(),before=structuredClone(w),prior=apply(w,action([add('retained_kpi',spec(['sum'],{chart:'kpi',groupBy:null}))])).board;
  const a=action([add('by_stage_count',spec(['count'])),add('by_stage_avg_value',spec(['average']))]);
  const pipeline={...w,currentDate:today,dashboard:{board:prior}},result={crmAction:a};
  const computed=Review.evidence({userCommand:command,pipeline},result),compiled=apply(w,a,prior);
  assert.deepEqual(compiled.board.elements.map(e=>e.id),['retained_kpi','by_stage_count','by_stage_avg_value']);
  assert.deepEqual(compiled.board.elements[0],prior.elements[0]);
  assert.equal(compiled.views[1].snapshot.table.reduce((sum,row)=>sum+row.value,0),45);
  assert.equal(compiled.views[2].snapshot.summaries[0].value,36640);
  for(const view of compiled.views.slice(1)){
    assert.equal(view.snapshot.recordCount,45);assert.equal(view.snapshot.shownGroups,7);
    assert(view.snapshot.table.some(row=>row.group==='Not set'));assert.equal(view.result.datasets.length,1);
  }
  const requirements=[requirement('Counts',['count','groups'],['graph:by_stage_count']),
    requirement('Averages',['average','groups'],['graph:by_stage_avg_value']),
    requirement('Independent graphs side by side',['separate_graphs'],['graph:by_stage_count','graph:by_stage_avg_value'])];
  assert.deepEqual(Review.validateReview(review(requirements),result,{pipeline}),{ok:true,requested:3,compiled:3,mappingIssues:[]});
  assert.equal(Review.renderAnswer({pipeline},result,computed),compiled.answer);
  const state=Conversation.validateState({view:'dashboard',report:{...compiled.board.elements[2].spec,dashboard:compiled.board}});
  assert.deepEqual(Dashboard.evaluate(JSON.parse(JSON.stringify(state)).report.dashboard,w.records,Core.create(w.tableSchema),[],{today}),compiled.views);
  assert.deepEqual(w,before);
});

test('count and distinct-count families stay separate from every field-value aggregation',()=>{
  const w=workspace();
  for(const count of ['count','count_distinct'])for(const value of ['sum','average','min','max','median'])for(const chart of ['bar','line']){
    assert.throws(()=>apply(w,action([add('mixed',spec([count,value],{chart}))])),/independent units/);
  }
  assert.throws(()=>apply(w,action([add('mixed',spec(['count','percentage']))])),/independent units/);
  assert.throws(()=>apply(w,action([add('mixed',spec(['average','percentage']))])),/independent units/);
  assert.throws(()=>apply(w,action([add('mixed',spec(['count','average'],{chart:'stage'}))])),/independent units/);
  assert.throws(()=>apply(w,action([add('mixed',spec(['count','invented']))])),/supported graph metric/);
});

test('same-family series and axis-free KPI readouts keep existing report validation',()=>{
  const w=workspace();
  for(const metrics of [['sum','average','min','max','median'],['count','count_distinct']]){
    const compiled=apply(w,action([add('compatible',spec(metrics))]));
    assert.equal(compiled.views[0].result.datasets.length,metrics.length);
  }
  const a=action([add('readouts',spec(['count','average'],{chart:'kpi',groupBy:null}))]);
  assert.equal(apply(w,a).views[0].snapshot.summaries.length,2);
  assert.equal(Read.supports(a,['graph:readouts'],['count','average']),true);
  assert.equal(Read.supports(a,['graph:readouts'],['separate_graphs']),false);
  w.tableSchema.fields.find(field=>field.id==='f_value').type='currency';
  w.tableSchema.fields.push({id:'f_hours',name:'Hours',type:'number',role:'none',options:[]});
  const incompatible=spec(['sum','average']);incompatible.measures[1].field='f_hours';
  assert.throws(()=>apply(w,action([add('incompatible',incompatible)])),/different units/);
});

test('updates fail atomically when introducing incompatible axis families, including KPI conversions',()=>{
  const w=workspace(),board=apply(w,action([add('counts',spec(['count'])),add('averages',spec(['average']))])).board;
  const before=structuredClone(board);
  const a=action([update(['counts'],[{field:'title',value:'Would change'}]),update(['averages'],[{field:'measures',value:spec(['count','average']).measures}])]);
  assert.throws(()=>apply(w,a,board),/independent units/);assert.deepEqual(board,before);
  assert.deepEqual(Read.evidenceIds(a,{pipeline:{dashboard:{board}}}),[]);
  assert.equal(Read.supports(a,['graph:averages'],['average'],{pipeline:{dashboard:{board}}}),false);
  const kpi=apply(w,action([add('readouts',spec(['count','average'],{chart:'kpi',groupBy:null}))])).board;
  assert.throws(()=>apply(w,action([update(['readouts'],[{field:'chart',value:'bar'}])]),kpi),/independent units/);
});

test('already persisted mixed numeric graphs remain readable and can be replaced without ID or KPI loss',()=>{
  const w=workspace(),old={version:1,elements:[{id:'old_combined',spec:spec(['count','average']),visibleIds:[]}],sharedFilters:[],activeId:'old_combined'};
  const before=structuredClone(old);
  assert.equal(Dashboard.evaluate(old,w.records,Core.create(w.tableSchema),[],{today}).length,1);
  const renamed=apply(w,action([update(['old_combined'],[{field:'title',value:'Earlier report'}])]),old);
  assert.equal(renamed.board.elements[0].id,'old_combined');
  const appended=apply(w,action([add('new_count',spec(['count'])),add('new_average',spec(['average']))]),old);
  assert.deepEqual(appended.board.elements[0],old.elements[0]);
  const replacement=apply(w,action([{op:'remove',ids:['old_combined']},add('new_count',spec(['count'])),add('new_average',spec(['average']))]),old);
  assert.deepEqual(replacement.board.elements.map(e=>e.id),['new_count','new_average']);assert.deepEqual(old,before);
});

test('separate_graphs requires distinct non-KPI component references, not root or two series',()=>{
  const w=workspace(),a=action([add('counts',spec(['count'])),add('averages',spec(['average'])),add('kpi',spec(['sum'],{chart:'kpi',groupBy:null}))]);
  apply(w,a);
  assert.equal(Read.supports(a,['graph:counts','graph:averages'],['separate_graphs']),true);
  for(const ids of [['root'],['graph:counts'],['graph:counts','graph:counts'],['graph:counts','graph:kpi'],['graph:counts','graph:missing']]){
    assert.equal(Read.supports(a,ids,['separate_graphs']),false,JSON.stringify(ids));
    assert.equal(Review.validateReview(review([requirement('Separate graphs',['separate_graphs'],ids)]),{crmAction:a}).ok,false);
  }
  const single=action([add('two_series',spec(['sum','average']))]);
  assert.equal(Read.supports(single,['graph:two_series'],['separate_graphs']),false);
  const removed=action([...a.operations,{op:'remove',ids:['averages']}]);
  assert.equal(Read.supports(removed,['graph:counts','graph:averages'],['separate_graphs']),false);
});

test('chart-only count, average and layout need no record projection or explicit prose questions',()=>{
  const w=workspace(),a=action([add('counts',spec(['count'])),add('averages',spec(['average']))]);
  const pipeline={...w,currentDate:today},result={crmAction:a,assistantMessage:'Charts prepared.'};
  const computed=Review.evidence({pipeline},result),ids=['graph:counts','graph:averages'];
  assert.deepEqual(a.questions,[]);
  assert.equal(computed.recordReadEvidence,undefined,'Dashboard evidence is not a current-field or history source read');
  const contract=Review.schemaFor(a,{pipeline});
  assert.deepEqual(contract.properties.requirements.items.properties.stepIds.items.enum,['root',...ids]);
  assert.equal(contract.properties.requirements.items.properties.stepIds.description,undefined);
  const combined=requirement('Display count and average by Stage side by side',['count','average','groups','separate_graphs'],ids);
  assert.deepEqual(Review.validateReview(review([combined]),result,{pipeline}),{ok:true,requested:1,compiled:1,mappingIssues:[]});
  const independent=[requirement('Count chart',['count','groups'],[ids[0]]),requirement('Average chart',['average','groups'],[ids[1]]),
    {...requirement('Side-by-side layout',['separate_graphs'],ids),evidenceKind:'compiled_action'}];
  assert.deepEqual(Review.validateReview(review(independent),result,{pipeline}),{ok:true,requested:3,compiled:3,mappingIssues:[]});
  assert.match(Review.instructions,/A rendered grouped chart is computed evidence of its groups and metric/);
});

test('saved-fact source mapping does not displace nested chart metrics or add layout to text reads',()=>{
  const w=workspace(),a=F.plan([
    F.select('selected',[[F.where('f_deal','equals','Deal 1')]]),
    {op:'read_records',id:'saved_fact',label:'Current saved wording',selection:'selected',showTable:false,outputs:[{kind:'fields',field:'f_notes'}]},
    {op:'dashboard',id:'charts',label:'Stage comparison',plan:action([add('counts',spec(['count'])),add('averages',spec(['average']))])}
  ]);
  const pipeline={...w,currentDate:today},result={crmAction:a},computed=Review.evidence({pipeline},result);
  assert.deepEqual(computed.recordReadEvidence,[{stepId:'saved_fact',source:'current_fields',selection:'selected',outputs:['fields'],recordIds:[1]}]);
  const ids=['charts/graph:counts','charts/graph:averages'];
  const contract=Review.schemaFor(a,{pipeline}),stepIds=contract.properties.requirements.items.properties.stepIds;
  assert(ids.every(id=>stepIds.items.enum.includes(id)));
  assert.match(stepIds.description,/saved_fact \(current_fields: fields\)/);
  const requirements=[requirement('Stored wording',['fields'],['saved_fact']),
    requirement('Rendered count and average comparison',['count','average','groups','separate_graphs'],ids)];
  assert.deepEqual(Review.validateReview(review(requirements),result,{pipeline}),{ok:true,requested:2,compiled:2,mappingIssues:[]});
  assert.equal(Read.supports(a,['saved_fact'],['separate_graphs'],{pipeline}),false);
  assert.equal(Read.supports(a,ids,['fields'],{pipeline}),false,'Chart display does not invent a requested text projection');
});

test('nested layouts cannot borrow an earlier replaced dashboard or a single displayed report',()=>{
  const w=workspace(),both=action([add('counts',spec(['count'])),add('averages',spec(['average']))]);
  const a=F.plan([{op:'dashboard',id:'charts',label:'Both graphs',plan:both}]);
  assert.equal(Plan.prepare(w,a,{today,nonce:'families'}).effects[0].board.elements.length,2);
  assert.equal(Read.supports(a,['charts/graph:counts','charts/graph:averages'],['separate_graphs']),true);
  assert.equal(Read.supports(a,['charts'],['separate_graphs']),false);
  a.steps.push({op:'dashboard',id:'replacement',label:'Replace',plan:action([{op:'clear'},add('only',spec(['count']))])});
  assert.equal(Read.supports(a,['charts/graph:counts','charts/graph:averages'],['separate_graphs']),false);
  const report={op:'report',id:'report',label:'Report',selection:null,spec:spec(['count','average']),showDashboard:true,
    questions:[{kind:'summary',elementIds:['report']}]};
  assert.deepEqual(Read.evidenceIds(F.plan([report])),[],'A displayed report cannot bypass the axis contract');
  report.showDashboard=false;
  assert.equal(Read.supports(F.plan([report]),['report'],['count','average']),true,'Answer-only scalar results need no shared axis');
  const nested=F.plan([{op:'dashboard',id:'charts',label:'Invalid combination',plan:action([add('combined',spec(['count','average']))])}]);
  assert.throws(()=>Plan.prepare(w,nested,{today,nonce:'families'}),/independent units/);
});

test('action schemas advertise metric-family separation without prompt-specific parsing',()=>{
  const w=workspace(),core=Core.create(w.tableSchema),schemas=Dashboard.schemas(core,[]);
  const operations=schemas[0].properties.operations.items.anyOf;
  const addSchema=operations.find(op=>op.properties.op.enum.includes('add'));
  assert.match(addSchema.properties.spec.description,/Numeric storage does not make record counts and field values compatible/);
  assert.match(addSchema.properties.spec.properties.measures.description,/separate graph elements with distinct IDs/);
  assert.match(operations.find(op=>op.properties.op.enum.includes('update')).properties.changes.description,/one metric family/);
  assert(Review.schema.properties.requirements.items.properties.requiredOutputs.items.enum.includes('separate_graphs'));
});
