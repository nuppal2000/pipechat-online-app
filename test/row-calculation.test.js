'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const Calc=require('../public/row-calculation'),Core=require('../public/pipeline-core');
const custom=[{id:'cf_probability',name:'Probability percent',type:'number'},{id:'cf_units',name:'Units',type:'number'}];
const expression={kind:'sum_product',factors:['value','cf_probability'],divisor:100};
const row=(id,value,probability,name='Record '+id)=>({id,account:name,value,cf_probability:probability});
const calculate=(rows,expr=expression)=>Calc.evaluate(rows,expr,Core,custom);

test('F08 weighted pipeline totals 32000 and reports three missing probabilities without changing input',()=>{
  const rows=[row(1,12000,50,'QA1105 Cedar Consulting'),row(2,30000,80,'QA1105 Cedar North'),row(3,8000,25,'QA1105 Maple Retail'),
    row(4,10000,null),row(5,20000,null),row(6,30000,null)],before=structuredClone(rows);
  const r=calculate(rows);
  assert.equal(r.value,32000);assert.equal(r.valueText,'32000.00');assert.equal(r.type,'currency');
  assert.deepEqual(r.exactTotal,{numerator:'32000',denominator:'1'});
  assert.deepEqual(r.contributions.map(c=>c.value),[6000,24000,2000]);
  assert.deepEqual(r.selectedRecordIds,[1,2,3,4,5,6]);
  assert.deepEqual([r.coverage.selectedCount,r.coverage.includedCount,r.coverage.excludedCount],[6,3,3]);
  assert.deepEqual(r.coverage.excludedRows.map(r=>[r.recordId,r.missingFields]),[[4,['cf_probability']],[5,['cf_probability']],[6,['cf_probability']]]);
  assert.match(Calc.describe(r),/Total: \$32,000\.00/);
  assert.match(Calc.describe(r),/multiply "Value" by "Probability percent", divide by 100, then add/);
  assert.match(Calc.describe(r),/3 of 6.*3 excluded/);assert.match(Calc.describe(r),/Record 4.*Probability percent/);
  assert.doesNotMatch(Calc.describe(r),/cf_probability|SUM\(|half away|#4/);
  assert.deepEqual(rows,before);assert.deepEqual(JSON.parse(JSON.stringify(r)),r);
});

test('human wording uses factor labels and money formatting while evidence retains exact typed IDs',()=>{
  const amount='f_7ba65c2e55bd4dafbf4af04dbdf12345',probability='cf_d12aee55cbb84c5789dc1ad9bdf12345';
  const core={definitions:()=>[{id:amount,name:'Deal Value (USD)',type:'currency'},{id:probability,name:'Probability percent',type:'number'}],role:()=> 'account'};
  const r=Calc.evaluate([{id:1,account:'Included', [amount]:30000,[probability]:80},{id:2,account:'Excluded', [amount]:10000,[probability]:null}],
    {kind:'sum_product',factors:[amount,probability],divisor:100},core),before=structuredClone(r);
  const text=Calc.describe(r);
  assert.match(text,/Total: \$24,000\.00/);assert.match(text,/Deal Value \(USD\).*Probability percent/);
  assert.match(text,/Excluded.*missing "Probability percent"/);
  for(const id of [amount,probability]){assert(!text.includes(id));assert(!r.expressionText.includes(id));}
  assert.deepEqual(r.expression.factors,[amount,probability]);
  assert.deepEqual(r.coverage.excludedRows[0].missingFields,[probability]);assert.deepEqual(r,before);
  assert.match(Calc.describe(calculate([row(1,100,-25)])),/Total: -\$25\.00/);
  assert.match(Calc.describe(calculate([row(1,100,0)])),/Total: \$0\.00/);
  assert.match(Calc.describe(calculate([row(1,0,1234.125)],{kind:'sum_product',factors:['cf_probability'],divisor:1})),/Total: 1,234\.125/);
});

test('divisor is explicit, never inferred from values; zero and negative factors are real data',()=>{
  assert.equal(calculate([row(1,100,0.5)]).value,0.5);
  assert.equal(calculate([row(1,100,0.5)],{...expression,divisor:1}).value,50);
  const r=calculate([row(1,100,0),row(2,100,-25),row(3,0,50),row(4,100,'')]);
  assert.equal(r.value,-25);assert.equal(r.coverage.includedCount,3);assert.equal(r.coverage.excludedCount,1);
  assert.equal(calculate([row(1,null,50)]).value,null);
  assert.equal(calculate([]).value,null);assert.match(Calc.describe(calculate([])),/Not set/);
});

test('decimal multiplication and summation round only the final aggregate; cancellation and repeated fractions remain stable',()=>{
  const r=calculate([row(1,0.01,50),row(2,0.01,50),row(3,0.01,50)]);
  assert.equal(r.value,0.02);assert.deepEqual(r.exactTotal,{numerator:'3',denominator:'200'});
  assert.equal(r.precision.roundingStage,'aggregate_after_sum');
  assert.equal(calculate([row(1,-0.01,50)]).value,-0.01);
  const fraction=calculate([row(1,0.1,0.2)],{...expression,divisor:1});
  assert.equal(fraction.value,0.02);assert.deepEqual(fraction.exactTotal,{numerator:'1',denominator:'50'});
  const nums={kind:'sum_product',factors:['cf_probability'],divisor:3};
  assert.equal(calculate([row(1,0,1),row(2,0,1),row(3,0,1)],nums).value,1);
  assert.equal(calculate([row(1,0,1)],nums).valueText,'0.333333');
  assert.equal(calculate([row(1,0,1e12),row(2,0,0.01),row(3,0,-1e12)],{...nums,divisor:1}).value,0.01);
  assert.equal(calculate([row(1,1e-7,2e7)]).value,0.02);
  assert.equal(calculate([row(1,0,1e-18)],{...nums,divisor:1}).value,0);
  assert.throws(()=>calculate([row(1,0,1e-19)],nums),/precision/);
});

test('saved numeric strings, booleans and nonfinite cells reject even beside a missing factor',()=>{
  for(const bad of ['50','50%',false,{},[],NaN,Infinity,1e13,1e-19]){
    assert.throws(()=>calculate([row(1,100,bad)]));
    assert.throws(()=>calculate([row(1,null,bad)]));
  }
  const r=calculate([row(1,0,null),row(2,0,undefined),row(3,0,'  ')]);
  assert.equal(r.coverage.excludedCount,3);assert.equal(r.value,null);
});

test('bounded expression validates current typed IDs, not labels, code, formulas or inferred scales',()=>{
  for(const bad of [{...expression,divisor:0},{...expression,divisor:-1},{...expression,divisor:Infinity},{...expression,divisor:1e-13},
    {...expression,divisor:1e13},{...expression,divisor:'100'}, {...expression,divisor:undefined},
    {...expression,factors:[]},{...expression,factors:['value','value']},{...expression,factors:Array(5).fill('value')},
    {...expression,factors:['Value','cf_probability']},{...expression,factors:['account','cf_probability']},
    {...expression,factors:['missing']},{...expression,factors:['@new_field']},{...expression,formula:'value * percent / 100'},
    {...expression,kind:'eval'},{...expression,aggregate:'average'}]){
    assert.throws(()=>calculate([row(1,100,50)],bad));
  }
  assert.throws(()=>Calc.evaluate([row(1,100,50)],expression,Core,[]));
  assert.throws(()=>calculate([row(1,1e12,1e12)]),/precision|range/i);
  assert.throws(()=>calculate([row(1,100,50),row(1,200,50)]),/record/i);
});

test('four-factor arithmetic, all-missing coverage, large selections and output-unit guards stay bounded',()=>{
  const fields=Array.from({length:4},(_,i)=>({id:'cf_factor_'+i,name:'Factor '+i,type:'number'}));
  const expr={kind:'sum_product',factors:fields.map(f=>f.id),divisor:2.5};
  const r=Calc.evaluate([{id:1,account:'Units',cf_factor_0:2,cf_factor_1:3,cf_factor_2:4,cf_factor_3:5}],expr,Core,fields);
  assert.equal(r.value,48);assert.equal(r.type,'number');
  const many=Array.from({length:2000},(_,i)=>row(i+1,null,null)),empty=calculate(many);
  assert.equal(empty.coverage.excludedCount,2000);assert.deepEqual(empty.coverage.excludedRows[0].missingFields,['value','cf_probability']);
  assert.match(Calc.describe(empty),/1980 more/);assert.throws(()=>calculate([...many,row(2001,100,50)]),/2000/);
  const core={...Core,definitions:()=>[...Core.definitions(),{id:'f_cost',name:'Cost',type:'currency'}]};
  assert.throws(()=>Calc.evaluate([{...row(1,100,50),f_cost:20}],{...expression,factors:['value','f_cost']},core),/currency/);
  assert.equal(Calc.responseSchema({...Core,definitions:()=>[{id:'account',name:'Name',type:'text'}]}),null);
});

test('response schema is request-local and browser entry point uses the same pure implementation',()=>{
  const schema=Calc.responseSchema(Core,custom),p=schema.properties;
  assert.equal(schema.additionalProperties,false);assert.deepEqual(schema.required,['kind','factors','divisor']);
  assert.deepEqual(p.factors.items.enum,['value','cf_probability','cf_units']);
  assert.equal(p.factors.maxItems,4);assert.equal(p.divisor.minimum,1e-12);
  assert.deepEqual(Calc.responseSchema(Core,[]).properties.factors.items.enum,['value']);
  const context={};vm.runInNewContext(fs.readFileSync(require.resolve('../public/row-calculation'),'utf8'),context);
  assert.equal(context.PipeChatRowCalculation.evaluate([row(1,200,25)],expression,Core,custom).value,50);
});
