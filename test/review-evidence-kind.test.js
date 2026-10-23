'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Review=require('../lib/action-review');
const F=require('./fixtures/workspace-plans.cjs'),Business=require('../public/business-workspace');
const requirement=(evidenceKind,stepIds=['root'])=>({description:'Requested outcome',evidenceKind,stepIds,requiredOutputs:evidenceKind==='computed_read'?['count']:[],satisfied:true});
const check=(action,r,context={})=>Review.validateReview({requirements:[r],issues:[],clarificationQuestion:null},{crmAction:action,assistantMessage:'Here are the saved values: 123.'},context);
test('review contract classifies every outcome by evidence kind',()=>{
  const schema=Review.schema.properties.requirements.items;
  assert(schema.required.includes('evidenceKind'));
  assert(schema.properties.evidenceKind.enum.includes('computed_read'));
  assert(Review.needsReview({userCommand:'What was the recorded contact?'},{crmAction:null}));
  assert(Review.needsReview({userCommand:'Good morning'},{crmAction:null}));
});
test('saved data prose cannot satisfy a computed read even if the reviewer marks it satisfied',()=>{
  for(const evidenceKind of [undefined,'invented',null])assert.equal(check({action:'audit_records'},requirement(evidenceKind)).ok,false);
  for(const action of [null,{action:'clarify'},{action:'add_field'}]){
    const result=check(action,requirement('computed_read'));
    assert.equal(result.ok,false);assert.equal(result.compiled,0);
    assert.match(result.mappingIssues[0],/canonical read step/);
  }
});
test('canonical read steps, not selection or mutation steps alone, supply read evidence',()=>{
  const w=F.workspace(),spec={version:1,title:'Owner counts',chart:'bar',scope:'all',groupBy:'f_owner',bucket:'none',splitBy:null,
    measures:[{label:'Count',metric:'count',field:null,where:[]}],where:[],sort:'label_asc',limit:null};
  const pipeline={...w,currentDate:'2026-10-23',visibleIds:w.records.map(row=>row.id),
    dashboard:{board:{version:1,elements:[{id:'existing',spec,visibleIds:[]}],sharedFilters:[],activeId:'existing'}},
    workflows:[{id:'workflow_fixture',spec:{name:'Follow-up'},history:[],executions:[]}],
    business:{state:Business.empty(),primary:{tableSchema:w.tableSchema,customFields:[],records:[]}}};
  const action=F.plan([F.select('cohort'),F.update('edit','cohort','f_priority','High'),
    {op:'read_records',id:'answer',label:'Count',selection:'cohort',showTable:false,outputs:[{kind:'count',field:null}]},
    {op:'report',id:'grouped',label:'Owners',selection:'cohort',spec,showDashboard:false,questions:[{kind:'groups',elementId:'grouped',measure:0}]}]);
  assert.equal(Review.evidence({pipeline},{crmAction:action}).mutates,true);
  for(const id of ['cohort','edit'])assert.equal(check(action,requirement('computed_read',[id]),{pipeline}).ok,false);
  for(const id of ['answer','grouped'])assert.equal(check(action,requirement('computed_read',[id]),{pipeline}).ok,true);
  assert.equal(check(action,requirement('computed_read',['invented']),{pipeline}).ok,false);
  const reads=[
    {action:'query_business',typeId:null,selector:{kind:'all'},linkedTo:null,relationshipTypeId:null},
    {action:'query_todos',selection:{source:'all',ids:[],focusId:null,conditions:[]}},
    {action:'audit_records',scope:'all',where:[],groups:[{label:'Assigned owners',where:[[F.where('f_owner','is_not_blank')]]}]},
    {action:'analyze_dashboard',questions:[{kind:'summary',elementIds:['existing']}]},
    {action:'workflow_history',workflowId:'workflow_fixture',limit:20}
  ];
  for(const read of reads){
    assert.doesNotThrow(()=>Review.evidence({pipeline},{crmAction:read}));
    assert.equal(check(read,requirement('computed_read'),{pipeline}).ok,true,read.action);
  }
});
test('saved workflow history is rendered from persisted events rather than model prose',()=>{
  const payload={pipeline:{tableSchema:null,customFields:[],workflows:[{id:'workflow_fixture',spec:{name:'Follow-up automation'},history:[{type:'created',at:'2026-10-10T12:00:00Z',status:'draft'},{type:'activated',at:'2026-10-10T13:00:00Z',status:'active'}],executions:[]}]}};
  const result={crmAction:{action:'workflow_history',workflowId:'workflow_fixture',limit:20},assistantMessage:'100 tasks executed successfully.'};
  const answer=Review.renderAnswer(payload,result);
  assert.match(answer,/2 saved history entries/);assert.match(answer,/activated \/ active/);assert.match(answer,/created \/ draft/);
  assert.doesNotMatch(answer,/100 tasks/);
});
test('general discussion and unavailable-field explanations still need no write action',()=>{
  for(const kind of ['conversation','unavailable','clarification'])assert.equal(check(null,requirement(kind)).ok,true);
  assert.equal(check(null,requirement('compiled_action')).ok,false);
  assert.equal(check({action:'clarify'},requirement('compiled_action')).ok,false);
  assert.equal(check({action:'create_workflow'},requirement('compiled_action')).ok,true);
});
