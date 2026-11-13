'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Board=require('../public/dashboard-board'),Core=require('../public/pipeline-core');
const Review=require('../lib/action-review'),Read=require('../lib/read-output-contract');
const F=require('./fixtures/workspace-plans.cjs');
const valueId='qa1110_total_value_by_owner',countId='qa1110_record_count_by_stage';
const spec=(title,metric,groupBy)=>({version:1,title,chart:'bar',scope:'all',groupBy,bucket:'none',splitBy:null,
  where:[[F.where('f_deal','starts_with','QA1110')]],sort:'label_asc',limit:null,
  measures:[{label:metric,metric,field:metric==='count'?null:'f_value',where:[]}]});
function pipeline(){
  const p={...F.workspace(),currentDate:'2026-11-13',workspaceVersion:'edit-qa'};
  p.records=[['Alex',12000],['Alex',1500],['Alex',0],['Alex',''],['Sam',15000],['Sam',30000],['Sam',7000]]
    .map(([owner,value],i)=>({...p.records[0],id:i+1,f_deal:'QA1110 '+i,f_owner:owner,f_value:value}));
  const action={action:'dashboard_plan',requestScope:null,operations:[
    {op:'add',id:valueId,spec:spec('QA1110 total value by owner','sum','f_owner')},
    {op:'add',id:countId,spec:spec('QA1110 record count by stage','count','f_stage')}],questions:[]};
  p.dashboard={board:Board.apply(null,action,p.records,Core.create(p.tableSchema),[],{today:p.currentDate}).board};
  return p;
}
const edit=(changes=[{field:'chart',value:'line'}],ids=[valueId])=>({action:'dashboard_plan',requestScope:null,
  operations:[{op:'update',ids,mode:'add_filter',where:[],replaceFields:[],changes}],questions:[]});
const requirement=(description,stepIds,requiredOutputs,evidenceKind='compiled_action')=>({description,stepIds,requiredOutputs,evidenceKind,satisfied:true});
const definition=(id,changes)=>({...requirement('Requested graph property edit',['graph:'+id],[]),
  ['editGraph:'+id]:{requestedGraphId:id,requestedChanges:changes}});
const preserve=id=>({...requirement('Keep the other graph unchanged',['unchanged:graph:'+id],['unchanged_graphs'],'constraint'),preserve:'verified_constraint'});
const envelope=requirements=>({requirements,issues:[],clarificationQuestion:null,answerIntent:'canonical',answerSelection:null});
function fixture(action=edit(),p=pipeline()){
  const result={crmAction:action},computed=Review.evidence({pipeline:p,userCommand:'Change the QA1110 total value by owner graph to a line chart. Keep the other graphs unchanged.'},result);
  const context={pipeline:p,computed};return {result,computed,context,schema:Review.schemaFor(action,context)};
}
const check=(f,requirements)=>Review.validateReview(envelope(requirements),f.result,f.context);

test('F09 diagnostic: graph-type edit has no separate_graphs obligation on its one edited ID',()=>{
  const f=fixture(),old=[requirement('Change graph to Line',['graph:'+valueId],['separate_graphs']),preserve(countId)];
  assert.equal(Read.supports(f.result.crmAction,['graph:'+valueId],['separate_graphs'],f.context),false);
  // Reproduce the generic review, without typed fields, from the live diagnostic.
  delete old[1].preserve;
  const bad=check(f,old);assert.equal(bad.ok,false);assert.equal(bad.requested,2);assert.equal(bad.compiled,1);
  assert.equal(bad.mappingReasons.unsupported_required_output,1);
  const requirementSchema=f.schema.properties.requirements.items;
  assert(requirementSchema.anyOf);assert.match(requirementSchema.description,/Changing one chart to Line does not request separate_graphs/);
  const branch=requirementSchema.anyOf.find(s=>s.properties['editGraph:'+valueId]);
  assert.deepEqual(branch.properties.stepIds.items.enum,['graph:'+valueId]);
  assert.equal(branch.properties.requiredOutputs.maxItems,0);
  const good=[definition(valueId,[{field:'chart',value:'line'}]),preserve(countId)];
  assert.deepEqual(check(f,good),{ok:true,requested:2,compiled:2,mappingIssues:[]});
  const after=f.computed.board;
  assert.equal(after.elements[0].spec.chart,'line');assert.equal(after.elements[0].spec.title,'QA1110 total value by owner');
  assert.deepEqual(after.elements[1],f.context.pipeline.dashboard.board.elements[1]);
  assert.equal(f.context.pipeline.dashboard.board.activeId,countId,'named target need not be the active graph');
  assert.deepEqual(Object.fromEntries(f.computed.displayed[0].table.map(row=>[row.group,row.value])),{Alex:13500,Sam:52000});
});

test('property definitions compare exact requested target and complete final spec, not titles or matching statistics',()=>{
  for(const alter of [
    rs=>rs[0]['editGraph:'+valueId].requestedGraphId=countId,
    rs=>rs[0]['editGraph:'+valueId].requestedChanges[0].value='stage',
    rs=>rs[0]['editGraph:'+valueId].requestedChanges=[],
    rs=>rs[0]['editGraph:'+valueId].requestedChanges.push({field:'title',value:'Invented title'}),
    rs=>rs[0].stepIds=['graph:'+countId],
    rs=>rs[0].requiredOutputs=['separate_graphs'],
    rs=>rs[0].evidenceKind='computed_read',
    rs=>rs.push(structuredClone(rs[0]))
  ]){
    const f=fixture(),rs=[definition(valueId,[{field:'chart',value:'line'}]),preserve(countId)];alter(rs);
    assert.equal(check(f,rs).ok,false);
  }
  const extra=fixture(edit([{field:'chart',value:'line'},{field:'title',value:'Changed without permission'}]));
  assert.equal(check(extra,[definition(valueId,[{field:'chart',value:'line'}]),preserve(countId)]).ok,false);
  const wrong=fixture(edit([{field:'chart',value:'line'}],[countId]));
  assert.equal(check(wrong,[definition(countId,[{field:'chart',value:'line'}])]).ok,true,'independently requested count-graph edit is valid');
  const r=definition(countId,[{field:'chart',value:'line'}]);r['editGraph:'+countId].requestedGraphId=valueId;
  assert.equal(check(fixture(edit([{field:'chart',value:'line'}],[countId])),[r]).ok,false);
});

test('variants preserve every unspecified property and can independently change two named graphs',()=>{
  const p=pipeline();p.dashboard.board.elements[0].spec.chart='line';
  const changes=[{field:'chart',value:'bar'},{field:'title',value:'Requested owner totals'}],f=fixture(edit(changes),p);
  assert.equal(check(f,[definition(valueId,changes),preserve(countId)]).ok,true);
  const a=edit();a.operations.push({...edit([{field:'sort',value:'value_desc'}],[countId]).operations[0]});
  const both=fixture(a);
  assert.equal(check(both,[definition(valueId,[{field:'chart',value:'line'}]),definition(countId,[{field:'sort',value:'value_desc'}])]).ok,true);
  assert.equal(check(fixture(a),[definition(valueId,[{field:'chart',value:'line'}])]).ok,false,'every touched graph needs its own definition');
});

test('copied, mutated and stale graph edit evidence fails; unchanged siblings require their own genuine proof',()=>{
  for(const change of [f=>f.context.computed=structuredClone(f.computed),f=>f.context.pipeline.records[0].f_value++,
    f=>{f.computed.preservation=structuredClone(f.computed.preservation);f.computed.preservation.elements[0].after.spec.chart='bar';},f=>f.context.pipeline.workspaceVersion='later']){
    const f=fixture(),rs=[definition(valueId,[{field:'chart',value:'line'}]),preserve(countId)];change(f);
    assert.equal(check(f,rs).ok,false);
  }
  const f=fixture(),rs=[definition(valueId,[{field:'chart',value:'line'}]),preserve(countId)];
  rs[1].stepIds=['graph:'+countId];assert.equal(check(f,rs).ok,false);
});
