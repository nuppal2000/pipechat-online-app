'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Scoped=require('../lib/scoped-table-request'),Intent=require('../lib/conditional-classification-intent');
const Review=require('../lib/action-review'),Plan=require('../public/workspace-plan'),Core=require('../public/pipeline-core');
const F=require('./fixtures/workspace-plans.cjs');
const condition=(operator,value)=>({operator,value});
const rule=(value,...conditions)=>({conditions,value});
const rules=()=>[
  rule('High',condition('gte',5000)),
  rule('Medium',condition('gt',0),condition('lt',5000)),
  rule('Low',condition('equals',0))
];
function intent(extra={}){
  return {completeIntent:true,source:'all',where:[[F.where('f_deal','starts_with','Segment ')]],numberField:'f_value',
    operator:null,threshold:null,targetField:'f_priority',whenTrue:null,otherwise:null,whenBlank:'unchanged',
    rules:rules(),whenUnmatched:'unchanged',otherRequestedWork:false,ambiguity:false,...extra};
}
function plan(i=intent()){
  return Scoped.compile({action:'scoped_table_request',title:'Classify values',source:i.source,where:i.where,
    operation:{kind:'classify_number_rules',numberField:i.numberField,targetField:i.targetField,rules:i.rules,whenBlank:i.whenBlank,whenUnmatched:i.whenUnmatched}});
}
function pipeline(values=[11000,2400,0,null,-1,4999.99,5000,0.01,'','unknown']){
  const p={...F.workspace(),currentDate:'2026-11-13',workspaceVersion:'rules-v1',visibleIds:[1,2],conversationFocus:{kind:'table',ids:[1,2]}};
  p.records=[...values,11000].map((value,i)=>({...p.records[0],id:i+1,f_deal:(i<values.length?'Segment ':'Outside ')+(i+1),
    f_value:value,f_priority:'Low',f_notes:'Keep '+i}));
  return p;
}
const context=(action,p=pipeline())=>({pipeline:p,computed:Review.evidence({pipeline:p},{crmAction:action})});
const assess=(i,a,p=pipeline())=>Intent.assess(i,a,context(a,p));
const selection=(c,id)=>c.computed.review.find(s=>s.id===id).records.map(r=>r.id).sort((a,b)=>a-b);
function native(i=intent()){
  const steps=i.rules.flatMap((r,n)=>[F.select('rows_'+n,[[...i.where[0],...r.conditions.map(c=>F.where(i.numberField,c.operator,c.value))]]),
    F.update('set_'+n,'rows_'+n,i.targetField,r.value)]);
  return F.plan(steps);
}

test('three-way numeric classification preserves zero, unknowns, exterior values and unrelated records atomically',()=>{
  const i=intent(),a=plan(i),p=pipeline(),before=structuredClone(p),c=context(a,p);
  assert(Intent.eligible(a));assert(Intent.assess(i,a,c).ok);
  assert.deepEqual(selection(c,'population'),[1,2,3,4,5,6,7,8,9,10]);
  assert.deepEqual(selection(c,'known_values'),[1,2,3,6,7,8]);
  assert.deepEqual(selection(c,'branch_0'),[3]);
  assert.deepEqual(selection(c,'branch_1'),[2,6,8]);
  assert.deepEqual(selection(c,'branch_2'),[1,7]);
  const next=Plan.prepare(p,a,{nonce:'rules'}).next;
  const expected=['High','Medium','Low','Low','Low','Medium','High','Medium','Low','Low','Low'];
  assert.deepEqual(next.records,p.records.map((r,n)=>({...r,f_priority:expected[n]})));
  assert.equal(c.computed.lifecycle.requiresConfirmation,true);assert.equal(c.computed.lifecycle.writesApplied,0);
  assert.deepEqual(p,before);
  const result=Intent.assess(i,a,c);assert.equal(result.requested,5);assert.equal(result.compiled,5);
});

test('rule and conjunct order have no precedence; zero-first and descending requests compile identically',()=>{
  const i=intent(),a=plan(i);
  for(const ordered of [[i.rules[2],i.rules[0],i.rules[1]],[...i.rules].reverse()]){
    const j=intent({rules:ordered.map(r=>({...r,conditions:[...r.conditions].reverse()}))}),b=plan(j);
    assert.deepEqual(b,a);assert(assess(i,b).ok);assert(assess(j,a).ok);
  }
});

test('finite positive and negative decimal boundaries and point equality belong to exactly one branch',()=>{
  for(const boundary of [-7.25,0,12.125]){
    const i=intent({rules:[rule('Low',condition('lt',boundary)),rule('Medium',condition('equals',boundary)),rule('High',condition('gt',boundary))]}),a=plan(i);
    const p=pipeline([boundary-0.001,boundary,boundary+0.001,null,'']),c=context(a,p);
    assert(assess(i,a,p).ok);
    assert.deepEqual([0,1,2].map(n=>selection(c,'branch_'+n)),[[1],[2],[3]]);
    assert.deepEqual(selection(c,'known_values'),[1,2,3]);
  }
});

test('bounded exterior values remain unchanged; closed/closed point and open intervals normalize semantically',()=>{
  const i=intent({rules:[rule('Low',condition('gte',-10),condition('lt',0)),rule('Medium',condition('gte',0),condition('lte',0)),rule('High',condition('gt',0),condition('lte',10))]});
  const a=plan(i),p=pipeline([-11,-10,-0.1,0,0.1,10,11,null]);
  assert(assess(i,a,p).ok);assert.deepEqual(selection(context(a,p),'known_values'),[2,3,4,5,6]);
  const equivalent=intent({...i,rules:[i.rules[0],rule('Medium',condition('equals',0)),i.rules[2]]});
  assert.deepEqual(plan(equivalent),a);assert(assess(equivalent,a,p).ok);
});

test('numeric gaps, overlaps, contradictory ranges and nonfinite boundaries fail without looking at rows',()=>{
  const bad=[
    [rule('Low',condition('lt',0)),rule('High',condition('gt',0))],
    [rule('Low',condition('lte',0)),rule('High',condition('gte',0))],
    [rule('Low',condition('lt',0)),rule('High',condition('gte',1))],
    [rule('Low',condition('lt',1)),rule('High',condition('gte',0))],
    [rule('Low',condition('equals',0)),rule('High',condition('equals',1))],
    [rule('Low',condition('gt',2),condition('lt',1)),rule('High',condition('gte',2))],
    [rule('Low',condition('gt',0),condition('lte',0)),rule('High',condition('gte',0))],
    [rule('Low',condition('equals',0),condition('equals',1)),rule('High',condition('gt',1))],
    [rule('Low',condition('lt',Infinity)),rule('High',condition('gte',Infinity))],
    [rule('Low',condition('lt','0')),rule('High',condition('gte',0))]
  ];
  for(const r of bad){
    assert.throws(()=>plan(intent({rules:r})),/numeric|Numeric/);
    const result=assess(intent({rules:r}),plan(),pipeline([]));assert.equal(result.complete,true);assert.equal(result.ok,false);
  }
});

test('every declared branch is required even when empty, a no-op or given the same assignment as its neighbor',()=>{
  const i=intent(),a=plan(i),p=pipeline([11000,2400,0,null]);
  p.records[2].f_priority='Low';
  const dropped=structuredClone(a);
  dropped.steps=dropped.steps.filter(s=>!['branch_0','apply_branch_0'].includes(s.id));
  dropped.goals=dropped.goals.filter(g=>!g.stepIds.includes('apply_branch_0'));
  assert.deepEqual(context(dropped,p).computed.patches,context(a,p).computed.patches);
  assert.equal(assess(i,dropped,p).ok,false);
  for(const values of [[11000,2400,null],[null,'','unknown'],[]])assert(assess(i,a,pipeline(values)).ok);
  p.records.forEach(r=>{if(typeof r.f_value==='number'&&r.f_value>=0)r.f_priority=r.f_value>=5000?'High':r.f_value>0?'Medium':'Low';});
  assert.deepEqual(context(a,p).computed.patches,[]);assert(assess(i,a,p).ok);
  const sameValue=intent({rules:rules().map(r=>({...r,value:'Medium'}))}),full=plan(sameValue);
  const merged=plan(intent({rules:[rule('Medium',condition('equals',0)),rule('Medium',condition('gt',0))]}));
  assert.deepEqual(context(full,p).computed.patches,context(merged,p).computed.patches);
  assert.equal(assess(sameValue,merged,p).ok,false);
});

test('widening the middle branch, swapping labels or dropping equality cannot hide behind identical current patches',()=>{
  const i=intent(),p=pipeline([11000,2400,null]),a=plan(i);
  const wrong=plan(intent({rules:[rule('Low',condition('equals',-1)),rule('Medium',condition('gt',-1),condition('lt',5000)),rule('High',condition('gte',5000))]}));
  assert.deepEqual(context(a,p).computed.patches,context(wrong,p).computed.patches);
  assert.equal(assess(i,wrong,p).ok,false);
  const legacy=Scoped.compile({action:'scoped_table_request',title:'Incorrect fallback',source:i.source,where:i.where,
    operation:{kind:'classify_number',numberField:i.numberField,operator:'gte',threshold:5000,targetField:i.targetField,whenTrue:'High',otherwise:'Medium',whenBlank:'unchanged'}});
  assert.deepEqual(context(a,p).computed.patches,context(legacy,p).computed.patches);
  assert.equal(assess(i,legacy,p).ok,false);
  const swapped=plan(intent({rules:rules().map(r=>({...r,value:r.value==='Low'?'Medium':r.value==='Medium'?'Low':r.value}))}));
  assert.equal(assess(i,swapped).ok,false);
});

test('all/visible scope and cohort predicates are proved, not inferred from coincidentally equal patches',()=>{
  const i=intent(),p=pipeline([11000,2400,0,null]);p.visibleIds=[1,2,3];p.conversationFocus.ids=[1,2,3];
  const all=plan(i),c=context(all,p);
  for(const j of [intent({source:'focus'}),intent({source:'visible'}),intent({where:[[F.where('f_deal','contains','Segment ')]]}),
    intent({where:[[...i.where[0],F.where('f_value','is_not_blank',null)]]})]){
    const a=plan(j);assert.deepEqual(context(a,p).computed.patches,c.computed.patches);assert.equal(assess(i,a,p).ok,false);
  }
  const explicit=intent({source:'visible'});assert(assess(explicit,plan(explicit),p).ok);
});

test('native plans prove every inline range independent of branch order and equality syntax',()=>{
  const i=intent(),a=native(i);
  for(const s of a.steps.filter(s=>s.op==='select_records'))s.where[0].reverse();
  a.steps=a.steps.slice(4).concat(a.steps.slice(0,4));
  assert(assess(i,a).ok);
  const zero=a.steps.find(s=>s.id==='rows_2');zero.where[0]=[...i.where[0],F.where('f_value','gte',0),F.where('f_value','lte',0)];
  assert(assess(i,a).ok);
});

test('OR cohorts retain their full unknown population and numeric cohort restrictions',()=>{
  for(const where of [
    [[F.where('f_deal','starts_with','Segment ')],[F.where('f_owner','equals','Sam')]],
    [[F.where('f_deal','starts_with','Segment '),F.where('f_value','gte',0)]]
  ]){
    const i=intent({where}),a=plan(i);assert(assess(i,a).ok);
    const nativePlan=F.plan(i.rules.flatMap((r,n)=>[F.select('rows_'+n,where.map(g=>[...g,...r.conditions.map(c=>F.where(i.numberField,c.operator,c.value))])),
      F.update('set_'+n,'rows_'+n,i.targetField,r.value)]));
    assert(assess(i,nativePlan).ok,JSON.stringify(where));
  }
});

test('a numeric cohort cannot hide incorrect branch boundaries or remove empty branches',()=>{
  const where=[[F.where('f_deal','starts_with','Segment '),F.where('f_value','gte',6000)]],i=intent({where}),a=plan(i),p=pipeline();
  assert(assess(i,a,p).ok);assert(assess(i,native(i),p).ok);
  const wrong=intent({where,rules:[rule('Low',condition('equals',0)),rule('Medium',condition('gt',0),condition('lt',5500)),rule('High',condition('gte',5500))]});
  for(const candidate of [plan(wrong),native(wrong)]){
    assert.deepEqual(context(candidate,p).computed.patches,context(a,p).computed.patches);
    assert.equal(assess(i,candidate,p).ok,false);
  }
  const sameValues=intent({where,rules:rules().map(r=>({...r,value:'High'}))});
  assert(assess(sameValues,plan(sameValues),p).ok);assert(assess(sameValues,native(sameValues),p).ok);
});

test('full branch limit fits ordinary plan budgets, preserves schema validity and exposes no execution shortcut',()=>{
  const many=Array.from({length:8},(_,n)=>rule(n%2?'High':'Low',...n===0?[condition('lt',1)]:n===7?[condition('gte',7)]:[condition('gte',n),condition('lt',n+1)]));
  const i=intent({rules:many}),a=plan(i),p=pipeline([0,1,2,3,4,5,6,7,8,null]);assert(assess(i,a,p).ok);
  assert.equal(a.steps.length,18);assert.equal(a.goals.length,9);
  assert.throws(()=>plan(intent({rules:[...many,rule('Low',condition('gte',8))]})),/2 to 8/);
  const schema=Scoped.schema(Plan.responseSchema(Core.create(p.tableSchema)));
  const op=schema.properties.operation.anyOf.find(s=>s.properties.kind.enum.includes('classify_number_rules'));
  assert.equal(op.properties.rules.maxItems,8);assert.equal(op.properties.rules.items.properties.conditions.maxItems,2);
  const verify=s=>{if(s.type==='object'){assert.equal(s.additionalProperties,false);assert.deepEqual(s.required,Object.keys(s.properties));Object.values(s.properties).forEach(verify);}if(s.items)verify(s.items);if(s.anyOf)s.anyOf.forEach(verify);};
  verify(schema);verify(Intent.schemaFor(p));
});

test('legacy and rule-list representations of two complementary branches remain compatible in both directions',()=>{
  const legacy={...intent(),operator:'gte',threshold:5000,whenTrue:'High',otherwise:'Medium',rules:null,whenUnmatched:null};
  const two=intent({rules:[rule('Medium',condition('lt',5000)),rule('High',condition('gte',5000))]});
  const a=Scoped.compile({action:'scoped_table_request',title:'Two branches',source:legacy.source,where:legacy.where,
    operation:{kind:'classify_number',numberField:'f_value',targetField:'f_priority',operator:'gte',threshold:5000,whenTrue:'High',otherwise:'Medium',whenBlank:'unchanged'}});
  assert(assess(two,a).ok);assert(assess(legacy,plan(two)).ok);assert.equal(assess(two,a).requested,4);
});

test('unsupported, ambiguous or mixed independent intents never authorize only the numeric subset',()=>{
  const a=plan(),p=pipeline();
  assert.equal(assess({...intent(),completeIntent:false,otherRequestedWork:true},a,p).complete,false);
  for(const invalid of [intent({ambiguity:true}),intent({otherRequestedWork:true}),intent({operator:'gte',threshold:5000}),
    intent({whenUnmatched:'Low'}),intent({whenBlank:'Low'}),intent({rules:rules().map(r=>({...r,value:3}))}),intent({rules:[rules()[0]]})]){
    const result=assess(invalid,a,p);assert.equal(result.complete,true);assert.equal(result.ok,false);
  }
  assert.match(Intent.instructions,/ENTIRE current request/);assert.match(Intent.instructions,/every requested branch/i);
});

test('extra writes/reads, stale evidence and changed snapshots fail the independent proof',()=>{
  const i=intent();
  for(const mutate of [a=>{a.steps.push(F.update('extra','population','f_notes','Unrequested'));a.goals.push({description:'Extra',stepIds:['extra']});},
    a=>{a.steps.push({op:'read_records',id:'read',label:'Extra',selection:'population',outputs:[{kind:'count',field:null}],showTable:true});a.goals.push({description:'Extra',stepIds:['read']});}]){
    const a=plan(i);mutate(a);assert(Intent.eligible(a));assert.equal(assess(i,a).ok,false);
  }
  for(const mutate of [(a,c)=>c.computed=structuredClone(c.computed),(a,c)=>c.pipeline.records[0].f_value=2,
    (a,c)=>c.computed.review.find(s=>s.id==='branch_1').records.pop(),a=>a.steps.find(s=>s.id==='apply_branch_1').assignments[0].value='Low']){
    const a=plan(i),c=context(a);assert(Intent.assess(i,a,c).ok);mutate(a,c);assert.equal(Intent.assess(i,a,c).ok,false);
  }
});

test('malformed compact rule lists never compile a partial mutation',()=>{
  const base={action:'scoped_table_request',title:'Classify',source:'all',where:[],operation:{kind:'classify_number_rules',numberField:'f_value',targetField:'f_priority',rules:rules(),whenBlank:'unchanged',whenUnmatched:'unchanged'}};
  for(const patch of [{rules:null},{whenBlank:'Low'},{whenUnmatched:'High'},{targetField:''},{otherwise:'Medium'},
    {rules:rules().map(r=>({...r,extra:'discarded'}))},{rules:rules().map(r=>({...r,value:null}))},
    {rules:rules().map(r=>({...r,conditions:r.conditions.map(c=>({...c,field:'f_value'}))}))}])assert.throws(()=>Scoped.compile({...base,operation:{...base.operation,...patch}}));
  assert.throws(()=>Scoped.compile({...base,steps:[]}));
});
