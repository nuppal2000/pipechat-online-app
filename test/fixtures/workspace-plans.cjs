const base=require('./record-additions.cjs');
const schema={...base.schema,fields:[...base.schema.fields,{id:'f_priority',name:'Priority',type:'choice',role:'none',options:['Low','Medium','High']}]};
const records=[['Summit Insurance Partners',41000,'Low',''],['Uppal Co',34000,'',''],['Already High',90000,'High',''],['Boundary',50000,'Medium','2026-10-01'],['Small',0,'Low',''],['Closed',80000,'Low','']].map(([name,value,priority,follow],i)=>({id:i+1,f_deal:name,f_value:value,f_priority:priority,f_follow:follow,f_stage:i===5?'Closed Won':'Qualified',f_owner:'Alex',f_contact:'',f_notes:'Keep notes',history:[]}));
const where=(field,operator,value=null,values=[])=>({field,operator,value,values});
const select=(id,conditions=[],extra={})=>({op:'select_records',id,label:id,source:'all',where:conditions,orderBy:null,direction:'asc',limit:null,...extra});
const update=(id,selection,field,value)=>({op:'update_records',id,label:id,selection,assignments:[{field,operation:'set',value}]});
const tasks=(id,selection,offset=2)=>({op:'add_todos',id,label:id,selection,status:'To Do',nextAction:'High-value follow-up',notes:'',dueDate:{dateMode:'business_days',date:null,offset}});
const plan=steps=>({action:'workspace_plan',version:1,title:'Complete review',goals:steps.map(s=>({description:s.label,stepIds:[s.id]})),steps});
const open=where('f_stage','not_in',null,['Closed Won','Closed Lost']);
const top=()=>plan([
  select('highest',[[open,where('f_priority','not_equals','High')],[open,where('f_priority','is_blank')]],{orderBy:'f_value',direction:'desc',limit:2}),
  select('missing_followup',[[where('f_follow','is_blank')]],{source:'highest'}),
  update('prioritize','highest','f_priority','High'),tasks('followups','missing_followup')
]);
const risk=()=>plan([
  {op:'add_field',id:'risk',label:'Add Risk Level dropdown',name:'Risk Level',type:'choice',options:['Low','Medium','High']},
  select('high',[[open,where('f_value','gte',50000)]]),update('set_high','high','@risk','High'),
  select('medium',[[open,where('f_value','gte',20000),where('f_value','lt',50000)]]),update('set_medium','medium','@risk','Medium'),
  select('low',[[open,where('f_value','lt',20000)]]),update('set_low','low','@risk','Low')
]);
const workspace=()=>({records:structuredClone(records),customFields:[],tableSchema:structuredClone(schema),todoCards:[]});
module.exports={schema,records,where,select,update,tasks,plan,top,risk,workspace};
