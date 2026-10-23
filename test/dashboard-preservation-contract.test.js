'use strict';

const test=require('node:test'),assert=require('node:assert/strict');
const Contract=require('../lib/read-output-contract'),Review=require('../lib/action-review');
const Dashboard=require('../public/dashboard-board'),Reports=require('../public/report-engine'),Core=require('../public/pipeline-core');
const F=require('./fixtures/workspace-plans.cjs');
const spec=(metric='count',groupBy='f_stage',extra={})=>({version:1,title:metric+' by '+groupBy,chart:'bar',scope:'all',groupBy,
  bucket:'none',splitBy:null,where:[],sort:'label_asc',limit:null,measures:[{label:metric,metric,field:metric==='count'?null:'f_value',where:[]}],...extra});
const add=(id,value)=>({op:'add',id,spec:value});
const update=(id,changes=[],extra={})=>({op:'update',ids:[id],mode:'add_filter',where:[],replaceFields:[],changes,...extra});
const dashboard=(...operations)=>({action:'dashboard_plan',operations,questions:[]});
const append=()=>dashboard(add('by_owner',spec('count','f_owner')),add('value_by_owner',spec('average','f_owner')));
const nested=(id,plan)=>({op:'dashboard',id,label:id,plan});
function pipeline(extra={}){
  const p={...F.workspace(),currentDate:'2026-10-23',timezone:'UTC',visibleIds:[1,2],workspaceVersion:12};
  p.dashboard={board:Dashboard.apply(null,dashboard(add('by_stage',spec('count','f_stage',extra)),
    add('value_by_stage',spec('average','f_stage',extra))),p.records,Core.create(p.tableSchema),p.customFields,
    {today:p.currentDate,visibleIds:p.visibleIds}).board};
  return p;
}
function evidence(action,p=pipeline()){
  const result={crmAction:action,assistantMessage:'Review the graphs.'};
  return {pipeline:p,computed:Review.evidence({pipeline:p},result)};
}
const invariant=(id,prefix='')=>prefix+'unchanged:graph:'+id;
const supports=(action,context,...ids)=>Contract.supports(action,ids,['unchanged_graphs'],context);
const invariants=(action,context)=>Contract.evidenceIds(action,context).filter(id=>id.includes('unchanged:graph:'));
const requirement=(stepIds,requiredOutputs=['unchanged_graphs'])=>({description:'Preserve the existing Stage graphs',
  evidenceKind:'computed_read',stepIds,requiredOutputs,satisfied:true});
const review=(action,context,req)=>Review.validateReview({requirements:[req],issues:[],clarificationQuestion:null,
  answerIntent:'canonical',answerSelection:null},{crmAction:action,assistantMessage:'No graph was changed.'},context);

test('canonical materialized preservation IDs reach the review schema and satisfy only explicit invariants',()=>{
  const action=append(),p=pipeline(),before=structuredClone({action,p}),context=evidence(action,p);
  const ids=[invariant('by_stage'),invariant('value_by_stage')];
  assert.deepEqual(invariants(action,context),ids);
  assert.deepEqual(context.computed.preservation.evidenceIds,ids);
  const allowed=Review.schemaFor(action,context).properties.requirements.items.properties.stepIds.items.enum;
  assert(ids.every(id=>allowed.includes(id)));
  assert.equal(supports(action,context,...ids),true);
  assert.equal(review(action,context,requirement(ids)).ok,true);
  assert.equal(Contract.supports(action,['graph:by_owner','graph:value_by_owner'],['separate_graphs'],context),true);
  for(const wrong of [[],['root'],['graph:by_stage'],['by_stage'],[invariant('by_owner')],
    [invariant('missing')],[ids[0],'root'],[ids[0],'graph:value_by_stage']]){
    assert.equal(supports(action,context,...wrong),false,JSON.stringify(wrong));
    assert.equal(review(action,context,requirement(wrong)).ok,false);
  }
  assert.deepEqual({action,p},before);
  assert.equal(context.computed.lifecycle.writesApplied,0);
});

test('preservation IDs cannot supply numbers, field values, layout or another output kind',()=>{
  const action=append(),context=evidence(action),id=invariant('by_stage');
  for(const kind of Contract.schema.items.enum.filter(kind=>kind!=='unchanged_graphs')){
    for(const stepIds of [[id],[id,'root'],[id,'graph:by_stage']]){
      assert.equal(Contract.supports(action,stepIds,[kind],context),false,kind);
      assert.equal(Contract.supports(action,stepIds,['unchanged_graphs',kind],context),false,kind);
    }
  }
  assert.equal(Contract.supports(action,['graph:by_stage'],['count'],context),true);
});

test('plain, copied and replayed computed objects do not acquire canonical preservation authority',()=>{
  const action=append(),context=evidence(action),id=invariant('by_stage');
  for(const computed of [undefined,{},structuredClone(context.computed),{...context.computed},
    {preservation:context.computed.preservation},{preservation:{evidenceIds:[id]}}]){
    const forged={pipeline:context.pipeline,computed};
    assert.equal(supports(action,forged,id),false);
    assert.deepEqual(invariants(action,forged),[]);
    assert.equal(review(action,forged,requirement([id])).ok,false);
  }
  assert.equal(supports(action,{...context,pipeline:structuredClone(context.pipeline)},id),false);
  assert.equal(supports(dashboard({op:'clear'}),context,id),false);
  assert.equal(supports(structuredClone(action),context,id),true,'Equivalent action serialization is allowed');
  assert.deepEqual(invariants(action,{pipeline:context.pipeline}),[],'A valid plan alone is not execution evidence');
});

test('changing any canonical source or materialized result invalidates its preservation binding',()=>{
  const edits=[
    context=>context.pipeline.workspaceVersion++,
    context=>context.pipeline.records[0].f_value++,
    context=>context.pipeline.visibleIds.push(3),
    context=>{context.pipeline.conversationFocus={ids:[1]};},
    context=>{context.pipeline.dashboard.board.elements[0].spec.title='Changed before board';},
    context=>{context.computed.board.elements[0].spec.title='Changed final board';},
    context=>{context.computed.preservation=structuredClone(context.computed.preservation);context.computed.preservation.evidenceIds.push(invariant('by_owner'));}
  ];
  for(const edit of edits){
    const action=append(),context=evidence(action);edit(context);
    assert.equal(supports(action,context,invariant('by_stage')),false);
    assert.deepEqual(invariants(action,context),[]);
  }
});

test('spec and identity changes reject only the affected existing graphs',()=>{
  const cases=[update('by_stage',[{field:'title',value:'Changed'}]),
    update('by_stage',[],{where:[[F.where('f_owner','equals','Alex')]]}),
    {op:'remove',ids:['by_stage']}];
  for(const operation of cases){
    const action=dashboard(operation),context=evidence(action);
    assert.deepEqual(invariants(action,context),[invariant('value_by_stage')]);
    assert.equal(supports(action,context,invariant('by_stage')),false);
  }
  const action=dashboard({op:'remove',ids:['by_stage']},add('replacement',spec())),context=evidence(action);
  assert.equal(supports(action,context,invariant('replacement')),false);
  assert.equal(supports(action,context,invariant('value_by_stage')),true);
});

test('scope refinement and recaptured visible IDs are checked on actual materialized boards',()=>{
  const p=pipeline(),action=dashboard(update('by_stage',[{field:'scope',value:'visible'}])),context=evidence(action,p);
  const change=context.computed.preservation.elements.find(element=>element.id==='by_stage');
  assert(change.reasons.includes('spec'));assert.equal(supports(action,context,invariant('by_stage')),false);
  assert.equal(supports(action,context,invariant('value_by_stage')),true);
  const visible=pipeline({scope:'visible'});visible.visibleIds=[3,4];
  const recreate=dashboard({op:'clear'},...visible.dashboard.board.elements.map(element=>add(element.id,element.spec)));
  const recaptured=evidence(recreate,visible);
  assert.deepEqual(invariants(recreate,recaptured),[]);
  assert(recaptured.computed.preservation.elements.every(element=>element.reasons.includes('visible_ids')));
  assert.deepEqual(recaptured.computed.board.elements.map(element=>element.spec),visible.dashboard.board.elements.map(element=>element.spec),
    'Identical specs alone would falsely claim preservation');
});

test('shared filters affect only their applicable graphs, including removal',()=>{
  const filter={op:'set_shared_filter',id:'owner_filter',targets:['by_stage'],where:[[F.where('f_owner','equals','Alex')]]};
  const action=dashboard(filter),p=pipeline(),context=evidence(action,p);
  assert.deepEqual(invariants(action,context),[invariant('value_by_stage')]);
  p.dashboard.board=context.computed.board;
  const removal=dashboard({op:'remove_shared_filter',id:'owner_filter'}),removed=evidence(removal,p);
  assert.deepEqual(invariants(removal,removed),[invariant('value_by_stage')]);
  const other=dashboard(add('by_owner',spec('count','f_owner')),{...filter,targets:['by_owner']});
  assert.deepEqual(invariants(other,evidence(other)),[invariant('by_stage'),invariant('value_by_stage')]);
});

test('relative graph order is preserved while active selection is irrelevant',()=>{
  const action=append(),context=evidence(action);
  assert.notEqual(context.pipeline.dashboard.board.activeId,context.computed.board.activeId);
  assert.equal(supports(action,context,invariant('by_stage'),invariant('value_by_stage')),true);
  const p=pipeline(),reorder=dashboard({op:'clear'},...p.dashboard.board.elements.slice().reverse().map(element=>add(element.id,element.spec)));
  const moved=evidence(reorder,p);
  assert.deepEqual(invariants(reorder,moved),[]);assert.equal(moved.computed.preservation.orderPreserved,false);
});

test('nested plans bind initial-to-final preservation only to the final dashboard step',()=>{
  const action=F.plan([nested('append_owner',append()),nested('change_stage',dashboard(update('by_stage',[{field:'title',value:'Changed'}])))]);
  const context=evidence(action),id=invariant('value_by_stage','change_stage/');
  assert.deepEqual(invariants(action,context),[id]);
  assert.equal(supports(action,context,id),true);assert.equal(review(action,context,requirement([id])).ok,true);
  for(const wrong of [invariant('value_by_stage'),invariant('value_by_stage','append_owner/'),
    invariant('by_stage','change_stage/'),invariant('by_owner','change_stage/'),'change_stage','root']){
    assert.equal(supports(action,context,wrong),false,wrong);
  }
  context.computed.effects.at(-1).board.elements[1].visibleIds.push(99);
  assert.equal(supports(action,context,id),false,'Changed final effects invalidate source binding');
});

test('an intermediate rewrite restored to the original is proven from initial and final boards only',()=>{
  const p=pipeline(),title=p.dashboard.board.elements[0].spec.title;
  const action=F.plan([nested('change',dashboard(update('by_stage',[{field:'title',value:'Temporary'}]))),
    nested('restore',dashboard(update('by_stage',[{field:'title',value:title}])))]);
  const context=evidence(action,p);
  assert.deepEqual(invariants(action,context),[invariant('by_stage','restore/'),invariant('value_by_stage','restore/')]);
  assert.equal(context.computed.lifecycle.writesApplied,0);
});

test('later displayed report replacement and analysis-only actions cannot reuse dashboard preservation',()=>{
  const action=F.plan([nested('append',append()),{op:'report',id:'replacement',label:'Replacement',selection:null,
    spec:spec(),questions:[{kind:'summary',elementIds:['replacement']}],showDashboard:true}]);
  const context=evidence(action);
  assert.equal(context.computed.preservation,undefined);assert.deepEqual(invariants(action,context),[]);
  assert.equal(supports(action,context,invariant('by_stage','append/')),false);
  const analyze={action:'analyze_dashboard',questions:[{kind:'summary',elementIds:['by_stage']}]};
  assert.equal(supports(analyze,evidence(analyze),invariant('by_stage')),false);
});

test('reviewing registered preservation never reruns graph execution or falls back to the spec mirror',()=>{
  const action=append(),context=evidence(action),execute=Reports.execute;
  Reports.execute=()=>{throw new Error('Unexpected reexecution during contract validation');};
  try{
    assert.equal(supports(action,context,invariant('by_stage')),true);
    assert.deepEqual(invariants(action,context),context.computed.preservation.evidenceIds);
    assert.equal(review(action,context,requirement([invariant('by_stage')])).ok,true);
    assert.equal(supports(action,{pipeline:context.pipeline},invariant('by_stage')),false);
  }finally{Reports.execute=execute;}
});
