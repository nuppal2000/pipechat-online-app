'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Plan=require('../public/workspace-plan'),F=require('./fixtures/workspace-plans.cjs');
const Output=require('../lib/read-output-contract');

test('fresh grouped comparison includes the requested difference without inheriting visible rows or replacing charts',()=>{
  for(const [left,right,values,gap] of [
    ['Sam','Alex',[12000,30000,0,8000,20000,null],6000],
    ['Aster','Briar',[14000,40000,0,5000,20000,null],11000]
  ]){
    const w=F.workspace(),owners=[right,left,right,left,right,''];
    w.records.forEach((r,i)=>Object.assign(r,{f_deal:'Cohort '+i,f_owner:owners[i],f_value:values[i]}));
    const before=structuredClone(w),spec={version:1,title:'Owner comparison',chart:'bar',scope:'all',groupBy:'f_owner',bucket:'none',splitBy:null,
      where:[],sort:'label_asc',limit:null,measures:[{label:'Deal value',metric:'sum',field:'f_value',where:[]}]};
    const ref=group=>({elementId:'totals',measure:0,stat:'group',group,series:null});
    const action=F.plan([F.select('cohort',[[F.where('f_deal','starts_with','Cohort'),F.where('f_owner','in',null,[left,right])]]),
      {op:'report',id:'totals',label:'Compare owners',selection:'cohort',spec,showDashboard:false,questions:[
        {kind:'groups',elementId:'totals',measure:0},
        {kind:'value',label:'Higher owner',reference:{elementId:'totals',measure:0,stat:'maximum'}},
        {kind:'difference',label:'Owner gap',left:ref(left),right:ref(right)}]}]);
    const result=Plan.prepare(w,action,{today:'2026-11-10',visibleIds:[1],nonce:'compare'});
    assert.deepEqual(w,before);assert.equal(result.mutates,false);
    assert.equal(result.queryResults[0].recordIds.length,5);
    assert(!result.effects.some(e=>e.kind==='dashboard'));
    assert.match(result.answers.join('\n'),new RegExp('Owner gap: \\$'+gap.toLocaleString('en-US')+'\\.00'));
    assert.match(result.answers.join('\n'),new RegExp(left+'.*largest'));
    assert.equal(Output.supports(action,['totals'],['sum','groups','max','difference']),true);
    const incomplete=structuredClone(action);incomplete.steps[1].questions.pop();
    assert.equal(Output.supports(incomplete,['totals'],['difference']),false);
  }
});
