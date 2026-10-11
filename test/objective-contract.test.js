'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Plan=require('../public/workspace-plan'),Todo=require('../public/todo-core'),Tasks=require('../public/todo-actions');
const Review=require('../lib/action-review'),Lifecycle=require('../lib/action-lifecycle'),F=require('./fixtures/workspace-plans.cjs');
const options={today:'2026-10-10',nonce:'objective'};
const prepare=(w,steps,extra={})=>Plan.prepare(w,F.plan(steps),{...options,...extra});
const references=(taskName,recordName)=>({source:'references',references:[{taskName,recordName}],conditions:[]});
test('preview lifecycle distinguishes a future write from execution for every mutation family',()=>{
  const w=F.workspace(),payload={pipeline:{...w,currentDate:options.today,workspaceVersion:'revision_a'}};
  for(const crmAction of [F.plan([F.select('one',[],{limit:1}),F.update('value','one','f_value',13000)]),{action:'add_field',newFieldName:'Final Decision Maker',targetType:'text'}]){
    const e=Review.evidence(payload,{crmAction});assert.equal(e.lifecycle.phase,'proposed');assert.equal(e.lifecycle.operation,'mutation');assert.equal(e.lifecycle.executed,false);assert.equal(e.lifecycle.writesApplied,0);assert.equal(e.lifecycle.requiresConfirmation,true);assert.equal(e.lifecycle.authorization,'prepare_only');
    assert.notEqual(e.lifecycle.planId,Lifecycle.describe(crmAction,e,'revision_b').planId);
  }
});
test('null and sentinel clarification outputs fail safely instead of rendering None',()=>{
  for(const question of [null,undefined,'','  ','None','null'])assert.throws(()=>Lifecycle.normalizeResult({assistantMessage:'None',crmAction:{action:'clarify',question}}),/clarification/);
  assert.equal(Lifecycle.normalizeResult({assistantMessage:'None',crmAction:{action:'clarify',question:'Which of the two companies?'}}).assistantMessage,'Which of the two companies?');
});
test('named task bindings are resolved independently despite a shared conversational focus',()=>{
  const w=F.workspace();w.records[0].f_deal='Uppal Co';w.records[1].f_deal='Brightpath Tutors';
  w.todoCards=[{...Todo.create('todo_uppal',1),nextAction:'Contact Uppal'},{...Todo.create('todo_brightpath',2),nextAction:'Hire a tutor'}];
  const step=(id,task,record,offset)=>({op:'update_tasks',id,label:id,selection:references(task,record),changes:[{field:'dueDate',operation:'set',value:{dateMode:'calendar_days',date:null,offset}}]});
  const result=prepare(w,[step('first','Contact Uppal','Uppal Co',0),step('second','Hire a tutor','Brightpath Tutors',1)],{focus:{kind:'todos',id:'prior',ids:['todo_uppal','todo_brightpath']}});
  assert.deepEqual(result.next.todoCards.map(c=>[c.id,c.dueDate]),[['todo_uppal','2026-10-10'],['todo_brightpath','2026-10-11']]);assert.deepEqual(result.next.records,w.records);
  w.todoCards.push({...Todo.create('todo_ambiguous',1),nextAction:'Contact Uppal'});
  assert.throws(()=>Tasks.select(w.todoCards,w.records,w.tableSchema,references('Contact Uppal','Uppal Co')),/More than one task/);
});
test('note search returns exact projected evidence from the same filtered population',()=>{
  const w=F.workspace();w.records[0].f_notes='Compliance reviewed by Priya. Budget next year is uncertain.';w.records[1].f_notes='No matching text.';
  const result=prepare(w,[F.select('found',[[F.where('f_notes','contains','compliance')]]),{op:'read_records',id:'answer',label:'Supporting notes',selection:'found',showTable:false,outputs:[{kind:'count',field:null},{kind:'names',field:null},{kind:'fields',field:'f_notes'}]}]);
  assert.match(result.answers[0],/Compliance reviewed by Priya/);assert.doesNotMatch(result.answers[0],/No matching text/);assert.equal(result.queryResults[0].projected[0].recordId,1);assert.equal(result.effects[0].show,false);assert.equal(result.mutates,false);
});
test('median and distinct use stored nonblank values, retaining numeric zero',()=>{
  const w=F.workspace();w.records=w.records.slice(0,4).map((r,i)=>({...r,f_value:[0,10,20,null][i]}));
  const result=prepare(w,[F.select('cohort'),{op:'read_records',id:'answer',label:'Numbers',selection:'cohort',showTable:false,outputs:[{kind:'median',field:'f_value'},{kind:'distinct',field:'f_value'}]}]);
  assert.match(result.answers[0],/Median.*\$10.00/);assert.match(result.answers[0],/Distinct.*: 3/);
});
test('field addition plus option rename preserves IDs, other cells, source snapshot and graph filters',()=>{
  const w=F.workspace();w.records[0].f_stage='Proposal Sent';const before=JSON.stringify(w);
  const spec={version:1,title:'Existing report',chart:'bar',scope:'all',groupBy:'f_stage',bucket:'none',splitBy:null,measures:[{label:'Count',metric:'count',field:null,where:[]}],where:[[F.where('f_stage','equals','Proposal Sent')]],sort:'label_asc',limit:null};
  const board={version:1,elements:[{id:'original',spec,visibleIds:[]}],sharedFilters:[],activeId:'original'};
  const result=prepare(w,[{op:'add_field',id:'new_field',label:'Decision maker',name:'Final Decision Maker',type:'text',options:[]},{op:'rename_choice_option',id:'rename',label:'Rename stage',field:'f_stage',from:'Proposal Sent',to:'Quote'}],{dashboard:board});
  assert.equal(JSON.stringify(w),before);assert.equal(result.next.tableSchema.fields.find(f=>f.id==='f_stage').options.includes('Quote'),true);
  for(const row of result.next.records){const old=w.records.find(r=>r.id===row.id);assert.equal(row.f_stage,old.f_stage==='Proposal Sent'?'Quote':old.f_stage);assert.equal(row.f_value,old.f_value);}
  assert.equal(result.effects[0].board.elements[0].spec.where[0][0].value,'Quote');assert.equal(result.effects[0].board.elements[0].id,'original');
});
test('unmapped business facts remain visible without inventing schema or executing source instructions',()=>{
  const w=F.workspace(),action=F.plan([F.select('one',[],{limit:1}),F.update('value','one','f_value',30000)]);
  action.unmappedFacts=[{text:'Final decision maker: Priya Shah',source:'Our final decision maker is Priya Shah.',reason:'No decision-maker field exists.'}];
  const result=Plan.prepare(w,action,options);assert.match(Plan.render(result,s=>String(s),false),/Facts needing a destination/);assert.equal(result.next.records.length,w.records.length);assert.equal(result.addedFields.length,0);
});

test('dependent selection uses renamed categories without changing the original eligibility population',()=>{
  const w=F.workspace();w.records[0].f_stage='Proposal Sent';w.records[2].f_stage='Proposal Sent';const expected=w.records.filter(r=>r.f_stage==='Proposal Sent').map(r=>r.id);
  assert.ok(expected.length);
  const result=prepare(w,[
    {op:'rename_choice_option',id:'rename',label:'Rename stage',field:'f_stage',from:'Proposal Sent',to:'Quote'},
    F.select('quoted',[[F.where('f_stage','equals','Quote')]]),
    F.update('note','quoted','f_notes','Renamed stage reviewed')
  ]);
  assert.deepEqual(result.review.find(r=>r.id==='quoted').records.map(r=>r.id),expected);
  for(const row of result.next.records)assert.equal(row.f_notes,expected.includes(row.id)?'Renamed stage reviewed':w.records.find(r=>r.id===row.id).f_notes);
  assert.ok(w.records.some(r=>r.f_stage==='Proposal Sent'));
});
