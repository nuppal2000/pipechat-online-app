// Offline API contract fixture: no live model, data or credentials.
const http=require('node:http'),assert=require('node:assert/strict');
const original=http.Server.prototype.listen;
http.Server.prototype.listen=function(...args){this.once('listening',()=>console.log('QA_LISTEN_PORT='+this.address().port));return original.apply(this,args);};
global.fetch=async(url,options)=>{
  assert.equal(url,'https://api.openai.com/v1/responses');const request=JSON.parse(options.body),input=JSON.parse(request.input[0].content[0].text);
  assert.equal(request.text.format.strict,true);assert.equal(request.text.format.schema.additionalProperties,false);
  assert.equal(request.text.format.schema.properties.fields.items.additionalProperties,false);
  const result={title:'Recruiting pipeline',recordLabel:'candidate',fields:[{name:'Candidate name',type:'text',role:'primary',options:[]},{name:'Compensation',type:'currency',role:'none',options:[]}]};
  if(input.description==='invalid-schema-test')result.fields=[];
  return {ok:true,json:async()=>({output_text:JSON.stringify(result)})};
};
