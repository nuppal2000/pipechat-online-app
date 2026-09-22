// Only for the opt-in, loopback-only QA launcher. All state dies with this process.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
assert.equal(process.env.PIPECHAT_LOCAL_QA, '1');
assert.equal(process.env.XANO_API_BASE_URL, 'https://pipechat-qa.invalid/api:pipechat');
assert.equal(process.env.PIPECHAT_HOST, '127.0.0.1');
assert.equal(process.env.PIPECHAT_SESSION_COOKIE, 'pipechat_local_qa_session');
const users = new Map(), tokens = new Map(), snapshots = new Map(), meters = new Map(), reservations = new Map();
const password = 'Local-QA-only-123';
const row = (id, account, owner) => ({ id, account, owner, stage: 'Discovery', value: id * 25000,
  close: '2026-11-30', next: 'Review', follow: id === 1 ? 'Today' : 'Tomorrow',
  notes: 'QA private note', history: [], activity: '', health: '' });
function addUser(email, name, limit, deals) {
  const user = { id: users.size + 1, email, name, password };
  users.set(user.id, user); snapshots.set(user.id, { deals, customFields:[], updatedAt: null });
  meters.set(user.id, { used: 0, reserved: 0, limit }); return user;
}
addUser('qa-one@example.invalid', 'QA One', 30, [row(1, 'Acme QA', 'QA One'), row(2, 'Beta QA', 'Sarah')]);
addUser('qa-two@example.invalid', 'QA Two', 30, []);
addUser('qa-cap@example.invalid', 'QA Cap', 1, [row(1, 'Cap QA', 'QA Cap')]);
addUser('qa-outage@example.invalid', 'QA Outage', 30, []);
const setupUser=addUser('qa-setup@example.invalid','QA Setup',30,[]);
snapshots.get(setupUser.id).tableSchema={status:'pending'};
addUser('qa-reports@example.invalid', 'QA Reports', 30, [
  row(1,'Alpha QA','Ravi'),row(2,'Beta QA','Sarah'),row(3,'Gamma QA','Ravi'),row(4,'Delta QA','Daniel')
]);
const usage = user => { const m = meters.get(user.id); return { ...m, remaining: Math.max(0, m.limit - m.used - m.reserved) }; };
const response = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => structuredClone(body) });
let delayNextRead = false;

global.fetch = async (url, options = {}) => {
  const address = String(url);
  if (address === 'https://api.openai.com/v1/responses') {
    const input = JSON.parse(JSON.parse(options.body).input[0].content[0].text);
    const command = input.userCommand;
    if(input.useCase){
      const recruiting=input.useCase==='Recruiting';
      return response(200,{output_text:JSON.stringify({title:recruiting?'Recruiting pipeline':'Business tracker',recordLabel:recruiting?'candidate':'record',fields:[
        {name:recruiting?'Candidate name':'Record name',type:'text',role:'primary',options:[]},
        {name:recruiting?'Recruiter':'Owner',type:'text',role:'owner',options:[]},
        {name:recruiting?'Recruiting stage':'Status',type:'choice',role:'status',options:recruiting?['Sourced','Interview','Offer','Hired']:['New','Active','Done']},
        {name:recruiting?'Expected compensation':'Budget',type:'currency',role:'none',options:[]},
        {name:'Follow-up date',type:'date',role:'followup',options:[]},
        {name:'Notes',type:'text',role:'none',options:[]}
      ]})});
    }
    if (input.headers && input.columns) {
      const mapping = require('../../public/csv-import.js').localMapping(input.headers);
      if (input.headers.includes('Business')) Object.assign(mapping.columnMap,{account:'Business',stage:'Journey',value:'Size'});
      mapping.stageMappings=[{source:'Quotation delivered',stage:'Proposal Sent'}];
      return response(200,{output_text:JSON.stringify(mapping)});
    }
    let action = null, message = 'Offline QA reply. No real model was called.';
    if (command === 'Add field called Contact') action={action:'add_field',newFieldName:'Contact'};
    if (command === 'Set Contact for Acme QA to Taylor') action={action:'update_record',recordMatch:'Acme QA',field:input.pipeline.customFields.find(field=>field.name==='Contact')?.id,value:'Taylor'};
    if (command === 'fail model') throw new Error('Synthetic model outage');
    if (command === 'Delay next workspace load') delayNextRead = true;
    if (command === 'Move Acme QA to Warm') action = { action: 'update_record', recordMatch: 'Acme QA', field: 'stage', value: 'Warm' };
    if (command === 'Add Gamma QA') action = { action: 'add_record', record: { account: 'Gamma QA', owner: 'Sarah', value: 1234 } };
    if (command === 'Assign Acme QA to Neelam') action = { action: 'clarify', question: 'Add Neelam as the owner?' };
    if (command === 'yes' && input.pendingClarification?.originalCommand === 'Assign Acme QA to Neelam') {
      assert(input.conversationHistory.some(item => item.content === 'Assign Acme QA to Neelam'));
      action = { action: 'update_record', recordMatch: 'Acme QA', field: 'owner', value: 'Neelam' };
    }
    if (command === 'Show follow-ups today') action = { action: 'filter_view', field: 'follow', operator: 'equals', value: 'Today' };
    if (command === 'Compare total value under Ravi and Sarah') action = {action:'show_report',report:{metric:'sum',field:'value',groupBy:'owner',chart:'bar',owners:['Ravi','Sarah'],accounts:null,filter:null,from:null,to:null}};
    if (command === 'Compare values for Alpha QA, Beta QA and Gamma QA') action = {action:'show_report',report:{metric:'sum',field:'value',groupBy:'account',chart:'bar',owners:null,accounts:['Alpha QA','Beta QA','Gamma QA'],filter:null,from:null,to:null}};
    if (command === 'Now compare averages') action = {action:'show_report',report:{...input.currentReport,metric:'average'}};
    if (command === 'Delete Gamma QA') action = { action: 'delete_record', recordMatch: 'Gamma QA' };
    if (command === 'Slow Acme update') {
      await new Promise(resolve => setTimeout(resolve, 8000));
      action = { action: 'update_record', recordMatch: 'Acme QA', field: 'owner', value: 'Stale AI result' };
    }
    if (input.csvImport) action = { action: 'import_mapping', columnMap: { account: 'Company', stage: 'Stage', value: 'Value', owner: 'Owner', notes: 'Notes', close: null, next: null, follow: null } };
    return response(200, { output_text: JSON.stringify({ assistantMessage: message, crmAction: action, memoryNote: null }) });
  }
  const base = 'https://pipechat-qa.invalid/api:pipechat/';
  assert(address.startsWith(base), 'Blocked non-fixture network request');
  assert.equal(options.headers['X-PipeChat-Key'], 'local-qa-fake-server-key-not-a-real-key');
  const endpoint = address.slice(base.length), body = options.body ? JSON.parse(options.body) : {};
  if (endpoint === 'pipechat/health') return response(200, { contract: 'pipechat-xano-v1',
    capabilities: ['auth', 'user-scoped-crm', 'atomic-crm-save', 'atomic-usage-reservations', 'token-revocation'] });
  if (endpoint === 'auth/signup' || endpoint === 'auth/login') {
    let user = [...users.values()].find(item => item.email === body.email);
    if (endpoint === 'auth/signup') {
      if (user) return response(409, {});
      if (!body.email.endsWith('@example.invalid')) return response(400, {});
      user = addUser(body.email, body.name, 30, []); user.password = body.password;
      snapshots.get(user.id).tableSchema={status:'pending'};
    } else if (!user || user.password !== body.password) return response(401, {});
    const token = 'local-qa-' + crypto.randomUUID(); tokens.set(token, user.id);
    return response(200, { authToken: token });
  }
  const token = options.headers.Authorization?.replace('Bearer ', '');
  const user = users.get(tokens.get(token));
  if (!user) return response(401, {});
  if (endpoint === 'auth/me') return response(200, user);
  if (endpoint === 'auth/logout') { tokens.delete(token); return response(200, { ok: true }); }
  if (endpoint === 'crm') {
    if (user.email === 'qa-outage@example.invalid') return response(503, {});
    if (options.method === 'PUT') {
      if (body.deals.some(item => item.owner === 'QA reject save')) return response(503, {});
      if (body.expectedUpdatedAt !== snapshots.get(user.id).updatedAt) return response(409, {});
      if(snapshots.get(user.id).customFields.length&&!Object.hasOwn(body,'customFields'))return response(409,{});
      const schemaCore=require('../../public/table-schema.js');
      try{schemaCore.transition(snapshots.get(user.id).tableSchema,body.tableSchema,body.deals);}catch{return response(409,{});}
      snapshots.set(user.id, { deals: body.deals, customFields:body.customFields||[], ...(body.tableSchema?{tableSchema:body.tableSchema}:{}),updatedAt: crypto.randomUUID() });
    } else if (delayNextRead && user.email === 'qa-one@example.invalid') {
      delayNextRead = false;
      await new Promise(resolve => setTimeout(resolve, 8000));
    }
    return response(200, snapshots.get(user.id));
  }
  if (endpoint === 'chat-usage') return response(200, usage(user));
  if (endpoint === 'chat-usage/reserve') {
    if (usage(user).remaining === 0) return response(402, { usage: usage(user) });
    const id = crypto.randomUUID(); reservations.set(id, { userId: user.id, state: 'reserved' });
    meters.get(user.id).reserved++;
    return response(200, { reservationId: id, usage: usage(user) });
  }
  if (endpoint === 'chat-usage/finalize') {
    const r = reservations.get(body.reservationId);
    if (r?.userId !== user.id) return response(403, {});
    if (r.state === 'reserved') {
      r.state = body.outcome; meters.get(user.id).reserved--;
      if (body.outcome === 'commit') meters.get(user.id).used++;
    }
    return response(200, usage(user));
  }
  throw new Error('Unexpected offline fixture operation');
};
