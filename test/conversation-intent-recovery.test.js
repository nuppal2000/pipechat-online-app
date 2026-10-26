'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const Grounding=require('../lib/ai-grounding'),Clarification=require('../lib/clarification-context');
const Intent=require('../lib/conversation-intent-context'),Schema=require('../public/table-schema');
const at='2026-10-26T12:00:00.000Z';
const current={updatedAt:at,tableSchema:Schema.legacySchema(),customFields:[],todoCards:[],deals:[
  {id:1,account:'Acorn East'},{id:2,account:'Acorn West'},{id:3,account:'Acorn North'},
  {id:4,account:'Northstar Design'},{id:5,account:'Birch East'},{id:6,account:'Birch West'}
]};
const edit=()=>({crmAction:{action:'update_records'}});
function fixture(command,{status='failed',answered=false}={}){
  const originalCommand='Set Acorn contact to Jon.';
  const original=Grounding.prepare({userCommand:originalCommand},structuredClone(current),{},null);
  const question=Grounding.guardIdentity(original,edit()).crmAction;
  const pending={originalCommand,question:question.question,options:question.clarificationOptions};
  if(answered){pending.answers=[{question:pending.question,answer:'2'}];pending.question='Which contact?';pending.options=null;}
  const messages=[originalCommand,'Public terminal reply.',command].map((content,i)=>({
    id:randomUUID(),seq:i+1,role:i===1?'assistant':'user',content,createdAt:at}));
  const state={clarification:pending,originalCommand,workspaceVersion:at,savedAt:at};
  const page={epoch:randomUUID(),version:3,messages,state,before:null,summary:'',summaryThrough:0,memoryMessages:[]};
  const outcomes=[{requestId:randomUUID(),userMessageId:messages[0].id,assistantMessageId:messages[1].id,
    status,publicErrorCode:status==='cancelled'?'cancelled':status==='interrupted'?'timeout':'validation',finishedAt:at}];
  const payload=Grounding.prepare({userCommand:command,pendingClarification:pending,
    conversationIntent:Intent.contextFor(page,outcomes,state,command)},structuredClone(current),{},state);
  return {payload,pending,page};
}

test('all-menu resolution accepts only literal offered-cohort selection, not independent prose or narrower identities',()=>{
  const {pending}=fixture('all'),before=structuredClone(pending);
  for(const reply of ['all','ALL!','all three','All 3 records.','All three Acorn deals.',
    'all of them','all of the three offered records','All three of those Acorn accounts, please.','all the options above']){
    const result=Clarification.resolve(pending,reply);
    assert.deepEqual(result?.selectedRecordIds,[1,2,3],reply);
    assert.equal(result.originalCommand,pending.originalCommand);
  }
  for(const reply of ['All I need now is the current record count.','All I want is a count.',
    'All done. Show current totals.','All tasks due tomorrow','All records with missing owners',
    'All three Acorn deals. Then delete Birch.','All Acorn East records','all two records','all of those two records',
    'all except the first','all but the second','all not Acorn West','all 13 accounts','all unicorn accounts']){
    assert.equal(Clarification.resolve(pending,reply),null,reply);
  }
  assert.deepEqual(pending,before);
  assert.equal(Clarification.resolve({question:'1) Today\n2) Tomorrow'},'all'),null);
});

test('closed historical intents cannot supply the identity or selected IDs of an independent request',()=>{
  for(const status of ['failed','interrupted','cancelled'])for(const command of [
    'Show the current record count.','All I need now is the current record count.',
    'Please show all records.','Could you list the records?','How many records are there?',
    'Set Northstar Design contact to Mia.','For Northstar Design, update contact to Mia.'
  ]){
    const {payload,pending}=fixture(command,{status,answered:true}),before=structuredClone(pending);
    assert.equal(payload.conversationIntent.terminalTurns[0].intentState,'closed');
    const context=Grounding.identityContext(payload);
    assert(!context.references.some(ref=>ref.phrase==='acorn'),command);
    assert.deepEqual(context.selectedIds,[],command);assert.equal(context.selectedId,null,command);
    const result=edit();assert.equal(Grounding.guardIdentity(payload,result),result,command);
    assert.deepEqual(pending,before,'scope selection must not clear or mutate saved pending state');
  }
});

test('a new singular write cannot inherit an old selection even for the same ambiguous reference',()=>{
  for(const command of ['Set Acorn contact to Mia.','Please update Birch notes to hello.',
    'For Acorn, change the owner to Alex.']){
    const {payload}=fixture(command,{answered:true}),context=Grounding.identityContext(payload);
    assert.deepEqual(context.selectedIds,[],command);
    const result=Grounding.guardIdentity(payload,edit());assert.equal(result.crmAction.action,'clarify',command);
    assert.match(result.crmAction.question,command.includes('Birch')?/Birch East/:/Acorn East/);
  }
});

test('short candidate and literal value replies keep the current clarification and its prior selected identity',()=>{
  for(const command of ['2','option 2','Acorn West','Acorn West [record #2]','all three Acorn accounts']){
    const {payload}=fixture(command),context=Grounding.identityContext(payload),result=edit();
    assert(context.references.some(ref=>ref.phrase==='acorn'),command);
    assert.deepEqual(context.selectedIds,command.startsWith('all')?[1,2,3]:[2],command);
    assert.equal(Grounding.guardIdentity(payload,result),result,command);
  }
  for(const command of ['Jon','Jon Bell','Ravi','High','Proposal Sent','2026-11-12','12500','yes','try again']){
    const {payload}=fixture(command,{answered:true}),result=edit();
    assert.equal(Grounding.identityContext(payload).selectedId,2,command);
    assert.equal(Grounding.guardIdentity(payload,result),result,command);
  }
  const unresolved=fixture('Jon').payload;
  assert.equal(Grounding.guardIdentity(unresolved,edit()).crmAction.action,'clarify','a value alone must not choose an ambiguous account');
});

test('typed read-only workspace plans never trigger record-write ambiguity; mixed writes still do',()=>{
  const {payload}=fixture('Jon');
  for(const op of ['select_records','read_records','read_history','report','dashboard']){
    const result={crmAction:{action:'workspace_plan',steps:[{op:'select_records'},{op}]}};
    assert.equal(Grounding.guardIdentity(payload,result),result,op);
  }
  for(const steps of [[],[{op:'read_records'},{op:'update_records'}],[{op:'read_records'},{op:'add_todos'}],
    [{op:'select_records'},{op:'unknown_operation'}]]){
    assert.equal(Grounding.guardIdentity(payload,{crmAction:{action:'workspace_plan',steps}}).crmAction.action,'clarify');
  }
});

test('existing-task bypass admits only explicit task-only operations and neutral read dependencies',()=>{
  const {payload}=fixture('Move Acorn review to Friday.');
  for(const op of ['update_tasks','add_unlinked_task','select_records','read_records','read_history','report','dashboard']){
    const result={crmAction:{action:'workspace_plan',steps:[{op:'update_tasks'},{op}]}};
    assert.equal(Grounding.guardIdentity(payload,result),result,op);
  }
  for(const op of ['delete_records','merge_records','create_records','update_records','add_todos',
    'add_field','rename_choice_option','unknown_operation',null])for(const reverse of [false,true]){
    const steps=[{op:'update_tasks'},op===null?null:{op}, {op:'read_records'}];
    if(reverse)steps.reverse();
    const result={crmAction:{action:'workspace_plan',steps}},before=structuredClone(result);
    const guarded=Grounding.guardIdentity(payload,result);
    assert.equal(guarded.crmAction.action,'clarify',String(op));
    assert.match(guarded.crmAction.question,/Acorn East/);
    assert.match(guarded.crmAction.question,/Acorn West/);
    assert.deepEqual(result,before,'guarding a mixed plan must not mutate its operations');
  }
});

test('singular and inexact Acorn requests never broaden to the plural cohort',()=>{
  for(const command of ['Update one of the Acorn accounts.', 'Update any one of the Acorn accounts.',
    'Update anyone of the Acorn accounts.', 'Update one of the three Acorn accounts.',
    'Update one of our Acorn accounts.', 'Update one of all Acorn accounts.',
    'Update a single Acorn account.', 'Update an Acorn account.', 'Update either Acorn account.',
    'Update any Acorn account.', 'Update some Acorn accounts.', 'Update Acorn.',
    'Update one or more Acorn accounts.', 'Update a few of the Acorn accounts.',
    'Update two of the Acorn accounts.', 'Update both Acorn accounts.', 'Update all two Acorn accounts.',
    'For the Acorn accounts, pick one and update its owner.',
    'For Acorn accounts, choose any one and update its owner.',
    'Update one of the Acorn accounts and leave all records unchanged otherwise.',
    'Update Acorn and show all records.']){
    const payload=Grounding.prepare({userCommand:command},structuredClone(current),{},null);
    assert.equal(Grounding.identityContext(payload).references.find(ref=>ref.phrase==='acorn').selection,'single_record',command);
    assert.equal(Grounding.guardIdentity(payload,edit()).crmAction.action,'clarify',command);
  }
  for(const command of ['Update all Acorn accounts.','For Acorn deals, set contact to Jon.',
    'Set every Acorn record contact to Jon.','Update all three Acorn accounts.',
    'Update all accounts matching Acorn.','Add one task for each Acorn account.']){
    const payload=Grounding.prepare({userCommand:command},structuredClone(current),{},null),result=edit();
    assert.equal(Grounding.identityContext(payload).references.find(ref=>ref.phrase==='acorn').selection,'all_matching_candidates',command);
    assert.equal(Grounding.guardIdentity(payload,result),result,command);
  }
});
