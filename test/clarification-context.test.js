const test=require('node:test'),assert=require('node:assert/strict');
const C=require('../lib/clarification-context');
const pending={originalCommand:'Create a follow-up task for 18 Maple Street',question:'For the new To Do linked to 18 Maple Street, what due date should I use? (a) 2026-10-01 (match Follow-Up Date), (b) leave blank, or (c) another date YYYY-MM-DD)'};
test('original letter reply resolves to its date meaning without discarding the original task',()=>{
  for(const reply of ['a','A','(a)','option a','choice a.']){const selected=C.resolve(pending,reply);assert.equal(selected.selectedMeaning,'2026-10-01 (match Follow-Up Date)');assert.equal(selected.originalCommand,pending.originalCommand);}
  assert.equal(C.resolve(pending,'b').selectedMeaning,'leave blank');assert.match(C.resolve(pending,'c').selectedMeaning,/another date/);
});
test('numeric and structured choices work for arbitrary business questions and exact-label answers',()=>{
  const p={originalCommand:'Move the review task',question:'Which task?\n1. Client review\n2. Legal review\n3. Team review'};
  assert.equal(C.resolve(p,'2').selectedMeaning,'Legal review');assert.equal(C.resolve(p,'Legal review').selectedKey,'2');
  p.options=[{key:'a',label:'Leave date blank'},{key:'b',label:'2027-01-04'}];assert.equal(C.resolve(p,'b').selectedMeaning,'2027-01-04');
});
test('invalid, mixed, non-sequential or unknown replies are not guessed',()=>{
  for(const reply of ['d','a and b','1','yes','',null])assert.equal(C.resolve(pending,reply),null);
  for(const question of ['Date is 2026-10-01.','(a) First, (a) Second','(a) First, (c) Third','(1) One, (b) Two','1.25 dollars or 2.35 dollars'])assert.equal(C.resolve({question},'1'),null);
  assert.equal(C.resolve(null,'a'),null);
});
test('guidance leaves optional fields blank but does not guess required or ambiguous details',()=>{
  assert.match(C.instructions,/Missing OPTIONAL/);assert.match(C.instructions,/Do not repeat a question already answered/);assert.match(C.instructions,/Final confirmation still belongs to the app/);
});
