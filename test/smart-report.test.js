const test=require('node:test'),assert=require('node:assert/strict'),R=require('../public/report-engine'),C=require('../public/pipeline-core');
const rows=[
 {id:1,account:'Alpha',owner:'Ravi',value:100,stage:'Warm',close:'2026-01-04'},
 {id:2,account:'Beta',owner:'Sarah',value:200,stage:'Won',close:'2026-02-06'},
 {id:3,account:'Gamma',owner:'Daniel',value:900,stage:'Warm',close:'2026-03-07'},
 {id:4,account:'Alpha',owner:'Sarah',value:0,stage:'Warm',close:'2026-02-12'},
 {id:5,account:'Delta',owner:'Ravi',value:null,stage:'Lost',close:''},
 {id:6,account:'Not set',owner:'Ravi',value:50,stage:'Warm',close:'2026-04-01'},
 {id:7,account:'',owner:'Sarah',value:10,stage:'Won',close:'2026-04-02'}
];
const condition=(field,operator,value=null,values=[])=>({field,operator,value,values});
const measure=(metric='sum',field='value',where=[])=>({label:metric,metric,field,where});
const spec=extra=>({version:1,title:'Comparison',chart:'bar',scope:'all',groupBy:'owner',bucket:'none',splitBy:null,measures:[measure()],where:[],sort:'value_desc',limit:null,...extra});
const run=(s,records=rows)=>R.execute(records,s,C,[],{today:'2026-04-03',visibleIds:[1]});
test('full-table subsets, compound AND/OR and selections do not mutate or follow visible rows',()=>{
 const saved=JSON.stringify(rows),s=spec({where:[[condition('owner','in',null,['Ravi','Sarah']),condition('value','gte',100)],[condition('account','equals','Gamma'),condition('stage','equals','Won')]]});
 assert.deepEqual(run(s).datasets[0].values,[200,100]);assert.equal(run(s).count,2);
 assert.equal(run({...s,scope:'visible'}).count,1);assert.equal(JSON.stringify(rows),saved);
 const simple=spec({where:[[condition('owner','in',null,['Ravi','Sarah']),condition('value','gte',0)]]}),selected=R.selections(simple,C);
 assert.deepEqual(selected.owners,['Ravi','Sarah']);assert.equal(selected.where[0].length,1);assert.deepEqual(run(simple).datasets,run(selected).datasets);
 assert.deepEqual(run({...selected,owners:['Daniel']}).datasets[0].values,[900]);
});
test('known zero, unknown amounts, repeated names and literal Not set are handled distinctly',()=>{
 const all=run(spec({groupBy:'account'}));assert.equal(all.labels.length,6);assert.equal(all.labels.filter(v=>v==='Not set').length,2);
 assert.equal(all.table.find(r=>r.group==='Delta').value,null);
 const zero=run(spec({where:[[condition('value','equals',0)]]}));assert.deepEqual(zero.datasets[0].values,[0]);
 const average=run(spec({groupBy:null,measures:[measure('average')]}));assert.equal(average.datasets[0].values[0],1260/6);
 assert.equal(run(spec({groupBy:null,measures:[measure('median')]})).datasets[0].values[0],75);
 assert.equal(run(spec({groupBy:null,measures:[measure('count_distinct','owner')]})).datasets[0].values[0],3);
 assert.equal(run(spec({groupBy:null,measures:[measure('min')]})).datasets[0].values[0],0);
 assert.equal(run(spec({groupBy:null,measures:[measure('max')]})).datasets[0].values[0],900);
});
test('monthly/weekly/quarterly trends and split series are calculated, not model supplied',()=>{
 const result=run(spec({chart:'line',groupBy:'close',bucket:'month',sort:'label_asc',splitBy:'owner'}));
 assert.deepEqual(result.labels,['2026-01','2026-02','2026-03','2026-04']);assert.equal(result.undated,1);
 assert.deepEqual(result.datasets.find(s=>s.label.startsWith('Sarah')).values,[null,200,null,10]);
 assert.deepEqual(run(spec({groupBy:'close',bucket:'quarter',sort:'label_asc'})).labels,['2026-Q1','2026-Q2']);
 assert.equal(run(spec({groupBy:'close',bucket:'week',sort:'label_asc'})).labels[0],'2025-12-29');
 const multi=run(spec({measures:[measure('sum'),measure('average')]}));assert.equal(multi.datasets.length,2);
});
test('conditional metrics and percentages use a defined within-group denominator',()=>{
 const won=[[condition('stage','equals','Won')]],s=spec({chart:'kpi',measures:[measure('percentage',null,won),measure('count',null,won)]});
 const result=run(s);assert.equal(result.datasets[0].values[result.labels.indexOf('Sarah')],2/3*100);
 assert.equal(result.datasets[1].values[result.labels.indexOf('Sarah')],2);
 assert.equal(run(spec({groupBy:null,chart:'kpi',measures:[measure('percentage',null,won)],where:[[condition('owner','equals','Nobody')]]})).datasets[0].values[0],null);
 assert.throws(()=>run(spec({measures:[measure('percentage',null)]})),/Which records/);
});
test('date, blank, text, range and negative filters have deterministic semantics',()=>{
 assert.equal(run(spec({where:[[condition('close','between',null,['2026-01-01','2026-03-31'])]]})).count,4);
 assert.equal(run(spec({where:[[condition('close','before_today')]]})).count,6);
 assert.equal(run(spec({where:[[condition('close','older_than_days',10)]]})).count,4);
 assert.equal(run(spec({where:[[condition('value','not_equals',0)]]})).count,5);
 assert.equal(run(spec({where:[[condition('value','is_blank')]]})).count,1);
 assert.equal(run(spec({where:[[condition('account','contains','alp')]]})).count,2);
 assert.equal(run(spec({where:[[condition('owner','not_in',null,['Ravi','Sarah'])]]})).count,1);
});
test('invalid and nonsensical reports require clarification, never silently drop conditions',()=>{
 for(const extra of [{groupBy:'missing'},{bucket:'month'},{measures:[measure('sum','owner')]},{chart:'stage',splitBy:'owner'},{limit:0},{measures:[measure('count',null),measure('sum')]},{where:[[condition('owner','gt',2)]]},{where:[[condition('close','between',null,['2026-04-01','2026-01-01'])]]}])assert.throws(()=>run(spec(extra)));
 assert.throws(()=>run(spec({chart:'stage'}),[{...rows[0],value:-1}]),/negative/);
 assert.throws(()=>run(spec({where:[[condition('__proto__','equals','anything')]]})),/unavailable/);
 assert.throws(()=>run(spec({where:[[]]})),/conditions/);
});
test('explicit top-N sorts and bounds without silently truncating default results',()=>{
 const result=run(spec({limit:2}));assert.equal(result.totalGroups,3);assert.equal(result.shownGroups,2);assert.deepEqual(result.labels,['Daniel','Sarah']);
 assert.deepEqual(run(spec({sort:'value_asc',limit:1})).labels,['Ravi']);
 assert.equal(run(spec({where:[[condition('owner','equals','Nobody')]]})).labels.length,0);
});
test('request-local schema uses actual field IDs, strict objects, and complete required properties',()=>{
  const schema=R.responseSchema(C,[]),visit=node=>{if(!node||typeof node!=='object')return;if(node.type==='object'){assert.equal(node.additionalProperties,false);assert.deepEqual(node.required.sort(),Object.keys(node.properties).sort());}for(const v of Object.values(node))if(v&&typeof v==='object')visit(v);};visit(schema);
  assert(schema.anyOf[1].properties.groupBy.enum.includes('account'));assert(!schema.anyOf[1].properties.groupBy.enum.includes('invented'));
});

const salesCore=C.create({status:'ready',useCase:'Sales',description:'',title:'Deals',recordLabel:'deal',fields:[
 {id:'f_account',name:'Deal',type:'text',role:'primary',options:[]},
 {id:'f_stage',name:'Stage',type:'choice',role:'status',options:['Qualified','Proposal Sent','Negotiation','Closed Won','Closed Lost','On Hold']},
 {id:'f_value',name:'Deal Value',type:'currency',role:'none',options:[]},
 {id:'f_owner',name:'Owner',type:'text',role:'owner',options:[]},
 {id:'f_close',name:'Close date',type:'date',role:'none',options:[]}
]});
const salesRows=[
 {id:1,f_account:'Alder',f_stage:'Qualified',f_value:12000,f_owner:'Alex',f_close:'2026-10-01'},
 {id:2,f_account:'Beacon',f_stage:'Proposal Sent',f_value:7500,f_owner:'Sam',f_close:'2026-10-02'},
 {id:3,f_account:'Cobalt',f_stage:'Negotiation',f_value:20000,f_owner:'Alex',f_close:'2026-10-03'},
 {id:4,f_account:'Delta',f_stage:'Closed Won',f_value:90000,f_owner:'Alex',f_close:'2026-10-04'},
 {id:5,f_account:'Echo',f_stage:'Closed Lost',f_value:30000,f_owner:'Sam',f_close:'2026-10-05'},
 {id:6,f_account:'Fern',f_stage:'',f_value:5000,f_owner:'Alex',f_close:'2026-10-06'},
 {id:7,f_account:'Gem',f_stage:'Qualified',f_value:2000,f_owner:'Sam',f_close:'2026-09-01'}
];
const openCondition=condition('f_stage','not_in',null,['Closed Won','Closed Lost']);
const closeCondition=condition('f_close','gte','2026-10-01');
const selectedStages=condition('f_stage','in',null,['Qualified','Proposal Sent']);
const salesSpec=(extra={})=>spec({groupBy:'f_stage',measures:[measure('sum','f_value')],where:[[openCondition,closeCondition]],...extra});
const refinement=(extra={})=>({action:'refine_report',mode:'add_filter',where:[],replaceFields:[],changes:[],...extra});
const salesOptions={today:'2026-10-02',records:salesRows,visibleIds:[1]};
const refineSales=(current,action)=>R.refine(current,action,salesCore,[],salesOptions);
const runSales=s=>R.execute(salesRows,s,salesCore,[],salesOptions);

test('compact refinement schema is separate, strict, bounded and uses request-local field IDs',()=>{
 const schema=R.refinementSchema(salesCore),visit=node=>{if(!node||typeof node!=='object')return;if(node.type==='object'){assert.equal(node.additionalProperties,false);assert.deepEqual([...node.required].sort(),Object.keys(node.properties).sort());}for(const v of Object.values(node))if(v&&typeof v==='object')visit(v);};visit(schema);
 assert.deepEqual(schema.required,['action','mode','where','replaceFields','changes']);
 assert.deepEqual(schema.properties.action.enum,['refine_report']);
 assert.deepEqual(schema.properties.mode.enum,['add_filter','replace_filter','remove_filter']);
 assert.equal(schema.properties.changes.minItems,1);
 assert.equal(schema.properties.where.maxItems,12);assert.equal(schema.properties.where.items.maxItems,20);
 assert(schema.properties.where.items.items.properties.field.enum.includes('f_stage'));
 assert(!schema.properties.where.items.items.properties.field.enum.includes('stage'));
 const changes=schema.properties.changes.items.anyOf;
 assert(changes.find(c=>c.properties.field.enum[0]==='groupBy').properties.value.enum.includes(null));
 assert(!changes.some(c=>c.properties.field.enum[0]==='where'));
 assert(!R.refinementSchema(C).properties.replaceFields.items.enum.includes('f_stage'));
 assert(!R.responseSchema(salesCore).anyOf[1].properties.action);
});

test('typed stage membership refines the open cohort without losing metric, grouping, scope or dates',()=>{
 const current=salesSpec(),action=refinement({where:[[selectedStages]]}),before=JSON.stringify({current,action,rows:salesRows});
 const next=refineSales(current,action),result=runSales(next);
 assert.deepEqual(result.labels,['Qualified','Proposal Sent']);assert.deepEqual(result.datasets[0].values,[12000,7500]);assert.equal(result.count,2);
 assert.deepEqual(next.where,[[openCondition,closeCondition,selectedStages]]);
 for(const key of ['title','chart','scope','groupBy','bucket','splitBy','measures','sort','limit'])assert.deepEqual(next[key],current[key]);
 assert.equal(JSON.stringify({current,action,rows:salesRows}),before);
 next.measures[0].label='Changed';next.where[0][2].values.push('Negotiation');
 assert.equal(JSON.stringify({current,action,rows:salesRows}),before,'returned report must not alias either input');
 const visible=refineSales(salesSpec({scope:'visible'}),action);assert.equal(visible.scope,'visible');assert.equal(runSales(visible).count,1);
});

test('stage replacement and removal are explicit field-wide operations retaining unrelated base filters',()=>{
 const selected=refineSales(salesSpec(),refinement({where:[[selectedStages]]}));
 const alternate=condition('f_stage','in',null,['Negotiation']);
 const replaced=refineSales(selected,refinement({mode:'replace_filter',replaceFields:['f_stage'],where:[[alternate]]}));
 assert.deepEqual(replaced.where,[[closeCondition,alternate]]);
 assert.deepEqual(runSales(replaced).labels,['Negotiation']);assert.deepEqual(runSales(replaced).datasets[0].values,[20000]);
 assert.deepEqual(replaced.measures,selected.measures);
 const removed=refineSales(replaced,refinement({mode:'remove_filter',replaceFields:['f_stage']}));
 assert.deepEqual(removed.where,[[closeCondition]]);assert.equal(runSales(removed).count,6);
 assert.deepEqual(selected.where,[[openCondition,closeCondition,selectedStages]]);
});

test('report property patches preserve unspecified measures, cohorts and explicit nullable changes',()=>{
 const measures=[measure('average','f_value',[[condition('f_owner','equals','Alex')]])];
 const current=salesSpec({measures,splitBy:'f_owner',limit:2,sort:'label_asc'});
 const next=refineSales(current,refinement({changes:[{field:'chart',value:'kpi'},{field:'groupBy',value:null},{field:'splitBy',value:null},{field:'limit',value:null},{field:'scope',value:'visible'}]}));
 assert.equal(next.groupBy,null);assert.equal(next.splitBy,null);assert.equal(next.limit,null);assert.equal(next.chart,'kpi');
 assert.equal(next.scope,'visible');assert.equal(next.sort,'label_asc');assert.deepEqual(next.measures,measures);assert.deepEqual(next.where,current.where);
 const changed=refineSales(current,refinement({changes:[{field:'measures',value:[measure('sum','f_value')]}]}));
 assert.equal(changed.measures[0].metric,'sum');assert.deepEqual(changed.where,current.where);assert.equal(current.measures[0].metric,'average');
});

test('measure and grouping refinements regenerate inherited titles but preserve explicit titles',()=>{
 const current=salesSpec({title:'Total Deal Value by Stage',measures:[{...measure('sum','f_value'),label:'Total Deal Value'}]}),before=JSON.stringify(current);
 const average={field:'measures',value:[{...measure('average','f_value'),label:'Average Deal Value'}]};
 const next=refineSales(current,refinement({changes:[average]}));
 assert.equal(next.title,'');assert.equal(runSales(next).title,'Average Deal Value by Stage');
 assert.deepEqual(next.where,current.where);assert.equal(runSales(next).count,runSales(current).count);
 const grouped=refineSales(current,refinement({changes:[{field:'groupBy',value:'f_owner'}]}));
 assert.equal(grouped.title,'');assert.equal(runSales(grouped).title,'Total Deal Value by Owner');
 const ungrouped=refineSales(next,refinement({changes:[{field:'groupBy',value:null}]}));
 assert.equal(runSales(ungrouped).title,'Average Deal Value');
 for(const changes of [[{field:'title',value:'My comparison'},average],[average,{field:'groupBy',value:'f_owner'},{field:'title',value:'My comparison'}]]){
  const named=refineSales(current,refinement({changes}));assert.equal(named.title,'My comparison');assert.equal(runSales(named).title,'My comparison');
 }
 const narrowed=refineSales(current,refinement({where:[[selectedStages]],changes:[{field:'chart',value:'kpi'}]}));
 assert.equal(narrowed.title,current.title);assert.equal(JSON.stringify(current),before);
});

test('adding OR filters distributes AND across every existing alternative',()=>{
 const alex=condition('f_owner','equals','Alex'),sam=condition('f_owner','equals','Sam');
 const qualified=condition('f_stage','equals','Qualified'),proposal=condition('f_stage','equals','Proposal Sent');
 const current=salesSpec({where:[[alex,closeCondition],[sam,closeCondition]]});
 const next=refineSales(current,refinement({where:[[qualified],[proposal]]}));
 assert.deepEqual(next.where,[[alex,closeCondition,qualified],[alex,closeCondition,proposal],[sam,closeCondition,qualified],[sam,closeCondition,proposal]]);
 assert.deepEqual(runSales(next).rows.map(r=>r.id),[1,2]);
 assert.deepEqual(refineSales(salesSpec({where:[]}),refinement({where:[[qualified],[proposal]]})).where,[[qualified],[proposal]]);
});

test('replacement removes the target from every OR branch but retains other predicates',()=>{
 const alex=condition('f_owner','equals','Alex'),sam=condition('f_owner','equals','Sam');
 const current=salesSpec({where:[[condition('f_stage','equals','Qualified'),alex],[condition('f_stage','equals','Closed Won'),sam]]});
 const next=refineSales(current,refinement({mode:'replace_filter',replaceFields:['f_stage'],where:[[selectedStages]]}));
 assert.deepEqual(next.where,[[alex,selectedStages],[sam,selectedStages]]);
 assert.deepEqual(runSales(next).rows.map(r=>r.id),[1,2,7]);
 const removed=refineSales(current,refinement({mode:'remove_filter',replaceFields:['f_stage']}));
 assert.deepEqual(removed.where,[[alex],[sam]]);assert.equal(runSales(removed).count,7);
});

test('a removal leaving an empty AND branch retains true-OR semantics',()=>{
 const current=salesSpec({where:[[selectedStages],[condition('f_owner','equals','Alex'),openCondition]]});
 const removed=refineSales(current,refinement({mode:'remove_filter',replaceFields:['f_stage']}));
 assert.deepEqual(removed.where,[]);assert.equal(runSales(removed).count,7);
 const next=refineSales(current,refinement({mode:'replace_filter',replaceFields:['f_stage'],where:[[condition('f_stage','equals','Closed Lost')]]}));
 assert.equal(runSales(next).count,1);assert.equal(runSales(next).rows[0].id,5);
});

test('manual owner/account selections survive narrowing and are cleared only by explicit field replacement',()=>{
 const current=salesSpec({owners:['Alex'],accounts:['Alder','Cobalt']}),action=refinement({where:[[selectedStages]]});
 const next=refineSales(current,action);assert.deepEqual(next.owners,['Alex']);assert.deepEqual(next.accounts,current.accounts);assert.equal(runSales(next).count,1);
 const owner=condition('f_owner','equals','Sam');
 const replaced=refineSales(current,refinement({mode:'replace_filter',replaceFields:['f_owner'],where:[[owner]]}));
 assert.equal(replaced.owners,null);assert.deepEqual(replaced.accounts,current.accounts);assert.equal(runSales(replaced).count,0);
 const narrowed=refineSales(current,refinement({where:[[owner]]}));
 assert.equal(runSales(narrowed).count,0);assert.equal(runSales(R.selections(narrowed,salesCore)).count,0,'selection extraction must not overwrite an existing selection');
 const removed=refineSales(current,refinement({mode:'remove_filter',replaceFields:['f_account']}));
 assert.equal(removed.accounts,null);assert.deepEqual(removed.owners,['Alex']);
});

test('categorical literals are validated, and contains never disguises a choice membership list',()=>{
 const current=salesSpec(),before=JSON.stringify(current);
 for(const c of [condition('f_stage','contains','Qualified|Proposal Sent'),condition('f_stage','not_contains','Qualified'),condition('f_stage','equals','Qualified|Proposal Sent'),condition('f_stage','in',null,['Qualified|Proposal Sent']),condition('f_stage','in',null,['Qualified','Invented']),condition('f_stage','not_in',null,['Invented']),condition('f_stage','equals',12)]){
   assert.throws(()=>refineSales(current,refinement({where:[[c]]})),/exact options|defined choices/);
   assert.throws(()=>runSales(salesSpec({where:[[c]]})),/exact options|defined choices/);
 }
 assert.equal(JSON.stringify(current),before);
 assert.equal(runSales(refineSales(current,refinement({where:[[condition('f_stage','in',null,[' qualified ','PROPOSAL SENT'])]]}))).count,2);
 assert.equal(runSales(salesSpec({where:[[condition('f_stage','equals','On Hold')]]})).count,0,'a defined option without rows remains a valid empty result');
 assert.throws(()=>runSales(salesSpec({measures:[measure('sum','f_value',[[condition('f_stage','equals','Invented')]])]})),/defined choices/);
});

test('explicit replacement repairs an invalid choice filter without dropping unrelated date restrictions',()=>{
 const current=salesSpec({where:[[closeCondition,condition('f_stage','contains','Qualified|Proposal Sent')]]}),before=JSON.stringify(current);
 assert.throws(()=>refineSales(current,refinement({where:[[selectedStages]]})),/exact options/);
 const repaired=refineSales(current,refinement({mode:'replace_filter',replaceFields:['f_stage'],where:[[selectedStages]]}));
 assert.deepEqual(repaired.where,[[closeCondition,selectedStages]]);assert.deepEqual(runSales(repaired).rows.map(r=>r.id),[1,2]);
 assert.equal(JSON.stringify(current),before);
});

test('observed choice values and literal pipes are supported without splitting or text-value guessing',()=>{
 const observed=[...salesRows,{...salesRows[0],id:8,f_stage:'Qualified|Proposal Sent',f_account:'A|B, C'}];
 const report=salesSpec({where:[[condition('f_stage','equals','Qualified|Proposal Sent')]]});
 assert.equal(R.execute(observed,report,salesCore).count,1);
 assert.equal(R.refine(salesSpec(),refinement({where:report.where}),salesCore,[],{records:observed}).where[0].at(-1).value,'Qualified|Proposal Sent');
 assert.throws(()=>R.refine(salesSpec(),refinement({where:report.where}),salesCore),/defined choices/);
 for(const operator of ['equals','contains']){
   const text=salesSpec({where:[[condition('f_account',operator,'A|B, C')]]});
   assert.equal(R.execute(observed,text,salesCore).count,1);
   assert.equal(R.execute(salesRows,text,salesCore).count,0,'unobserved text literals are valid');
 }
 const typed=salesSpec({where:[[condition('f_value','in',null,[12000,'7500']),condition('f_close','in',null,['2026-10-01','2026-10-02'])]]});
 assert.equal(runSales(typed).count,2);
});

test('malformed refinements and conflicting filter operands require clarification without mutation',()=>{
 const current=salesSpec(),before=JSON.stringify(current);
 const invalid=[
  {action:'show_report'}, {mode:'new'}, {mode:'replace_filter'}, {replaceFields:['f_stage']},
  {mode:'remove_filter',replaceFields:['f_stage'],where:[[selectedStages]]},
  {mode:'replace_filter',replaceFields:['f_owner'],where:[[selectedStages]]},
  {mode:'remove_filter',replaceFields:['f_missing']}, {mode:'remove_filter',replaceFields:['f_stage','f_stage']},
  {changes:[{field:'scope',value:'open'}]}, {changes:[{field:'limit',value:NaN}]},
  {changes:[{field:'where',value:[]}]}, {changes:[{field:'groupBy',value:'missing'}]},
  {changes:[{field:'chart',value:'bar'},{field:'chart',value:'kpi'}]}, {smartReport:salesSpec()},
  {where:[[]]}, {where:[[condition('f_stage','in','Qualified',['Qualified'])]]},
  {where:[[condition('f_account','contains','A',['B'])]]}, {where:[[condition('f_value','equals',{})]]}
 ];
 for(const extra of invalid)assert.throws(()=>refineSales(current,refinement(extra)));
 assert.throws(()=>R.refine(null,refinement(),salesCore),/show_report/);
 assert.throws(()=>R.refine({metric:'sum'},refinement(),salesCore),/show_report/);
 assert.equal(JSON.stringify(current),before);
});

test('refinement composition is bounded by group, condition, value and change limits',()=>{
 const alternatives=Array.from({length:4},(_,i)=>[condition('f_value','gte',i)]);
 assert.throws(()=>refineSales(salesSpec({where:alternatives}),refinement({where:alternatives})),/12 alternative/);
 const many=Array.from({length:20},()=>condition('f_value','gte',0));
 assert.throws(()=>refineSales(salesSpec({where:[many]}),refinement({where:[[selectedStages]]})),/1 to 20/);
 assert.throws(()=>refineSales(salesSpec(),refinement({where:Array.from({length:13},()=>[selectedStages])})),/12 alternative/);
 assert.throws(()=>refineSales(salesSpec(),refinement({where:[[condition('f_account','in',null,Array(2001).fill('A'))]]})),/valid list/);
 assert.throws(()=>refineSales(salesSpec(),refinement({changes:Array(10).fill({field:'title',value:'New'})})),/bounded/);
});

const filtering=(extra={})=>({action:'filter_records',target:'pipeline_table',mode:'add_filter',where:[],removeFields:[],...extra});
const refineTable=(current,action)=>R.refineTableFilter(current,action,salesCore,[],salesRows,salesOptions.today);
const tableRows=filter=>salesRows.filter(R.tableMatches(filter,salesCore,[],salesRows,salesOptions.today));

test('contextual filtering schema exposes only target and bounded typed filter operations',()=>{
 const schema=R.filteringSchema(salesCore),visit=node=>{if(!node||typeof node!=='object')return;if(node.type==='object'){assert.equal(node.additionalProperties,false);assert.deepEqual([...node.required].sort(),Object.keys(node.properties).sort());}for(const v of Object.values(node))if(v&&typeof v==='object')visit(v);};visit(schema);
 assert.deepEqual(schema.required,['action','target','mode','where','removeFields']);
 assert.deepEqual(schema.properties.action.enum,['filter_records']);
 assert.deepEqual(schema.properties.target.enum,['context','report','pipeline_table']);
 assert.deepEqual(schema.properties.mode.enum,['add_filter','replace_filter','remove_filter']);
 assert.equal(schema.properties.where.maxItems,12);assert.equal(schema.properties.where.items.maxItems,20);
 assert(schema.properties.removeFields.items.enum.includes('f_stage'));assert(!schema.properties.changes);assert(!schema.properties.replaceFields);
 assert(!R.filteringSchema(C).properties.removeFields.items.enum.includes('f_stage'));
});

test('filteringRefinement produces independent canonical actions with derived replacement fields',()=>{
 const owner=condition('f_owner','equals','Ravi'),where=[[selectedStages,owner],[condition('f_stage','equals','Negotiation'),owner]];
 for(const target of ['context','report','pipeline_table']){
  const action=filtering({target,mode:'replace_filter',where}),before=JSON.stringify(action);
  const canonical=R.filteringRefinement(action);
  assert.deepEqual(canonical,{action:'refine_report',mode:'replace_filter',where,replaceFields:['f_stage','f_owner'],changes:[]});
  canonical.where[0][0].values.push('On Hold');canonical.replaceFields.push('f_close');
  assert.equal(JSON.stringify(action),before);
 }
 const added=R.filteringRefinement(filtering({where:[[owner]]}));assert.deepEqual(added.replaceFields,[]);assert.deepEqual(added.changes,[]);
 const action=filtering({mode:'remove_filter',removeFields:['f_owner']}),removed=R.filteringRefinement(action);
 assert.deepEqual(removed,{action:'refine_report',mode:'remove_filter',where:[],replaceFields:['f_owner'],changes:[]});
 removed.replaceFields.push('f_stage');assert.deepEqual(action.removeFields,['f_owner']);
});

test('only Ravi after a stage subset preserves stage/date filters on both table and report targets',()=>{
 const records=salesRows.map(row=>({...row,f_owner:row.f_owner==='Alex'?'Ravi':row.f_owner}));
 const base={where:[[selectedStages,closeCondition]]},owner=condition('f_owner','equals','Ravi');
 const action=filtering({mode:'replace_filter',where:[[owner]]}),before=JSON.stringify({base,action,records});
 const table=R.refineTableFilter(base,action,salesCore,[],records,salesOptions.today);
 assert.deepEqual(table.where,[[selectedStages,closeCondition,owner]]);
 assert.deepEqual(records.filter(R.tableMatches(table,salesCore,[],records,salesOptions.today)).map(row=>row.id),[1]);
 const current=salesSpec(base),canonical=R.filteringRefinement({...action,target:'report'});
 assert.deepEqual(canonical.replaceFields,['f_owner']);
 const report=R.refine(current,canonical,salesCore,[],{...salesOptions,records});
 assert.deepEqual(report.where,table.where);assert.deepEqual(report.measures,current.measures);assert.equal(report.groupBy,current.groupBy);assert.equal(report.title,current.title);
 assert.equal(R.execute(records,report,salesCore).count,1);
 const changed=R.refineTableFilter(table,filtering({mode:'replace_filter',where:[[condition('f_owner','equals','Sam')]]}),salesCore,[],records,salesOptions.today);
 assert.deepEqual(changed.where,[[selectedStages,closeCondition,condition('f_owner','equals','Sam')]]);
 assert.deepEqual(records.filter(R.tableMatches(changed,salesCore,[],records,salesOptions.today)).map(row=>row.id),[2]);
 assert.equal(JSON.stringify({base,action,records}),before);
});

test('derived replacement and explicit removal preserve other predicates in every OR branch',()=>{
 const qualified=condition('f_stage','equals','Qualified'),proposal=condition('f_stage','equals','Proposal Sent');
 const current={where:[[qualified,condition('f_owner','equals','Sam'),closeCondition],[proposal,condition('f_owner','equals','Alex'),closeCondition]]};
 const owner=condition('f_owner','equals','Alex'),replaced=refineTable(current,filtering({mode:'replace_filter',where:[[owner]]}));
 assert.deepEqual(replaced.where,[[qualified,closeCondition,owner],[proposal,closeCondition,owner]]);
 const removed=refineTable(replaced,filtering({mode:'remove_filter',removeFields:['f_owner']}));
 assert.deepEqual(removed.where,[[qualified,closeCondition],[proposal,closeCondition]]);
 assert.deepEqual(tableRows(removed).map(row=>row.id),[1,2]);
 assert.deepEqual(current.where[0][1],condition('f_owner','equals','Sam'));
});

test('filter action conversion rejects contradictory modes, redundant fields and malformed conditions',()=>{
 const bad=[{replaceFields:[]},{removeFields:null},{removeFields:['f_owner']},{mode:'replace_filter'},
  {mode:'replace_filter',removeFields:['f_stage'],where:[[selectedStages]]},{mode:'remove_filter'},
  {mode:'remove_filter',removeFields:['f_stage'],where:[[selectedStages]]},{mode:'remove_filter',removeFields:['f_stage','f_stage']},
  {mode:'remove_filter',removeFields:['']},{mode:'remove_filter',removeFields:Array.from({length:21},(_,i)=>'f_'+i)},
  {where:[[]]},{where:[[null]]},{where:[[condition('', 'equals','A')]]},{where:[[condition('f_owner','unknown','A')]]},
  {where:[[condition('f_value','equals',NaN)]]},{where:[[condition('f_owner','in',null,[])]]},
  {where:[[condition('f_owner','equals','A',['B'])]]},{where:[[condition('f_value','between',null,[1])]]},
  {where:[[condition('f_owner','in',null,Array(2001).fill('A'))]]},{where:Array.from({length:13},()=>[selectedStages])},
  {where:[Array(21).fill(selectedStages)]},{where:[[{...selectedStages,extra:true}]]},
  {mode:'replace_filter',where:[Array.from({length:20},(_,i)=>condition('f_'+i,'equals','A')),[condition('f_20','equals','B')]]}
 ];
 for(const extra of bad)assert.throws(()=>R.filteringRefinement(filtering(extra)));
 assert.throws(()=>R.filteringRefinement({...filtering(),removeFields:undefined}));
 assert.throws(()=>refineTable(null,filtering({mode:'remove_filter',removeFields:['missing']})),/existing columns/);
});

test('table filtering starts unrestricted, uses membership and preserves the legacy base condition',()=>{
 for(const filter of [null,undefined,{where:[]}]){assert.equal(tableRows(filter).length,7);assert.equal(R.tableFilterDescription(filter,salesCore),'');}
 const current={field:'f_close',operator:'gte',value:'2026-10-01'},action=filtering({where:[[selectedStages]]}),before=JSON.stringify({current,action,salesRows});
 const next=refineTable(current,action);
 assert.deepEqual(next,{where:[[closeCondition,selectedStages]]});assert.deepEqual(tableRows(next).map(r=>r.id),[1,2]);
 assert.equal(R.tableFilterDescription(next,salesCore,[]),'(Close date gte 2026-10-01 AND Stage in Qualified, Proposal Sent)');
 next.where[0][1].values.push('Negotiation');assert.equal(JSON.stringify({current,action,salesRows}),before);
 assert.deepEqual(refineTable(null,filtering()),{where:[]});
 assert.deepEqual(tableRows(refineTable(null,filtering({target:'context',where:[[selectedStages]]}))).map(r=>r.id),[1,2,7]);
});

test('conflicting table selections remain empty until explicitly replaced or removed',()=>{
 const current={field:'f_stage',operator:'equals',value:'Qualified'},proposal=condition('f_stage','equals','Proposal Sent');
 const conflict=refineTable(current,filtering({where:[[proposal]]}));assert.equal(tableRows(conflict).length,0);
 const replaced=refineTable(conflict,filtering({mode:'replace_filter',where:[[proposal]]}));
 assert.deepEqual(replaced.where,[[proposal]]);assert.deepEqual(tableRows(replaced).map(r=>r.id),[2]);
 const removed=refineTable(replaced,filtering({mode:'remove_filter',removeFields:['f_stage']}));
 assert.deepEqual(removed,{where:[]});assert.equal(tableRows(removed).length,7);
 const none=refineTable(null,filtering({where:[[condition('f_stage','equals','On Hold')]]}));assert.equal(tableRows(none).length,0);
});

test('table and report refinements share OR composition, field removal and bounded validation',()=>{
 const current={where:[[condition('f_owner','equals','Alex'),closeCondition],[condition('f_owner','equals','Sam'),closeCondition]]};
 const where=[[condition('f_stage','equals','Qualified')],[condition('f_stage','equals','Proposal Sent')]];
 const next=refineTable(current,filtering({where}));
 assert.deepEqual(next.where,refineSales(salesSpec(current),refinement({where})).where);assert.deepEqual(tableRows(next).map(r=>r.id),[1,2]);
 const removed=refineTable(next,filtering({mode:'remove_filter',removeFields:['f_stage']}));
 assert(removed.where.every(group=>group.length===2));assert.equal(tableRows(removed).length,6);
 const alternatives=Array.from({length:4},(_,i)=>[condition('f_value','gte',i)]);
 assert.throws(()=>refineTable({where:alternatives},filtering({where:alternatives})),/12 alternative/);
 assert.throws(()=>R.tableMatches({where:[[]]},salesCore),/conditions/);
});

test('table choice filters reject joined strings while text punctuation remains literal',()=>{
 for(const value of ['Qualified, Proposal Sent','Qualified|Proposal Sent']){
  const legacy={field:'f_stage',operator:'contains',value};
  assert.throws(()=>R.tableMatches(legacy,salesCore,[],salesRows),/exact options/);
  assert.throws(()=>refineTable(null,filtering({where:[[condition('f_stage','contains',value)]]})),/exact options/);
  assert.throws(()=>refineTable(null,filtering({where:[[condition('f_stage','in',null,[value])]]})),/defined choices/);
 }
 const records=[{...salesRows[0],f_account:'A|B, C'}],filter={field:'f_account',operator:'contains',value:'A|B, C'};
 assert.equal(records.filter(R.tableMatches(filter,salesCore,[],records)).length,1);
 assert.equal(salesRows.filter(R.tableMatches(filter,salesCore,[],salesRows)).length,0);
 const custom=[{id:'cf_region',name:'Region',type:'choice',options:['East','West']}],observed=[{id:1,cf_region:'North'}];
 const typed={where:[[condition('cf_region','in',null,['North'])]]};
 assert.equal(observed.filter(R.tableMatches(typed,C,custom,observed)).length,1);
 assert.equal(R.tableFilterDescription(typed,C,custom),'(Region in North)','describing validated filters does not require the row snapshot');
 assert.throws(()=>R.tableMatches(typed,C,custom),/defined choices/);
});

test('unsupported or ambiguous legacy filters clarify instead of discarding existing restrictions',()=>{
 const current={field:'f_close',operator:'month_equals',value:10},before=JSON.stringify(current);
 for(const attempt of [()=>refineTable(current,filtering({where:[[selectedStages]]})),()=>R.tableMatches(current,salesCore),()=>R.tableFilterDescription(current,salesCore)])assert.throws(attempt,/month_equals.*date range/);
 for(const filter of [{},{where:[],field:'f_stage',operator:'equals',value:'Qualified'},{field:'missing',operator:'equals',value:'A'},{field:'f_owner',operator:'unsupported',value:'Alex'}])assert.throws(()=>refineTable(filter,filtering()));
 assert.equal(JSON.stringify(current),before);
});

test('legacy blanks, field labels and Today retain their existing matching semantics',()=>{
 const blankStage={field:'Stage',operator:'is_blank',value:null};assert.deepEqual(tableRows(blankStage).map(r=>r.id),[6]);
 const todayFilter={field:'f_close',operator:'equals',value:'Today'};
 assert.deepEqual(salesRows.filter(R.tableMatches(todayFilter,salesCore,[],salesRows,'2026-10-02')).map(r=>r.id),[2]);
 const records=[{follow:'Today'},{follow:'2026-10-02'},{follow:'2026-10-03'}],legacy={field:'follow',operator:'equals',value:'Today'};
 assert.equal(records.filter(R.tableMatches(legacy,C,[],records,'2026-10-02')).length,2);
 assert.throws(()=>R.tableMatches(todayFilter,salesCore,[],salesRows,'not-a-date'),/valid calendar date/);
});

test('table helper rejects report targets, legacy actions and malformed filter operations without mutation',()=>{
 const current={where:[[closeCondition]]},before=JSON.stringify(current);
 for(const extra of [{target:'report'},{target:'unknown'},{action:'filter_view'},{changes:[]},{mode:'new'},{mode:'remove_filter'},{removeFields:['f_stage']},{mode:'replace_filter',removeFields:['f_owner'],where:[[selectedStages]]},{replaceFields:[]},{where:[[condition('f_stage','in','Qualified',['Qualified'])]]}])assert.throws(()=>refineTable(current,filtering(extra)));
 assert.throws(()=>R.refineTableFilter(null,filtering(),salesCore,[],{}),/table records/);
 assert.equal(JSON.stringify(current),before);
});
