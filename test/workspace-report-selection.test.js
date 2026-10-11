'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Plan=require('../public/workspace-plan.js'),Dashboard=require('../public/dashboard-board.js'),Core=require('../public/pipeline-core.js');
const F=require('./fixtures/workspace-plans.cjs');
const options={today:'2026-10-10',nonce:'report_selection'};
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const workspace=()=>{
  const w=F.workspace();
  w.records=w.records.map((row,i)=>({...row,id:[17,5,92,31,44,68][i],f_deal:'Account '+(i+1),f_owner:i%2?'Owner B':'Owner A',f_value:[120,60,0,900,800,700][i],f_notes:i<3?'cohort':'outside'}));
  return w;
};
const cohort=()=>F.select('cohort',[[F.where('f_notes','equals','cohort')]],{orderBy:'f_value',direction:'asc'});
const spec=extra=>({version:1,title:'Owner totals',chart:'bar',scope:'all',groupBy:'f_owner',bucket:'none',splitBy:null,measures:[{label:'Amount',metric:'sum',field:'f_value',where:[]}],where:[],sort:'label_asc',limit:null,...extra});
const report=extra=>({op:'report',id:'report',label:'Report selected records',selection:'cohort',spec:spec(),questions:[{kind:'summary',elementIds:['report']},{kind:'groups',elementId:'report',measure:0}],showDashboard:false,...extra});
const prepare=(steps,w=workspace(),extra={})=>Plan.prepare(w,F.plan(steps),{...options,...extra});
const evaluate=(board,w=workspace())=>Dashboard.evaluate(board,w.records,Core.create(w.tableSchema),w.customFields,options)[0];
const evidence=result=>result.queryResults.find(row=>row.id==='report');
const ids=values=>values.slice().sort((a,b)=>a-b);

test('report model schema requires a strict nullable selection reference',()=>{
  const branch=Plan.responseSchema().properties.steps.items.anyOf.find(s=>s.properties.op.enum.includes('report'));
  assert.equal(branch.additionalProperties,false);
  assert.deepEqual(branch.required,Object.keys(branch.properties));
  assert(branch.required.includes('selection'));
  assert.deepEqual(branch.properties.selection.type,['string','null']);
});

test('read and grouped report use the same selected cohort even when the report says all',()=>{
  const w=freeze(workspace()),read={op:'read_records',id:'read',label:'Read selected amounts',selection:'cohort',showTable:false,outputs:[{kind:'count',field:null},{kind:'sum',field:'f_value'}]};
  const result=prepare([cohort(),read,report()],w,{visibleIds:[31,44,68]});
  assert.match(result.answers[0],/Record count: 3/);
  assert.match(result.answers[0],/Total Value: \$180\.00/);
  assert.match(result.answers[1],/3 records represented/);
  assert.match(result.answers[1],/Amount: \$180\.00/);
  assert.match(result.answers[1],/Owner A: \$120\.00 \(2 records\)/);
  assert.match(result.answers[1],/Owner B: \$60\.00 \(1 records\)/);
  assert.deepEqual(ids(evidence(result).recordIds),ids(result.queryResults[0].recordIds));
  assert.equal(evidence(result).selection,'cohort');
  assert.equal(evidence(result).viewEffect,'answer_only');
  const review=result.review.find(row=>row.id==='report');
  assert.equal(review.selection,'cohort');assert.equal(review.count,3);
  assert.deepEqual(review.recordIds,evidence(result).recordIds);
  assert.equal(result.effects.some(effect=>effect.kind==='dashboard'),false);
  assert.equal(result.mutates,false);assert.deepEqual(result.next,w);
});

test('selected reports retain additional spec filters without matching outside records',()=>{
  const where=[[F.where('f_value','gt',0),F.where('f_owner','equals','Owner A')]];
  const result=prepare([cohort(),report({spec:spec({where}),showDashboard:true})]);
  assert.deepEqual(evidence(result).recordIds,[17]);
  assert.match(result.answers[0],/1 records represented/);
  assert.match(result.answers[0],/Amount: \$120\.00/);
  const element=result.effects[0].board.elements[0];
  assert.equal(element.spec.scope,'visible');assert.deepEqual(element.spec.where,where);
  assert.deepEqual(element.visibleIds,[92,5,17]);
});

test('answer-only report publishes its actual narrowed cohort without a view change',()=>{
  for(const where of [[[F.where('f_value','gt',0),F.where('f_owner','equals','Owner A')]],[[F.where('f_value','gt',99999)]]]){
    const result=prepare([cohort(),report({spec:spec({where})})],workspace(),{focus:{kind:'table',ids:[31,44]}});
    assert.deepEqual(result.effects,[{kind:'table',show:false,ids:evidence(result).recordIds}]);
    const focus={kind:'table',ids:result.effects[0].ids};
    const next=prepare([F.select('next',[],{source:'focus'}),{op:'read_records',id:'read',label:'Read those records',selection:'next',showTable:false,outputs:[{kind:'count',field:null}]}],workspace(),{focus});
    assert.deepEqual(next.queryResults[0].recordIds,evidence(result).recordIds);
    assert.equal(result.mutates,false);
  }
});

test('an empty selection never falls back to all records or the current visible records',()=>{
  const empty=F.select('cohort',[[F.where('f_value','gt',10000)]]);
  const result=prepare([empty,report({spec:spec({measures:[{label:'Count',metric:'count',field:null,where:[]}]}),showDashboard:true})],workspace(),{visibleIds:[31,44,68]});
  assert.deepEqual(evidence(result).recordIds,[]);assert.equal(evidence(result).selection,'cohort');
  assert.match(result.answers[0],/0 records represented/);assert.match(result.answers[0],/Count: 0/);
  const saved=JSON.parse(JSON.stringify(result.effects[0].board));
  assert.deepEqual(saved.elements[0].visibleIds,[]);assert.equal(saved.elements[0].spec.scope,'visible');
  assert.equal(evaluate(saved).snapshot.recordCount,0);assert.equal(result.mutates,false);
});

test('unknown, non-selection and forward report references fail closed',()=>{
  const cases=[
    [cohort(),report({selection:'missing'})],
    [cohort(),report({selection:'all'})],
    [cohort(),report({selection:'visible'})],
    [report(),cohort()],
    [cohort(),report({selection:'report'})],
    [cohort(),F.update('edit','cohort','f_notes','changed'),report({selection:'edit'})],
    [cohort(),F.update('edit','cohort','f_notes','changed'),report({selection:'stale_selection'})]
  ];
  for(const steps of cases){
    const w=freeze(workspace()),action=freeze(F.plan(steps)),before=JSON.stringify({w,action});
    assert.throws(()=>Plan.prepare(w,action,options),error=>error.clarification===true&&/Select records before.*entire plan is unchanged/.test(error.message));
    assert.equal(JSON.stringify({w,action}),before);
  }
});

test('provided non-null report selections must be strings naming a prior selection',()=>{
  for(const selection of ['',false,0,[],{},undefined]){
    assert.throws(()=>prepare([cohort(),report({selection})]),error=>error.clarification===true&&/selection|Select records/.test(error.message));
  }
});

test('a report cannot reuse a stale focused cohort with a deleted record',()=>{
  const w=freeze(workspace()),focus=freeze({kind:'table',ids:[17,999]});
  assert.throws(()=>prepare([F.select('cohort',[],{source:'focus'}),report()],w,{focus}),/no longer exists.*entire plan is unchanged/);
  assert.deepEqual(focus.ids,[17,999]);
});

test('explicit null and omitted legacy selection retain independent all and visible scope',()=>{
  for(const scope of ['all','visible'])for(const legacy of [false,true]){
    const step=report({selection:null,spec:spec({scope})});if(legacy)delete step.selection;
    const result=prepare([cohort(),step],workspace(),{visibleIds:[31,44]});
    const expected=scope==='all'?[17,5,92,31,44,68]:[31,44];
    assert.equal(evidence(result).selection,null);assert.deepEqual(ids(evidence(result).recordIds),ids(expected));
    assert.match(result.answers[0],scope==='all'?/Amount: \$2,580\.00/:/Amount: \$1,700\.00/);
  }
});

test('showDashboard persists cohort IDs and scope through serialization and reevaluation',()=>{
  for(const scope of ['all','visible']){
    const w=freeze(workspace()),action=freeze(F.plan([cohort(),report({spec:spec({scope}),showDashboard:true})]));
    const config=freeze({...options,visibleIds:[31,44],dashboard:Dashboard.empty()}),before=JSON.stringify({w,action,config});
    const result=Plan.prepare(w,action,config),saved=JSON.parse(JSON.stringify(result.effects[0].board));
    assert.equal(result.effects.length,1);assert.equal(evidence(result).viewEffect,'show_dashboard');
    assert.deepEqual(saved.elements[0].visibleIds,[92,5,17]);assert.equal(saved.elements[0].spec.scope,'visible');
    const changed=workspace();changed.records.push({...changed.records[0],id:109,f_value:9999});
    const view=evaluate(saved,changed);
    assert.equal(view.snapshot.recordCount,3);assert.equal(view.snapshot.summaries[0].value,180);
    assert.equal(result.mutates,false);assert.deepEqual(result.next,w);assert.deepEqual(result.patches,[]);
    result.effects[0].board.elements[0].spec.measures[0].label='Changed output';
    result.effects[0].board.elements[0].visibleIds.push(109);
    assert.equal(JSON.stringify({w,action,config}),before);
  }
});

test('legacy report effects also detach spec and visible IDs from the inputs',()=>{
  const w=freeze(workspace()),action=freeze(F.plan([report({selection:null,spec:spec({scope:'visible'}),showDashboard:true})]));
  const config=freeze({...options,visibleIds:[17]});
  const result=Plan.prepare(w,action,config),element=result.effects[0].board.elements[0];
  element.spec.where.push([F.where('f_value','gt',0)]);element.visibleIds.push(5);
  assert.deepEqual(action.steps[0].spec.where,[]);assert.deepEqual(config.visibleIds,[17]);
});

test('grouped percentages use the selected cohort as the shared denominator',()=>{
  const result=prepare([cohort(),report({spec:spec({measures:[{label:'Share',metric:'percentage',field:null,where:[]}]}),showDashboard:true})]);
  const view=evaluate(result.effects[0].board),groups=view.snapshot.table;
  assert.equal(view.result.count,3);assert.equal(view.snapshot.summaries[0].value,100);
  assert(Math.abs(groups.find(row=>row.group==='Owner A').value-200/3)<1e-9);
  assert(Math.abs(groups.find(row=>row.group==='Owner B').value-100/3)<1e-9);
  assert(Math.abs(groups.reduce((sum,row)=>sum+row.value,0)-100)<1e-9);
  assert.match(result.answers[0],/Owner A: 66\.67%/);assert.match(result.answers[0],/Owner B: 33\.33%/);
});

test('percentage numerator and group limit do not shrink the selected denominator',()=>{
  const result=prepare([cohort(),report({spec:spec({measures:[{label:'Positive share',metric:'percentage',field:null,where:[[F.where('f_value','gt',0)]]}],limit:1}),showDashboard:true})]);
  const view=evaluate(result.effects[0].board);
  assert.equal(view.result.count,3);assert.equal(view.snapshot.recordCount,2);
  assert(Math.abs(view.snapshot.summaries[0].value-100/3)<1e-9);
  assert.deepEqual(ids(evidence(result).recordIds),[17,92]);
  assert.deepEqual(result.effects[0].board.elements[0].visibleIds,[92,5,17]);
});

test('a selected report does not silently repair an invalid original scope',()=>{
  assert.throws(()=>prepare([cohort(),report({spec:spec({scope:'invalid'})})]),/scope|report definition/i);
});

test('numeric read summaries keep zero, exclude null, empty and non-numeric values, and state that policy',()=>{
  const w=workspace();w.records=w.records.slice(0,5).map((row,i)=>({...row,f_value:[0,null,'',12,'not numeric'][i]}));
  const outputs=['sum','average','median','min','max'].map(kind=>({kind,field:'f_value'}));
  const action=freeze(F.plan([F.select('cohort'),{op:'read_records',id:'read',label:'Numeric summaries',selection:'cohort',showTable:false,outputs}]));
  freeze(w);const before=JSON.stringify({w,action}),result=Plan.prepare(w,action,options),lines=result.answers[0].split('\n');
  for(const [index,label,value] of [[0,'Total','12.00'],[1,'Average','6.00'],[2,'Median','6.00'],[3,'Lowest','0.00'],[4,'Highest','12.00']]){
    assert(lines[index].startsWith(`${label} Value: $${value}`));
    assert.match(lines[index],/2 numeric values across 5 records\. Blank\/non-numeric values excluded; zeroes included\.$/);
  }
  assert.equal(result.mutates,false);assert.equal(JSON.stringify({w,action}),before);assert.deepEqual(result.next,w);
});
