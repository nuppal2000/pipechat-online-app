'use strict';

const test=require('node:test'),assert=require('node:assert/strict');
const Intent=require('../lib/date-shift-intent'),Review=require('../lib/action-review');
const Plan=require('../public/workspace-plan'),Scoped=require('../lib/scoped-table-request');
const F=require('./fixtures/workspace-plans.cjs');
const scope=[[F.where('f_deal','starts_with','QA1110')]];
const intent=(extra={})=>({completeIntent:true,source:'all',where:structuredClone(scope),field:'f_follow',base:'saved_date',
  dateMode:'business_days',offset:2,blankPolicy:'skip',otherRequestedWork:false,ambiguity:false,...extra});
function pipeline(){
  const p={...F.workspace(),currentDate:'2026-11-13',timezone:'America/New_York',workspaceVersion:'saved_v1',visibleIds:[1,2]};
  p.tableSchema.fields.find(f=>f.id==='f_follow').name='Next Follow-Up Date';
  p.records=[['Beacon','2026-11-13'],['Harbor','2026-11-16'],['Loom','2026-11-09'],['Tide','2026-11-17'],['Blank',''],['Unknown',null],['Outside','2026-11-13']]
    .map(([name,date],i)=>({...p.records[0],id:i+1,f_deal:(i===6?'Other ':'QA1110 ')+name,f_follow:date}));
  return p;
}
function plan(i=intent()){
  return Scoped.compile({action:'scoped_table_request',title:'Preview saved dates',source:i.source,where:structuredClone(i.where),
    operation:{kind:'shift_saved_dates',field:i.field,dateMode:i.dateMode,offset:i.offset,blankPolicy:i.blankPolicy}});
}
const context=(a,p=pipeline())=>({pipeline:p,computed:Review.evidence({pipeline:p},{crmAction:a})});
function assess(i,a,p=pipeline()){
  a.goals=F.plan(a.steps).goals;
  return Intent.assess(i,a,context(a,p));
}
const write=a=>a.steps.find(s=>s.op==='update_records');
const patchDates=c=>c.computed.patches.map(p=>[p.id,p.changes.find(change=>change.field==='Next Follow-Up Date').after]);

test('typed gate avoids an extra intent call for non-date updates but checks date literals and transforms',()=>{
  const p=pipeline(),a=plan();
  assert.equal(Intent.eligible(a,p),true);
  write(a).assignments=[{field:'f_follow',operation:'set',value:'2026-11-17'}];
  assert.equal(Intent.eligible(a,p),true);
  write(a).assignments=[{field:'f_value',operation:'set',value:12}];
  assert.equal(Intent.eligible(a,p),false);
});

test('two-business-day regression proves all four saved-date updates and preserves blanks and outside records',()=>{
  const i=intent(),a=plan(i),p=pipeline(),before=structuredClone({i,a,p}),c=context(a,p),result=Intent.assess(i,a,c);
  assert.deepEqual(result,{complete:true,ok:true,issues:[],requested:5,compiled:5});
  assert.deepEqual(patchDates(c),[[1,'2026-11-17'],[2,'2026-11-18'],[3,'2026-11-11'],[4,'2026-11-19']]);
  const evidence=c.computed.recordTransformEvidence[0];
  assert.deepEqual(evidence.recordIds,[1,2,3,4,5,6]);
  assert.deepEqual(evidence.cells.map(cell=>[cell.before,cell.after,cell.baseDate,cell.skipped]),[
    ['2026-11-13','2026-11-17','2026-11-13',false],['2026-11-16','2026-11-18','2026-11-16',false],
    ['2026-11-09','2026-11-11','2026-11-09',false],['2026-11-17','2026-11-19','2026-11-17',false],
    ['','',null,true],[null,null,null,true]
  ]);
  assert.equal(c.computed.lifecycle.executed,false);assert.equal(c.computed.lifecycle.requiresConfirmation,true);
  assert.deepEqual({i,a,p},before);
});

test('one-business-day original, signed calendar shifts and zero use saved dates, never today',()=>{
  for(const [offset,dateMode,expected] of [
    [1,'business_days',['2026-11-16','2026-11-17','2026-11-10','2026-11-18']],
    [-2,'business_days',['2026-11-11','2026-11-12','2026-11-05','2026-11-13']],
    [2,'calendar_days',['2026-11-15','2026-11-18','2026-11-11','2026-11-19']],
    [-2,'calendar_days',['2026-11-11','2026-11-14','2026-11-07','2026-11-15']]
  ])for(const today of [null,'2040-01-01']){
    const i=intent({offset,dateMode}),a=plan(i),p=pipeline();p.currentDate=today;
    const c=context(a,p);assert.equal(Intent.assess(i,a,c).ok,true);
    assert.deepEqual(patchDates(c).map(([,after])=>after),expected);
  }
  for(const kind of ['zero','empty','all_blank']){
    const i=intent({offset:kind==='zero'?0:2}),a=plan(i),p=pipeline();
    if(kind==='empty')p.records.forEach(r=>r.f_deal='Elsewhere');
    if(kind==='all_blank')p.records.forEach(r=>r.f_follow=null);
    const c=context(a,p);assert.deepEqual(c.computed.patches,[]);assert.equal(c.computed.mutates,false);
    assert.equal(Intent.assess(i,a,c).ok,true,kind);
  }
});

test('generic custom date fields handle weekends, leap days, year boundaries and holidays with existing calendar rules',()=>{
  for(const [base,offset,mode,after] of [
    ['2026-10-31',1,'business_days','2026-11-02'],['2028-02-28',1,'business_days','2028-02-29'],
    ['2026-12-31',2,'business_days','2027-01-04'],['2027-01-01',-2,'calendar_days','2026-12-30'],
    ['2026-10-31',0,'business_days','2026-10-31']
  ]){
    const p=pipeline();p.customFields=[{id:'cf_dispatch',name:'Dispatch date',type:'date'}];
    p.records=p.records.slice(0,1);p.records[0].f_deal='Shipping A';p.records[0].cf_dispatch=base;
    const i=intent({field:'cf_dispatch',where:[[F.where('f_deal','starts_with','Shipping')]],offset,dateMode:mode,blankPolicy:'error'});
    const a=plan(i),c=context(a,p);assert.equal(Intent.assess(i,a,c).ok,true);
    assert.equal(c.computed.recordTransformEvidence[0].cells[0].after,after);
  }
  for(const offset of [-366,366])for(const dateMode of ['calendar_days','business_days']){
    const i=intent({offset,dateMode}),a=plan(i);assert.equal(assess(i,a).ok,true);
  }
});

test('independent input is current command and schema only, for paraphrases without prompt matching',()=>{
  const p=pipeline();
  for(const userCommand of [
    'Postpone all QA1110 Next Follow-Up Dates by two business days from each saved date. Skip blank dates. Preview the changes.',
    'Move every dated QA1110 follow-up forward by one business day. Leave undated deals alone.',
    'Bring the Shipping dispatch dates back three calendar days, keeping missing dates empty.'
  ]){
    const input=Intent.input({userCommand,pipeline:p,compiled:plan(),proposalMessage:'secret',conversationHistory:['secret'],
      conversationMemory:'secret',computed:{secret:1}});
    assert.deepEqual(Object.keys(input).sort(),['fields','primaryField','userCommand']);assert.equal(input.userCommand,userCommand);
    assert.equal(input.primaryField,'f_deal');assert.equal(JSON.stringify(input).includes('secret'),false);
    assert.equal(JSON.stringify(input).includes('Beacon'),false);assert.equal(JSON.stringify(input).includes('2026-11-13'),false);
  }
  for(const extra of [{pendingAction:{}},{pendingClarification:{}},{userCommand:' '},{userCommand:'x'.repeat(24001)}]){
    assert.equal(Intent.input({userCommand:'Shift the saved dates.',pipeline:p,...extra}),null);
  }
  const large=pipeline();large.tableSchema.fields[0].name='x'.repeat(24000);
  assert.equal(Intent.input({userCommand:'Shift dates.',pipeline:large}),null);
  const noDates=pipeline();noDates.tableSchema.fields=noDates.tableSchema.fields.filter(f=>f.type!=='date');
  assert.equal(Intent.schemaFor(noDates),null);assert.equal(Intent.input({userCommand:'Shift dates.',pipeline:noDates}),null);
  assert.match(Intent.instructions,/ENTIRE current request/);assert.match(Intent.instructions,/No proposed plan/);
  assert.match(Intent.instructions,/today-based date/);assert.match(Intent.instructions,/ANY additional work/);
});

test('strict structured schema limits date fields, units, offsets, cohorts and unsupported nulls',()=>{
  const schema=Intent.schemaFor(pipeline());assert.deepEqual(schema.required,Object.keys(intent()));
  const visit=s=>{
    if(s.type==='object'){
      assert.equal(s.additionalProperties,false);assert.deepEqual(s.required,Object.keys(s.properties));Object.values(s.properties).forEach(visit);
    }
    if(s.items)visit(s.items);if(s.anyOf)s.anyOf.forEach(visit);
  };visit(schema);
  assert.deepEqual(schema.properties.field.anyOf[0].enum,['f_follow']);
  assert.deepEqual(schema.properties.offset.anyOf[0],{type:'integer',minimum:-366,maximum:366});
  assert.deepEqual(schema.properties.dateMode.anyOf[0].enum,['calendar_days','business_days']);
  assert.deepEqual(schema.properties.base.anyOf[0].enum,['saved_date']);
  assert(!schema.properties.where.items.items.properties.operator.enum.includes('before_today'));
});

test('broad transport gate includes literal replacements and mixed work, without making them approvable',()=>{
  const a=plan();assert.equal(Intent.eligible(a),true);
  write(a).assignments=[{field:'f_follow',operation:'set',value:'2026-11-17'}];assert.equal(Intent.eligible(a),true);
  a.steps.push({op:'read_records',id:'read',label:'Extra',selection:'population',showTable:true,outputs:[{kind:'names',field:null}]});
  assert.equal(Intent.eligible(a),true);
  assert.equal(Intent.eligible(F.plan([F.select('rows')])),false);assert.equal(Intent.eligible(null),false);
  assert.equal(Intent.eligible({action:'workspace_plan',steps:Array(31).fill({op:'update_records'})}),false);
});

test('exact all/visible cohort meaning cannot be replaced by focus, a limit or coincidentally matching predicates',()=>{
  for(const change of [
    a=>a.steps[0].source='visible',a=>a.steps[0].source='focus',a=>a.steps[0].where[0][0].operator='contains',
    a=>a.steps[0].where=[],a=>a.steps[0].limit=6,a=>a.steps[0].orderBy='f_value',a=>a.steps[0].relatedTasks='none',
    a=>a.steps[0].where[0].push(F.where('f_owner','equals','Alex'))
  ]){
    const a=plan(),p=pipeline();p.visibleIds=p.records.map(r=>r.id);p.conversationFocus={kind:'table',ids:p.visibleIds};
    change(a);assert.equal(assess(intent(),a,p).ok,false,change.toString());
  }
  const i=intent({source:'visible'}),a=plan(i);assert.equal(assess(i,a).ok,true);
  assert.equal(assess(i,plan()).ok,false);
  const p=pipeline();p.visibleIds=[1,1];assert.equal(assess(i,a,p).ok,false);
  p.visibleIds=[1,999];assert.throws(()=>context(a,p),error=>error.reasonCode==='record_selection_stale');
  assert.equal(Intent.assess(i,a,{pipeline:p,computed:null}).ok,false);
});

test('reordered OR/AND predicates and selection chains preserve exact common cohort semantics',()=>{
  const i=intent({where:[[F.where('f_owner','equals','Alex'),...scope[0]],[F.where('f_deal','equals','Other Outside')]]}),a=plan(i);
  a.steps[0].where.reverse();a.steps[0].where[1].reverse();a.steps[0].where.push(structuredClone(a.steps[0].where[0]));
  assert.equal(assess(i,a).ok,true);
  const nested=intent({where:[[...scope[0],F.where('f_owner','equals','Alex')]]}),b=plan(nested);
  b.steps[0].where=[[F.where('f_owner','equals','Alex')]];
  b.steps.splice(1,0,F.select('named',scope,{source:'population'}));write(b).selection='named';
  assert.equal(assess(nested,b).ok,true);
});

test('only an explicit skip policy permits a target-date nonblank guard; full blank preservation is still proven',()=>{
  for(const blank of ['',null,undefined,'  '])for(const nested of [true,false]){
    const i=intent(),a=plan(i),p=pipeline();p.records[4].f_follow=blank;
    const guard=F.where('f_follow','is_not_blank');
    if(nested){a.steps.splice(1,0,F.select('dated',[[guard]],{source:'population'}));write(a).selection='dated';}
    else a.steps[0].where[0].push(guard);
    assert.equal(assess(i,a,p).ok,true);
    const wrongPolicy=structuredClone(a);write(wrongPolicy).assignments[0].value.blankPolicy='error';
    assert.equal(assess(i,wrongPolicy,p).ok,false);
    const errorIntent={...i,blankPolicy:'error'};assert.equal(assess(errorIntent,wrongPolicy,p).ok,false);
  }
  const a=plan();a.steps[0].where[0].push(F.where('f_notes','is_not_blank'));
  assert.equal(assess(intent(),a).ok,false,'another field guard is never a blank-date preservation proof');
  const p=pipeline();p.records.forEach(r=>r.f_follow=null);
  const guarded=plan();guarded.steps[0].where[0].push(F.where('f_follow','is_not_blank'));
  assert.equal(assess(intent(),guarded,p).ok,true,'an all-blank cohort is still a complete no-op');
});

test('literal dates, today-based sets, wrong date fields, units and offsets cannot substitute for saved-date semantics',()=>{
  const p=pipeline();p.records=p.records.slice(1,2);p.currentDate='2026-11-16';
  const expected=context(plan(),p).computed.patches;
  for(const replacement of [
    {field:'f_follow',operation:'set',value:'2026-11-18'},
    {field:'f_follow',operation:'set',value:{dateMode:'business_days',date:null,offset:2}},
    {field:'f_follow',operation:'shift_date',value:{dateMode:'calendar_days',offset:2,blankPolicy:'skip'}}
  ]){
    const a=plan();write(a).assignments=[replacement];const c=context(a,p);
    assert.deepEqual(c.computed.patches,expected,'current patches can coincide despite wrong semantics');
    assert.equal(Intent.assess(intent(),a,c).ok,false);
  }
  for(const change of [a=>write(a).assignments[0].value.offset=1,a=>write(a).assignments[0].value.offset=-2,
    a=>write(a).assignments[0].value.blankPolicy='error',a=>write(a).assignments[0].field='cf_other']){
    const a=plan(),pop=pipeline();pop.records=pop.records.slice(0,4);
    pop.customFields=[{id:'cf_other',name:'Other date',type:'date'}];pop.records.forEach(r=>r.cf_other=r.f_follow);
    change(a);assert.equal(assess(intent(),a,pop).ok,false,change.toString());
  }
});

test('whole-intent proof rejects extra operations even if they are no-ops or ultimately overwritten',()=>{
  for(const change of [
    a=>a.steps.push(F.update('notes','population','f_notes','Keep notes')),
    a=>a.steps.push(F.select('unused',scope)),
    a=>a.steps.push({...structuredClone(write(a)),id:'repeat'}),
    a=>a.steps.splice(1,0,F.update('earlier','population','f_follow','2030-01-01')),
    a=>write(a).assignments.push({field:'f_notes',operation:'set',value:'Keep notes'}),
    a=>a.steps.push({id:'read',op:'read_records',label:'Count',selection:'population',showTable:false,outputs:[{kind:'count',field:null}]}),
    a=>a.steps.push({id:'read',op:'read_records',label:'Show names',selection:'population',showTable:true,outputs:[{kind:'names',field:null}]}),
    a=>a.steps.push(F.tasks('tasks','population')),
    a=>a.steps.push({id:'field',op:'add_field',label:'Extra field',name:'Extra',type:'text',options:[]}),
    a=>a.unmappedFacts=[{text:'Also do something',source:'User',reason:'Omitted'}]
  ]){
    const a=plan();change(a);assert.equal(Intent.eligible(a),true);assert.equal(assess(intent(),a).ok,false,change.toString());
  }
});

test('only explicit unsupported extraction falls back; malformed or incomplete complete claims fail closed',()=>{
  const a=plan(),c=context(a);
  assert.deepEqual(Intent.assess({...intent(),completeIntent:false},a,c),{complete:false,ok:false,issues:[],requested:0,compiled:0});
  for(const change of [
    i=>delete i.completeIntent,i=>i.completeIntent='true',i=>i.otherRequestedWork=true,i=>i.ambiguity=true,i=>i.base='today',
    i=>i.source='focus',i=>i.field='f_notes',i=>i.field='@new_date',i=>i.dateMode='working_days',i=>i.dateMode=null,
    i=>i.offset='2',i=>i.offset=1.5,i=>i.offset=367,i=>i.offset=-367,i=>i.blankPolicy='today',i=>delete i.blankPolicy,
    i=>i.extra='also write',i=>i.where=[[F.where('f_follow','before_today')]],i=>i.where=[[F.where('f_value','gt','0')]],
    i=>i.where=[[F.where('f_follow','is_not_blank','ignored')]],i=>i.where=[[F.where('f_follow','equals','2026-02-30')]]
  ]){
    const i=intent();change(i);const result=Intent.assess(i,a,c);assert.equal(result.complete,true);assert.equal(result.ok,false,change.toString());
  }
  for(const i of [null,{},[]])assert.equal(Intent.assess(i,a,c).ok,false);
});

test('copied, forged, stale or edited execution evidence cannot authorize the shift',()=>{
  const a=plan(),c=context(a);
  assert.equal(Intent.assess(intent(),a,structuredClone(c)).ok,false);
  assert.equal(Intent.assess(intent(),a,{...c,computed:structuredClone(c.computed)}).ok,false);
  const changed=structuredClone(a);changed.title='Changed action';assert.equal(Intent.assess(intent(),changed,c).ok,false);
  for(const change of [
    c=>c.pipeline.records[0].f_follow='2026-11-14',c=>c.pipeline.workspaceVersion='saved_v2',c=>c.pipeline.visibleIds.push(3),
    c=>c.pipeline.tableSchema.fields.find(f=>f.id==='f_follow').type='text',c=>c.computed.lifecycle.executed=true,
    c=>c.computed.lifecycle.requiresConfirmation=false,c=>c.computed.lifecycle.writesApplied=4,
    c=>c.computed.recordTransformEvidence[0].cells[0].baseDate='2026-11-10',c=>c.computed.recordTransformEvidence[0].cells.pop(),
    c=>c.computed.patches.pop(),c=>c.computed.effects.push({kind:'table',show:true,ids:[1]})
  ]){
    const current=context(a);change(current);assert.equal(Intent.assess(intent(),a,current).ok,false,change.toString());
  }
});

test('independent calculation checks authenticated cell evidence and final patches, not only their provenance',()=>{
  const original=Plan.prepare;
  try{
    for(const change of [
      p=>p.review.find(s=>s.op==='update_records').transforms[0].before='2026-11-10',
      p=>p.review.find(s=>s.op==='update_records').transforms[0].after='2026-11-18',
      p=>p.review.find(s=>s.op==='update_records').transforms[0].baseDate='2026-11-10',
      p=>p.review.find(s=>s.op==='update_records').transforms[0].operand.offset=1,
      p=>p.review.find(s=>s.op==='update_records').transforms.pop(),
      p=>p.patches[0].changes[0].before='2026-11-10',p=>p.patches.pop()
    ]){
      let calls=0;Plan.prepare=(...args)=>{const p=original(...args);if(calls++===0)change(p);return p;};
      const a=plan(),c=context(a);assert.equal(Review.checkedWorkspaceEvidence(a,c),c.computed);
      assert.equal(Intent.assess(intent(),a,c).ok,false,change.toString());
    }
    let calls=0;Plan.prepare=(...args)=>{const p=original(...args);if(calls++===0){p.patches.reverse();p.review.find(s=>s.op==='update_records').transforms.reverse();}return p;};
    const a=plan();assert.equal(Intent.assess(intent(),a,context(a)).ok,true,'ordering alone is immaterial');
  }finally{Plan.prepare=original;}
});

test('repair feedback retains only bounded validated intent for the exact full request',()=>{
  const a=plan();a.steps[0].source='visible';const r=assess(intent(),a);
  assert.equal(r.ok,false);assert.equal(r.compiled,0);
  const expected=JSON.parse(r.issues[0].split(' Expected intent: ')[1]);
  assert.deepEqual(expected,{source:'all',where:scope,field:'f_follow',base:'saved_date',dateMode:'business_days',offset:2,blankPolicy:'skip'});
  const invalid=assess(intent({offset:'2'}),plan());assert.equal(invalid.issues[0].includes('Expected intent:'),false);
  const large=intent({where:[[F.where('f_deal','in',null,['a'.repeat(7000),'b'.repeat(7000)])]]});
  const bounded=assess(large,plan());assert.equal(bounded.ok,false);assert.match(bounded.issues[0],/bounded repair/);
  assert.equal(bounded.issues[0].includes('Expected intent:'),false);
});
