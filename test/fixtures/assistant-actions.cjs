const sales=require('./record-additions.cjs');
const schema={...sales.schema,fields:[...sales.schema.fields,{id:'f_source',name:'Lead Source',type:'text',role:'none',options:[]}]};
const records=sales.records.map((row,i)=>({id:i+1,...row,f_source:'',history:[]}));
const dropdownPrompt='add a dropdown field called test with hot medium cold as options';
const dropdown={action:'add_field',newFieldName:'test',targetType:'choice',dropdownOptions:['hot','medium','cold']};
const todoPrompt='Create two to-do items: call Omar tomorrow about Greenline, and email Maya next Monday about Northstar. Link each task to the correct deal.';
const todos={action:'add_todos',todos:[
  {recordMatch:'Greenline',ids:null,todoStatus:'To Do',todoNextAction:'Call Omar about Greenline',todoNotes:'',todoDueDate:'2026-09-24'},
  {recordMatch:'Northstar',ids:null,todoStatus:'To Do',todoNextAction:'Email Maya about Northstar',todoNotes:'',todoDueDate:'2026-09-28'}
]};
const crmPrompt="Set Northstar Design's Lead Source to Referral. Set Greenline Foods' Lead Source to Website and move Greenline to Negotiation.";
const crm={action:'update_records',changes:[
  {recordMatch:'Northstar Design',field:'f_source',value:'Referral'},
  {recordMatch:'Greenline Foods',field:'f_source',value:'Website'},
  {recordMatch:'Greenline Foods',field:'f_stage',value:'Negotiation'}
]};
module.exports={schema,records,dropdownPrompt,dropdown,todoPrompt,todos,crmPrompt,crm};
