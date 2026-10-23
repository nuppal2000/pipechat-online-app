'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Inspector=require('../public/inspector-core'),Review=require('../lib/action-review'),Grounding=require('../lib/ai-grounding');
const F=require('./fixtures/workspace-plans.cjs');
const note=text=>JSON.stringify({pipechatHistory:1,type:'note',id:'note1',at:'2026-10-23T12:00:00.000Z',actor:'QA',text});
const history=(id,selection)=>({op:'read_history',id,label:id,selection,kind:'all',from:null,to:null,limit:100});
function payloadFor(w){
  const payload={userCommand:'Read saved history',pipeline:{currentDate:'2026-10-23',timezone:'America/New_York'}};
  return Grounding.prepare(payload,{deals:w.records,tableSchema:w.tableSchema,customFields:w.customFields,todoCards:w.todoCards,updatedAt:'v1'},{name:'QA'},null);
}
function render(parts,extra={}){
  return Review.renderAnswer({}, {crmAction:{action:'workspace_plan'}},
    {mutates:false,answers:parts,calculations:[],addedFields:[],patches:[],addedCards:[],taskPatches:[],...extra});
}

test('a storage-valid oversized activity is clipped without hiding later entries or changing history',()=>{
  const rows=[{id:43,name:'QA Acorn Supplies',history:[
    '2026-10-23T12:00:00.000Z | QA: Notes changed from "'+'x'.repeat(12000)+'" to "'+'y'.repeat(12000)+'".',
    '2026-10-22T12:00:00.000Z | QA: Short older activity.'
  ]}];
  const before=structuredClone(rows),result=Inspector.query(rows,'name');
  assert(rows[0].history[0].length>24000&&rows[0].history[0].length<=32768);
  assert.equal(result.total,2);assert.equal(result.entries.length,2);assert.equal(result.omitted,0);assert.equal(result.truncated,1);
  assert.equal(result.entries[0].truncated,true);assert(result.entries[0].text.length<=6000);
  assert.match(result.entries[0].text,/truncated by the per-entry limit/);assert.match(result.answer,/Short older activity/);
  assert.match(result.answer,/Open the record history to inspect the full entries/);assert.deepEqual(rows,before);
});

test('long names and noncanonical timestamps cannot exhaust the per-entry budget',()=>{
  const rows=[{id:43,name:'A'.repeat(12000),history:['2026-10-23T12:00:00.'+'0'.repeat(200)+'Z | Short activity.']}];
  const result=Inspector.query(rows,'name');
  assert.equal(result.entries.length,1);assert.equal(result.entries[0].recordId,43);
  assert(result.entries[0].name.length<=400);assert.equal(result.entries[0].at,'2026-10-23T12:00:00.000Z');
  assert.match(result.answer,/#43/);assert.match(result.answer,/Short activity/);assert.equal(result.truncated,1);
});

test('per-entry clipping preserves Unicode and still discloses whole-entry omissions',()=>{
  const symbol=String.fromCodePoint(0x1f680);
  const rows=[{id:43,name:symbol.repeat(6000),history:Array.from({length:8},()=>note(symbol.repeat(16000)))}];
  const result=Inspector.query(rows,'name');
  assert(result.entries.length>0&&result.entries.length<8);assert.equal(result.omitted,8-result.entries.length);
  assert.equal(result.truncated,result.entries.length);assert(result.answer.length<25000);assert(result.answer.isWellFormed());
  for(const entry of result.entries){assert(entry.name.isWellFormed());assert(entry.text.isWellFormed());}
  assert.match(result.answer,new RegExp(`Showing ${result.entries.length} of 8`));
});

test('two bounded history results fit the durable cap with both results and limit disclosures retained',()=>{
  const w=F.workspace();
  for(const row of w.records.slice(0,2))row.history=Array.from({length:8},()=>note('x'.repeat(5900)));
  const payload=payloadFor(w),before=JSON.stringify(w);
  const action=F.plan([
    F.select('one',[[F.where('f_deal','equals',w.records[0].f_deal)]]),history('first_history','one'),
    F.select('two',[[F.where('f_deal','equals',w.records[1].f_deal)]]),history('second_history','two')
  ]);
  const result={crmAction:action},computed=Review.evidence(payload,result),original=structuredClone(computed);
  assert(computed.answers.join('\n\n').length>32000);
  const answer=Review.renderAnswer(payload,result,computed);
  assert(answer.length<=30000);assert.match(answer,/Combined response limited to 30,000 characters/);
  for(const row of w.records.slice(0,2))assert(answer.includes(row.f_deal));
  assert.equal((answer.match(/Showing 4 of 8/g)||[]).length,2);
  assert.equal((answer.match(/characters omitted by the combined response limit/g)||[]).length,2);
  assert.equal((answer.match(/No changes were made/g)||[]).length,2);
  assert.equal(answer,Review.renderAnswer(payload,result,computed));assert.deepEqual(computed,original);assert.equal(JSON.stringify(w),before);
});

test('a maximum-length plan keeps every requested history result represented',()=>{
  const w=F.workspace();w.records[0].history=Array.from({length:8},()=>note('x'.repeat(5900)));
  const steps=[F.select('one',[[F.where('f_deal','equals',w.records[0].f_deal)]])];
  for(let i=0;i<29;i++)steps.push(history('history_'+i,'one'));
  const action={...F.plan(steps),goals:[{description:'Read each requested result',stepIds:steps.map(step=>step.id)}]};
  const payload=payloadFor(w),result={crmAction:action},computed=Review.evidence(payload,result);
  const answer=Review.renderAnswer(payload,result,computed);
  assert.equal(computed.answers.length,29);assert(answer.length<=30000);
  assert.equal((answer.match(/Saved history: 8 entries/g)||[]).length,29);
  assert.equal((answer.match(/Showing 4 of 8/g)||[]).length,29);
  for(let i=1;i<=29;i++)assert(answer.includes(`[Section ${i}:`));
});

test('small answers and ordinary mutation previews remain byte-for-byte unchanged',()=>{
  assert.equal(render(['First answer','Second answer']),'First answer\n\nSecond answer');
  assert.equal(render([]),'No table or task changes are needed. No changes were saved.');
  assert.equal(render(['x'.repeat(30000)]),'x'.repeat(30000));
  assert.equal(render(['History answer'],{mutates:true,calculations:['Date calculation']}),
    'Review the complete plan: 0 new columns, 0 changed records, 0 new tasks and 0 updated tasks. Nothing is saved until you confirm the entire plan.\n\nDate calculation\n\nCalculated answers for this proposed plan (including any proposed changes):\n\nHistory answer');
});

test('short results retain their full text beside long Unicode results in a mutation preview',()=>{
  const symbol=String.fromCodePoint(0x1f680),long='Long result starts\n'+symbol.repeat(18000)+'\nLong result ends';
  const answer=render([long,'Short result retained in full'],{mutates:true,calculations:['Date calculation retained in full']});
  assert(answer.length<=30000);assert(answer.isWellFormed());assert.match(answer,/Nothing is saved until you confirm the entire plan/);
  for(const text of ['Long result starts','Long result ends','Short result retained in full','Date calculation retained in full'])assert(answer.includes(text));
  assert.match(answer,/characters omitted by the combined response limit/);
});

test('many distinct date calculations cannot overflow the answer cap or erase the requested read',()=>{
  const calculations=Array.from({length:1160},(_,i)=>`Date calculation ${i}: `+'x'.repeat(100));
  const answer=render(['Requested history result'],{mutates:true,calculations});
  assert(answer.length<=30000);assert.match(answer,/Requested history result/);
  assert.match(answer,/Nothing is saved until you confirm the entire plan/);
  assert.match(answer,/Date calculation 0:/);assert.match(answer,/Date calculation 1159:/);
  assert.match(answer,/shortened/);assert.match(answer,/Request a result separately for more detail/);
});
