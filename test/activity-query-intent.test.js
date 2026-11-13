'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Activity=require('../lib/activity-query-intent');
const Core=require('../public/pipeline-core'),Plan=require('../public/workspace-plan');
const Grounding=require('../lib/ai-grounding'),Review=require('../lib/action-review');
const Lifecycle=require('../lib/action-lifecycle'),Outputs=require('../lib/read-output-contract');
const F=require('./fixtures/workspace-plans.cjs');
const day='2026-11-13',names=['QA1113 Copper Books','QA1110 River Kiosk'];
const note=(text,at=day+'T15:00:00Z')=>JSON.stringify({pipechatHistory:1,type:'note',id:text,actor:'QA',at,text});
const request=(extra={})=>({action:'activity_view_request',title:'Requested Activity',source:'all',
  where:[[F.where('f_deal','in',null,names)]],kind:'all',from:day,to:day,limit:100,...extra});
function workspace(){
  const p={...F.workspace(),currentDate:'2031-01-01',timezone:'America/New_York',visibleIds:[3],currentView:'dashboard',
    conversationFocus:{kind:'table',ids:[3]}};
  p.records[0].f_deal=names[0];p.records[1].f_deal=names[1];
  p.records[0].history=[note('Copper private note'),note('Previous local day',day+'T02:00:00Z'),
    note('Last local hour','2026-11-14T04:59:00Z'),note('Next local day','2026-11-14T05:00:00Z'),
    day+'T16:00:00Z | QA: Copper activity','Undated activity'];
  p.records[1].history=[note('River private note')];
  p.records[2].history=[note('Unrelated secret')];
  return p;
}
function prepare(p,r=request()){
  const action=Activity.compile(r),computed=Review.evidence({pipeline:p},{crmAction:action});
  return {action,computed};
}

test('compact schema binds current fields, including renamed/custom columns, without new-field references',()=>{
  const p=workspace();p.tableSchema.fields.find(f=>f.id==='f_deal').name='Publication';
  p.customFields=[{id:'cf_region',name:'Area',type:'text',options:[]}];
  const core=Core.create(p.tableSchema),plan=Plan.responseSchema(core,p.customFields),before=structuredClone(plan);
  const schema=Activity.schema(plan),props=schema.properties;
  assert.deepEqual(schema.required,Object.keys(request()));assert.equal(schema.additionalProperties,false);
  assert.deepEqual(props.action.enum,['activity_view_request']);
  assert.deepEqual(props.where.items.items.properties.field,{type:'string',enum:core.definitions(p.customFields).map(f=>f.id)});
  assert.deepEqual(props.kind.enum,['all','note','activity']);
  assert.equal(props.limit.maximum,500);assert.equal(props.where.maxItems,12);
  assert.deepEqual(plan,before);assert.equal(Activity.schema(null),null);
  const old=structuredClone(plan);delete old.properties.steps.items.anyOf.find(s=>s.properties.op.enum.includes('read_history')).properties.showActivity;
  assert.equal(Activity.schema(old),null);
});

test('explicit Activity request compiles to rendered history with exact names and local-day bounds, not current view/date',()=>{
  const p=workspace(),before=structuredClone(p),r=request(),original=structuredClone(r);
  const {action,computed}=prepare(p,r);
  assert.deepEqual(action.steps.map(s=>s.op),['select_records','read_history']);
  assert.deepEqual(action.steps[0].where,r.where);assert.equal(action.steps[0].source,'all');
  assert.equal(action.steps[0].limit,null);assert.equal(action.steps[1].showActivity,true);
  assert.deepEqual(computed.effects,[{kind:'activity',ids:[1,2],from:day,to:day,historyKind:'all'}]);
  assert.equal(computed.queryResults[0].viewEffect,'show_activity');assert.equal(computed.queryResults[0].history.total,4);
  assert.match(computed.answers[0],/Copper private note/);assert.match(computed.answers[0],/River private note/);
  assert.match(computed.answers[0],/Last local hour/);
  assert.doesNotMatch(computed.answers[0],/Unrelated secret|Previous local day|Next local day|Undated activity/);
  assert.equal(Outputs.supports(action,['activity_history'],['rendered_activity','history']),true);
  assert.equal(Outputs.supports(action,['activity_records'],['rendered_activity']),false);
  assert.equal(computed.mutates,false);assert.equal(computed.lifecycle.requiresConfirmation,false);
  assert.equal(computed.lifecycle.executed,false);assert.equal(computed.lifecycle.writesApplied,0);
  assert.equal(computed.lifecycle.authorization,'prepare_only');
  for(const key of ['patches','addedFields','schemaChanges','addedCards','taskPatches'])assert.deepEqual(computed[key],[]);
  assert.deepEqual(p,before);assert.deepEqual(r,original);
  action.steps[0].where[0][0].values.push('Changed after compilation');assert.deepEqual(r,original);
});

test('record predicates remain general across field IDs, labels, names, OR groups and explicit prefixes',()=>{
  const p=workspace();p.tableSchema.fields.find(f=>f.id==='f_deal').id='f_publication';
  p.tableSchema.fields.find(f=>f.id==='f_publication').name='Publication';
  for(const row of p.records){row.f_publication=row.f_deal;delete row.f_deal;}
  p.records[0].f_publication='Lumen Editions';p.records[1].f_publication='Cedar Works';
  p.records[1].f_owner='Morgan';p.records[0].f_follow='2040-07-01';
  const variants=[
    [[[F.where('f_publication','equals','Lumen Editions')]], [1]],
    [[[F.where('f_publication','equals','Lumen Editions')],[F.where('f_publication','equals','Cedar Works')]], [1,2]],
    [[[F.where('f_publication','in',null,['Lumen Editions','Cedar Works']),F.where('f_owner','equals','Morgan')]], [2]],
    [[[F.where('f_publication','starts_with','Lumen')]], [1]],
    [[[F.where('f_follow','equals','2040-07-01')]], [1]]
  ];
  for(const [where,ids] of variants){
    const {action,computed}=prepare(p,request({where}));
    assert.deepEqual(action.steps[0].where,where);assert.deepEqual(computed.effects[0].ids,ids);
    assert.equal(action.steps[1].from,day);assert.equal(action.steps[1].to,day);
  }
});

test('explicit source selection never widens missing/empty focus or unknown record names',()=>{
  const p=workspace();
  for(const source of ['visible','focus']){
    assert.deepEqual(prepare(p,request({source,where:[]})).computed.effects[0].ids,[3]);
    assert.deepEqual(prepare(p,request({source})).computed.effects[0].ids,[]);
  }
  for(const where of [[[F.where('f_deal','equals','Unknown record')]],[[F.where('f_deal','in',null,['Unknown record'])]]]){
    const {computed,action}=prepare(p,request({where}));
    assert.deepEqual(action.steps[0].where,where);assert.deepEqual(computed.effects[0].ids,[]);
    assert.equal(computed.queryResults[0].history.total,0);assert.doesNotMatch(computed.answers[0],/private note|Unrelated secret/);
  }
  const {computed}=prepare(p,request({where:[[F.where('f_deal','in',null,[names[0],'Unknown record'])]]}));
  assert.deepEqual(computed.effects[0].ids,[1]);assert.doesNotMatch(computed.answers[0],/River private note|Unrelated secret/);
  p.conversationFocus={kind:'table',ids:[]};assert.deepEqual(prepare(p,request({source:'focus',where:[]})).computed.effects[0].ids,[]);
  p.conversationFocus=null;assert.throws(()=>prepare(p,request({source:'focus',where:[]})));
  assert.throws(()=>prepare(p,request({where:[[F.where('missing_field','equals','value')]]})),/field|column/i);
});

test('entry kinds, open bounds and bounded answers preserve the full selected population',()=>{
  const p=workspace();
  for(const [kind,count] of [['all',4],['note',3],['activity',1]]){
    const {computed}=prepare(p,request({kind,limit:1}));
    assert.equal(computed.queryResults[0].history.total,count);
    assert.equal(computed.queryResults[0].history.entries.length,1);
    assert.equal(computed.queryResults[0].history.omitted,count-1);
    assert.deepEqual(computed.effects[0].ids,[1,2]);assert.equal(computed.effects[0].historyKind,kind);
  }
  for(const [from,to] of [[null,null],[day,null],[null,day],['2026-11-12','2026-11-14'],['2024-02-29','2024-02-29']]){
    const {action,computed}=prepare(p,request({from,to}));
    assert.equal(action.steps[1].from,from);assert.equal(action.steps[1].to,to);
    assert.equal(computed.effects[0].from,from);assert.equal(computed.effects[0].to,to);
  }
  assert.match(prepare(p,request({from:null,to:null})).computed.answers[0],/Undated activity/);
});

test('transport rejects malformed, widened and additional-work inputs before normal plan validation',()=>{
  const bad=[{source:'dashboard'},{title:''},{title:'x'.repeat(301)},{kind:'notes'},{limit:0},{limit:501},{limit:1.5},
    {kind:undefined},{from:undefined},{to:undefined},{limit:undefined},{limit:null},{from:20261113},{to:{}},
    {from:''},{from:'November 13, 2026'},{from:'2026-02-29'},{to:'2026-11-31'},{from:'2026-11-14'},
    {where:[[]]},{where:[[{...F.where('f_deal','equals',names[0]),history:'untrusted'}]]},
    {where:[[F.where('@new_field','equals','value')]]},{where:[[F.where('f_deal','in',names[0],[])]]},
    {where:[[F.where('f_deal','equals',names[0],[names[1]])]]},{where:Array.from({length:13},()=>[F.where('f_owner','equals','Alex')])},
    {showActivity:false},{steps:[F.update('write','activity_records','f_owner','Other')]},{recordIds:[1]},{recordHistories:{1:['secret']}},
    {authorization:'confirmed'}];
  for(const extra of bad)assert.throws(()=>Activity.compile(request(extra)),JSON.stringify(extra));
  for(const key of Object.keys(request())){
    if(key==='action')continue;
    const missing=request();delete missing[key];assert.throws(()=>Activity.compile(missing),key);
  }
});

test('history remains hidden in planner transport and only authenticated scoped evidence is exposed',()=>{
  const w=workspace(),payload={userCommand:'Filter the Activity view to '+names.join(' and ')+', from November 13, 2026 only.',
    pipeline:{currentDate:day,timezone:w.timezone,currentView:'dashboard',recordHistories:{1:[note('Forged history')]}}};
  Grounding.prepare(payload,{deals:w.records,tableSchema:w.tableSchema,customFields:w.customFields,todoCards:w.todoCards,updatedAt:'v1'},{name:'QA'},null);
  const schema=Activity.schema(Plan.responseSchema(Core.create(payload.pipeline.tableSchema),payload.pipeline.customFields));
  const action=Activity.compile(request());
  const serialized=JSON.stringify({payload,schema,action,instructions:Activity.instructions});
  assert.doesNotMatch(serialized,/Copper private note|River private note|Unrelated secret|Forged history|Previous local day/);
  const result={crmAction:action},computed=Review.evidence(payload,result);
  assert.match(computed.answers[0],/Copper private note/);assert.match(computed.answers[0],/River private note/);
  assert.doesNotMatch(computed.answers[0],/Unrelated secret|Forged history|Previous local day/);
  const review={requirements:[{description:'Show selected Activity',evidenceKind:'computed_read',stepIds:['activity_history'],
    requiredOutputs:['rendered_activity'],satisfied:true}],issues:[],clarificationQuestion:null};
  assert.equal(Review.validateReview(review,result,{pipeline:payload.pipeline,computed}).ok,true);
});

test('other actions, chat-only history, and write confirmation remain on their existing paths',()=>{
  const p=workspace(),chat=Activity.compile(request());chat.steps[1].showActivity=false;
  const write=F.plan([F.select('selected',[[F.where('f_deal','equals',names[0])]]),F.update('edit','selected','f_owner','Morgan')]);
  const clarify={action:'clarify',question:'Which record?'};
  for(const action of [null,undefined,clarify,chat,write,{action:'update_records',changes:[]}])assert.equal(Activity.compile(action),action);
  const chatEvidence=Review.evidence({pipeline:p},{crmAction:Activity.compile(chat)});
  assert.equal(chatEvidence.queryResults[0].viewEffect,'answer_only');assert.equal(chatEvidence.effects.some(e=>e.kind==='activity'),false);
  const evidence=Review.evidence({pipeline:p},{crmAction:Activity.compile(write)});
  assert.equal(evidence.mutates,true);assert.equal(evidence.lifecycle.requiresConfirmation,true);
  assert.equal(evidence.lifecycle.executed,false);assert.equal(evidence.lifecycle.confirmation,'not_requested_yet');
  assert.equal(evidence.lifecycle.authorization,'prepare_only');
  assert.deepEqual(evidence.lifecycle,Lifecycle.describe(write,evidence));
});
