'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Plan=require('../public/workspace-plan'),Reports=require('../public/report-engine'),Core=require('../public/pipeline-core'),Review=require('../lib/action-review'),Todo=require('../public/todo-core');
const F=require('./fixtures/workspace-plans.cjs');
const options={today:'2026-10-04',nonce:'complete'};
const read=(selection,outputs,showTable=false)=>({op:'read_records',id:'answer',label:'Answer',selection,outputs:outputs.map(([kind,field=null])=>({kind,field})),showTable});
const run=(w,steps,extra={})=>Plan.prepare(w,F.plan(steps),{...options,...extra});
const taskSelection=id=>({source:'ids',ids:[id],focusId:null,conditions:[]});
const edit=(id,cardId,value)=>({op:'update_tasks',id,label:id,selection:taskSelection(cardId),changes:[{field:'dueDate',operation:'set',value}]});

test('one selected population supplies explicit count, names, total, average and tied extrema',()=>{
  const w=F.workspace();w.records=w.records.slice(0,3).map((row,i)=>({...row,f_value:[73000,47000,41000][i]}));const before=JSON.stringify(w);
  const result=run(w,[F.select('selected',[],{orderBy:'f_value',direction:'desc'}),read('selected',[['count'],['names'],['sum','f_value'],['average','f_value'],['min','f_value'],['max','f_value']])]);
  assert.match(result.answers[0],/161,000/);assert.match(result.answers[0],/53,666.67/);assert.match(result.answers[0],/Record count: 3/);assert.match(result.answers[0],/Highest.*73,000/);assert.match(result.answers[0],/Lowest.*41,000/);
  assert.equal(result.mutates,false);assert.equal(JSON.stringify(w),before);assert.deepEqual(result.effects[0].ids,[1,2,3]);
});
test('follow-up show those records retains exact identities and order, including an empty result',()=>{
  const w=F.workspace(),steps=[F.select('those',[],{source:'focus'}),read('those',[['count'],['names']],true)];
  const result=run(w,steps,{focus:{kind:'table',ids:[4,1,3]}});assert.deepEqual(result.effects[0].ids,[4,1,3]);
  // Source focus must retain its order when no new sort is requested.
  assert.equal(result.effects[0].show,true);
  const empty=run(w,steps,{focus:{kind:'table',ids:[]}});assert.deepEqual(empty.effects[0].ids,[]);
  assert.throws(()=>run(w,steps,{focus:{kind:'todos',ids:[]}}),/Select records/);
});
test('conditional rules select from immutable eligibility, including owner AND stage alternatives',()=>{
  const w=F.workspace();w.records.forEach((r,i)=>{r.f_owner=i<4?'Sarah':'Ravi';r.f_stage=i%2?'Proposal Sent':'Negotiation';r.f_value=i*30000;});
  const base=[F.where('f_owner','equals','Sarah'),F.where('f_stage','in',null,['Proposal Sent','Negotiation'])];
  const result=run(w,[F.select('cohort',[base]),F.update('first','cohort','f_stage','Qualified'),F.select('lower',[[F.where('f_stage','in',null,['Proposal Sent','Negotiation']),F.where('f_value','lt',80000)]],{source:'cohort'}),F.update('priority','lower','f_priority','Medium')]);
  assert.deepEqual(result.review[2].records.map(r=>r.id),[1,2,3]);assert.deepEqual(result.next.records.filter(r=>r.f_priority==='Medium').map(r=>r.id),[1,2,3,4]);
});
test('open AND blank date excludes terminal, unknown stages and already dated records',()=>{
  const w=F.workspace();w.records[1].f_stage='';w.records[2].f_stage='Closed Lost';
  const result=run(w,[F.select('missing',[[F.where('f_stage','in',null,['Qualified','Proposal Sent','Negotiation']),F.where('f_follow','is_blank')]]),F.update('date','missing','f_follow',{dateMode:'calendar_days',date:null,offset:7})]);
  assert.deepEqual(result.patches.map(p=>p.id),[1,5]);assert.equal(result.next.records[0].f_follow,'2026-10-11');
});
test('existing task exclusion includes completed tasks and never drops a matching account',()=>{
  const w=F.workspace();w.todoCards=[{...Todo.create('todo_existing',2),status:'Done'}];
  const result=run(w,[F.select('eligible',[[F.where('f_stage','equals','Qualified')]],{relatedTasks:'none'}),F.tasks('tasks','eligible')]);
  assert.deepEqual(result.addedCards.map(c=>c.recordId),[1,3,4,5]);assert.equal(result.next.todoCards[0].id,'todo_existing');
});
test('unlinked task requires no company and edits to two cards retain separate dates',()=>{
  const w=F.workspace();w.todoCards=[Todo.create('todo_a',1),Todo.create('todo_b',2)];
  const result=run(w,[{op:'add_unlinked_task',id:'new_task',label:'Standalone',customTitle:'Prepare weekly sales report',status:'To Do',nextAction:'Prepare report',notes:'',dueDate:null},edit('today','todo_a','2026-10-04'),edit('tomorrow','todo_b','2026-10-05')]);
  assert.equal(result.addedCards[0].recordId,null);assert.equal(result.next.todoCards[0].dueDate,'2026-10-04');assert.equal(result.next.todoCards[1].dueDate,'2026-10-05');assert.equal(result.taskPatches.length,2);
  assert.deepEqual(result.next.records,w.records);assert.match(Plan.render(result,s=>String(s),false),/2026-10-05/);
  assert.throws(()=>run(w,[edit('first','todo_a','2026-10-04'),edit('conflict','todo_a','2026-10-05')]),/conflict|different/i);
});
const spec=extra=>({version:1,title:'Fixed title',chart:'bar',scope:'all',groupBy:'f_owner',bucket:'none',splitBy:null,measures:[{label:'Value',metric:'sum',field:'f_value',where:[]}],where:[],sort:'label_asc',limit:null,...extra});
test('read-only grouped question returns actual groups and totals without dashboard effect',()=>{
  const w=F.workspace(),result=run(w,[{op:'report',id:'answer',label:'Owners',spec:spec(),showDashboard:false,questions:[{kind:'groups',elementId:'answer',measure:0},{kind:'summary',elementIds:['answer']}]}]);
  assert.equal(result.mutates,false);assert.equal(result.effects.length,0);assert.match(result.answers[0],/Alex/);assert.match(result.answers[0],/295,000/);
});
test('dashboard and record changes remain staged and fail as a whole if a later operation fails',()=>{
  const w=F.workspace(),before=JSON.stringify(w),steps=[F.select('all_rows'),F.update('edit','all_rows','f_priority','High'),{op:'dashboard',id:'graphs',label:'Graphs',plan:{action:'dashboard_plan',operations:[{op:'add',id:'one',spec:spec()},{op:'add',id:'two',spec:spec({measures:[{label:'Count',metric:'count',field:null,where:[]}]})}],questions:[{kind:'summary',elementIds:['one','two']}]}}];
  const result=run(w,steps);assert.equal(result.effects[0].board.elements.length,2);assert.equal(JSON.stringify(w),before);
  assert.throws(()=>run(w,[...steps,F.update('invalid','all_rows','missing','X')]),/entire plan/);assert.equal(JSON.stringify(w),before);
});
test('percentage denominator is shared across split groups, overlapping labels and zero-value records',()=>{
  const w=F.workspace(),core=Core.create(w.tableSchema),s=spec({groupBy:'f_priority',splitBy:'f_stage',measures:[{label:'Share',metric:'percentage',field:null,where:[]},{label:'Status / Share',metric:'percentage',field:null,where:[[F.where('f_value','gte',0)]]}]});
  const result=Reports.execute(w.records,s,core,[],options);
  for(let i=0;i<2;i++)assert(Math.abs(result.datasets.filter((d,index)=>index%2===i).flatMap(d=>d.values).reduce((a,b)=>a+b,0)-100)<1e-7);
});
test('ambiguous generic graph edit asks identity; exact graph title bypasses that gate',()=>{
  const payload={userCommand:'Change the graph to Bar',pipeline:{dashboard:{board:{elements:[{id:'one',spec:spec({title:'Owner values'})},{id:'two',spec:spec({title:'Stage counts'})}]}}}};
  assert.match(Review.graphQuestion(payload).assistantMessage,/Which graph/);payload.userCommand='Change the Owner values graph to Bar';assert.equal(Review.graphQuestion(payload),null);
});
test('completeness review requires every requested outcome mapped to real steps and no issues',()=>{
  const result={crmAction:F.plan([F.select('select')])};
  const requirement={description:'Count',satisfied:true,stepIds:['select']},review={requirements:[requirement],issues:[],clarificationQuestion:null};
  assert.equal(Review.validateReview(review,result).ok,true);
  for(const changed of [{...review,requirements:[requirement,{description:'Missing total',satisfied:false,stepIds:[]}]},{...review,issues:['Open scope omitted']},{...review,requirements:[{...requirement,stepIds:['invented']}]}])assert.equal(Review.validateReview(changed,result).ok,false);
});

test('failed reviews explain bounded unmet outcomes instead of an opaque refusal',()=>{
  const result={crmAction:F.plan([F.select('select')])};
  const review={requirements:[{description:'Keep selected accounts',satisfied:true,stepIds:['wrong']}],issues:[],clarificationQuestion:null};
  const checked=Review.validateReview(review,result);assert.equal(checked.mappingIssues.length,1);
  assert.match(Review.failureMessage({...review,issues:checked.mappingIssues}),/Keep selected accounts/);
  assert.match(Review.failureMessage({issues:['Missing date predicate'],requirements:[]}),/Missing date predicate/);
  assert(Review.failureMessage({issues:['x'.repeat(4000)]}).length<1100);
});

test('review output can reference only actual compiled steps, never invented root IDs',()=>{
  const action=F.plan([F.select('actual_selection'),read('actual_selection',[['count']])]);
  const choices=Review.schemaFor(action).properties.requirements.items.properties.stepIds.items.enum;
  assert.deepEqual(choices,['actual_selection','answer']);
  assert.deepEqual(Review.schemaFor({action:'dashboard_plan'}).properties.requirements.items.properties.stepIds.items.enum,['root']);
  assert.equal(Review.schema.properties.requirements.items.properties.stepIds.items.enum,undefined);
});

test('dashboard analysis review validates references and supplies computed answers',()=>{
  const w=F.workspace(),board={version:1,elements:[{id:'existing',spec:spec(),visibleIds:[]}],sharedFilters:[],activeId:'existing'};
  const payload={pipeline:{...w,currentDate:options.today,dashboard:{board}}};
  const result={crmAction:{action:'analyze_dashboard',questions:[{kind:'summary',elementIds:['existing']}]}};
  const evidence=Review.evidence(payload,result);assert.match(evidence.answer,/295,000/);assert.equal(evidence.dashboardChanged,false);
  result.crmAction.questions[0].elementIds=['missing'];assert.throws(()=>Review.evidence(payload,result),/not currently displayed/);
});

test('model emits complete steps before outcome references and repair identifies bad references',()=>{
  const branch={properties:{action:{enum:['workspace_plan']},goals:{type:'array'},steps:{type:'array'}},required:['action','goals','steps']};
  const model=Review.modelSchema({properties:{crmAction:{anyOf:[branch]}}});
  assert.deepEqual(Object.keys(model.properties.crmAction.anyOf[0].properties),['action','steps','goals']);
  assert.deepEqual(Object.keys(branch.properties),['action','goals','steps']);
  const action=F.plan([F.select('actual')]);action.goals[0].stepIds=['missing'];
  assert.throws(()=>Plan.prepare(F.workspace(),action,options),/Unrecognized references: missing.*Available steps: actual/);
});
