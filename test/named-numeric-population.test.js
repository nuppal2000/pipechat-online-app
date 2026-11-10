'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Typed=require('../lib/scoped-table-request'),Review=require('../lib/action-review');
const Plan=require('../public/workspace-plan'),Core=require('../public/pipeline-core'),F=require('./fixtures/workspace-plans.cjs');
const names=['QA1105 Cedar Consulting','QA1105 Cedar North','QA1105 Maple Retail'];
const original='Add a number field called Probability percent. Set it to 50 for QA1105 Cedar Consulting, 80 for QA1105 Cedar North, and 25 for QA1105 Maple Retail.';
const request=(name,names,values)=>({action:'scoped_table_request',title:'Add and populate a numeric column',source:'all',where:[],
  operation:{kind:'add_named_numbers',name,entries:names.map((recordName,i)=>({recordName,value:values[i]}))}});
function workspace(labels=names){
  const w=F.workspace();w.records=w.records.slice(0,4).map((row,i)=>({...row,f_deal:labels[i]??'Other'}));return w;
}
const prepare=(w,a)=>Plan.prepare(w,a,{nonce:'client',today:'2026-11-10',visibleIds:[4]});

test('model contract offers literal named numeric assignments even without an existing numeric column',()=>{
  const w=workspace();w.tableSchema.fields=w.tableSchema.fields.filter(f=>!['currency','number'].includes(f.type));
  const plan=Plan.responseSchema(Core.create(w.tableSchema)),shell={properties:{crmAction:{anyOf:[plan]}}};
  const shorthand=Review.modelSchema(shell).properties.crmAction.anyOf.find(b=>b.properties.action.enum.includes('scoped_table_request'));
  const branch=shorthand.properties.operation.anyOf.find(b=>b.properties.kind.enum.includes('add_named_numbers'));
  assert.ok(branch);assert.deepEqual(branch.required.toSorted(),['entries','kind','name']);
  assert.equal(branch.properties.entries.items.properties.value.type,'number');
});

for(const [prompt,label,labels,values] of [
  [original,'Probability percent',names,[50,80,25]],
  ['Record the signed variances against the named jobs.','Signed variance',['Phase 2','Phase 20','Phase 200'],[-2.125,0,99.5]]
])test(prompt,()=>{
  const w=workspace(labels),before=structuredClone(w),action=Typed.compile(request(label,labels,values));
  const pipeline={...w,visibleIds:[4],currentDate:'2026-11-10'},result={crmAction:action};
  const e=Review.evidence({pipeline},result),p=prepare(w,action);
  assert.equal(action.action,'workspace_plan');assert.equal(e.lifecycle.requiresConfirmation,true);assert.equal(e.lifecycle.writesApplied,0);
  assert.deepEqual(e.addedFields.map(({name,type})=>({name,type})),[{name:label,type:'number'}]);
  assert.deepEqual(e.patches.map(row=>[row.id,row.changes[0].after]),values.map((v,i)=>[i+1,v]));
  const requirements=action.goals.map(g=>({...g,evidenceKind:'compiled_action',requiredOutputs:[],satisfied:true}));
  assert.equal(Review.validateReview({requirements,issues:[]},result,{pipeline,computed:e}).ok,true);
  assert.deepEqual(p.next.records.map(r=>r[p.addedFields[0].id]),[...values,null]);assert.deepEqual(w,before);
});

test('the maximum batch fits plan limits and resolves a renamed primary column rather than guessing a sales field',()=>{
  const w=workspace(),labels=Array.from({length:14},(_,i)=>'Job '+(i+1)),values=labels.map((_,i)=>i);
  w.tableSchema.fields=w.tableSchema.fields.map(f=>f.role==='primary'?{...f,id:'f_job',name:'Job title'}:f);
  const base={...w.records[0]};delete base.f_deal;
  w.records=labels.map((name,i)=>({...base,id:i+1,f_job:name}));
  const p=prepare(w,Typed.compile(request('Lead time',labels.map(n=>n.toUpperCase()),values)));
  assert.deepEqual(p.next.records.map(r=>r[p.addedFields[0].id]),values);
});

test('missing and ambiguous names reject the whole plan during both server review and client re-preparation',()=>{
  const a=F.plan([{id:'field',op:'add_field',label:'Add number column',name:'Variance',type:'number',options:[]},
    {...F.select('one'),source:{kind:'exact_primary',name:names[0]}},F.update('set_one','one','@field',0)]);
  assert.deepEqual(prepare(workspace(),a).patches.map(r=>r.id),[1]);
  for(const [labels,error] of [[['Different'],/no exact match/i],[[names[0],names[0].toUpperCase()],/more than one exact match/i]]){
    const w=workspace(labels),before=structuredClone(w);
    assert.throws(()=>prepare(w,a),error);
    assert.throws(()=>Review.evidence({pipeline:{...w,visibleIds:[],currentDate:'2026-11-10'}},{crmAction:a}),error);assert.deepEqual(w,before);
  }
});

test('translation rejects repeated targets, malformed numbers, conflicting scopes and oversized batches',()=>{
  for(const mutate of [r=>r.operation.entries[1].recordName=' '+names[0].toLowerCase(),r=>r.operation.entries[0].recordName=' ',
    r=>r.operation.entries[0].value='50%',r=>r.operation.entries[0].value=false,r=>r.operation.entries[0].value=1e13,
    r=>r.operation.entries=[],r=>r.operation.entries=Array.from({length:15},(_,i)=>({recordName:'Job '+i,value:i})),
    r=>r.source='visible',r=>r.where=[[F.where('f_owner','equals','Alex')]]]){
    const r=request('Score',names,[1,2,3]);mutate(r);assert.throws(()=>Typed.compile(r));
  }
});
