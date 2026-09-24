'use strict';
const weekdays=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
function dateContext(today){
  if(typeof today!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(today)||today.startsWith('0000-'))return null;
  const base=new Date(today+'T12:00:00Z');
  if(!Number.isFinite(base.getTime())||base.toISOString().slice(0,10)!==today)return null;
  const offset=days=>{const date=new Date(base);date.setUTCDate(date.getUTCDate()+days);return date.toISOString().slice(0,10);};
  const nextWeekdays=Object.fromEntries(weekdays.map((day,index)=>[day,offset((index-base.getUTCDay()+7)%7||7)]));
  if(Object.values(nextWeekdays).some(date=>!/^\d{4}-\d{2}-\d{2}$/.test(date)))return null;
  return {today,weekday:weekdays[base.getUTCDay()],tomorrow:offset(1),nextWeekdays};
}
const instructions='dateContext is a server-calculated calendar based on the current browser-local pipeline.currentDate. Use its exact dates for today, tomorrow and the next occurrence of a named weekday instead of guessing calendar arithmetic or reusing dates from older messages. nextWeekdays always means the first such weekday strictly AFTER today (if today is Monday, next Monday is seven days later). Do not add an extra day. For a different intended week, explicit dates or genuinely ambiguous timing, honor the user or clarify. If dateContext is null, ask for an explicit date rather than inventing today. Omitted task dates and notes stay blank; never invent business details.';
module.exports={dateContext,instructions};
