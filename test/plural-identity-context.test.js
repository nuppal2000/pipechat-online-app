'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Grounding=require('../lib/ai-grounding'),Clarification=require('../lib/clarification-context');
const payload=command=>({userCommand:command,pipeline:{primaryField:'name',records:[
  {id:1,name:'Acorn North'},{id:2,name:'Acorn South'},{id:3,name:'Acorn West'}
],todoView:[{id:'todo_call',recordId:1,title:'Acorn North',nextAction:'Call Acorn North',status:'To Do',dueDate:'2026-10-26'},
  {id:'todo_review',recordId:null,title:'Weekly review',nextAction:'Acorn weekly review',status:'In Progress',dueDate:'2026-10-27'}]}});

test('plural cohorts do not trigger a singular identity question',()=>{
  for(const command of ['For Acorn deals, set priority by value','Update all three Acorn accounts','Set every Acorn record priority']){
    const p=payload(command),result={crmAction:{action:'workspace_plan',steps:[{op:'update_records'}]}};
    assert(Grounding.identityContext(p).references.every(ref=>ref.selection==='all_matching_candidates'));
    assert.equal(Grounding.guardIdentity(p,result),result);
  }
  assert.equal(Grounding.guardIdentity(payload('Set Acorn priority'),{crmAction:{action:'workspace_plan'}}).crmAction.action,'clarify');
});

test('leading named cohort scopes preserve the conditional write for the matching reference only',()=>{
  const result={crmAction:{action:'workspace_plan',steps:[{op:'select_records'},{op:'update_records'}]}};
  for(const [name,command] of [
    ['QA1105','Within the QA1105 cohort classify known deal amounts into Priority: 15000 and above High, below 15000 Medium; make no assignment for a missing amount.'],
    ['Acorn','For Acorn cohort, set Priority by value.'],
    ['North Ridge','Across the North-Ridge cohort: mark missing dates for review.']
  ]){
    const p=payload(command);
    p.pipeline.records=[...['Alpha','Beta','Gamma'].map((suffix,i)=>({id:i+1,name:name+' '+suffix})),{id:4,name:'Outside'}];
    const [ref]=Grounding.identityContext(p).references;
    assert.equal(ref.phrase,name.toLowerCase());assert.equal(ref.selection,'all_matching_candidates',command);
    assert.deepEqual(ref.candidates.map(c=>c.id),[1,2,3]);assert.equal(Grounding.guardIdentity(p,result),result);
  }
  const mixed=payload('Within the Acorn cohort set Priority by value; also update Cedar.');
  mixed.pipeline.records.push({id:4,name:'Cedar Alpha'},{id:5,name:'Cedar Beta'});
  const refs=Grounding.identityContext(mixed).references;
  assert.equal(refs.find(ref=>ref.phrase==='acorn').selection,'all_matching_candidates');
  assert.equal(refs.find(ref=>ref.phrase==='cedar').selection,'single_record');
  assert.match(Grounding.guardIdentity(mixed,result).crmAction.question,/Which record did you mean by "cedar"/);
});

test('mentioning a cohort does not authorize a singular, limited, or independently ambiguous target',()=>{
  const result={crmAction:{action:'workspace_plan',steps:[{op:'update_records'}]}};
  for(const command of [
    'Update one record within the Acorn cohort.', 'For the Acorn cohort, update one of its members.',
    'Within Acorn cohort assign priority to a deal.', 'Within the Acorn cohort, set Priority for two records.',
    'For the Acorn cohort, choose one and update the owner.', 'Move that record into the Acorn cohort.',
    'Set notes to "within the Acorn cohort".', 'Update Acorn; within the Acorn cohort classify amounts.',
    'Within the Acorn cohort, classify amounts; also update Acorn.', 'For Acorn, set the cohort label.',
    'Within Acorn cohort update the highest-value deal.', 'Within Acorn cohort update another matching record.',
    'Within Acorn cohort update one record and leave all other Acorn deals unchanged.',
    'Within Acorn cohort set Priority for two matching records.', 'Within the Acorn cohort? Update priority.'
  ]){
    const p=payload(command),ref=Grounding.identityContext(p).references.find(ref=>ref.phrase==='acorn');
    assert.equal(ref.selection,'single_record',command);
    assert.equal(Grounding.guardIdentity(p,result).crmAction.action,'clarify',command);
  }
});

test('all offered record identities retains the original conditional intent',()=>{
  const p=payload('Set Acorn priority according to its value'),question=Grounding.guardIdentity(p,{crmAction:{action:'workspace_plan'}}).crmAction;
  p.pendingClarification={originalCommand:p.userCommand,question:question.question,options:question.clarificationOptions};
  p.userCommand='All three Acorn deals.';
  const resolved=Clarification.resolve(p.pendingClarification,p.userCommand);
  assert.deepEqual(resolved.selectedRecordIds,[1,2,3]);assert.equal(resolved.originalCommand,p.pendingClarification.originalCommand);
  assert.deepEqual(Grounding.identityContext(p).selectedIds,[1,2,3]);
  const result={crmAction:{action:'workspace_plan'}};assert.equal(Grounding.guardIdentity(p,result),result);
  for(const reply of ['all two records','all except the first','all but the second'])assert.equal(Clarification.resolve(p.pendingClarification,reply),null);
  assert.equal(Clarification.resolve({question:'1) Today\n2) Tomorrow'},'all'),null);
});

test('named task references use card IDs rather than partial account names',()=>{
  const p=payload('Move Call Acorn North to tomorrow and Acorn weekly review to Friday');
  const context=Grounding.identityContext(p);
  assert.deepEqual(context.taskReferences.map(ref=>ref.candidates[0].id),['todo_call','todo_review']);
  const action={crmAction:{action:'workspace_plan',steps:[{op:'update_tasks'},{op:'update_tasks'}]}};
  assert.equal(Grounding.guardIdentity(p,action),action);
  const mixed={crmAction:{action:'workspace_plan',steps:[{op:'update_tasks'},{op:'update_records'}]}};
  assert.equal(Grounding.guardIdentity(payload('Move Acorn task and set Acorn priority'),mixed).crmAction.action,'clarify');
});
