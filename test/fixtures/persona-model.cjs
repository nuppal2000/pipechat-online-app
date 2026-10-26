// Offline contract checks complement, but do not replace, the connected-model acceptance run.
const http=require('node:http'),assert=require('node:assert/strict');
const original=http.Server.prototype.listen;
http.Server.prototype.listen=function(...args){this.once('listening',()=>console.log('QA_LISTEN_PORT='+this.address().port));return original.apply(this,args);};
global.fetch=async(url,options)=>{
  assert.equal(url,'https://api.openai.com/v1/responses');const body=JSON.parse(options.body),review=body.text.format.name==='pipechat_action_review',input=JSON.parse(review?body.input:body.input[0].content[0].text);
  assert.match(body.instructions,/PIPECHAT PERSONA POLICY/);assert.match(body.instructions,/All writes still require/);
  assert(!body.instructions.includes('UNTRUSTED_DESCRIPTION_SENTINEL'));
  if(review)return {ok:true,json:async()=>({output_text:JSON.stringify({requirements:[{description:'General advice',evidenceKind:'conversation',stepIds:['root'],requiredOutputs:[],satisfied:true}],issues:[],clarificationQuestion:null,answerIntent:'canonical',answerSelection:null})})};
  let result;
  if(input.userCommand){
    assert.equal(input.agentContext.personaId,'recruiting');
    if(input.userCommand==='Explain why and compare approaches')assert.equal(body.model,'gpt-5.2');
    else assert.equal(body.model,'gpt-5.4-mini');
    result={assistantMessage:'Start with clear interview feedback for each search.',crmAction:null,memoryNote:null};
  }else result={title:'Executive searches',recordLabel:'search',fields:[{name:'Search',type:'text',role:'primary',options:[]},{name:'Status',type:'choice',role:'status',options:['Sourcing','Interviewing','Placed']}]};
  if(body.text.format.schema.properties.personaSelection)result.personaSelection={personaId:'recruiting',certainty:'clear',subtype:'executive search'};
  return {ok:true,json:async()=>({output_text:JSON.stringify(result)})};
};
