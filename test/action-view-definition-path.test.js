'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module');
const Review=require('../lib/action-review'),Business=require('../public/business-workspace'),F=require('./fixtures/workspace-plans.cjs');
const serverPath=path.join(__dirname,'../server.js'),source=fs.readFileSync(serverPath,'utf8'),localRequire=createRequire(serverPath);
const workspaceId='11111111-1111-4111-8111-111111111111',viewId='view_33333333-3333-4333-8333-333333333333';
const copy=value=>JSON.parse(JSON.stringify(value));
function fixture(){
  const pipeline=F.workspace();
  pipeline.records=pipeline.records.slice(0,3).map(row=>({...row,f_deal:'PRIVATE RECORD '+row.id,f_notes:'=PRIVATE_CELL()',history:['PRIVATE HISTORY']}));
  pipeline.visibleIds=[3];pipeline.workspaceVersion=7;pipeline.currentDate='2026-10-26';pipeline.timezone='UTC';
  pipeline.tableSchema.columnOrder=['f_notes','f_value','f_deal','f_follow','f_owner','f_contact','f_stage','f_priority'];
  pipeline.business={workspaceId,state:{...Business.empty(),views:[{id:viewId,name:'Ordered selection',entityIds:[2,1].map(id=>Business.legacyId(workspaceId,id))}]}};
  pipeline.dashboard={board:{version:1,elements:[{id:'retained',visibleIds:[3],spec:{version:1,title:'Existing graph',chart:'bar',scope:'all',groupBy:'f_stage',bucket:'none',splitBy:null,
    where:[],sort:'label_asc',limit:null,measures:[{label:'Value',metric:'sum',field:'f_value',where:[]}]}}],sharedFilters:[],activeId:'retained'}};
  return {_requestId:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',userCommand:'Prepare the requested saved selection or CSV. Keep records, tasks, schema and the existing graph unchanged.',pipeline};
}
const actions=()=>[
  {action:'save_view',name:'New selection',selection:{source:'visible'}},
  {action:'open_view',selection:{source:'saved_view',viewName:'Ordered selection'}},
  {action:'export_records',selection:{source:'saved_view',viewId},columns:{source:'all'},format:'csv'},
  {action:'export_records',selection:{source:'saved_view',viewName:'Ordered selection'},columns:{source:'selected',columnIds:['f_value','f_notes']},format:'csv'}
];
const requirement=(kind,ids,outputs)=>({description:'PRIVATE reviewer requirement',evidenceKind:kind,stepIds:ids,requiredOutputs:outputs,satisfied:true});
const definition=()=>requirement('compiled_action',['root'],['view_definition']);
const review=requirements=>({requirements,issues:[],clarificationQuestion:null,answerIntent:'canonical',answerSelection:null});
const preserved=()=>[['unchanged:records','unchanged_records'],['unchanged:tasks','unchanged_tasks'],['unchanged:schema','unchanged_schema'],['unchanged:graph:retained','unchanged_graphs']]
  .map(([id,output])=>requirement('constraint',[id],[output]));
function harness(action,reviewer){
  const calls=[],logs=[],assertions=[],pipelines=new WeakMap();
  const proposal={crmAction:action,assistantMessage:'PRIVATE MODEL: Everything saved and file delivered.',memoryNote:null};
  const boundContext=context=>({...context,pipeline:pipelines.get(context.computed)||context.pipeline});
  const context={__dirname:path.dirname(serverPath),Buffer,URL,structuredClone,AbortController,AbortSignal,setTimeout,clearTimeout,
    console:{log:line=>logs.push(JSON.parse(line)),warn:line=>logs.push(JSON.parse(line))},
    process:{env:{PIPECHAT_STORAGE_PROVIDER:'json',OPENAI_API_KEY:'OFFLINE_FIXTURE_ONLY',NODE_ENV:'test'}},
    require(name){
      if(name==='node:http')return {createServer:()=>({})};
      // Normalize VM inputs while retaining the exact pipeline that owns each proof.
      if(name==='./lib/action-review.js')return {...Review,evidence:(payload,result)=>{
        const normalized=copy(payload),computed=Review.evidence(normalized,copy(result));pipelines.set(computed,normalized.pipeline);return computed;
      },schemaFor:(action,context)=>Review.schemaFor(copy(action),boundContext(context)),
      validateReview:(review,result,context)=>Review.validateReview(copy(review),copy(result),boundContext(context))};
      return localRequire(name);
    },
    fetch:async(url,options)=>{
      assert.equal(url,'https://api.openai.com/v1/responses');
      const body=JSON.parse(options.body),input=JSON.parse(typeof body.input==='string'?body.input:body.input[0].content[0].text);
      const isReview=body.text.format.name==='pipechat_action_review';calls.push({body,input,isReview});
      let result;
      try{result=isReview?reviewer(input,body,calls.filter(call=>call.isReview).length):proposal;}
      catch(error){if(error.code==='ERR_ASSERTION')assertions.push(error);throw error;}
      return {ok:true,json:async()=>({output_text:JSON.stringify(result)})};
    }};
  const startup=source.lastIndexOf('start().catch(');assert(startup>0);
  vm.runInNewContext(source.slice(0,startup)+'\nglobalThis.planTest=planPipeChatAction;',context,{filename:serverPath});
  return {calls,logs,plan:async payload=>{
    try{return copy(await context.planTest(payload,{tier:'complex',model:'gpt-5.2',reason:'offline_test'}));}
    finally{if(assertions.length)throw assertions[0];}
  }};
}

test('save/open/export planning accepts typed definitions, counts and exact preservation without raw CSV evidence',async()=>{
  for(const action of actions()){
    const payload=fixture(),before=copy(payload),recordIds=action.action==='save_view'?[3]:[2,1];
    const h=harness(action,(input,body)=>{
      const req=body.text.format.schema.properties.requirements.items.properties;
      assert(req.requiredOutputs.items.enum.includes('view_definition'));assert.match(req.stepIds.description,/compiled_action view_definition/);
      assert.match(body.instructions,/not extra computed_read requirements/);
      assert.deepEqual(input.computed.selection.recordIds,recordIds);assert.equal(input.computed.count,recordIds.length);
      const columnIds=action.action!=='export_records'?[]:action.columns.source==='all'?payload.pipeline.tableSchema.columnOrder:action.columns.columnIds;
      assert.deepEqual(input.computed.columns.map(column=>column.id),columnIds);
      assert.deepEqual(input.allowedStepIds,['root',...input.computed.constraintEvidence.map(item=>item.id)]);
      for(const item of preserved())assert(input.allowedStepIds.includes(item.stepIds[0]));
      assert.doesNotMatch(JSON.stringify(input.computed),/PRIVATE|rawCSV|"body"|"artifact"|"commands"/i);
      assert.equal(input.computed.lifecycle.executed,false);assert.equal(input.computed.lifecycle.writesApplied,0);
      return review([definition(),requirement('computed_read',['root'],['count']),...preserved()]);
    });
    const response=await h.plan(payload);
    assert.deepEqual(response.crmAction,action);assert.deepEqual(response.coverage,{requested:6,compiled:6});
    assert.deepEqual(response.ai.viewSelection.recordIds,recordIds);assert.equal(response.ai.viewSelection.count,recordIds.length);
    assert.match(response.computedAnswer,/Prepared/);assert.doesNotMatch(response.computedAnswer,/PRIVATE|Everything saved|file delivered/);
    assert.equal(response.lifecycle.requiresConfirmation,action.action==='save_view');assert.equal(response.lifecycle.writesApplied,0);
    assert.deepEqual(payload,before);assert.equal(h.calls.length,2);assert.deepEqual(h.logs,[]);
    assert.match(h.calls[0].body.instructions,/view_definition at root/);
  }
});

test('empty read checks for view selection repair to typed definition requirements without changing the action',async()=>{
  for(const action of actions().slice(0,3)){
    const payload=fixture(),before=copy(payload);
    const h=harness(action,(_input,_body,attempt)=>review([definition(),...preserved(),
      attempt===1?requirement('computed_read',['root'],[]):definition()]));
    const response=await h.plan(payload);
    assert.deepEqual(response.crmAction,action);assert.deepEqual(response.coverage,{requested:6,compiled:6});
    assert.equal(h.calls.length,4);assert.equal(h.logs.length,1);
    assert(h.logs[0].codes.includes('evidence_mapping_invalid'));assert.equal(h.logs[0].counts.mappingIssues,1);
    const repair=h.calls.find(call=>!call.isReview&&call.input.compilerRepair);
    assert(repair);assert.match(repair.input.compilerRepair.issues.join('\n'),/compiled_action view_definition/);
    assert.doesNotMatch(JSON.stringify(h.logs),/PRIVATE|rawCSV|Ordered selection|OFFLINE_FIXTURE/i);
    assert.deepEqual(payload,before);
  }
});

test('unsupported record reads remain failed after bounded repair rather than silently dropping an outcome',async()=>{
  for(const outputs of [[],['fields'],['names'],['sum'],['groups']]){
    const payload=fixture(),before=copy(payload),h=harness(actions()[2],()=>review([definition(),requirement('computed_read',['root'],outputs),...preserved()]));
    const response=await h.plan(payload);
    assert.equal(response.outcome,'validation_failed');assert.equal(response.crmAction,null);assert.equal(response.computedAnswer,undefined);
    assert.equal(h.calls.length,4);assert.equal(h.logs.length,2);
    for(const log of h.logs){assert(log.codes.includes('evidence_mapping_invalid'));assert.equal(log.counts.requested,6);assert.equal(log.counts.compiled,5);}
    assert.doesNotMatch(JSON.stringify(h.logs),/PRIVATE|rawCSV|Ordered selection|OFFLINE_FIXTURE/i);assert.deepEqual(payload,before);
  }
});
