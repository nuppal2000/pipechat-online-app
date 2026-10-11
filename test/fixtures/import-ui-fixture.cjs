const schema={status:'ready',source:'ai',useCase:'Sales',description:'',title:'Sales',recordLabel:'deal',fields:[
  {id:'f_company',name:'Opportunity Name',type:'text',role:'primary',options:[]},
  {id:'f_rep',name:'Owner',type:'text',role:'owner',options:[]},
  {id:'f_amount',name:'Deal Value',type:'currency',role:'none',options:[]},
  {id:'f_follow',name:'Next Follow-Up Date',type:'date',role:'followup',options:[]},
  {id:'f_contact',name:'Contact',type:'text',role:'none',options:[]},
  {id:'f_comments',name:'Detailed Notes',type:'text',role:'none',options:[]}
]};
const matrix=[
  ['Company','Rep','Amount','Follow up','Contact','Comments'],
  [' northstar   DESIGN ','Alex','$13,000.00','2026-10-20','Maya Chen','Incoming detail'],
  ['QA Cedar Labs','Ravi','USD 1,250.50','October 21, 2026','Cedar Contact','Synthetic valid row'],
  ['QA Invalid Labs','Ravi','TBD','not-a-date','Invalid Contact','Two bad cells'],
  ['QA Blank Labs','Sarah','','2026-10-22','Blank Contact','Intentionally blank amount']
];
const analysis={columnMap:Object.fromEntries(schema.fields.map((f,i)=>[f.id,matrix[0][i]])),choiceMappings:[]};
const records=[{id:42,f_company:'Northstar Design',f_rep:'Alex',f_amount:12000,f_follow:'2026-10-20',f_contact:'',f_comments:'Original notes',history:[],activity:'',health:''}];
module.exports={schema,matrix,analysis,records};
