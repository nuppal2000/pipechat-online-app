'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
const Core=require('../public/pipeline-core'),Schema=require('../public/table-schema'),Todo=require('../public/todo-core');
const Plan=require('../public/workspace-plan'),Reports=require('../public/report-engine'),Dashboard=require('../public/dashboard-board');
const Compiler=require('../lib/business-compiler'),Business=require('../public/business-workspace'),WorkflowHTTP=require('../lib/business-automation-http');
const F=require('./fixtures/workspace-plans.cjs');
const version='2026-10-10T12:00:00.000Z',wid='11111111-1111-4111-a111-111111111111';
const plain=value=>JSON.parse(JSON.stringify(value));
const source=fs.readFileSync(require.resolve('../public/pipechat'),'utf8').replace(/\r\n/g,'\n');
const workflow=()=>({action:'create_workflow',spec:{version:2,scope:{type:'all_records'},name:'Follow-up workflow',timezone:'UTC',
  trigger:{type:'field_changes_to',field:'f_stage',to:'Negotiation'},conditions:[{type:'no_open_qualifying_task',match:{field:'nextAction',operator:'contains',value:'follow-up'}}],
  action:{type:'create_linked_task',nextAction:'Send follow-up',notes:'',due:{anchor:'event_date',offsetDays:2}}}});
const business=()=>({action:'business_plan',version:1,title:'Contact and links',operations:[
  {op:'put_type',type:{id:'contacts',name:'Contact',fields:[{id:'name',name:'Name',type:'text',required:true,options:[]}]}},
  {op:'put_relationship_type',type:{id:'contact_deals',name:'Contact deals',fromType:'contacts',toType:'primary',cardinality:'many_to_many'}},
  {op:'upsert_entity',alias:'maya',typeId:'contacts',matchField:'name',matchValue:'Maya Chen',mode:'reuse',values:[{field:'name',value:'Maya Chen'}]},
  {op:'link',typeId:'contact_deals',from:{source:'alias',key:'maya'},to:{source:'primary',key:Business.legacyId(wid,1)}}]});
function harness(override){
  const nodes=new Map(),messages=[],calls=[],saved=[];
  const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',textContent:'',hidden:false,disabled:false,innerHTML:'',classList:{add(){},remove(){}},addEventListener(){},removeEventListener(){}});return nodes.get(id);};
  const w=F.workspace();
  const snapshot={updatedAt:version,tableSchema:w.tableSchema,customFields:[],deals:w.records,todoCards:[],workflows:[]};
  const typed={workspaceId:wid,version:0,role:'owner',scope:'workspace',state:Business.empty(),primary:{updatedAt:version,tableSchema:w.tableSchema,customFields:[],records:w.records.map(row=>({recordId:row.id,entityId:Business.legacyId(wid,row.id),values:row}))}};
  const handler=async(url,options)=>{
    const body=options?.body?JSON.parse(options.body):null;calls.push({url,body});
    if(override)return override(url,body);
    if(url==='/api/workflows/prepare')return WorkflowHTTP.prepare('owner',body,snapshot,snapshot);
    if(url==='/api/business/prepare')return Compiler.prepare(typed,body.action,'ui_preview');
    if(url==='/api/documents/proposal')return {recordId:body.recordId,artifact:{filename:'proposal.html'}};
    if(url==='/api/actions/preview-undo')return {actionId:body.actionId,expectedUpdatedAt:version,changes:[]};
    if(url==='/api/workflows/retry')return {operation:'retry',action:{action:'retry_workflow_event',...body},actionId:crypto.randomUUID()};
    throw new Error('Unexpected API call: '+url);
  };
  const window={PipelineCore:Core,PipeChatSchema:Schema,PipeChatTodo:Todo,PipeChatIcons:{},PipeChatPlan:Plan,PipeChatReports:Reports,PipeChatDashboard:Dashboard,PipeChatWorkflowUI:require('../public/workflow-ui')};
  const startup='  wire();\n  restoreSession();';assert(source.includes(startup));
  vm.runInNewContext(source.replace(startup,`const actualTrust=renderTrust;render=()=>{};renderTrust=()=>{};syncWorkspacePanes=()=>{};focusTrust=()=>{};toast=()=>{};updateUsage=()=>{};paintMessage=()=>{};say=text=>messages.push(text);api=handler;
    window.test={S,useSchema,handleAction,prepareWorkflow,chatState,saveChatState,clearDraft,reviewRestoredProposal,acceptTurnResponse,actualTrust,aiPayload,
      restore(state){restoredProposal=state;},restored(){return restoredProposal;},connect(value){conversation=value;chatThread='thread';},
      beginTurn(){turnAwaiting={draftSignature:draftSignature()};}};`),
    {window,document:{getElementById:node},crypto,handler,messages,Intl,Date,TextEncoder,setTimeout,clearTimeout,sessionStorage:{getItem(){return null;},setItem(){},removeItem(){}}});
  const h=window.test;h.useSchema(w.tableSchema);
  Object.assign(h.S,{loaded:true,user:{id:'owner',name:'Owner'},records:w.records,customFields:[],todoCards:[],updatedAt:version,generation:1});
  const conversation={ready:true,state(state){saved.push(plain(state));},load:async()=>({epoch:'epoch',messages:[],state:saved.at(-1)||{}})};
  h.connect(conversation);
  return {...h,calls,messages,saved,w,snapshot,typed,node,conversation};
}

test('chat workflow revision replaces only its unconfirmed compatible draft and persists original intent',async()=>{
  const h=harness(),original='When stage changes to Negotiation, draft a follow-up workflow. Preview only.';
  await h.handleAction({crmAction:workflow()},original);const first=h.S.pending;
  const revised=workflow();revised.spec.timezone='America/New_York';revised.spec.action.due.offsetDays=5;
  h.beginTurn();
  await h.acceptTurnResponse({crmAction:revised,turn:{status:'succeeded',epoch:'epoch',threadId:'thread'}},h.conversation,true,'Use America/New_York and five days.');
  assert.notEqual(h.S.pending,first);assert.equal(h.S.pending.proposal.action.spec.timezone,'America/New_York');
  assert.equal(h.S.pending.proposal.action.spec.action.due.offsetDays,5);assert.equal(h.S.pending.originalCommand,original);
  assert.equal(h.saved.at(-1).originalCommand,original);assert.equal(h.S.pending.attempted,false);
  assert.deepEqual(h.calls.map(c=>c.url),['/api/workflows/prepare','/api/workflows/prepare']);
  assert.equal(h.S.updatedAt,version);assert.deepEqual(h.S.records,h.w.records);
});

test('read-only workspace plans display the same canonical extractive or numeric answer as the server',()=>{
  for(const extractive of [false,true]){
    const h=harness(),canonical=extractive?'Acorn (#1): "Use email."\nSource: Saved note':'Selected records: 1';
    const action=F.plan([F.select('one',[[F.where('f_deal','equals',h.w.records[0].f_deal)]]),
      {op:'read_records',id:'read',label:'Read selected record',selection:'one',outputs:[{kind:'count',field:null}],showTable:false}]);
    const before=plain(h.S.records);
    h.handleAction({crmAction:action,computedAnswer:canonical,ai:{workspaceVersion:version},
      ...(extractive?{answerPresentation:{mode:'extractive',snapshotId:'current-snapshot',workspaceVersion:version}}:{})},'Read');
    assert.deepEqual(h.messages,[canonical]);assert.deepEqual(plain(h.S.focus.ids),[1]);assert.deepEqual(h.S.records,before);assert.equal(h.S.pending,null);
  }
});

test('stale or malformed canonical workspace answers fail before changing focus or draft',()=>{
  for(const failure of ['missing version','stale version','missing body','empty body','bad mode','stale presentation','oversize']){
    const h=harness(),pending={kind:'existing'};h.S.pending=pending;h.S.focus={kind:'table',ids:[2]};
    const action=F.plan([F.select('one'),{op:'read_records',id:'read',label:'Read',selection:'one',outputs:[{kind:'count',field:null}],showTable:false}]);
    const response={crmAction:action,computedAnswer:'Canonical answer',ai:{workspaceVersion:version},answerPresentation:{mode:'extractive',snapshotId:'snapshot',workspaceVersion:version}};
    if(failure==='missing version')delete response.ai;
    if(failure==='stale version')response.ai.workspaceVersion='old';
    if(failure==='missing body')delete response.computedAnswer;
    if(failure==='empty body')response.computedAnswer='';
    if(failure==='bad mode')response.answerPresentation.mode='unchecked';
    if(failure==='stale presentation')response.answerPresentation.workspaceVersion='old';
    if(failure==='oversize')response.computedAnswer='x'.repeat(30001);
    assert.throws(()=>h.handleAction(response,'Read'),/verified|workspace changed/);
    assert.deepEqual(h.messages,[]);assert.equal(h.S.pending,pending);assert.deepEqual(h.S.focus.ids,[2]);
  }
});

test('pending write plans do not publish computed read answers before confirmation',()=>{
  const h=harness(),before=plain(h.S.records),action=F.plan([F.select('one',[[F.where('f_deal','equals',h.w.records[0].f_deal)]]),
    F.update('change','one','f_notes','Proposed note'),{op:'read_records',id:'read',label:'Proposed read',selection:'one',outputs:[{kind:'fields',field:'f_notes'}],showTable:false}]);
  h.handleAction({crmAction:action,computedAnswer:'WITHHELD_READ_RESULT',ai:{workspaceVersion:version}},'Change note and read it');
  assert(h.S.pending);assert.deepEqual(h.S.records,before);assert.doesNotMatch(h.messages.join('\n'),/WITHHELD_READ_RESULT|Proposed note/);
  assert.match(h.messages.join('\n'),/Nothing is saved until/);
});

test('both AI payload branches preserve the current report dashboard for server grounding',()=>{
  const h=harness(),board={version:1,elements:[],sharedFilters:[],activeId:null};
  h.S.dashboard=board;h.S.report={metric:'sum',field:'f_value'};
  assert.deepEqual(plain(h.aiPayload('Read').currentReport),{metric:'sum',field:'f_value',dashboard:board});
  h.useSchema(null);h.S.report={metric:'sum',field:'value'};h.S.dashboard=board;
  assert.deepEqual(plain(h.aiPayload('Read').currentReport),{metric:'sum',field:'value',dashboard:board});
});

test('workflow revision refuses unrelated, stale, changed-session and uncertain-save drafts',async()=>{
  for(const change of ['unrelated','activation','another-workflow','stale','generation','attempted','saving']){
    const h=harness();await h.handleAction({crmAction:workflow()},'Create the workflow');const p=h.S.pending;
    let action=workflow();
    if(change==='unrelated')p.kind='business-plan';
    if(change==='activation')action={action:'set_workflow_activation',workflowId:'workflow_other',active:true};
    if(change==='another-workflow'){
      h.S.sourceAction={action:'set_workflow_activation',workflowId:'workflow_original',active:true};
      action={action:'set_workflow_activation',workflowId:'workflow_other',active:false};
    }
    if(change==='stale')h.S.updatedAt='newer';
    if(change==='generation')h.S.generation++;
    if(change==='attempted')p.attempted=true;
    if(change==='saving')h.S.saving=true;
    await assert.rejects(async()=>h.handleAction({crmAction:action},'Revise the draft'),/current|workspace changed|same save/);
    assert.equal(h.S.pending,p,change);assert.equal(h.calls.length,1,change);
  }
});

test('typed business revisions preserve the initial request and stay proposed through restore',async()=>{
  const h=harness(),original='Create Maya Chen as a contact and link her to the existing deal. Preview only.';
  await h.handleAction({crmAction:business()},original);const first=h.S.pending;
  const revised=business();revised.title='Revised contact preview';
  await h.handleAction({crmAction:revised},'Use Contact and many-to-many.');
  assert.notEqual(h.S.pending,first);assert.equal(h.S.pending.originalCommand,original);
  assert.equal(h.S.pending.proposal.next.entities[0].values.name,'Maya Chen');assert.equal(h.S.pending.proposal.next.relationships.length,1);
  h.saveChatState();const state=h.saved.at(-1);h.clearDraft();h.restore(state);
  await h.reviewRestoredProposal();
  assert.equal(h.S.pending.kind,'business-plan');assert.equal(h.S.pending.originalCommand,original);
  assert.equal(h.S.pending.proposal.title,'Revised contact preview');assert.equal(h.S.sourceAction.action,'business_plan');
  assert.equal(h.saved.at(-1).originalCommand,original);assert(h.calls.every(c=>c.url==='/api/business/prepare'));
  assert.equal(h.typed.state.entities.length,0,'Review and restore never commit the proposed entities');
});

test('workflow, document, undo, activation and retry restores use crmAction and preserve the original command',async()=>{
  const cases=[
    [workflow(),'workflow-save','/api/workflows/prepare'],
    [{action:'create_document',recordId:1,documentType:'proposal',format:'html'},'business-document','/api/documents/proposal'],
    [{action:'undo_action',actionId:crypto.randomUUID()},'journal-undo','/api/actions/preview-undo'],
    [{action:'set_workflow_activation',workflowId:'workflow_saved',active:true},'workflow-save','/api/workflows/prepare'],
    [{action:'retry_workflow_event',workflowId:'workflow_saved',eventId:'event_saved'},'workflow-save','/api/workflows/retry']
  ];
  for(const [action,kind,url]of cases){
    const h=harness(async(path,body)=>{
      assert.equal(path,url);
      return {operation:action.action==='retry_workflow_event'?'retry':action.action==='set_workflow_activation'?'activation':'create',action:body.action||action,actionId:crypto.randomUUID()};
    });
    const original='Original request for '+action.action;
    h.restore({sourceAction:action,originalCommand:original,workspaceVersion:version});
    await h.reviewRestoredProposal();
    assert.equal(h.S.pending.kind,kind,action.action);assert.equal(h.S.pending.originalCommand,original);
    assert.deepEqual(plain(h.S.sourceAction),action);assert.equal(h.saved.at(-1).originalCommand,original);
    assert.equal(h.calls.length,1);assert.equal(h.calls[0].url,url);assert.equal(h.S.updatedAt,version);
  }
});

test('document and undo preparation persist their original commands before any restore',async()=>{
  for(const action of [{action:'create_document',recordId:1,documentType:'proposal',format:'html'},{action:'undo_action',actionId:crypto.randomUUID()}]){
    const h=harness(),command='Prepare '+action.action+' for review';
    await h.handleAction({crmAction:action},command);h.saveChatState();
    assert.equal(h.saved.at(-1).originalCommand,command);assert.deepEqual(h.saved.at(-1).sourceAction,action);
  }
});

test('undo summarizes generic history paths without exposing activity values or changing the inverse',()=>{
  for(const collection of ['records','tasks']){
    const h=harness(),proposal={actionId:crypto.randomUUID(),expectedUpdatedAt:version,changes:[
      {path:['records','4','f_priority'],before:{exists:true,value:'Medium'},after:{exists:true,value:'High'}},
      {path:[collection,'4','history'],before:{exists:true,value:['2026-10-10T12:00:00.000Z | private@example.test: Priority changed.']},after:{exists:true,value:[]}}
    ]};
    const before=JSON.stringify(proposal);h.S.pending={kind:'journal-undo',proposal};h.actualTrust();
    const html=h.node('trustBody').innerHTML;
    assert.match(html,/Priority/);assert.match(html,/class="diff-before">Medium</);assert.match(html,/class="diff-after">High</);
    assert.match(html,/Activity history for this saved change will be restored\./);
    assert.doesNotMatch(html,/private@example\.test|2026-10-10|Priority changed|\[\]/);
    assert.match(html,/data-confirm\s*>Confirm undo/);assert.match(html,/data-cancel>Cancel/);
    assert.equal(JSON.stringify(h.S.pending.proposal),before);assert.equal(h.calls.length,0);
    h.S.saving=true;h.actualTrust();assert.match(h.node('trustBody').innerHTML,/data-confirm disabled/);
  }
});

test('clarification during a workflow revision keeps the original request and answered options',async()=>{
  const h=harness(),original='Original workflow request';await h.handleAction({crmAction:workflow()},original);
  h.handleAction({crmAction:{action:'clarify',question:'Which timezone?',clarificationOptions:null}},'Change the timezone');
  assert.equal(h.S.pending,null);assert.equal(h.S.clarification.originalCommand,original);
  const action=workflow();action.spec.timezone='America/New_York';
  await h.handleAction({crmAction:action},'America/New_York');h.saveChatState();
  assert.equal(h.S.pending.originalCommand,original);assert.equal(h.saved.at(-1).originalCommand,original);
});

test('recovering a successful revision preserves original intent in the restored proposal',async()=>{
  const h=harness(),original='Original workflow request';await h.handleAction({crmAction:workflow()},original);h.saveChatState();h.beginTurn();
  const revised=workflow();revised.spec.action.due.offsetDays=5;
  await h.acceptTurnResponse({crmAction:revised,ai:{workspaceVersion:version},turn:{status:'succeeded',epoch:'epoch',threadId:'thread'}},h.conversation,false,'Make it five days');
  assert.equal(h.restored().originalCommand,original);assert.equal(h.saved.at(-1).originalCommand,original);
  assert.equal(h.restored().sourceAction.spec.action.due.offsetDays,5);
});

test('restores reject stale context and cannot replace an unrelated live proposal',async()=>{
  for(const blocked of ['stale','pending','busy','saving']){
    const h=harness(),other={kind:'business-document'};
    h.restore({sourceAction:workflow(),originalCommand:'Old request',workspaceVersion:blocked==='stale'?'old':version});
    if(blocked==='pending')h.S.pending=other;
    if(blocked==='busy')h.S.busy=true;
    if(blocked==='saving')h.S.saving=true;
    await h.reviewRestoredProposal();assert.equal(h.calls.length,0,blocked);
    if(blocked==='pending')assert.equal(h.S.pending,other);
    if(blocked==='stale')assert.match(h.messages.at(-1),/table changed/);
  }
});

test('late workflow and business revision results preserve a newer draft or changed workspace',async()=>{
  for(const action of [workflow(),business()])for(const change of ['pending','generation','version']){
    let finish,started;
    const ready=new Promise(resolve=>{started=resolve;}),h=harness(()=>new Promise(resolve=>{finish=resolve;started();}));
    const preparation=h.handleAction({crmAction:action},'Prepare a proposal');await ready;
    const other={kind:'business-document'};
    if(change==='pending')h.S.pending=other;
    if(change==='generation')h.S.generation++;
    if(change==='version')h.S.updatedAt='newer';
    finish({action,mutates:true});await assert.rejects(()=>preparation,/workspace or draft changed/);
    assert.equal(h.S.pending,change==='pending'?other:null);assert.equal(h.S.sourceAction,null);
  }
});

test('failed or late restore cannot clear a newer proposal or a changed session',async()=>{
  for(const change of ['pending','generation']){
    let finish,started;
    const ready=new Promise(resolve=>{started=resolve;}),h=harness(()=>new Promise(resolve=>{finish=resolve;started();}));
    h.restore({sourceAction:workflow(),originalCommand:'Saved workflow request',workspaceVersion:version});
    const restore=h.reviewRestoredProposal();await ready;
    const other={kind:'business-plan'};h.S.pending=other;if(change==='generation')h.S.generation++;
    finish({action:workflow()});await restore;assert.equal(h.S.pending,other);assert.equal(h.S.sourceAction,null);
  }
});

const audit=groups=>({action:'audit_records',scope:'all',where:[],groups});
const group=(label,where)=>({label,where:[where]});
function auditWorkspace(h){
  h.S.records=Array.from({length:12},(_,i)=>({...h.w.records[0],id:i+1,f_deal:'Account '+(i+1),f_owner:i<3||i>=9?'Ravi':'Alex',
    f_stage:i===9?'Closed Won':i===11?'':['Prospecting','Qualified','Proposal Sent','Negotiation'][i%4],f_follow:i===10?'2026-10-12':''}));
}
const open=F.where('f_stage','in',null,['Prospecting','Qualified','Proposal Sent','Negotiation']);
const readFocused=where=>F.plan([F.select('selected',where,{source:'focus'}),{op:'read_records',id:'answer',label:'Read the focused records',selection:'selected',showTable:false,outputs:[{kind:'count',field:null},{kind:'sum',field:'f_value'}]}]);

test('answer-only grouped report replaces stale focus but preserves table and dashboard display',()=>{
  const h=harness();auditWorkspace(h);h.S.focus={kind:'table',ids:[10,11]};h.S.tab='dashboard';
  const before=plain({filter:h.S.filter,sort:h.S.sort,dashboard:h.S.dashboard,tab:h.S.tab});
  const action=F.plan([F.select('ravi',[[open,F.where('f_owner','equals','Ravi'),F.where('f_follow','is_blank')]]),{op:'report',id:'totals',label:'Ravi totals',selection:'ravi',showDashboard:false,
    spec:{version:1,title:'Selected totals',chart:'bar',scope:'all',groupBy:'f_owner',bucket:'none',splitBy:null,measures:[{label:'Count',metric:'count',field:null,where:[]}],where:[],sort:'label_asc',limit:null},questions:[{kind:'summary',elementIds:['totals']}]}]);
  h.handleAction({crmAction:action},'Answer only with totals by owner');
  assert.deepEqual(plain(h.S.focus),{kind:'table',ids:[1,2,3]});
  assert.deepEqual(plain({filter:h.S.filter,sort:h.S.sort,dashboard:h.S.dashboard,tab:h.S.tab}),before);
  h.handleAction({crmAction:readFocused([])},'Give the count for those records');
  assert.match(h.messages.at(-1),/Record count: 3/);assert.equal(h.S.pending,null);
});

test('nine-record audit focuses canonical group IDs while preserving the audit display base filter',()=>{
  const h=harness();auditWorkspace(h);const before=plain(h.S.records);
  const action={...audit([group('Missing follow-up',[F.where('f_follow','is_blank')])]),where:[[open]]};
  h.handleAction({crmAction:action},'Open deals missing a follow-up');
  assert.deepEqual(plain(h.S.focus),{kind:'table',ids:[1,2,3,4,5,6,7,8,9],auditGroups:[{label:'Missing follow-up',ids:[1,2,3,4,5,6,7,8,9]}]});
  assert.deepEqual(plain(h.S.filter),{where:[[open]]});assert.deepEqual(plain(h.S.records),before);assert.equal(h.S.pending,null);
});

test('a narrowed three-record audit supersedes the nine-record focus without changing the nine-record display',()=>{
  const h=harness();auditWorkspace(h);
  const base=[[open,F.where('f_follow','is_blank')]];
  h.handleAction({crmAction:{...audit([group('Open with no follow-up',[F.where('f_follow','is_blank')])]),where:base}},'Show the missing follow-ups');
  const displayed=plain(h.S.filter);
  h.handleAction({crmAction:{...audit([group('Ravi',[F.where('f_owner','equals','Ravi')])]),where:base}},'Only Ravi from that set, answer only');
  assert.deepEqual(plain(h.S.focus.ids),[1,2,3]);assert.deepEqual(plain(h.S.filter),displayed);
  const prepared=Plan.prepare({records:h.S.records,tableSchema:h.S.tableSchema,customFields:[],todoCards:[]},readFocused([]),{today:'2026-10-10',nonce:'test',focus:h.S.focus});
  assert.deepEqual(prepared.queryResults[0].recordIds,[1,2,3]);assert.match(prepared.answers[0],/Record count: 3/);
  assert.equal(prepared.effects[0].show,false);assert.deepEqual(plain(h.S.filter),displayed);
});

test('query_records focuses its exact latest three rows, independent of an earlier audit result',()=>{
  const h=harness();auditWorkspace(h);
  h.handleAction({crmAction:audit([group('Open',[open,F.where('f_follow','is_blank')])])},'List open deals without a date');
  h.handleAction({crmAction:{action:'query_records',where:[[open,F.where('f_follow','is_blank'),F.where('f_owner','equals','Ravi')]],orderBy:null,direction:null}},'Show Ravi from that set');
  assert.deepEqual(plain(h.S.focus),{kind:'table',ids:[1,2,3]});
  const prepared=Plan.prepare({records:h.S.records,tableSchema:h.S.tableSchema,customFields:[],todoCards:[]},readFocused([]),{today:'2026-10-10',nonce:'test',focus:h.S.focus});
  assert.deepEqual(prepared.queryResults[0].recordIds,[1,2,3]);
});

test('overlapping audit groups produce a stable union and empty audits keep an explicit empty focus',()=>{
  const h=harness();auditWorkspace(h);
  h.handleAction({crmAction:audit([group('Proposals',[F.where('f_stage','equals','Proposal Sent')]),group('Ravi',[F.where('f_owner','equals','Ravi')])])},'Audit both groups');
  assert.deepEqual(plain(h.S.focus.ids),[3,7,11,1,2,10,12]);assert.equal(h.S.focus.auditGroups.length,2);
  h.handleAction({crmAction:audit([group('No matches',[F.where('f_owner','equals','Missing owner')])])},'No matches');
  assert.deepEqual(plain(h.S.focus),{kind:'table',ids:[],auditGroups:[{label:'No matches',ids:[]}]});
  const prepared=Plan.prepare({records:h.S.records,tableSchema:h.S.tableSchema,customFields:[],todoCards:[]},readFocused([]),{today:'2026-10-10',nonce:'test',focus:h.S.focus});
  assert.deepEqual(prepared.queryResults[0].recordIds,[]);assert.match(prepared.answers[0],/Record count: 0/);
});

test('large repeated audit groups keep complete focus IDs without unbounded subgroup metadata',()=>{
  const h=harness();h.S.records=Array.from({length:2000},(_,i)=>({...h.w.records[0],id:i+1}));
  h.handleAction({crmAction:audit(Array.from({length:20},(_,i)=>group('Group '+i,[F.where('f_owner','is_not_blank')])))},'Audit matching groups');
  assert.equal(h.S.focus.ids.length,2000);assert.equal(h.S.focus.auditGroups,undefined);
  h.saveChatState();assert(h.saved.at(-1));assert.equal(h.saved.at(-1).focus.ids.length,2000);
  assert(Buffer.byteLength(JSON.stringify(h.saved.at(-1)))<30000);
});
