'use strict';

const test=require('node:test'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const Review=require('../lib/action-review');
const {enrich}=require('../lib/action-journal-context');
const {buildActionEntry,validateReceipt,planInverse}=require('../lib/action-journal');

function saved(paths){
  return {receipt:validateReceipt({formatVersion:1,actionId:randomUUID(),requestId:randomUUID(),conversationId:null,
    planId:'a'.repeat(64),undoOf:null,beforeVersion:'v1',afterVersion:'v2',importReceipt:null}),
    createdAt:'2026-10-10T12:00:00Z',undoneBy:null,undoInvalidated:false,...(paths===undefined?{}:{paths})};
}
function pipeline(){
  return {tableSchema:null,customFields:[],workspaceVersion:'v2',primaryField:'project',
    fields:{project:'Project',priority:'Priority',owner:'Assigned to'},
    records:Array.from({length:9},(_,i)=>({id:i+1,project:`Current project ${i+1}`,priority:'High',owner:'Ravi'})),
    todoCards:[]};
}
function fixture(paths,p=pipeline(),entry=saved(paths)){
  const payload={userCommand:'Undo that saved change.',pipeline:{...p,recentActions:enrich([entry],p)}};
  const result={crmAction:{action:'undo_action',actionId:entry.receipt.actionId},
    assistantMessage:'Restored 7 records in the old cohort: Stale Company, Old Account. Priority is Low. Everything has been saved.',
    computedAnswer:'Untrusted model answer'};
  return {payload,result};
}
const render=f=>Review.renderAnswer(f.payload,f.result);

test('undo preview replaces wrong model cohort with nine saved record identities, not eighteen field paths',()=>{
  const p=pipeline(),paths=p.records.flatMap(row=>[['records',String(row.id),'priority'],['records',String(row.id),'owner']]);
  const f=fixture(paths,p),before=structuredClone(f),e=Review.evidence(f.payload,f.result),answer=Review.renderAnswer(f.payload,f.result,e);
  assert.equal(e.kind,'undo-preview');assert.equal(e.requiresInverseReview,true);assert.equal(e.mutates,true);
  assert.equal(e.savedAction.receipt.actionId,f.result.crmAction.actionId);
  assert.match(answer,/Showing 18 of 18 saved action paths/);assert.match(answer,/Distinct records in the listed paths: 9\./);
  for(const row of p.records)assert(answer.includes(JSON.stringify(row.project)));
  assert.match(answer,/"Priority"/);assert.match(answer,/"Assigned to"/);
  assert.doesNotMatch(answer,/Stale Company|Old Account|Restored 7|Priority is Low|Everything has been saved|Untrusted model answer/);
  assert.match(answer,/Nothing has been undone or saved/);assert.match(answer,/Review the durable inverse and confirm/);
  assert.match(answer,/current-version and conflict checks must still pass/);
  assert.equal(e.lifecycle.phase,'proposed');assert.equal(e.lifecycle.requiresConfirmation,true);
  assert.equal(e.lifecycle.executed,false);assert.equal(e.lifecycle.writesApplied,0);
  assert.equal(render(f),answer);assert.deepEqual(f,before);
});

test('truncated saved paths report sample counts without inventing complete record or field coverage',()=>{
  const p=pipeline();p.records=Array.from({length:110},(_,i)=>({id:i+1,project:`Visible ${i+1}`}));
  const paths=p.records.flatMap(row=>[['records',String(row.id),'priority'],['records',String(row.id),'owner']]);
  const f=fixture(paths,p),answer=render(f);
  assert.equal(f.payload.pipeline.recentActions[0].omittedPathCount,120);
  assert.match(answer,/Showing 100 of 220 saved action paths/);
  assert.match(answer,/partial list, not the complete affected set \(120 paths not shown\)/);
  assert.match(answer,/Distinct records in the listed paths: 50\./);
  assert(answer.includes('"Visible 50"'));assert(!answer.includes('"Visible 51"'));
  assert.doesNotMatch(answer,/Distinct records in the listed paths: (100|110|220)\./);
});

test('renamed and unavailable identities use current authorized labels or stable IDs, not aliases or deletion guesses',()=>{
  const p=pipeline();p.records[0].project='Renamed project';p.fields.priority='Urgency';
  p.records[0].account='Historical alias';p.records[1].project='';p.records[1].account='Blank-name fallback';
  delete p.fields.owner;p.records[0].owner='Hidden old owner';
  const answer=render(fixture([['records','1','priority'],['records','1','owner'],['records','2'],['records','99','removed']],p));
  assert(answer.includes('Record #1 ("Renamed project") / Field "priority" ("Urgency")'));
  assert(answer.includes('Field "owner" (current label unavailable)'));
  assert(answer.includes('Record #2 (current name unavailable)'));
  assert(answer.includes('Record #99 (current name unavailable) / Field "removed" (current label unavailable)'));
  assert.doesNotMatch(answer,/Historical alias|Blank-name fallback|Hidden old owner|"Priority"|deleted|restored/);
});

test('generic undo paths cover tasks, schema, order, workflows and unknown collections without guessed operations',()=>{
  const p=pipeline();p.todoCards=[{id:'todo_review',recordId:null,customTitle:'Current review',status:'Done'}];
  const paths=[['tasks','todo_review','dueDate'],['tasks','todo_missing'],['schema','workspace','tableSchema'],
    ['schema','workspace','customFields'],['order','workspace','records'],['order','workspace','tasks'],
    ['workflows','workflow_one'],['future','exact-id','exact-field']];
  const answer=render(fixture(paths,p));
  assert.match(answer,/Distinct tasks in the listed paths: 2\./);
  for(const text of ['Task "todo_review" ("Current review") / Field "dueDate" ("Due date")',
    'Task "todo_missing" (current title unavailable)','Workspace schema: "tableSchema"','Workspace schema: "customFields"',
    'Workspace order: "records"','Workspace order: "tasks"','Workflow "workflow_one"','["future","exact-id","exact-field"]'])assert(answer.includes(text),text);
  assert.doesNotMatch(answer,/Distinct records|deleted|restored|renamed|Done/);
});

test('missing paths stay unknown and empty paths never claim that nothing changed',()=>{
  const missing=render(fixture(undefined));
  assert.match(missing,/Showing 0 available saved action paths\. The complete affected set is unknown/);
  assert.doesNotMatch(missing,/0 of 0|Distinct records|no changes are needed/i);
  const empty=render(fixture([]));
  assert.match(empty,/Showing 0 of 0 saved action paths/);
  assert.match(empty,/Review the durable inverse and confirm/);
  assert.doesNotMatch(empty,/no changes are needed|nothing changed/i);
});

test('undecorated and mismatched path context never borrows names from other paths or model prose',()=>{
  const f=fixture([['records','1','priority']]),action=f.payload.pipeline.recentActions[0];
  delete action.pathCount;delete action.omittedPathCount;delete action.pathContext;
  assert.match(render(f),/complete affected set is unknown/);
  assert(render(f).includes('["records","1","priority"]'));
  action.pathContext=[{path:['records','2','priority'],kind:'record',currentName:'Wrong path name'}];
  assert.doesNotMatch(render(f),/Wrong path name|Stale Company/);
});

test('long current labels keep the durable answer bounded and disclose any additional display truncation',()=>{
  const p=pipeline();p.fields.priority='F'.repeat(240);
  p.records=Array.from({length:100},(_,i)=>({id:i+1,project:'N'.repeat(240)}));
  const f=fixture(p.records.map(row=>['records',String(row.id),'priority']),p),answer=render(f);
  const shown=Number(answer.match(/Showing (\d+) of 100 saved action paths/)[1]);
  assert(shown>0&&shown<100);assert(answer.length<32000);
  assert(answer.includes(`partial list, not the complete affected set (${100-shown} paths not shown)`));
  assert(answer.includes(`Distinct records in the listed paths: ${shown}.`));
});

test('unavailable saved actions and invalid computed evidence still fail instead of falling back to prose',()=>{
  for(const overrides of [{undoneBy:randomUUID()},{undoInvalidated:true}]){
    const f=fixture([['records','1','priority']]);Object.assign(f.payload.pipeline.recentActions[0],overrides);
    assert.throws(()=>render(f),/Choose an eligible saved action/);
  }
  const f=fixture([]);f.result.crmAction.actionId=randomUUID();
  assert.throws(()=>render(f),/Choose an eligible saved action/);
  for(const computed of [{},{kind:'undo-preview',savedAction:saved([])}]){
    assert.throws(()=>Review.renderAnswer(f.payload,f.result,computed),/canonical undo preview is unavailable/);
  }
});

test('canonical undo remains compiled-action evidence, not permission to satisfy unrelated saved-data reads',()=>{
  const f=fixture([]);
  for(const evidenceKind of ['compiled_action','computed_read']){
    const approval={requirements:[{description:'Undo the saved action',evidenceKind,stepIds:['root'],satisfied:true}],issues:[],clarificationQuestion:null};
    assert.equal(Review.validateReview(approval,f.result).ok,evidenceKind==='compiled_action');
  }
});

test('canonical preview does not reconstruct inverses or bypass conflicts after independent edits',()=>{
  const p=pipeline(),before={updatedAt:'v1',deals:structuredClone(p.records),
    tableSchema:{status:'ready',fields:[{id:'priority',type:'text'}]},customFields:[],todoCards:[]};
  const after=structuredClone(before);after.updatedAt='v2';after.deals[0].priority='Low';
  const entry=buildActionEntry({actionId:randomUUID(),requestId:randomUUID(),before,after});
  const {changes,dependencies,...receipt}=entry;
  const current=structuredClone(after);current.updatedAt='v3';current.deals[0].owner='Independent edit';
  const f=fixture(changes.map(change=>change.path),{...p,records:current.deals},
    {...saved([]),receipt:validateReceipt({...receipt,importReceipt:null}),paths:changes.map(change=>change.path)});
  const original=structuredClone(current),answer=render(f),inverse=planInverse(entry,current);
  assert.equal(inverse.ok,true);assert.equal(inverse.snapshot.deals[0].priority,'High');
  assert.equal(inverse.snapshot.deals[0].owner,'Independent edit');assert.deepEqual(current,original);
  current.deals[0].priority='Conflicting edit';
  assert.equal(planInverse(entry,current).ok,false);assert.equal(render(f),answer);
  assert.doesNotMatch(answer,/High|Low|Independent edit|Conflicting edit/);
});
