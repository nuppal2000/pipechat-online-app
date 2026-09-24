const fs = require('node:fs/promises');
global.fetch = async (url, options) => {
  if(url !== 'https://api.openai.com/v1/responses')throw new Error('Offline test only');
  const request = JSON.parse(options.body), input = JSON.parse(request.input[0].content[0].text);
  await fs.appendFile(process.env.CONVERSATION_CAPTURE, JSON.stringify(input)+'\n');
  return {ok:true,json:async()=>({output_text:JSON.stringify({assistantMessage:'Simulated answer',crmAction:null,
    memoryNote:input.memoryUpdate?'Prefers concise replies. Earlier discussion concerned sales follow-ups.':null})})};
};
