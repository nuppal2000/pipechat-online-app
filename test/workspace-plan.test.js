const test=require('node:test'),assert=require('node:assert/strict');
const P=require('../public/workspace-plan.js'),F=require('./fixtures/workspace-plans.cjs');
const options={today:'2026-09-25',nonce:'qa_plan'},run=(action,w=F.workspace())=>P.prepare(w,action,options);
test('top ranked open non-High cohort, conditional tasks, business date and full calculated review',()=>{
  const w=F.workspace(),before=structuredClone(w),p=run(F.top(),w);
  assert.deepEqual(w,before);assert.deepEqual(p.review[0].records.map(r=>r.name),['Boundary','Summit Insurance Partners']);
  assert.equal(p.review[0].matched,4);assert.equal(p.patches.length,2);assert.equal(p.addedCards.length,1);assert.equal(p.addedCards[0].recordId,1);assert.equal(p.addedCards[0].dueDate,'2026-09-29');assert.match(p.calculations[0],/2026-09-28, 2026-09-29/);
  assert.equal(p.next.records[1].f_priority,'');assert.equal(p.next.records[5].f_priority,'Low');assert.equal(p.next.records[0].f_notes,'Keep notes');
  const html=P.render(p,s=>String(s).replaceAll('<','&lt;'),false);for(const text of ['Boundary','Summit Insurance Partners','High-value follow-up','Confirm entire plan','Date calculations','4 matching; 2 selected'])assert(html.includes(text));
});
test('original expected two deals both get linked cards when higher deals are already High',()=>{
  const w=F.workspace();w.records[3].f_priority='High';const p=run(F.top(),w);
  assert.deepEqual(p.review[0].records.map(r=>[r.name,r.value]),[['Summit Insurance Partners',41000],['Uppal Co',34000]]);assert.equal(p.addedCards.length,2);assert.equal(p.patches.length,2);
});
test('schema addition and dependent conditional population preserve closed/null rows blank',()=>{
  const w=F.workspace();w.records.push({...w.records[0],id:7,f_deal:'Unknown value',f_value:null});const p=run(F.risk(),w),field=p.addedFields[0];
  assert.equal(field.type,'choice');assert.deepEqual(field.options,['Low','Medium','High']);assert.deepEqual(p.next.records.map(r=>r[field.id]),['Medium','Medium','High','High','Low','','']);assert.equal(w.customFields.length,0);assert.equal(p.patches.length,5);
});
test('variants support different thresholds, text/date edits, subset reuse, duplicate names, zero and ties',()=>{
  const w=F.workspace();w.records[1].f_deal=w.records[0].f_deal;w.records[1].f_value=41000;
  const p=run(F.plan([F.select('eligible',[[F.where('f_value','lte',41000)]],{orderBy:'f_value',direction:'desc',limit:3}),F.update('notes','eligible','f_notes','Review paperwork'),F.update('date','eligible','f_follow',{dateMode:'calendar_days',offset:1,date:null}),F.tasks('tasks','eligible',3)]),w);
  assert.deepEqual(p.review[0].records.map(r=>r.id),[1,2,5]);assert.equal(p.addedCards.length,3);assert(p.addedCards.every(c=>c.dueDate==='2026-09-30'));assert(p.next.records.filter(r=>[1,2,5].includes(r.id)).every(r=>r.f_follow==='2026-09-26'&&r.f_notes==='Review paperwork'));
});
test('empty conditional tasks are explicit, valid and never broadened',()=>{
  const w=F.workspace();w.records.forEach(r=>r.f_follow='2026-10-01');const p=run(F.top(),w);assert.equal(p.addedCards.length,0);assert.equal(p.patches.length,2);assert.match(P.render(p,String,false),/no matching records; no changes in this step/);
});
test('invalid later step, unknown or forward references, unsupported operations and invalid choices reject entire plan',()=>{
  for(const mutate of [a=>a.steps.push({...F.tasks('bad','highest'),status:'Unknown'}),a=>a.steps[2].assignments[0].value='banana',a=>a.steps[2].assignments[0].field='@missing',a=>a.steps[0].source='missing_followup',a=>a.steps.push({op:'run_sql',id:'unsafe',label:'Unsafe'}),a=>a.steps[3].dueDate={dateMode:'literal',date:'2026-02-30',offset:null}]){
    const w=F.workspace(),before=structuredClone(w),a=F.top();mutate(a);a.goals=a.steps.map(s=>({description:s.label,stepIds:[s.id]}));assert.throws(()=>run(a,w));assert.deepEqual(w,before);
  }
  const a=F.risk();a.goals.pop();assert.throws(()=>run(a),/not included/);const b=F.risk();b.steps[0].name='Priority';assert.throws(()=>run(b),/already exists/);
});
test('date arithmetic skips weekends across month/year boundaries and leap day without holiday assumptions',()=>{
  for(const [today,offset,date]of [['2026-09-26',2,'2026-09-29'],['2026-12-31',2,'2027-01-04'],['2028-02-28',1,'2028-02-29'],['2026-09-28',-1,'2026-09-25']])assert.equal(P.dateValue({dateMode:'business_days',date:null,offset},today).value,date);
  assert.throws(()=>P.dateValue({dateMode:'business_days',offset:1000,date:null},options.today));
});
