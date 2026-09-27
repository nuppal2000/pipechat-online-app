const test=require('node:test'),assert=require('node:assert/strict');
const D=require('../public/dashboard-board'),R=require('../public/report-engine'),C=require('../public/pipeline-core'),PDF=require('../public/dashboard-pdf');
const cond=(field,operator,value=null,values=[])=>({field,operator,value,values});
const stages=['Prospecting','Qualified','Proposal Sent','Negotiation'];
const custom=[{id:'cf_stage',name:'Segment',type:'choice',options:[...stages,'Won','Lost']},{id:'cf_date',name:'Review Day',type:'date'}];
const open=[[cond('cf_stage','in',null,stages)]];
const spec=(metric='count',extra={})=>({version:1,title:metric+' by Owner',chart:'bar',scope:'all',groupBy:'owner',bucket:'none',splitBy:null,where:open,measures:[{label:metric+' value',metric,field:metric==='count'?null:'value',where:[]}],sort:'value_desc',limit:null,...extra});
const rows=Array.from({length:42},(_,i)=>({id:i+1,account:'Record '+i,owner:i<6?'Ravi':i<15?'Sarah':'Neelam',value:i<5?68000:i===5?68500:i<14?50000:i===14?51500:i<21?36500:i===21?36800:9999,cf_stage:i<2?'Prospecting':i<5?'Qualified':i<15?'Proposal Sent':i<22?'Negotiation':i<27?'Won':i<29?'Lost':'',cf_date:i<13?'2026-09-30':''}));
function apply(board,operations,questions=[]){return D.apply(board,{action:'dashboard_plan',operations,questions},rows,C,custom,{today:'2026-09-27'});}
const add=(id,spec)=>({op:'add',id,spec});
const ref=(elementId,stat='aggregate')=>({elementId,measure:0,stat});
const groupRef=(elementId,group,series=null)=>({elementId,measure:0,stat:'group',group,series});
function initial(){return apply(null,[add('count',spec()),add('value',spec('sum'))]);}

test('named group references and group reports never substitute the overall average',()=>{
 const data=[...Array.from({length:6},(_,i)=>({id:i+1,owner:'Sarah',value:75250})),...Array.from({length:4},(_,i)=>({id:i+7,owner:'Ravi',value:79250}))];
 const r=D.apply(null,{action:'dashboard_plan',operations:[add('averages',spec('average',{where:[]}))],questions:[]},data,C);
 assert.equal(r.views[0].snapshot.summaries[0].value,76850);
 const answer=D.analyze([{kind:'value',label:'Sarah average',reference:groupRef('averages','Sarah')},{kind:'value',label:'Ravi average',reference:groupRef('averages','Ravi')},{kind:'groups',elementId:'averages',measure:0}],r.views);
 assert.match(answer,/Sarah average: \$75,250\.00/);assert.match(answer,/Ravi average: \$79,250\.00/);assert.match(answer,/Sarah: \$75,250\.00 \(6 records\)/);assert.match(answer,/Ravi: \$79,250\.00 \(4 records\)/);assert(!answer.includes('76,850'));
 assert.throws(()=>D.analyze([{kind:'value',label:'Missing',reference:groupRef('averages','Unknown')}],r.views),/missing or ambiguous/);
 const difference=D.analyze([{kind:'difference',label:'Group gap',left:groupRef('averages','Ravi'),right:groupRef('averages','Sarah')}],r.views);assert.match(difference,/Group gap: \$4,000\.00/);
});

test('group analysis rejects ambiguous split series and resolves the chosen plotted cell',()=>{
 const data=[{id:1,owner:'Ravi',stage:'Warm',value:20},{id:2,owner:'Ravi',stage:'Won',value:30}];
 const r=D.apply(null,{action:'dashboard_plan',operations:[add('split',spec('sum',{where:[],splitBy:'stage'}))],questions:[]},data,C);
 assert.throws(()=>D.analyze([{kind:'value',label:'Ravi',reference:groupRef('split','Ravi')}],r.views),/ambiguous/);
 const target=r.views[0].snapshot.table.find(row=>row.value===20);
 assert.match(D.analyze([{kind:'value',label:'Chosen cell',reference:groupRef('split','Ravi',target.series)}],r.views),/Chosen cell: \$20\.00/);
 assert.throws(()=>D.analyze([{kind:'groups',elementId:'split',measure:99}],r.views),/Choose a displayed/);
});
test('separate mixed-unit graphs coexist, use explicit stages, and summarize exact represented rows',()=>{
 const before=JSON.stringify(rows),r=initial();assert.equal(r.board.elements.length,2);assert.equal(r.views[0].snapshot.recordCount,22);assert.equal(r.views[0].snapshot.summaries[0].value,22);assert(Math.abs(r.views[1].snapshot.summaries[0].value-1115800)<0.01);assert.equal(JSON.stringify(rows),before);assert.match(r.answer,/22 records represented/);
});
test('changing only one chart preserves IDs, all filters and the other chart spec/data',()=>{
 const a=initial(),r=apply(a.board,[{op:'update',ids:['value'],mode:'add_filter',where:[],replaceFields:[],changes:[{field:'chart',value:'line'}]}]);
 assert.deepEqual(r.board.elements[0],a.board.elements[0]);assert.deepEqual(r.board.elements.map(e=>e.id),['count','value']);assert.equal(r.board.elements[1].spec.chart,'line');assert.deepEqual(r.views.map(v=>v.snapshot.table),a.views.map(v=>v.snapshot.table));
});
test('three added KPI elements keep both graphs and use the same 22-record cohort',()=>{
 const a=initial(),r=apply(a.board,['count','sum','average'].map(metric=>add('kpi_'+metric,spec(metric,{chart:'kpi',groupBy:null}))));
 assert.equal(r.board.elements.length,5);assert.deepEqual(r.board.elements.slice(0,2),a.board.elements);assert(r.views.every(v=>v.snapshot.recordCount===22));assert(Math.abs(r.views[4].snapshot.summaries[0].value-50718.181818)<0.01);
});
test('shared filter targets all five, then removal restores specs, layout, IDs and data byte-for-byte',()=>{
 const a=apply(initial().board,['count','sum','average'].map(metric=>add('kpi_'+metric,spec(metric,{chart:'kpi',groupBy:null})))),ids=a.board.elements.map(e=>e.id);
 const b=apply(a.board,[{op:'set_shared_filter',id:'ravi',targets:ids,where:[[cond('owner','equals','Ravi')]]}]);
 assert(b.views.every(v=>v.snapshot.recordCount===6&&v.snapshot.sharedFilters[0].id==='ravi'));assert(Math.abs(b.views[1].snapshot.summaries[0].value-408500)<0.01);assert(Math.abs(b.views[4].snapshot.summaries[0].value-68083.333333)<0.01);
 const c=apply(b.board,[{op:'remove_shared_filter',id:'ravi'}]);assert.deepEqual(c.board,a.board);assert.deepEqual(c.views,a.views);
});
test('shared filter on a subset preserves untargeted graphs; newly added all-record graph does not inherit it',()=>{
 const a=apply(initial().board,[{op:'set_shared_filter',id:'one',targets:['value'],where:[[cond('owner','equals','Ravi')]]},add('all_stages',spec('count',{groupBy:'cf_stage',where:[],chart:'stage'}))]);
 assert.deepEqual(a.views.map(v=>v.snapshot.recordCount),[22,6,42]);assert.equal(a.views[2].snapshot.sharedFilters.length,0);assert.equal(a.views[2].snapshot.table.find(t=>t.group==='Not set').value,13);
});
test('date grouping excludes blanks from represented coverage and preserves other chart cohorts',()=>{
 const r=apply(initial().board,[add('week',spec('sum',{chart:'line',groupBy:'cf_date',bucket:'week',sort:'label_asc'})),add('stages',spec('count',{chart:'stage',groupBy:'cf_stage',where:[]}))]);
 assert.deepEqual(r.views.map(v=>v.snapshot.recordCount),[22,22,13,42]);assert.equal(r.views[2].snapshot.undated,9);assert.equal(r.views[2].snapshot.table[0].group,'2026-09-28');assert.equal(r.views[3].snapshot.table.find(t=>t.group==='Not set').value,13);
 const answer=D.analyze([{kind:'percentage',label:'Open share',left:ref('count','records'),right:ref('stages','records')},{kind:'difference',label:'Peak difference',left:ref('value','maximum'),right:ref('week','maximum')}],r.views);
 assert.match(answer,/52.38%/);assert.match(answer,/22 records, grouped by Owner/);assert.match(answer,/13 records, grouped by Review Day \/ week/);
});
test('largest and smallest nonzero preserve every tie and analysis uses cached graph results only',()=>{
 const data=[{id:1,account:'A',owner:'A',value:20},{id:2,account:'B',owner:'B',value:20},{id:3,account:'C',owner:'C',value:5},{id:4,account:'D',owner:'D',value:5},{id:5,owner:'Z',value:0}];
 const r=D.apply(null,{action:'dashboard_plan',operations:[add('values',spec('sum',{where:[]}))],questions:[]},data,C),before=JSON.stringify(r);
 data[0].value=9999;
 const answer=D.analyze([{kind:'value',label:'Largest',reference:ref('values','maximum')},{kind:'value',label:'Smallest nonzero',reference:ref('values','minimum_nonzero')}],r.views);
 assert.match(answer,/A, B/);assert.match(answer,/C, D/);assert(!answer.includes('9999'));assert.equal(JSON.stringify(r),before);
});
test('all-record Stage chart reports all exact groups independently of prior open views',()=>{
 const r=apply(initial().board,[add('stages',spec('count',{where:[],groupBy:'cf_stage',chart:'stage'}))]);
 assert.deepEqual(Object.fromEntries(r.views[2].snapshot.table.map(t=>[t.group,t.value])),{'Not set':13,'Proposal Sent':10,Negotiation:7,Won:5,Qualified:3,Lost:2,Prospecting:2});
});
test('remove only requested elements, prune shared targets, keep remaining IDs, reset to empty',()=>{
 const a=apply(initial().board,[{op:'set_shared_filter',id:'ravi',targets:['count','value'],where:[[cond('owner','equals','Ravi')]]}]);
 const b=apply(a.board,[{op:'remove',ids:['value']}]);assert.equal(b.board.elements[0].id,'count');assert.deepEqual(b.board.sharedFilters[0].targets,['count']);assert.equal(b.board.activeId,'count');
 const c=apply(b.board,[{op:'clear'}]);assert.deepEqual(c.board,D.empty());
});
test('invalid later operations, missing analysis refs and duplicate IDs cannot partially commit',()=>{
 const a=initial(),before=JSON.stringify(a);
 for(const operations of [[add('new',spec()),{op:'remove',ids:['unknown']}],[add('count',spec())],[{op:'set_shared_filter',id:'bad',targets:['unknown'],where:open}]])assert.throws(()=>apply(a.board,operations));
 assert.throws(()=>apply(a.board,[add('new',spec())],[{kind:'value',label:'Bad',reference:ref('unknown')} ]));assert.equal(JSON.stringify(a),before);
});
test('incompatible metrics and non-subset percentages request clarification; zero denominators are not invented',()=>{
 const r=initial();assert.throws(()=>D.analyze([{kind:'difference',label:'Bad',left:ref('count'),right:ref('value')}],r.views),/different units/);
 const a=apply(r.board,[add('empty',spec('count',{where:[[cond('owner','equals','Nobody')]]}))]);
 assert.match(D.analyze([{kind:'percentage',label:'Empty',left:ref('empty','records'),right:ref('empty','records')}],a.views),/Not set/);
 assert.throws(()=>D.analyze([{kind:'percentage',label:'Bad share',left:ref('count','records'),right:ref('empty','records')}],a.views),/not a subset/);
});
test('top-N represented count and averages use plotted rows, not unweighted mean of group means',()=>{
 const r=D.apply(null,{action:'dashboard_plan',operations:[add('top',spec('average',{where:[],limit:1}))],questions:[]},[{id:1,owner:'A',value:10},{id:2,owner:'A',value:30},{id:3,owner:'B',value:100}],C);
 assert.equal(r.views[0].snapshot.recordCount,1);assert.equal(r.views[0].snapshot.matchingCount,3);assert.equal(r.views[0].snapshot.summaries[0].value,100);
});
test('dashboard state fits existing private conversation state without a schema migration',()=>{
 const state={report:{...spec(),dashboard:initial().board}};assert.deepEqual(require('../lib/conversation-core').validateState(state),state);
});
test('schemas are strict, field-aware and request-local',()=>{
 const schemas=D.schemas(C,custom),json=JSON.stringify(schemas);assert(json.includes('cf_date'));assert(!JSON.stringify(D.schemas(C)).includes('cf_date'));
 function walk(v){if(v?.type==='object'){assert.equal(v.additionalProperties,false);assert.deepEqual(v.required,Object.keys(v.properties));}if(v&&typeof v==='object')Object.values(v).forEach(walk);}walk(schemas);
});
test('PDF contains every independent report with scope, image and literal-text values',()=>{
 const definition=PDF.definition({workspace:'QA',kpis:[],reports:[{title:'Count',caption:'22 records',headings:['Owner','Count'],rows:[['Ravi',6]]},{title:'Value',caption:'22 records',chart:'data:image/png;base64,AAAA',headings:['Owner','Value'],rows:[['Sarah','$451,500']]}]});
 const json=JSON.stringify(definition);assert(json.includes('Count'));assert(json.includes('Value'));assert(json.includes('$451,500'));assert.equal(definition.content.filter(n=>n.image).length,1);
});
