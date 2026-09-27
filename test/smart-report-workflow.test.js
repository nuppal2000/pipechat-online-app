const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const C=require('../public/pipeline-core'),R=require('../public/report-engine');
const source=fs.readFileSync(require.resolve('../public/pipechat.js'),'utf8').replace(/\r\n/g,'\n');
function harness(multiple=false){
 const nodes=new Map(),charts=[],messages=[];const node=id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',value:'',innerHTML:'',style:{},setAttribute(){}});return nodes.get(id);};
 class Chart{constructor(canvas,config){charts.push(config);}destroy(){}}
 const window={PipeChatReports:R,PipelineCore:C,PipeChatIcons:{},Chart,PipeChatCustomize:require('../public/workspace-customization')};
 const context={window,document:{getElementById:node,querySelector:node},Chart};
 // The browser exposes globalThis and window as the same object.
 vm.runInNewContext(fs.readFileSync(require.resolve('../public/report-ui'),'utf8'),{...context,globalThis:window});
 if(multiple){window.PipeChatDashboard=require('../public/dashboard-board');window.PipeChatReportsUI.drawBoard=()=>[];}
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

test('multi-dashboard client plans, cached analysis, controls and contextual refinements preserve siblings and data',()=>{
 const h=harness(true),before=JSON.stringify(h.S.records);
 h.handleAction({crmAction:{action:'dashboard_plan',operations:[{op:'add',id:'first',spec:report},{op:'add',id:'second',spec:{...report,title:'Count',measures:[{label:'Count',metric:'count',field:null,where:[]}]}}],questions:[{kind:'value',label:'Highest',reference:{elementId:'first',measure:0,stat:'maximum'}}]}},'Two charts and highest');
 assert.equal(h.S.dashboard.elements.length,2);assert.equal(h.S.tab,'dashboard');assert.match(h.messages.at(-1),/Sarah/);const board=JSON.stringify(h.S.dashboard),charts=h.charts.length;
 h.handleAction({crmAction:{action:'analyze_dashboard',questions:[{kind:'value',label:'Smallest',reference:{elementId:'first',measure:0,stat:'minimum_nonzero'}}]}},'Smallest only');assert.equal(JSON.stringify(h.S.dashboard),board);assert.equal(h.charts.length,charts);assert.match(h.messages.at(-1),/Ravi/);
 h.changeSmartReport('reportChart','line');assert.equal(h.S.dashboard.elements[0].spec.chart,'bar');assert.equal(h.S.dashboard.elements[1].spec.chart,'line');
 h.handleAction({crmAction:{action:'filter_records',target:'context',mode:'replace_filter',where:[[{field:'owner',operator:'equals',value:'Sarah',values:[]}]],removeFields:[]}},'Now only Sarah');assert.equal(h.S.dashboard.elements.length,2);assert.equal(h.S.dashboard.elements[0].spec.where[0][0].operator,'in');assert.equal(h.S.dashboard.elements[1].spec.where[0][0].value,'Sarah');assert.equal(JSON.stringify(h.S.records),before);assert.equal(h.S.pending,null);
 h.S.revision++;assert.throws(()=>h.handleAction({crmAction:{action:'analyze_dashboard',questions:[]}},'Old graph'),/current dashboard/);
});
test('bad chart requests retain the previous graph and clarification context',()=>{
 const h=harness();h.handleAction({crmAction:{action:'show_report',smartReport:report}},'Compare');const prior=JSON.stringify(h.S.report),count=h.charts.length;
 h.handleAction({crmAction:{action:'show_report',smartReport:{...report,groupBy:'unknown'}}},'Use missing field');
 assert.equal(JSON.stringify(h.S.report),prior);assert.equal(h.charts.length,count);assert.equal(h.S.clarification.originalCommand,'Use missing field');assert.match(h.messages.at(-1),/Quick clarification/);
});

test('conversational report refinement keeps totals, grouping and open filters; invalid lists do not erase the graph',()=>{
 const h=harness();h.S.records=[{id:1,account:'A',owner:'Ravi',stage:'Warm',value:100},{id:2,account:'B',owner:'Sarah',stage:'Proposal Sent',value:300},{id:3,account:'C',owner:'Ravi',stage:'Won',value:999}];
 const base={...report,groupBy:'stage',where:[[{field:'stage',operator:'not_in',value:null,values:['Won','Lost']}]]};h.handleAction({crmAction:{action:'show_report',smartReport:base}},'Show total value by stage for open deals');
 const refine={action:'refine_report',mode:'add_filter',where:[[{field:'stage',operator:'in',value:null,values:['Warm','Proposal Sent']}]],replaceFields:[],changes:[]};
 h.handleAction({crmAction:refine},'Now show only Warm and Proposal Sent');assert.equal(h.S.report.measures[0].metric,'sum');assert.equal(h.S.report.groupBy,'stage');assert.equal(h.S.report.where[0].length,2);assert.deepEqual(Array.from(h.charts.at(-1).data.datasets[0].data),[300,100]);assert.equal(h.S.focus.kind,'report');
 const previous=JSON.stringify(h.S.report),count=h.charts.length;h.handleAction({crmAction:{...refine,where:[[{field:'stage',operator:'contains',value:'Warm|Proposal Sent',values:[]}]]}},'Only those two');assert.equal(JSON.stringify(h.S.report),previous);assert.equal(h.charts.length,count);assert(h.S.clarification);assert.equal(h.S.pending,null);
});
test('primary default, escaped chart labels, KPI and date control integration',()=>{
 const h=harness();assert.equal(h.defaultReport().groupBy,'account');h.S.records[0].owner='<script>bad()</script>';
 h.handleAction({crmAction:{action:'show_report',smartReport:{...report,where:[],chart:'kpi'}}},'KPI');
 assert.match(h.node('reportKpis').innerHTML,/&lt;script&gt;/);assert(!h.node('reportKpis').innerHTML.includes('<script>'));
 h.changeSmartReport('reportGroup','close::month');assert.equal(h.S.report.bucket,'month');assert.equal(h.S.report.sort,'label_asc');
});

test('contextual filtering preserves the report; explicitly targeted table filters remain available',()=>{
 const h=harness();h.S.scope='all';h.S.search='';h.S.records=[{id:1,account:'A',stage:'Warm',value:100},{id:2,account:'B',stage:'Proposal Sent',value:300},{id:3,account:'C',stage:'Won',value:999}];
 const base={...report,groupBy:'stage',where:[[{field:'stage',operator:'not_in',value:null,values:['Won','Lost']}]]};h.handleAction({crmAction:{action:'show_report',smartReport:base}},'Total value by stage for open deals');
 const filter={action:'filter_records',target:'context',mode:'add_filter',where:[[{field:'stage',operator:'in',value:null,values:['Warm','Proposal Sent']}]],removeFields:[]};
 h.handleAction({crmAction:filter},'Now only Warm and Proposal Sent');assert.equal(h.S.tab,'dashboard');assert.equal(h.S.filter,null);assert.equal(h.S.report.measures[0].metric,'sum');assert.deepEqual(Array.from(h.charts.at(-1).data.datasets[0].data),[300,100]);
 const saved=JSON.stringify(h.S.report);h.handleAction({crmAction:{...filter,target:'pipeline_table'}},'Show those stages in the pipeline table');assert.equal(h.S.tab,'table');assert.equal(h.S.focus.kind,'table');assert.equal(JSON.stringify(h.S.report),saved);assert.match(h.messages.at(-1),/Showing 2 matching records/);
 h.handleAction({crmAction:{...filter,where:[[{field:'value',operator:'gt',value:200,values:[]}]]}},'Now only values above 200');assert.match(h.messages.at(-1),/Showing 1 matching records/);assert.equal(h.S.filter.where[0].length,2);assert.equal(JSON.stringify(h.S.report),saved);
 h.handleAction({crmAction:{action:'clear_table_view'}},'Clear table filters');assert.equal(h.S.filter,null);assert.equal(h.S.scope,'all');assert.equal(JSON.stringify(h.S.report),saved);
});

test('the exact legacy misrouting response cannot switch away or produce a false empty table',()=>{
 const h=harness();h.handleAction({crmAction:{action:'show_report',smartReport:report}},'Show report');const before=JSON.stringify({report:h.S.report,filter:h.S.filter,tab:h.S.tab,records:h.S.records});
 assert.throws(()=>h.handleAction({crmAction:{action:'filter_view',filter:{field:'stage',operator:'contains',value:'Qualified, Proposal Sent'}}},'Now only Qualified and Proposal Sent'),/current view has been kept/);
 assert.equal(JSON.stringify({report:h.S.report,filter:h.S.filter,tab:h.S.tab,records:h.S.records}),before);
 assert.throws(()=>h.handleAction({crmAction:{action:'filter_records',target:'unknown',mode:'add_filter',where:[],removeFields:[]}},'Only these'),/report or the pipeline/);
 assert.equal(JSON.stringify({report:h.S.report,filter:h.S.filter,tab:h.S.tab,records:h.S.records}),before);
});

test('fresh record search leaves Dashboard, clears unrelated filters and applies sorting together without mutations',()=>{
 const h=harness();h.handleAction({crmAction:{action:'show_report',smartReport:report}},'Show chart');
 const saved=JSON.stringify(h.S.report),rows=JSON.stringify(h.S.records);h.S.filter={where:[[{field:'owner',operator:'equals',value:'Nobody',values:[]}]]};
 h.handleAction({crmAction:{action:'query_records',where:[[{field:'owner',operator:'in',value:null,values:['Ravi','Sarah']}]],orderBy:'value',direction:'desc'}},'Show Ravi or Sarah deals, highest first');
 assert.equal(h.S.tab,'table');assert.equal(h.S.focus.kind,'table');assert.equal(h.S.scope,'all');assert.equal(h.S.search,'');assert.equal(h.S.sort.field,'value');assert.equal(h.S.sort.direction,'desc');assert.match(h.messages.at(-1),/Showing 2 matching records, sorted/);
 assert.equal(JSON.stringify(h.S.report),saved);assert.equal(JSON.stringify(h.S.records),rows);assert.equal(h.S.pending,null);
 const prior=JSON.stringify(h.S);assert.throws(()=>h.handleAction({crmAction:{action:'query_records',where:[],orderBy:'missing',direction:'asc'}},'Bad sort'));assert.equal(JSON.stringify(h.S),prior);
});

test('one-off KPI never creates a persistent proposal or changes saved KPI definitions',()=>{
 const h=harness(),schema=JSON.stringify(h.S.tableSchema),rows=JSON.stringify(h.S.records);
 h.handleAction({crmAction:{action:'show_kpi',title:'One-off total',scope:'all',where:[],measures:[{label:'Total value',metric:'sum',field:'value',where:[]}]}},'Show me a KPI for total value');
 assert.equal(h.S.tab,'dashboard');assert.equal(h.S.report.chart,'kpi');assert.equal(h.S.report.groupBy,null);assert.equal(h.S.pending,null);assert.equal(JSON.stringify(h.S.tableSchema),schema);assert.equal(JSON.stringify(h.S.records),rows);assert.match(h.node('reportKpis').innerHTML,/400/);
});

test('audit output uses computed counts/names, ignores assistant arithmetic and leaves saved cards untouched',()=>{
 const h=harness();h.handleAction({crmAction:{action:'show_report',smartReport:report}},'Show chart');const schema=JSON.stringify(h.S.tableSchema);
 h.handleAction({assistantMessage:'There are 999 missing owners',crmAction:{action:'audit_records',scope:'all',where:[],groups:[{label:'Missing owner',where:[[{field:'owner',operator:'is_blank',value:null,values:[]}]]},{label:'Missing date',where:[[{field:'close',operator:'is_blank',value:null,values:[]}]]}]}},'Audit owners and dates');
 assert.equal(h.S.tab,'table');assert.equal(h.S.scope,'all');assert.equal(h.S.search,'');assert.match(h.messages.at(-1),/Missing owner \(0\)/);assert.match(h.messages.at(-1),/Missing date \(2\)/);assert.match(h.messages.at(-1),/Alpha \(#1\)/);assert.match(h.messages.at(-1),/Beta \(#2\)/);assert(!h.messages.at(-1).includes('999'));assert.equal(JSON.stringify(h.S.tableSchema),schema);assert.equal(h.S.pending,null);
});
