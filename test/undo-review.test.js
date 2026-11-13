'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const Review=require('../public/undo-review'),Journal=require('../lib/action-journal');
const Schema=require('../public/table-schema');
const field=(id,name,type='text',role='none',options=[])=>({id,name,type,role,options});
const schema=()=>({status:'ready',useCase:'Sales',description:'',title:'Sales',recordLabel:'deal',fields:[
  field('f_company','Deal / Account Name','text','primary'),field('f_owner','Assigned Rep','text','owner'),
  field('f_stage','Deal Stage','choice','status',['Qualified','Won']),field('f_value','Deal Value (USD)','currency'),
  field('f_follow','Next Follow-Up Date','date','followup'),field('f_notes','Notes')],columnOrder:['f_company','f_owner','f_stage','f_value','f_follow','f_notes']});
const bronze=()=>({id:67,f_company:'QA1113 Bronze Bikes',f_owner:'Alex',f_stage:'Qualified',f_value:2400,f_follow:'',
  f_notes:'New enquiry; confirm frame sizes.\nSend the starter price list.',cf_seats:0,health:'internal-risk-value',activity:'internal-activity-value',
  history:['created-private-history','edited-private-history','inspector-private-history']});
const workspace=()=>({updatedAt:'v1',deals:[{...bronze(),id:1,f_company:'Other record'},bronze()],todoCards:[],tableSchema:schema(),
  customFields:[{id:'cf_seats',name:'License seats',type:'number',options:[]}],workflows:[]});
function inverse(before,after){
  const entry=Journal.buildActionEntry({actionId:randomUUID(),requestId:randomUUID(),before,after});
  const proposal=Journal.planInverse(entry,after);
  assert.equal(proposal.ok,true);
  return proposal;
}
const exists=value=>({exists:true,value}),missing=()=>({exists:false});
const change=(path,before,after)=>({path,before,after});
const row=(section,label)=>section.rows.find(item=>item.label===label);
const client=s=>({records:s.deals,todoCards:s.todoCards,tableSchema:s.tableSchema,customFields:s.customFields});

test('F16: a real delete inverse restores the deleted name, field labels, zero and history count without raw JSON',()=>{
  const before=workspace(),after=structuredClone(before);after.deals=after.deals.filter(r=>r.id!==67);after.updatedAt='v2';
  const proposal=inverse(before,after),original=structuredClone({proposal,after});
  const sections=Review.sections(proposal,client(after)),record=sections.find(s=>s.kind==='record'),order=sections.find(s=>s.kind==='order');
  assert.equal(record.title,'Restore QA1113 Bronze Bikes');
  assert.deepEqual(row(record,'Deal Value (USD)'),{label:'Deal Value (USD)',before:'Not present',after:'2,400'});
  assert.equal(row(record,'License seats').after,'0');
  assert.equal(row(record,'Notes').after,before.deals[1].f_notes);
  assert.equal(row(record,'Activity history').after,'3 history entries');
  assert.equal(row(record,'Assigned Rep').after,'Alex');
  assert.equal(order.title,'Record order');assert.equal(row(order,'Record count').after,'2');
  const html=Review.render(proposal,client(after));
  for(const forbidden of ['Unnamed record','undefined','f_company','f_value','cf_seats','internal-risk-value',
    'internal-activity-value','created-private-history','workspace / records','{"','["'])assert(!html.includes(forbidden),forbidden);
  assert.match(html,/Existing records keep their relative order/);
  assert.deepEqual({proposal,after},original,'rendering must not apply, mutate or re-invert the undo');
});

test('primary naming follows the actual reordered schema, including renamed fields and custom first columns',()=>{
  const w=workspace();w.tableSchema.fields[0].name='Candidate';w.tableSchema.recordLabel='candidate';
  for(const [primary,expected] of [['f_owner','Alex'],['cf_seats','0']]){
    w.tableSchema.columnOrder=[primary,...w.tableSchema.columnOrder.filter(id=>id!==primary)];
    const proposal={changes:[change(['records','67'],missing(),exists(bronze()))]};
    assert.equal(Review.sections(proposal,client(w))[0].title,'Restore '+expected);
  }
  w.tableSchema.columnOrder=['f_company'];
  const p={changes:[change(['records','67','f_company'],exists('QA1113 Bronze Bikes'),exists('Bronze Cycle Studio'))]};
  const [section]=Review.sections(p,client(w));
  assert.equal(section.title,'Update Bronze Cycle Studio');
  assert.deepEqual(row(section,'Candidate'),{label:'Candidate',before:'QA1113 Bronze Bikes',after:'Bronze Cycle Studio'});
});

test('individual cell edits distinguish zero, null, blank, and missing without inventing values',()=>{
  const w=workspace(),p={changes:[change(['records','67','f_value'],exists(0),exists(null)),
    change(['records','67','f_follow'],exists('2026-11-16'),exists('')),change(['records','67','cf_seats'],exists(null),missing())]};
  const [section]=Review.sections(p,client(w));
  assert.deepEqual(row(section,'Deal Value (USD)'),{label:'Deal Value (USD)',before:'0',after:'Not set'});
  assert.equal(row(section,'Next Follow-Up Date').after,'Blank');
  assert.equal(row(section,'License seats').after,'Not present');
  assert.deepEqual(section.changeIndexes,[0,1,2]);
});

test('whole-record removal and equal-length history replacement have honest descriptions',()=>{
  const w=workspace();
  const p={changes:[change(['records','67'],exists(bronze()),missing())]};
  const [section]=Review.sections(p,client(w));assert.equal(section.title,'Remove QA1113 Bronze Bikes');
  assert.equal(row(section,'Activity history').after,'Not present');
  assert(section.details.some(text=>/history will be removed/.test(text)));
  const history={changes:[change(['records','67','history'],exists(['new']),exists(['old']))]};
  const [h]=Review.sections(history,client(w));
  assert.equal(row(h,'Activity history').before,'1 history entry');assert.equal(row(h,'Activity history').after,'1 history entry');
  assert(h.details.some(text=>/content.*restored/.test(text)));
  assert(!Review.render(history,client(w)).includes('>old<'));
});

test('tasks restored with a deleted record use its saved name and keep every task field readable',()=>{
  const before=workspace();before.todoCards=[{id:'todo_call',recordId:67,status:'In Progress',nextAction:'Confirm frame sizes',dueDate:'2026-11-17',notes:'Use the small sample box.'}];
  const after=structuredClone(before);after.todoCards=[];after.deals=after.deals.filter(r=>r.id!==67);after.updatedAt='v2';
  const p=inverse(before,after),sections=Review.sections(p,client(after)),task=sections.find(s=>s.kind==='task');
  assert.equal(task.title,'Restore task: Confirm frame sizes');
  assert.equal(row(task,'Linked record').after,'QA1113 Bronze Bikes');
  assert.equal(row(task,'Board status').after,'In Progress');assert.equal(row(task,'Due date').after,'2026-11-17');
  assert.equal(row(task,'Notes').after,'Use the small sample box.');
  assert.equal(sections.find(s=>s.kind==='order'&&s.title==='Task order').rows[0].after,'1');
  assert(!Review.render(p,client(after)).includes('todo_call'));
});

test('standalone removal and individual task changes do not pretend to edit CRM cells',()=>{
  const card={id:'todo_custom',recordId:null,customTitle:'Weekly report',status:'Done',nextAction:'Summarize sales',notes:'Keep notes',dueDate:''};
  const w={...client(workspace()),todoCards:[card]};
  const [removed]=Review.sections({changes:[change(['tasks',card.id],exists(card),missing())]},w);
  assert.equal(removed.title,'Remove task: Weekly report');assert.equal(row(removed,'Linked record').before,'Standalone task');
  const [updated]=Review.sections({changes:[change(['tasks',card.id,'status'],exists('Done'),exists('To Do')),
    change(['tasks',card.id,'dueDate'],exists('2026-11-13'),exists(''))]},w);
  assert.equal(updated.title,'Update task: Weekly report');assert.equal(updated.rows.length,2);assert.equal(row(updated,'Due date').after,'Blank');
});

test('schema restoration shows field definition changes and column ordering, including the primary',()=>{
  const w=workspace(),old=structuredClone(w.tableSchema),next=structuredClone(old);
  next.fields[0].name='Client';next.fields[2].options=['Warm','Qualified','Won'];
  next.fields.push(field('f_seats','Seats','number'));next.columnOrder=['f_owner','f_company','f_seats','f_stage','f_value','f_follow','f_notes'];
  const p={changes:[change(['schema','workspace','tableSchema'],exists(old),exists(next)),
    change(['schema','workspace','customFields'],exists(w.customFields),exists([]))]};
  const [section]=Review.sections(p,client(w));assert.equal(section.kind,'schema');assert.deepEqual(section.changeIndexes,[0,1]);
  assert.equal(row(section,'Client / Name').before,'Deal / Account Name');
  assert.equal(row(section,'Client / Name').after,'Client');
  assert.equal(row(section,'Seats / Type').after,'Number');
  assert.equal(row(section,'Deal Stage / Options').after,'Warm; Qualified; Won');
  assert.equal(row(section,'Primary field').after,'Assigned Rep');
  assert.match(row(section,'Column order').after,/Assigned Rep; Client; Seats/);
  assert(section.details.includes('Remove field: License seats'));
  assert(!Review.render(p,client(w)).includes('f_seats'));
});

test('workflow status, trigger, action, execution and history changes remain visible without serializing internals',()=>{
  const before={id:'wf_secret',version:1,status:'active',revision:4,createdAt:'2026-11-01',updatedAt:'2026-11-13',activatedAt:'2026-11-12',
    spec:{name:'Qualified follow-ups',trigger:{field:'f_stage',to:'Qualified'},action:{nextAction:'Send samples',due:{offset:2}}},
    executions:[{event:'secret event'}],history:[{secret:'history'}]};
  const after=structuredClone(before);after.status='paused';after.revision=3;after.spec.trigger.to='Warm';after.spec.action.due.offset=1;after.executions=[];
  const p={changes:[change(['workflows','wf_secret'],exists(before),exists(after))]};
  const [section]=Review.sections(p,client(workspace()));assert.equal(section.title,'Update workflow: Qualified follow-ups');
  assert.equal(row(section,'Status').after,'paused');assert.equal(row(section,'Spec / Trigger / To').after,'Warm');
  assert.equal(row(section,'Spec / Action / Due / Offset').after,'1');assert.equal(row(section,'Executions').after,'0 executions');
  const html=Review.render(p,client(workspace()));assert(!html.includes('wf_secret'));assert(!html.includes('secret event'));
  assert.match(html,/does not execute the workflow/);
});

test('late KPI and dropdown-option changes cannot disappear behind an unchanged list prefix',()=>{
  const w=workspace(),old=structuredClone(w.tableSchema),next=structuredClone(old);
  old.kpis=Array.from({length:12},(_,i)=>({id:'kpi_'+i,title:'Metric '+i,metric:'sum',field:'f_value',conditions:[]}));
  next.kpis=structuredClone(old.kpis);next.kpis[11].metric='average';
  old.fields[2].options=Array.from({length:20},(_,i)=>'Choice '+i);next.fields[2].options=[...old.fields[2].options];next.fields[2].options[19]='Last changed option';
  const p={changes:[change(['schema','workspace','tableSchema'],exists(old),exists(next))]};
  const [section]=Review.sections(p,client(w));
  assert.equal(row(section,'Kpis / Metric 11 / Metric').before,'sum');assert.equal(row(section,'Kpis / Metric 11 / Metric').after,'average');
  assert.match(row(section,'Deal Stage / Options').after,/Last changed option/);
  assert(!Review.render(p,client(w)).includes('kpi_11'));
});

test('large order reviews are bounded with explicit counts rather than dumping identifier arrays',()=>{
  const w=client(workspace());w.records=Array.from({length:40},(_,i)=>({...bronze(),id:i+1,f_company:'Company '+(i+1)}));
  const before=w.records.map(r=>String(r.id)),after=[...before].reverse();
  const p={changes:[change(['order','workspace','records'],exists(before),exists(after))]};
  const [section]=Review.sections(p,w);
  assert.equal(section.rows.length,11);assert(section.details.includes('30 additional position changes included.'));
  assert(section.details.includes('The relative order of existing records will change.'));
  assert.equal(row(section,'Company 40').before,'Position 40');assert.equal(row(section,'Company 40').after,'Position 1');
  assert(!Review.render(p,w).includes('["1"'));
});

test('every change is represented, including metadata-only and future configuration paths',()=>{
  const p={changes:[change(['records','67','health'],exists('risk-secret'),exists('ok-secret')),
    change(['order','workspace','tasks'],exists([]),exists([])),
    change(['future','workspace','preferences'],exists({mode:'before'}),exists({mode:'after'}))]};
  const sections=Review.sections(p,client(workspace()));
  assert.deepEqual(sections.flatMap(s=>s.changeIndexes).sort((a,b)=>a-b),[0,1,2]);
  assert(sections.find(s=>s.kind==='record').details.length>0);
  assert.equal(sections.find(s=>s.kind==='other').rows[0].after,'after');
  const html=Review.render(p,client(workspace()));assert(!html.includes('risk-secret'));assert(!html.includes('health'));
});

test('render escapes record names, labels, notes, workflow labels and task values, and supports caller icons',()=>{
  const attack='<img src=x onerror="alert(1)">',w=workspace(),r=bronze();r.f_company=attack;r.f_notes='</span><script>alert(2)</script>';w.tableSchema.fields[1].name=attack;
  const p={changes:[change(['records','67'],missing(),exists(r)),
    change(['tasks','todo_bad'],missing(),exists({id:'todo_bad',recordId:null,customTitle:attack,status:'To Do',nextAction:attack,dueDate:'',notes:attack})),
    change(['workflows','wf_bad'],missing(),exists({spec:{name:attack},status:'paused'}))]};
  const html=Review.render(p,client(w));assert(!/<(?:img|script)\b/i.test(html));assert(!html.includes('</span><script>'));
  assert.match(html,/&lt;img/);assert.match(html,/&quot;alert/);assert.match(html,/&lt;script&gt;/);
  assert.match(Review.render({changes:[change(['records','67','f_value'],exists(0),exists(1))]},client(w),undefined,name=>'<i data-icon="'+name+'"></i>'),/data-icon="ArrowRight"/);
});

test('long user text is expandable and the UMD browser API is standalone with no execution hooks',()=>{
  const fs=require('node:fs'),vm=require('node:vm'),source=fs.readFileSync(require.resolve('../public/undo-review'),'utf8'),sandbox={};
  vm.runInNewContext(source,sandbox);assert.equal(typeof sandbox.PipeChatUndoReview.render,'function');
  assert.deepEqual(Object.keys(sandbox.PipeChatUndoReview).sort(),['render','sections']);
  const text='Safe notes. '.repeat(500),p={changes:[change(['records','67','f_notes'],exists('before'),exists(text))]};
  const html=Review.render(p,client(workspace()));assert.match(html,/<details>/);assert(html.includes(text));
  assert(!html.includes('data-confirm'));assert(!html.includes('onclick='));
  assert.deepEqual(Review.sections({changes:[]},client(workspace())),[]);
  assert(Schema.validate(schema()));
});
