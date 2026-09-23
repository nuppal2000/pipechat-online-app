const test=require('node:test');
const assert=require('node:assert/strict');
const Runner=require('../scripts/test-supabase-real-ai.cjs');
const Guard=require('../scripts/supabase-browser-qa-guard.cjs');

test('paid mapping transport allows exactly one synthetic bounded request and forbids CRM writes',async()=>{
  const calls=[],guarded=[];
  const transport=Runner.realAiTransport(async(...args)=>{calls.push(args);return new Response('{}');},async(...args)=>{guarded.push(args);return new Response('{}');},'sk-private-not-a-real-key');
  const body={model:Guard.MODEL,input:[{role:'user',content:[{type:'input_text',text:JSON.stringify(Runner.DESCRIPTION)}]}],text:{format:{type:'json_schema'}}};
  await assert.rejects(()=>transport('https://api.openai.com/v1/responses',{method:'POST',body:JSON.stringify({...body,input:[]})}));
  assert.equal(calls.length,0);
  await assert.rejects(()=>transport(Guard.BASE+'/rest/v1/rpc/pipechat_write_crm',{method:'POST'}));
  assert.equal(guarded.length,0);
  await transport('https://api.openai.com/v1/responses',{method:'POST',body:JSON.stringify(body)});
  assert.equal(calls.length,1);
  const request=JSON.parse(calls[0][1].body);
  assert.equal(request.model,'gpt-5.5'); assert.equal(request.max_output_tokens,4000); assert.equal(request.store,false);
  assert.equal(calls[0][1].redirect,'error'); assert.equal(calls[0][1].headers.get('Authorization'),'Bearer sk-private-not-a-real-key');
  await assert.rejects(()=>transport('https://api.openai.com/v1/responses',{method:'POST',body:JSON.stringify(body)}));
  await transport(Guard.BASE+'/auth/v1/user'); assert.equal(guarded.length,1);
});

test('failed paid request is not retried',async()=>{
  let count=0;
  const transport=Runner.realAiTransport(async()=>{count++;throw new Error('offline');},async()=>{},'sk-offline-test');
  const init={method:'POST',body:JSON.stringify({model:Guard.MODEL,input:[{content:[{text:JSON.stringify(Runner.DESCRIPTION)}]}],text:{format:{type:'json_schema'}}})};
  await assert.rejects(()=>transport('https://api.openai.com/v1/responses',init));
  await assert.rejects(()=>transport('https://api.openai.com/v1/responses',init));
  assert.equal(count,1);
});

test('semantic mapping assertions use the real importer and distinguish zeroes and invalid blanks',()=>{
  const design=Guard.tableDesign('Recruiting');
  const fields=design.fields.map((f,i)=>({...f,id:'f_'+i}));
  const snapshot={tableSchema:{...design,status:'ready',useCase:'Recruiting',description:'',fields},customFields:[{id:'cf_contact',name:'Contact',type:'text'}]};
  const action={action:'import_mapping',columnMap:Object.fromEntries([...fields,...snapshot.customFields].map((f,i)=>[f.id,Runner.HEADERS[i]])),stageMappings:[]};
  const preview=Runner.checkMapping(snapshot,action);
  assert.equal(preview.records.length,3);
  assert.equal(preview.issues.length,4);
  assert.throws(()=>Runner.checkMapping(snapshot,{...action,columnMap:{...action.columnMap,f_3:null}}));
});
