'use strict';
const F=require('./workspace-plans.cjs');
const rows=[
  [41,'Alpha',0,'Qualified','Alex','2026-10-09','Compliance: "audit-ready"; preserve the exact wording.'],
  [7,'Duplicate',10,'Qualified','Ravi','2026-10-10','Budget review only.'],
  [93,'Duplicate',20,'Closed Won','Ravi','2026-10-11','COMPLIANCE & approval\n<script>inert source text</script>'],
  [12,'Blank amount',null,'','','',''],
  [55,'Repeat amount',10,'Proposal Sent','Alex','2026-10-17','No matching evidence.'],
  [101,'Adjustment',-10,'Closed Lost','Sarah','2026-10-18','Archived.']
];
function workspace(){
  const w=F.workspace();
  w.records=rows.map(([id,f_deal,f_value,f_stage,f_owner,f_follow,f_notes])=>({id,f_deal,f_value,f_stage,f_owner,f_follow,f_notes,f_priority:'',f_contact:'',history:[]}));
  return w;
}
function withValues(values){
  const w=workspace(),base=w.records[0];
  w.records=values.map((value,index)=>({...structuredClone(base),id:index+1,f_deal:'Amount '+(index+1),f_value:value}));
  return w;
}
const read=(selection,outputs,showTable=false)=>({op:'read_records',id:'answer',label:'Requested evidence',selection,outputs,showTable});
const spec=(metric='count',extra={})=>({version:1,title:'Acceptance '+metric,chart:'bar',scope:'all',groupBy:'f_owner',bucket:'none',splitBy:null,where:[],
  measures:[{label:metric,metric,field:['count','percentage'].includes(metric)?null:'f_value',where:[]}],sort:'label_asc',limit:null,...extra});
const options={today:'2026-10-10',nonce:'objective_acceptance',now:Date.parse('2026-10-10T12:00:00Z')};
function freeze(value){if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
function notifications(){
  const T=require('../../public/todo-core.js'),w=workspace(),base=w.records[0];
  w.records=['2026-10-09','2026-10-10','2026-10-11','2026-10-17','2026-10-18','','2026-02-30','next week'].map((date,i)=>({...structuredClone(base),id:i+1,f_deal:'Reminder '+(i+1),f_follow:date}));
  w.records.push({...structuredClone(base),id:9,f_deal:'Closed reminder',f_stage:'Closed Won',f_follow:'2026-10-09'});
  w.todoCards=['2026-10-09','2026-10-10','2026-10-11','2026-10-17','2026-10-18',''].map((date,i)=>({...T.create('todo_'+(i+1),i+1),nextAction:'Task '+(i+1),dueDate:date,status:i===0?'In Progress':'To Do'}));
  w.todoCards.push({...T.create('todo_done',2),nextAction:'Already complete',dueDate:'2026-10-09',status:'Done'},
    {...T.create('todo_orphan',999),nextAction:'Deleted record',dueDate:'2026-10-10'},
    {...T.create('todo_standalone',null,'Office'),nextAction:'Standalone task',dueDate:'2026-10-10'});
  return w;
}
module.exports={workspace,withValues,notifications,read,spec,options,freeze,select:F.select,where:F.where,plan:F.plan};
