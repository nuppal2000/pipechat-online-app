'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Typed=require('../lib/scoped-table-request'),Review=require('../lib/action-review');
const F=require('./fixtures/workspace-plans.cjs');
const pipeline=()=>({...F.workspace(),visibleIds:[6],currentDate:'2026-11-10',timezone:'UTC'});
const condition=(field,operator,value,values=[])=>({field,operator,value,values});
function prepare(p,operation,where=[]){
  const action=Typed.compile({action:'scoped_table_request',title:'Fixture',source:'all',where,operation});
  const result={crmAction:action},computed=Review.evidence({pipeline:p},result);
  return {action,computed,result};
}
test('a fresh list uses exactly one full-table selection for its table, ordered names and total',()=>{
  const p=pipeline();
  p.records[1].f_owner='Jo';p.records[3].f_owner='Jo';p.records[4].f_owner='Jo';
  const {computed}=prepare(p,{kind:'show_rows',orderBy:'f_value',direction:'desc',outputs:[{kind:'sum',field:'f_value'}]},
    [[condition('f_owner','equals','Jo'),condition('f_stage','in',null,['Qualified','Negotiation'])]]);
  assert.deepEqual(computed.effects.find(e=>e.kind==='table').ids,[4,2,5]);
  assert.deepEqual(computed.queryResults[0].recordIds,[4,2,5]);assert.match(computed.answers.join(' '),/84,000/);
  assert.equal(computed.mutates,false);
});
test('complementary threshold branches preserve unknown values including in scoped exclusion evidence',()=>{
  const p=pipeline();p.records[0].f_value=null;
  for(const [operator,high,low] of [['gte',[3,4,6],[2,5]],['gt',[3,6],[2,4,5]],['lt',[2,5],[3,4,6]],['lte',[2,4,5],[3,6]]]){
    const {computed,action,result}=prepare(p,{kind:'classify_number',numberField:'f_value',operator,threshold:50000,targetField:'f_priority',whenTrue:'High',otherwise:'Medium',whenBlank:'unchanged'});
    const ids=id=>computed.review.find(step=>step.id===id).records.map(r=>r.id);
    assert.deepEqual(ids('match'),high);assert.deepEqual(ids('otherwise'),low);
    assert(computed.constraintEvidence.some(e=>e.id==='unchanged:records:blank:f_value'&&e.count===1));
    action.steps.push(F.update('unsafe','population','f_priority','Medium'));action.goals.push({description:'Unsafe',stepIds:['unsafe']});
    const altered=Review.evidence({pipeline:p},result);assert(!altered.constraintEvidence.some(e=>e.id==='unchanged:records:blank:f_value'));
  }
});
test('relative shifts start from each original date, including different weekdays in one cohort',()=>{
  const p=pipeline();p.records[0].f_follow='2026-11-06';p.records[1].f_follow='2026-11-09';
  const {computed}=prepare(p,{kind:'shift_saved_dates',field:'f_follow',dateMode:'business_days',offset:1,blankPolicy:'error'},
    [[condition('f_deal','in',null,[p.records[0].f_deal,p.records[1].f_deal])]]);
  assert.deepEqual(computed.recordTransformEvidence[0].cells.map(c=>[c.before,c.after]),[['2026-11-06','2026-11-09'],['2026-11-09','2026-11-10']]);
  assert.equal(computed.lifecycle.executed,false);
});
