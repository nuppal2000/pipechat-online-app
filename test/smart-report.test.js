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
