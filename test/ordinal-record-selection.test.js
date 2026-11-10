'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Plan=require('../public/workspace-plan'),F=require('./fixtures/workspace-plans.cjs');
const Review=require('../lib/action-review'),Core=require('../public/pipeline-core'),Todo=require('../public/todo-core');
function workspace(){
  const w=F.workspace();
  w.records=[{id:40,value:20000,owner:'Sam'},{id:10,value:30000,owner:'Jo'},{id:30,value:20000,owner:'Alex'},
    {id:50,value:0,owner:'Zero'},{id:60,value:null,owner:'Unknown'},{id:70,value:90000,owner:'Outside'}]
    .map(({id,value,owner},i)=>({...w.records[0],id,f_deal:(i<5?'Cohort ':'Other ')+id,f_value:value,f_owner:owner}));
  return w;
}
const select=limit=>F.select('ranked',[[F.where('f_deal','starts_with','Cohort')]],{orderBy:'f_value',direction:'desc',limit});
const read={op:'read_records',id:'answer',label:'Ranked owner',selection:'ranked',showTable:false,
  outputs:[{kind:'names',field:null},{kind:'fields',field:'f_owner'}]};
const prepare=(w,steps,options={})=>Plan.prepare(w,F.plan(steps),{nonce:'rank',today:'2026-11-10',...options});
const ids=p=>p.queryResults[0].recordIds;

test('second highest is one result, not the top two; equal values break ties by record ID',()=>{
  const w=workspace(),before=structuredClone(w);
  assert.deepEqual(ids(prepare(w,[select(2),read])),[10,30]);
  const p=prepare(w,[select({offset:1,count:1,mode:'rows'}),read]);
  assert.deepEqual(ids(p),[30]);
  assert.deepEqual(p.queryResults[0].projected.map(c=>[c.recordId,c.value]),[[30,'Alex']]);
  assert.deepEqual(p.effects,[{kind:'table',show:false,ids:[30]}]);
  assert.deepEqual(p.review[0].ranking,{offset:1,count:1,mode:'rows',available:4});
  assert.equal(p.mutates,false);assert.deepEqual(w,before);
});

test('row offsets support first, third, ranges, ascending order, zero, and out-of-range ranks without broadening',()=>{
  const w=workspace();
  for(const [offset,count,direction,expected] of [[0,1,'desc',[10]],[2,1,'desc',[40]],[1,2,'desc',[30,40]],
    [3,1,'desc',[50]],[4,1,'desc',[]],[2000,1,'desc',[]],[1,1,'asc',[30]]]){
    const p=prepare(w,[{...select({offset,count,mode:'rows'}),direction},read]);
    assert.deepEqual(ids(p),expected);
    assert.deepEqual(p.effects[0].ids,expected);
  }
  w.records.reverse();
  assert.deepEqual(ids(prepare(w,[select({offset:1,count:1,mode:'rows'}),read])),[30]);
});

test('distinct-value windows keep all ties and never silently substitute row positions',()=>{
  const w=workspace();
  const dense=(offset,count=1)=>select({offset,count,mode:'distinct_values'});
  assert.deepEqual(ids(prepare(w,[dense(1),read])),[30,40]);
  assert.deepEqual(ids(prepare(w,[dense(0,2),read])),[10,30,40]);
  assert.deepEqual(ids(prepare(w,[dense(2),read])),[50]);
  assert.deepEqual(ids(prepare(w,[dense(3),read])),[]);
  w.records.find(r=>r.id===40).f_value=30000;
  assert.deepEqual(ids(prepare(w,[select({offset:1,count:1,mode:'rows'}),read])),[40]);
  assert.deepEqual(ids(prepare(w,[dense(1),read])),[30]);
  w.records.reverse();
  const p=prepare(w,[dense(0),read]);
  assert.deepEqual(ids(p),[10,40]);
  assert.deepEqual(p.review[0].ranking,{offset:0,count:1,mode:'distinct_values',available:3});
});

test('ranked numeric values exclude missing/invalid cells before sorting, retain negative/decimal/zero values',()=>{
  const w=workspace();w.records.forEach((r,i)=>r.f_value=[-2.5,'unknown',-1.25,0,null,999][i]);
  const p=prepare(w,[select({offset:1,count:1,mode:'rows'}),read]);
  assert.deepEqual(ids(p),[30]);
  assert.equal(p.review[0].ranking.available,3);
  assert.deepEqual(ids(prepare(w,[{...select({offset:0,count:1,mode:'rows'}),direction:'asc'},read])),[40]);
});

test('the ordinal is within the requested record/task cohort, visible set, focus, or prior selection',()=>{
  const w=workspace(),window={offset:1,count:1,mode:'rows'};
  w.todoCards=[{...Todo.create('todo_open',10),status:'To Do'},{...Todo.create('todo_closed',30),status:'Done'}];
  const noOpen={quantifier:'none',statuses:['To Do','In Progress']};
  assert.deepEqual(ids(prepare(w,[{...select(window),relatedTasks:noOpen},read])),[40]);
  for(const [source,options,expected] of [['visible',{visibleIds:[40,50,70]},[50]],
    ['focus',{focus:{kind:'table',ids:[40,30,50]}},[40]],
    ['focus',{focus:{kind:'table',ids:[]}},[]]]){
    assert.deepEqual(ids(prepare(w,[{...select(window),source},read],options)),expected);
  }
  const parent=F.select('cohort',[[F.where('f_owner','in',null,['Sam','Zero'])]]);
  assert.deepEqual(ids(prepare(w,[parent,{...select(window),source:'cohort'},read])),[50]);
});

test('only the returned ordinal becomes the follow-up mutation focus, including empty and tied results',()=>{
  const w=workspace(),before=structuredClone(w);
  for(const [window,expected] of [[{offset:1,count:1,mode:'rows'},[30]],
    [{offset:1,count:1,mode:'distinct_values'},[30,40]],[{offset:9,count:1,mode:'rows'},[]]]){
    const ranked=prepare(w,[select(window),read]),effect=ranked.effects.find(e=>e.kind==='table');
    const next=prepare(w,[F.select('selected',[],{source:'focus'}),F.update('change','selected','f_priority','High')],
      {focus:{kind:'table',ids:effect.ids},visibleIds:w.records.map(r=>r.id)});
    assert.deepEqual(next.patches.map(r=>r.id).sort((a,b)=>a-b),expected);
    assert(next.patches.every(p=>p.changes.length===1&&p.changes[0].field==='Priority'));
  }
  assert.deepEqual(w,before);
});

test('earlier proposed numeric changes do not change original ranking and malformed windows fail atomically',()=>{
  const w=workspace(),before=structuredClone(w),base=F.select('all_rows'),edit=F.update('write','all_rows','f_value',0);
  assert.deepEqual(ids(prepare(w,[base,edit,select({offset:1,count:1,mode:'rows'}),read])),[30]);
  for(const limit of [{offset:-1,count:1,mode:'rows'},{offset:0.5,count:1,mode:'rows'},{offset:2001,count:1,mode:'rows'},
    {offset:1,count:0,mode:'rows'},{offset:1,count:2001,mode:'rows'},{offset:1,count:1,mode:'all'},
    {offset:1,count:1},{offset:'1',count:1,mode:'rows'},{offset:1,count:1,mode:'rows',ids:[70]},[],0]){
    assert.throws(()=>prepare(w,[base,edit,select(limit),read]),/entire plan is unchanged/);
  }
  assert.throws(()=>prepare(w,[{...select({offset:1,count:1,mode:'rows'}),orderBy:null},read]),/explicit sort field/);
  assert.throws(()=>prepare(w,[{...select({offset:1,count:1,mode:'distinct_values'}),orderBy:'f_owner'},read]),/numeric sort field/);
  assert.deepEqual(w,before);
});

test('model schema, canonical review answer and rank evidence agree on the single selected owner',()=>{
  const pipeline={...workspace(),visibleIds:[70],currentDate:'2026-11-10'},limit={offset:1,count:1,mode:'rows'};
  const schema=Plan.responseSchema(Core.create(pipeline.tableSchema)),selection=schema.properties.steps.items.anyOf.find(s=>s.properties.op.enum.includes('select_records'));
  assert.equal(selection.properties.limit.description,Plan.rankingInstructions);
  assert.deepEqual(selection.properties.limit.anyOf[1].required,['offset','count','mode']);
  const result={crmAction:F.plan([select(limit),read])},computed=Review.evidence({pipeline},result);
  assert.deepEqual(computed.queryResults[0].recordIds,[30]);
  assert.deepEqual(computed.recordReadEvidence[0].ranking.limit,limit);
  const answer=Review.renderAnswer({pipeline},result,computed);
  assert.match(answer,/Cohort 30/);assert.match(answer,/Alex/);assert.doesNotMatch(answer,/Cohort 10|Jo|Outside/);
  const req={description:'Second highest record and owner',satisfied:true,evidenceKind:'computed_read',stepIds:['answer'],requiredOutputs:['names','fields']};
  assert(Review.validateReview({requirements:[req],issues:[]},result,{pipeline,computed}).ok);
  assert(!Review.validateReview({requirements:[{...req,requiredOutputs:['max']}],issues:[]},result,{pipeline,computed}).ok);
});
