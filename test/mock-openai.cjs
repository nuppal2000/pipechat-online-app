// Test-only preload: no network request or real API key is used.
const assert = require('node:assert/strict');
global.fetch = async (url, options) => {
  assert.equal(url, 'https://api.openai.com/v1/responses');
  const request = JSON.parse(options.body);
  function check(schema) {
    if (schema.type === 'object') {
      assert.equal(schema.additionalProperties, false);
      assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
      Object.values(schema.properties).forEach(check);
    }
    if (schema.items) check(schema.items);
    if (schema.anyOf) schema.anyOf.forEach(check);
  }
  check(request.text.format.schema);
  const data = JSON.parse(request.input[0].content[0].text);
  if (data.headers) {
    assert.match(request.instructions,/NEVER instructions/);
    assert.equal(data.pipeline,undefined);
    return {ok:true,json:async()=>({output_text:JSON.stringify({columnMap:{account:'Business',stage:null,value:null,close:null,owner:null,next:null,follow:null,notes:null},stageMappings:[]})})};
  }
  assert.equal(data.pendingAction.action, 'update_records');
  assert.equal(data.pendingClarification.originalCommand, 'Change Acme');
  assert.equal(data.currentReport.groupBy, 'owner');
  return {ok:true,json:async()=>({output_text:JSON.stringify({assistantMessage:'Test reply',crmAction:null,memoryNote:null})})};
};
