'use strict';

const test=require('node:test'),assert=require('node:assert/strict');
const {schema,supports}=require('../lib/read-output-contract');
const spec=(metric='sum',field=metric==='count'||metric==='percentage'?null:'amount')=>({version:1,title:'Report',chart:'bar',
  scope:'all',groupBy:'owner',bucket:'none',splitBy:null,where:[],sort:'label_asc',limit:null,measures:[{label:'Measure',metric,field,where:[]}]});
const pipeline=(...elements)=>({dashboard:{board:{version:1,elements:elements.map(([id,value])=>({id,spec:value,visibleIds:[]})),sharedFilters:[],activeId:elements[0]?.[0]??null}}});
const plan=(...steps)=>({action:'workspace_plan',version:1,title:'Read',goals:[],unmappedFacts:[],steps});
const read=(id,...kinds)=>({op:'read_records',id,label:'Read',selection:'selected',showTable:false,
  outputs:kinds.map(kind=>({kind,field:['count','names'].includes(kind)?null:'amount'}))});
const report=(id,value,questions,showDashboard=false)=>({op:'report',id,label:'Report',selection:null,spec:value,questions,showDashboard});
const reference=(elementId,stat='aggregate',measure=0)=>({elementId,measure,stat});
const value=reference=>({kind:'value',label:'Requested value',reference});
const groups=elementId=>({kind:'groups',elementId,measure:0});
const percentages=(elementId,denominator='matching_records')=>({kind:'group_percentages',elementId,measure:0,denominator});
const compare=(kind,left,right)=>({kind,label:'Comparison',left,right});
const analyze=(...questions)=>({action:'analyze_dashboard',questions});
const dashboard=(operations,questions=[])=>({action:'dashboard_plan',operations,questions});
const add=(id,value)=>({op:'add',id,spec:value});
const update=(ids,changes)=>({op:'update',ids,mode:'add_filter',where:[],replaceFields:[],changes});
const root=(action,required,p)=>supports(action,['root'],required,{pipeline:p});

test('exports a bounded array schema and treats only explicit empty requirements as noncomputed',()=>{
  assert.deepEqual(schema.items.enum,['count','names','fields','sum','average','median','distinct','min','max','groups','percentages']);
  assert.equal(schema.type,'array');assert.equal(schema.maxItems,11);
  assert.equal(supports(null,[],[]),true);assert.equal(supports({action:'undo_action'},['root'],[]),true);
  for(const required of [undefined,null,'count',{},['unknown'],['count','count'],Array(12).fill('count'),new Array(1)]){
    assert.equal(supports(read('answer','count'),['root'],required),false);
  }
});

test('workspace outputs use exact typed kinds from only the mapped steps',()=>{
  const direct=schema.items.enum.slice(0,9),action=plan(read('first','count','names'),read('second',...direct));
  assert.equal(supports(action,['second'],direct),true);
  assert.equal(supports(action,['first'],['sum']),false);
  assert.equal(supports(action,['first','second'],['names','sum','median','distinct','min','max']),true);
  for(const required of [['percentages'],['groups']])assert.equal(supports(action,['second'],required),false);
  for(const ids of [[],['root'],['missing'],['first','missing'],['first','first'],Array(31).fill('first')])assert.equal(supports(action,ids,['count']),false);
  assert.equal(supports(plan({op:'select_records',id:'selected'}),['selected'],['names']),false);
  assert.equal(supports(plan(read('same','count'),read('same','sum')),['same'],['count']),false);
});

test('malformed direct outputs and prose claims never grant output capabilities',()=>{
  for(const output of [{kind:'count',field:'amount'},{kind:'sum',field:null},{kind:'fields'},
    {kind:'percentages',field:'amount'},{kind:'names',field:null,answer:'50%'},null]){
    const action=plan({...read('answer','count'),outputs:[{kind:'count',field:null},output]});
    assert.equal(supports(action,['answer'],['count']),false);
  }
  const action=plan(read('answer','count'));action.steps[0].label='Names, totals and percentages: 100%';
  action.assistantMessage='All percentages are computed.';action.computedAnswer='50%';
  assert.equal(supports(action,['answer'],['percentages']),false);
});

test('values, differences and grouped counts cannot satisfy percentages, but typed percentage questions can',()=>{
  const p=pipeline(['cohort',spec('count')]);
  const questions=[value(reference('cohort','maximum')),
    compare('difference',reference('cohort','maximum'),reference('cohort','minimum_nonzero')),groups('cohort')];
  const action=analyze(...questions);
  assert.equal(root(action,['count','min','max','groups'],p),true);
  assert.equal(root(action,['percentages'],p),false);
  assert.equal(root(analyze(...questions,percentages('cohort')),['percentages','groups'],p),true);
  assert.equal(root(analyze(compare('percentage',reference('cohort','maximum'),reference('cohort','records'))),['percentages'],p),false,'Incompatible units fail closed');
  assert.equal(root(analyze(compare('percentage',reference('cohort','records'),reference('cohort','records'))),['percentages'],p),true);
  assert.equal(root(analyze({...groups('cohort'),label:'Percentages'}),['percentages'],p),false);
});

test('graph metrics and reference statistics resolve exactly, including distinct and percentage measures',()=>{
  for(const [metric,output] of [['count','count'],['sum','sum'],['average','average'],['median','median'],
    ['min','min'],['max','max'],['count_distinct','distinct'],['percentage','percentages']]){
    const p=pipeline(['graph',spec(metric)]);
    assert.equal(root(analyze(value(reference('graph'))),[output],p),true);
    assert.equal(root(analyze({kind:'summary',elementIds:['graph']}),[output,'count'].filter((v,i,a)=>a.indexOf(v)===i),p),true);
    assert.equal(root(analyze(groups('graph')),[output,'groups'],p),true);
    assert.equal(root(analyze(value(reference('graph','maximum'))),['max'],p),true);
    if(output!=='count'&&output!=='max')assert.equal(root(analyze(value(reference('graph','maximum'))),[output],p),false);
  }
  const p=pipeline(['graph',spec('sum')]);
  assert.equal(root(analyze(value({...reference('graph','group'),group:'A',series:null})),['sum'],p),true);
  assert.equal(root(analyze(value({...reference('graph','group'),group:'A',series:null})),['groups'],p),false);
  assert.equal(root(analyze(groups('graph')),['names','fields'],p),false);
});

test('percentage denominators and both references must resolve without unknown acceptance',()=>{
  const p=pipeline(['sum',spec('sum')],['average',spec('average')],['other',spec('sum','other_amount')]);
  assert.equal(root(analyze(percentages('sum','measure_total')),['sum','percentages','groups'],p),true);
  assert.equal(root(analyze(percentages('average')),['percentages'],p),true);
  assert.equal(root(analyze(percentages('average')),['average'],p),false,'Record shares do not emit average values');
  for(const question of [percentages('average','measure_total'),percentages('sum','invented'),percentages('missing'),
    {...percentages('sum'),measure:1},compare('percentage',reference('sum'),reference('other')),
    compare('percentage',reference('sum'),reference('missing')),value(reference('sum','invented'))]){
    assert.equal(root(analyze(question),['percentages'],p),false);
  }
  assert.equal(root(analyze(percentages('sum')),['percentages']),false);
  assert.equal(root(analyze(groups('sum')),['groups'],pipeline(['sum',spec('unknown')])),false);
  assert.equal(root(analyze(groups('sum')),['groups'],pipeline(['sum',spec()],['sum',spec()])),false);
});

test('new and updated graph specs determine capabilities in operation order',()=>{
  const p=pipeline(['existing',spec('count')]);
  const action=dashboard([update(['existing'],[{field:'measures',value:spec('average').measures}]),add('new',spec('percentage'))],
    [{kind:'summary',elementIds:['existing','new']}]);
  const original=structuredClone({p,action});
  assert.equal(root(action,['average','percentages'],p),true);assert.equal(root(action,['sum'],p),false);
  assert.deepEqual({p,action},original);
  assert.equal(root(dashboard([add('new',spec('sum'))]),['sum','count']),true,'Empty dashboard questions default to summary');
  assert.equal(root(dashboard([add('new',spec('sum'))]),['groups']),false);
  assert.equal(root(dashboard([update(['missing'],[])]),['count'],p),false);
  assert.equal(root(dashboard([add('existing',spec())]),['sum'],p),false);
  assert.equal(root(dashboard([{op:'remove',ids:['existing']}],[groups('existing')]),['groups'],p),false);
  assert.equal(root(dashboard([{op:'clear'},add('new',spec('median'))]),['median'],p),true);
  assert.equal(root(dashboard([update(['existing'],[{field:'measures',value:spec('unknown').measures}])]),['count'],p),false);
});

test('workspace reports and dashboard steps track board state without borrowing unreferenced answers',()=>{
  const action=plan(report('report',spec('sum'),[groups('report')],true),
    {op:'dashboard',id:'change',plan:dashboard([update(['report'],[{field:'measures',value:spec('percentage').measures}])])});
  assert.equal(supports(action,['report'],['sum','groups']),true);
  assert.equal(supports(action,['report'],['percentages']),false);
  assert.equal(supports(action,['change'],['percentages']),true);
  assert.equal(supports(action,['change'],['sum','groups']),false);
  assert.equal(supports(action,['report','change'],['sum','groups','percentages']),true);
  action.steps[0].showDashboard=false;
  assert.equal(supports(action,['change'],['percentages']),false,'Answer-only reports do not become the current board');
  assert.equal(supports(plan(report('report',spec('sum'),[])),['report'],['sum']),false,'Reports have no implicit summary');
  assert.equal(supports(plan(report('report',spec('sum'),[groups('other')])),['report'],['groups']),false);
});

test('independent business query IDs cannot borrow root or another nonexistent scope',()=>{
  const query=id=>({id,typeId:'contacts',query:null,linkedTo:null,relationshipTypeId:null});
  const action={action:'query_business_batch',queries:[query('first'),query('second')]};
  assert.equal(supports(action,['second'],['count','names','fields']),true);
  for(const stepIds of [['root'],['missing'],['first','missing']])assert.equal(supports(action,stepIds,['count']),false);
  assert.equal(supports(action,['first'],['sum']),false);
  assert.equal(supports({...action,queries:[query('first'),query('first')]},['first'],['count']),false);
  assert.equal(root({action:'query_business'},['names','fields','count']),true);
});

test('task, audit and legacy reads cover only their canonical answer shapes',()=>{
  assert.equal(root({action:'query_todos'},['count','names','fields']),true);
  assert.equal(root({action:'query_todos'},['groups','percentages']),false);
  assert.equal(root({action:'audit_records',groups:[{label:'Group',where:[[]]}]},['count','names','groups']),true);
  assert.equal(root({action:'audit_records',groups:[{}]},['fields']),false);
  assert.equal(root({action:'query_records'},['count']),true);assert.equal(root({action:'query_records'},['names']),false);
  assert.equal(root({action:'workflow_history'},['count','fields']),true);
  assert.equal(root({action:'show_kpi',...spec('median')},['median','count']),true);
  assert.equal(root({action:'show_report',smartReport:spec('percentage')},['percentages']),true);
  assert.equal(root({action:'show_report'},['percentages']),false);
  const p=pipeline(['current',spec('sum')]);
  const action={action:'refine_report',mode:'add_filter',where:[],replaceFields:[],changes:[{field:'measures',value:spec('max').measures}]};
  assert.equal(root(action,['max'],p),true);assert.equal(root(action,['sum'],p),false);
  assert.equal(root(action,['max']),false);
});

test('bounded malformed contracts and unsupported actions fail closed',()=>{
  const p=pipeline(['graph',spec()]);
  for(const action of [null,{},[],{action:'undo_action'},{action:'business_plan'},analyze({kind:'invented'}),
    analyze(...Array(21).fill(groups('graph'))),dashboard(Array(25).fill({op:'clear'})),
    dashboard([{op:'invented'}]),dashboard([update(['graph'],Array(10).fill({field:'title',value:'x'}))]),
    plan(...Array.from({length:31},(_,i)=>read('read_'+i,'count')))]){
    assert.equal(root(action,['count'],p),false);
  }
  assert.equal(supports(plan(read('read','count')),['read'],['count'],{pipeline:{dashboard:{board:{elements:new Array(13)}}}}),false);
  for(const context of [null,[],false])assert.equal(supports({action:'query_records'},['root'],['count'],context),false);
});

test('invalid measure indexes, unknown metrics and duplicate updates cannot lend a known output',()=>{
  const p=pipeline(['graph',spec('sum')]);
  for(const index of [-1,0.5,1,NaN,'0',null])assert.equal(root(analyze(value(reference('graph','aggregate',index))),['sum'],p),false);
  for(const measure of [{metric:'sum',field:null},{metric:'percentage',field:'amount'},{metric:'count_distinct'},
    {metric:'invented',field:null}]){
    assert.equal(root(analyze(groups('graph')),['groups'],pipeline(['graph',{...spec(),measures:[measure]}])),false);
  }
  const changes=[{field:'measures',value:spec('sum').measures},{field:'measures',value:spec('average').measures}];
  assert.equal(root(dashboard([update(['graph'],changes)]),['sum'],p),false);
  assert.equal(root(analyze({kind:'summary',elementIds:['graph','missing']}),['sum'],p),false);
});
