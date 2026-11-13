'use strict';

const test=require('node:test'),assert=require('node:assert/strict');
const Intent=require('../lib/date-shift-intent'),Review=require('../lib/action-review');
const Scoped=require('../lib/scoped-table-request'),F=require('./fixtures/workspace-plans.cjs');

function pipeline(){
  const p={...F.workspace(),currentDate:null,timezone:'America/New_York',workspaceVersion:'date_recovery_v1',visibleIds:[1,5]};
  p.records=['2026-11-13','2026-11-16','2026-11-09','2026-11-17','',null,undefined,'2026-11-13']
    .map((date,index)=>({...p.records[0],id:index+1,f_deal:(index===7?'Outside ':'QA1110 ')+(index+1),f_follow:date}));
  return p;
}
const intent=(extra={})=>({completeIntent:true,source:'all',where:[[F.where('f_deal','starts_with','QA1110')]],
  field:'f_follow',base:'saved_date',dateMode:'business_days',offset:1,blankPolicy:'skip',otherRequestedWork:false,ambiguity:false,...extra});
const compact=i=>Scoped.compile({action:'scoped_table_request',title:'Model candidate',source:i.source,where:structuredClone(i.where),
  operation:{kind:'shift_saved_dates',field:i.field,dateMode:i.dateMode,offset:i.offset,blankPolicy:i.blankPolicy}});
const context=(action,p)=>({pipeline:p,computed:Review.evidence({pipeline:p},{crmAction:action})});
const write=action=>action.steps.find(step=>step.op==='update_records');
const dates=computed=>computed.patches.map(patch=>[patch.id,patch.changes[0].after]);
const expectedDates=offset=>offset===1
  ?[[1,'2026-11-16'],[2,'2026-11-17'],[3,'2026-11-10'],[4,'2026-11-18']]
  :[[1,'2026-11-17'],[2,'2026-11-18'],[3,'2026-11-11'],[4,'2026-11-19']];

// Plausible typed transports, not captured production requests or model calls.
for(const offset of [1,2])test(offset+' business-day complete intent repairs mismatched typed plans and rechecks fresh evidence',()=>{
  const variants=[
    a=>a.steps[0].source='visible',
    a=>a.steps[0].where[0][0].operator='contains',
    a=>a.steps[0].where[0].push(F.where('f_owner','equals','Alex')),
    a=>write(a).assignments[0].value.dateMode='calendar_days',
    a=>write(a).assignments[0].value.offset=-offset,
    a=>write(a).assignments[0]={field:'f_follow',operation:'set',value:'2026-11-17'},
    a=>{a.steps[0].where[0].push(F.where('f_follow','is_not_blank'));write(a).assignments[0].value.blankPolicy='error';},
    a=>a.steps.push({id:'unrequested_read',op:'read_records',label:'Extra count',selection:'population',showTable:false,outputs:[{kind:'count',field:null}]})
  ];
  for(const change of variants){
    const i=intent({offset}),p=pipeline(),a=compact(i);change(a);a.goals=F.plan(a.steps).goals;
    const before=structuredClone({i,p,a}),c=context(a,p),failure=Intent.assess(i,a,c);
    assert.equal(Intent.eligible(a,p),true);
    assert.equal(failure.ok,false,change.toString());
    assert.equal(failure.requested,5);assert.equal(failure.compiled,0);assert.equal(failure.issues.length,1);
    assert.equal(failure.expectedAction.action,'workspace_plan');
    const prepared=Intent.prepare(i,p);
    assert.deepEqual(prepared.action,failure.expectedAction);
    assert.equal(Review.checkedWorkspaceEvidence(prepared.action,{pipeline:p,computed:prepared.computed}),prepared.computed);
    assert.deepEqual(prepared.assessment,{complete:true,ok:true,issues:[],requested:5,compiled:5});
    assert.deepEqual(dates(prepared.computed),expectedDates(offset));
    assert.deepEqual(prepared.computed.recordTransformEvidence[0].cells.filter(cell=>cell.skipped).map(cell=>cell.recordId),[5,6,7]);
    assert.deepEqual(prepared.computed.recordTransformEvidence[0].cells.filter(cell=>!cell.skipped).map(cell=>cell.baseDate),
      ['2026-11-13','2026-11-16','2026-11-09','2026-11-17']);
    assert.equal(prepared.computed.lifecycle.requiresConfirmation,true);
    assert.equal(prepared.computed.lifecycle.authorization,'prepare_only');
    assert.equal(prepared.computed.lifecycle.executed,false);assert.equal(prepared.computed.lifecycle.writesApplied,0);
    assert.deepEqual({i,p,a},before,'repair cannot edit intent, failed transport or saved state');
    const fresh=context(prepared.action,p);
    assert.notEqual(fresh.computed,prepared.computed);
    assert.equal(Intent.assess(i,prepared.action,fresh).ok,true,'server must recompute evidence for the replacement');
    assert.equal(Intent.assess(i,prepared.action,c).ok,false,'failed-candidate evidence is not reusable');
  }
});

test('compiled transport is detached, bounded and contains no snapshot dates or candidate metadata',()=>{
  const i=intent(),p=pipeline(),before=structuredClone({i,p}),a=Intent.compile(i,p);
  assert.deepEqual({i,p},before);assert.deepEqual(a.steps[0].where,i.where);
  assert.notEqual(a.steps[0].where,i.where);assert.notEqual(a.steps[0].where[0][0],i.where[0][0]);
  assert.deepEqual(write(a).assignments,[{field:'f_follow',operation:'shift_date',value:{dateMode:'business_days',offset:1,blankPolicy:'skip'}}]);
  assert.equal(a.steps[0].source,'all');assert.equal(a.steps[0].limit,null);assert.equal(a.steps[0].orderBy,null);
  assert.equal(a.steps.length,2);assert.deepEqual(a.unmappedFacts,[]);
  assert(!JSON.stringify(a).includes('2026-'));assert(Buffer.byteLength(JSON.stringify(a),'utf8')<=12000);
  a.steps[0].where[0][0].value='Changed proposal';
  assert.deepEqual({i,p},before);
  const failure=Intent.assess(i,compact(intent({offset:2})),{pipeline:p,computed:null});
  failure.expectedAction.steps[0].where[0][0].value='Changed repair';
  assert.deepEqual({i,p},before);assert.deepEqual(Intent.prepare(i,p).action,Intent.compile(i,p));
});

test('valid native and compact transports still pass directly without repair metadata',()=>{
  const i=intent(),p=pipeline();
  for(const a of [Intent.compile(i,p),compact(i)]){
    const checked=Intent.assess(i,a,context(a,p));
    assert.deepEqual(checked,{complete:true,ok:true,issues:[],requested:5,compiled:5});
    assert.equal(Object.hasOwn(checked,'expectedAction'),false);
  }
});

test('visible recovery uses only explicitly visible rows, including empty visibility',()=>{
  for(const visibleIds of [[1,5],[]]){
    const i=intent({source:'visible'}),p=pipeline();p.visibleIds=visibleIds;
    const a=compact({...i,source:'all'}),failure=Intent.assess(i,a,context(a,p));
    assert.equal(failure.ok,false);assert.equal(failure.expectedAction.steps[0].source,'visible');
    const prepared=Intent.prepare(i,p);
    assert.deepEqual(prepared.computed.recordTransformEvidence[0].recordIds,visibleIds);
    assert.deepEqual(dates(prepared.computed),visibleIds.length?[[1,'2026-11-16']]:[]);
  }
});

test('local preparation retains no-op semantics for zero, empty cohorts and all blank dates',()=>{
  for(const kind of ['zero','empty','blank']){
    const i=intent({offset:kind==='zero'?0:2}),p=pipeline();
    if(kind==='empty')i.where=[[F.where('f_deal','starts_with','Missing group')]];
    if(kind==='blank')p.records.slice(0,7).forEach((r,index)=>r.f_follow=['',null,'  '][index%3]);
    const before=structuredClone(p),prepared=Intent.prepare(i,p);
    assert.deepEqual(prepared.computed.patches,[]);assert.equal(prepared.computed.mutates,false);
    assert.equal(prepared.computed.lifecycle.requiresConfirmation,false);
    assert.equal(prepared.computed.lifecycle.operation,'read');assert.equal(prepared.computed.lifecycle.writesApplied,0);
    assert.equal(prepared.assessment.ok,true);assert.deepEqual(p,before);
  }
});

test('local preparation is generic across fields, cohorts, dates, units and signed offsets',()=>{
  for(const [before,offset,dateMode,after] of [
    ['2028-02-28',1,'business_days','2028-02-29'],['2026-12-31',2,'business_days','2027-01-04'],
    ['2027-01-04',-2,'business_days','2026-12-31'],['2028-03-01',-1,'calendar_days','2028-02-29']
  ]){
    const p=pipeline();p.customFields=[{id:'cf_dispatch',name:'Dispatch',type:'date'}];p.records=p.records.slice(0,1);
    p.records[0].f_deal='Shipping';p.records[0].cf_dispatch=before;p.currentDate='2045-05-01';
    const i=intent({field:'cf_dispatch',where:[[F.where('f_deal','equals','Shipping')]],offset,dateMode,blankPolicy:'error'});
    assert.deepEqual(dates(Intent.prepare(i,p).computed),[[1,after]]);
  }
});

test('unsupported, malformed and oversized intent cannot produce a partial repair action',()=>{
  const p=pipeline(),a=compact(intent()),c=context(a,p);
  for(const change of [
    i=>i.completeIntent=false,i=>i.completeIntent='true',i=>i.otherRequestedWork=true,i=>i.ambiguity=true,
    i=>i.source='focus',i=>i.base='today',i=>i.field='f_notes',i=>i.field='@new_date',i=>i.dateMode='working_days',
    i=>i.offset='1',i=>i.offset=1.5,i=>i.offset=367,i=>i.blankPolicy='preserve',i=>delete i.blankPolicy,
    i=>i.extra='another requested operation',i=>i.where=[[F.where('f_follow','before_today')]],
    i=>i.where=[[F.where('f_follow','equals','2026-02-30')]],i=>i.where=[[F.where('f_value','gt','0')]],
    i=>i.where=[[F.where('f_deal','in',null,['a'.repeat(7000),'b'.repeat(7000)])]],
    i=>i.where=[[F.where('f_deal','in',null,['\u00e9'.repeat(6000)])]]
  ]){
    const i=intent();change(i);
    assert.throws(()=>Intent.compile(i,p),undefined,change.toString());
    assert.throws(()=>Intent.prepare(i,p),undefined,change.toString());
    const failure=Intent.assess(i,a,c);
    assert.equal(failure.ok,false);assert.equal(failure.compiled,0);assert.equal(Object.hasOwn(failure,'expectedAction'),false);
  }
});

test('bounded intent alone is insufficient when the complete repair action exceeds the byte limit',()=>{
  const i=intent({where:[[F.where('f_deal','starts_with','x'.repeat(11400))]]}),p=pipeline();
  assert(Buffer.byteLength(JSON.stringify(i),'utf8')<12000);
  assert.throws(()=>Intent.compile(i,p),/plan exceeds the bounded repair contract/);
  const failure=Intent.assess(i,compact(i),{pipeline:p,computed:null});
  assert.equal(failure.ok,false);assert.equal(Object.hasOwn(failure,'expectedAction'),false);
});

test('a step named visible cannot turn a built-in source into a consumed selection dependency',()=>{
  const i=intent({source:'visible'}),p=pipeline(),a=compact(i);
  a.steps.unshift(F.select('visible',[],{source:'visible'}));a.goals=F.plan(a.steps).goals;
  const failure=Intent.assess(i,a,context(a,p));
  assert.equal(failure.ok,false);assert.match(failure.issues[0],/unused selections/);
  assert.equal(Intent.prepare(i,p).assessment.ok,true);
});

test('missing, invalid or stale snapshot identities cannot produce a replacement transport',()=>{
  for(const change of [
    p=>p.records=null,p=>p.records.push({...p.records[0]}),p=>p.records[0]=null,p=>p.records[0].id=0,
    p=>p.records[0].id='1',p=>p.visibleIds=undefined,p=>p.visibleIds=[1,1],p=>p.visibleIds=[999],p=>p.visibleIds=['1']
  ]){
    const i=intent({source:'visible'}),p=pipeline();change(p);
    assert.throws(()=>Intent.compile(i,p),undefined,change.toString());
    assert.throws(()=>Intent.prepare(i,p),undefined,change.toString());
    const failure=Intent.assess(i,compact(i),{pipeline:p,computed:null});
    assert.equal(failure.ok,false);assert.equal(Object.hasOwn(failure,'expectedAction'),false);
  }
});

test('preparation refuses invalid saved bases and never invents a skip policy',()=>{
  for(const value of ['2026-02-30','not a date',0]){
    const p=pipeline();p.records[0].f_follow=value;
    assert.throws(()=>Intent.prepare(intent(),p),error=>error.reasonCode==='transform_base_invalid');
  }
  assert.throws(()=>Intent.prepare(intent({blankPolicy:'error'}),pipeline()),error=>error.reasonCode==='transform_blank');
  const p=pipeline();p.records[7].f_follow='invalid outside cohort';
  assert.equal(Intent.prepare(intent(),p).assessment.ok,true);
});

test('prepared evidence is still rejected when copied, forged, tampered or stale',()=>{
  for(const change of [
    c=>c.computed=structuredClone(c.computed),c=>c.pipeline=structuredClone(c.pipeline),
    c=>c.computed.recordTransformEvidence[0].cells[0].baseDate='2026-11-10',c=>c.computed.patches.pop(),
    c=>c.computed.lifecycle.executed=true,c=>c.computed.lifecycle.writesApplied=4,
    c=>c.pipeline.workspaceVersion='new_version',c=>c.pipeline.records[0].f_follow='2026-11-12'
  ]){
    const i=intent(),p=pipeline(),prepared=Intent.prepare(i,p),c={pipeline:p,computed:prepared.computed};change(c);
    assert.equal(Intent.assess(i,prepared.action,c).ok,false,change.toString());
  }
  const evidence=Review.evidence;
  try{
    Review.evidence=(...args)=>structuredClone(evidence(...args));
    assert.throws(()=>Intent.prepare(intent(),pipeline()),/authenticated evidence/);
  }finally{Review.evidence=evidence;}
});

test('date candidate gate tolerates malformed assignments without approving them',()=>{
  const p=pipeline(),a=compact(intent());write(a).assignments=[null];
  assert.equal(Intent.eligible(a,p),false);
  write(a).assignments.push({field:'f_follow',operation:'set',value:'2026-11-17'});
  assert.equal(Intent.eligible(a,p),true);
  assert.equal(Intent.assess(intent(),a,{pipeline:p,computed:null}).ok,false);
});
