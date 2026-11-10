'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module');
const Review=require('../lib/action-review'),F=require('./fixtures/workspace-plans.cjs');
const serverPath=path.join(__dirname,'../server.js'),source=fs.readFileSync(serverPath,'utf8'),localRequire=createRequire(serverPath);
const simple='gpt-5.4-mini',complex='gpt-5.2',copy=value=>JSON.parse(JSON.stringify(value));
const completed=value=>({ok:true,data:{status:'completed',output_text:JSON.stringify(value)}});
const limited={ok:true,data:{status:'incomplete',incomplete_details:{reason:'max_output_tokens'},output_text:'{"issues":[]}'}};

function harness(respond){
  const pipelines=new WeakMap(),calls=[],logs=[],delays=[],assertions=[];let now=1000;
  const context={__dirname:path.dirname(serverPath),Buffer,URL,structuredClone,AbortController,AbortSignal,
    Date:class extends Date{static now(){return now;}},
    setTimeout:(fn,delay)=>{delays.push(delay);return setTimeout(fn,delay);},clearTimeout,
    console:{log:line=>logs.push(JSON.parse(line)),warn:line=>logs.push(JSON.parse(line))},
    process:{env:{PIPECHAT_STORAGE_PROVIDER:'json',OPENAI_API_KEY:'OFFLINE_FIXTURE_ONLY',NODE_ENV:'test',PIPECHAT_SIMPLE_MODEL:simple,PIPECHAT_COMPLEX_MODEL:complex}},
    require(name){
      if(name==='node:http')return {createServer:()=>({})};
      if(name==='./lib/action-review.js')return {...Review,
        evidence:(payload,result)=>{const p=copy(payload),computed=Review.evidence(p,copy(result));pipelines.set(computed,p.pipeline);return computed;},
        schemaFor:(action,c)=>Review.schemaFor(copy(action),{...c,pipeline:pipelines.get(c.computed)}),
        allowedStepIdsFor:(action,c)=>Review.allowedStepIdsFor(copy(action),{...c,pipeline:pipelines.get(c.computed)}),
        validateReview:(review,result,c)=>Review.validateReview(copy(review),copy(result),{...c,pipeline:pipelines.get(c.computed)})};
      return localRequire(name);
    },
    fetch:async(url,options)=>{
      assert.equal(url,'https://api.openai.com/v1/responses');
      const body=JSON.parse(options.body),input=JSON.parse(typeof body.input==='string'?body.input:body.input[0].content[0].text);
      calls.push({name:body.text.format.name,model:body.model,body,input});now+=1000;
      try{const response=respond(calls.at(-1),calls.length-1);return {ok:response.ok,json:async()=>response.data};}
      catch(error){assertions.push(error);throw error;}
    }};
  const startup=source.lastIndexOf('start().catch(');assert(startup>0);
  vm.runInNewContext(source.slice(0,startup)+'\nglobalThis.planTest=planPipeChatAction;globalThis.reviewTest=runStructuredReview;',context,{filename:serverPath});
  const checked=async operation=>{try{return await operation();}finally{if(assertions.length)throw assertions[0];}};
  return {calls,logs,delays,advance:time=>now=time,
    plan:payload=>checked(()=>context.planTest(payload,{tier:'complex',model:complex,reason:'offline_test'},1000)),
    review:(payload,model)=>checked(()=>context.reviewTest({name:'offline_review',schema:{type:'object'},instructions:'Offline fixture',input:{}},1000,payload,model))};
}
function fixture(){
  const p={...F.workspace(),currentDate:'2026-11-10',workspaceVersion:'v1',visibleIds:[]};
  p.records.forEach((r,i)=>r.f_deal='QA1110 '+i);p.records[0].f_value=null;
  return {userCommand:'For QA1110 deals, make Priority High for amounts of $15,000 or more and Medium for smaller amounts. Skip any deal with no amount.',
    _requestId:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',pipeline:p};
}
const proposal=()=>({assistantMessage:'Prepared a priority classification for review.',memoryNote:null,
  crmAction:{action:'scoped_table_request',title:'Classify priorities',source:'all',where:[[F.where('f_deal','starts_with','QA1110')]],
    operation:{kind:'classify_number',numberField:'f_value',operator:'gte',threshold:15000,targetField:'f_priority',whenTrue:'High',otherwise:'Medium',whenBlank:'unchanged'}}});
function reviewFor(input,issues=[]){
  const req=(description,evidenceKind,stepIds,requiredOutputs)=>({description,evidenceKind,stepIds,requiredOutputs,satisfied:true});
  return {requirements:[...input.compiled.steps.filter(s=>s.op==='update_records').map(s=>req(s.label,'compiled_action',[s.id],[])),
    req('Skip missing amounts','constraint',['unchanged:records:blank:f_value'],['unchanged_records']),
    req('Keep excluded records unchanged','constraint',['unchanged:records:outside:known_values'],['unchanged_records'])],
    issues,clarificationQuestion:null,answerIntent:'canonical',answerSelection:null};
}

for(const stillInvalid of [false,true])test('completion fallback stays complex through semantic plan repair; final review '+(stillInvalid?'still rejects issues':'can approve'),async()=>{
  const payload=fixture(),before=copy(payload.pipeline);
  const h=harness((call,index)=>{
    if(index===0||index===3)return completed(proposal());
    if(index===1)return limited;
    assert([2,4].includes(index),'no extra retries');
    return completed(reviewFor(call.input,index===2||stillInvalid?['Check the requested threshold','Check the excluded population']:[]));
  });
  const response=await h.plan(payload);
  assert.deepEqual(h.calls.map(c=>[c.name,c.model]),[
    ['pipechat_response',complex],['pipechat_action_review',simple],['pipechat_action_review',complex],
    ['pipechat_response',complex],['pipechat_action_review',complex]]);
  assert.equal(h.calls.filter(c=>c.name==='pipechat_action_review').every(c=>c.body.max_output_tokens===8192),true);
  assert.deepEqual(h.delays,[79000,78000,76000],'review calls retain the original request deadline');
  assert.equal(payload._completionFallbackUsed,true);
  const diagnostics=h.logs.filter(l=>l.event==='pipechat.validation');
  assert.equal(diagnostics.length,stillInvalid?2:1);
  assert.deepEqual(diagnostics[0].counts,{requested:4,compiled:4,unsatisfied:0,mappingIssues:0,issues:2});
  if(stillInvalid){assert.equal(response.outcome,'validation_failed');assert.equal(response.crmAction,null);}
  else{assert.equal(response.crmAction.action,'workspace_plan');assert.deepEqual(copy(response.coverage),{requested:4,compiled:4});}
  assert.deepEqual(payload.pipeline,before);
});

test('fallback used by an earlier stage selects complex before any subsequent review fetch',async()=>{
  const h=harness(()=>completed({ok:true})),payload={_completionFallbackUsed:true};
  h.advance(70000);
  assert.deepEqual(copy(await h.review(payload)),{ok:true});
  assert.deepEqual(h.calls.map(c=>c.model),[complex]);assert.deepEqual(h.delays,[11000]);
  assert.equal(payload._completionFallbackUsed,true,'selection does not reset the allowance or extend the fallback window');
});

test('ordinary independent reviews still use mini until a retryable completion failure occurs',async()=>{
  const h=harness(()=>completed({ok:true}));
  await h.review({});await h.review({});
  assert.deepEqual(h.calls.map(c=>c.model),[simple,simple]);
});

for(const failure of [
  {code:'http_error',response:{ok:false,data:{error:{message:'PRIVATE_HTTP_DETAIL'}}}},
  {code:'refusal',response:{ok:true,data:{status:'completed',output:[{content:[{type:'refusal',refusal:'PRIVATE_REFUSAL_DETAIL'}]}]}}},
  {code:'provider_error',response:{ok:true,data:{error:{message:'PRIVATE_PROVIDER_DETAIL'}}}}
])test(failure.code+' never gains fallback, including after sticky escalation',async()=>{
  for(const used of [false,true]){
    const h=harness(()=>failure.response),payload=used?{_completionFallbackUsed:true}:{};
    await assert.rejects(h.review(payload),/completeness review could not finish/);
    assert.deepEqual(h.calls.map(c=>c.model),[used?complex:simple]);
    assert.equal(!!payload._completionFallbackUsed,used);
    assert.doesNotMatch(JSON.stringify(h.logs),/PRIVATE_/);
    assert.equal(h.logs[0].code,failure.code);
  }
});

test('another incomplete response on the sticky complex reviewer fails without another fallback',async()=>{
  const h=harness(()=>limited);
  await assert.rejects(h.review({_completionFallbackUsed:true}),/completeness review could not finish/);
  assert.deepEqual(h.calls.map(c=>c.model),[complex]);
});
