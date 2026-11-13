const test = require('node:test');
const assert = require('node:assert/strict');
const {parse,takeFallback,reviewModel,ModelResponseError} = require('../lib/model-response');
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

test('HTTP and provider failures expose only allowlisted categories without enabling fallback',()=>{
  const categories=['insufficient_quota','rate_limit_exceeded','invalid_json_schema',
    'invalid_api_key','model_not_found','invalid_request_error','authentication_error',
    'permission_denied','server_error'];
  for(const category of categories)for(const field of ['code','type'])for(const ok of [false,true]){
    const payload={},response={ok,status:ok?200:429};
    assert.throws(()=>parse(response,{error:{[field]:category}}),e=>{
      assert(e instanceof ModelResponseError);
      assert.equal(e.code,ok?'provider_error':'http_error');
      assert.equal(e.retryable,false);
      assert.equal(e.status,502);
      assert.equal(e.message,'The AI provider did not return a complete structured response.');
      assert.deepEqual(e.diagnostics,ok?{providerCategory:category}:{httpStatus:429,providerCategory:category});
      assert(Object.isFrozen(e.diagnostics));
      assert.equal(takeFallback(e,payload,models.simple,models,0,0),false);
      assert.deepEqual(payload,{});
      return true;
    });
  }
});

test('provider code takes precedence over type, with only exact allowlisted matches',()=>{
  for(const [code,type,category] of [
    ['insufficient_quota','rate_limit_exceeded','insufficient_quota'],
    ['PRIVATE_UNKNOWN_CODE','invalid_request_error','invalid_request_error'],
    [null,'invalid_api_key','invalid_api_key'],
    ['invalid_json_schema','PRIVATE_UNKNOWN_TYPE','invalid_json_schema'],
    ['INSUFFICIENT_QUOTA',' rate_limit_exceeded','unknown'],
    ['invalid_api_key\nPRIVATE_DETAIL','model_not_found:PRIVATE_DETAIL','unknown']
  ])assert.throws(()=>parse({ok:false,status:400},{error:{code,type}}),e=>{
    assert.deepEqual(e.diagnostics,{httpStatus:400,providerCategory:category});
    return true;
  });
});

test('diagnostic HTTP status accepts only integer numbers from 400 through 599 without coercion',()=>{
  for(let status=400;status<=599;status++){
    assert.throws(()=>parse({ok:false,status},null),e=>{
      assert.deepEqual(e.diagnostics,{httpStatus:status,providerCategory:'unknown'});
      return true;
    });
  }
  const noCoercion={valueOf(){assert.fail('Status must not be coerced');},toString(){assert.fail('Status must not be coerced');}};
  for(const status of [undefined,null,0,200,399,600,-429,429.5,NaN,Infinity,-Infinity,
    '429','429 PRIVATE_DETAIL',true,429n,Symbol('PRIVATE_DETAIL'),[429],new Number(429),noCoercion]){
    assert.throws(()=>parse({ok:false,status},{error:{code:'insufficient_quota',status:429}}),e=>{
      assert.deepEqual(e.diagnostics,{providerCategory:'insufficient_quota'});
      return true;
    });
  }
});

test('unknown provider fields and values cannot leak into errors or their serialized diagnostics',()=>{
  const secret='PRIVATE_PROVIDER_DETAIL';
  const hostile={toString(){assert.fail('Provider fields must not be coerced');},toJSON(){return secret;}};
  for(const value of [undefined,null,false,429,429n,Symbol(secret),secret,'constructor','__proto__',
    ['insufficient_quota'],new String('insufficient_quota'),{code:'insufficient_quota',secret},hostile]){
    for(const ok of [false,true]){
      const response={ok,status:ok?200:429,headers:{authorization:secret},statusText:secret};
      const data={error:{code:value,type:value,message:secret,param:secret,payload:{secret},
        headers:{secret},request_id:secret,unexpected:secret,toJSON(){return secret;}},output_text:secret};
      assert.throws(()=>parse(response,data),e=>{
        assert(e instanceof ModelResponseError);
        assert.deepEqual(e.diagnostics,ok?{providerCategory:'unknown'}:{httpStatus:429,providerCategory:'unknown'});
        assert.deepEqual(Object.getOwnPropertyNames(e).sort(),['code','diagnostics','message','name','retryable','stack','status']);
        assert.equal(Object.getOwnPropertySymbols(e).length,0);
        assert(!JSON.stringify(e).includes(secret));
        assert(!e.message.includes(secret));
        assert(!e.stack.includes(secret));
        return true;
      });
    }
  }
});

test('failure diagnostics never read raw messages, parameters, payloads or headers',()=>{
  const unreadable={get(){assert.fail('Raw provider details must not be read');}};
  const providerError={code:'invalid_json_schema'};
  for(const field of ['message','param','payload','headers','unexpected','toJSON']){
    Object.defineProperty(providerError,field,unreadable);
  }
  const response={ok:false,status:400};
  for(const field of ['headers','statusText','body'])Object.defineProperty(response,field,unreadable);
  assert.throws(()=>parse(response,{error:providerError}),e=>{
    assert.deepEqual(e.diagnostics,{httpStatus:400,providerCategory:'invalid_json_schema'});
    return true;
  });
});

test('the error constructor sanitizes diagnostic input and limits it to provider failures',()=>{
  const secret='PRIVATE_PROVIDER_DETAIL';
  for(const code of ['http_error','provider_error']){
    const source={httpStatus:429,providerCategory:'insufficient_quota',message:secret,
      param:secret,payload:{secret},headers:{secret},unexpected:secret};
    const error=new ModelResponseError(code,false,source);
    source.httpStatus=secret;source.providerCategory=secret;
    assert.deepEqual(error.diagnostics,{httpStatus:429,providerCategory:'insufficient_quota'});
    assert(!JSON.stringify(error).includes(secret));
    assert.deepEqual(new ModelResponseError(code,false,source).diagnostics,{providerCategory:'unknown'});
    assert.deepEqual(new ModelResponseError(code,false,null).diagnostics,{providerCategory:'unknown'});
    assert.deepEqual(new ModelResponseError(code).diagnostics,{providerCategory:'unknown'});
  }
  for(const code of ['refusal','output_limit','incomplete','not_completed','empty_output','invalid_json']){
    assert.equal(Object.hasOwn(new ModelResponseError(code,false,{httpStatus:400,providerCategory:'invalid_json_schema'}),'diagnostics'),false);
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

test('later reviews stay complex after completion fallback without changing its one-use allowance',()=>{
  const payload={},error=new ModelResponseError('output_limit',true);
  assert.equal(reviewModel(payload,models.simple,models),models.simple);
  assert.equal(takeFallback(error,payload,models.simple,models,0,30000),true);
  const repair={...payload,_reviewAttempt:1};
  assert.equal(reviewModel(repair,models.simple,models),models.complex);
  assert.equal(reviewModel(repair,models.complex,models),models.complex);
  assert.equal(reviewModel(repair,'explicit-model',models),'explicit-model');
  assert.equal(takeFallback(error,repair,models.simple,models,0,30001),false);
  assert.equal(reviewModel({},models.simple,models),models.simple,'separate requests remain independent');
  assert.equal(reviewModel(null,models.simple,models),models.simple);
  assert.equal(reviewModel(repair,models.simple,{simple:models.simple,complex:models.simple}),models.simple);
  assert.deepEqual(repair,{_completionFallbackUsed:true,_reviewAttempt:1});
});
