'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

test('workflow HTTP routes: offline authenticated draft, activation, history and explicit retries', { timeout: 30000 }, async t => {
  const child = spawn(process.execPath, ['--require', path.join(__dirname, 'fixtures/workflow-http.cjs'), 'server.js'], {
    cwd: path.join(__dirname, '..'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', PIPECHAT_HOST: '127.0.0.1', PIPECHAT_STORAGE_PROVIDER: 'supabase', OPENAI_API_KEY: '',
      SUPABASE_URL: 'https://workflow-test.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_12345678901234567890' }
  });
  t.after(async () => { if (child.exitCode === null) { const done = new Promise(resolve => child.once('exit', resolve)); child.kill(); await done; } });
  let output = '';
  const port = await new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => { output += chunk; const match = /WORKFLOW_PORT=(\d+)/.exec(output); if (match) resolve(match[1]); });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('exit', code => reject(new Error('Fixture exited ' + code + ': ' + output)));
  });
  const base = 'http://127.0.0.1:' + port;
  async function call(route, body, who = 'a', extra = {}, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(base + route, { method,
      headers: { ...(who ? { cookie: 'qa=' + who } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json', origin: base }), ...extra },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, headers: response.headers, data: await response.json() };
  }
  assert.equal((await call('/api/workflows', undefined, null)).status, 401);
  const initial = await call('/api/workflows');
  assert.equal(initial.status, 200); assert.match(initial.headers.get('cache-control'), /no-store/);
  const original = initial.data, spec = structuredClone(original.workflows[0].spec);
  spec.name = 'A new draft'; spec.scope = {type:'record_ids', recordIds:[1]}; spec.action.due = null;
  for (const scope of [{type:'record_ids',recordIds:[99]}, {type:'record_ids',recordIds:[]}, null]) {
    assert.equal((await call('/api/workflows/prepare', {action:{action:'create_workflow',spec:{...spec,scope}}, expectedUpdatedAt:original.updatedAt})).status, 400);
  }
  const prepared = await call('/api/workflows/prepare', { action: { action: 'create_workflow', spec }, expectedUpdatedAt: original.updatedAt });
  assert.equal(prepared.status, 200); assert.equal(prepared.data.operation, 'create');
  assert.equal(prepared.data.preview.scope, 'Only records: A (#1)'); assert.equal(prepared.data.preview.due, 'No due date');
  assert.deepEqual((await call('/api/workflows')).data, original, 'preparation does not write');
  assert.equal((await call('/api/workflows/confirm', { proposal: prepared.data, confirm: false })).status, 400);
  assert.equal((await call('/api/workflows/confirm', { proposal: prepared.data, confirm: true }, 'b')).status, 409);
  const tampered = structuredClone(prepared.data); tampered.action.spec.name = 'Changed after review';
  assert.equal((await call('/api/workflows/confirm', { proposal: tampered, confirm: true })).status, 409);
  const broadened = structuredClone(prepared.data); broadened.action.spec.scope = {type:'all_records'};
  assert.equal((await call('/api/workflows/confirm', {proposal:broadened,confirm:true})).status, 409);
  const saved = await call('/api/workflows/confirm', { proposal: prepared.data, confirm: true });
  assert.equal(saved.status, 200); assert.equal(saved.data.workflow.status, 'draft');
  assert.equal(saved.data.receipt.actionId, prepared.data.actionId);
  assert.deepEqual(saved.data.snapshot.workflows, saved.data.workflows);
  const replay = await call('/api/workflows/confirm', { proposal: prepared.data, confirm: true });
  assert.equal(replay.data.replayed, true); assert.deepEqual(replay.data.snapshot, saved.data.snapshot);
  assert.equal((await call('/api/workflows/prepare', { action: prepared.data.action, expectedUpdatedAt: original.updatedAt })).status, 409);
  assert.equal((await call('/api/workflows', undefined, 'b')).data.workflows.length, 1, 'owner isolation');

  const activation = await call('/api/workflows/prepare', { action: { action: 'set_workflow_activation', workflowId: saved.data.workflow.id, active: true }, expectedUpdatedAt: saved.data.updatedAt });
  assert.equal(activation.status, 200);
  const lost = await call('/api/workflows/confirm', { proposal: activation.data, confirm: true }, 'a', { 'x-test-lose-ack': '1' });
  assert.equal(lost.status, 503);
  const recovered = await call('/api/workflows/confirm', { proposal: activation.data, confirm: true });
  assert.equal(recovered.status, 200); assert.equal(recovered.data.replayed, true); assert.equal(recovered.data.workflow.status, 'active');
  const history = await call('/api/workflows/history?workflowId=' + saved.data.workflow.id + '&limit=50');
  assert.equal(history.status, 200); assert.equal(history.data.history[0].type, 'activated');
  assert.equal((await call('/api/workflows/history?workflowId=workflow_absent')).status, 404);
  assert.equal((await call('/api/workflows/history?workflowId=workflow_failed&limit=no')).status, 400);
  assert.equal((await call('/api/workflows/history?workflowId=workflow_failed&limit=201')).status, 400);
  const retry = await call('/api/workflows/retry', { workflowId: 'workflow_failed', eventId: 'failed_event', expectedUpdatedAt: recovered.data.updatedAt });
  assert.equal(retry.status, 200); assert.equal(retry.data.operation, 'retry');
  assert.equal((await call('/api/workflows')).data.workflows[0].executions[0].status, 'failed');
  const retried = await call('/api/workflows/confirm', { proposal: retry.data, confirm: true });
  assert.equal(retried.status, 200); assert.equal(retried.data.execution.status, 'succeeded'); assert.equal(retried.data.snapshot.todoCards.length, 1);
  assert.equal((await call('/api/workflows/retry', { workflowId: 'workflow_failed', eventId: 'failed_event', expectedUpdatedAt: retried.data.updatedAt })).status, 409);
  assert.equal((await call('/api/workflows/unknown')).status, 404);
  assert.equal((await call('/api/workflows/prepare', {}, 'a', { origin: 'https://attacker.test' })).status, 403);
  const current = (await call('/api/crm-data')).data;
  const schemaChanges = [{ kind: 'rename_choice_option', fieldId: 'stage', from: 'Won', to: 'Customer' }];
  const changed = structuredClone(current);
  changed.tableSchema.fields.find(f => f.id === 'stage').options = changed.tableSchema.fields.find(f => f.id === 'stage').options.map(o => o === 'Won' ? 'Customer' : o);
  changed.deals.forEach(r => { if (r.stage === 'Won') r.stage = 'Customer'; });
  const crmBody = { deals: changed.deals, tableSchema: changed.tableSchema, customFields: changed.customFields,
    todoCards: changed.todoCards, expectedUpdatedAt: current.updatedAt, schemaChanges };
  const remap = await call('/api/crm-data', crmBody, 'a', {}, 'PUT');
  assert.equal(remap.status, 200); assert.deepEqual(remap.data.receivedMetadata.schemaChanges, schemaChanges);
  for (const patch of [{ schemaChanges: [{ ...schemaChanges[0], field: 'Stage' }] }, { schemaChanges: null },
    { actionMetadata: { schemaChanges } }, { actionMetadata: { ownerId: 'forged' } }]) {
    assert.equal((await call('/api/crm-data', { ...crmBody, ...patch }, 'a', {}, 'PUT')).status, 400);
  }
});
