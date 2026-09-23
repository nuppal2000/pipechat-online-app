const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const C=require('../public/pipeline-core'),R=require('../public/report-engine');
const source=fs.readFileSync(require.resolve('../public/pipechat.js'),'utf8').replace(/\r\n/g,'\n');
function harness(){
 const nodes=new Map(),charts=[],messages=[];const node=id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',value:'',innerHTML:'',style:{},setAttribute(){}});return nodes.get(id);};
 class Chart{constructor(canvas,config){charts.push(config);}destroy(){}}
 const window={PipeChatReports:R,PipelineCore:C,PipeChatIcons:{},Chart,PipeChatCustomize:require('../public/workspace-customization')};
 const context={window,document:{getElementById:node,querySelector:node},Chart};
 // The browser exposes globalThis and window as the same object.
 vm.runInNewContext(fs.readFileSync(require.resolve('../public/report-ui'),'utf8'),{...context,globalThis:window});
 vm.runInNewContext(source.replace('  wire();\n  restoreSession();',`render=()=>renderReport(visible());renderTrust=()=>{};renderReportSelections=()=>{};toast=text=>window.messages.push(text);say=text=>{window.messages.push(text);};window.test={S,handleAction,renderReport,changeSmartReport,defaultReport};`),{...context,window:Object.assign(window,{messages})});
 const h=window.test;Object.assign(h.S,{loaded:true,user:{id:1,name:'QA'},scope:'mine',search:'Alpha',records:[{id:1,account:'Alpha',owner:'Ravi',value:100},{id:2,account:'Beta',owner:'Sarah',value:300}],customFields:[]});
 return {...h,node,charts,messages};
}
const report={version:1,title:'Selected reps',chart:'bar',scope:'all',groupBy:'owner',bucket:'none',splitBy:null,measures:[{label:'Total value',metric:'sum',field:'value',where:[]}],where:[[{field:'owner',operator:'in',value:null,values:['Ravi','Sarah']}]],sort:'value_desc',limit:null};
test('chat graph uses full table despite pipeline search/mine, stays read-only and preserves manual controls',()=>{
 const h=harness(),before=JSON.stringify(h.S.records);h.handleAction({crmAction:{action:'show_report',smartReport:report}},'Compare Ravi and Sarah');
 assert.equal(h.S.tab,'dashboard');assert.deepEqual(Array.from(h.charts[0].data.labels),['Sarah','Ravi']);assert.deepEqual(Array.from(h.charts[0].data.datasets[0].data),[300,100]);
 assert.equal(h.S.scope,'mine');assert.equal(h.S.search,'Alpha');assert.deepEqual(JSON.parse(JSON.stringify(h.S.report.owners)),['Ravi','Sarah']);
 h.changeSmartReport('reportMetric','average');assert.equal(h.S.report.measures[0].metric,'average');assert.equal(h.S.report.scope,'all');assert.equal(h.S.report.owners.length,2);
 assert.equal(JSON.stringify(h.S.records),before);assert.equal(h.S.pending,null);
});
test('bad chart requests retain the previous graph and clarification context',()=>{
 const h=harness();h.handleAction({crmAction:{action:'show_report',smartReport:report}},'Compare');const prior=JSON.stringify(h.S.report),count=h.charts.length;
 h.handleAction({crmAction:{action:'show_report',smartReport:{...report,groupBy:'unknown'}}},'Use missing field');
 assert.equal(JSON.stringify(h.S.report),prior);assert.equal(h.charts.length,count);assert.equal(h.S.clarification.originalCommand,'Use missing field');assert.match(h.messages.at(-1),/Quick clarification/);
});
test('primary default, escaped chart labels, KPI and date control integration',()=>{
 const h=harness();assert.equal(h.defaultReport().groupBy,'account');h.S.records[0].owner='<script>bad()</script>';
 h.handleAction({crmAction:{action:'show_report',smartReport:{...report,where:[],chart:'kpi'}}},'KPI');
 assert.match(h.node('reportKpis').innerHTML,/&lt;script&gt;/);assert(!h.node('reportKpis').innerHTML.includes('<script>'));
 h.changeSmartReport('reportGroup','close::month');assert.equal(h.S.report.bucket,'month');assert.equal(h.S.report.sort,'label_asc');
});
