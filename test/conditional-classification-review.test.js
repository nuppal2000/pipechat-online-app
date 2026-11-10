'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Scoped=require('../lib/scoped-table-request'),Review=require('../lib/action-review');
const Plan=require('../public/workspace-plan'),Core=require('../public/pipeline-core'),F=require('./fixtures/workspace-plans.cjs');
const original='For all QA1105 deals, set Priority to High if the deal value is at least $15,000, otherwise Medium. Leave records with an unknown deal value unchanged.';
const variant='Within the QA1105 cohort classify known deal amounts into Priority: 15000 and above High, below 15000 Medium; make no assignment for a missing amount.';
const scope=F.where('f_deal','starts_with','QA1105');
const operation={kind:'classify_number',numberField:'f_value',operator:'gte',threshold:15000,targetField:'f_priority',whenTrue:'High',otherwise:'Medium',whenBlank:'unchanged'};
const compact=(op=operation)=>({action:'scoped_table_request',title:'Classify priorities',source:'all',where:[[scope]],operation:op});
function workspace(){
  const w=F.workspace();
  w.records=[null,0,14999.99,15000,15000.01,'',15000,0].map((v,i)=>({...w.records[0],id:i+1,
    f_deal:(i<6?'QA1105 ':'Not QA1105 ')+i,f_value:v,f_priority:i===4?'High':'Low',f_notes:'Keep '+i}));
  return {...w,visibleIds:[7],conversationFocus:{kind:'table',ids:[8]},workspaceVersion:'v1',currentDate:'2026-11-10'};
}
function native(){
  const branch=(id,op)=>F.select(id,[[scope,F.where('f_value',op,15000)]]);
  return F.plan([branch('upper','gte'),branch('lower','lt'),F.update('a','upper','f_priority','High'),F.update('b','lower','f_priority','Medium')]);
}
const proof={description:'Leave records outside the scoped known values unchanged',satisfied:true,evidenceKind:'constraint',
  stepIds:['unchanged:records:outside:known_values'],requiredOutputs:['unchanged_records']};
const check=(requirements,result,pipeline,computed,issues=[])=>Review.validateReview({requirements,issues},result,{pipeline,computed}).ok;

test('compact classification is available only with an existing numeric source field',()=>{
  const w=workspace(),branch=()=>Review.modelSchema({properties:{crmAction:{anyOf:[Plan.responseSchema(Core.create(w.tableSchema))]}}})
    .properties.crmAction.anyOf.find(b=>b.properties.action.enum.includes('scoped_table_request')).properties.operation.anyOf
    .find(b=>b.properties.kind.enum.includes('classify_number'));
  assert.deepEqual(branch().properties.numberField.enum,['f_value']);
  assert.deepEqual(branch().properties.whenBlank.enum,['unchanged']);
  w.tableSchema.fields=w.tableSchema.fields.filter(f=>f.id!=='f_value');assert.equal(branch(),undefined);
});

for(const [command,request] of [[original,compact],[variant,native]])test(command,()=>{
  const p=workspace(),before=structuredClone(p),action=Scoped.compile(request()),result={crmAction:action};
  const computed=Review.evidence({pipeline:p,userCommand:command},result);
  const known=computed.review.find(s=>s.id==='known_values');
  assert.deepEqual(known.records.map(r=>[r.id,r.value]),[[2,0],[3,14999.99],[4,15000],[5,15000.01]]);
  const reviewIds=Review.schemaFor(action,{pipeline:p,computed}).properties.requirements.items.properties.stepIds.items.enum;
  assert(reviewIds.includes(proof.stepIds[0]));
  assert(!check([{...proof,evidenceKind:'computed_read',stepIds:[known.id],requiredOutputs:['fields']}],result,p,computed));
  assert.deepEqual(computed.patches.map(r=>[r.id,r.changes]),[2,3,4].map(id=>[id,[{field:'Priority',before:'Low',after:id===4?'High':'Medium'}]]));
  assert.deepEqual(computed.effects,[]);assert.equal(computed.lifecycle.requiresConfirmation,true);assert.equal(computed.lifecycle.writesApplied,0);
  const writes=action.steps.filter(s=>s.op==='update_records').map(s=>({description:s.label,stepIds:[s.id],satisfied:true,evidenceKind:'compiled_action',requiredOutputs:[]}));
  assert(check([...writes,proof],result,p,computed));
  assert(!check([...writes,proof],result,p,computed,['Unexpected scope']),'a free-text objection still blocks');
  assert(!check([{...writes[0],satisfied:false},writes[1],proof],result,p,computed),'an unsatisfied branch still blocks');
  assert(!check([proof],result,p,structuredClone(computed)),'copied evidence has no authority');
  const next=Plan.prepare(p,action,{nonce:'client',visibleIds:p.visibleIds}).next;
  for(const [i,row] of next.records.entries()){
    assert.deepEqual(row,{...p.records[i],f_priority:['Low','Medium','Medium','High','High','Low','Low','Low'][i]});
  }
  assert.deepEqual(p,before);
  p.records[0].f_value=20000;assert(!check([proof],result,p,computed),'stale source no longer proves preservation');
});

test('each threshold comparison allocates equality exactly once, with zero a real boundary',()=>{
  const p=workspace();p.records.slice(0,6).forEach((r,i)=>r.f_value=[-1,0,1,null,'',null][i]);
  for(const [operator,high,low] of [['gte',[2,3],[1]],['gt',[3],[1,2]],['lt',[1],[2,3]],['lte',[1,2],[3]]]){
    const action=Scoped.compile(compact({...operation,threshold:0,operator}));
    const e=Review.evidence({pipeline:p},{crmAction:action}),ids=id=>e.review.find(s=>s.id===id).records.map(r=>r.id);
    assert.deepEqual(ids('match'),high);assert.deepEqual(ids('otherwise'),low);
    assert.deepEqual(ids('known_values'),[1,2,3]);assert(check([proof],{crmAction:action},p,e));
  }
});

test('an empty cohort or all unknown values never widens either branch; absence is a valid protected set',()=>{
  for(const state of ['empty','unknown','all known']){
    const p=workspace();for(const row of p.records){
      if(state==='empty')row.f_deal='Outside';else row.f_value=state==='unknown'?null:0;
    }
    const result={crmAction:Scoped.compile(compact())},e=Review.evidence({pipeline:p},result);
    const count=state==='all known'?6:0;
    assert.equal(e.review.find(s=>s.id==='known_values').records.length,count);
    assert.equal(e.patches.length,count);assert(check([proof],result,p,e));
  }
});

test('a later change to a protected field invalidates the final-state proof even if the priority cell is untouched',()=>{
  const p=workspace(),action=Scoped.compile(compact()),result={crmAction:action},before=Review.evidence({pipeline:p},result);
  action.steps.push(F.update('overwrite','population','f_notes','cleared'));action.goals.push({description:'Unexpected edit',stepIds:['overwrite']});
  const after=Review.evidence({pipeline:p},result);
  assert(!check([proof],result,p,after));assert(!check([proof],result,p,before));
});

test('the source-value witness is the exact union of both typed filters, not a truthiness or nonblank check',()=>{
  const p=workspace();p.records[5].f_value='unavailable';
  const a=native();a.steps[1].where[0].reverse();
  const result={crmAction:Scoped.compile(a)},e=Review.evidence({pipeline:p},result);
  assert.deepEqual(e.review.find(s=>s.id==='known_values').records.map(r=>r.id),[2,3,4,5]);
  assert(check([proof],result,p,e));assert(!e.patches.some(r=>r.id===6));
});

test('ordinary plans are not repaired from incomplete, asymmetric, extra-effect or colliding branches',()=>{
  for(const mutate of [a=>a.steps.pop(),a=>a.steps[1].where[0][1].operator='lte',a=>a.steps[0].where[0][1].value=15001,
    a=>a.steps[0].where[0][0]=F.where('f_deal','contains','QA1105'),a=>a.steps[1].source='visible',a=>a.steps[0].limit=1,
    a=>a.steps[3].assignments[0].field='f_notes',a=>a.steps[2].assignments.push({field:'f_owner',operation:'set',value:'Elsewhere'}),
    a=>a.steps.push(F.update('extra','lower','f_notes','overwrite')),a=>a.goals[0].stepIds.push('known_values'),
    a=>a.unmappedFacts=[{text:'More',source:'user',reason:'missing operation'}]]){
    const a=native();mutate(a);assert.equal(Scoped.compile(a),a);
  }
  const a=native();a.goals=a.goals.filter(g=>!g.stepIds.includes('b'));
  assert.throws(()=>Review.evidence({pipeline:workspace()},{crmAction:Scoped.compile(a)}),/Uncovered steps: b/);
});

test('partial or nonliteral compact assignments cannot compile',()=>{
  for(const change of [{otherwise:undefined},{otherwise:null},{whenTrue:{value:'High'}},{whenTrue:Infinity},
    {whenBlank:'Medium'},{threshold:'15000'},{targetField:''},{assignments:[{field:'f_notes',value:'overwrite'}]}]){
    assert.throws(()=>Scoped.compile(compact({...operation,...change})));
  }
  assert.throws(()=>Scoped.compile({...compact(),steps:[F.update('extra','population','f_notes','overwrite')]}));
});
