'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const R=require('../public/report-engine.js'),D=require('../public/dashboard-board.js'),P=require('../public/workspace-plan.js'),C=require('../public/pipeline-core.js');
const Review=require('../lib/action-review.js'),F=require('./fixtures/objective-query-acceptance.cjs');
const execute=(w,spec,options={})=>R.execute(w.records,spec,C.create(w.tableSchema),w.customFields,{...F.options,...options});
const prepare=(w,steps,options={})=>P.prepare(w,F.plan(steps),{...F.options,...options});
const escape=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');

test('objective 10: odd/even medians retain zero, exclude null/blank, and never mutate input order',()=>{
  for(const [values,median,distinct] of [
    [[20,null,0,10,''],10,3],[[20,0,null,10,10],10,3],
    [[-10,0,10,20,null],5,4],[[0,0,null,''],0,1],[[null,'',null],null,0]
  ]){
    const w=F.freeze(F.withValues(values)),before=JSON.stringify(w);
    const report=execute(w,F.spec('median',{chart:'kpi',groupBy:null}));
    assert.equal(report.summaries[0].value,median);assert.equal(report.count,values.length);
    assert.equal(execute(w,F.spec('count_distinct',{chart:'kpi',groupBy:null})).summaries[0].value,distinct);
    const result=prepare(w,[F.select('cohort'),F.read('cohort',[{kind:'median',field:'f_value'},{kind:'distinct',field:'f_value'}])]);
    const expected=median===null?'Not set':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(median);
    assert(result.answers[0].includes('Median Value: '+expected));assert(result.answers[0].includes('Distinct Value: '+distinct));
    assert.equal(result.mutates,false);assert.deepEqual(result.next,w);assert.equal(JSON.stringify(w),before);
  }
});

test('objective 10: numeric aggregations separate a real zero from an entirely missing cohort',()=>{
  const w=F.freeze(F.withValues([null,0,0,10,20]));
  for(const [metric,value] of [['sum',30],['average',7.5],['min',0],['max',20],['median',5],['count_distinct',3]]){
    const result=execute(w,F.spec(metric,{chart:'kpi',groupBy:null}));assert.equal(result.summaries[0].value,value,metric);
  }
  for(const metric of ['sum','average','min','max','median'])assert.equal(execute(F.withValues([null,'']),F.spec(metric,{chart:'kpi',groupBy:null})).summaries[0].value,null,metric);
  const named=F.freeze(F.workspace()),result=execute(named,F.spec('count_distinct',{chart:'kpi',groupBy:null,measures:[{label:'Owners',metric:'count_distinct',field:'f_owner',where:[]}]}));
  assert.equal(result.summaries[0].value,3);assert.equal(result.count,6);
});

test('objective 11: groups, numerator filters, top-N and visible scope share one percentage denominator',()=>{
  const w=F.freeze(F.workspace()),base=F.spec('percentage',{chart:'stage',groupBy:'f_stage'});
  const result=execute(w,base),sum=r=>r.table.reduce((total,row)=>total+(row.value??0),0);
  assert.equal(result.count,6);assert(Math.abs(sum(result)-100)<1e-9);
  assert(Math.abs(result.table.find(row=>row.group==='Qualified').value-100/3)<1e-9);
  assert(Math.abs(result.table.find(row=>row.group==='Not set').value-100/6)<1e-9);
  const numerator={...base,measures:[{...base.measures[0],where:[[F.where('f_owner','equals','Alex')]]}]};
  assert(Math.abs(sum(execute(w,numerator))-100/3)<1e-9);
  const top=execute(w,{...base,sort:'value_desc',limit:1});assert.equal(top.count,6);assert.deepEqual(top.representedIds,[41,7]);assert(Math.abs(sum(top)-100/3)<1e-9);
  const visible=execute(w,{...base,scope:'visible'},{visibleIds:[41,93,12]});assert.equal(visible.count,3);assert.equal(visible.table.length,3);assert(Math.abs(sum(visible)-100)<1e-9);
  const dated=execute(w,{...base,chart:'bar',groupBy:'f_follow',bucket:'day'});assert.equal(dated.undated,1);assert.equal(dated.count,6);assert(Math.abs(sum(dated)-500/6)<1e-9);
  const empty=execute(w,{...base,where:[[F.where('f_value','gt',1000)]]});assert.equal(empty.count,0);assert.equal(empty.summaries[0].value,null);
});

test('objective 11: shared-filter removal restores independent comparison snapshots and IDs',()=>{
  const w=F.freeze(F.workspace()),core=C.create(w.tableSchema);
  const initial=D.apply(null,{action:'dashboard_plan',operations:[{op:'add',id:'volume',spec:F.spec()},{op:'add',id:'amount',spec:F.spec('sum')}],questions:[]},w.records,core,w.customFields,F.options);
  F.freeze(initial);const before=JSON.stringify(initial);
  const filtered=D.apply(initial.board,{action:'dashboard_plan',operations:[{op:'set_shared_filter',id:'alex',targets:['volume','amount'],where:[[F.where('f_owner','equals','Alex')]]}],questions:[]},w.records,core,w.customFields,F.options);
  assert.deepEqual(filtered.views.map(v=>v.snapshot.recordCount),[2,2]);assert.deepEqual(filtered.board.elements.map(e=>e.id),['volume','amount']);
  const restored=D.apply(filtered.board,{action:'dashboard_plan',operations:[{op:'remove_shared_filter',id:'alex'}],questions:[]},w.records,core,w.customFields,F.options);
  assert.deepEqual(restored.board,initial.board);assert.deepEqual(restored.views,initial.views);assert.equal(JSON.stringify(initial),before);
});

test('objective 13: sorted read focus retains exact IDs/order across storage reorder without writing rows',()=>{
  const w=F.freeze(F.workspace()),initial=prepare(w,[F.select('ranked',[],{orderBy:'f_value',direction:'desc'}),F.read('ranked',[{kind:'names',field:null},{kind:'fields',field:'f_value'}],true)]);
  const ids=[93,7,55,41,101,12];assert.deepEqual(initial.queryResults[0].recordIds,ids);
  assert.deepEqual(initial.effects[0],{kind:'table',show:true,ids});assert.equal(initial.mutates,false);assert.deepEqual(initial.next,w);
  const focus=F.freeze({kind:'table',id:'ranked_focus',ids:[...ids]}),changed=structuredClone(w);changed.records.reverse();changed.records.find(r=>r.id===41).f_value=999;
  const current=F.freeze(changed),follow=prepare(current,[F.select('same',[],{source:'focus'}),F.read('same',[{kind:'fields',field:'f_value'}])],{focus});
  assert.deepEqual(follow.queryResults[0].recordIds,ids);assert.equal(follow.queryResults[0].projected.find(r=>r.recordId===41).value,999);
  assert.equal(initial.queryResults[0].projected.find(r=>r.recordId===41).value,0);assert.equal(follow.mutates,false);assert.deepEqual(follow.next,current);assert.deepEqual(focus.ids,ids);
  const missing=structuredClone(w);missing.records=missing.records.filter(r=>r.id!==7);
  assert.throws(()=>prepare(missing,[F.select('same',[],{source:'focus'})],{focus}),/no longer exists/);assert.deepEqual(focus.ids,ids);
});

test('objective 16: missing-field reads reject without creating fields or changing any saved state',()=>{
  const w=F.freeze(F.workspace()),before=JSON.stringify(w);
  for(const steps of [
    [F.select('cohort'),F.read('cohort',[{kind:'median',field:'f_missing_budget'}])],
    [F.select('missing',[[F.where('f_missing_budget','gt',0)]]),F.read('missing',[{kind:'names',field:null}])]
  ])assert.throws(()=>prepare(w,steps),/field|column/i);
  assert.throws(()=>execute(w,F.spec('average',{measures:[{label:'Unavailable budget',metric:'average',field:'f_missing_budget',where:[]}]})),/column/i);
  const evidence=Review.evidence({pipeline:{...w,workspaceVersion:'saved_1'}},{assistantMessage:'Budget is not a stored field. No calculation or schema change was made.',crmAction:null});
  assert.equal(evidence.kind,'conversation');assert.equal(evidence.lifecycle.executed,false);assert.equal(evidence.lifecycle.writesApplied,0);assert.equal(evidence.lifecycle.requiresConfirmation,false);
  assert.equal(JSON.stringify(w),before);
});

test('objective 27: notes are exact current-cell evidence for every match, including duplicate names and inert markup',()=>{
  const w=F.freeze(F.workspace()),result=prepare(w,[F.select('found',[[F.where('f_notes','contains','compliance')]]),F.read('found',[{kind:'count',field:null},{kind:'names',field:null},{kind:'fields',field:'f_notes'}])]);
  assert.deepEqual(result.queryResults[0].recordIds,[41,93]);
  assert.deepEqual(result.queryResults[0].projected,w.records.filter(row=>[41,93].includes(row.id)).map(row=>({recordId:row.id,name:row.f_deal,fieldId:'f_notes',fieldName:'Notes',value:row.f_notes,source:'current_record'})));
  for(const row of w.records.filter(row=>[41,93].includes(row.id)))assert(result.answers[0].includes(row.f_notes));
  assert(!result.answers[0].includes('Budget review only.'));assert.equal(result.effects[0].show,false);assert.equal(result.mutates,false);assert.deepEqual(result.next,w);
  const html=P.render(result,escape,false);assert(html.includes('&lt;script&gt;inert source text&lt;/script&gt;'));assert(!html.includes('<script>'));
  const noMatches=prepare(w,[F.select('none',[[F.where('f_notes','contains','unfindable-token')]]),F.read('none',[{kind:'fields',field:'f_notes'}])]);
  assert.deepEqual(noMatches.queryResults[0].projected,[]);assert.match(noMatches.answers[0],/No matching records/);
});
