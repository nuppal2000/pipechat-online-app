'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Review=require('../lib/action-review'),Plan=require('../public/workspace-plan');
const Core=require('../public/pipeline-core'),Dashboard=require('../public/dashboard-board');
const Reports=require('../public/report-engine'),Tasks=require('../public/todo-actions'),Todo=require('../public/todo-core');
const Business=require('../lib/business-compiler'),Workspace=require('../public/business-workspace');
const F=require('./fixtures/workspace-plans.cjs');
const today='2026-10-10';
const payload=(workspace=F.workspace(),extra={})=>({userCommand:'Read the saved facts',pipeline:{...workspace,currentDate:today,...extra}});
const result=crmAction=>({crmAction,assistantMessage:'Count: 99999. Total: 7. Everything has been saved.',computedAnswer:'Untrusted model answer'});
const read=(outputs,selection='selected',showTable=false)=>({op:'read_records',id:'answer',label:'Read saved facts',selection,showTable,outputs:outputs.map(([kind,field=null])=>({kind,field}))});
const spec=extra=>({version:1,title:'Saved values',chart:'bar',scope:'all',groupBy:'f_owner',bucket:'none',splitBy:null,measures:[{label:'Value',metric:'sum',field:'f_value',where:[]}],where:[],sort:'label_asc',limit:null,...extra});
const board=report=>({version:1,elements:[{id:'existing',spec:report,visibleIds:[]}],sharedFilters:[],activeId:'existing'});
const options={today,nonce:'review'};

// Narrow transcription of work/objective-live-baseline-rows.json, not model prose.
// Keep this regression self-contained when the test is run outside the acceptance workspace.
const baselineRows=[
  ['Uppal Co','Prospecting',''],
  ['Northstar Design','Qualified','2026-10-02'],
  ['Greenline Foods','Proposal Sent','2026-09-29'],
  ['Harbor Dental Group','Qualified','2026-09-27'],
  ['Northline Security','Proposal Sent','2026-09-26'],
  ['Brightpath Tutors','Negotiation',''],
  ['Maritime Kitchens','Won',''],
  ['Summit Insurance Partners','Proposal Sent',''],
  ['Evergreen Property Group','Negotiation',''],
  ['Pixel Forge Studio','Won',''],
  ['Lakeside Wellness','Prospecting',''],
  ['Atlas Field Services','Qualified',''],
  ['Maple Ridge Properties','Negotiation','2026-10-01'],
  ['Bluebird Dental Network','','2026-09-30'],
  ['North Coast Security','Proposal Sent','2026-10-03'],
  ['Prairie Equipment Co.','',''],
  ['Harbourview Kitchens','Won',''],
  ['Summit Benefits Group','Proposal Sent',''],
  ['Cedar Lane Wellness','','2026-10-12'],
  ['Atlas Maintenance Services','',''],
  ['Brightstone Tutoring','Negotiation','2026-10-05'],
  ['Evergreen Realty Partners','Negotiation',''],
  ['Pixel North Creative','Won',''],
  ['Green Basket Foods','Proposal Sent','2026-09-29'],
  ['Lakeshore Veterinary','','2026-10-07'],
  ['Ironwood Logistics','Proposal Sent',''],
  ['Red River Insurance','','2026-10-06'],
  ['Coastal Solar Installers','',''],
  ['Oak & Stone Construction','Lost',''],
  ['Northern Peak Fitness','','2026-10-09'],
  ['Capital City Legal','Proposal Sent','2026-10-02'],
  ['Westline Manufacturing','Negotiation','2026-10-08'],
  ['Aurora Event Rentals','',''],
  ['Riverbend Accounting','','2026-10-13'],
  ['Golden Prairie Farms','Lost',''],
  ['MetroCare Clinics','Proposal Sent','2026-10-04'],
  ['Stonebridge Architects','',''],
  ['Eastgate Auto Group','Negotiation','2026-10-10'],
  ['Mariner Travel Co.','Won',''],
  ['Forest Hill Childcare','','2026-10-15'],
  ['Polar Data Systems','Proposal Sent','2026-10-01'],
  ['Willow Home Care','','']
];

test('durable read answer uses the complete canonical nine-row cohort, never the seven-name model reply',()=>{
  const w=F.workspace();
  w.tableSchema.fields.find(f=>f.id==='f_stage').options=['Prospecting','Qualified','Proposal Sent','Negotiation','Won','Lost'];
  w.records=baselineRows.map(([name,stage,follow],i)=>({...w.records[0],id:i+1,f_deal:name,f_stage:stage,f_follow:follow}));
  assert.equal(w.records.length,42);
  const open=['Prospecting','Qualified','Proposal Sent','Negotiation'];
  const action=F.plan([F.select('selected',[[F.where('f_stage','in',null,open),F.where('f_follow','is_blank')]]),read([['count'],['names']],undefined,true)]);
  const p=payload(w),r={crmAction:action,assistantMessage:'Uppal Co, Brightpath Tutors, Atlas Field Services, Prairie Equipment Co., Willow Home Care, Stonebridge Architects, Aurora Event Rentals. Count: 7.'};
  const before=structuredClone(p),e=Review.evidence(p,r),answer=Review.renderAnswer(p,r,e);
  assert.equal(e.queryResults[0].recordIds.length,9);
  assert.equal(answer,Plan.prepare(w,action,options).answers.join('\n\n'));
  assert.match(answer,/Record count: 9\./);
  const expected=['Uppal Co','Brightpath Tutors','Summit Insurance Partners','Evergreen Property Group','Lakeside Wellness','Atlas Field Services','Summit Benefits Group','Evergreen Realty Partners','Ironwood Logistics'];
  assert.deepEqual(e.queryResults[0].recordIds.map(id=>w.records.find(row=>row.id===id).f_deal),expected);
  for(const name of expected)assert(answer.includes(name));
  for(const name of ['Prairie Equipment Co.','Willow Home Care','Stonebridge Architects','Aurora Event Rentals'])assert(!answer.includes(name));
  assert.deepEqual(p,before);
});

test('an approving completeness review cannot turn fabricated model totals into the durable answer',()=>{
  const p=payload(),r=result(F.plan([F.select('selected'),read([['count'],['sum','f_value'],['average','f_value']])]));
  const approval={requirements:[{description:'The count and all amounts are correct',satisfied:true,stepIds:['answer']}],issues:[],clarificationQuestion:null};
  assert.equal(Review.validateReview(approval,r).ok,true);
  const answer=Review.renderAnswer(p,r);
  assert.match(answer,/Record count: 6/);assert.match(answer,/Total Value: \$295,000\.00/);assert.match(answer,/Average Value: \$49,166\.67/);
  assert.doesNotMatch(answer,/99999|Everything has been saved|Untrusted model answer/);
  assert.equal(r.assistantMessage,'Count: 99999. Total: 7. Everything has been saved.');
});

test('focus refinements retain canonical names, ordering, numeric zero and an empty cohort',()=>{
  const p=payload(F.workspace(),{conversationFocus:{kind:'table',ids:[5,1]}});
  const r=result(F.plan([F.select('selected',[],{source:'focus'}),read([['names'],['count'],['sum','f_value'],['min','f_value']])]));
  const answer=Review.renderAnswer(p,r);
  assert.match(answer,/Record count: 2/);assert.match(answer,/Total Value: \$41,000\.00/);assert.match(answer,/Lowest Value: \$0\.00/);
  assert(answer.indexOf('Small')<answer.indexOf('Summit Insurance Partners'));
  p.pipeline.conversationFocus.ids=[];
  const empty=Review.renderAnswer(p,r);assert.match(empty,/Record count: 0/);assert.match(empty,/None\./);assert.match(empty,/Lowest Value: Not set/);
});

test('note facts are projected from the same matching rows rather than summarized by the model',()=>{
  const w=F.workspace();w.records[0].f_notes='Compliance reviewed by Priya. Keep the original wording.';w.records[1].f_notes='Unrelated confidential note.';
  const p=payload(w),r=result(F.plan([F.select('selected',[[F.where('f_notes','contains','compliance')]]),read([['count'],['names'],['fields','f_notes']])]));
  const e=Review.evidence(p,r),answer=Review.renderAnswer(p,r,e);
  assert.match(answer,/Compliance reviewed by Priya\. Keep the original wording\./);assert.doesNotMatch(answer,/Unrelated confidential note/);
  assert.equal(e.queryResults[0].projected[0].value,w.records[0].f_notes);
});

test('workspace mutation answers are explicit previews, including computed dates and staged read values',()=>{
  const w=F.workspace(),p=payload(w),before=structuredClone(p);
  const r=result(F.plan([F.select('selected',[],{limit:1}),F.update('edit','selected','f_value',123),F.tasks('task','selected',2),read([['sum','f_value']])]));
  const e=Review.evidence(p,r),answer=Review.renderAnswer(p,r,e);
  assert.equal(e.mutates,true);assert.match(answer,/1 changed records, 1 new tasks/);
  assert.match(answer,/Nothing is saved until you confirm/);assert.match(answer,/Calculated answers for this proposed plan/);
  assert.match(answer,/2026-10-13/);assert.match(answer,/Total Value: \$123\.00/);assert.doesNotMatch(answer,/Everything has been saved/);
  assert.deepEqual(p,before);
});

test('no-op plans do not fall back to a model claim of saved changes',()=>{
  const p=payload(),r=result(F.plan([F.select('selected',[],{limit:1}),F.update('same','selected','f_value',41000)]));
  assert.equal(Review.renderAnswer(p,r),'No table or task changes are needed. No changes were saved.');
});

test('workspace report and dashboard steps use the same analysis strings as browser plan rendering',()=>{
  const w=F.workspace(),p=payload(w);
  for(const step of [
    {op:'report',id:'answer',label:'Owner totals',spec:spec(),showDashboard:false,questions:[{kind:'groups',elementId:'answer',measure:0},{kind:'summary',elementIds:['answer']}]},
    {op:'dashboard',id:'answer',label:'Owner graph',plan:{action:'dashboard_plan',operations:[{op:'add',id:'owner',spec:spec()}],questions:[{kind:'summary',elementIds:['owner']}]}}
  ]){
    const r=result(F.plan([step])),answer=Review.renderAnswer(p,r);
    assert.equal(answer,Plan.prepare(w,r.crmAction,options).answers.join('\n\n'));assert.match(answer,/295,000/);
  }
});

test('dashboard creation, refinement and analysis preserve the canonical answer and do not mutate the snapshot',()=>{
  const w=F.workspace(),core=Core.create(w.tableSchema),p=payload(w,{dashboard:{board:board(spec())}}),before=structuredClone(p);
  const actions=[
    {action:'dashboard_plan',operations:[{op:'add',id:'count',spec:spec({chart:'kpi',groupBy:null,measures:[{label:'Count',metric:'count',field:null,where:[]}]})}],questions:[]},
    {action:'dashboard_plan',operations:[{op:'update',ids:['existing'],mode:'replace_filter',where:[[F.where('f_stage','equals','Qualified')]],replaceFields:['f_stage'],changes:[]}],questions:[{kind:'summary',elementIds:['existing']}]}
  ];
  for(const action of actions){
    const r=result(action),e=Review.evidence(p,r),canonical=Dashboard.apply(p.pipeline.dashboard.board,action,w.records,core,[],options).answer;
    assert.equal(e.answer,canonical);assert.equal(Review.renderAnswer(p,r,e),canonical);assert.equal(Review.renderAnswer(p,r),canonical);
  }
  const r=result({action:'analyze_dashboard',questions:[{kind:'summary',elementIds:['existing']}]});
  assert.equal(Review.renderAnswer(p,r),Dashboard.analyze(r.crmAction.questions,Dashboard.evaluate(p.pipeline.dashboard.board,w.records,core,[],options)));
  assert.deepEqual(p,before);
});

test('audits render counts and names from the canonical scope even when model text claims otherwise',()=>{
  const w=F.workspace(),p=payload(w,{visibleIds:[1,2]}),action={action:'audit_records',scope:'visible',where:[],groups:[{label:'No follow-up',where:[[F.where('f_follow','is_blank')]]}]};
  const canonical=Reports.describeAudit(Reports.auditRecords(w.records,action,Core.create(w.tableSchema),[],{today,visibleIds:[1,2]}));
  assert.equal(Review.renderAnswer(p,result(action)),canonical);assert.match(canonical,/No follow-up \(2\)/);assert.doesNotMatch(canonical,/Already High/);
});

test('task queries ground linked and unlinked saved titles, dates and notes with canonical focus',()=>{
  const w=F.workspace();w.todoCards=[{...Todo.create('todo_linked',1),nextAction:'Call Priya',notes:'Budget confirmed in saved task',dueDate:'2026-10-12'},
    {...Todo.create('todo_standalone',null,'Prepare report'),notes:'Standalone source note',dueDate:'2026-10-13'},
    {...Todo.create('todo_excluded',2),notes:'Do not leak an unselected note'}];
  const p=payload(w,{conversationFocus:{kind:'todos',id:'saved_focus',ids:['todo_linked','todo_standalone']}});
  const r=result({action:'query_todos',selection:{source:'focus',ids:[],focusId:'saved_focus',conditions:[]}}),e=Review.evidence(p,r),before=structuredClone(p);
  const answer=Review.renderAnswer(p,r,e);
  assert.equal(e.count,2);assert.deepEqual(e.cards.map(c=>c.id),['todo_linked','todo_standalone']);
  assert(answer.startsWith(Tasks.describe(e.cards,w.records,w.tableSchema)));
  for(const text of ['Summit Insurance Partners','Prepare report','2026-10-12','2026-10-13','Budget confirmed in saved task','Standalone source note'])assert(answer.includes(text));
  assert.doesNotMatch(answer,/Do not leak|99999/);assert.deepEqual(p,before);
  p.pipeline.conversationFocus.ids=[];assert.match(Review.renderAnswer(p,r),/^No tasks match/);
});

test('cross-table queries render only genuinely linked saved entity facts',()=>{
  const w=F.workspace(),wid='11111111-1111-4111-a111-111111111111';
  const business={workspaceId:wid,version:1,role:'owner',scope:'workspace',state:Workspace.empty(),primary:{updatedAt:today,tableSchema:w.tableSchema,customFields:[],records:[{recordId:1,entityId:Workspace.legacyId(wid,1),values:w.records[0]}]}};
  business.state.entityTypes=[{id:'contacts',name:'Contacts',fields:[{id:'name',name:'Name',type:'text',required:true,options:[]},{id:'notes',name:'Notes',type:'text',required:false,options:[]}]}];
  business.state.entities=[{id:'ent_22222222-2222-4222-a222-222222222222',typeId:'contacts',values:{name:'Priya Shah',notes:'Final decision maker'}},{id:'ent_33333333-3333-4333-a333-333333333333',typeId:'contacts',values:{name:'Unrelated contact',notes:'Not linked'}}];
  business.state.relationshipTypes=[{id:'contact_deals',name:'Contact deals',fromType:'contacts',toType:'primary',cardinality:'many_to_many'}];
  business.state.relationships=[{id:'lnk_44444444-4444-4444-a444-444444444444',typeId:'contact_deals',fromId:business.state.entities[0].id,toId:business.primary.records[0].entityId}];
  const p=payload(w,{business}),action={action:'query_business',typeId:'contacts',query:null,linkedTo:{source:'primary',key:'Summit Insurance Partners'},relationshipTypeId:'contact_deals'};
  const answer=Review.renderAnswer(p,result(action));
  assert.equal(answer,Business.describe(business,Business.query(business,action)));assert.match(answer,/Priya Shah/);assert.match(answer,/Final decision maker/);assert.doesNotMatch(answer,/Unrelated contact/);
});

test('legacy record, KPI and report reads render canonical numbers without the model prose',()=>{
  const p=payload(),query={action:'query_records',where:[[F.where('f_stage','equals','Qualified')]],orderBy:'f_value',direction:'desc'};
  assert.equal(Review.renderAnswer(p,result(query)),'Showing 5 matching records, sorted by Value, descending. Table values are unchanged.');
  const s=spec({chart:'kpi',groupBy:null});
  for(const action of [{action:'show_kpi',title:s.title,scope:s.scope,where:s.where,measures:s.measures},{action:'show_report',smartReport:s}]){
    const answer=Review.renderAnswer(p,result(action));assert.match(answer,/295,000/);assert.match(answer,/6 records represented/);assert.doesNotMatch(answer,/99999/);
  }
});

test('legacy refinement computes the refined report for both dashboard and current-report contexts',()=>{
  const w=F.workspace(),action={action:'refine_report',mode:'replace_filter',where:[[F.where('f_stage','equals','Qualified')]],replaceFields:['f_stage'],changes:[]};
  for(const p of [payload(w,{dashboard:{board:board(spec())}}),{...payload(w),currentReport:spec()}]){
    const before=structuredClone(p),answer=Review.renderAnswer(p,result(action));
    assert.match(answer,/215,000/);assert.match(answer,/5 records represented/);assert.deepEqual(p,before);
  }
});

test('canonical read failures throw instead of silently returning model text',()=>{
  const p=payload(),r=result(F.plan([F.select('selected'),read([['sum','missing_field']])]));
  assert.throws(()=>Review.renderAnswer(p,r),/entire plan is unchanged/);
  assert.throws(()=>Review.renderAnswer(p,result({action:'query_todos',selection:{source:'ids',ids:['missing'],focusId:null,conditions:[]}})),/no longer exists/);
  assert.throws(()=>Review.renderAnswer(p,result({action:'query_records',where:[],orderBy:'missing',direction:'asc'})),/existing sort column/);
  assert.throws(()=>Review.renderAnswer(p,result({action:'analyze_dashboard',questions:[]}),{}),/canonical read answer is unavailable/);
});

test('ordinary chat and unsupported render families retain existing response handling',()=>{
  for(const r of [{assistantMessage:'Happy to help.',crmAction:null},result({action:'clarify',question:'Which record?'}),result({action:'share_view'})]){
    assert.equal(Review.renderAnswer({},r),null);
  }
  // Rendering does not infer a missing action from wording, even when a review approved it.
  const p=payload(),r={crmAction:null,assistantMessage:'Count: 7.'};
  assert.equal(Review.needsReview({...p,userCommand:'Show open deals and their count'},r),true);
  assert.equal(Review.renderAnswer(p,r),null);
});
