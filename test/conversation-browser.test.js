const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { create } = require('../public/conversation.js');
const epoch = crypto.randomUUID();
function fixture() {
  const data = { epoch, version: 0, messages: [], before: null, state: null };
  const calls = []; let fail = false, blocked = null;
  const client = create({ uuid: crypto.randomUUID, api: async (url, options) => {
    calls.push({url,options});
    if (!options) return structuredClone(data);
    if (blocked) await blocked;
    if (fail) throw new Error('Offline');
    const update = JSON.parse(options.body);
    assert.equal(update.version, data.version);
    data.messages.push(...update.messages); data.state = update.state; data.version++;
    return {epoch,version:data.version};
  }});
  return {client,data,calls,setFailure:value=>{fail=value;},block:value=>{blocked=value;}};
}
test('chat reload preserves full text and exact pending state without rewriting messages',async()=>{
  const f=fixture();await f.client.load();
  f.client.add('user','Add a contact');f.client.add('assistant','Which contact?');
  f.client.state({clarification:{question:'Which contact?',originalCommand:'Add a contact'},workspaceVersion:'v1'});
  assert(f.client.dirty);await f.client.flush();assert(!f.client.dirty);
  const loaded=await f.client.load();assert.equal(loaded.messages.length,2);assert.equal(loaded.state.clarification.question,'Which contact?');
  assert.equal(f.calls.filter(call=>call.options).length,1);
  f.client.state({clarification:null,workspaceVersion:'v1'});f.client.add('assistant','Cancelled.');await f.client.flush();
  assert.equal(f.data.state.clarification,null);f.client.stop();
});
test('failed saves retain outbox, explicit retry saves once, and stopping prevents follow-up writes',async()=>{
  const f=fixture();await f.client.load();f.client.add('user','Private message');f.setFailure(true);
  await assert.rejects(f.client.flush(),/Offline/);assert(f.client.dirty);assert.equal(f.data.messages.length,0);
  f.setFailure(false);await f.client.flush();assert.equal(f.data.messages.length,1);assert(!f.client.dirty);
  f.client.stop();f.client.add('user','Do not save');await assert.rejects(f.client.flush(),/closed/);assert.equal(f.data.messages.length,1);
});
test('new messages during a save serialize behind it without losing or duplicating messages',async()=>{
  const f=fixture();await f.client.load();let release;f.block(new Promise(resolve=>release=resolve));
  f.client.add('user','First');const pending=f.client.flush();f.client.add('assistant','Second');release();await pending;
  assert.deepEqual(f.data.messages.map(message=>message.content),['First','Second']);assert(!f.client.dirty);f.client.stop();
});
test('long Unicode replies split losslessly and bounded batches stay under server limit',async()=>{
  const f=fixture();await f.client.load();const content='\ud83d\ude80'.repeat(20000);f.client.add('assistant',content);await f.client.flush();
  assert.equal(f.data.messages.map(message=>message.content).join(''),content);
  for(const call of f.calls.filter(call=>call.options))assert(Buffer.byteLength(call.options.body)<=65536);
  f.client.stop();
});
