const field=(id,name,type='text',role='none',options=[])=>({id,name,type,role,options});
const schema={status:'ready',useCase:'Sales',title:'Sales pipeline',recordLabel:'deal',description:'',fields:[
  field('f_deal','Deal / Account Name','text','primary'),
  field('f_stage','Deal Stage','choice','status',['Prospecting','Qualified','Proposal Sent','Negotiation','Closed Won','Closed Lost']),
  field('f_owner','Owner','text','owner'),field('f_follow','Follow-up Date','date','followup'),
  field('f_value','Value','currency'),field('f_contact','Contact'),field('f_notes','Notes')
]};
const prompt='Add three sample deals: Northstar Design, Qualified, owner Alex, follow-up 2026-10-02, value $12,000, contact Maya Chen, note Interested in annual plan; Greenline Foods, Proposal Sent, owner Sam, follow-up 2026-09-29, value $7,500, contact Omar Patel, note Waiting on legal review; and Beacon Realty, Prospecting, owner Alex, follow-up 2026-10-05, value $20,000, contact Elena Ruiz, note Referred by an existing customer.';
const records=[
  {f_deal:'Northstar Design',f_stage:'Qualified',f_owner:'Alex',f_follow:'2026-10-02',f_value:12000,f_contact:'Maya Chen',f_notes:'Interested in annual plan'},
  {f_deal:'Greenline Foods',f_stage:'Proposal Sent',f_owner:'Sam',f_follow:'2026-09-29',f_value:7500,f_contact:'Omar Patel',f_notes:'Waiting on legal review'},
  {f_deal:'Beacon Realty',f_stage:'Prospecting',f_owner:'Alex',f_follow:'2026-10-05',f_value:20000,f_contact:'Elena Ruiz',f_notes:'Referred by an existing customer'}
];
module.exports={schema,prompt,records};
