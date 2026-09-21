// Contract emulator only. This does not validate a real Xano workspace implementation.
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const users=new Map(),tokens=new Map(),snapshots=new Map(),meters=new Map(),reservations=new Map();
const response=(status,body)=>({ok:status>=200&&status<300,status,json:async()=>body});
const usage=user=>{const meter=meters.get(user.id);return {...meter,remaining:Math.max(meter.limit-meter.used-meter.reserved,0)};};
global.fetch=async(url,options={})=>{
  if(String(url)==='https://api.openai.com/v1/responses') {
    const request=JSON.parse(options.body),input=JSON.parse(request.input[0].content[0].text);
    if(input.userCommand==='fail model')throw new Error('Test-only OpenAI failure');
    return response(200,{output_text:JSON.stringify({assistantMessage:'Mock model reply',crmAction:null,memoryNote:null})});
  }
  assert(String(url).startsWith('https://xano.example.test/api:pipechat/'));
  assert.equal(options.headers['X-PipeChat-Key'],process.env.XANO_SERVER_KEY);
  const endpoint=String(url).split('/api:pipechat/')[1],body=options.body?JSON.parse(options.body):{};
  if(endpoint==='pipechat/health')return response(200,{contract:'pipechat-xano-v1',capabilities:['auth','user-scoped-crm','atomic-crm-save','atomic-usage-reservations','token-revocation']});
  if(endpoint==='auth/signup'){
    if([...users.values()].some(u=>u.email===body.email))return response(409,{});
    const user={id:users.size+1,email:body.email,name:body.name,password:body.password};users.set(user.id,user);
    snapshots.set(user.id,{deals:[],updatedAt:null});meters.set(user.id,{used:0,reserved:0,limit:1});
    const token='test-xano-'+crypto.randomUUID();tokens.set(token,user.id);return response(200,{authToken:token});
  }
  if(endpoint==='auth/login'){
    const user=[...users.values()].find(u=>u.email===body.email&&u.password===body.password);if(!user)return response(401,{});
    const token='test-xano-'+crypto.randomUUID();tokens.set(token,user.id);return response(200,{authToken:token});
  }
  const token=options.headers.Authorization?.replace('Bearer ',''),user=users.get(tokens.get(token));
  if(!user)return response(401,{});
  if(endpoint==='auth/me')return response(200,user);
  if(endpoint==='auth/logout'){tokens.delete(token);return response(200,{ok:true});}
  if(endpoint==='crm'){
    if(user.email==='outage@example.test')return response(500,{error:'secret backend error'});
    if(options.method==='PUT'){
      if(body.expectedUpdatedAt!==snapshots.get(user.id).updatedAt)return response(409,{});
      snapshots.set(user.id,{deals:body.deals,updatedAt:crypto.randomUUID()});
    }
    return response(200,structuredClone(snapshots.get(user.id)));
  }
  if(endpoint==='chat-usage')return response(200,usage(user));
  if(endpoint==='chat-usage/reserve'){
    assert.deepEqual(Object.keys(body),['requestId']);
    if(usage(user).remaining===0)return response(402,{usage:usage(user)});
    const id=crypto.randomUUID();reservations.set(id,{userId:user.id,state:'reserved'});meters.get(user.id).reserved++;
    return response(200,{reservationId:id,usage:usage(user)});
  }
  if(endpoint==='chat-usage/finalize'){
    const reservation=reservations.get(body.reservationId);if(reservation?.userId!==user.id)return response(403,{});
    if(reservation.state==='reserved'){reservation.state=body.outcome;meters.get(user.id).reserved--;if(body.outcome==='commit')meters.get(user.id).used++;}
    return response(200,usage(user));
  }
  throw new Error('Unexpected Xano test endpoint '+endpoint);
};
