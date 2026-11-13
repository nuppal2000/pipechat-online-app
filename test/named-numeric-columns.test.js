'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const N=require('../lib/named-numeric-intent'),Review=require('../lib/action-review');
const Compact=require('../lib/scoped-table-request'),F=require('./fixtures/workspace-plans.cjs');
const names=['QA1113 Copper Books','QA1113 Silver Cafe','QA1113 Gold Repairs','QA1113 Bronze Bikes','Unrelated record','Hidden control'];
const fieldId='cf_seats';
const intent=(operation,fieldName,entries=[],leaveOthersBlank=true)=>({completeIntent:true,operation,fieldName,
  assignments:entries.map(([i,value])=>({name:names[i],value})),leaveOthersBlank,otherRequestedWork:false,ambiguity:false});
const add=name=>({id:'number',op:'add_field',label:'Untrusted title',name,type:'number',options:[]});
const select=i=>F.select('target_'+i,[[F.where('f_deal','equals',names[i])]]);
const assignments=entries=>entries.flatMap(([i,value])=>[select(i),F.update('set_'+i,'target_'+i,fieldId,value)]);
function prepare(action,configure){
  const pipeline={...F.workspace(),visibleIds:[5],workspaceVersion:'number-test',currentDate:'2026-11-13'};
  pipeline.records.forEach((row,i)=>{row.f_deal=names[i];});
  pipeline.customFields=[{id:'cf_license',name:'License seats',type:'number'}];
  pipeline.records.forEach(row=>{row.cf_license=row.id===1?12:null;});
  configure?.(pipeline);
  const snapshot=structuredClone(pipeline),normalized=N.normalizeAction(action,pipeline);
  const context={pipeline,computed:Review.evidence({pipeline},{crmAction:normalized})};
  assert.deepEqual(pipeline,snapshot,'preparing a proof never changes saved input');
  return {action:normalized,context};
}
function existing(pipeline){
  pipeline.customFields.push({id:fieldId,name:'Seats',type:'number'});
  pipeline.records.forEach(row=>{row[fieldId]=null;});
}

for(const [command,label] of [
  ['Add a number column named Seats.','Seats'],
  ['Add a number column called Delivery days. Leave it blank for existing accounts.','Delivery days'],
  ['Preview a new numeric field called Capacity.','Capacity']
])for(const native of [false,true])test('standalone Number definition: '+command+' native='+native,()=>{
  const action=native?F.plan([add(label)]):{action:'add_field',newFieldName:label,targetType:'number',dropdownOptions:[]};
  const state=prepare(action),i=intent('create',label);
  assert.equal(N.eligible(state.action),true);
  assert.equal(N.matches(i,state.action,state.context),true);
  assert.deepEqual(N.assess(i,state.action,state.context),{complete:true,ok:true,requested:1,compiled:1,issues:[]});
  assert.equal(state.context.computed.numericAssignmentEvidence.length,1);
  assert.deepEqual(state.context.computed.numericAssignmentEvidence.map(p=>[p.output,p.fieldName,p.fieldType,p.recordCount,p.populatedCount,p.blankCount]),
    [['numeric_field_definition',label,'number',6,0,6]]);
  assert.equal(state.context.computed.lifecycle.requiresConfirmation,true);
  assert.equal(state.context.computed.lifecycle.writesApplied,0);
  assert.deepEqual(state.context.computed.patches,[]);
});

test('standalone blank Number creation on an empty table still has a complete proof',()=>{
  const {action,context}=prepare(F.plan([add('Seats')]),p=>{p.records=[];p.visibleIds=[];});
  assert.equal(N.matches(intent('create','Seats'),action,context),true);
  assert.deepEqual(context.computed.numericAssignmentEvidence.map(p=>[p.recordCount,p.blankCount,p.populatedCount]),[[0,0,0]]);
});

test('existing similarly named fields are preserved and exact duplicate column names are rejected',()=>{
  const {context}=prepare(F.plan([add('Seats')]));
  assert.equal(context.computed.addedFields[0].name,'Seats');
  assert.equal(context.pipeline.customFields[0].name,'License seats');
  assert.throws(()=>prepare(F.plan([add('License seats')])),/already|exists/i);
});

test('new field plus distinct assignments preserves column-title identity and explicit zero',()=>{
  const entries=[[0,12],[1,0]],i=intent('create','QA1113 Seats',entries);
  const compiled=Compact.compile({action:'scoped_table_request',title:'Review',source:'all',where:[],operation:{kind:'add_named_numbers',
    name:i.fieldName,entries:i.assignments.map(a=>({recordName:a.name,value:a.value}))}});
  const {action,context}=prepare(compiled);
  assert.equal(N.matches(i,action,context),true);
  assert.equal(N.assess(i,action,context).requested,3);
  assert.deepEqual(context.computed.numericAssignmentEvidence.slice(1).map(p=>p.cells.map(c=>[c.primaryName,c.before,c.after])),
    [[[names[0],null,12]],[[names[1],null,0]]]);
  assert.equal(N.matches({...i,assignments:[]},action,context),false,'cannot silently omit requested population');
  const standalone=prepare(F.plan([add(i.fieldName)]));
  assert.equal(N.matches(i,standalone.action,standalone.context),false,'a blank definition does not fulfill assignments');
});

for(const entries of [[[0,12],[1,0]],[[3,-4.5],[2,18.25]]])test('existing named Number assignments: '+JSON.stringify(entries),()=>{
  const state=prepare(F.plan(assignments(entries)),existing),i=intent('assign','Seats',entries);
  assert.equal(N.eligible(state.action),true);
  assert.equal(N.matches(i,state.action,state.context),true);
  assert.equal(N.assess(i,state.action,state.context).requested,2);
  assert.equal(state.context.computed.addedFields.length,0);
  assert.deepEqual(state.context.computed.numericAssignmentEvidence.map(p=>p.cells[0].after),entries.map(a=>a[1]));
  assert.deepEqual(state.context.computed.patches.map(p=>p.id),entries.map(a=>a[0]+1).sort((a,b)=>a-b));
  assert.equal(state.context.pipeline.records[0].cf_license,12);
  assert.equal(N.matches({...i,operation:'create'},state.action,state.context),false);
  assert.equal(N.matches({...i,fieldName:'License seats'},state.action,state.context),false,'similar labels are not interchangeable');
});

test('legacy numeric edits compile exact names or resolved IDs without widening the population',()=>{
  for(const selector of [i=>({recordMatch:names[i],ids:null}),i=>({recordMatch:null,ids:[i+1]})]){
    const a={action:'update_records',title:'Review changes',changes:[[0,12],[1,0]].map(([i,value])=>({
      ...selector(i),filter:null,field:fieldId,operation:'set',value}))};
    const state=prepare(a,existing);
    assert.equal(state.action.action,'workspace_plan');
    assert.equal(N.matches(intent('assign','Seats',[[0,12],[1,0]]),state.action,state.context),true);
  }
});

test('unchanged numeric targets remain proven including zero and a completely no-op plan',()=>{
  for(const both of [false,true]){
    const {action,context}=prepare(F.plan(assignments([[0,12],[1,0]])),p=>{existing(p);p.records[1][fieldId]=0;if(both)p.records[0][fieldId]=12;});
    assert.equal(N.matches(intent('assign','Seats',[[0,12],[1,0]]),action,context),true);
    assert.equal(context.computed.patches.length,both?0:1);
    assert.equal(context.computed.numericAssignmentEvidence.length,2);
  }
});

test('leave rest blank never authorizes clearing an existing nonblank control or considers zero blank',()=>{
  for(const value of [8,0]){
    const state=prepare(F.plan(assignments([[0,12],[1,0]])),p=>{existing(p);p.records[5][fieldId]=value;});
    const i=intent('assign','Seats',[[0,12],[1,0]]);
    assert.equal(N.matches(i,state.action,state.context),false);
    assert.equal(N.matches({...i,leaveOthersBlank:false},state.action,state.context),true);
  }
});

test('missing, extra, swapped, fuzzy, duplicate and wrong-column edits cannot borrow the numeric proof',()=>{
  const i=intent('assign','Seats',[[0,12],[1,0]]),base=F.plan(assignments([[0,12],[1,0]]));
  for(const edit of [a=>a.steps.splice(2),a=>a.steps.push(...assignments([[2,0]])),
    a=>a.steps[1].assignments[0].value=0,a=>a.steps[3].assignments[0].field='cf_license',
    a=>a.steps[0].source='visible',a=>a.steps[0].limit=1,a=>a.steps.push(F.tasks('task','target_0'))]){
    const a=structuredClone(base);edit(a);
    const state=prepare(F.plan(a.steps),existing);
    assert.equal(N.matches(i,state.action,state.context),false,edit.toString());
  }
  const duplicated=prepare(base,p=>{existing(p);p.records[5].f_deal=names[0].toUpperCase();});
  assert.equal(N.matches(i,duplicated.action,duplicated.context),false);
  const state=prepare(base,existing);
  for(const bad of [{...i,assignments:[{name:'Copper',value:12},{name:names[1],value:0}]},
    {...i,assignments:[]},{...i,otherRequestedWork:true},{...i,ambiguity:true},{...i,operation:null}])
    assert.equal(N.matches(bad,state.action,state.context),false);
  assert.equal(N.matches(i,state.action,{...state.context,computed:structuredClone(state.context.computed)}),false);
});

test('normalization leaves unsupported/mixed transports untouched rather than dropping obligations',()=>{
  const p=F.workspace();existing(p);
  const base={action:'add_field',targetType:'number',newFieldName:'Seats',dropdownOptions:[]};
  for(const extra of [{changes:[{field:'f_notes',value:'Also do this'}]},{ids:[1]},{filter:{field:'f_owner',value:'Alex'}},
    {question:'Also confirm this?'},{assumptions:['Infer the rest']},{dropdownOptions:['A']},{targetType:'text'},{extra:'unrecognized'}]){
    const a={...base,...extra};assert.equal(N.normalizeAction(a,p),a);
  }
  const update={action:'update_records',changes:[{recordMatch:names[0],ids:null,filter:null,field:fieldId,value:12,operation:'set'}]};
  p.records[0].f_deal=names[0];
  for(const edit of [a=>a.changes[0].filter={field:'f_owner',value:'Alex'},a=>a.changes[0].recordMatch='Copper',
    a=>a.changes[0].ids=[2],a=>a.changes[0].value='',a=>a.changes[0].field='f_value',a=>a.changes[0].operation='append',
    a=>a.changes.push({...a.changes[0],field:'cf_license'})]){
    const a=structuredClone(update);edit(a);assert.equal(N.normalizeAction(a,p),a,edit.toString());
  }
});
