const fs = require('node:fs/promises');
global.fetch = async (url, options) => {
  if(url !== 'https://api.openai.com/v1/responses')throw new Error('Offline test only');
  const request = JSON.parse(options.body), input = JSON.parse(typeof request.input==='string'?request.input:request.input[0].content[0].text);
  const review=request.text?.format?.name==='pipechat_action_review';
  await fs.appendFile(process.env.CONVERSATION_CAPTURE, JSON.stringify({...input,_fixtureStage:review?'review':'plan'})+'\n');
  if(review)return {ok:true,json:async()=>({output_text:JSON.stringify({requirements:[{description:'Acknowledge the earlier conversation',evidenceKind:'conversation',stepIds:['root'],satisfied:true}],issues:[],clarificationQuestion:null})})};
  return {ok:true,json:async()=>({output_text:JSON.stringify({assistantMessage:'Simulated answer',crmAction:null,
    memoryNote:input.memoryUpdate?'Prefers concise replies. Earlier discussion concerned sales follow-ups.':null})})};
};
