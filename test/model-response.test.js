const test = require('node:test');
const assert = require('node:assert/strict');
const {parse,takeFallback,ModelResponseError} = require('../lib/model-response');
const models={simple:'gpt-5.4-mini',complex:'gpt-5.2'};
const valid={assistantMessage:'Hello',crmAction:null};
const rest={status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(valid)}]}]};

test('REST and SDK completed JSON results are parsed without changing action values',()=>{
  assert.deepEqual(parse({ok:true},rest),valid);
  assert.deepEqual(parse({ok:true},{status:'completed',output_text:JSON.stringify(valid)}),valid);
});
test('an incomplete response never exposes even parseable partial output',()=>{
  assert.throws(()=>parse({ok:true},{...rest,status:'incomplete',incomplete_details:{reason:'max_output_tokens'}}),
    e=>e instanceof ModelResponseError&&e.code==='output_limit'&&e.retryable);
});
test('completion, HTTP, safety and JSON boundaries fail closed with bounded public metadata',()=>{
  for(const [response,data,code,retryable] of [
    [{ok:false},{error:{message:'PRIVATE_PROVIDER_DETAIL'}},'http_error',false],
    [{ok:true},{error:{message:'PRIVATE_PROVIDER_DETAIL'}},'provider_error',false],
    [{ok:true},{status:'failed'},'not_completed',false],
    [{ok:true},{status:'in_progress'},'not_completed',false],
    [{ok:true},{status:'incomplete',incomplete_details:{reason:'content_filter'}},'incomplete',false],
    [{ok:true},{status:'completed',output:[{content:[{type:'refusal',refusal:'PRIVATE_PROVIDER_DETAIL'}]}]},'refusal',false],
    [{ok:true},{status:'completed',output:[]},'empty_output',true],
    [{ok:true},{status:'completed',output_text:'{"private":"PRIVATE_PROVIDER_DETAIL"'},'invalid_json',true],
    [{ok:true},{status:'completed',output_text:'null'},'invalid_json',true],
    [{ok:true},{status:'completed',output_text:'[]'},'invalid_json',true]
  ]){
    assert.throws(()=>parse(response,data),e=>e.code===code&&e.retryable===retryable&&!JSON.stringify(e).includes('PRIVATE_PROVIDER_DETAIL'));
  }
});
test('fallback is once per turn, only from the simple model, with time left and no safety bypass',()=>{
  const error=new ModelResponseError('output_limit',true),payload={};
  assert.equal(takeFallback(error,payload,models.simple,models,0,30000),true);
  assert.equal(takeFallback(error,payload,models.simple,models,0,30001),false);
  assert.equal(takeFallback(error,{},models.complex,models,0,30000),false);
  assert.equal(takeFallback(error,{},models.simple,models,0,65000),false);
  assert.equal(takeFallback(new ModelResponseError('refusal'),{},models.simple,models,0,0),false);
  assert.equal(takeFallback(error,{},models.simple,{simple:models.simple,complex:models.simple},0,0),false);
});
