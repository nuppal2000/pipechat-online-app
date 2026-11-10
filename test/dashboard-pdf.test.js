const test=require('node:test'),assert=require('node:assert/strict'),PDF=require('../public/dashboard-pdf');
const sample={workspace:'Recruiting',exportedAt:'Sep 23, 2026',title:'Average score',kpis:[
  {label:'Average score',value:'0',metric:'average',scope:'Average Assessment score; known applicants.',population:'visible_records',populationCount:3,count:2,numericCount:1},
  {label:'Stale candidates',value:'3',metric:'count',scope:'Last contact date before today.',population:'all_authorized_records',populationCount:3,count:3}
],filters:['Owners: Ravi, Sarah'],caption:'2 matching records.',headings:['Recruiter','Average score','Records'],rows:[['Ravi','0','1'],['Sarah','Not set','1']]};
const Customize=require('../public/workspace-customization'),K=require('./fixtures/scoped-kpis.cjs');
const table={status:'ready',useCase:'Sales',title:'Export QA',recordLabel:'deal',description:'',fields:[
  {id:'f_name',name:'Opportunity title',type:'text',role:'primary',options:[]},
  {id:'f_value',name:'Contract amount (USD)',type:'currency',role:'none',options:[]},
  {id:'f_follow',name:'Next contact date',type:'date',role:'followup',options:[]}
]};
const scopeWhere=[[K.cohort]];
function card(k,rows=K.rows){
  const population=Object.hasOwn(k,'where')?'all_authorized_records':'visible_records';
  const selected=population==='visible_records'?rows.filter(row=>[1,2,3,5].includes(row.id)):rows;
  const result=Customize.summarize(k,selected,table,[],'2026-11-10');
  return {label:k.title,value:result.displayValue,metric:k.metric,scope:result.definition,population,populationCount:selected.length,
    count:result.count,...(result.numericCount===undefined?{}:{numericCount:result.numericCount}),
    ...(result.numeratorCount===undefined?{}:{numeratorCount:result.numeratorCount,denominatorCount:result.denominatorCount})};
}
function mixedCards(rows=K.rows.slice(0,6)){
  return [
    card({id:'kpi_records',title:'Records',metric:'count',field:null,conditions:[]},rows),
    card({id:'kpi_value',title:'Total Contract amount (USD)',metric:'sum',field:'f_value',conditions:[]},rows),
    card({...K.median,id:'kpi_user_median'},rows),
    card({id:'kpi_user_missing',title:'Missing Next contact date',metric:'percentage',field:null,conditions:[],where:[[K.blank]],denominatorWhere:scopeWhere},rows)
  ];
}
const textNode=textContent=>({textContent});
function fakeDocument(kpis,{multi=true}={}){
  const rendered=kpis.map(k=>({dataset:Object.fromEntries(Object.entries(k).filter(([key])=>!['label','value'].includes(key)).map(([key,value])=>['kpi'+key[0].toUpperCase()+key.slice(1),String(value)])),
    querySelector:selector=>textNode(selector==='span'?k.label:k.value)}));
  const report={querySelector:selector=>selector==='h4'?textNode('Visible QA1105 amounts by Stage'):null,
    querySelectorAll:selector=>({
      '.dashboard-element-scope,.dashboard-shared-filter':[textNode('Current pipeline view: 4 records'),textNode('Stage excludes Closed')],
      th:['Stage','Contract amount (USD)','Records'].map(textNode),
      'tbody tr':[{cells:['Negotiation','$30,000','1'].map(textNode)}]
    }[selector]||[])};
  const nodes={dashboardView:{hidden:false},dashboardElements:{hidden:!multi},workspaceTitle:textNode('Renamed sales workspace'),
    reportTitle:textNode('Visible QA1105 amounts'),chartContainer:{hidden:true},reportKpis:{hidden:true},
    reportCaption:textNode('Current pipeline view: 4 records'),reportRows:{querySelectorAll:()=>report.querySelectorAll('tbody tr')}};
  return {rendered,getElementById:id=>nodes[id],querySelectorAll:selector=>({
    '.metrics > div':rendered,'.dashboard-element':[report],'.report-table th':report.querySelectorAll('th')
  }[selector]||[])};
}

test('capture retains supplied filters and per-card computed populations, including all-record median beside a visible total',()=>{
  const cards=mixedCards(),filters=['Pipeline table context: QA1105 open deals','Owner: Current representative'];
  for(const multi of [true,false]){
    const snapshot=PDF.capture(fakeDocument(cards,{multi}),filters,new Date('2026-11-10T17:00:00Z'));
    assert.deepEqual(snapshot.filters,filters);assert.notEqual(snapshot.filters,filters);
    assert.deepEqual(snapshot.kpis,cards);
    assert.equal(snapshot.kpis[0].count,4);assert.equal(snapshot.kpis[1].value,'$50,000');
    assert.equal(snapshot.kpis[2].value,'$12,000');assert.equal(snapshot.kpis[2].count,6);assert.equal(snapshot.kpis[2].numericCount,5);
    assert.equal(snapshot.kpis[3].value,'33.33%');assert.equal(snapshot.kpis[3].numeratorCount,2);assert.equal(snapshot.kpis[3].denominatorCount,6);
    const report=multi?snapshot.reports[0]:snapshot;
    assert.match(report.caption,/Current pipeline view: 4 records/);
    if(multi)assert.match(report.caption,/Stage excludes Closed/);
    assert.deepEqual(report.headings,['Stage','Contract amount (USD)','Records']);
    const output=JSON.stringify(PDF.definition(snapshot).content);
    for(const label of ['Opportunity title','Contract amount (USD)','Next contact date','Pipeline table context: QA1105 open deals'])assert(output.includes(label),label);
    assert.doesNotMatch(output,/Saved KPI cards use the pipeline scope/);
    assert.match(output,/6 matching records; 5 numeric values/);assert.match(output,/Numerator: 2 records; denominator: 6 records/);
    assert.match(output,/Source population: current pipeline view \(4 records\)/);assert.match(output,/Source population: all authorized records \(6 records\)/);
  }
});

test('PDF copies current percentage edits, zero/empty populations, and number counts without calculating from the report table',()=>{
  for(const [rows,display,numerator,denominator] of [
    [K.rows.map((row,i)=>i===0?{...row,f_follow:'2026-11-10'}:row),'16.67%',1,6],
    [K.rows.map(row=>({...row,f_follow:'2026-11-10'})),'0%',0,6],
    [[],'Not set',0,0]
  ]){
    const snapshot=PDF.capture(fakeDocument(mixedCards(rows)));
    const kpi=snapshot.kpis[3];assert.deepEqual([kpi.value,kpi.numeratorCount,kpi.denominatorCount],[display,numerator,denominator]);
    const output=JSON.stringify(PDF.definition(snapshot).content);
    assert(output.includes(display));assert(output.includes('Numerator: '+numerator+' records; denominator: '+denominator+' records'));
    if(!denominator)assert.match(output,/zero denominator/);
  }
  const copied=mixedCards();copied[2].value='Rendered value only';
  assert.match(JSON.stringify(PDF.definition(PDF.capture(fakeDocument(copied))).content),/Rendered value only/);
  const outside=PDF.capture(fakeDocument(mixedCards(K.rows)));
  assert.equal(outside.kpis[2].populationCount,7);assert.equal(outside.kpis[2].count,6);assert.equal(outside.kpis[3].denominatorCount,6);
  const noNumbers=PDF.capture(fakeDocument(mixedCards(K.rows.map(row=>({...row,f_value:null})))));
  assert.equal(noNumbers.kpis[2].count,6);assert.equal(noNumbers.kpis[2].numericCount,0);assert.equal(noNumbers.kpis[2].value,'Not set');
  assert.match(JSON.stringify(PDF.definition(noNumbers).content),/6 matching records; 0 numeric values/);
});

test('missing, malformed or inconsistent saved-card evidence fails closed instead of assigning a universal scope',()=>{
  for(const changes of [{scope:undefined},{population:undefined},{metric:undefined},{count:undefined},{numericCount:undefined},
    {population:'all'},{scope:''},{count:-1},{count:1.5},{count:''},{count:8},{numericCount:7},{populationCount:'no count'},{count:null},{count:'NaN'},{count:'Infinity'}]){
    const doc=fakeDocument(mixedCards());
    for(const [key,value] of Object.entries(changes)){
      const attr='kpi'+key[0].toUpperCase()+key.slice(1);
      if(value===undefined)delete doc.rendered[2].dataset[attr];else doc.rendered[2].dataset[attr]=String(value);
    }
    assert.throws(()=>PDF.capture(doc),/KPI.*refresh/i,JSON.stringify(changes));
  }
  for(const changed of [{denominatorCount:undefined},{numeratorCount:3},{denominatorCount:1},{denominatorCount:8}]){
    const bad={...mixedCards()[3],...changed};
    assert.throws(()=>PDF.definition({...sample,kpis:[bad]}),/KPI.*refresh/i);
  }
});

test('scope definitions, renamed headers and customer strings remain literal PDF text, never rich content or links',()=>{
  const hostile='<img src=x onerror=alert(1)> {"link":"https://invalid.test","image":"file:///private"}';
  const kpis=mixedCards();kpis[2]={...kpis[2],label:hostile,scope:hostile};
  const snapshot=PDF.capture(fakeDocument(kpis),[hostile]),before=structuredClone(snapshot);
  snapshot.reports[0].headings=[hostile,'Renamed monetary amount','Records'];
  const doc=PDF.definition(snapshot),output=JSON.stringify(doc.content);
  assert(output.includes(hostile.replaceAll('"','\\"')));assert.match(output,/Renamed monetary amount/);
  function check(node){
    if(!node||typeof node!=='object')return;
    for(const key of ['link','linkToPage','linkToDestination','image','svg','attachment'])assert(!Object.hasOwn(node,key),key);
    if(Object.hasOwn(node,'text'))assert.equal(typeof node.text,'string');
    for(const value of Object.values(node))check(value);
  }
  check(doc.content);assert.deepEqual(snapshot.kpis,before.kpis);
});

test('temporary graph KPI labels and each graph scope are copied independently of saved-card metadata',()=>{
  const doc=fakeDocument(mixedCards()),query=doc.querySelectorAll.bind(doc);
  const graph=(scope,value)=>({
    querySelector:selector=>selector==='h4'?textNode(scope):null,
    querySelectorAll:selector=>({
      '.dashboard-element-scope,.dashboard-shared-filter':[textNode(scope)],
      '.dashboard-kpi-result':[{querySelector:key=>textNode(key==='span'?'Temporary total':value)}]
    }[selector]||[])
  });
  doc.querySelectorAll=selector=>selector==='.dashboard-element'?[graph('Visible filtered graph','$50,000'),graph('Full-cohort graph','$70,000')]:query(selector);
  const snapshot=PDF.capture(doc),content=JSON.stringify(PDF.definition(snapshot).content);
  assert.deepEqual(snapshot.reports.map(report=>report.caption),['Visible filtered graph','Full-cohort graph']);
  for(const text of ['Temporary total','$50,000','$70,000','Visible filtered graph','Full-cohort graph'])assert(content.includes(text));
  doc.getElementById('dashboardView').hidden=true;assert.throws(()=>PDF.capture(doc),/Open the dashboard/);
});
test('PDF includes current KPI values, filtered summary, chart-mode KPIs and literal user content',()=>{
  const doc=PDF.definition({...sample,chartKpis:[{label:'Ravi',value:'0'}],title:{url:'https://invalid.test'}}),serialized=JSON.stringify(doc.content);
  assert.match(serialized,/Owners: Ravi, Sarah/);assert.match(serialized,/Not set/);assert.match(serialized,/Stale candidates/);assert.match(serialized,/\[object Object\]/);
  assert.equal(doc.pageOrientation,'landscape');assert.equal(doc.content.at(-1).table.headerRows,1);assert.equal(doc.content.at(-1).table.body.length,3);
  assert.throws(()=>PDF.definition({...sample,chart:'https://invalid.test/image.png'}));
});
test('PDF pagination accepts many KPIs and all report rows without truncation',()=>{
  const doc=PDF.definition({...sample,kpis:Array.from({length:13},(_,i)=>({...sample.kpis[0],label:'KPI '+i,value:i})),rows:Array.from({length:600},(_,i)=>['Record '+i,i,1])});
  assert.equal(doc.content.at(-1).table.body.length,601);assert.match(JSON.stringify(doc),/Record 599/);assert.match(JSON.stringify(doc),/KPI 12/);
  assert.equal(doc.content.find(node=>node.table?.widths.length===3&&node.layout==='noBorders').table.dontBreakRows,true);
  const longScope='Literal scope evidence. '.repeat(200)+'End of complete scope';
  const long=PDF.definition({...sample,kpis:[{...sample.kpis[0],scope:longScope}]});
  assert.equal(long.content.find(node=>node.table?.widths.length===3&&node.layout==='noBorders').table.dontBreakRows,false);
  assert(JSON.stringify(long.content).includes(longScope));
});
test('vendored PDF engine produces a real multi-page PDF with embedded fonts',{timeout:60000},async()=>{
  const engine=require('../public/vendor/pdfmake-0.3.11.min.js');engine.addVirtualFileSystem(require('../public/vendor/pdfmake-0.3.11-fonts.js'));
  const buffer=await engine.createPdf(PDF.definition({...sample,rows:Array.from({length:100},(_,i)=>['Fran\u00e7ois '+i,i,1])})).getBuffer();
  assert.equal(buffer.slice(0,5).toString(),'%PDF-');assert.match(buffer.toString('latin1'),/\/FontFile2/);assert.ok((buffer.toString('latin1').match(/\/Type \/Page\b/g)||[]).length>1);
  const scoped=PDF.definition(PDF.capture(fakeDocument([...mixedCards(),...mixedCards().map(k=>({...k,label:'Second '+k.label}))])));
  const scopedBuffer=await engine.createPdf(scoped).getBuffer();
  assert.equal(scopedBuffer.slice(0,5).toString(),'%PDF-');assert.match(scopedBuffer.toString('latin1'),/\/FontFile2/);
});
