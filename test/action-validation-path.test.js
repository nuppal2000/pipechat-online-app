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
function harness(planner,reviewer,numericReviewer=()=>assert.fail('Unexpected named numeric intent request'),populationReviewer=()=>({completeIntent:false,ratios:[],otherRequestedWork:true,ambiguity:false})){
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
      allowedStepIdsFor:(action,context)=>Review.allowedStepIdsFor(copy(action),{...context,pipeline:evidencePipelines.get(context.computed)||context.pipeline}),
      validateReview:(review,result,context)=>Review.validateReview(copy(review),copy(result),{...context,pipeline:evidencePipelines.get(context.computed)||context.pipeline})};
      if(name==='./lib/named-numeric-intent.js'){
        const numeric=localRequire(name);
        return {...numeric,eligible:action=>numeric.eligible(copy(action)),
          candidateEligible:action=>numeric.candidateEligible(copy(action)),
          normalizeAction:(action,pipeline)=>numeric.normalizeAction(action==null?action:copy(action),copy(pipeline)),
          assess:(intent,action,context)=>numeric.assess(copy(intent),copy(action),{...context,pipeline:evidencePipelines.get(context.computed)})};
      }
      if(['./lib/conditional-classification-intent.js','./lib/derived-calculation-intent.js',
        './lib/ratio-calculation-intent.js','./lib/task-query-intent.js','./lib/date-shift-intent.js'].includes(name)){
        const intent=localRequire(name);
        return {...intent,eligible:(action,pipeline)=>intent.eligible(copy(action),pipeline&&copy(pipeline)),assess:(value,action,context)=>
          intent.assess(copy(value),copy(action),{...context,pipeline:evidencePipelines.get(context.computed)})};
      }
      if(name==='./lib/dashboard-presentation-contract.js'){
        const presentation=localRequire(name);
        return {...presentation,assess:(value,action,context)=>presentation.assess(value==null?value:copy(value),copy(action),
          {...context,pipeline:evidencePipelines.get(context.computed)||context.pipeline})};
      }
      if(name==='./lib/conversation-core.js'){
        const core=localRequire(name);return {...core,validateState:input=>core.validateState(copy(input)),contextFor:(page,command,recalled)=>core.contextFor(copy(page),command,copy(recalled))};
      }
      return localRequire(name);
    },
    fetch:async(url,options)=>{
      assert.equal(url,'https://api.openai.com/v1/responses');
      const body=JSON.parse(options.body),input=JSON.parse(typeof body.input==='string'?body.input:body.input[0].content[0].text);
      const name=body.text.format.name,isReview=name==='pipechat_action_review';calls.push({name,body,input,isReview});
      let result;
      try{result=await (isReview?reviewer:name==='pipechat_named_numeric_intent'?numericReviewer:
        ['pipechat_conditional_classification_intent','pipechat_derived_calculation_intent','pipechat_ratio_calculation_intent','pipechat_task_query_intent','pipechat_date_shift_intent'].includes(name)?populationReviewer:planner)(input,body);}catch(error){if(error.code==='ERR_ASSERTION')assertions.push(error);throw error;}
      // Existing semantic-review fixtures are answer-only unless a test explicitly
      // supplies the new presentation obligation or deliberately omits it.
      if(isReview&&body.text.format.schema.properties.presentationIntent&&!Object.hasOwn(result,'presentationIntent'))
        result={...result,presentationIntent:{status:'not_requested',elements:[]}};
      return {ok:true,json:async()=>({output_text:JSON.stringify(result)})};
    }};
  const startup=source.lastIndexOf('start().catch(');assert(startup>0);
  vm.runInNewContext(source.slice(0,startup)+'\nglobalThis.planTest=planPipeChatAction;globalThis.turnTest=runConversationTurn;',context,{filename:serverPath});
  return {calls,logs,turn:async(req,...args)=>{
    if(req.backend)Object.assign(req.backend,{readAgentProfile:async()=>null,saveAgentProfile:async assignment=>assignment});
    return context.turnTest(req,...args);
  },plan:async(payload,options={})=>{try{return await context.planTest(payload,{tier:'complex',model:'gpt-5.2',reason:'offline_test'},options.startedAt??Date.now());}finally{if(assertions.length)throw assertions[0];}}};
}

const plannerFormat='pipechat_response',numericFormat='pipechat_named_numeric_intent',genericFormat='pipechat_action_review';
test('server exposes Activity filtering and compiles it before the ordinary read review',async()=>{
  const F=require('./fixtures/workspace-plans.cjs'),p=F.workspace();
  p.currentDate='2026-11-13';p.currentView='dashboard';p.workspaceVersion='activity-test';
  p.records[0].history=['2026-11-13T15:00:00Z | QA: Saved activity'];
  const action={action:'activity_view_request',title:'Selected Activity',source:'all',
    where:[[F.where('f_deal','equals',p.records[0].f_deal)]],kind:'all',from:'2026-11-13',to:'2026-11-13',limit:100};
  const h=harness((_input,body)=>{
    assert.match(body.instructions,/ACTIVITY VIEW/);
    assert(body.text.format.schema.properties.crmAction.anyOf.some(s=>s.properties?.action?.enum?.includes('activity_view_request')));
    return {assistantMessage:'Show saved Activity.',memoryNote:null,crmAction:action};
  },input=>{
    assert.equal(input.compiled.action,'workspace_plan');
    return review([{...requirement('Render the selected Activity','computed_read',true,['activity_history']),requiredOutputs:['rendered_activity']}]);
  });
  const result=await h.plan({userCommand:'Filter the Activity view to '+p.records[0].f_deal+' on November 13, 2026.',pipeline:p});
  assert.equal(result.crmAction.action,'workspace_plan');
  assert.equal(result.crmAction.steps[1].showActivity,true);
  assert.equal(h.calls.filter(c=>c.isReview).length,1);
});
for(const repair of [false,true])test('server checks saved-date shift intent and '+(repair?'repairs the wrong literal':'returns the full preview'),async()=>{
  const F=require('./fixtures/workspace-plans.cjs'),Scoped=require('../lib/scoped-table-request'),p=F.workspace();
  p.currentDate='2026-11-13';p.workspaceVersion='date-check';
  p.records=p.records.slice(0,3).map((row,i)=>({...row,f_deal:'Group '+i,f_follow:['2026-11-13','2026-11-16',null][i]}));
  const payload={pipeline:p,userCommand:'Postpone every dated Group follow-up by two business days from its saved date, leaving undated records alone.'};
  const where=[[F.where('f_deal','starts_with','Group')]];
  const intent={completeIntent:true,source:'all',where,field:'f_follow',base:'saved_date',dateMode:'business_days',offset:2,blankPolicy:'skip',otherRequestedWork:false,ambiguity:false};
  const action=Scoped.compile({action:'scoped_table_request',title:'Saved dates',source:'all',where,
    operation:{kind:'shift_saved_dates',field:'f_follow',dateMode:'business_days',offset:2,blankPolicy:'skip'}});
  if(repair)action.steps.find(step=>step.op==='update_records').assignments=[{field:'f_follow',operation:'set',value:'2026-11-20'}];
  const before=copy(p),h=harness(()=>({crmAction:action,assistantMessage:'Preview.'}),()=>assert.fail('The exact date proof needs no generic approval'),undefined,(input,body)=>{
    assert.equal(body.text.format.name,'pipechat_date_shift_intent');
    assert.equal(input.userCommand,payload.userCommand);assert.equal(input.records,undefined);return intent;
  });
  const result=await h.plan(payload);
  assert.deepEqual(h.calls.map(c=>c.name),[plannerFormat,'pipechat_date_shift_intent']);
  assert.deepEqual(copy(result.coverage),{requested:5,compiled:5});
  assert.match(result.computedAnswer,/2026-11-17/);assert.match(result.computedAnswer,/2026-11-18/);
  assert.equal(result.lifecycle.requiresConfirmation,true);assert.equal(result.lifecycle.writesApplied,0);
  assert.deepEqual(p,before);
});
test('independent classification repairs a stale focus before allowing a full-cohort confirmation preview',async()=>{
  const F=require('./fixtures/workspace-plans.cjs'),p=F.workspace();
  p.records=p.records.slice(0,3);p.records[0].f_value=12000;p.records[1].f_value=30000;p.records[2].f_value=null;
  p.currentDate='2026-11-10';p.workspaceVersion='current';p.visibleIds=[1];p.conversationFocus={kind:'table',ids:[1]};
  const payload={userCommand:'For all deals set Priority High at 15000 or above, otherwise Medium; leave unknown amounts unchanged.',pipeline:p};
  const operation={kind:'classify_number',numberField:'f_value',operator:'gte',threshold:15000,targetField:'f_priority',whenTrue:'High',otherwise:'Medium',whenBlank:'unchanged'};
  const intent={completeIntent:true,source:'all',where:[],...operation,otherRequestedWork:false,ambiguity:false};delete intent.kind;
  let attempt=0;
  const h=harness(()=>({assistantMessage:'Review this preview.',memoryNote:null,crmAction:{action:'scoped_table_request',title:'Classify',source:attempt++?'all':'focus',where:[],operation}}),
    ()=>assert.fail('A known population mismatch must not fall through to generic approval'),undefined,(input,body)=>{
      assert.equal(body.text.format.name,'pipechat_conditional_classification_intent');
      assert.deepEqual(Object.keys(input).sort(),['fields','userCommand']);
      assert.equal(input.userCommand,payload.userCommand);assert(!JSON.stringify(input).includes('Summit'));
      return intent;
    });
  const before=copy(p),result=await h.plan(payload);
  assert.equal(result.crmAction?.action,'workspace_plan');assert.equal(result.crmAction.steps[0].source,'all');
  assert.equal(result.lifecycle.writesApplied,0);assert.equal(result.lifecycle.requiresConfirmation,true);
  assert.deepEqual(p,before);assert.equal(attempt,2);
  assert.deepEqual(h.logs.map(x=>[x.attempt,x.counts.compiled]),[[0,0]]);
});

test('a persistently narrowed weighted-calculation population is rejected despite the correct total',async()=>{
  const F=require('./fixtures/workspace-plans.cjs'),p=F.workspace();
  p.customFields=[{id:'cf_probability',name:'Probability percent',type:'number'}];
  p.records=p.records.slice(0,3).map((r,i)=>({...r,cf_probability:i===0?50:null}));
  p.currentDate='2026-11-10';p.workspaceVersion='current';
  const expression={kind:'sum_product',factors:['f_value','cf_probability'],divisor:100};
  const action=F.plan([F.select('present',[[F.where('cf_probability','is_not_blank')]]),
    {op:'read_records',id:'calculate',label:'Weighted total',selection:'present',showTable:false,outputs:[{kind:'row_calculation',expression}]}]);
  const payload={userCommand:'Compute weighted value across all deals and report missing-factor exclusions.',pipeline:p};
  const h=harness(()=>({assistantMessage:'PRIVATE_PLANNER_PROSE',memoryNote:null,crmAction:action}),
    ()=>assert.fail('A known calculation-population mismatch must never get generic approval'),undefined,(input,body)=>{
      if(body.text.format.name==='pipechat_ratio_calculation_intent')return {completeIntent:false,ratios:[],otherRequestedWork:true,ambiguity:false};
      assert.equal(body.text.format.name,'pipechat_derived_calculation_intent');
      assert(!JSON.stringify(input).includes('PRIVATE_PLANNER_PROSE'));
      return {completeIntent:true,population:{source:'all',where:[]},expression,coverage:true,counts:['selected','included','excluded'],otherRequestedWork:false,ambiguity:false};
    });
  const before=copy(p),result=await h.plan(payload);
  assert.equal(result.outcome,'validation_failed');assert.equal(result.crmAction,null);assert.equal(result.computedAnswer,undefined);
  assert.deepEqual(p,before);assert.equal(h.logs.length,2);assert(h.logs.every(x=>x.counts.compiled===0));
});

test('malformed independent population evidence cannot fall through to generic approval',async()=>{
  const F=require('./fixtures/workspace-plans.cjs'),p=F.workspace();p.currentDate='2026-11-10';p.workspaceVersion='current';
  const action=F.plan([F.select('rows',[[F.where('f_value','gte',15000)]]),F.update('priority','rows','f_priority','High')]);
  const h=harness(()=>({assistantMessage:'Review.',memoryNote:null,crmAction:action}),
    ()=>assert.fail('Malformed independent intent cannot authorize generic fallback'),undefined,()=>({}));
  const response=await h.plan({userCommand:'Classify all priorities above and below 15000.',pipeline:p});
  assert.equal(response.outcome,'validation_failed');assert.equal(response.crmAction,null);
  assert.equal(h.calls.filter(c=>c.name==='pipechat_conditional_classification_intent').length,2);
});
function numericFixture(){
  const payload=fixture(),p=payload.pipeline;
  payload.userCommand='Create a number column called Confidence score. Set Harbor Studio to 12.75 and Cedar Grove to 0. Leave all other cells in the new column blank.';
  payload.conversationHistory=[{role:'assistant',content:'PRIVATE_HISTORY_SENTINEL'}];
  p.records=['Cedar Grove','PRIVATE_OUTSIDER_SENTINEL','Harbor Studio'].map((f_deal,i)=>({...p.records[0],id:i+1,f_deal,f_notes:'PRIVATE_CELL_SENTINEL'}));
  p.visibleIds=[2];
  return payload;
}
const numericProposal=(harbor,cedar)=>({assistantMessage:'PRIVATE_PROPOSAL_SENTINEL',memoryNote:null,
  crmAction:{action:'scoped_table_request',title:'Add confidence scores',source:'all',where:[],operation:{kind:'add_named_numbers',name:'Confidence score',
    entries:[{recordName:'Harbor Studio',value:harbor},{recordName:'Cedar Grove',value:cedar}]}}});
const numericIntent=()=>({completeIntent:true,operation:'create',fieldName:'Confidence score',assignments:[{name:'Harbor Studio',value:12.75},{name:'Cedar Grove',value:0}],
  leaveOthersBlank:true,otherRequestedWork:false,ambiguity:false});

test('named numeric intent receives only the user command and approves the exact decimal/zero preview',async()=>{
  const payload=numericFixture(),before=copy(payload.pipeline);
  const h=harness(()=>numericProposal(12.75,0),()=>assert.fail('An exact numeric preview does not need generic review'),(input,body)=>{
    assert.deepEqual(input,{userCommand:payload.userCommand});
    assert.equal(body.text.format.strict,true);
    assert.doesNotMatch(JSON.stringify(body),/PRIVATE_(?:HISTORY|OUTSIDER|CELL|PROPOSAL)_SENTINEL/);
    return numericIntent();
  });
  const response=await h.plan(payload);
  assert.deepEqual(h.calls.map(c=>c.name),[plannerFormat,numericFormat]);
  assert.equal(response.crmAction?.action,'workspace_plan');assert.deepEqual(copy(response.coverage),{requested:3,compiled:3});
  assert.equal(response.lifecycle.requiresConfirmation,true);assert.equal(response.lifecycle.writesApplied,0);
  const {records,customFields,tableSchema,todoCards}=payload.pipeline;
  const preview=require('../public/workspace-plan').prepare({records,customFields,tableSchema,todoCards},copy(response.crmAction),{nonce:'client',visibleIds:[2]});
  const [column]=preview.addedFields;assert.equal(column.name,'Confidence score');assert.equal(column.type,'number');
  assert.deepEqual(preview.next.records,records.map((row,i)=>({...row,[column.id]:[0,null,12.75][i]})));
  assert.deepEqual(payload.pipeline,before);
});

test('named numeric intent repairs swapped values from independent pairs before preparing a confirmation preview',async()=>{
  const payload=numericFixture(),before=copy(payload.pipeline);
  const h=harness(()=>numericProposal(0,12.75),()=>assert.fail('A mismatched complete intent cannot fall back to generic approval'),numericIntent);
  const response=await h.plan(payload);
  assert.deepEqual(h.calls.map(c=>c.name),[plannerFormat,numericFormat]);
  assert.equal(response.crmAction.action,'workspace_plan');
  assert.equal(response.lifecycle.requiresConfirmation,true);assert.equal(response.lifecycle.writesApplied,0);
  const {records,customFields,tableSchema,todoCards}=payload.pipeline;
  const preview=require('../public/workspace-plan').prepare({records,customFields,tableSchema,todoCards},copy(response.crmAction),{nonce:'repaired',visibleIds:[2]});
  const [column]=preview.addedFields;
  assert.deepEqual(preview.next.records,records.map((row,i)=>({...row,[column.id]:[0,null,12.75][i]})));
  assert.deepEqual(h.logs,[]);
  assert.deepEqual(payload.pipeline,before);
});

test('additional work falls through to generic validation; a numeric write cannot satisfy the requested sum',async()=>{
  const payload=numericFixture();payload.userCommand+=' Also tell me the sum of deal values.';
  const h=harness(()=>numericProposal(12.75,0),input=>{
    assert.equal(input.userCommand,payload.userCommand);
    const defs=input.computed.numericAssignmentEvidence;
    const numeric=defs.map(p=>({...requirement(p.output,'compiled_action',true,[p.stepId]),requiredOutputs:[p.output]}));
    const write=defs.find(p=>p.output==='literal_numeric_assignment');
    return {...review([...numeric,{...requirement('Sum of deal values','computed_read',true,[write.stepId]),requiredOutputs:['sum']}]),
      answerIntent:'canonical',answerSelection:null};
  },()=>({completeIntent:false,fieldName:null,assignments:[],leaveOthersBlank:false,otherRequestedWork:true,ambiguity:false}));
  const response=await h.plan(payload);
  assert.deepEqual(h.calls.map(c=>c.name),[plannerFormat,numericFormat,genericFormat,plannerFormat,numericFormat,genericFormat]);
  assert.equal(response.outcome,'validation_failed');assert.equal(response.crmAction,null);
  assert.deepEqual(h.logs.map(l=>[l.counts.requested,l.counts.compiled,l.mappingReasons.no_evidence_action]),[[4,3,1],[4,3,1]]);
});

test('standalone Number transport normalizes before evidence and needs just one independent creation proof',async()=>{
  const payload=fixture();payload.userCommand='Add a number column named Seats.';
  payload.pipeline.customFields=[{id:'cf_license',name:'License seats',type:'number'}];
  payload.pipeline.records[0].cf_license=12;
  const before=copy(payload.pipeline),h=harness(()=>({assistantMessage:'Review the column.',memoryNote:null,
    crmAction:{action:'add_field',newFieldName:'Seats',targetType:'number',dropdownOptions:[]}}),
    ()=>assert.fail('No generic reviewer is needed for a complete standalone numeric proof'),()=>({completeIntent:true,operation:'create',
      fieldName:'Seats',assignments:[],leaveOthersBlank:true,otherRequestedWork:false,ambiguity:false}));
  const result=await h.plan(payload);
  assert.deepEqual(h.calls.map(c=>c.name),[plannerFormat,numericFormat]);
  assert.equal(result.crmAction.action,'workspace_plan');assert.equal(result.crmAction.steps.length,1);
  assert.deepEqual(copy(result.coverage),{requested:1,compiled:1});
  assert.equal(result.lifecycle.requiresConfirmation,true);assert.equal(result.lifecycle.writesApplied,0);
  assert.deepEqual(payload.pipeline,before);
});

test('existing Number updates normalize their exact names and report two assignments, not a phantom field creation',async()=>{
  const payload=numericFixture();payload.userCommand='Set Seats to 12 for Harbor Studio and 0 for Cedar Grove. Leave the rest blank.';
  payload.pipeline.customFields=[{id:'cf_seats',name:'Seats',type:'number'}];
  payload.pipeline.records.forEach(row=>row.cf_seats=null);
  const before=copy(payload.pipeline),h=harness(()=>({assistantMessage:'Review both values.',memoryNote:null,
    crmAction:{action:'update_records',changes:[['Harbor Studio',12],['Cedar Grove',0]].map(([recordMatch,value])=>({
      recordMatch,ids:null,filter:null,field:'cf_seats',operation:'set',value}))}}),
    ()=>assert.fail('Complete exact-number proof must not need a generic mapping'),()=>({...numericIntent(),operation:'assign',fieldName:'Seats',
      assignments:[{name:'Harbor Studio',value:12},{name:'Cedar Grove',value:0}]}));
  const result=await h.plan(payload);
  assert.deepEqual(h.calls.map(c=>c.name),[plannerFormat,numericFormat]);
  assert.deepEqual(copy(result.coverage),{requested:2,compiled:2});
  assert(result.crmAction.steps.every(s=>s.op!=='add_field'));assert.deepEqual(payload.pipeline,before);
});

test('malformed numeric independent verdict fails closed, including when the repair budget has elapsed',async()=>{
  const h=harness(()=>numericProposal(12.75,0),()=>assert.fail('No fallback from malformed supported-intent evidence'),()=>({}));
  const result=await h.plan(numericFixture(),{startedAt:Date.now()-60000});
  assert.equal(result.outcome,'validation_failed');assert.equal(result.crmAction,null);
  assert.deepEqual(h.calls.map(c=>c.name),[plannerFormat,numericFormat]);
});

function ratioFixture(){
  const F=require('./fixtures/workspace-plans.cjs'),p=F.workspace(),template=p.records[0];
  p.currentDate='2026-11-13';p.workspaceVersion='ratio-current';p.visibleIds=[1];
  p.records=[15000,18000,22000,8500,2000,0,null].map((f_value,index)=>({...copy(template),id:index+1,
    f_deal:'QA1110 Deal '+(index+1),f_value,f_stage:index?'Qualified':'Closed Won'}));
  p.records.push({...copy(template),id:8,f_deal:'PRIVATE_UNRELATED_ACCOUNT',f_value:999999,f_stage:'Closed Won'});
  const cohort=[[F.where('f_deal','starts_with','QA1110')]],won=[[F.where('f_stage','equals','Closed Won')]];
  const ratio=(label,metric,field)=>({label,population:{source:'all',where:cohort},
    numerator:{metric,field,where:won},denominator:{metric,field,where:[]}});
  const intent={completeIntent:true,otherRequestedWork:false,ambiguity:false,
    ratios:[ratio('Won record share','count',null),ratio('Won known value share','sum','f_value')]};
  return {intent,payload:{pipeline:p,userCommand:'Show the percentage of QA1110 deals that are Won, next to the percentage of their known value that is Won.'}};
}

test('paired-percentage server check returns both actual fractions without generic review or dashboard mutations',async()=>{
  const {payload,intent}=ratioFixture(),Ratio=require('../lib/ratio-calculation-intent'),before=copy(payload.pipeline);
  const h=harness(()=>({assistantMessage:'Provisional arithmetic is not authoritative.',crmAction:Ratio.compile(intent,payload.pipeline)}),
    ()=>assert.fail('Typed full-percentage proof should finish in one check'),undefined,(input,body)=>{
      assert.equal(body.text.format.name,'pipechat_ratio_calculation_intent');
      assert.deepEqual(Object.keys(input).sort(),['fields','primaryField','primaryNames','userCommand']);
      assert.deepEqual(input.primaryNames,payload.pipeline.records.map(row=>({name:row.f_deal,matches:1})));return intent;
    });
  const result=await h.plan(payload);
  assert.deepEqual(h.calls.map(c=>c.name),[plannerFormat,'pipechat_ratio_calculation_intent']);
  assert.deepEqual(copy(result.coverage),{requested:2,compiled:2});
  assert.match(result.computedAnswer,/14\.29% \(1 \/ 7 x 100\)/);
  assert.match(result.computedAnswer,/22\.9% \(\$15,000\.00 \/ \$65,500\.00 x 100\)/);
  assert.equal(result.lifecycle.operation,'read');assert.deepEqual(payload.pipeline,before);
});

test('missing second percentage is locally recompiled from complete independent intent with fresh evidence',async()=>{
  const {payload,intent}=ratioFixture(),Ratio=require('../lib/ratio-calculation-intent');let attempt=0;
  const h=harness(input=>{
    if(attempt)assert.match(JSON.stringify(input.compilerRepair),/Every requested percentage|Expected percentage intent/);
    return {assistantMessage:'Calculated shares.',crmAction:Ratio.compile(attempt++?intent:{...intent,ratios:intent.ratios.slice(0,1)},payload.pipeline)};
  },()=>assert.fail('A supported percentage mismatch must not reach a generic approval'),undefined,()=>intent);
  const result=await h.plan(payload);
  assert.equal(result.coverage.compiled,2);assert.equal(attempt,1);
  assert.deepEqual(h.calls.map(c=>c.name),[plannerFormat,'pipechat_ratio_calculation_intent']);
  assert.match(result.computedAnswer,/22\.9%/);assert.equal(result.lifecycle.operation,'read');
  assert.equal(h.logs.length,0);
});

test('partial negative or malformed percentage verdict is never accepted by falling through',async()=>{
  for(const malformed of [false,true]){
    const {payload,intent}=ratioFixture(),Ratio=require('../lib/ratio-calculation-intent');
    const wrong={...intent,ratios:intent.ratios.slice(0,1)};
    const h=harness(()=>({assistantMessage:'Partial answer.',crmAction:Ratio.compile(wrong,payload.pipeline)}),
      ()=>assert.fail('No silent generic fallback'),undefined,()=>malformed?{}:{...intent,completeIntent:false,otherRequestedWork:true});
    const result=await h.plan(payload);
    assert.equal(result.outcome,'validation_failed');assert.equal(result.crmAction,null);
    assert.equal(h.calls.length,4);assert(h.calls.every(c=>!c.isReview));
  }
});

function taskReadFixture(result='tasks'){
  const F=require('./fixtures/workspace-plans.cjs'),Todo=require('../public/todo-core'),p=F.workspace();
  p.currentDate='2026-11-13';p.workspaceVersion='tasks-current';p.visibleIds=[3];
  p.records=p.records.slice(0,3).map((row,i)=>({...row,f_deal:['QA1110 Beacon Print','QA1110 Tide Glass','Unrelated'][i],f_follow:p.currentDate}));
  const card=(id,recordId,nextAction,dueDate,status='To Do')=>({...Todo.create(id,recordId),nextAction,dueDate,status,notes:'Saved task notes'});
  p.todoCards=[card('todo_proof',1,'Proof review','2026-11-12'),card('todo_samples',2,'Send samples','2026-11-17'),
    card('todo_done',1,'Already done','2026-11-11','Done'),card('todo_unrelated',3,'QA1110 Beacon Print mention','2026-11-10')];
  const intent={completeIntent:true,result,linkedRecords:{where:[[F.where('f_deal','starts_with','QA1110'),
    ...(result==='records'?[F.where('f_follow','equals',p.currentDate)]:[])]]},
    taskStatus:'open',due:{kind:'overdue',date:null},taskText:[],otherRequestedWork:false,ambiguity:false};
  return {intent,payload:{pipeline:p,userCommand:result==='records'?'Which QA1110 deals have a follow-up today but an overdue task?':
    'Show overdue QA1110 tasks, with their linked deal and due date.'}};
}

for(const target of ['tasks','records'])test('server wires linked-record task '+target+' schema, instructions and complete read evidence',async()=>{
  const {payload,intent}=taskReadFixture(target),Task=require('../lib/task-query-intent'),before=copy(payload.pipeline);
  const h=harness((input,body)=>{
    const schema=body.text.format.schema.properties.crmAction.anyOf.find(s=>s.properties?.action?.enum?.includes('query_todos'));
    assert(schema.properties.result.enum.includes('records'));
    assert(schema.properties.selection.anyOf.some(s=>s.properties.source.enum.includes('linked_records')));
    assert(body.instructions.includes(require('../public/todo-actions').queryInstructions));
    return {assistantMessage:'Read the task population.',crmAction:Task.compile(intent,payload.pipeline).action};
  },()=>assert.fail('An independently checked task join does not need generic approval'),undefined,(input,body)=>{
    assert.equal(body.text.format.name,'pipechat_task_query_intent');
    assert.deepEqual(Object.keys(input).sort(),['dateContext','fields','primaryField','userCommand']);
    assert(!JSON.stringify(input).includes('Proof review'));return intent;
  });
  const result=await h.plan(payload);
  assert.equal(result.crmAction?.action,'query_todos',JSON.stringify({result,logs:h.logs}));
  assert.deepEqual(h.calls.map(c=>c.name),[plannerFormat,'pipechat_task_query_intent']);
  assert.match(result.computedAnswer,/QA1110 Beacon Print/);assert.match(result.computedAnswer,/Proof review/);
  assert.doesNotMatch(result.computedAnswer,/Already done|QA1110 Beacon Print mention|Send samples/);
  assert.equal(result.lifecycle.operation,'read');assert.deepEqual(payload.pipeline,before);
});

test('incorrect task text scoping cannot replace a linked-record query; repair receives the checked expected action',async()=>{
  const {payload,intent}=taskReadFixture(),Task=require('../lib/task-query-intent');let attempt=0;
  const expected=Task.compile(intent,payload.pipeline).action;
  const h=harness(input=>{
    if(attempt){assert.deepEqual(input.compilerRepair.expectedAction,expected);return {assistantMessage:'Matched saved tasks.',crmAction:expected};}
    attempt++;
    return {assistantMessage:'Matched task text.',crmAction:{action:'query_todos',result:'tasks',selection:{source:'all',ids:[],focusId:null,
      conditions:[{field:'nextAction',operator:'contains',value:'QA1110',values:[]}]}}};
  },()=>assert.fail('A rejected task join must not fall through'),undefined,()=>intent);
  const result=await h.plan(payload);
  assert.equal(result.crmAction?.selection.source,'linked_records',JSON.stringify({result,logs:h.logs}));
  assert.equal(h.calls.length,4);assert.equal(h.logs.length,1);
});

test('malformed independent task-read verdict remains rejected after the single repair',async()=>{
  const {payload,intent}=taskReadFixture(),Task=require('../lib/task-query-intent');
  const h=harness(()=>({assistantMessage:'Tasks found.',crmAction:Task.compile(intent,payload.pipeline).action}),
    ()=>assert.fail('A malformed task verdict cannot gain generic approval'),undefined,()=>({}));
  const result=await h.plan(payload);
  assert.equal(result.outcome,'validation_failed');assert.equal(result.crmAction,null);
  assert.deepEqual(h.calls.map(c=>c.name),[plannerFormat,'pipechat_task_query_intent',plannerFormat,'pipechat_task_query_intent']);
});

function presentationFixture(showDashboard){
  const F=require('./fixtures/workspace-plans.cjs'),p=F.workspace();p.currentDate='2026-11-13';p.workspaceVersion='display-current';
  const spec={version:1,title:'Median deal value',chart:'kpi',scope:'all',groupBy:null,splitBy:null,bucket:'none',where:[],
    sort:'label_asc',limit:null,measures:[{label:'Median',metric:'median',field:'f_value',where:[]}]};
  const action=F.plan([{op:'report',id:'metric',label:'Median value and coverage',selection:null,spec,showDashboard,
    questions:[{kind:'summary',elementIds:['metric']}]}]);
  const presentationIntent={status:'resolved',elements:[{chart:'kpi',groupBy:null,splitBy:null,bucket:'none',measures:[{metric:'median',field:'f_value'}]}]};
  return {payload:{userCommand:'Show median deal value as a temporary KPI and say how many numeric values it uses.',pipeline:p},action,presentationIntent};
}
const medianReview=presentationIntent=>({...review([{...requirement('Median and numeric coverage','computed_read',true,['metric']),requiredOutputs:['median','count']}]),
  answerIntent:'canonical',answerSelection:null,presentationIntent});

test('a correct numerical answer without the requested KPI fails the supplemental check and repairs without another review call',async()=>{
  const {payload,presentationIntent}=presentationFixture(false);let attempt=0;
  const h=harness(input=>{
    if(attempt)assert.match(JSON.stringify(input.compilerRepair),/Missing final displayed element/);
    return {assistantMessage:'Median computed.',crmAction:presentationFixture(attempt++>0).action};
  },(input,body)=>{
    assert(body.text.format.schema.required.includes('presentationIntent'));
    assert(body.instructions.includes('supplemental presentation check'));
    assert(input.computed&&input.pipeline);return medianReview(presentationIntent);
  });
  const result=await h.plan(payload);
  assert.equal(result.crmAction?.steps[0].showDashboard,true,JSON.stringify({result,logs:h.logs}));
  assert.equal(attempt,2);assert.deepEqual(h.calls.map(c=>c.name),[plannerFormat,genericFormat,plannerFormat,genericFormat]);
  assert.equal(result.lifecycle.operation,'view');assert.equal(result.lifecycle.writesApplied,0);
});

test('passing presentation never overrides an unsatisfied semantic obligation',async()=>{
  const {payload,action,presentationIntent}=presentationFixture(true);
  const h=harness(()=>({assistantMessage:'The graph is visible.',crmAction:action}),()=>({...medianReview(presentationIntent),
    requirements:[{...requirement('The requested cohort was not selected','computed_read',false,['metric']),requiredOutputs:['median']}]}));
  const result=await h.plan(payload);
  assert.equal(result.outcome,'validation_failed');assert.equal(result.crmAction,null);assert.equal(result.computedAnswer,undefined);
  assert.deepEqual(h.calls.map(c=>c.name),[plannerFormat,genericFormat,plannerFormat,genericFormat]);
});

test('a malformed presentation inventory cannot silently approve a request or consume a citation-only repair',async()=>{
  const {payload,action}=presentationFixture(true);
  const h=harness(()=>({assistantMessage:'Graph prepared.',crmAction:action}),()=>medianReview(null));
  const result=await h.plan(payload);
  assert.equal(result.outcome,'validation_failed');assert.equal(h.calls.length,4);
  assert(h.calls.filter(c=>c.isReview).every(c=>!c.input.citationRepair));
});

test('answer-only analysis uses the ordinary review once; new intent extractors stay gated',async()=>{
  const {payload,action}=presentationFixture(false);payload.userCommand='What is the median value and how many numeric values are there? Do not change the dashboard.';
  const h=harness(()=>({assistantMessage:'Analysis prepared.',crmAction:action}),()=>medianReview({status:'not_requested',elements:[]}),
    ()=>assert.fail('No numeric-write extraction for a read'),()=>assert.fail('No ratio, weighted or task extraction for an ordinary median'));
  const result=await h.plan(payload);
  assert.equal(result.lifecycle.operation,'read');assert.deepEqual(h.calls.map(c=>c.name),[plannerFormat,genericFormat]);
  assert(result.computedAnswer.includes('numeric values'));
});

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
    assert.equal(body.text.format.schema.properties.presentationIntent,undefined);
    assert.deepEqual(body.text.format.schema.properties.answerIntent,{type:'string',enum:['canonical']});
    assert.deepEqual(body.text.format.schema.properties.answerSelection,{type:'null'});
    assert.match(body.instructions,/General advice, hypothetical examples and conversational coaching/);
    return {...review([requirement('Provide initial briefing advice','conversation')]),answerIntent:'canonical',answerSelection:null};
  });
  const result=await h.plan(payload);
  assert.equal(result.crmAction,null);assert.equal(result.assistantMessage,response.assistantMessage);assert.equal(result.coverage.compiled,1);
  assert.deepEqual(h.calls.map(c=>c.name),[plannerFormat,genericFormat]);
  const missing={...review([requirement('What did the saved client say?','computed_read')]),answerIntent:'canonical',answerSelection:null};
  assert.equal(Review.validateReview(missing,response).ok,false);
});

test('null-action prose cannot satisfy a requested visual through generic semantic review',async()=>{
  const {payload}=presentationFixture(false);
  const h=harness(()=>({assistantMessage:'The median KPI is ready.',crmAction:null,memoryNote:null}),(_input,body)=>{
    assert.equal(body.text.format.schema.properties.presentationIntent,undefined);
    return {...review([{...requirement('Display the computed median as a KPI','computed_read',true,['root']),
      requiredOutputs:['median','scalar_kpi']}]),answerIntent:'canonical',answerSelection:null};
  });
  const result=await h.plan(payload);
  assert.equal(result.outcome,'validation_failed');assert.equal(result.crmAction,null);assert.equal(result.computedAnswer,undefined);
  assert.deepEqual(h.calls.map(c=>c.name),[plannerFormat,genericFormat,plannerFormat,genericFormat]);
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

test('a dashboard citation can be repaired without regenerating its graph or dropping a required metric',async()=>{
  const payload=fixture();payload.userCommand='Display one temporary average deal value KPI.';
  const spec={version:1,title:'Mean value',chart:'kpi',groupBy:null,scope:'all',bucket:'none',splitBy:null,
    where:[],sort:'label_asc',limit:null,measures:[{metric:'average',label:'Mean',field:'f_value',where:[]}]};
  const proposal={assistantMessage:'Showing mean deal value.',memoryNote:null,crmAction:{action:'dashboard_plan',
    requestScope:{scope:'all',where:[]},operations:[{op:'add',id:'mean',spec}],questions:[]}};
  const h=harness(()=>proposal,input=>({...review([{...requirement('One average readout','computed_read',true,
    [input.citationRepair?'graph:mean':'root']),requiredOutputs:['average','scalar_kpi']}]),answerIntent:'canonical',answerSelection:null}));
  const response=await h.plan(payload);
  assert.deepEqual(copy(response.crmAction),proposal.crmAction);assert.equal(response.coverage.compiled,1);
  assert.deepEqual(h.calls.map(c=>c.isReview),[false,true,true]);
  assert.deepEqual(h.calls[1].input.computed,h.calls[2].input.computed);
  assert.equal(h.calls[2].input.citationRepair.requirements[0].stepIds[0],'root');
});

test('F04v sends the strict element/layout union and accepts its actual mixed review on the first attempt',async()=>{
  const payload=fixture();payload.userCommand='For QA1105 deals plot total deal value by stage beside a temporary mean KPI. Keep saved cards.';
  const where=[[{field:'f_deal',operator:'starts_with',value:'QA1105',values:[]}]];
  const desired=(chart,groupBy,metric)=>({chart,groupBy,scope:'all',bucket:'none',splitBy:null,limit:null,where,
    measures:[{metric,field:'f_value',where:[]}]});
  const requested=[desired('plot','f_stage','sum'),desired('kpi',null,'average')],ids=['stage_total','mean'];
  const operations=requested.map((element,i)=>({op:'add',id:ids[i],spec:{...element,version:1,where:[],chart:i?'kpi':'bar',title:ids[i],
    sort:'label_asc',measures:element.measures.map(m=>({...m,label:m.metric}))}}));
  const result={assistantMessage:'Showing both.',memoryNote:null,crmAction:{action:'dashboard_plan',requestScope:{scope:'all',where},operations,questions:[]}};
  const h=harness(()=>result,(input,body)=>{
    const item=body.text.format.schema.properties.requirements.items;
    assert.equal(input.pipeline,undefined,'the composition reviewer does not need raw CRM rows');
    assert.equal(input.proposalMessage,undefined,'planner prose is not display evidence');
    assert(input.fields.some(f=>f.id==='f_value'));assert.equal(input.userCommand,payload.userCommand);
    assert.equal(input.computed.board.elements.length,2);
    assert.equal(body.text.format.strict,true);assert(!item.properties);
    assert(item.anyOf.some(b=>b.properties['graph:mean']));assert(item.anyOf.some(b=>b.properties.widgetLayout));
    assert(!item.anyOf.some(b=>b.properties.plottedLayout));assert(input.allowedStepIds.includes('unchanged:kpis'));
    const claim=(shape,stepIds,requiredOutputs,evidenceKind='computed_read')=>({...shape,...requirement('Requested outcome',evidenceKind,true,stepIds),requiredOutputs});
    return {...review([claim({'graph:stage_total':{requestedCohort:'cohort_1'}},['graph:stage_total'],['sum','groups']),
      claim({'graph:mean':{requestedCohort:'cohort_1'}},['graph:mean'],['average','scalar_kpi']),
      claim({widgetLayout:['plot','kpi']},['graph:stage_total','graph:mean'],['separate_widgets']),
      claim({preserve:'verified_constraint'},['unchanged:kpis'],['unchanged_kpis'],'constraint')]),answerIntent:'canonical',answerSelection:null};
  });
  const response=await h.plan(payload);
  assert.equal(response.coverage.compiled,4);assert.deepEqual(h.calls.map(call=>call.name),[plannerFormat,'pipechat_ratio_calculation_intent',genericFormat]);assert.deepEqual(h.logs,[]);
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

test('F06 server review maps a prefix KPI and two retained graphs without weakening unsupported-output rejection',async()=>{
  const Dashboard=require('../public/dashboard-board'),Core=require('../public/pipeline-core'),payload=fixture();
  const ids=['deal_value_by_stage','deal_value_by_owner'],p=payload.pipeline,row=p.records[0];
  p.records=Array.from({length:49},(_,i)=>({...row,id:i+1,f_deal:i<4?'QA26 '+i:i===4?'Embedded QA26':'Other '+i,f_value:i<4?[10000,20000,0,4000][i]:90000}));
  p.visibleIds=[49];
  const spec=field=>({version:1,title:'Deal value by '+field,chart:'bar',scope:'all',groupBy:field,bucket:'none',splitBy:null,where:[],sort:'label_asc',limit:null,
    measures:[{label:'Value',metric:'sum',field:'f_value',where:[]}]});
  p.dashboard={board:Dashboard.apply(null,{action:'dashboard_plan',operations:ids.map((id,i)=>({op:'add',id,spec:spec(i?'f_owner':'f_stage')})),questions:[]},p.records,Core.create(p.tableSchema),[],{today:p.currentDate}).board};
  payload.userCommand='Keep those two graphs and add a KPI called QA26 average showing the average deal value for accounts whose names start with QA26.';
  const result={assistantMessage:'Untrusted average 99999.',crmAction:{action:'add_kpi',kpiId:null,kpi:{title:'QA26 average',metric:'average',field:'f_value',conditions:[],where:[[{field:'f_deal',operator:'starts_with',value:'QA26'}]]}}};
  for(const invalid of [true,false]){
    const h=harness(()=>result,(input,body)=>{
      const props=body.text.format.schema.properties.requirements.items.properties;
      assert(props.evidenceKind.enum.includes('constraint'));assert(props.requiredOutputs.items.enum.includes('kpi_definition'));
      assert.equal(input.computed.summary.value,8500);assert.equal(input.computed.summary.count,4);assert.equal(input.computed.summary.numericCount,4);
      const invariants=ids.map(id=>'unchanged:graph:'+id);
      assert(invariants.every(id=>input.allowedStepIds.includes(id)&&props.stepIds.items.enum.includes(id)));
      const req=(kind,stepIds,requiredOutputs)=>({...requirement('Requested outcome',kind,true,stepIds),requiredOutputs});
      return {...review([req('compiled_action',['root'],['kpi_definition']),req('computed_read',['root'],['average']),
        ...invariants.map(id=>req('constraint',invalid?['root']:[id],['unchanged_graphs']))]),answerIntent:'canonical',answerSelection:null};
    });
    const response=await h.plan(payload);
    if(invalid){
      assert.equal(response.outcome,'validation_failed');assert.equal(h.calls.length,4);
      assert(h.logs.every(log=>log.counts.requested===4&&log.counts.compiled===2&&log.mappingReasons.unsupported_required_output===2));
    }else{
      assert.equal(response.crmAction.action,'add_kpi');assert.equal(response.coverage.compiled,4);assert.equal(h.calls.length,2);assert.deepEqual(h.logs,[]);
      assert.match(response.computedAnswer,/\$8,500.*4 matching records; 4 numeric values/);assert.doesNotMatch(response.computedAnswer,/99999/);
    }
  }
});

test('delete-only KPI server review retains the other saved KPI and both graphs using exact proof IDs',async()=>{
  const Customize=require('../public/workspace-customization'),Dashboard=require('../public/dashboard-board'),Core=require('../public/pipeline-core');
  const payload=fixture(),p=payload.pipeline,averageId='kpi_user_qa26',percentageId='kpi_user_missing',graphIds=['deal_value_by_stage','deal_value_by_owner'];
  p.tableSchema=Customize.addKpi(p.tableSchema,[],averageId,{title:'QA26 average',metric:'average',field:'f_value',conditions:[],where:[[{field:'f_deal',operator:'starts_with',value:'QA26'}]]}).tableSchema;
  p.tableSchema=Customize.addKpi(p.tableSchema,[],percentageId,{title:'Missing follow-up percent',metric:'percentage',field:null,conditions:[],where:[[{field:'f_follow',operator:'is_blank',value:null}]],denominatorWhere:[]}).tableSchema;
  const spec=groupBy=>({version:1,title:'Deal value',chart:'bar',scope:'all',groupBy,bucket:'none',splitBy:null,where:[],sort:'label_asc',limit:null,
    measures:[{label:'Value',metric:'sum',field:'f_value',where:[]}]});
  p.dashboard={board:Dashboard.apply(null,{action:'dashboard_plan',operations:graphIds.map((id,i)=>({op:'add',id,spec:spec(i?'f_owner':'f_stage')})),questions:[]},p.records,Core.create(p.tableSchema),[],{today:p.currentDate}).board};
  const before=copy(p);
  payload.userCommand='Delete only saved dashboard KPI named QA26 average. Keep Missing follow-up percent card and graphs.';
  const result={assistantMessage:'Untrusted: deleted everything.',crmAction:{action:'delete_kpi',kpiId:averageId,kpi:null}};
  for(const invalid of [true,false]){
    const h=harness(()=>result,(input,body)=>{
      const req=(kind,id,requiredOutputs)=>({...requirement('Requested outcome',kind,true,[id]),requiredOutputs});
      const retained='unchanged:kpi:'+percentageId;
      assert(input.allowedStepIds.includes(retained));assert(!input.allowedStepIds.includes('unchanged:kpi:'+averageId));
      assert(body.text.format.schema.properties.requirements.items.properties.requiredOutputs.items.enum.includes('unchanged_kpis'));
      return review([req('compiled_action','root',['kpi_definition']),req('constraint',invalid?'root':retained,['unchanged_kpis']),
        ...graphIds.map(id=>req('constraint','unchanged:graph:'+id,['unchanged_graphs']))]);
    });
    const response=await h.plan(payload);
    if(invalid){
      assert.equal(response.outcome,'validation_failed');assert.equal(h.calls.length,4);
      assert(h.logs.every(log=>log.counts.requested===4&&log.counts.compiled===3&&log.mappingReasons.unsupported_required_output===1));
    }else{
      assert.equal(response.crmAction.action,'delete_kpi');assert.equal(response.crmAction.kpiId,averageId);
      assert.equal(response.coverage.compiled,4);assert.equal(h.calls.length,2);assert.deepEqual(h.logs,[]);
      assert.match(response.computedAnswer,/Review removal of KPI "QA26 average".*No KPI has been deleted/);
    }
    assert.deepEqual(p,before);
  }
});

test('resolved plural preview maps lifecycle and unchanged outsiders to explicit proof IDs on the server path',async()=>{
  const F=require('./fixtures/workspace-plans.cjs'),payload=fixture(),p=payload.pipeline;
  p.records=[{...p.records[0],id:1,f_deal:'Juniper Alpha'},{...p.records[0],id:2,f_deal:'Juniper Beta'},{...p.records[0],id:3,f_deal:'Other'}];p.visibleIds=[3];
  payload.userCommand='Both Juniper deals. Preview the follow-up date change; leave other deals unchanged.';
  const action=F.plan([F.select('juniper',[[F.where('f_deal','in',null,['Juniper Alpha','Juniper Beta'])]]),F.update('dates','juniper','f_follow','2026-10-29')]);
  const h=harness(()=>({crmAction:action,assistantMessage:'Review both changes.'}),(input,body)=>{
    const req=(kind,id,output)=>({...requirement('Requested outcome',kind,true,[id]),requiredOutputs:output});
    for(const id of ['dates','lifecycle:preview_only','unchanged:records:outside:juniper'])assert(input.allowedStepIds.includes(id));
    assert.equal(input.computed.lifecycle.executed,false);assert.equal(input.computed.patches.length,2);
    assert(body.text.format.schema.properties.requirements.items.properties.evidenceKind.enum.includes('constraint'));
    return review([req('compiled_action','dates',[]),req('constraint','lifecycle:preview_only',['preview_only']),req('constraint','unchanged:records:outside:juniper',['unchanged_records'])]);
  });
  const response=await h.plan(payload);assert.equal(response.coverage.compiled,3);
  assert.deepEqual(h.calls.map(c=>c.name),[plannerFormat,'pipechat_date_shift_intent',genericFormat]);assert.deepEqual(h.logs,[]);
  assert(p.records.every(row=>row.f_follow!=='2026-10-29'));
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
      assert(input.allowedStepIds.includes('unchanged:kpis'));
      assert(input.computed.constraintEvidence.some(p=>p.id==='unchanged:kpis'&&p.output==='unchanged_kpis'));
      const req=(description,stepIds,requiredOutputs)=>({...requirement(description,'computed_read',true,stepIds),requiredOutputs});
      return {...review([req('Keep count',invalid?[]:[invariants[0]],['unchanged_graphs']),req('Keep average',[invariants[1]],['unchanged_graphs']),
        req('Count by owner',['graph:new_count'],['count']),req('Average by owner',['graph:new_average'],['average']),
        req('Separate graphs',invalid?['graph:new_count']:['graph:new_count','graph:new_average'],['separate_graphs'])]),answerIntent:'canonical',answerSelection:null};
    });
    const response=await h.plan(payload);
    if(invalid){
      assert.equal(response.outcome,'validation_failed');assert.equal(response.crmAction,null);
      assert.deepEqual(h.calls.map(c=>c.name),[plannerFormat,'pipechat_ratio_calculation_intent',genericFormat,genericFormat]);
      assert(h.calls[3].input.citationRepair);assert.equal(h.logs.length,1);
      assert(h.logs.every(log=>log.counts.requested===5&&log.counts.compiled===3&&log.mappingReasons.missing_step_ids===1&&log.mappingReasons.unsupported_required_output===1));
    }else{assert.equal(response.coverage.compiled,5);assert.equal(h.calls.length,3);assert.deepEqual(h.logs,[]);}
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
