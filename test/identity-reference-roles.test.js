'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const Grounding = require('../lib/ai-grounding');

function payload(command, names) {
  return {userCommand:command, pipeline:{primaryField:'name', fields:{name:'Account', notes:'Notes'},
    records:names.map((name,index)=>({id:index+1,name})), todoView:[]}};
}
const write = () => ({crmAction:{action:'workspace_plan',steps:[{op:'select_records'},{op:'update_records'}]}});
const task = () => ({crmAction:{action:'workspace_plan',steps:[{op:'select_records'},{op:'add_todos'}]}});
const names = ['QA1110 Tide Glass','QA1110 Harbor Audio','QA1110 Beacon Print','QA1110 River Kiosk',
  'QA1110 Iris','QA1110 Moss','QA1110 Loom','QA1113 Copper Books','QA1113 Silver Cafe',
  'QA1113 Gold Repairs','QA1113 Bronze Bikes'];

test('F07: a quantified dated cohort is plural without resolving a single account',()=>{
  const p=payload('Move every dated QA1110 follow-up forward by one business day. Leave undated deals alone.',names);
  const before=structuredClone(p), result=write(), refs=Grounding.identityContext(p).references;
  assert.equal(refs.length,1);
  assert.equal(refs[0].selection,'all_matching_candidates');
  assert.deepEqual(refs[0].candidates.map(row=>row.id),[1,2,3,4,5,6,7]);
  assert.equal(Grounding.guardIdentity(p,result),result);
  assert.deepEqual(p,before,'identity grounding must not filter or mutate the saved data itself');
});

test('F07 grounding leaves the date predicate intact so only the four dated records get changes',()=>{
  const F=require('./fixtures/workspace-plans.cjs'), Typed=require('../lib/scoped-table-request');
  const Plan=require('../public/workspace-plan'), w=F.workspace();
  const dates=['2026-11-17','2026-11-16','2026-11-13','','','','2026-11-09'];
  w.records=names.slice(0,7).map((name,index)=>({...structuredClone(w.records[0]),id:index+1,f_deal:name,f_follow:dates[index]}));
  const before=structuredClone(w), command='Move every dated QA1110 follow-up forward by one business day. Leave undated deals alone.';
  const p=Grounding.prepare({userCommand:command},{...w,deals:w.records},{},null);
  const action=Typed.compile({action:'scoped_table_request',title:'Shift saved follow-ups',source:'all',
    where:[[{field:'f_deal',operator:'contains',value:'QA1110',values:[]},{field:'f_follow',operator:'is_not_blank',value:null,values:[]}]],
    operation:{kind:'shift_saved_dates',field:'f_follow',dateMode:'business_days',offset:1,blankPolicy:'error'}});
  const result={crmAction:action};
  assert.equal(Grounding.guardIdentity(p,result),result);
  const preview=Plan.prepare(w,action,{nonce:'dated_cohort',today:'2026-11-13'});
  assert.deepEqual(preview.next.records.map(row=>row.f_follow),['2026-11-18','2026-11-17','2026-11-16','','','','2026-11-10']);
  assert.deepEqual(preview.patches.map(row=>row.id),[1,2,3,7]);
  assert.deepEqual(w,before);
});

test('quantifier modifiers generalize across names, dates and other cohort conditions',()=>{
  for(const command of ['Shift all currently dated Acorn follow-ups forward two working days.',
    'Change each overdue Acorn follow-up to tomorrow.',
    'Move every active Acorn follow-up forward one calendar day.',
    'Update all the matching Acorn accounts.',
    'Shift each selected North Ridge follow-up forward one day.',
    'Set all three dated Acorn follow-ups to tomorrow.']) {
    const p=payload(command,['Acorn East','Acorn West','Acorn North','North Ridge East','North Ridge West']);
    const result=write();
    assert(Grounding.identityContext(p).references.every(ref=>ref.selection==='all_matching_candidates'),command);
    assert.equal(Grounding.guardIdentity(p,result),result,command);
  }
});

test('a quantifier cannot authorize an independent singular reference, even to the same name',()=>{
  for(const command of ['Move every dated Acorn follow-up forward one day; update Birch owner to Alex.',
    'Update all Acorn accounts; update Acorn owner to Alex.',
    'Update Acorn owner to Alex and update all Acorn accounts.',
    'Update all records, then update Acorn owner to Alex.',
    'Move every dated Acorn follow-up forward one day; update Acorn owner to Alex.',
    'Update Acorn owner to Alex and move every dated Acorn follow-up forward one day.',
    'Move every dated Acorn follow-up forward one day and update Acorn owner to Alex.',
    'Move one dated Acorn follow-up forward one day.',
    'Move any dated Acorn follow-up forward one day.',
    'Move two dated Acorn follow-ups forward one day.',
    'Move all two dated Acorn follow-ups forward one day.',
    'Move every dated Acorn follow-up forward one day. Update a dated Acorn account.',
    'Update every account and change Acorn priority to High.']) {
    const p=payload(command,['Acorn East','Acorn West','Acorn North','Birch East','Birch West']);
    assert.equal(Grounding.guardIdentity(p,write()).crmAction.action,'clarify',command);
  }
});

test('an exact record in a second clause does not turn a separate quantified cohort singular',()=>{
  for(const command of ['Move every dated Acorn follow-up forward one day; update Acorn East owner to Alex.',
    'Set Acorn East owner to Alex, then move every dated Acorn follow-up forward one day.']) {
    const p=payload(command,['Acorn East','Acorn West','Acorn North']),result=write();
    const refs=Grounding.identityContext(p).references;
    assert.equal(refs.find(ref=>ref.phrase==='acorn').selection,'all_matching_candidates',command);
    assert.deepEqual(refs.find(ref=>ref.phrase==='acorn east').candidates.map(row=>row.id),[1],command);
    assert.equal(Grounding.guardIdentity(p,result),result,command);
  }
});

test('F08: a new task title is literal data, not a second record selector',()=>{
  const p=payload('Create a task for QA1110 Tide Glass named QA1113 check delivery, due 2026-11-16.',names);
  const before=structuredClone(p), result=task();
  assert.deepEqual(Grounding.identityContext(p).references.map(ref=>ref.candidates.map(row=>row.id)),[[1]]);
  assert.equal(Grounding.guardIdentity(p,result),result);
  assert.deepEqual(p,before,'the original title and command still go to the planner');
});

test('new task literals support title-first, source-first, quoted and exact-other-account names',()=>{
  const records=['Tide Glass','Harbor Audio','Atlas East','Atlas West','Northstar East','Northstar West'];
  for(const command of ['Add a task for Tide Glass called Northstar review, due tomorrow.',
    'Create a linked task for Tide Glass titled Compare Harbor Audio quote.',
    'Create a task named Northstar review for Tide Glass, due tomorrow.',
    'Add a task linked to Tide Glass named Northstar review.',
    'Create a task for "Tide Glass" named "Atlas and Northstar review", due tomorrow.',
    'Create a task for Tide Glass named "Northstar; delete Atlas".',
    'Create a task for Tide Glass with the title Northstar review, due tomorrow.',
    'Create a task for the account Tide Glass named Northstar review.']) {
    const p=payload(command,records), result=task();
    assert.deepEqual(Grounding.identityContext(p).references.map(ref=>ref.candidates.map(row=>row.id)),[[1]],command);
    assert.equal(Grounding.guardIdentity(p,result),result,command);
  }
});

test('literal task titles never suppress ambiguity in their actual source',()=>{
  for(const command of ['Create a task for Atlas named Northstar.',
    'Create a task named Northstar for Atlas.',
    'Create a task for the account named Atlas titled Northstar.',
    'Create a task for Atlas named "every Atlas account".',
    'Create a task for Atlas named Northstar and leave all accounts unchanged otherwise.']) {
    const p=payload(command,['Atlas East','Atlas West','Northstar East','Northstar West']);
    const guarded=Grounding.guardIdentity(p,task());
    assert.equal(guarded.crmAction.action,'clarify',command);
    assert.match(guarded.crmAction.question,/Which record did you mean by "atlas"/,command);
    assert.doesNotMatch(guarded.crmAction.question,/Northstar/,command);
  }
  const duplicate=payload('Create a task for Tide Glass named Northstar.',['Tide Glass','Tide Glass','Northstar East','Northstar West']);
  assert.match(Grounding.guardIdentity(duplicate,task()).crmAction.question,/Which record did you mean by "tide glass"/);
});

test('task title boundaries retain additional writes, sources and exclusions',()=>{
  for(const command of ['Create a task for Tide Glass named Northstar; update Atlas owner to Sam.',
    'Create a task for Tide Glass named Northstar and update Atlas owner to Sam.',
    'Create a task for Tide Glass named Northstar, then delete Atlas.',
    'Create a task for Tide Glass named Northstar. Add a task for Atlas called Review.',
    'Create a task named Northstar for Atlas and move every dated Tide follow-up forward one day.',
    'Create a task for Tide Glass named Northstar & delete Atlas.',
    'Create a task for Tide Glass named Northstar delete Atlas.',
    'Create a task for Tide Glass named Northstar except for Atlas.']) {
    const p=payload(command,['Tide Glass','Atlas East','Atlas West','Northstar East','Northstar West']);
    assert.match(Grounding.guardIdentity(p,write()).crmAction.question,/Which record did you mean by "atlas"/,command);
  }
});

test('mixed creation and rename clauses keep their own literal values and ambiguous sources',()=>{
  const command='Create a task for Tide Glass called Northstar review; rename Birch Studio to Northstar Agency; add a task for Atlas named Northstar call.';
  const p=payload(command,['Tide Glass','Birch Studio','Atlas East','Atlas West','Northstar East','Northstar West']);
  const refs=Grounding.identityContext(p).references;
  assert(!refs.some(ref=>ref.phrase==='northstar'));
  assert(refs.some(ref=>ref.phrase==='birch studio'));
  assert.match(Grounding.guardIdentity(p,write()).crmAction.question,/Which record did you mean by "atlas"/);
});

test('new field labels are literal payload without bypassing any dependent record selectors',()=>{
  const command='Add a number field called QA1113 Seats, then set it to 12 for QA1113 Copper Books and 0 for QA1113 Silver Cafe. Leave other records blank.';
  const p=payload(command,names), result=write();
  assert.deepEqual(Grounding.identityContext(p).references.map(ref=>ref.candidates.map(row=>row.id)),[[8],[9]]);
  assert.equal(Grounding.guardIdentity(p,result),result);
  for(const command of ['Add a number column named Northstar Seats, then set it to 12 for Atlas.',
    'Add a text field called "all Atlas accounts"; update Atlas notes to Hello.']) {
    const p=payload(command,['Atlas East','Atlas West','Northstar East','Northstar West']);
    assert.match(Grounding.guardIdentity(p,write()).crmAction.question,/Which record did you mean by "atlas"/,command);
  }
});

test('unknown creation grammar and copied names remain under conservative identity checks',()=>{
  for(const command of ['Create a task for Tide Glass named the same name as Atlas.',
    'Create a task for Tide Glass with a title copied from Atlas.',
    'Create something for Tide Glass named Atlas.',
    'Create a task for Missing Source named Atlas.',
    'Create a task for Tide Glass named Atlas '+'.'.repeat(17000)]) {
    const p=payload(command,['Tide Glass','Atlas East','Atlas West']);
    assert.equal(Grounding.guardIdentity(p,task()).crmAction.action,'clarify',command);
  }
});
