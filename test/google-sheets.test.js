const test=require('node:test'),assert=require('node:assert/strict');
const {exportUrl,safeRedirect,createSheetsReader}=require('../lib/google-sheets.js');
const link='https://docs.google.com/spreadsheets/d/abcdefghijklmnop/edit#gid=123';
test('Sheets links become narrowly scoped export requests, never arbitrary fetch URLs',()=>{
  assert.equal(exportUrl(link).href,'https://docs.google.com/spreadsheets/d/abcdefghijklmnop/export?format=csv&gid=123');
  assert.equal(exportUrl(link.replace('/d/','/d/e/').replace('/edit','/pubhtml')).searchParams.get('output'),'csv');
  for(const url of ['http://docs.google.com/spreadsheets/d/abcdefghijklmnop','https://localhost/','https://docs.google.com.evil.test/spreadsheets/d/abcdefghijklmnop','https://docs.google.com@evil.test/spreadsheets/d/abcdefghijklmnop','https://docs.google.com:8443/spreadsheets/d/abcdefghijklmnop',link.replace('123','http://localhost'),link.replace('/spreadsheets','/other')])assert.throws(()=>exportUrl(url));
  for(const url of ['http://docs.google.com/spreadsheets/x','https://accounts.google.com/','https://127.0.0.1/','https://doc-a-sheets.googleusercontent.com.evil.test/','https://docs.google.com/url?q=secret'])assert.equal(safeRedirect(new URL(url)),false);
});
test('bounded Sheets download follows only Google export redirects without application credentials',async()=>{
  const calls=[];const reader=createSheetsReader({fetchImpl:async(url,options)=>{calls.push({url,options});return calls.length===1?new Response(null,{status:302,headers:{location:'https://doc-abc-sheets.googleusercontent.com/export'}}):new Response('Name,Amount\nA,0',{headers:{'content-type':'text/csv'}});}});
  const result=await reader('qa-a',link);assert.equal(result.text,'Name,Amount\nA,0');assert.equal(calls.length,2);
  for(const {options} of calls){assert.deepEqual(options.headers,{Accept:'text/csv'});assert.equal(options.redirect,'manual');assert.equal(options.credentials,'omit');}
});
test('private, oversized and failed downloads are sanitized and never fetch rejected redirect targets',async()=>{
  for(const response of [new Response(null,{status:302,headers:{location:'http://127.0.0.1/secret'}}),new Response('<html>secret</html>',{headers:{'content-type':'text/html'}}),new Response('x',{headers:{'content-length':'5000001'}}),new Response('private-secret',{status:403})]){
    let calls=0;const reader=createSheetsReader({fetchImpl:async()=>{calls++;return response;}});await assert.rejects(()=>reader('u',link),e=>!e.message.includes('private-secret'));assert.equal(calls,1);
  }
  await assert.rejects(()=>createSheetsReader({fetchImpl:async()=>{throw Error('SECRET');}})('u',link),e=>e.status===502&&!e.message.includes('SECRET'));
});
test('download quota is separate from AI quota and resets after one minute',async()=>{
  let time=0,calls=0;const reader=createSheetsReader({now:()=>time,fetchImpl:async()=>{calls++;return new Response('A\nb');}});
  for(let i=0;i<6;i++)await reader('a',link);await assert.rejects(()=>reader('a',link),e=>e.status===429);assert.equal(calls,6);
  await reader('b',link);time=60001;await reader('a',link);assert.equal(calls,8);
});
test('download deadline aborts the provider request',async()=>{
  let aborted=false;const reader=createSheetsReader({timeoutMs:10,fetchImpl:async(url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(Error('private'));}))});
  await assert.rejects(()=>reader('a',link),e=>e.status===502);assert(aborted);
});
