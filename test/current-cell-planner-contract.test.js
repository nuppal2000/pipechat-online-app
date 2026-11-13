'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module');
const Scoped=require('../lib/scoped-table-request'),Review=require('../lib/action-review');
const Plan=require('../public/workspace-plan'),Core=require('../public/pipeline-core');
const F=require('./fixtures/workspace-plans.cjs');
const object=properties=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
const schema=(table=F.schema,custom=[])=>object({assistantMessage:{type:'string'},crmAction:{anyOf:[{type:'null'},Plan.responseSchema(Core.create(table),custom)]},memoryNote:{type:['string','null']}});
const projection=model=>model.properties.crmAction.anyOf.find(branch=>branch.properties?.action.enum.includes('scoped_table_request'));
const readValues=branch=>branch.properties.operation.anyOf.find(operation=>operation.properties.kind.enum.includes('read_values'));
const request=()=>({action:'scoped_table_request',title:'Current delivery fields',source:'all',
  where:[[F.where('f_deal','equals','Orchid Studio')]],operation:{kind:'read_values',fields:['cf_delivery','f_value']}});
function fixture(){
  const pipeline={...F.workspace(),currentDate:'2026-11-13',timezone:'UTC',workspaceVersion:'current',visibleIds:[2]};
  pipeline.customFields=[{id:'cf_delivery',name:'Dispatch wording',type:'text'}];
  pipeline.records[0].f_deal='Orchid Studio';
  pipeline.records[0].cf_delivery='  Preserve indentation.\n\nDelivery: Tuesday.\n';
  pipeline.records[0].f_value=0;
  Object.defineProperty(pipeline,'recordHistories',{value:new Map([[1,['2026-11-01T10:00:00.000Z | QA: Historical wording only.']]])});
  return {userCommand:'Read the saved Dispatch wording and Value cells for Orchid Studio exactly, including all lines. Do not use history or change anything.',
    conversationHistory:[{role:'assistant',content:'Old chat text must not supply the saved answer.'}],pipeline};
}
const outcome=(stepId='root',outputs=['fields'])=>({description:'Return the complete requested current cells',
  evidenceKind:'computed_read',stepIds:[stepId],requiredOutputs:outputs,satisfied:true});
const review=requirements=>({requirements,issues:[],clarificationQuestion:null,answerIntent:'canonical',answerSelection:null});
function strict(node){
  if(!node||typeof node!=='object')return;
  if(node.type==='object'){
    assert.equal(node.additionalProperties,false);
    assert.deepEqual([...node.required].sort(),Object.keys(node.properties).sort());
  }
  for(const value of Object.values(node))if(value&&typeof value==='object')strict(value);
}

test('the live model envelope chooses typed evidence before prose without losing conversation-only replies',()=>{
  for(const table of [null,F.schema]){
    const original=schema(table,[{id:'cf_dispatch',name:'Dispatch wording',type:'text'}]),before=structuredClone(original);
    const model=Review.modelSchema(original);strict(model);
    assert.deepEqual(Object.keys(model.properties),['crmAction','assistantMessage','memoryNote']);
    assert.deepEqual(model.required,['crmAction','assistantMessage','memoryNote']);
    assert.match(model.properties.crmAction.description,/READS ARE ACTIONS/);
    assert.match(model.properties.assistantMessage.description,/executor renders the answer/);
    const nulls=model.properties.crmAction.anyOf.filter(branch=>branch.type==='null');
    assert.equal(nulls.length,1);assert.match(nulls[0].description,/Do not choose null for an available current-cell read/);
    assert.match(projection(model).properties.action.description,/read_values/);
    assert.match(readValues(projection(model)).description,/read-only chat answer/);
    assert(readValues(projection(model)).properties.fields.items.enum.includes('cf_dispatch'));
    assert.deepEqual(original,before);
  }
});

test('projection fields come from readable columns, independently of sortable fields',()=>{
  const plan=Plan.responseSchema(Core.create(F.schema));
  const select=plan.properties.steps.items.anyOf.find(step=>step.properties.op.enum.includes('select_records'));
  select.properties.orderBy={anyOf:[{type:'string',enum:['f_value']},{type:'null'}]};
  const fields=readValues(Scoped.schema(plan)).properties.fields.items.enum;
  assert(fields.includes('f_notes'));assert(fields.includes('f_stage'));assert(fields.includes('f_follow'));
  assert(fields.includes('f_value'));assert(!fields.some(field=>field.startsWith('@')));
});

test('a null action cannot satisfy a current-cell read and repair asks for an actual projection',()=>{
  const payload=fixture(),result={crmAction:null,assistantMessage:payload.pipeline.records[0].cf_delivery};
  const computed=Review.evidence(payload,result),context={pipeline:payload.pipeline,computed};
  const checked=Review.validateReview(review([outcome()]),result,context);
  assert.equal(checked.ok,false);assert.equal(checked.requested,1);assert.equal(checked.compiled,0);
  assert.equal(checked.mappingReasons.no_evidence_action,1);
  assert.match(checked.mappingIssues[0],/Repair crmAction, not just assistantMessage/);
  assert.match(checked.mappingIssues[0],/kind:read_values,fields:\[existing field IDs\]/);
  assert.match(checked.mappingIssues[0],/retain preservation constraints/);
  assert.match(checked.mappingIssues[0],/For a history request use read_history/);
  assert.match(Review.schemaFor(null,context).properties.requirements.items.description,/satisfied false until repaired/);
  assert.equal(Review.renderAnswer(payload,result,computed),null);
});

test('extra preview constraints do not turn a missing read into evidence or weaken its repair',()=>{
  const payload=fixture(),result={crmAction:null,assistantMessage:'Nothing changed.'};
  const computed=Review.evidence(payload,result),context={pipeline:payload.pipeline,computed};
  const constraint={description:'No execution',evidenceKind:'constraint',stepIds:['lifecycle:preview_only'],requiredOutputs:['preview_only'],satisfied:true};
  const checked=Review.validateReview(review([outcome(),constraint]),result,context);
  assert.equal(checked.ok,false);assert.equal(checked.requested,2);assert.equal(checked.compiled,1);
  assert.equal(checked.mappingReasons.no_evidence_action,1);assert.match(checked.mappingIssues[0],/No typed saved-data read was compiled/);
});

test('conversation-only advice and honest unavailable-capability explanations still pass',()=>{
  for(const message of ['Keep delivery notes concise.','That column is not present in the current schema.']){
    const payload=fixture(),result={crmAction:null,assistantMessage:message},computed=Review.evidence(payload,result);
    const checked=Review.validateReview(review([{description:message,evidenceKind:'conversation',stepIds:['root'],requiredOutputs:[],satisfied:true}]),result,{pipeline:payload.pipeline,computed});
    assert.equal(checked.ok,true);assert.equal(Scoped.compile(null),null);
  }
});

test('planner and reviewer share the read/action boundary and restrict history fallback to source-unspecified facts',()=>{
  for(const instructions of [Review.compilerInstructions,Review.instructions]){
    assert(instructions.startsWith('READS ARE ACTIONS:'));
    assert.match(instructions,/fallback does NOT apply to explicit current-cell projections or requests excluding history/);
    assert.doesNotMatch(instructions,/QA111[03]|Orchid Studio|Dispatch wording/);
  }
  assert(Scoped.instructions.startsWith('CURRENT SAVED CELL READS:'));
  assert.match(Scoped.instructions,/read_values returns the complete requested current cells/);
});

// Exercise the real server planner/repair path in this realm, with startup
// removed and fetch replaced. No socket, provider, credentials or storage writes.
function harness(planner,reviewer){
  const filename=path.join(__dirname,'../server.js'),source=fs.readFileSync(filename,'utf8'),localRequire=createRequire(filename);
  const startup=source.lastIndexOf('start().catch(');assert(startup>0);
  const calls=[],logs=[],assertions=[];
  const requireOffline=name=>name==='node:http'?{createServer:()=>({})}:localRequire(name);
  const fetchOffline=async(url,options)=>{
    assert.equal(url,'https://api.openai.com/v1/responses');
    const body=JSON.parse(options.body),input=JSON.parse(typeof body.input==='string'?body.input:body.input[0].content[0].text);
    const name=body.text.format.name;calls.push({name,body,input});
    let result;
    try{
      assert(['pipechat_response','pipechat_action_review'].includes(name),'Unexpected auxiliary model call: '+name);
      result=await (name==='pipechat_response'?planner:reviewer)(input,body);
      if(name==='pipechat_action_review'&&body.text.format.schema.properties.presentationIntent)
        result={...result,presentationIntent:{status:'not_requested',elements:[]}};
    }catch(error){assertions.push(error);throw error;}
    return {ok:true,json:async()=>({output_text:JSON.stringify(result)})};
  };
  const load=vm.compileFunction(source.slice(0,startup)+'\nreturn planPipeChatAction;',
    ['require','process','fetch','__dirname','console'],{filename});
  const plan=load(requireOffline,{env:{PIPECHAT_STORAGE_PROVIDER:'json',OPENAI_API_KEY:'OFFLINE_FIXTURE_ONLY',NODE_ENV:'test'}},
    fetchOffline,path.dirname(filename),{log:line=>logs.push(JSON.parse(line)),warn:line=>logs.push(JSON.parse(line))});
  return {calls,logs,plan:async payload=>{
    try{return await plan(payload,{tier:'complex',model:'gpt-5.2',reason:'offline_test'});}
    finally{if(assertions.length)throw assertions[0];}
  }};
}

test('offline server carries null-action repair into a canonical multiline projection with zero writes',async()=>{
  const payload=fixture(),before=structuredClone(payload.pipeline);let attempts=0;
  const h=harness((input,body)=>{
    assert.equal(Object.keys(body.text.format.schema.properties)[0],'crmAction');
    assert.match(body.instructions,/READS ARE ACTIONS/);
    assert.match(readValues(projection(body.text.format.schema)).description,/read-only chat answer/);
    if(attempts++===0)return {crmAction:null,assistantMessage:'Provisional text without evidence.',memoryNote:null};
    assert.match(input.compilerRepair.issues.join(' '),/Repair crmAction, not just assistantMessage/);
    assert.match(input.compilerRepair.issues.join(' '),/kind:read_values/);
    assert.equal(input.userCommand,payload.userCommand);
    return {crmAction:request(),assistantMessage:'Do not use this provisional wording as the saved answer.',memoryNote:null};
  },input=>{
    if(input.compiled===null)return review([outcome()]);
    assert.deepEqual(input.compiled.steps.map(step=>step.op),['select_records','read_records']);
    assert.equal(input.compiled.steps[1].showTable,false);
    assert.equal(input.computed.mutates,false);
    assert.deepEqual(input.computed.recordReadEvidence[0].recordIds,[1]);
    assert.doesNotMatch(JSON.stringify(input.computed),/Historical wording only|Old chat text/);
    return review([outcome('current_values'),{description:'Keep saved records unchanged',evidenceKind:'constraint',
      stepIds:['unchanged:records'],requiredOutputs:['unchanged_records'],satisfied:true}]);
  });
  const result=await h.plan(payload);
  assert.equal(attempts,2);assert.equal(result.crmAction?.action,'workspace_plan',JSON.stringify({result,logs:h.logs}));
  assert.deepEqual(result.coverage,{requested:2,compiled:2});
  assert(result.computedAnswer.includes(payload.pipeline.records[0].cf_delivery));
  assert.doesNotMatch(result.computedAnswer,/provisional|Historical wording|Old chat text/);
  assert.equal(result.lifecycle.writesApplied,0);assert.equal(result.lifecycle.requiresConfirmation,false);
  assert.deepEqual(payload.pipeline,before);
  assert.deepEqual(h.calls.map(call=>call.name),['pipechat_response','pipechat_action_review','pipechat_response','pipechat_action_review']);
  const failures=h.logs.filter(log=>log.event==='pipechat.validation');
  assert.equal(failures.length,1);assert.equal(failures[0].mappingReasons.no_evidence_action,1);
});

test('offline server rejects repeated conversational answers instead of synthesizing a read or returning their text',async()=>{
  const payload=fixture(),h=harness(()=>({crmAction:null,assistantMessage:'Unsupported saved-data answer.',memoryNote:null}),()=>review([outcome()]));
  const result=await h.plan(payload);
  assert.equal(result.outcome,'validation_failed');assert.equal(result.crmAction,null);assert.equal(result.computedAnswer,undefined);
  assert.doesNotMatch(result.assistantMessage,/Unsupported saved-data answer/);
  assert.equal(h.calls.filter(call=>call.name==='pipechat_response').length,2);
  const failures=h.logs.filter(log=>log.event==='pipechat.validation');
  assert.deepEqual(failures.map(log=>[log.attempt,log.counts.requested,log.counts.compiled]),[[0,1,0],[1,1,0]]);
  assert(failures.every(log=>log.mappingReasons.no_evidence_action===1));
});
