'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Review=require('../lib/action-review');
test('planner and independent reviewer share identical specialized action boundaries',()=>{
  assert(Review.familyInstructions.length>0);
  assert(Review.compilerInstructions.endsWith(Review.familyInstructions));
  assert(Review.instructions.endsWith(Review.familyInstructions));
  for(const text of ['create_workflow','business_plan','primary-table column','pendingAction','SAME family','constraints or permissions'])assert(Review.familyInstructions.includes(text));
  assert.doesNotMatch(Review.familyInstructions,/Northstar|Maya Chen|America\/New_York|Proposal Sent/);
});
test('shared routing guidance does not weaken outcome coverage',()=>{
  const result={crmAction:{action:'create_workflow'}};
  assert.equal(Review.validateReview({requirements:[{description:'Keep the original trigger',evidenceKind:'compiled_action',stepIds:['root'],satisfied:true},{description:'Apply the corrected timezone',evidenceKind:'compiled_action',stepIds:[],satisfied:false}],issues:[],clarificationQuestion:null},result).ok,false);
  assert.equal(Review.validateReview({requirements:[{description:'Typed contact and both links',evidenceKind:'compiled_action',stepIds:['root'],satisfied:true}],issues:[],clarificationQuestion:null},{crmAction:{action:'business_plan'}}).ok,true);
});
