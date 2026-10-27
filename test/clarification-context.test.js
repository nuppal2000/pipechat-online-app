const test=require('node:test'),assert=require('node:assert/strict');
const C=require('../lib/clarification-context');
const pending={originalCommand:'Create a follow-up task for 18 Maple Street',question:'For the new To Do linked to 18 Maple Street, what due date should I use? (a) 2026-10-01 (match Follow-Up Date), (b) leave blank, or (c) another date YYYY-MM-DD)'};

test('both offered records resolves the complete conditional request for arbitrary saved identities',()=>{
  for(const [name,ids] of [['Juniper',[1,2]],['Cobalt',[17,43]],['Red Maple',[91,7]]])for(const legacy of [false,true]){
    const options=ids.map((id,i)=>({key:String(i+1),label:`${name} ${i?'East':'Labs'} [record #${id}]`}));
    const p={originalCommand:`For ${name}, set Priority to High at 15000 or more and Medium below that.`,
      question:`Which record ${name}?\n`+options.map(o=>`${o.key}) ${o.label}`).join('\n'),...(legacy?{}:{options})};
    const before=structuredClone(p);
    for(const reply of [`Both ${name} deals.`,'both','Both.','both of them','both of these records',
      'two listed records','2 accounts','the two offered accounts',`Two ${name} accounts, please.`]){
      const result=C.resolve(p,reply);assert(result,reply);
      assert.deepEqual(result.selectedRecordIds,ids,reply);assert.deepEqual(result.selectedKeys,['1','2']);
      assert.equal(result.originalCommand,p.originalCommand);assert.match(result.selectedMeaning,/Preserve the original conditions and requested values/);
      assert.equal(result.selectedKey,undefined);
    }
    assert.deepEqual(p,before);
    for(const reply of ['2','(2)','option 2','choice 2.']){
      const result=C.resolve(p,reply);assert.equal(result.selectedKey,'2',reply);assert.equal(result.selectedRecordIds,undefined,reply);
    }
  }
});

test('counted plural replies bind the full offered set only when the explicit count matches',()=>{
  const counts=['two','three','four','five','six','seven','eight','nine','ten','eleven','twelve'];
  for(let count=2;count<=12;count++){
    const options=Array.from({length:count},(_,i)=>({key:String(i+1),label:`Cobalt Branch ${i+1} [record #${100+i*7}]`}));
    const p={originalCommand:'Update Cobalt by the previously supplied thresholds.',question:'Which record?',options};
    for(const reply of [`${count} listed records`,`The ${counts[count-2]} offered accounts.`,`${counts[count-2]} of them`]){
      assert.deepEqual(C.resolve(p,reply)?.selectedRecordIds,options.map(o=>Number(/#(\d+)/.exec(o.label)[1])),reply);
    }
    assert.equal(C.resolve(p,`${count+1} listed records`),null);
    if(count!==2)assert.equal(C.resolve(p,'both'),null);
  }
});

test('the offered plural reply reaches identity grounding as the complete conditional update',()=>{
  const G=require('../lib/ai-grounding');
  for(const name of ['Juniper','Red Maple']){
    const originalCommand=`For ${name}, set Priority to High at 15000 or more and Medium below that.`;
    const records=[{id:17,name:`${name} Labs`},{id:43,name:`${name} East`}];
    const p={userCommand:`Both ${name} deals.`,pipeline:{primaryField:'name',records,todoView:[]},
      pendingClarification:{originalCommand,question:`Which record ${name}?`,
        options:records.map((row,i)=>({key:String(i+1),label:`${row.name} [record #${row.id}]`}))}};
    const answer=C.resolve(p.pendingClarification,p.userCommand);
    assert.equal(answer.originalCommand,originalCommand);assert.deepEqual(answer.selectedRecordIds,[17,43]);
    assert.deepEqual(G.identityContext(p).selectedIds,[17,43]);
    const result={crmAction:{action:'workspace_plan',steps:[{op:'select_records'},{op:'update_records'}]}};
    assert.equal(G.guardIdentity(p,result),result);
  }
});

test('plural selections reject exclusions, narrower identities, unrelated prose and non-record menus',()=>{
  const p={originalCommand:'Update Juniper priority.',question:'Which record?',options:[
    {key:'1',label:'Juniper Labs [record #1]'},{key:'2',label:'Juniper East [record #2]'}]};
  for(const reply of ['both except Labs','both but the first','both excluding East','both not Labs',
    'both only Labs','the two records except Labs','two first records','Both Juniper Labs deals.',
    'three Juniper deals','Both deals and show the total.','Both I need now are unrelated tasks.',
    'All I need now is the current record count.','the two','2 please'])assert.equal(C.resolve(p,reply),null,reply);
  const other={originalCommand:'Set the priority.',question:'Which priority?',options:[{key:'1',label:'High'},{key:'2',label:'Medium'}]};
  for(const reply of ['both','two listed options','2 options'])assert.equal(C.resolve(other,reply),null,reply);
});
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
test('yes resolves the concrete Summit suggestion, including the optional contact, for review only',()=>{
  const p={originalCommand:'Spoke to Mike from summit insurance partners, quoted $25K for Product A, follow up in two weeks.',question:'Should I update Summit Insurance Partners with Deal Value (USD) = 25000 and Next Follow-Up Date = 2026-10-18? If you also want Mike stored, should I put him in Primary Contact?'};
  for(const answer of ['yes','Yes please.','go ahead','yes to both']){
    const result=C.resolve(p,answer);assert.equal(result.selectedKey,'yes');assert.equal(result.originalCommand,p.originalCommand);assert.match(result.selectedMeaning,/not authorization to save/);
  }
  assert.equal(C.resolve({question:'Which Atlas record should I update?'},'yes'),null);
  assert.equal(C.resolve({question:'Should I use Sarah or Neelam?'},'yes'),null);
  assert.equal(C.resolve({question:'Should I update this?',candidates:[{id:1},{id:2}]},'yes'),null);
});
test('repeat detection covers current and earlier answered questions without suppressing a different detail',()=>{
  const p={question:'Should I set Acme owner to Sarah?',answers:[{question:'What due date should the legal review task have?',answer:'Tomorrow'}]};
  assert(C.repeats(p,{crmAction:{action:'clarify',question:'Should I set Acme owner to Sarah?!'}}));
  assert(C.repeats(p,{crmAction:{action:'clarify',question:'What due date should the legal review task have?'}}));
  assert(!C.repeats(p,{crmAction:{action:'clarify',question:'Which of the two Atlas records do you mean?'}}));
  assert(!C.sameQuestion('Should I use 2026-10-18 for the date?','Should I use 2026-10-19 for the date?'));
  assert(!C.repeats(null,{crmAction:{action:'clarify',question:p.question}}));
});
