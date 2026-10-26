'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module');
const {randomUUID}=require('node:crypto');
const os=require('node:os');
const Review=require('../lib/action-review'),Compiler=require('../lib/business-compiler'),Workspace=require('../public/business-workspace');
const Table=require('./fixtures/record-additions.cjs');
const serverPath=path.join(__dirname,'../server.js'),source=fs.readFileSync(serverPath,'utf8'),localRequire=createRequire(serverPath);
const requestId='aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',wid='11111111-1111-4111-a111-111111111111';
const copy=value=>JSON.parse(JSON.stringify(value));
const field={id:'name',name:'Name',type:'text',required:true,options:[]};
const type=id=>({id,name:id,fields:[field]});
function fixture(){
  const record={id:1,...Table.records[0],f_deal:'Harbor Studio',f_contact:'Jordan Patel'};
  return {userCommand:'Create a separate person for Jordan Patel and link to the existing Harbor Studio company and deal. Reuse any existing person. Show proposed records and links before saving.',
    _requestId:requestId,pipeline:{records:[record],tableSchema:copy(Table.schema),customFields:[],todoCards:[],currentDate:'2026-10-10',primaryField:'f_deal',workspaceVersion:'v1',
      business:{workspaceId:wid,version:3,role:'owner',scope:'workspace',state:{...Workspace.empty(),entityTypes:['client_companies','candidates','job_roles'].map(type)},
        primary:{updatedAt:'2026-10-10',tableSchema:copy(Table.schema),customFields:[],records:[{recordId:1,entityId:Workspace.legacyId(wid,1),values:record}]}}}};
}
function contact(){return {assistantMessage:'The company and deal are one combined primary record here. This proposes one person-to-primary link, not two distinct links. Nothing is saved.',memoryNote:null,
  crmAction:{action:'business_plan',version:1,title:'Person and association',operations:[
    {op:'put_type',type:type('people')},
    {op:'put_relationship_type',type:{id:'people_deals',name:'People and deals',fromType:'people',toType:'primary',cardinality:'many_to_many'}},
    {op:'upsert_entity',alias:'person',typeId:'people',matchField:'name',matchValue:'Jordan Patel',mode:'reuse',values:[{field:'name',value:'Jordan Patel'}]},
    {op:'link',typeId:'people_deals',from:{source:'alias',key:'person'},to:{source:'primary',key:Workspace.legacyId(wid,1)}}]}};}
const requirement=(description,evidenceKind='compiled_action',satisfied=true,stepIds=['root'])=>({description,evidenceKind,satisfied,stepIds});
const review=requirements=>({requirements,issues:[],clarificationQuestion:null});
function harness(planner,reviewer){
  const evidencePipelines=new WeakMap();
  const calls=[],logs=[],assertions=[],context={__dirname:path.dirname(serverPath),Buffer,URL,structuredClone,AbortController,AbortSignal,setTimeout,clearTimeout,
    console:{log:line=>logs.push(JSON.parse(line)),warn:line=>logs.push(JSON.parse(line))},
    process:{env:{PIPECHAT_STORAGE_PROVIDER:'json',OPENAI_API_KEY:'OFFLINE_FIXTURE_ONLY',NODE_ENV:'test'}},
    require(name){
      if(name==='node:http')return {createServer:()=>({})};
      // The real server and validators share a realm; deserialize VM model data into that realm.
      if(name==='./lib/action-review.js')return {...Review,evidence:(payload,result)=>{
        const normalized=copy(payload);
        if(payload.pipeline.recordHistories instanceof Map)Object.defineProperty(normalized.pipeline,'recordHistories',{value:payload.pipeline.recordHistories});
        const computed=Review.evidence(normalized,copy(result));evidencePipelines.set(computed,normalized.pipeline);return computed;
      },schemaFor:(action,context)=>Review.schemaFor(copy(action),{...context,pipeline:evidencePipelines.get(context.computed)||context.pipeline}),
      validateReview:(review,result,context)=>Review.validateReview(copy(review),copy(result),{...context,pipeline:evidencePipelines.get(context.computed)||context.pipeline})};
      if(name==='./lib/conversation-core.js'){
        const core=localRequire(name);return {...core,validateState:input=>core.validateState(copy(input)),contextFor:(page,command,recalled)=>core.contextFor(copy(page),command,copy(recalled))};
      }
      return localRequire(name);
    },
    fetch:async(url,options)=>{
      assert.equal(url,'https://api.openai.com/v1/responses');
      const body=JSON.parse(options.body),input=JSON.parse(typeof body.input==='string'?body.input:body.input[0].content[0].text);
      const isReview=body.text.format.name==='pipechat_action_review';calls.push({body,input,isReview});
      let result;
      try{result=await (isReview?reviewer:planner)(input,body);}catch(error){if(error.code==='ERR_ASSERTION')assertions.push(error);throw error;}
      return {ok:true,json:async()=>({output_text:JSON.stringify(result)})};
    }};
  const startup=source.lastIndexOf('start().catch(');assert(startup>0);
  vm.runInNewContext(source.slice(0,startup)+'\nglobalThis.planTest=planPipeChatAction;globalThis.turnTest=runConversationTurn;',context,{filename:serverPath});
  return {calls,logs,turn:async(req,...args)=>{
    if(req.backend)Object.assign(req.backend,{readAgentProfile:async()=>null,saveAgentProfile:async assignment=>assignment});
    return context.turnTest(req,...args);
  },plan:async payload=>{try{return await context.planTest(payload,{tier:'complex',model:'gpt-5.2',reason:'offline_test'});}finally{if(assertions.length)throw assertions[0];}}};
}

test('typed proposal reviewer receives representation disclosure and the same full entity contract',async()=>{
  const payload=fixture(),before=copy(payload),result=contact();
  const h=harness(()=>result,(input,body)=>{
    assert.equal(input.proposalMessage,result.assistantMessage,'A required representation disclosure must not vanish at the independent review boundary');
    assert(body.instructions.includes(Compiler.instructions),'Both stages need the same dependency, reuse, representation and permission contract');
    assert.equal(input.computed.next.entities.length,1);assert.equal(input.computed.next.relationships.length,1);
    assert.equal(input.computed.next.entityTypes.length,4);assert.equal(input.computed.lifecycle.writesApplied,0);
    return review([requirement('Create or reuse the separate person'),requirement('Associate to the combined saved row with disclosed representation')]);
  });
  const response=await h.plan(payload);
  assert.equal(response.crmAction.action,'business_plan');assert.equal(response.coverage.compiled,2);
  assert.deepEqual(payload,before);assert.equal(h.calls.length,2);
});

test('general advice uses conversational evidence, while missing saved reads cannot gain quotation authority',async()=>{
  const payload=fixture();payload.userCommand='What should I ask a client in an initial search briefing? Advice only; do not change anything.';
  const response={assistantMessage:'Discuss the role outcomes, search scope, decision process and interview timeline.',crmAction:null,memoryNote:null};
  const h=harness(()=>response,(_input,body)=>{
    assert.deepEqual(body.text.format.schema.properties.answerIntent,{type:'string',enum:['canonical']});
    assert.deepEqual(body.text.format.schema.properties.answerSelection,{type:'null'});
    assert.match(body.instructions,/General advice, hypothetical examples and conversational coaching/);
    return {...review([requirement('Provide initial briefing advice','conversation')]),answerIntent:'canonical',answerSelection:null};
  });
  const result=await h.plan(payload);
  assert.equal(result.crmAction,null);assert.equal(result.assistantMessage,response.assistantMessage);assert.equal(result.coverage.compiled,1);
  const missing={...review([requirement('What did the saved client say?','computed_read')]),answerIntent:'canonical',answerSelection:null};
  assert.equal(Review.validateReview(missing,response).ok,false);
});

test('new primary records preserve supplied facts without forcing a read or speculative schema changes',async()=>{
  const payload=fixture();payload.userCommand='Record my call today with Avery at Cedar Supply: quoted $18K for Service B, follow up in two weeks. Preview only.';
  const result={assistantMessage:'Proposed new record; optional fields remain blank. Service details are retained in Notes.',memoryNote:null,
    crmAction:{action:'add_record',record:{f_deal:'Cedar Supply',f_contact:'Avery',f_value:18000,f_follow:'2026-10-24',f_notes:'Spoke on 2026-10-10; quoted $18K for Service B.'},records:null}};
  const h=harness(()=>result,(input,body)=>{
    assert.equal(input.proposalMessage,result.assistantMessage);
    assert.match(body.instructions,/add_record and add_records/);
    assert.match(body.instructions,/supplied facts are proposal evidence, not a saved-data read/);
    assert.equal(input.computed.records[0].f_value,18000);assert.equal(input.computed.records[0].f_follow,'2026-10-24');
    assert.equal(input.computed.records[0].f_stage,'');assert.match(input.computed.records[0].f_notes,/Service B/);
    return review(['New company','Contact','Quoted amount','Product and call date','Follow-up date','Preview only'].map(value=>requirement(value)));
  });
  const before=copy(payload),response=await h.plan(payload);
  assert.equal(response.coverage.compiled,6);assert.equal(response.crmAction.action,'add_record');assert.deepEqual(payload,before);
});

test('structural evidence failures get bounded diagnostics and remain failed after one repair',async()=>{
  const payload=fixture(),broken=contact();broken.crmAction.operations[3].to.key='ent_22222222-2222-4222-a222-222222222222';broken.crmAction.operations[3].to.source='entity';
  const h=harness(()=>broken,()=>assert.fail('Invalid plans never reach semantic review'));
  const before=copy(payload),response=await h.plan(payload);
  assert.equal(response.outcome,'validation_failed');assert.equal(response.crmAction,null);assert.deepEqual(payload,before);
  assert.equal(h.calls.length,2);assert.equal(h.logs.length,2);
  assert.deepEqual(h.logs.map(log=>log.codes),[['evidence_invalid'],['evidence_invalid']]);
  assert.deepEqual(h.logs.map(log=>log.attempt),[0,1]);assert(h.logs.every(log=>log.requestId===requestId));
  assert.doesNotMatch(JSON.stringify(h.logs),/Jordan|Harbor|That linked entity|OFFLINE_FIXTURE|ent_222/);
});

test('missing outcomes and invalid evidence mappings cannot pass on repair; diagnostics contain no reviewer text',async()=>{
  const h=harness(()=>contact(),()=>({...review([requirement('PRIVATE_UNSATISFIED','compiled_action',false,[]),requirement('PRIVATE_READ','computed_read')]),issues:['PRIVATE_ISSUE credential=secret']}));
  const response=await h.plan(fixture());
  assert.equal(response.outcome,'validation_failed');assert.equal(response.crmAction,null);assert.equal(h.calls.length,4);
  assert.equal(h.logs.length,2);
  for(const log of h.logs){
    assert.deepEqual(log.codes,['requirements_unsatisfied','evidence_mapping_invalid','review_issues']);
    assert.deepEqual(log.counts,{requested:2,compiled:0,unsatisfied:1,mappingIssues:1,issues:1});
  }
  assert.doesNotMatch(JSON.stringify(h.logs),/PRIVATE|credential|secret|Jordan|Harbor/);
});

test('an explicitly required separate company endpoint still cannot be silently dropped',async()=>{
  const h=harness(()=>contact(),()=>({...review([requirement('Separate saved company endpoint','clarification',false,[])]),clarificationQuestion:'There is only a combined primary row. Should I propose a separate company, or link only to that row?'}));
  const result=await h.plan(fixture());assert.equal(result.crmAction.action,'clarify');assert.match(result.crmAction.question,/separate company/);
  assert.equal(h.calls.length,2);
});

test('standalone read requirements still reject proposal commentary even when it looks like saved data',()=>{
  const checked=Review.validateReview(review([requirement('Read saved contact','computed_read')]),contact());
  assert.equal(checked.ok,false);assert.equal(checked.compiled,0);
});

test('undo turn persists and replays the canonical nine-record preview instead of approved stale model prose',async t=>{
  const directory=await fs.promises.mkdtemp(path.join(os.tmpdir(),'pipechat-undo-answer-'));
  t.after(async()=>{assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));assert(path.basename(directory).startsWith('pipechat-undo-answer-'));await fs.promises.rm(directory,{recursive:true,force:true});});
  const store=require('../lib/conversation-store').createConversationStore(directory,(_key,work)=>work())('offline-user');
  const {buildActionEntry,validateReceipt}=require('../lib/action-journal');
  const payload=fixture();payload.userCommand='Preview undo of the saved owner change.';payload.pipeline.workspaceVersion='v2';
  const current={deals:Array.from({length:9},(_,i)=>({...Table.records[0],id:i+1,f_deal:`Current account ${i+1}`,f_owner:'Ravi'})),
    customFields:[],tableSchema:copy(Table.schema),todoCards:[],updatedAt:'v2'};
  const prior=copy(current);prior.updatedAt='v1';prior.deals.forEach(row=>{row.f_owner='Alex';});
  const {changes,dependencies,...receipt}=buildActionEntry({actionId:randomUUID(),requestId:randomUUID(),before:prior,after:current});
  const savedAction={receipt:validateReceipt({...receipt,importReceipt:null}),createdAt:'2026-10-10T12:00:00Z',undoneBy:null,undoInvalidated:false,paths:changes.map(change=>change.path)};
  const result={crmAction:{action:'undo_action',actionId:receipt.actionId},memoryNote:null,
    assistantMessage:'Restored 7 records from the old cohort: Stale Company and Old Account. Everything has been saved.'};
  const h=harness(()=>result,input=>{
    assert.equal(input.proposalMessage,result.assistantMessage);
    assert.equal(input.computed.kind,'undo-preview');assert.equal(input.computed.savedAction.pathCount,9);
    assert.equal(input.computed.savedAction.receipt.actionId,receipt.actionId);
    assert.equal(input.computed.requiresInverseReview,true);assert.equal(input.computed.lifecycle.writesApplied,0);
    return review([requirement('Preview undo of the saved owner change')]);
  });
  const initial=await store.readConversation(),userMessageId=randomUUID();
  const saved=await store.writeConversation({epoch:initial.epoch,version:initial.version,messages:[{id:userMessageId,role:'user',content:payload.userCommand}],state:{}});
  payload.conversation={epoch:saved.epoch,version:saved.version};
  payload.turn={threadId:(await store.listConversationThreads()).activeThreadId,requestId,userMessageId,assistantMessageId:randomUUID()};
  const original=copy(current),backend={...Object.fromEntries(Object.entries(store).map(([name,fn])=>[name,(...args)=>fn(...args.map(copy))])),
    readCrm:async()=>copy(current),listActions:async()=>({actions:[copy(savedAction)]}),
    reserveUsage:async()=>({reservationId:'offline'}),finishUsage:async()=>({used:1})};
  const req={backend,headers:{}},user={id:'offline-user',name:'Offline'};
  const response=copy(await h.turn(req,user,payload));
  assert.equal(response.turn.status,'succeeded',JSON.stringify({response,logs:h.logs,calls:h.calls.length}));assert.deepEqual(response.crmAction,result.crmAction);
  assert.match(response.assistantMessage,/Distinct records in the listed paths: 9\./);
  for(const row of current.deals)assert(response.assistantMessage.includes(row.f_deal));
  assert.doesNotMatch(response.assistantMessage,/Stale Company|Old Account|Restored 7|Everything has been saved/);
  assert.equal(response.assistantMessage,response.computedAnswer);
  assert.equal(response.lifecycle.requiresConfirmation,true);assert.equal(response.lifecycle.executed,false);
  assert.equal(response.lifecycle.writesApplied,0);assert.deepEqual(current,original);
  assert.equal(h.calls.length,2);assert.deepEqual(h.logs,[]);
  const page=await store.readConversation(),messages=page.messages.filter(message=>message.id===payload.turn.assistantMessageId);
  assert.equal(messages.length,1);assert.equal(messages[0].content,response.computedAnswer);
  const replay=copy(await h.turn(req,user,payload));
  assert.deepEqual(replay.turn,response.turn);assert.equal(replay.assistantMessage,response.computedAnswer);
  assert.equal(h.calls.length,2,'Replaying a durable turn must not re-run the model');
});

test('invalid review envelopes and provider errors have separate sanitized diagnostic codes',async()=>{
  const malformed=harness(()=>contact(),()=>({requirements:[],issues:['PRIVATE_MALFORMED'],clarificationQuestion:null}));
  assert.equal((await malformed.plan(fixture())).outcome,'validation_failed');
  assert.deepEqual(malformed.logs.map(log=>log.codes),[['review_contract_invalid'],['review_contract_invalid']]);
  const unavailable=harness(()=>contact(),()=>{throw new Error('PRIVATE_PROVIDER_SECRET');});
  await assert.rejects(()=>unavailable.plan(fixture()),/review could not finish/);
  assert.deepEqual(unavailable.logs.map(log=>log.codes),[['review_unavailable']]);
  assert.doesNotMatch(JSON.stringify([...malformed.logs,...unavailable.logs]),/PRIVATE/);
});

test('diagnostic boundary drops arbitrary values and bounds counters without echoing reviewer content',()=>{
  const result=Review.validationDiagnostic({requestId:'credential=private',attempt:10000,stage:'PRIVATE_STAGE',issues:['PRIVATE'],extra:'SECRET',review:{requirements:Array.from({length:100},()=>({satisfied:false})),issues:Array(100).fill('PRIVATE')}});
  assert.equal(result.requestId,null);assert.equal(result.attempt,0);assert.equal(result.stage,'review');
  assert.deepEqual(result.codes,['review_unavailable']);assert.equal(result.counts.unsatisfied,40);assert.equal(result.counts.issues,20);
  assert.doesNotMatch(JSON.stringify(result),/credential|PRIVATE|SECRET/);
});

function factFixture(){
  const payload=fixture();payload.userCommand='How should we contact Harbor Studio?';
  payload.pipeline.records[0].history=Array.from({length:9},(_,i)=>JSON.stringify({pipechatHistory:1,type:'note',id:'note_'+i,actor:'QA',
    at:'2026-10-10T12:00:00.000Z',text:i===0?'Prefers email updates.':'Unrelated history entry '+i+'.'}));
  const F=require('./fixtures/workspace-plans.cjs');
  const action=F.plan([F.select('selected'),{op:'read_history',id:'saved',label:'Saved context',selection:'selected',kind:'all',from:null,to:null,limit:100}]);
  action.goals=[{description:'Answer the requested saved fact',stepIds:['saved']}];
  return {payload,result:{crmAction:action,
    assistantMessage:'Provisional ungrounded summary',computedAnswer:'FORGED_PLANNER_ANSWER',answerPresentation:{mode:'extractive',snapshotId:'forged',workspaceVersion:'v1'}}};
}
function factReview(input){
  const bundle=input.computed.qualitativeSources;
  return {...review([{...requirement('Requested saved fact','computed_read',true,['saved']),requiredOutputs:['fields']}]),answerIntent:'qualitative_fact',
    answerSelection:{mode:'extractive',snapshotId:bundle.snapshotId,results:[{requirementIndex:0,recordId:1,status:'supported',
      citations:[{sourceId:bundle.sources.find(source=>source.text==='Prefers email updates.').id,quote:'Prefers email updates.'}]}]}};
}

test('review pass selects one exact source and server returns it with no extra model call',async()=>{
  const {payload,result}=factFixture();
  const h=harness(()=>result,(input,body)=>{
    const r=factReview(input),selection=body.text.format.schema.properties.answerSelection.anyOf[1];
    assert.deepEqual(selection.properties.snapshotId.enum,[r.answerSelection.snapshotId]);
    assert(selection.properties.results.items.properties.citations.items.properties.sourceId.enum.includes(r.answerSelection.results[0].citations[0].sourceId));
    assert.equal(body.text.format.schema.properties.requirements.items.properties.description.enum,undefined);
    return r;
  });
  const response=await h.plan(payload);assert.equal(response.crmAction.action,'workspace_plan');assert.equal(h.calls.length,2);
  assert.equal(response.computedAnswer,'Harbor Studio (#1): "Prefers email updates."\nSource: Saved note (2026-10-10T12:00:00.000Z)');
  assert.equal(response.answerPresentation.mode,'extractive');assert.equal(response.answerPresentation.workspaceVersion,'v1');
  assert.doesNotMatch(response.computedAnswer,/Unrelated|FORGED|Provisional/);assert.deepEqual(h.logs,[]);
});

test('server passes the same preservation evidence through schema and validation without empty-ID exceptions',async()=>{
  const Dashboard=require('../public/dashboard-board'),Core=require('../public/pipeline-core'),payload=fixture();
  const spec=(metric,groupBy)=>({version:1,title:metric+' by '+groupBy,chart:'bar',scope:'all',groupBy,bucket:'none',splitBy:null,
    where:[],sort:'label_asc',limit:null,measures:[{label:metric,metric,field:metric==='count'?null:'f_value',where:[]}]});
  const add=(id,metric,groupBy)=>({op:'add',id,spec:spec(metric,groupBy)});
  const board=Dashboard.apply(null,{action:'dashboard_plan',operations:[add('old_count','count','f_stage'),add('old_average','average','f_stage')],questions:[]},
    payload.pipeline.records,Core.create(payload.pipeline.tableSchema),[],{today:'2026-10-10'}).board;
  payload.pipeline.dashboard={board};payload.userCommand='Keep both stage graphs unchanged and append separate count and average graphs by owner.';
  const result={crmAction:{action:'dashboard_plan',operations:[add('new_count','count','f_owner'),add('new_average','average','f_owner')],questions:[]},assistantMessage:'Graph preview'};
  for(const invalid of [false,true]){
    const h=harness(()=>result,input=>{
      const invariants=input.computed.preservation.evidenceIds;
      assert.deepEqual(invariants,['unchanged:graph:old_count','unchanged:graph:old_average']);
      assert(invariants.every(id=>input.allowedStepIds.includes(id)));
      const req=(description,stepIds,requiredOutputs)=>({...requirement(description,'computed_read',true,stepIds),requiredOutputs});
      return {...review([req('Keep count',invalid?[]:[invariants[0]],['unchanged_graphs']),req('Keep average',[invariants[1]],['unchanged_graphs']),
        req('Count by owner',['graph:new_count'],['count']),req('Average by owner',['graph:new_average'],['average']),
        req('Separate graphs',invalid?['graph:new_count']:['graph:new_count','graph:new_average'],['separate_graphs'])]),answerIntent:'canonical',answerSelection:null};
    });
    const response=await h.plan(payload);
    if(invalid){
      assert.equal(response.outcome,'validation_failed');assert.equal(h.calls.length,4);
      assert(h.logs.every(log=>log.counts.requested===5&&log.counts.compiled===3&&log.mappingReasons.missing_step_ids===1&&log.mappingReasons.unsupported_required_output===1));
    }else{assert.equal(response.coverage.compiled,5);assert.equal(h.calls.length,2);assert.deepEqual(h.logs,[]);}
  }
});

for(const repair of [false,true])test('invalid source selection uses bounded '+(repair?'repair':'fail-closed')+' without full dump',async()=>{
  const {payload,result}=factFixture();let attempts=0;
  const h=harness(()=>result,input=>{
    const r=factReview(input);if(!repair||attempts===0)r.answerSelection.results[0].citations[0].quote='Fabricated fact.';attempts++;return r;
  });
  const response=await h.plan(payload);assert.equal(h.calls.length,4);assert.equal(attempts,2);
  assert.equal(response.crmAction?.action,repair?'workspace_plan':undefined);
  if(repair)assert.match(response.computedAnswer,/Prefers email/);
  else{assert.equal(response.outcome,'validation_failed');assert.equal(response.computedAnswer,undefined);assert.equal(response.answerPresentation,undefined);}
  assert(h.logs.every(log=>log.mappingReasons.invalid_answer_selection===1));
  assert.doesNotMatch(JSON.stringify(h.logs),/Fabricated|Prefers|Harbor|Unrelated/);
});

test('extractive answer is identical in durable text, result receipt and replay',async t=>{
  const directory=await fs.promises.mkdtemp(path.join(os.tmpdir(),'pipechat-extractive-'));
  t.after(async()=>{assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));assert(path.basename(directory).startsWith('pipechat-extractive-'));await fs.promises.rm(directory,{recursive:true,force:true});});
  const store=require('../lib/conversation-store').createConversationStore(directory,(_key,work)=>work())('offline-user');
  const {payload,result}=factFixture(),current={deals:copy(payload.pipeline.records),tableSchema:copy(payload.pipeline.tableSchema),customFields:[],todoCards:[],updatedAt:'v1'};
  const h=harness(input=>{assert.doesNotMatch(JSON.stringify(input.pipeline),/Prefers email|Unrelated history/);return result;},factReview);
  const initial=await store.readConversation(),userMessageId=randomUUID();
  const saved=await store.writeConversation({epoch:initial.epoch,version:initial.version,messages:[{id:userMessageId,role:'user',content:payload.userCommand}],state:{}});
  payload.conversation={epoch:saved.epoch,version:saved.version};
  payload.turn={threadId:(await store.listConversationThreads()).activeThreadId,requestId,userMessageId,assistantMessageId:randomUUID()};
  const before=copy(current),backend={...Object.fromEntries(Object.entries(store).map(([name,fn])=>[name,(...args)=>fn(...args.map(copy))])),
    readCrm:async()=>copy(current),reserveUsage:async()=>({reservationId:'offline'}),finishUsage:async()=>({used:1})};
  const req={backend,headers:{}},user={id:'offline-user',name:'Offline'},response=copy(await h.turn(req,user,payload));
  assert.equal(response.turn.status,'succeeded',JSON.stringify({response,logs:h.logs}));assert.equal(h.calls.length,2);
  assert.equal(response.assistantMessage,response.computedAnswer);assert.match(response.computedAnswer,/Prefers email/);
  assert.doesNotMatch(response.computedAnswer,/Unrelated|FORGED/);assert.deepEqual(current,before);
  const page=await store.readConversation();assert.equal(page.messages.find(message=>message.id===payload.turn.assistantMessageId).content,response.computedAnswer);
  assert.equal(response.turn.resultReceipt.computedAnswer,response.computedAnswer);
  const replay=copy(await h.turn(req,user,payload));assert.equal(replay.assistantMessage,response.computedAnswer);
  assert.deepEqual(replay.answerPresentation,response.answerPresentation);assert.equal(h.calls.length,2);
});

for(const failure of ['structural','semantic'])test(`${failure} validation failure persists and replays as failed, never a partial success`,async t=>{
  const directory=await fs.promises.mkdtemp(path.join(os.tmpdir(),'pipechat-validation-'));
  t.after(async()=>{assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));assert(path.basename(directory).startsWith('pipechat-validation-'));await fs.promises.rm(directory,{recursive:true,force:true});});
  const store=require('../lib/conversation-store').createConversationStore(directory,(_key,work)=>work())('offline-user');
  const payload=fixture(),result=contact();
  if(failure==='structural')result.crmAction.operations[3].to.key='Missing primary record';
  const h=harness(()=>result,()=>review([requirement('PRIVATE_OMITTED_OUTCOME','compiled_action',false,[])]));
  const initial=await store.readConversation(),userMessageId=randomUUID();
  const saved=await store.writeConversation({epoch:initial.epoch,version:initial.version,messages:[{id:userMessageId,role:'user',content:payload.userCommand}],state:{}});
  payload.conversation={epoch:saved.epoch,version:saved.version};
  payload.turn={threadId:(await store.listConversationThreads()).activeThreadId,requestId,userMessageId,assistantMessageId:randomUUID()};
  const business=copy(payload.pipeline.business),current={deals:copy(payload.pipeline.records),customFields:[],tableSchema:copy(Table.schema),todoCards:[],updatedAt:'v1'},before=copy(current),usageCalls=[];
  const backend={...Object.fromEntries(Object.entries(store).map(([name,fn])=>[name,(...args)=>fn(...args.map(copy))])),
    readCrm:async()=>copy(current),readBusiness:async()=>copy(business),
    reserveUsage:async()=>{usageCalls.push('reserve');return {reservationId:'offline'};},
    finishUsage:async(_token,_id,outcome)=>{usageCalls.push(outcome);return {used:1};}};
  const req={backend,headers:{}},user={id:'offline-user',name:'Offline'};
  const response=copy(await h.turn(req,user,payload));
  assert.equal(response.turn.status,'failed');assert.equal(response.turn.publicErrorCode,'validation');
  assert.equal(response.crmAction,null);assert.equal(response.turn.resultReceipt,null);
  assert.equal(response.assistantMessage,"Sorry, I couldn't prepare every part of that request reliably. Please try again or narrow the request.",'Durable public-code copy stays conversational without allowing raw failure text');
  assert.deepEqual(usageCalls,['reserve','commit']);assert.deepEqual(current,before);
  const calls=h.calls.length,logs=h.logs.length;
  const replay=copy(await h.turn(req,user,payload));assert.deepEqual(replay.turn,response.turn);assert.equal(h.calls.length,calls);assert.equal(h.logs.length,logs);
  const page=await store.readConversation();assert.equal(page.messages.filter(message=>message.id===payload.turn.assistantMessageId).length,1);
  assert.doesNotMatch(JSON.stringify(page),/PRIVATE_OMITTED/);
  assert(h.logs.some(log=>log.requestId===requestId&&log.codes.includes(failure==='structural'?'evidence_invalid':'requirements_unsatisfied')));
});
