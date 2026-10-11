'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Diagnostic=require('../lib/compiler-diagnostic');
const Review=require('../lib/action-review');

test('compiler diagnostics classify private-label failures without printing payloads',()=>{
  const error=new Error('Step 2 (PRIVATE CUSTOMER): No task matches PRIVATE NOTE. Please check its task text and linked record; no cards were changed.');
  error.compilerStep='update_tasks';
  assert.deepEqual(Diagnostic.describe(error,{action:'workspace_plan',private:'SECRET'}),{action:'workspace_plan',operation:'update_tasks',reason:'task_reference_missing'});
  const output=Review.validationDiagnostic({stage:'evidence',action:{action:'workspace_plan',steps:['SECRET']},error});
  assert.equal(output.compiler.reason,'task_reference_missing');
  assert.doesNotMatch(JSON.stringify(output),/PRIVATE|SECRET|matches|NOTE/);
});
test('unknown error properties and action names never enter logs',()=>{
  const output=Diagnostic.describe({name:'SECRET',message:'PRIVATE',compilerStep:'SECRET',code:'TOKEN',stack:'PASSWORD'},{action:'PRIVATE'});
  assert.deepEqual(output,{action:'other',operation:null,reason:'unclassified'});
  assert.deepEqual(Diagnostic.describe(new TypeError('PRIVATE'),null),{action:'none',operation:null,reason:'runtime_typeerror'});
});
test('scope, task collision, and numeric-field failures use independent closed codes',()=>{
  for(const [message,reason] of [
    ['Select records before using that selection in another step.','selection_dependency'],
    ['Two edits target the same card field dueDate on task PRIVATE.','task_write_conflict'],
    ['Choose a numeric field for calculations.','numeric_field_required'],
    ['A step refers to an unavailable field. Create the field first.','field_unavailable']
  ])assert.equal(Diagnostic.describe(new Error(message),{action:'workspace_plan'}).reason,reason);
});
