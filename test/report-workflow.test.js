const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const C=require('../public/pipeline-core.js');
const source=fs.readFileSync(path.join(__dirname,'../public/pipechat.js'),'utf8').replace(/\r\n/g,'\n');
const records=[
  {id:1,account:'Alpha',owner:'Ravi',value:150,stage:'Warm',close:'2026-10-01'},
  {id:2,account:'Beta',owner:'Sarah',value:250,stage:'Won',close:'2026-11-01'},
  {id:3,account:'Gamma',owner:'Daniel',value:900,stage:'Warm',close:'2026-12-01'},
  {id:4,account:'Alpha',owner:'Sarah',value:50,stage:'Warm',close:'2026-12-01'}
];
function harness(replies){
  const nodes=new Map(),calls=[],charts=[],messages=[];
  const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',textContent:'',innerHTML:'',style:{},setAttribute(name,value){this[name]=value;}});return nodes.get(id);};
  class Chart{constructor(canvas,config){charts.push(config);}destroy(){}}
  const context={window:{PipelineCore:C,PipeChatCustomize:require('../public/workspace-customization.js'),PipeChatIcons:{},Chart,messages},Chart,document:{getElementById:node,querySelector:node},AbortSignal,
    fetch:async(url,options)=>{calls.push({url,options});assert.equal(url,'/api/pipechat-ai');return {ok:true,json:async()=>({crmAction:{action:'show_report',report:replies.shift()},usage:{used:calls.length,remaining:100-calls.length}})};}};
  vm.runInNewContext(source.replace('  wire();\n  restoreSession();',`render=()=>renderReport(visible());renderReportSelections=()=>{};updateUsage=()=>{};toast=(text)=>window.messages.push(text);say=(text,role='assistant')=>{S.history.push({role,content:text});window.messages.push(text);};window.test={S,send,handleAction,renderReport,defaultReport};`),context);
  const h=context.window.test;
  Object.assign(h.S,{records:C.clone(records),user:{id:1,name:'QA'},loaded:true,usage:{used:0,remaining:100},health:{aiConfigured:true}});
  return {...h,node,calls,charts,messages};
}
const spec={metric:'sum',field:'value',groupBy:'owner',chart:'bar',owners:['Ravi','Sarah'],accounts:null,filter:null,from:null,to:null};
test('AI owner comparison and refinements carry full selections and render computed bars without writes',async()=>{
  const h=harness([spec,{...spec,metric:'average'}]);
  await h.send('Compare total value of all accounts under Ravi and Sarah');
  assert.equal(h.S.tab,'dashboard');assert.equal(h.S.pending,null);assert.equal(h.S.usage.used,1);
  assert.deepEqual(Array.from(h.charts[0].data.labels),['Sarah','Ravi']);
  assert.deepEqual(Array.from(h.charts[0].data.datasets[0].data),[300,150]);
  assert.match(h.node('reportCaption').textContent,/Owners: Ravi, Sarah/);
  await h.send('Now compare their average deal values');
  const payload=JSON.parse(h.calls[1].options.body);assert.deepEqual(payload.currentReport.owners,['Ravi','Sarah']);assert.equal(payload.currentReport.accounts,null);
  assert.equal(payload.conversationHistory[0].content,'Compare total value of all accounts under Ravi and Sarah');
  assert.deepEqual(Array.from(h.charts[1].data.datasets[0].data),[150,150]);
  assert.deepEqual(h.S.records,records);assert.equal(h.calls.length,2);assert.equal(h.S.pending,null);
});
test('account report produces one bar per selected name and resets to the all-owner default',async()=>{
  const h=harness([{...spec,groupBy:'account',owners:null,accounts:['Alpha','Beta']}]);
  await h.send('Compare the values for accounts Alpha and Beta');
  assert.equal(h.node('reportGroup').value,'account');assert.equal(h.node('reportGroupHeading').textContent,'Account');
  assert.deepEqual(Array.from(h.charts[0].data.labels),['Beta','Alpha']);
  assert.deepEqual(Array.from(h.charts[0].data.datasets[0].data),[250,200]);
  assert.match(h.node('reportCaption').textContent,/same account name are combined/);
  h.S.report=h.defaultReport();h.renderReport(h.S.records);
  assert.equal(h.S.report.owners,null);assert.equal(h.S.report.accounts,null);assert.equal(h.charts.at(-1).data.labels.length,3);
  assert.deepEqual(h.S.records,records);assert.equal(h.calls.length,1);
});
test('unmatched or malformed AI selections do not silently show all entities',async()=>{
  const h=harness([{...spec,owners:['Nobody']}]);await h.send('Compare Nobody');
  assert.equal(h.charts[0].data.labels.length,0);assert.match(h.node('reportCaption').textContent,/No matching deals in this view for Nobody/);
  assert.throws(()=>h.handleAction({crmAction:{action:'show_report',report:{...spec,owners:'Ravi, Sarah'}}},'Invalid'),/valid list/);
  assert.deepEqual(h.S.records,records);assert.equal(h.S.report.owners[0],'Nobody');
});
test('account labels are escaped in markup and unknown values stay null in chart data',async()=>{
  const name='<img src=x onerror=alert(1)>',h=harness([{...spec,groupBy:'account',owners:null,accounts:[name]}]);
  h.S.records=[{id:9,account:name,owner:'QA',value:null,stage:'Warm'}];await h.send('Compare this account');
  assert(h.node('reportRows').innerHTML.includes('&lt;img'));assert(!h.node('reportRows').innerHTML.includes('<img'));
  assert.equal(h.charts[0].data.datasets[0].data[0],null);assert.match(h.node('reportRows').innerHTML,/Not set/);
});
