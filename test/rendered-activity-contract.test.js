'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Outputs=require('../lib/read-output-contract');
const history=extra=>({op:'read_history',id:'history',label:'History',selection:'records',kind:'all',
  from:'2026-11-13',to:'2026-11-13',limit:500,...extra});
const plan=(...steps)=>({action:'workspace_plan',version:1,title:'History',steps});

test('rendered_activity is available only on a typed, explicitly displayed history read',()=>{
  assert(Outputs.schema.items.enum.includes('rendered_activity'));
  for(const [extra,expected] of [[{},false],[{showActivity:false},false],[{showActivity:true},true]]){
    const action=plan(history(extra));
    assert.equal(Outputs.supports(action,['history'],['history','count','names','notes']),true);
    assert.equal(Outputs.supports(action,['history'],['rendered_activity']),expected);
  }
  const activityOnly=plan(history({kind:'activity',showActivity:true}));
  assert.equal(Outputs.supports(activityOnly,['history'],['rendered_activity','history']),true);
  assert.equal(Outputs.supports(activityOnly,['history'],['notes']),false);
});

test('prose, truthy strings, another history answer and unreferenced displays do not prove visible Activity',()=>{
  for(const showActivity of ['true',1,null,{},[]]){
    assert.equal(Outputs.supports(plan(history({showActivity})),['history'],['rendered_activity']),false);
    assert.equal(Outputs.supports(plan(history({showActivity})),['history'],['history']),false);
  }
  const action=plan(history({label:'Activity view is shown',showActivity:false}),history({id:'display',showActivity:true}));
  assert.equal(Outputs.supports(action,['history'],['rendered_activity']),false);
  assert.equal(Outputs.supports(action,['display'],['rendered_activity']),true);
  assert.equal(Outputs.supports(action,['root'],['rendered_activity']),false);
});
