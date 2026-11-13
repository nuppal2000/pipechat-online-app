'use strict';

const test=require('node:test'),assert=require('node:assert/strict');
const Grounding=require('../lib/ai-grounding'),Todo=require('../public/todo-core');
const TaskActions=require('../public/todo-actions'),Plan=require('../public/workspace-plan');
const F=require('./fixtures/workspace-plans.cjs');

function fixture({prefix='Northstar',source='Tide Glass',taskName=prefix+' send samples'}={}){
  const w=F.workspace();
  const names=[source,'Harbor Audio',prefix+' Copper Books',prefix+' Silver Cafe',prefix+' Gold Repairs',prefix+' Bronze Bikes'];
  w.records.forEach((row,i)=>{row.f_deal=names[i];});
  w.todoCards=[{...Todo.create('todo_samples',1),nextAction:taskName,status:'Done',dueDate:'2026-11-14',notes:'Use the small sample box.'},
    {...Todo.create('todo_delivery',1),nextAction:prefix+' check delivery',dueDate:'2026-11-19',notes:'Keep delivery notes.'}];
  return w;
}
const payload=(command,w=fixture())=>Grounding.prepare({userCommand:command},{...w,deals:w.records},{},null);
const referencePlan=(taskName='Northstar send samples',recordName='Tide Glass')=>F.plan([{op:'update_tasks',id:'reopen',label:'Reopen task',
  selection:{source:'references',references:[{taskName,recordName}],conditions:[]},
  changes:[{field:'status',operation:'set',value:'To Do'},{field:'dueDate',operation:'clear',value:null}]}]);
const proposal=()=>({crmAction:referencePlan()});
const taskRef=(context,phrase='northstar send samples')=>context.taskReferences.find(ref=>ref.phrase===phrase);

test('F12: saved task text does not introduce unrelated primary-record candidates before planning or guarding',()=>{
  const w=fixture({prefix:'QA1113',source:'QA1110 Tide Glass'}),before=structuredClone(w);
  const command='Reopen QA1113 send samples for QA1110 Tide Glass and remove its due date. Keep its notes.';
  const p=payload(command,w),original=structuredClone(p),context=Grounding.identityContext(p);
  assert.deepEqual(context.references.map(ref=>ref.candidates.map(row=>row.id)),[[1]]);
  assert.deepEqual(taskRef(context,'qa1113 send samples').candidates,[{
    id:'todo_samples',title:'QA1110 Tide Glass',nextAction:'QA1113 send samples',recordId:1,status:'Done',dueDate:'2026-11-14'
  }]);
  const result={crmAction:referencePlan('QA1113 send samples','QA1110 Tide Glass')};
  assert.equal(Grounding.guardIdentity(p,result),result);
  const clarification={crmAction:{action:'clarify',question:'Which task status?'}};
  assert.equal(Grounding.guardIdentity(p,clarification),clarification,'do not replace planner output with a false account menu');
  const preview=Plan.prepare(w,result.crmAction,{nonce:'task_identity',today:'2026-11-13'});
  assert.deepEqual(preview.next.todoCards,[{...before.todoCards[0],status:'To Do',dueDate:''},before.todoCards[1]]);
  assert.deepEqual(preview.next.records,before.records);assert.deepEqual(preview.patches,[]);
  assert.deepEqual(p,original);assert.deepEqual(w,before);
});

test('existing task identity supports edit verbs, field-first wording, quotes and linked-record ordering',()=>{
  for(const command of [
    'Reopen Northstar send samples for Tide Glass.',
    'Complete Northstar send samples for Tide Glass.',
    'Mark Northstar send samples for Tide Glass as Done.',
    'Reschedule Northstar send samples for Tide Glass to Friday.',
    'Remove the due date from Northstar send samples for Tide Glass.',
    'Set the due date of Northstar send samples for Tide Glass to tomorrow.',
    'Change the status of the task named Northstar send samples for Tide Glass to To Do.',
    'Clear Northstar send samples due date for Tide Glass.',
    'Please move the existing task called "Northstar send samples" for "Tide Glass" to Friday.',
    "Reopen 'Northstar send samples' linked to Tide Glass.",
    'Reopen \u201cNorthstar send samples\u201d for Tide Glass.',
    'For Tide Glass, reopen Northstar send samples and keep its notes.',
    'For the task Northstar send samples for Tide Glass, remove its due date.',
    'Move the Northstar send samples task for Tide Glass to tomorrow.',
    'Reopen NORTHSTAR SEND SAMPLES for Tide Glass.'
  ]){
    const p=payload(command),context=Grounding.identityContext(p),result=proposal();
    assert.deepEqual(context.references.map(ref=>ref.candidates.map(row=>row.id)),[[1]],command);
    assert.deepEqual(taskRef(context).candidates.map(card=>card.id),['todo_samples'],command);
    assert.equal(Grounding.guardIdentity(p,result),result,command);
  }
});

test('standalone saved titles and nextAction names are task identities, not record prefixes',()=>{
  const w=fixture();w.todoCards.push({...Todo.create('todo_standalone',null,'Northstar weekly review'),nextAction:'Check totals'});
  for(const command of ['Move Northstar weekly review to Friday.','Reopen the task named Northstar weekly review.']){
    const p=payload(command,w),context=Grounding.identityContext(p),result=proposal();
    assert.deepEqual(context.references,[],command);
    assert.deepEqual(taskRef(context,'northstar weekly review').candidates.map(card=>card.id),['todo_standalone']);
    assert.equal(Grounding.guardIdentity(p,result),result);
  }
});

test('distinct saved task names stay distinct in coordinated and mixed edits',()=>{
  for(const command of ['Move Northstar send samples to tomorrow and Northstar check delivery to Friday.',
    'Reopen Northstar send samples; update Northstar check delivery due date to Friday.',
    'Move Northstar send samples to tomorrow and set Harbor Audio owner to Alex.']){
    const p=payload(command),context=Grounding.identityContext(p),result=proposal();
    assert(!context.references.some(ref=>ref.phrase==='northstar'),command);
    assert.equal(Grounding.guardIdentity(p,result),result,command);
    assert.deepEqual(taskRef(context).candidates.map(card=>card.id),['todo_samples']);
    if(command.includes('check delivery'))assert.deepEqual(taskRef(context,'northstar check delivery').candidates.map(card=>card.id),['todo_delivery']);
    else assert.deepEqual(context.references.map(ref=>ref.candidates.map(row=>row.id)),[[2]]);
  }
});

test('task-text masking is occurrence-specific and cannot suppress independent account writes',()=>{
  for(const command of ['Reopen Northstar send samples for Tide Glass; set Northstar owner to Sam.',
    'Reopen Northstar send samples for Tide Glass and update Northstar notes.',
    'Set Northstar owner to Sam, then reopen Northstar send samples for Tide Glass.',
    'Reopen Northstar send samples for Tide Glass and remove Northstar.',
    'Reopen Northstar send samples for Tide Glass; update the Northstar send samples account.']){
    const p=payload(command),context=Grounding.identityContext(p);
    assert(context.references.some(ref=>ref.phrase==='northstar'&&ref.candidates.length===4),command);
    assert.match(Grounding.guardIdentity(p,proposal()).crmAction.question,/Which record did you mean by "northstar"/,command);
  }
});

test('actual ambiguous linked accounts remain guarded even for guessed task-only IDs or direct todo actions',()=>{
  const w=fixture();w.records[0].f_deal='Atlas East';w.records[1].f_deal='Atlas West';
  for(const command of ['Reopen Northstar send samples for Atlas.',
    'Complete the task named Northstar send samples linked to Atlas.',
    'Clear the due date of Northstar send samples for Atlas.',
    'Move the Atlas task to tomorrow.']){
    const p=payload(command,w),context=Grounding.identityContext(p);
    assert(context.references.some(ref=>ref.phrase==='atlas'&&ref.candidates.length===2),command);
    for(const action of [{action:'workspace_plan',steps:[{op:'update_tasks',selection:{source:'ids',ids:['todo_samples']}}]},
      {action:'workspace_plan',steps:[{op:'select_records'},{op:'update_tasks'}]},
      {action:'update_todos',updates:[]},{action:'clarify',question:'Which date?'}]){
      assert.match(Grounding.guardIdentity(p,{crmAction:action}).crmAction.question,/Which record did you mean by "atlas"/,command);
    }
  }
});

test('identical linked record names still require record identity even when only one has the named task',()=>{
  const w=fixture();w.records[1].f_deal='Tide Glass';
  const p=payload('Reopen Northstar send samples for Tide Glass.',w);
  assert.match(Grounding.guardIdentity(p,proposal()).crmAction.question,/Which record did you mean by "tide glass"/);
});

test('duplicate task names remain multiple candidates and the task compiler rejects an unresolved reference',()=>{
  for(const recordId of [1,2]){
    const w=fixture();w.todoCards.push({...w.todoCards[0],id:'todo_duplicate',recordId});
    const p=payload('Reopen Northstar send samples and remove its due date.',w),context=Grounding.identityContext(p);
    assert.deepEqual(context.references,[]);
    assert.deepEqual(taskRef(context).candidates.map(card=>card.id),['todo_samples','todo_duplicate']);
    const clarification={crmAction:{action:'clarify',question:'Which saved task did you mean?'}};
    assert.equal(Grounding.guardIdentity(p,clarification),clarification);
    assert.throws(()=>Plan.prepare(w,referencePlan('Northstar send samples',null),{nonce:'duplicate'}),
      error=>error.reasonCode==='task_reference_ambiguous');
    if(recordId===1)assert.throws(()=>Plan.prepare(w,referencePlan(),{nonce:'duplicate_link'}),error=>error.reasonCode==='task_reference_ambiguous');
    else {
      const qualified=payload('Reopen Northstar send samples for Tide Glass.',w);
      assert.deepEqual(Grounding.identityContext(qualified).linkedTasks[0].candidates.map(row=>row.id),[1]);
      const result=proposal();assert.equal(Grounding.guardIdentity(qualified,result),result);
      assert.deepEqual(Plan.prepare(w,result.crmAction,{nonce:'qualified'}).taskPatches.map(patch=>patch.after.id),['todo_samples']);
    }
  }
});

test('linked display titles and partial task names never grant implicit record identity',()=>{
  const w=fixture();w.todoCards[0].nextAction='Northstar';
  for(const command of ['Set Northstar owner to Sam.','Reopen Northstar.',
    'Update Northstar send samples account owner to Sam.']){
    assert.match(Grounding.guardIdentity(payload(command,w),proposal()).crmAction.question,/Which record did you mean by "northstar"/,command);
  }
  const p=payload('Reopen the task named Northstar for Tide Glass.',w);
  assert.deepEqual(Grounding.identityContext(p).references.map(ref=>ref.candidates.map(row=>row.id)),[[1]]);
  w.records[0].f_deal='Northstar Copper Books';w.todoCards[0].nextAction='Call';
  assert.match(Grounding.guardIdentity(payload('Move Northstar task to tomorrow.',w),proposal()).crmAction.question,/Which record did you mean by "northstar"/);
});

test('creation titles keep their existing shielding without hiding an ambiguous source',()=>{
  const p=payload('Create a task for Northstar named Northstar send samples.');
  assert.match(Grounding.guardIdentity(p,proposal()).crmAction.question,/Which record did you mean by "northstar"/);
  const exact=payload('Create a task for Tide Glass named Northstar send samples.');
  assert.deepEqual(Grounding.identityContext(exact).references.map(ref=>ref.candidates.map(row=>row.id)),[[1]]);
});

test('a linked-record clarification reply preserves the original task reference and supplied changes',()=>{
  const w=fixture();w.records[0].f_deal='Atlas East';w.records[1].f_deal='Atlas West';
  const p=payload('Reopen Northstar send samples for Atlas and remove its due date. Keep its notes.',w);
  const question=Grounding.guardIdentity(p,proposal()).crmAction;
  p.pendingClarification={originalCommand:p.userCommand,question:question.question,options:question.clarificationOptions};p.userCommand='1';
  const context=Grounding.identityContext(p),result=proposal();
  assert.equal(context.selectedId,1);assert.deepEqual(taskRef(context).candidates.map(card=>card.id),['todo_samples']);
  assert.equal(Grounding.guardIdentity(p,result),result);
});

test('task candidate IDs from grounding use the ordinary validated task selection path',()=>{
  const w=fixture(),p=payload('Reopen Northstar send samples for Tide Glass.',w),context=Grounding.identityContext(p);
  assert.deepEqual(TaskActions.select(w.todoCards,w.records,w.tableSchema,{source:'ids',ids:taskRef(context).candidates.map(card=>card.id),focusId:null,conditions:[]})
    .map(card=>card.id),['todo_samples']);
});

test('short independent task edits never inherit an earlier record clarification',()=>{
  const original=payload('Set Northstar owner to Alex.'),question=Grounding.guardIdentity(original,proposal()).crmAction;
  for(const command of ['Reopen Northstar send samples.','Complete Northstar send samples.',
    'Reschedule Northstar send samples to Friday.','Clear Northstar send samples due date.']){
    const p=payload(command);p.pendingClarification={originalCommand:original.userCommand,question:question.question,options:question.clarificationOptions};
    const context=Grounding.identityContext(p),result=proposal();
    assert.deepEqual(context.references,[],command);assert.deepEqual(context.selectedIds,[]);
    assert.deepEqual(taskRef(context).candidates.map(card=>card.id),['todo_samples']);
    assert.equal(Grounding.guardIdentity(p,result),result);
  }
});

test('full record names inside saved task text do not create links; independent occurrences still do',()=>{
  const w=fixture({taskName:'Compare Northstar Copper Books and Northstar Silver Cafe'});
  const command='Reopen Compare Northstar Copper Books and Northstar Silver Cafe for Tide Glass.';
  assert.deepEqual(Grounding.identityContext(payload(command,w)).references.map(ref=>ref.candidates.map(row=>row.id)),[[1]]);
  const p=payload(command+' Set Northstar Copper Books owner to Alex.',w);
  assert.deepEqual(Grounding.identityContext(p).references.map(ref=>ref.candidates.map(row=>row.id)),[[1],[3]]);
});

test('saved task masking normalizes punctuation and Unicode without relying on a specific prefix',()=>{
  for(const prefix of ['North Ridge','Sequoia42','Caf\u00e9']){
    const w=fixture({prefix,taskName:prefix+' / send samples'}),p=payload('Reopen "'+prefix.toUpperCase()+' / send samples" for Tide Glass.',w);
    assert.deepEqual(Grounding.identityContext(p).references.map(ref=>ref.candidates.map(row=>row.id)),[[1]],prefix);
    const result=proposal();assert.equal(Grounding.guardIdentity(p,result),result);
  }
});

test('unrecognized task syntax, cross-clause aliases and oversized input retain conservative primary references',()=>{
  for(const command of ['Regarding Northstar send samples, remove its due date.',
    'Reopen Northstar; send samples for Tide Glass.',
    'Reopen Northstar send samples for Tide Glass. '+'.'.repeat(17000)]){
    const p=payload(command);
    assert(Grounding.identityContext(p).references.some(ref=>ref.phrase==='northstar'&&ref.candidates.length===4),command);
    assert.equal(Grounding.guardIdentity(p,proposal()).crmAction.action,'clarify');
  }
});
