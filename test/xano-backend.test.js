const test = require('node:test');
const assert = require('node:assert/strict');
const { createXanoBackend, snapshotResult, usageResult } = require('../lib/xano-backend.js');
const serverKey = 'test-only-server-key-not-a-secret-12345';
const config = { baseUrl:'https://example.test/api:pipechat', serverKey };
const usage = {used:2,limit:10,reserved:1,remaining:7};
const row = {id:1,account:'Acme',stage:'Discovery',owner:'Jordan',value:100,close:'',next:'',follow:'',notes:'',history:[]};

test('Xano requires HTTPS, a private key and an application API URL',()=>{
  for(const baseUrl of ['http://example.test/api:test','https://user:pass@example.test/api:test','https://example.test/api:meta/workspace/1','https://example.test/api:test?token=secret']) {
    assert.throws(()=>createXanoBackend({...config,baseUrl}));
  }
  assert.throws(()=>createXanoBackend({...config,serverKey:''}));
  assert.throws(()=>createXanoBackend({...config,baseUrl:undefined}));
});
test('auth passes credentials only to the configured API and exposes only public user fields',async()=>{
  const seen=[];
  const backend=createXanoBackend({...config,fetchImpl:async(url,options)=>{
    seen.push({url:String(url),...options});
    assert.equal(options.headers['X-PipeChat-Key'],serverKey);assert.equal(options.redirect,'error');
    return {ok:true,json:async()=>String(url).endsWith('/auth/login')?{authToken:'private-auth-token-for-test'}:{id:7,email:'person@example.test',name:'Person',password:'NEVER RETURN THIS',internalRole:'admin'}};
  }});
  const result=await backend.authenticate('login',{email:'person@example.test',password:'test password',user_id:99});
  assert.equal(seen[0].url,'https://example.test/api:pipechat/auth/login');
  assert.deepEqual(JSON.parse(seen[0].body),{email:'person@example.test',password:'test password'});
  assert.equal(seen[1].headers.Authorization,'Bearer private-auth-token-for-test');
  assert.deepEqual(result.user,{id:7,email:'person@example.test',name:'Person'});
});
test('upstream errors never echo secrets and never become an empty dataset',async()=>{
  const backend=createXanoBackend({...config,fetchImpl:async()=>({ok:false,status:500,json:async()=>({error:serverKey})})});
  await assert.rejects(backend.readCrm('token'),error=>error.status===503&&!error.message.includes(serverKey));
  const unavailable=createXanoBackend({...config,fetchImpl:async()=>{throw new Error('Network failure '+serverKey);}});
  await assert.rejects(unavailable.readCrm('token'),/No local fallback/);
});
test('snapshot validation rejects incomplete/malformed responses and projects safe fields',()=>{
  assert.throws(()=>snapshotResult({deals:[]}));
  assert.throws(()=>snapshotResult({deals:[{id:1,account:'Missing fields'}],updatedAt:null}));
  assert.throws(()=>snapshotResult({deals:[row,row],updatedAt:'v1'}));
  const result=snapshotResult({deals:[{...row,user_id:99,password:'hidden'}],updatedAt:'v1'});
  assert.equal(result.deals[0].user_id,undefined);assert.equal(result.deals[0].password,undefined);
  assert.deepEqual(snapshotResult({deals:[],updatedAt:'saved-empty'}),{deals:[],updatedAt:'saved-empty'});
});
test('usage includes reserved calls and rejects inconsistent or absent counters',()=>{
  assert.equal(usageResult(usage).remaining,7);
  assert.equal(usageResult({used:0,limit:1,reserved:1,remaining:0}).paymentRequired,true);
  assert.throws(()=>usageResult({...usage,remaining:10}));assert.throws(()=>usageResult({}));
});
test('reservations and finalization carry opaque IDs, never user-controlled limits or owners',async()=>{
  const requests=[];
  const backend=createXanoBackend({...config,fetchImpl:async(url,options)=>{
    requests.push(JSON.parse(options.body));
    return {ok:true,json:async()=>String(url).endsWith('reserve')?{reservationId:'reservation-1',usage}:usage};
  }});
  const reservation=await backend.reserveUsage('token','request-1');
  await backend.finishUsage('token',reservation.reservationId,'commit');
  assert.deepEqual(requests,[{requestId:'request-1'},{reservationId:'reservation-1',outcome:'commit'}]);
});
test('stale writes preserve the conflict status and missing versions fail before sending',async()=>{
  let count=0;
  const backend=createXanoBackend({...config,fetchImpl:async()=>{count++;return {ok:false,status:409,json:async()=>({})};}});
  await assert.rejects(backend.writeCrm('token',[row],undefined),error=>error.status===400);assert.equal(count,0);
  await assert.rejects(backend.writeCrm('token',[row],'v1'),error=>error.status===409);
});
test('startup readiness requires the PipeChat contract, not merely a responding URL',async()=>{
  const backend=createXanoBackend({...config,fetchImpl:async()=>({ok:true,json:async()=>({ok:true})})});
  await assert.rejects(backend.check(),/integration contract/);
});
