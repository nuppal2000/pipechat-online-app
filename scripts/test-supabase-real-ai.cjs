'use strict';
const path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const Csv = require('../public/csv-import.js');
const { childEnvironment } = require('./start-supabase-browser-qa.js');
const Guard = require('./supabase-browser-qa-guard.cjs');

const RUN='60abf0b7-1d6c-402b-8297-dbce9727580b';
const KEY='sb_publishable_QTpUkzDxazN6L0DUhEfcwg_QthMCwGV';
const EMAIL=`supabase-qa-${RUN}-a@example.invalid`;
const HEADERS=['Applicant full name','Recruiting specialist','Hiring process phase','Annual salary expectation USD','Next candidate check-in','Evaluation rating','Candidate contact details','Legacy opaque code'];
const VALUES=[
  ['AI QA, Applicant One','Sarah','Interview','$125,000.50','2026-10-01','9.5','qa-one@example.invalid','X7ZZ'],
  ['AI QA Zero','Ravi','Sourced','0','2026-10-02','0','','Q2XY'],
  ['AI QA Uncertain','Daniel','Ambiguous','not money','03/04/26','not a score','','M9AB']
];
const ROWS=VALUES.map(row=>Object.fromEntries(HEADERS.map((h,i)=>[h,row[i]])));
const DESCRIPTION=Csv.validateDescription(Csv.describe(HEADERS,ROWS));
const NAMES=['Candidate','Recruiter','Hiring stage','Expected compensation','Follow-up date','Score','Contact'];
const fail=message=>{throw new Error(message);};

function realAiTransport(nativeFetch, guardedFetch, key, notify=()=>{}) {
  let attempts=0;
  return async(input,init={})=>{
    const url=new URL(input instanceof Request?input.url:input);
    if(url.pathname==='/rest/v1/rpc/pipechat_write_crm') fail('CRM writes are disabled in this preview-only test.');
    if(url.href!=='https://api.openai.com/v1/responses') return guardedFetch(input,init);
    if(init.method!=='POST'||typeof init.body!=='string'||attempts!==0) fail('Only one approved model request is allowed.');
    const body=JSON.parse(init.body);
    const described=JSON.parse(body.input?.[0]?.content?.[0]?.text);
    if(JSON.stringify(described)!==JSON.stringify(DESCRIPTION)||body.model!==Guard.MODEL||body.text?.format?.type!=='json_schema'||body.tools) fail('Only the synthetic CSV mapping request is allowed.');
    attempts++;
    notify({type:'real-ai-attempt',count:attempts});
    const request={...body,model:'gpt-5.5',max_output_tokens:4000,store:false};
    const headers=new Headers(init.headers); headers.set('Authorization',`Bearer ${key}`);
    try {
      return await nativeFetch(url.href,{...init,headers,body:JSON.stringify(request),redirect:'error'});
    } finally { key=''; }
  };
}

function checkMapping(snapshot,action) {
  if(snapshot.tableSchema?.useCase!=='Recruiting'||snapshot.tableSchema.status!=='ready') fail('Expected the existing recruiting QA table.');
  const core=Csv.forTable(snapshot.tableSchema,snapshot.customFields);
  const fields=[...snapshot.tableSchema.fields,...snapshot.customFields];
  const ids=NAMES.map(name=>{
    const matching=fields.filter(f=>f.name===name);
    if(matching.length!==1) fail('QA table fields changed; review before running.');
    return matching[0].id;
  });
  if(action.action!=='import_mapping') fail('Model did not return a mapping preview.');
  const preview=core.build(HEADERS,ROWS,action);
  for(let i=0;i<ids.length;i++) if(preview.mapping[ids[i]]!==HEADERS[i]) fail('Semantic header mapping did not match the expected meaning.');
  if(preview.records.length!==3||!preview.ignored.includes('Legacy opaque code')) fail('Unrelated source data was not left unmapped.');
  const expected=[
    ['AI QA, Applicant One','Sarah','Interview',125000.5,'2026-10-01',9.5,'qa-one@example.invalid'],
    ['AI QA Zero','Ravi','Sourced',0,'2026-10-02',0,''],
    ['AI QA Uncertain','Daniel','',null,'',null,'']
  ];
  for(let row=0;row<3;row++) for(let col=0;col<ids.length;col++) if(preview.records[row][ids[col]]!==expected[row][col]) fail('Typed preview differs from expected valid/blank values.');
  return preview;
}

async function worker() {
  const [message]=await once(process,'message');
  if(message?.type!=='private-config'||typeof message.key!=='string'||!/^sk-\S{16,}$/.test(message.key)) fail('Missing private worker configuration.');
  const nativeFetch=global.fetch;
  Guard.install();
  global.fetch=realAiTransport(nativeFetch,global.fetch,message.key,data=>process.send?.(data));
  message.key='';
  require('../server.js');
}

async function main(input) {
  if(input?.authorization!=='AI' || typeof input.password!=='string' || input.password.length<8 || !/^sk-\S{16,}$/.test(input.key||'')) fail('Private input is invalid.');
  const env=childEnvironment({SUPABASE_URL:Guard.BASE,SUPABASE_PUBLISHABLE_KEY:KEY,PIPECHAT_QA_RUN_ID:RUN,...Object.fromEntries(['SystemRoot','WINDIR','PATH','TEMP','TMP'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]))},['--approved-qa']);
  const child=fork(__filename,['--worker','--approved-qa'],{cwd:path.resolve(__dirname,'..'),env,windowsHide:true,silent:true});
  const exit=once(child,'exit');
  child.stdout.resume(); child.stderr.resume();
  let attempts=0,root,stage='QA process startup',loggedIn=false;
  const jar=new Map();
  const deadline=setTimeout(()=>child.kill(),150000);
  async function req(route,method='GET',body) {
    if(!root||!['/api/auth/login','/api/auth/logout','/api/crm-data','/api/chat-usage','/api/pipechat-ai'].includes(route)||method==='PUT') fail('Unapproved local route.');
    const response=await fetch(root+route,{method,redirect:'error',signal:AbortSignal.timeout(100000),headers:{'Content-Type':'application/json',Origin:root,Cookie:[...jar].map(([k,v])=>`${k}=${v}`).join('; ')},...(body===undefined?{}:{body:JSON.stringify(body)})});
    for(const cookie of response.headers.getSetCookie()) {
      const pair=cookie.split(';')[0],i=pair.indexOf('=');
      if(/Max-Age=0\b/i.test(cookie)) jar.delete(pair.slice(0,i)); else jar.set(pair.slice(0,i),pair.slice(i+1));
    }
    return {status:response.status,data:await response.json()};
  }
  const ok=response=>{if(response.status!==200) fail('Expected successful app response.');return response.data;};
  try {
    root=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('QA startup timeout.')),30000);
      child.on('message',message=>{
        if(message?.type==='real-ai-attempt') attempts=message.count;
        if(message?.type==='qa-ready'&&Number.isInteger(message.port)&&message.port>0&&message.port<65536){clearTimeout(timer);resolve(`http://127.0.0.1:${message.port}`);}
      });
      child.once('error',()=>{clearTimeout(timer);reject(new Error('QA startup failed.'));});
      child.once('exit',()=>{clearTimeout(timer);reject(new Error('QA exited before readiness.'));});
      child.send({type:'private-config',key:input.key}); input.key='';
    });
    stage='private QA A sign-in';
    const user=ok(await req('/api/auth/login','POST',{email:EMAIL,password:input.password})).user; input.password=''; loggedIn=true;
    if(user?.email!==EMAIL) fail('Wrong QA identity.');
    const before=ok(await req('/api/crm-data'));
    const usage=ok(await req('/api/chat-usage'));
    if(before.deals.length!==7||usage.reserved!==0||usage.remaining<1) fail('QA preconditions changed.');
    const fields=[...before.tableSchema.fields,...before.customFields];
    if(JSON.stringify(fields.map(f=>f.name))!==JSON.stringify(NAMES)) fail('Expected the reviewed seven-field recruiting table.');
    console.log('PASS: QA A verified; seven existing rows stay read-only. One real GPT-5.5 request is next.');
    stage='one real GPT-5.5 CSV mapping request';
    const response=await req('/api/pipechat-ai','POST',{userCommand:'Analyze this synthetic CSV for an append-only preview.',pipeline:{tableSchema:before.tableSchema,customFields:before.customFields,records:[]},csvImport:DESCRIPTION});
    const after=ok(await req('/api/crm-data')),afterUsage=ok(await req('/api/chat-usage'));
    if(JSON.stringify(before)!==JSON.stringify(after)) fail('Unexpected CRM modification during preview.');
    if(attempts!==1) fail('Unexpected model call count.');
    if(response.status!==200) {
      if(afterUsage.used===usage.used&&afterUsage.reserved===0) console.log('PASS: Failed model attempt left CRM unchanged and released the chat reservation.');
      fail('Model request failed.');
    }
    if(afterUsage.used!==usage.used+1||afterUsage.reserved!==0||afterUsage.limit!==usage.limit) fail('Unexpected chat accounting.');
    console.log('PASS: Exactly one real request and one chat charge; no reserved balance or CRM write.');
    stage='semantic mapping and typed preview assertions';
    checkMapping(before,response.data.crmAction);
    console.log('PASS: Seven differently named headers mapped by meaning; unrelated column ignored; valid amounts, zeroes and dates preserved; ambiguous values blank.');
    console.log('REAL AI PREVIEW PASSED. No import was confirmed or saved. Browser confirmation and production rollout remain separate checks.');
  } catch {
    console.log(`FAIL: ${stage}. No automatic model retry. Share status only; raw provider output withheld.`);
    process.exitCode=1;
  } finally {
    input.password=''; input.key='';
    if(loggedIn) {
      try { ok(await req('/api/auth/logout','POST',{})); console.log('PASS: Only this test login was signed out; existing browser sessions stay unchanged.'); }
      catch { console.log('FAIL: Test-session logout not verified. Revoke this QA session before launch.'); process.exitCode=1; }
    }
    jar.clear();
    if(child.connected) child.send({type:'qa-stop'},()=>{});
    const kill=setTimeout(()=>child.kill(),7000);
    await exit;
    clearTimeout(kill);clearTimeout(deadline);
  }
}

if(require.main===module) {
  (async()=>{
    if(process.argv.includes('--worker')&&process.argv.includes('--approved-qa')) return worker();
    if(process.argv.length!==3||process.argv[2]!=='--approved-qa') fail('Explicit opt-in required.');
    let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>8192)fail('Input too large.');}
    const parsed=JSON.parse(input);input='';await main(parsed);
  })().catch(()=>{console.log('FAIL: Real-AI runner refused input or failed to start. No private details printed.');process.exitCode=1;});
}
module.exports={HEADERS,ROWS,DESCRIPTION,NAMES,realAiTransport,checkMapping};
