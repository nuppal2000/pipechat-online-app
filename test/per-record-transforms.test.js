'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Plan=require('../public/workspace-plan'),Core=require('../public/pipeline-core');
const F=require('./fixtures/workspace-plans.cjs');
const options={today:'2026-10-26',nonce:'per_record',now:123};
const workspace=(values=[10000,20000,0],dates=['2026-10-27','2026-10-28','2026-10-30'])=>{
  const w=F.workspace();
  w.records=values.map((value,index)=>({...w.records[index%w.records.length],id:index+1,f_deal:'Record '+(index+1),f_value:value,f_follow:dates[index%dates.length]}));
  return w;
};
const percent=(value=10,blankPolicy='error',field='f_value')=>({field,operation:'adjust_percent',value:{percent:value,blankPolicy}});
const shift=(offset=2,dateMode='calendar_days',blankPolicy='error',field='f_follow')=>({field,operation:'shift_date',value:{dateMode,offset,blankPolicy}});
const update=(assignments,id='change',selection='selected')=>({op:'update_records',id,label:id,selection,assignments});
const action=(...assignments)=>F.plan([F.select('selected'),update(assignments)]);
const prepare=(a,w=workspace(),extra={})=>Plan.prepare(w,a,{...options,...extra});
const evidence=p=>p.review.flatMap(step=>step.transforms||[]);
function rejects(a,w=workspace(),reason){
  const before=structuredClone(w),originalAction=structuredClone(a);
  assert.throws(()=>prepare(a,w),error=>{
    assert.equal(error.clarification,true);assert.equal(error.compilerStep,'update_records');
    assert.match(error.message,/entire plan is unchanged/);
    if(reason)assert.equal(error.reasonCode,reason);
    return true;
  });
  assert.deepEqual(w,before);assert.deepEqual(a,originalAction);
}

test('F01 adjusts each saved value by +10 percent and retains zero in evidence',()=>{
  const w=workspace(),before=structuredClone(w),a=action(percent()),originalAction=structuredClone(a),p=prepare(a,w);
  assert.deepEqual(p.next.records.map(row=>row.f_value),[11000,22000,0]);
  assert.deepEqual(w,before);assert.deepEqual(a,originalAction);
  assert.equal(p.patches.length,2);assert.equal(p.review[1].count,3);assert.equal(p.review[1].changes,2);
  assert.deepEqual(evidence(p).map(row=>[row.recordId,row.before,row.after,row.baseDate,row.skipped]),[[1,10000,11000,null,false],[2,20000,22000,null,false],[3,0,0,null,false]]);
  assert.equal(p.calculations.length,3);assert.match(p.calculations[2],/Record 3 \(#3\).*0 \+ 10% = 0/);
  for(const row of evidence(p)){
    assert.equal(row.operation,'adjust_percent');assert.equal(row.fieldId,'f_value');assert.equal(row.fieldName,'Value');
    assert.deepEqual(row.operand,{percent:10,blankPolicy:'error'});
  }
});

test('percentages support negatives, decimals, zero and full reductions using field rounding',()=>{
  for(const [values,operand,expected] of [
    [[10000,20000,0],-10,[9000,18000,0]],[[100,200,0],-100,[0,0,0]],
    [[10.25,19.99,0],12.5,[11.53,22.49,0]],[[10.25,19.99,0],-12.5,[8.97,17.49,0]],
    [[-100,-12.5,0],10,[-110,-13.75,0]],[[1,2,0],-150,[-0.5,-1,0]],
    [[10.25,19.99,0],0,[10.25,19.99,0]]
  ])assert.deepEqual(prepare(action(percent(operand)),workspace(values)).next.records.map(row=>row.f_value),expected);
  const w=workspace([0.1,12.3456,0]);w.tableSchema.fields.find(field=>field.id==='f_value').type='number';
  assert.deepEqual(prepare(action(percent(12.5)),w).next.records.map(row=>row.f_value),[0.1125,13.8888,0]);
  assert.equal(prepare(action(percent(0)),w).mutates,false);
});

test('F03 shifts each saved date instead of today and exposes every base date',()=>{
  const w=workspace([10000,20000],['2026-10-27','2026-10-28']),p=prepare(action(shift()),w);
  assert.deepEqual(p.next.records.map(row=>row.f_follow),['2026-10-29','2026-10-30']);
  assert.deepEqual(evidence(p).map(row=>[row.before,row.after,row.baseDate]),[['2026-10-27','2026-10-29','2026-10-27'],['2026-10-28','2026-10-30','2026-10-28']]);
  for(const row of evidence(p)){
    assert.deepEqual(row.operand,{dateMode:'calendar_days',offset:2,blankPolicy:'error'});
    assert.match(row.explanation,new RegExp('base date \\(saved\\): '+row.before));
    assert.match(row.explanation,new RegExp(row.before+' -> '+row.after));
  }
  assert.doesNotMatch(p.calculations.join('\n'),/2026-10-26|today/);
  for(const today of [undefined,'not a date','2040-01-01'])assert.deepEqual(prepare(action(shift()),w,{today}),p);
});

test('calendar and business shifts cover weekends, negative offsets, leap days and year changes',()=>{
  for(const [base,offset,mode,expected] of [
    ['2026-10-30',2,'business_days','2026-11-03'],['2026-10-31',1,'business_days','2026-11-02'],
    ['2026-11-02',-2,'business_days','2026-10-29'],['2026-11-01',-1,'business_days','2026-10-30'],
    ['2026-12-31',2,'business_days','2027-01-04'],['2028-02-28',1,'business_days','2028-02-29'],
    ['2028-02-28',2,'calendar_days','2028-03-01'],['2027-01-01',-2,'calendar_days','2026-12-30'],
    ['2026-10-31',0,'business_days','2026-10-31'],['2026-10-31',0,'calendar_days','2026-10-31']
  ]){
    const p=prepare(action(shift(offset,mode)),workspace([1],[base]));
    assert.equal(p.next.records[0].f_follow,expected,`${base}: ${offset} ${mode}`);
    assert.equal(evidence(p)[0].baseDate,base);
    if(mode==='business_days')assert.match(p.calculations[0],/Monday-Friday; weekends skipped, holidays not excluded/);
  }
});

test('transforms read original saved values even after earlier assignments and other transforms',()=>{
  const w=workspace([10000,20000],['2026-10-27','2026-10-28']);
  const a=F.plan([F.select('selected'),update([
    {field:'f_value',operation:'set',value:999},{field:'f_follow',operation:'set',value:{dateMode:'literal',date:'2030-01-01',offset:null}}
  ],'set_first'),update([percent(50),shift(10)],'first_transform'),update([percent(10),shift(2)])]);
  const p=prepare(a,w);
  assert.deepEqual(p.next.records.map(row=>[row.f_value,row.f_follow]),[[11000,'2026-10-29'],[22000,'2026-10-30']]);
  assert.deepEqual(p.review[3].transforms.map(row=>row.before),[10000,'2026-10-27',20000,'2026-10-28']);
  const sameStep=prepare(action({field:'f_value',operation:'set',value:999},percent()),w);
  assert.deepEqual(sameStep.next.records.map(row=>row.f_value),[11000,22000]);
});

test('transforms stay within authorized selections and selectors keep original-value semantics',()=>{
  const w=workspace([10000,20000,0]);w.records[2].f_follow='invalid outside selection';
  const a=F.plan([F.select('selected',[],{source:'visible'}),update([percent(),shift()]),
    F.select('original_large',[[F.where('f_value','gte',20000)]],{source:'selected'}),update([percent(-10)],'reduce','original_large')]);
  const p=prepare(a,w,{visibleIds:[1,2]});
  assert.deepEqual(p.next.records.map(row=>row.f_value),[11000,18000,0]);
  assert.deepEqual(p.next.records[2],w.records[2]);
  assert.deepEqual(p.review[2].records.map(row=>row.id),[2]);
});

test('blank saved values require clarification by default, including after literal assignments',()=>{
  for(const make of [percent,shift])for(const blank of ['',null,undefined,'  ']){
    const a=make(),w=workspace();w.records[1][a.field]=blank;delete a.value.blankPolicy;
    rejects(action(a),w,'transform_blank');
    rejects(action({...a,value:{...a.value,blankPolicy:'error'}}),w,'transform_blank');
  }
  const w=workspace();w.records[1].f_follow='';
  rejects(F.plan([F.select('selected'),update([{field:'f_follow',operation:'set',value:{dateMode:'calendar_days',date:null,offset:1}}],'fill'),update([shift()])]),w,'transform_blank');
});

test('explicit skip leaves blanks untouched and reports them; zero is never skipped',()=>{
  const w=workspace([0,null,'',undefined,'  '],['2026-10-27','',null,undefined,'  ']);
  const p=prepare(action(percent(10,'skip'),shift(2,'calendar_days','skip')),w);
  assert.deepEqual(p.next.records.map(row=>row.f_value),[0,null,'',undefined,'  ']);
  assert.deepEqual(p.next.records.map(row=>row.f_follow),['2026-10-29','',null,undefined,'  ']);
  assert.equal(evidence(p).filter(row=>row.skipped).length,8);
  assert.equal(evidence(p)[0].skipped,false);assert.equal(evidence(p)[0].after,0);
  assert.equal(p.calculations.length,10);assert.match(p.calculations[2],/blank saved value.*skipped by explicit blank policy/);
  assert.equal(p.review[1].changes,1);assert.equal(p.patches.length,1);
});

test('missing blankPolicy defaults to error on populated cells without changing the model schema',()=>{
  const a=percent(),b=shift();delete a.value.blankPolicy;delete b.value.blankPolicy;
  const p=prepare(action(a,b));
  assert(evidence(p).every(row=>row.operand.blankPolicy==='error'));
});

test('operand and result limits are enforced atomically, including date range overflow',()=>{
  for(const operand of [-10000,10000])assert.equal(prepare(action(percent(operand)),workspace([1])).next.records[0].f_value,1+operand/100);
  for(const offset of [-366,366])for(const mode of ['calendar_days','business_days'])assert.equal(evidence(prepare(action(shift(offset,mode)),workspace([1]))).length,1);
  assert.equal(prepare(action(percent(0)),workspace([1e12])).next.records[0].f_value,1e12);
  rejects(action(percent(10000.01)),workspace(),'transform_invalid');
  rejects(action(percent(-10000.01)),workspace(),'transform_invalid');
  rejects(action(percent()),workspace([1,1e12]),'transform_result_invalid');
  rejects(action(percent(0)),workspace([1,1e12+1]),'transform_base_invalid');
  rejects(action(shift(1)),workspace([1,2],['2026-10-27','9999-12-31']),'transform_result_invalid');
  rejects(action(shift(-1)),workspace([1,2],['2026-10-27','0100-01-01']),'transform_result_invalid');
});

test('malformed, formula-like and extra transform operands reject without coercion',()=>{
  const malformed=[
    ...['10',NaN,Infinity,-Infinity,null,true,{},[]].map(value=>percent(value)),
    ...['2',1.5,NaN,Infinity,null,true,367,-367].map(value=>shift(value)),
    shift(2,'literal'),shift(2,'days'),percent(10,null),percent(10,'zero'),shift(2,'calendar_days','today'),
    {...percent(),value:11000},{...shift(),value:'2026-10-29'},
    {...percent(),value:{expression:'value * 1.1'}},{...shift(),value:{offset:2}},
    {...percent(),value:{...percent().value,result:11000}},{...shift(),value:{...shift().value,baseDate:'2026-10-26'}},
    {...shift(),value:{...shift().value,date:null}},{...percent(),value:shift().value},{...shift(),value:percent().value},
    {...percent(),baseValue:10000},{...shift(),sourceField:'f_notes'}
  ];
  for(const assignment of malformed)rejects(action(assignment),workspace(),'transform_invalid');
  rejects(action({...percent(),operation:'multiply'}));
  for(const value of [null,[],{},'value + 10'])rejects(action({...percent(),value}),workspace(),'transform_invalid');
});

test('cross-type fields and corrupt saved values are rejected even with skip enabled',()=>{
  for(const field of ['f_deal','f_priority','f_follow'])rejects(action(percent(10,'skip',field)),workspace(),'transform_type_invalid');
  for(const field of ['f_deal','f_priority','f_value'])rejects(action(shift(2,'calendar_days','skip',field)),workspace(),'transform_type_invalid');
  for(const value of ['10000',true,'invalid',NaN,Infinity,{},[]]){
    const w=workspace();w.records[1].f_value=value;rejects(action(percent(10,'skip')),w,'transform_base_invalid');
  }
  for(const value of [0,123,true,'2026-02-30','10/27','today','2026-10-27T12:00:00Z',{},[]]){
    const w=workspace();w.records[1].f_follow=value;rejects(action(shift(2,'calendar_days','skip')),w,'transform_base_invalid');
  }
});

test('invalid empty branches are not silently accepted and earlier successful writes stay atomic',()=>{
  rejects(F.plan([F.select('selected',[[F.where('f_value','lt',0)]]),update([percent('10')])]),workspace(),'transform_invalid');
  rejects(F.plan([F.select('selected',[[F.where('f_value','lt',0)]]),update([shift(2,'calendar_days','skip','f_value')])]),workspace(),'transform_type_invalid');
  const w=workspace(),a=F.plan([F.select('selected'),F.update('notes','selected','f_notes','Must not persist'),update([percent(),shift()])]);
  w.records[2].f_follow='';rejects(a,w,'transform_blank');
  const p=prepare(F.plan([F.select('selected',[[F.where('f_value','lt',0)]]),update([percent(),shift()])]));
  assert.equal(p.mutates,false);assert.equal(p.review[1].count,0);assert.deepEqual(p.calculations,[]);
});

test('custom dates, dependent new dates and legacy numeric/date fields obey the same rules',()=>{
  const w=workspace([1]);w.customFields=[{id:'cf_due',name:'Due',type:'date'}];w.records[0].cf_due='2026-10-27';
  assert.equal(prepare(action(shift(2,'calendar_days','error','cf_due')),w).next.records[0].cf_due,'2026-10-29');
  const add={op:'add_field',id:'due',label:'New date',name:'New date',type:'date',options:[]};
  rejects(F.plan([add,F.select('selected'),update([shift(2,'calendar_days','error','@due')])]),w,'transform_blank');
  const p=prepare(F.plan([add,F.select('selected'),update([shift(2,'calendar_days','skip','@due')])]),w);
  assert.equal(p.next.records[0][p.addedFields[0].id],'');assert.equal(evidence(p)[0].skipped,true);
  const legacy={tableSchema:null,customFields:[],todoCards:[],records:[{id:1,account:'Legacy',value:10000,close:'2026-10-27',notes:'',history:[]}]};
  const result=prepare(action(percent(10,'error','value'),shift(2,'calendar_days','error','close')),legacy);
  assert.equal(result.next.records[0].value,11000);assert.equal(result.next.records[0].close,'2026-10-29');
  rejects(action(percent(-200,'error','value')),legacy,'transform_result_invalid');
  rejects(action(shift(2,'calendar_days','error','follow')),legacy,'transform_type_invalid');
});

test('legacy literal and append contracts still work, with dates explicitly based on today',()=>{
  const p=prepare(action({field:'f_notes',operation:'append',value:'More notes'},
    {field:'f_value',operation:'set',value:0},{field:'f_follow',operation:'set',value:{dateMode:'calendar_days',date:null,offset:2}}));
  assert(p.next.records.every(row=>row.f_value===0&&row.f_follow==='2026-10-28'&&row.f_notes==='Keep notes\nMore notes'));
  assert.match(p.calculations[0],/2026-10-26 \+ 2 calendar days = 2026-10-28/);assert.deepEqual(evidence(p),[]);
  rejects(action({field:'f_value',operation:'set',value:{percent:10,blankPolicy:'error'}}));
});

test('review calculations show actual before/after values, not model prose, including unchanged zero',()=>{
  const a=action(percent(),shift());a.title='Model replacement 999';a.steps[1].label='Model replacement 999';
  const w=workspace();w.records[0].f_deal='<script>name</script>';
  const p=prepare(a,w),html=Plan.render(p,value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'),false);
  assert.doesNotMatch(html,/Model replacement 999|<script>/);assert.match(html,/&lt;script&gt;name&lt;\/script&gt;/);
  for(const text of ['10000 + 10% = 11000','20000 + 10% = 22000','0 + 10% = 0','base date (saved): 2026-10-27','base date (saved): 2026-10-28'])assert(html.includes(text),text);
});

test('model assignments have bounded discriminated operand shapes and stable field metadata',()=>{
  const core=Core.create(F.schema),custom=[{id:'cf_due',name:'Due',type:'date'}],schema=Plan.responseSchema(core,custom);
  const items=schema.properties.steps.items.anyOf.find(step=>step.properties.op.enum[0]==='update_records').properties.assignments.items;
  assert.deepEqual(items.properties.field.anyOf[0].enum,core.definitions(custom).map(field=>field.id));
  assert.equal(items.additionalProperties,false);assert.deepEqual(items.required,['field','operation','value']);
  const [literal,numeric,date]=items.anyOf;
  assert.deepEqual(literal.properties.operation.enum,['set','append']);assert.equal(literal.properties.value.anyOf.length,2);
  assert.deepEqual(numeric.properties.operation.enum,['adjust_percent']);assert.deepEqual(numeric.properties.field.enum,['f_value']);
  assert.deepEqual(numeric.properties.value.properties.percent,{type:'number',minimum:-10000,maximum:10000});
  assert.deepEqual(numeric.properties.value.required,['percent','blankPolicy']);
  assert.deepEqual(date.properties.operation.enum,['shift_date']);
  assert.deepEqual(date.properties.value.properties.offset,{type:'integer',minimum:-366,maximum:366});
  assert.deepEqual(date.properties.value.properties.dateMode.enum,['calendar_days','business_days']);
  assert.deepEqual(date.properties.value.required,['dateMode','offset','blankPolicy']);
  assert.deepEqual(date.properties.field.anyOf.flatMap(ref=>ref.enum||[]),['f_follow','cf_due']);
  for(const branch of items.anyOf){
    assert.equal(branch.additionalProperties,false);assert.deepEqual(branch.required,['field','operation','value']);
  }
  for(const branch of [numeric,date]){
    assert.equal(branch.properties.value.additionalProperties,false);
    assert.deepEqual(branch.properties.value.properties.blankPolicy.enum,['error','skip']);
  }
  const noNumbers=Core.create({...F.schema,fields:F.schema.fields.filter(field=>field.id!=='f_value')});
  const variants=Plan.responseSchema(noNumbers).properties.steps.items.anyOf.find(step=>step.properties.op.enum[0]==='update_records').properties.assignments.items.anyOf;
  assert.equal(variants.some(branch=>branch.properties.operation.enum.includes('adjust_percent')),false);
});
