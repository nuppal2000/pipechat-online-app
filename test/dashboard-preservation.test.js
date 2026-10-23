'use strict';

const test=require('node:test'),assert=require('node:assert/strict');
const Dashboard=require('../public/dashboard-board'),Reports=require('../public/report-engine'),Core=require('../public/pipeline-core');
const Customize=require('../public/workspace-customization'),F=require('./fixtures/workspace-plans.cjs');
const today='2026-10-23';
const spec=(metric='count',groupBy='f_stage',extra={})=>({version:1,title:metric+' by '+groupBy,chart:'bar',scope:'all',groupBy,
  bucket:'none',splitBy:null,where:[],sort:'label_asc',limit:null,measures:[{label:metric,metric,field:metric==='count'?null:'f_value',where:[]}],...extra});
const add=(id,spec)=>({op:'add',id,spec});
const update=(id,changes=[],extra={})=>({op:'update',ids:[id],mode:'add_filter',where:[],replaceFields:[],changes,...extra});
const workspace=()=>{
  const w=F.workspace(),stages=[...w.tableSchema.fields.find(field=>field.id==='f_stage').options,''];
  w.tableSchema=Customize.addKpi(w.tableSchema,[],'kpi_user_retained',{title:'Saved total',metric:'sum',field:'f_value',conditions:[]}).tableSchema;
  w.records=Array.from({length:45},(_,index)=>({...w.records[0],id:index+1,f_deal:'Deal '+(index+1),f_stage:stages[index%7],
    f_owner:['Alex','Sam',''][index%3],f_value:36640+(index-22)*100}));
  return w;
};
const apply=(w,board,operations,options={})=>Dashboard.apply(board,{action:'dashboard_plan',operations,questions:[]},w.records,Core.create(w.tableSchema),w.customFields,{today,...options});
const initial=(w,extra={})=>apply(w,null,[add('deals_by_stage',spec('count','f_stage',extra)),add('avg_value_by_stage',spec('average','f_stage',extra))],{visibleIds:[1,2]}).board;
const append=[add('deals_by_owner',spec('count','f_owner')),add('avg_value_by_owner',spec('average','f_owner'))];
const entry=(evidence,id)=>evidence.elements.find(element=>element.id===id);
const compare=(w,before,after,options={})=>{
  Dashboard.evaluate(after,w.records,Core.create(w.tableSchema),w.customFields,{today});
  return Dashboard.preservation(before,after,options);
};

test('append two Owner graphs proves both Stage graphs unchanged from materialized boards',()=>{
  const w=workspace(),before=initial(w),saved=structuredClone({w,before});
  const result=apply(w,before,append),evidence=result.preservation;
  assert.deepEqual(evidence.evidenceIds,['unchanged:graph:deals_by_stage','unchanged:graph:avg_value_by_stage']);
  assert.equal(evidence.orderPreserved,true);
  assert.deepEqual(result.board.elements.slice(0,2),before.elements);
  assert.deepEqual(evidence.elements.map(element=>[element.id,element.unchanged,element.reasons]),[
    ['deals_by_stage',true,[]],['avg_value_by_stage',true,[]],['deals_by_owner',false,['added']],['avg_value_by_owner',false,['added']]
  ]);
  for(const element of evidence.elements.slice(0,2)){
    assert.deepEqual(element.before,element.after);
    assert.deepEqual(Object.keys(element.before),['position','spec','visibleIds','sharedFilters']);
  }
  assert.equal(entry(evidence,'deals_by_owner').before,null);
  assert.equal(entry(evidence,'deals_by_owner').evidenceId,null);
  assert(result.views.every(view=>view.snapshot.recordCount===45));
  assert(result.views.slice(0,2).every(view=>view.snapshot.shownGroups===7));
  assert.equal(result.views[2].snapshot.table.reduce((sum,row)=>sum+row.value,0),45);
  assert.equal(result.views[3].snapshot.summaries[0].value,36640);
  assert.deepEqual({w,before},saved,'Data, saved KPI definitions and the original board stay unchanged');
});

test('preservation snapshots are deeply frozen and detached from inputs, output board and action specs',()=>{
  const w=workspace(),before=initial(w,{scope:'visible'}),operations=structuredClone(append),result=apply(w,before,operations);
  const snapshot=entry(result.preservation,'deals_by_stage'),added=entry(result.preservation,'deals_by_owner');
  assert(Object.isFrozen(result.preservation));assert(Object.isFrozen(result.preservation.elements));
  assert(Object.isFrozen(snapshot.before.spec.measures[0]));assert(Object.isFrozen(snapshot.after.visibleIds));
  assert.throws(()=>{snapshot.before.spec.title='Forgery';},TypeError);
  assert.throws(()=>snapshot.after.visibleIds.push(99),TypeError);
  assert.throws(()=>result.preservation.evidenceIds.push('unchanged:graph:missing'),TypeError);
  before.elements[0].spec.title='Later input change';before.elements[0].visibleIds.push(3);
  result.board.elements[0].spec.title='Later output change';result.board.elements[0].visibleIds.push(4);
  operations[0].spec.title='Later action change';
  assert.equal(snapshot.before.spec.title,'count by f_stage');assert.equal(snapshot.after.spec.title,'count by f_stage');
  assert.deepEqual(snapshot.before.visibleIds,[1,2]);assert.deepEqual(snapshot.after.visibleIds,[1,2]);
  assert.equal(added.after.spec.title,'count by f_owner');
  assert(!Object.isFrozen(before));assert(!Object.isFrozen(result.board));
});

test('nested prefixes apply to proven unchanged IDs without rerunning report execution',()=>{
  const w=workspace(),before=initial(w),execute=Reports.execute;let executions=0;
  Reports.execute=(...args)=>{executions++;return execute(...args);};
  try{
    const result=apply(w,before,append,{preservationPrefix:'owner_charts/'});
    assert.equal(executions,6,'Two added specs and four final views, with no extra execution for preservation');
    assert.deepEqual(result.preservation.evidenceIds,['owner_charts/unchanged:graph:deals_by_stage','owner_charts/unchanged:graph:avg_value_by_stage']);
    assert.deepEqual(Dashboard.preservation(before,result.board,{prefix:'owner_charts/'}),result.preservation);
    assert.equal(executions,6);
  }finally{Reports.execute=execute;}
});

test('persisted boards retain exact graph identity, captured scope and applicable filters',()=>{
  const w=workspace(),before=apply(w,initial(w,{scope:'visible'}),[
    {op:'set_shared_filter',id:'saved_owner',targets:['deals_by_stage'],where:[[F.where('f_owner','equals','Alex')]]}
  ]).board;
  const result=apply(w,before,append),reloaded=JSON.parse(JSON.stringify(result.board));
  assert.deepEqual(compare(w,before,reloaded),result.preservation);
  const views=Dashboard.evaluate(reloaded,w.records,Core.create(w.tableSchema),w.customFields,{today});
  assert.deepEqual(views,result.views);
  assert.deepEqual(reloaded.elements.map(element=>element.id),['deals_by_stage','avg_value_by_stage','deals_by_owner','avg_value_by_owner']);
});

test('whole-plan preservation uses the final board, not a stale intermediate invariant',()=>{
  const w=workspace(),before=initial(w),intermediate=apply(w,before,append);
  assert(intermediate.preservation.evidenceIds.includes('unchanged:graph:deals_by_stage'));
  const final=apply(w,intermediate.board,[update('deals_by_stage',[{field:'title',value:'Changed later'}])]);
  const evidence=Dashboard.preservation(before,final.board,{prefix:'final_charts/'});
  assert.deepEqual(evidence.evidenceIds,['final_charts/unchanged:graph:avg_value_by_stage']);
  assert.deepEqual(entry(evidence,'deals_by_stage').reasons,['spec']);
  assert.deepEqual(entry(evidence,'deals_by_owner').reasons,['added']);
});

test('materialized spec changes fail preservation even when displayed totals are equal',()=>{
  const w=workspace(),before=initial(w);
  for(const [field,value] of [['title','Renamed'],['chart','line'],['groupBy','f_owner'],['splitBy','f_owner'],
    ['scope','visible'],['sort','label_desc'],['limit',1],['measures',spec('sum').measures]]){
    const result=apply(w,before,[update('deals_by_stage',[{field,value}])]);
    assert.deepEqual(entry(result.preservation,'deals_by_stage').reasons,['spec'],field);
    assert.deepEqual(result.preservation.evidenceIds,['unchanged:graph:avg_value_by_stage']);
  }
  const filtered=apply(w,before,[update('deals_by_stage',[],{where:[[F.where('f_stage','equals','Qualified')]]})]);
  assert.deepEqual(entry(filtered.preservation,'deals_by_stage').reasons,['spec']);
  assert.notDeepEqual(entry(filtered.preservation,'deals_by_stage').before.spec.where,entry(filtered.preservation,'deals_by_stage').after.spec.where);
  const renamed=apply(w,before,[update('deals_by_stage',[{field:'title',value:'Same totals, different definition'}])]);
  assert.equal(renamed.views[0].snapshot.summaries[0].value,45);
  assert.equal(entry(renamed.preservation,'deals_by_stage').unchanged,false);
});

test('captured visible IDs are part of preservation, including their order',()=>{
  const w=workspace(),before=initial(w,{scope:'visible'});
  for(const visibleIds of [[2,3],[2,1],[]]){
    const after=structuredClone(before);after.elements[0].visibleIds=visibleIds;
    const evidence=compare(w,before,after);
    assert.deepEqual(entry(evidence,'deals_by_stage').reasons,['visible_ids']);
    assert.deepEqual(evidence.evidenceIds,['unchanged:graph:avg_value_by_stage']);
  }
});

test('shared-filter additions, predicate changes, removal and retargeting invalidate only affected elements',()=>{
  const w=workspace(),plain=initial(w),where=[[F.where('f_owner','equals','Alex')]];
  const before=apply(w,plain,[{op:'set_shared_filter',id:'owner_filter',targets:['deals_by_stage'],where}]).board;
  for(const operations of [
    [{op:'set_shared_filter',id:'owner_filter',targets:['deals_by_stage'],where:[[F.where('f_owner','equals','Sam')]]}],
    [{op:'remove_shared_filter',id:'owner_filter'}],
    [{op:'set_shared_filter',id:'other_filter',targets:['deals_by_stage'],where}]
  ]){
    const evidence=apply(w,before,operations).preservation;
    assert.deepEqual(entry(evidence,'deals_by_stage').reasons,['shared_filters']);
    assert.deepEqual(evidence.evidenceIds,['unchanged:graph:avg_value_by_stage']);
  }
  const retargeted=apply(w,before,[{op:'set_shared_filter',id:'owner_filter',targets:['avg_value_by_stage'],where}]).preservation;
  assert.deepEqual(retargeted.evidenceIds,[]);
  assert(retargeted.elements.every(element=>element.reasons.includes('shared_filters')));
});

test('adding another target to a shared filter does not change its existing target',()=>{
  const w=workspace(),where=[[F.where('f_owner','equals','Alex')]];
  const before=apply(w,initial(w),[{op:'set_shared_filter',id:'owner_filter',targets:['deals_by_stage'],where}]).board;
  const result=apply(w,before,[...append,{op:'set_shared_filter',id:'owner_filter',targets:['deals_by_stage','deals_by_owner'],where}]);
  assert.deepEqual(result.preservation.evidenceIds,['unchanged:graph:deals_by_stage','unchanged:graph:avg_value_by_stage']);
  const snapshot=entry(result.preservation,'deals_by_stage').after;
  assert.deepEqual(snapshot.sharedFilters,[{id:'owner_filter',where}]);
  assert(Object.isFrozen(snapshot.sharedFilters[0].where[0][0]));
  result.board.sharedFilters[0].where[0][0].value='Sam';
  assert.equal(snapshot.sharedFilters[0].where[0][0].value,'Alex');
});

test('object property ordering, shared-filter layer ordering and active selection are not graph edits',()=>{
  const w=workspace(),before=apply(w,initial(w),[
    {op:'set_shared_filter',id:'z_owner',targets:['deals_by_stage'],where:[[F.where('f_owner','equals','Alex')]]},
    {op:'set_shared_filter',id:'a_stage',targets:['deals_by_stage'],where:[[F.where('f_stage','equals','Qualified')]]}
  ]).board;
  const after=structuredClone(before);after.activeId='deals_by_stage';after.sharedFilters.reverse();
  after.elements[0].spec=Object.fromEntries(Object.entries(after.elements[0].spec).reverse());
  const evidence=compare(w,before,after);
  assert.deepEqual(evidence.evidenceIds,['unchanged:graph:deals_by_stage','unchanged:graph:avg_value_by_stage']);
  assert.deepEqual(entry(evidence,'deals_by_stage').after.sharedFilters.map(filter=>filter.id),['a_stage','z_owner']);
});

test('deleting an ID and adding an identical graph under a new ID is not preservation',()=>{
  const w=workspace(),before=initial(w),result=apply(w,before,[{op:'remove',ids:['deals_by_stage']},add('new_identity',before.elements[0].spec)]);
  assert.deepEqual(entry(result.preservation,'deals_by_stage').reasons,['removed']);
  assert.equal(entry(result.preservation,'deals_by_stage').after,null);
  assert.deepEqual(entry(result.preservation,'new_identity').reasons,['added']);
  assert.deepEqual(result.preservation.evidenceIds,['unchanged:graph:avg_value_by_stage']);
});

test('remove and recreate is preserved only with the same final identity, configuration and relative position',()=>{
  const w=workspace(),before=initial(w);
  const moved=apply(w,before,[{op:'remove',ids:['deals_by_stage']},add('deals_by_stage',before.elements[0].spec)]);
  assert.deepEqual(moved.preservation.evidenceIds,[]);assert.equal(moved.preservation.orderPreserved,false);
  assert(moved.preservation.elements.every(element=>element.reasons.includes('order')));
  const identical=apply(w,before,[{op:'clear'},...before.elements.map(element=>add(element.id,element.spec))]);
  assert.deepEqual(identical.preservation.evidenceIds,['unchanged:graph:deals_by_stage','unchanged:graph:avg_value_by_stage']);
  const changed=apply(w,before,[{op:'clear'},...before.elements.map((element,index)=>add(element.id,index?element.spec:{...element.spec,title:'Changed'}))]);
  assert.deepEqual(changed.preservation.evidenceIds,['unchanged:graph:avg_value_by_stage']);
  const scoped=initial(w,{scope:'visible'});
  const recaptured=apply(w,scoped,[{op:'clear'},...scoped.elements.map(element=>add(element.id,element.spec))],{visibleIds:[3,4]});
  assert.deepEqual(recaptured.preservation.evidenceIds,[]);
  assert(recaptured.preservation.elements.every(element=>element.reasons.includes('visible_ids')));
});

test('clearing and recreating specs cannot conceal lost applicable shared filters',()=>{
  const w=workspace(),before=apply(w,initial(w),[{op:'set_shared_filter',id:'old_filter',targets:['deals_by_stage'],where:[[F.where('f_owner','equals','Alex')]]}]).board;
  const recreated=apply(w,before,[{op:'clear'},...before.elements.map(element=>add(element.id,element.spec))]);
  assert.deepEqual(entry(recreated.preservation,'deals_by_stage').reasons,['shared_filters']);
  assert.deepEqual(recreated.preservation.evidenceIds,['unchanged:graph:avg_value_by_stage']);
});

test('relative-order checks catch crossed neighbors even when a graph keeps its absolute index',()=>{
  const w=workspace(),before=apply(w,initial(w),append).board,after=structuredClone(before);
  after.elements=[after.elements[2],after.elements[1],after.elements[0],after.elements[3]];
  const evidence=compare(w,before,after);
  assert.deepEqual(evidence.evidenceIds,['unchanged:graph:avg_value_by_owner']);
  const middle=entry(evidence,'avg_value_by_stage');assert.equal(middle.before.position,middle.after.position);
  assert.deepEqual(middle.reasons,['order']);
});

test('new elements can shift indices without crossing retained graphs',()=>{
  const w=workspace(),before=initial(w),after=apply(w,before,append).board;
  after.elements=[after.elements[2],after.elements[0],after.elements[3],after.elements[1]];
  const evidence=compare(w,before,after);
  assert.equal(evidence.orderPreserved,true);
  assert.deepEqual(evidence.evidenceIds,['unchanged:graph:deals_by_stage','unchanged:graph:avg_value_by_stage']);
  assert.equal(entry(evidence,'deals_by_stage').before.position,0);
  assert.equal(entry(evidence,'deals_by_stage').after.position,1);
});

test('temporary KPI elements can be preserved, but newly created or removed elements never receive evidence IDs',()=>{
  const w=workspace(),before=apply(w,null,[add('temporary_kpi',spec('sum',null,{chart:'kpi'}))]).board;
  assert.deepEqual(apply(w,before,append).preservation.evidenceIds,['unchanged:graph:temporary_kpi']);
  const removed=apply(w,before,[{op:'clear'}]);assert.deepEqual(removed.preservation.evidenceIds,[]);
  assert.deepEqual(Dashboard.preservation(null,before).evidenceIds,[]);
  assert.deepEqual(Dashboard.preservation(Dashboard.empty(),Dashboard.empty()),{evidenceIds:[],elements:[],orderPreserved:true});
});

test('malformed boards and prefixes fail closed, with no fallback to raw IDs or cached totals',()=>{
  const w=workspace(),before=initial(w);
  for(const invalid of [false,0,'']){
    assert.throws(()=>Dashboard.preservation(invalid,before));
    assert.throws(()=>apply(w,invalid,append));
  }
  for(const prefix of [null,[],1,'step','Step/','../','a/b/','root/graph:','a'.repeat(41)+'/'])assert.throws(()=>Dashboard.preservation(before,before,{prefix}));
  for(const invalid of [null,{}, {board:before,displayed:[]}, {...before,recordCount:45},
    {...before,elements:[before.elements[0],before.elements[0]]},
    {...before,elements:[{...before.elements[0],spec:null}]}])assert.throws(()=>Dashboard.preservation(before,invalid));
  assert.throws(()=>apply(w,before,append,{preservationPrefix:'bad/prefix/'}));
  assert.deepEqual(before,initial(w));
});
