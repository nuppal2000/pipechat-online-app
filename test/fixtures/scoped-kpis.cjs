const c=(field,operator,value=null)=>({field,operator,value});
const cohort=c('f_name','starts_with','QA1105'),blank=c('f_follow','is_blank'),dated=c('f_follow','is_dated'),overdue=c('f_follow','before_today');
const ratio=(title,populationWhere,withinPopulationWhere,relationship='refine')=>({
  title,metric:'percentage',conditions:[],field:null,selection:{populationWhere,withinPopulationWhere,relationship}
});
const missing=ratio('Missing follow-ups',[[cohort]],[[blank]]);
const late=ratio('Overdue among dated follow-ups',[[cohort,dated]],[[overdue]]);
const median={title:'Median deal value',metric:'median',field:'f_value',conditions:[],where:[[cohort]]};
const rows=[12000,30000,0,null,8000,20000,950000].map((value,i)=>({
  id:i+1,f_name:(i<6?'QA1105':'Outside')+i,f_value:value,f_score:i,f_status:'Open',
  f_follow:['','','2000-01-01','2099-01-01','2000-06-01','2099-06-01',''][i],activity:'',health:'',history:[]
}));
module.exports={c,cohort,blank,dated,overdue,ratio,missing,late,median,rows};
