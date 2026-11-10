'use strict';

const test=require('node:test'),assert=require('node:assert/strict');
const Board=require('../public/dashboard-board'),Core=require('../public/pipeline-core');
const Read=require('../lib/read-output-contract'),Review=require('../lib/action-review');
const Customize=require('../public/workspace-customization');
const F=require('./fixtures/workspace-plans.cjs');

const first='Show a stage chart of total deal value by stage and a KPI chart of average deal value for QA1105 deals';
const append='Add a third graph showing average deal value by owner for QA1105 deals. Keep both existing QA1105 graphs so I can compare all three.';
const together='Show three graphs together for QA1105 deals: deal count by owner as a bar chart, total deal value by stage as a line chart, and average deal value by owner as a bar chart.';
const where=(field,operator,value)=>[[F.where(field,operator,value)]];
const cohort=prefix=>({scope:'all',where:where('f_deal','starts_with',prefix)});
const add=(id,chart,metric,groupBy,extra={})=>({op:'add',id,spec:{version:1,title:id,chart,groupBy,
  scope:'all',bucket:'none',splitBy:null,where:[],sort:'label_asc',limit:null,
  measures:[{metric,label:metric,field:metric==='count'?null:'f_value',where:[]}],...extra}});
const total=chart=>add('stage_total',chart,'sum','f_stage');
const average=()=>add('mean','kpi','average',null);
const byOwner=()=>add('owner_mean','bar','average','f_owner');
const count=()=>add('owner_count','bar','count','f_owner');
const plan=(requestScope,...operations)=>({action:'dashboard_plan',requestScope,operations,questions:[]});
const workspace=(prefix='QA1105')=>{
  const w=F.workspace(),rows=[[0,'Ada','Open'],[12000,'Ada','Open'],[20000,'Ada','Won'],
    [18000,'Ben','Open'],[20000,'Ben','Won'],[null,'Cal','Lost']];
  w.records=rows.map(([f_value,f_owner,f_stage],i)=>({...w.records[i],f_value,f_owner,f_stage,f_deal:prefix+' '+i}));
  w.records.push({...w.records[5],id:7,f_deal:'Not '+prefix,f_value:91000});
  return {...w,visibleIds:[7,1,6],currentDate:'2026-11-05'};
};
const apply=(w,action,board)=>Board.apply(board,action,w.records,Core.create(w.tableSchema),[],{visibleIds:w.visibleIds,today:w.currentDate});
const req=(description,requiredOutputs,stepIds,evidenceKind='computed_read')=>({description,requiredOutputs,stepIds,evidenceKind,satisfied:true});
function checked(w,command,action,requirements,prior){
  const pipeline={...w,dashboard:prior?{board:prior}:null},result={crmAction:action};
  const computed=Review.evidence({pipeline,userCommand:command},result);
  const review=Review.validateReview({requirements,issues:[],clarificationQuestion:null},result,{pipeline,computed});
  assert.equal(review.ok,true,JSON.stringify(review.mappingIssues));
  return computed;
}
function assertOwners(view){
  assert.equal(view.snapshot.matchingCount,6);
  assert.deepEqual(view.snapshot.table.map(r=>[r.group,r.count,r.numericCount,Board.format(r.value,r.type)]),
    [['Ada',3,3,'$10,666.67'],['Ben',2,2,'$19,000.00'],['Cal',1,0,'Not set']]);
  assert.equal(view.result.datasets[0].values[2],null);
}

test('F04 live shape: an All deals title and KPI measure-only prefix; normalize only a declared shared cohort',()=>{
  const w=workspace(),local=average(),stage=total('stage'),prefix=cohort('QA1105').where;
  w.records.pop();
  for(let i=0;i<50;i++)w.records.push({...w.records[0],id:i+7,f_deal:'Unrelated '+i,f_value:i===49?2974:12000});
  local.spec.measures[0].where=prefix;stage.spec.title='Total deal value by Stage (All deals)';
  const old={action:'dashboard_plan',operations:[stage,local],questions:[]},before=structuredClone(old);
  const stats=({views})=>views.map(v=>[v.snapshot.recordCount,v.snapshot.summaries[0].value]);
  const split=apply(w,old);
  assert.deepEqual(stats(split),[[56,660974],[6,14000]]);
  const legacy=Board.context(split.board,split.views).displayed;
  assert.deepEqual(legacy.map(v=>[v.baseWhere,v.commonMeasureWhere]),[[[],[]],[[],prefix]]);
  const cleaned=total('stage');cleaned.spec.title='Total deal value by Stage';
  for(const requestScope of [cohort('QA1105'),{fromAdd:'mean'}]){
    const a=plan(requestScope,cleaned,local),fixed=apply(w,a);
    assert.deepEqual(stats(fixed),[[6,70000],[6,14000]]);
    assert.deepEqual(fixed.board.elements.map(e=>e.spec.where),[prefix,prefix]);
    assert.deepEqual(fixed.board.elements[1].spec.measures[0].where,[]);
    assert.deepEqual(checked(w,first,a,[req('Both scoped widgets',['separate_widgets'],['graph:stage_total','graph:mean'])]).board,fixed.board);
  }
  assert.deepEqual(old,before);
});

for(const [prefix,command] of [['QA1105',first],['North','For North deals show the mean value KPI beside total value by stage.']]){
  test('F04: '+command,()=>{
    const w=workspace(prefix),a=plan(cohort(prefix),total('stage'),average());
    const before=structuredClone({w,a}),result=apply(w,a);
    assert.deepEqual(result.views.map(v=>[v.snapshot.chart,v.snapshot.recordCount,v.snapshot.summaries[0].numericCount,v.snapshot.summaries[0].value]),
      [['stage',6,5,70000],['kpi',6,5,14000]]);
    assert.deepEqual(result.board.elements.map(e=>e.spec.where),[a.requestScope.where,a.requestScope.where]);
    assert.deepEqual(result.board.sharedFilters,[]);
    const requirements=[req('Total by stage',['sum','groups'],['graph:stage_total']),req('KPI average',['average'],['graph:mean']),
      req('Separate chart and KPI',['separate_widgets'],['graph:stage_total','graph:mean'])];
    assert.deepEqual(checked(w,command,a,requirements).board,result.board);
    assert.equal(Read.supports(a,['graph:stage_total','graph:mean'],['separate_graphs']),false);
    assert.match(result.answer,/5 numeric values/);
    assert.deepEqual({w,a},before);
  });
}

test('F08: '+append,()=>{
  const w=workspace(),initial=apply(w,plan(cohort('QA1105'),total('stage'),average()));
  const persisted=JSON.parse(JSON.stringify(initial.board)),before=structuredClone(persisted);
  const a=plan(cohort('QA1105'),byOwner()),result=apply(w,a,persisted);
  assert.deepEqual(result.board.elements.slice(0,2),before.elements);
  assert.deepEqual(result.views.slice(0,2),initial.views);
  assert.deepEqual(persisted,before);assertOwners(result.views[2]);
  const proof=checked(w,append,a,[req('Owner averages',['average','groups'],['graph:owner_mean']),
    req('Keep both',['unchanged_graphs'],['unchanged:graph:stage_total','unchanged:graph:mean'],'constraint'),
    req('Compare all three visually',['separate_widgets'],['graph:stage_total','graph:mean','graph:owner_mean'])],persisted);
  assert.deepEqual(proof.displayed.map(v=>v.id),['stage_total','mean','owner_mean']);
});

for(const [prefix,command] of [['QA1105',together],['North','For North deals, plot totals by stage as a line between two bars: owner counts and owner means.']]){
  test('F08: '+command,()=>{
    const w=workspace(prefix),a=plan(cohort(prefix),count(),total('line'),byOwner());
    const result=apply(w,a);
    assert.deepEqual(result.views.map(v=>[v.spec.chart,v.spec.groupBy,v.snapshot.recordCount]),
      [['bar','f_owner',6],['line','f_stage',6],['bar','f_owner',6]]);
    assert.deepEqual(result.views[0].result.datasets[0].values,[3,2,1]);
    assert.deepEqual(result.views[1].result.datasets[0].values,[null,30000,40000]);assertOwners(result.views[2]);
    const proof=checked(w,command,a,[req('Owner counts',['count','groups'],['graph:owner_count']),
      req('Stage totals',['sum','groups'],['graph:stage_total']),req('Owner means',['average','groups'],['graph:owner_mean']),
      req('Show three charts',['separate_graphs'],['graph:owner_count','graph:stage_total','graph:owner_mean'])]);
    assert.deepEqual(proof.board,result.board);
  });
}

test('new scope intersects local alternatives and selections without narrowing other adds or prior filters',()=>{
  const w=workspace('North');
  const prior=apply(w,plan(null,count(),{op:'set_shared_filter',id:'owner',targets:['owner_count'],where:where('f_owner','equals','Ben')}));
  const before=structuredClone(prior.board);
  const shared={scope:'all',where:[...cohort('North').where,...where('f_owner','equals','Nobody')]};
  const stage=total('line');stage.spec.where=[...where('f_stage','equals','Open'),...where('f_stage','equals','Won')];
  const kpi=average();kpi.spec.scope='visible';
  const newGraph=byOwner();newGraph.spec.measures[0].where=where('f_owner','equals','Cal');
  const result=apply(w,plan(shared,stage,kpi,newGraph),prior.board);
  assert.deepEqual(result.board.elements[0],before.elements[0]);assert.deepEqual(result.views[0],prior.views[0]);
  assert.deepEqual(result.board.sharedFilters,before.sharedFilters);
  assert.equal(result.board.elements[1].spec.where.length,4);
  assert.deepEqual(result.views.map(v=>v.snapshot.recordCount),[2,5,2,1]);
  assert.deepEqual(result.views.map(v=>v.snapshot.summaries[0].value),[2,70000,0,null]);
  const stored=JSON.parse(JSON.stringify(result.board));
  assert.deepEqual(Board.evaluate(stored,w.records,Core.create(w.tableSchema),[],{visibleIds:[],today:w.currentDate}),result.views);
});

test('a visible request restricts all new elements; a later request has independent scope',()=>{
  const w=workspace('West'),before=structuredClone(w);
  const shared={...cohort('West'),scope:'visible'};
  const two=apply(w,plan(shared,total('stage'),average()));
  assert.deepEqual(two.views.map(v=>[v.snapshot.recordCount,v.snapshot.summaries[0].value]),[[2,0],[2,0]]);
  const third=apply(w,plan(null,byOwner()),two.board);
  assert.deepEqual(third.views.slice(0,2),two.views);assert.equal(third.views[2].snapshot.recordCount,7);
  const empty=apply(w,plan(cohort('Unmatched'),byOwner(),average()));
  assert.deepEqual(empty.views.map(v=>v.snapshot.summaries[0].value),[null,null]);
  assert.deepEqual(empty.views.map(v=>v.snapshot.summaries[0].numericCount),[0,0]);assert.deepEqual(w,before);
});

test('malformed request scope, local filters and expanded DNF fail atomically',()=>{
  const w=workspace(),initial=apply(w,plan(null,count())),before=structuredClone(initial.board);
  for(const shared of [{scope:'all'},undefined,{scope:'any',where:[]},{scope:'all',where:[[]]},
    {scope:'all',where:where('unknown','equals','X')},{scope:'all',where:[],targets:['owner_count']}]){
    assert.throws(()=>apply(w,plan(shared,average()),initial.board));
  }
  assert.throws(()=>apply(w,plan(cohort('QA1105'),{op:'clear'}),initial.board),/new graph/);
  const broken=byOwner();broken.spec.where=[[]];
  assert.throws(()=>apply(w,plan(cohort('QA1105'),average(),broken),initial.board),/filter group/i);
  const alternatives=field=>['a','b','c','d'].flatMap(value=>where(field,'equals',value));
  broken.spec.where=alternatives('f_owner');
  assert.throws(()=>apply(w,plan({scope:'all',where:alternatives('f_deal')},broken),initial.board),/too complex/);
  assert.deepEqual(initial.board,before);
});

test('strict top-level and nested model schemas require explicit requestScope, not inferred sibling scope',()=>{
  const w=workspace(),core=Core.create(w.tableSchema),direct=Board.schemas(core)[0];
  assert(direct.required.includes('requestScope'));
  const steps=require('../public/workspace-plan').responseSchema(core).properties.steps.items.anyOf;
  assert.deepEqual(steps.find(s=>s.properties.op.enum.includes('dashboard')).properties.plan.properties.requestScope,direct.properties.requestScope);
  const scope=direct.properties.requestScope.anyOf;
  assert.deepEqual(scope[1].required,['scope','where']);assert.equal(scope[1].additionalProperties,false);
  assert.deepEqual(scope[1].properties.scope.enum,['all','visible']);
  assert(scope[1].properties.where.items.items.properties.field.enum.includes('f_deal'));
  const a=plan(cohort('QA1105'),total('stage'),average());
  const nested=F.plan([{op:'dashboard',id:'charts',label:'Compare',plan:a}]);
  const idList=['charts/graph:stage_total','charts/graph:mean'];
  const proof=checked(w,'Compare a stage graph and an average KPI for QA1105 deals.',nested,[req('Both widgets',['separate_widgets'],idList)]);
  assert.deepEqual(proof.effects[0].board,apply(w,a).board);
  for(const ids of [['charts'],['charts/graph:mean'],['charts/graph:mean','charts/graph:mean'],['charts/graph:mean','charts'],['root',...idList]]){
    assert.equal(Read.supports(nested,ids,['separate_widgets'],{pipeline:w}),false);
  }
});

test('visual comparison does not synthesize a statistic between incompatible measures',()=>{
  const w=workspace(),a=plan(cohort('QA1105'),count(),total('line'),byOwner());
  const invalid=structuredClone(a);
  const ref=elementId=>({elementId,measure:0,stat:'aggregate'});
  invalid.questions=[{kind:'difference',label:'Comparison',left:ref('owner_count'),right:ref('owner_mean')}];
  assert.throws(()=>apply(w,invalid),/different units or aggregations/);
  assert.equal(apply(w,a).views.length,3);
});

test('shared source intersects base and common measure predicates, never percentages or divergent measure subsets',()=>{
  const w=workspace('East'),a=average(),prefix=cohort('East').where;
  a.spec.where=where('f_owner','equals','Ada');
  a.spec.measures=[{label:'Sum',metric:'sum',field:'f_value',where:prefix},{...a.spec.measures[0],where:structuredClone(prefix)}];
  const run=()=>apply(w,plan({fromAdd:'mean'},count(),a));
  const scoped=run();
  assert.deepEqual(scoped.views.map(v=>v.snapshot.recordCount),[3,3]);
  assert.deepEqual(scoped.board.elements[1].spec.measures.map(m=>m.where),[[],[]]);
  a.spec.where=[];a.spec.measures[1].where=[];
  assert.throws(run,/no shared population restriction/);
  a.spec.measures=[{label:'Share',metric:'percentage',field:null,where:prefix}];
  assert.throws(run,/no shared population restriction/);
  a.spec.where=where('f_owner','equals','Cal');
  const share=run();
  assert.deepEqual(share.views.map(v=>v.snapshot.recordCount),[2,2]);
  assert.equal(share.views[1].snapshot.summaries[0].value,50);
  assert.deepEqual(share.board.elements[1].spec.measures[0].where,prefix);
  assert.throws(()=>apply(w,plan({fromAdd:'owner_count'},average()),scoped.board),/unique new graph/);
});

const savedCardsCommand='For deals beginning QA1105 only, plot total Deal Value grouped by Stage and put the mean Deal Value in a temporary KPI next to it. Do not modify saved cards.';
const ownerCountCommand='For the six QA1105 deals, display three separate charts side by side: a bar for how many accounts each owner has, a line for summed deal value by stage, and a bar for mean deal size per owner.';
function existing(w){
  return apply(w,plan(null,total('line'),count(),{op:'set_shared_filter',id:'ben',targets:['owner_count'],where:where('f_owner','equals','Ben')}));
}

test('F04 existing board: '+savedCardsCommand,()=>{
  const w=workspace(),prior=existing(w);
  w.tableSchema=Customize.addKpi(w.tableSchema,[],'kpi_user_saved',{title:'Saved value',metric:'sum',field:'f_value',conditions:[]}).tableSchema;
  const before=structuredClone({w,board:prior.board}),saved=Customize.kpis(w.tableSchema,[]);
  const a=F.plan([{id:'charts',label:'Show temporary charts without changing saved cards',op:'dashboard',
    plan:plan(cohort('QA1105'),add('requested_total','bar','sum','f_stage'),average())}]);
  const ids=['charts/graph:requested_total','charts/graph:mean'];
  const computed=checked(w,savedCardsCommand,a,[req('Stage total',['sum','groups'],[ids[0]]),req('Mean KPI',['average'],[ids[1]]),
    req('Separate temporary widgets',['separate_widgets'],ids),req('Leave all saved cards unchanged',['unchanged_kpis'],saved.map(k=>'unchanged:kpi:'+k.id),'constraint')],prior.board);
  assert.equal(computed.mutates,false);
  assert.deepEqual(computed.effects.map(e=>e.kind),['dashboard']);
  const views=Board.evaluate(computed.effects[0].board,w.records,Core.create(w.tableSchema),[],{today:w.currentDate});
  assert.deepEqual(views.slice(0,2),prior.views);
  assert.deepEqual(views.slice(2).map(v=>[v.spec.chart,v.snapshot.recordCount,v.snapshot.summaries[0].value]),[['bar',6,70000],['kpi',6,14000]]);
  assert.deepEqual({w,board:prior.board},before);
  assert.match(Review.compilerInstructions,/workspace_plan dashboard step.*unchanged saved-card definitions/);
  const direct=a.steps[0].plan, directIds=['graph:requested_total','graph:mean'];
  const verified=checked(w,savedCardsCommand,direct,[req('Stage total',['sum','groups'],[directIds[0]]),
    req('Mean KPI',['average'],[directIds[1]]),req('Separate temporary widgets',['separate_widgets'],directIds),
    req('Leave all saved cards unchanged',['unchanged_kpis'],saved.map(k=>'unchanged:kpi:'+k.id),'constraint')],prior.board);
  assert.deepEqual(verified.board.elements.slice(0,2),prior.board.elements);
});

test('F08 existing board: '+ownerCountCommand,()=>{
  const w=workspace(),prior=existing(w),a=plan(cohort('QA1105'),
    add('requested_count','bar','count','f_owner'),add('requested_total','line','sum','f_stage'),byOwner());
  const ids=a.operations.map(op=>'graph:'+op.id);
  const computed=checked(w,ownerCountCommand,a,[req('How many accounts each owner has',['count','groups'],[ids[0]]),
    req('Summed deal value by stage',['sum','groups'],[ids[1]]),req('Mean deal size per owner',['average','groups'],[ids[2]]),
    req('Three separate plotted charts',['separate_graphs'],ids)],prior.board);
  assert.deepEqual(computed.board.elements.slice(0,2),prior.board.elements);
  assert.deepEqual(computed.board.sharedFilters,prior.board.sharedFilters);
  const views=Board.evaluate(computed.board,w.records,Core.create(w.tableSchema),[],{today:w.currentDate}).slice(2);
  assert.deepEqual(views.map(v=>[v.spec.chart,v.snapshot.recordCount]),[['bar',6],['line',6],['bar',6]]);
  assert.deepEqual(views[0].result.datasets[0].values,[3,2,1]);assert.deepEqual(views[1].result.datasets[0].values,[null,30000,40000]);
  assertOwners(views[2]);
});

test('new chart measure schema admits only field/metric pairs the report executor supports',()=>{
  const w=workspace(),core=Core.create(w.tableSchema);
  const branches=Board.schemas(core)[0].properties.operations.items.anyOf.find(op=>op.properties.op.enum.includes('add'))
    .properties.spec.properties.measures.items.anyOf;
  const allowed=(metric,field)=>branches.some(({properties:p})=>p.metric.enum.includes(metric)&&
    (p.field.type==='null'?field===null:p.field.enum.includes(field)));
  for(const metric of ['count','percentage','count_distinct','average','sum','median','min','max']){
    for(const field of [null,'f_deal','f_value','missing']){
      const op=count();op.spec.measures=[{metric,label:metric,field,where:[]}];
      const run=()=>apply(w,plan(cohort('QA1105'),op));
      const valid=['count','percentage'].includes(metric)?field===null:field==='f_value'||metric==='count_distinct'&&field==='f_deal';
      assert.equal(allowed(metric,field),valid,metric+':'+field);
      if(valid)assert.doesNotThrow(run);else assert.throws(run);
    }
  }
});
