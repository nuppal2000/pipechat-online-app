const test=require('node:test'),assert=require('node:assert/strict');
const D=require('../public/dashboard-board'),R=require('../public/report-engine'),C=require('../public/pipeline-core');
const cond=(field,value)=>({field,operator:'equals',value,values:[]});
const measure=(metric='count',extra={})=>({label:metric,metric,field:['count','percentage'].includes(metric)?null:'value',where:[],...extra});
const spec=(extra={})=>({version:1,title:'Distribution',chart:'bar',scope:'all',groupBy:'owner',bucket:'none',splitBy:null,where:[],measures:[measure()],sort:'label_asc',limit:null,...extra});
const question=(denominator='matching_records',extra={})=>({kind:'group_percentages',elementId:'graph',measure:0,denominator,...extra});
function build(records,specs={graph:spec()},custom=[],options={},core=C){
  return D.apply(null,{action:'dashboard_plan',operations:Object.entries(specs).map(([id,spec])=>({op:'add',id,spec})),questions:[]},records,core,custom,options);
}
const answer=(result,denominator='matching_records',extra={})=>D.analyze([question(denominator,extra)],result.views);

test('review refuses an omitted percentage even if the reviewer labels raw counts satisfied',()=>{
  const Review=require('../lib/action-review');
  const current=build([{id:1,owner:'A',value:40000},{id:2,owner:'A',value:48000},{id:3,owner:'B',value:73000}]);
  const result={crmAction:{action:'analyze_dashboard',questions:[{kind:'groups',elementId:'graph',measure:0}]}};
  const review={issues:[],clarificationQuestion:null,requirements:[{description:'Every owner share',evidenceKind:'computed_read',stepIds:['root'],requiredOutputs:['groups','percentages'],satisfied:true}]};
  const context={pipeline:{dashboard:{board:current.board}}};
  assert.equal(Review.validateReview(review,result,context).ok,false);
  result.crmAction.questions.push(question());
  assert.equal(Review.validateReview(review,result,context).ok,true);
});

test('Q11: value comparison and every stage percentage are computed without changing either Ravi graph',()=>{
  const records=[{id:1,owner:'Ravi',stage:'Qualified',value:40000},{id:2,owner:'Ravi',stage:'Qualified',value:48000},{id:3,owner:'Ravi',stage:'Negotiation',value:73000},{id:4,owner:'Sarah',stage:'Qualified',value:999999}];
  const where=[[cond('owner','Ravi')]],result=build(records,{graph:spec({title:'Ravi deal counts',groupBy:'stage',where}),values:spec({title:'Ravi deal values',groupBy:'stage',where,measures:[measure('sum')]})});
  const ref=group=>({elementId:'values',measure:0,stat:'group',group,series:null});
  const questions=[{kind:'value',label:'Larger stage',reference:{elementId:'values',measure:0,stat:'maximum'}},{kind:'difference',label:'Value gap',left:ref('Qualified'),right:ref('Negotiation')},question()];
  const before=JSON.stringify(result),execute=R.execute;
  records[0].value=999999;records.push({id:5,owner:'Ravi',stage:'Lost',value:1});
  R.execute=()=>{throw new Error('Analysis must use the cache, not rerun reports');};
  try{
    const text=D.analyze(questions,result.views);
    assert.match(text,/Larger stage: \$88,000\.00/);assert.match(text,/Qualified.*largest sum/);
    assert.match(text,/Value gap: \$15,000\.00 \(\$88,000\.00 - \$73,000\.00\)/);
    assert.match(text,/Shared denominator: 3 matching records/);
    assert.match(text,/- Qualified: 66\.67% \(2 \/ 3 x 100; 2 records\)/);
    assert.match(text,/- Negotiation: 33\.33% \(1 \/ 3 x 100; 1 records\)/);
    assert.doesNotMatch(text,/999,999|54\.66%/);assert.equal(JSON.stringify(result),before);
  }finally{R.execute=execute;}
});

test('denominator explicitly distinguishes record shares from currency shares on the same cached graph',()=>{
  const result=build([{id:1,owner:'A',value:40000},{id:2,owner:'A',value:48000},{id:3,owner:'B',value:73000}],{graph:spec({measures:[measure('sum')]})});
  const records=answer(result),values=answer(result,'measure_total');
  assert.match(records,/- A: 66\.67% \(2 \/ 3 x 100/);
  assert.match(values,/sum total \$161,000\.00/);
  assert.match(values,/- A: 54\.66% \(\$88,000\.00 \/ \$161,000\.00 x 100/);
  assert.match(values,/- B: 45\.34% \(\$73,000\.00 \/ \$161,000\.00 x 100/);
});

test('split series share one complete population, including zero-count cells',()=>{
  const result=build([{id:1,owner:'A',stage:'Warm'},{id:2,owner:'A',stage:'Won'},{id:3,owner:'B',stage:'Won'},{id:4,owner:'B',stage:'Won'}],{graph:spec({splitBy:'stage'})});
  const text=answer(result);
  assert.match(text,/- A \/ Warm \/ count: 25% \(1 \/ 4/);
  assert.match(text,/- B \/ Warm \/ count: 0% \(0 \/ 4/);
  assert.match(text,/- A \/ Won \/ count: 25% \(1 \/ 4/);
  assert.match(text,/- B \/ Won \/ count: 50% \(2 \/ 4/);
  assert.equal(text.match(/ x 100;/g).length,4);
});

test('filtered measures select the correct index and preserve a subset denominator across all groups',()=>{
  const result=build([{id:1,owner:'A',stage:'Won'},{id:2,owner:'A',stage:'Warm'},{id:3,owner:'B',stage:'Warm'},{id:4,owner:'C',stage:'Won'}],{graph:spec({measures:[measure('count',{label:'All'}),measure('count',{label:'Won',where:[[cond('stage','Won')]]})]})});
  const text=answer(result,'matching_records',{measure:1});
  assert.match(text,/group percentages for Won/);
  assert.match(text,/- A: 25% \(1 \/ 4/);assert.match(text,/- B: 0% \(0 \/ 4/);assert.match(text,/- C: 25% \(1 \/ 4/);
  assert.match(text,/not renormalized to 100%/);
  const selectedTotal=answer(result,'measure_total',{measure:1});
  assert.match(selectedTotal,/Won total 2/);assert.match(selectedTotal,/- A: 50% \(1 \/ 2/);
});

test('dataset positions prevent colliding split/measure labels from duplicating or mixing numerators',()=>{
  const result=build([{id:1,owner:'A',stage:'X / A'},{id:2,owner:'B',stage:'X'},{id:3,owner:'B',stage:'X'}],{graph:spec({splitBy:'stage',measures:[measure('count',{label:'B'}),measure('count',{label:'A / B',where:[[cond('owner','A')]]})]})});
  assert.equal(result.views[0].result.datasets.filter(d=>d.label==='X / A / B').length,2);
  const text=answer(result);
  assert.equal(text.match(/ x 100;/g).length,4);
  assert.match(text,/- A \/ X \/ A \/ B: 33\.33% \(1 \/ 3/);
  assert.match(text,/- B \/ X \/ B: 66\.67% \(2 \/ 3/);
});

test('top-N counts keep the pre-truncation denominator; incomplete additive totals are rejected',()=>{
  const data=[{id:1,owner:'A',value:1},{id:2,owner:'A',value:1},{id:3,owner:'B',value:1}];
  for(const metric of ['count','sum']){
    const result=build(data,{graph:spec({measures:[measure(metric)],sort:'value_desc',limit:1})});
    const text=answer(result);
    assert.match(text,/- A: 66\.67% \(2 \/ 3/);assert.match(text,/2 of 3 matching records represented; 1 of 2 groups shown/);
    assert.throws(()=>answer(result,'measure_total'),/complete measure total is not cached/);
    assert.match(answer(build(data,{graph:spec({limit:5,measures:[measure(metric)]})}),'measure_total'),/- A: 66\.67%/);
  }
});

test('date exclusions and empty intervals use the original matching count, never just plotted records',()=>{
  const data=[{id:1,cf_date:'2026-09-01',value:1},{id:2,cf_date:'2026-09-03',value:1},{id:3,cf_date:'',value:1}],custom=[{id:'cf_date',name:'Review date',type:'date'}];
  const result=build(data,{graph:spec({groupBy:'cf_date',bucket:'day'})},custom),text=answer(result);
  assert.match(text,/- 2026-09-01: 33\.33% \(1 \/ 3/);assert.match(text,/- 2026-09-02: 0% \(0 \/ 3/);assert.match(text,/- 2026-09-03: 33\.33% \(1 \/ 3/);
  assert.match(text,/2 of 3 matching records represented/);assert.throws(()=>answer(result,'measure_total'),/date-excluded/);
});

test('blank and zero-valued group labels remain in the population',()=>{
  const result=build([{id:1,owner:null},{id:2,owner:''},{id:3,owner:0}]);
  assert.match(answer(result),/- Not set: 66\.67% \(2 \/ 3/);assert.match(answer(result),/- 0: 33\.33% \(1 \/ 3/);
});

test('scope and shared graph filters define the denominator without accepting an assumed user count',()=>{
  const data=[{id:1,owner:'Ravi',stage:'Warm'},{id:2,owner:'Ravi',stage:'Won'},{id:3,owner:'Other',stage:'Warm'},{id:4,owner:'Ravi',stage:'Warm'}];
  const initial=build(data,{graph:spec({scope:'visible',groupBy:'stage'})},[],{visibleIds:[1,2,3]});
  const result=D.apply(initial.board,{action:'dashboard_plan',operations:[{op:'set_shared_filter',id:'ravi',targets:['graph'],where:[[cond('owner','Ravi')]]}],questions:[question()]},data,C);
  assert.match(result.answer,/Shared denominator: 2 matching records/);
  assert.match(result.answer,/- Warm: 50% \(1 \/ 2/);assert.match(result.answer,/- Won: 50% \(1 \/ 2/);
});

test('zero and missing totals are undefined, while zero numerators and null value cells stay distinct',()=>{
  for(const groupBy of ['owner',null]){
    const empty=build([],{graph:spec({groupBy})});
    for(const denominator of ['matching_records','measure_total']){
      const text=answer(empty,denominator);
      assert.match(text,/Percentages are Not set because the shared denominator is missing or zero/);
      assert.doesNotMatch(text,/: (?:NaN|Infinity|0)%/);
      assert.match(text,groupBy===null?/- All records: Not set/:/No groups/);
    }
  }
  const emptySplit=build([],{graph:spec({splitBy:'stage'})});
  assert.match(answer(emptySplit),/Percentages are Not set/);assert.match(answer(emptySplit),/No groups/);
  assert.match(answer(emptySplit,'measure_total'),/Percentages are Not set/);
  const values=build([{id:1,owner:'Missing',value:null},{id:2,owner:'Zero',value:0},{id:3,owner:'Known',value:25}],{graph:spec({measures:[measure('sum')]})});
  const text=answer(values,'measure_total');
  assert.match(text,/- Missing: Not set \(Not set \/ \$25\.00/);
  assert.match(text,/- Zero: 0% \(\$0\.00 \/ \$25\.00/);
  assert.match(text,/- Known: 100% \(\$25\.00 \/ \$25\.00/);
  assert.match(answer(values),/- Missing: 33\.33% \(1 \/ 3/);
  for(const value of [0,null]){
    const all=build([{id:1,owner:'A',value}],{graph:spec({measures:[measure('sum')]})});
    assert.match(answer(all,'measure_total'),/- A: Not set/);
  }
});

test('numeric and currency additive totals, measure indices, and signed net shares are explicit',()=>{
  const data=[{id:1,owner:'A',value:0.1},{id:2,owner:'B',value:0.2}];
  const currency=build(data,{graph:spec({measures:[measure('sum',{label:'All'}),measure('sum',{label:'A',where:[[cond('owner','A')]]})]})});
  assert.match(answer(currency,'measure_total'),/- A: 33\.33% \(\$0\.10 \/ \$0\.30/);
  assert.match(answer(currency,'measure_total',{measure:1}),/- A: 100% \(\$0\.10 \/ \$0\.10/);
  const core=C.create({status:'ready',useCase:'Other',description:'Inventory',title:'Inventory',recordLabel:'item',fields:[{id:'f_name',name:'Item',type:'text',role:'primary',options:[]},{id:'f_quantity',name:'Quantity',type:'number',role:'none',options:[]}]});
  const numeric=build([{id:1,f_name:'A',f_quantity:2},{id:2,f_name:'B',f_quantity:6}],{graph:spec({groupBy:'f_name',measures:[measure('sum',{field:'f_quantity'})]})},[],{},core);
  assert.match(answer(numeric,'measure_total'),/- B: 75% \(6 \/ 8/);
  const signed=build([{id:1,owner:'A',value:120},{id:2,owner:'B',value:-20}],{graph:spec({measures:[measure('sum')]})});
  assert.match(answer(signed,'measure_total'),/- B: -20%/);assert.match(answer(signed,'measure_total'),/- A: 120%/);
  assert.match(answer(signed,'measure_total'),/signed shares of a net total/);
});

test('nonadditive measures cannot be silently normalized into value distributions',()=>{
  for(const metric of ['average','median','min','max','count_distinct','percentage']){
    const result=build([{id:1,owner:'A',value:10},{id:2,owner:'B',value:10}],{graph:spec({measures:[measure(metric)]})});
    assert.throws(()=>answer(result,'measure_total'),/require an additive count or sum/);
    assert.match(answer(result),/- A: 50% \(1 \/ 2/);
  }
});

test('context omission does not truncate cached analysis and rounding never forces a remainder to 100%',()=>{
  const many=build(Array.from({length:121},(_,i)=>({id:i+1,owner:'Group '+i})));
  const context=D.context(many.board,many.views);
  assert.equal(context.displayed[0].tableOmitted,true);assert.equal(context.displayed[0].table,undefined);
  assert.match(context.analysisRule,/group_percentages/);assert.match(context.analysisRule,/tableOmitted only limits this context/);
  assert.equal(answer(many).match(/ x 100;/g).length,121);
  const equal=build([{id:1,owner:'A'},{id:2,owner:'B'},{id:3,owner:'C'}]);
  assert.equal(answer(equal).match(/33\.33%/g).length,3);assert.doesNotMatch(answer(equal),/33\.34%/);
});

test('strict schema adds one backward-compatible question kind to both action forms',()=>{
  const schemas=D.schemas(C);
  for(const schema of schemas){
    const variants=schema.properties.questions.items.anyOf;
    const distribution=variants.find(v=>v.properties.kind.enum.includes('group_percentages'));
    assert.deepEqual(distribution.required,['kind','elementId','measure','denominator']);assert.equal(distribution.additionalProperties,false);
    assert.deepEqual(distribution.properties.denominator.enum,['matching_records','measure_total']);
    assert.deepEqual(variants.find(v=>v.properties.kind.enum.includes('groups')).required,['kind','elementId','measure']);
    assert.deepEqual(variants.find(v=>v.properties.kind.enum.includes('percentage')).required,['kind','label','left','right']);
  }
  const plan=require('../public/workspace-plan').responseSchema(C),report=plan.properties.steps.items.anyOf.find(step=>step.properties.op.enum.includes('report'));
  assert.deepEqual(report.properties.questions,schemas[1].properties.questions);
});

test('existing review evidence carries actual grouped percentages and preserves the dashboard',()=>{
  const Review=require('../lib/action-review'),records=[{id:1,owner:'A'},{id:2,owner:'A'},{id:3,owner:'B'}],result=build(records);
  const payload={pipeline:{records,currentDate:'2026-10-10',dashboard:{board:result.board}}},before=JSON.stringify(payload);
  const action={assistantMessage:'Untrusted answer',crmAction:{action:'analyze_dashboard',questions:[question()]}};
  const evidence=Review.evidence(payload,action);
  assert.equal(evidence.dashboardChanged,false);assert.match(evidence.answer,/- A: 66\.67% \(2 \/ 3/);assert.match(evidence.answer,/- B: 33\.33% \(1 \/ 3/);
  assert.equal(Review.renderAnswer(payload,action,evidence),evidence.answer);assert.equal(JSON.stringify(payload),before);
  const groups=Review.evidence(payload,{crmAction:{action:'analyze_dashboard',questions:[{kind:'groups',elementId:'graph',measure:0}]}});
  assert.doesNotMatch(groups.answer,/%/);
});

test('invalid questions and incomplete caches fail rather than invent a percentage',()=>{
  const result=build([{id:1,owner:'A'}]),before=JSON.stringify(result);
  for(const extra of [{elementId:'missing'},{measure:-1},{measure:0.5},{measure:9},{denominator:3},{denominator:'groups'},{denominator:null},{denominator:{elementId:'graph',stat:'records'}},{extra:true}])assert.throws(()=>answer(result,'matching_records',extra));
  const missing=question();delete missing.denominator;assert.throws(()=>D.analyze([missing],result.views),/complete, supported/);
  assert.equal(JSON.stringify(result),before);
  const partial=structuredClone(result);partial.views[0].snapshot.table=[];
  assert.throws(()=>answer(partial),/cached group results are incomplete/);
  const inflated=structuredClone(result);inflated.views[0].snapshot.table[0].count=2;
  assert.throws(()=>answer(inflated),/not a subset/);
  const invalid=structuredClone(result);invalid.views[0].snapshot.table[0].count=NaN;
  assert.throws(()=>answer(invalid),/invalid numeric value/);
});
