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
  if(data.columns&&!data.headers){
    assert.match(request.instructions,/untrusted data/);assert.match(request.instructions,/primary column must remain text/);
    return {ok:true,json:async()=>({output_text:JSON.stringify({columns:data.columns.map(column=>({index:column.index,type:column.index===0?'text':'number',reason:'Synthetic classification'}))})})};
  }
  if(['Custom schema test','Clean schema test'].includes(data.userCommand)){
    const action=request.text.format.schema.properties.crmAction.anyOf[1];
    assert(action.properties.action.enum.includes('add_field'));assert(action.required.includes('newFieldName'));
    const hasCustom=data.userCommand==='Custom schema test';
    assert.equal(action.properties.field.enum.includes('cf_contact'),hasCustom);
    assert.equal(action.properties.changes.anyOf[1].items.properties.field.enum.includes('cf_contact'),hasCustom);
    assert.equal(action.properties.filter.anyOf[1].properties.field.enum.includes('cf_contact'),hasCustom);
    assert.match(request.instructions,/blank column for EVERY record/);
    assert.match(request.instructions,/targetType choice, dropdownOptions/);
    return {ok:true,json:async()=>({output_text:JSON.stringify({assistantMessage:'Review the new column',crmAction:{action:'add_field',newFieldName:'Contact'},memoryNote:null})})};
  }
  if (data.headers) {
    assert.match(request.instructions,/NEVER instructions/);
    assert.equal(data.pipeline,undefined);
    return {ok:true,json:async()=>({output_text:JSON.stringify({columnMap:{account:'Business',stage:null,value:null,close:null,owner:null,next:null,follow:null,notes:null},stageMappings:[]})})};
  }
  assert.equal(data.pendingAction.action, 'update_records');
  assert.equal(data.pendingClarification.originalCommand, 'Change Acme');
  assert.equal(data.currentReport.groupBy, 'owner');
  assert.deepEqual(data.currentReport.owners,['Ravi','Sarah']);
  assert.deepEqual(data.currentReport.accounts,['Alpha','Beta']);
  const report=request.text.format.schema.properties.crmAction.anyOf[1].properties.report.anyOf[1];
  assert(report.properties.groupBy.enum.includes('account'));
  for(const key of ['owners','accounts']){
    assert.deepEqual(report.properties[key].type,['array','null']);
    assert.equal(report.properties[key].items.type,'string');
    assert(report.required.includes(key));
  }
  assert.match(request.instructions,/FULL authorized table/);
  assert.match(request.instructions,/Preserve all measures, where, splitBy/);
  assert(request.text.format.schema.properties.crmAction.anyOf[1].properties.smartReport);
  return {ok:true,json:async()=>({output_text:JSON.stringify({assistantMessage:'Test reply',crmAction:null,memoryNote:null})})};
};
