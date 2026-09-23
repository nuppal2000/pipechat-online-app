const test = require('node:test');
const assert = require('node:assert/strict');
const { createSupabaseBackend, BackendError } = require('../lib/supabase-backend.js');
const { BackendError: SharedBackendError } = require('../lib/xano-backend.js');

const config = { url: 'https://pipechat-test.supabase.co', publishableKey: 'sb_publishable_offline_test_key_123456789' };
const secret = 'DO_NOT_EXPOSE_ACCESS_REFRESH_PASSWORD_SQL';
const health = { ok: true, contract: 'pipechat-supabase-v1', database: 'ok', schemaVersion: 1 };
const counters = { used: 2, limit: 10, reserved: 1, remaining: 7, paymentRequired: false, updatedAt: '2026-09-22T12:00:00.000Z' };
const user = { id: 'user-1', email: 'person@example.test', user_metadata: { name: 'Person', role: 'admin' }, app_metadata: { secret } };
const safeUser = { id: user.id, email: user.email, name: 'Person' };
const legacyRow = { id: 1, account: 'Acme', stage: '', owner: '', value: null, close: '', next: '', follow: '', notes: '', history: [], activity: '', health: '' };
const empty = { deals: [], customFields: [], tableSchema: null, updatedAt: null };
const schema = { status: 'ready', useCase: 'Recruiting', description: 'Interview workflow', title: 'Applicants', recordLabel: 'candidate', fields: [
  { id: 'cf_candidate', name: 'Candidate', type: 'text', role: 'primary', options: [] },
  { id: 'f_owner', name: 'Recruiter', type: 'text', role: 'owner', options: [] },
  { id: 'f_status', name: 'Progress', type: 'choice', role: 'status', options: ['New', 'Interview', 'Hired'] },
  { id: 'f_pay', name: 'Compensation', type: 'currency', role: 'none', options: [] },
  { id: 'f_score', name: 'Score', type: 'number', role: 'none', options: [] },
  { id: 'f_due', name: 'Follow-up', type: 'date', role: 'followup', options: [] }
] };
const customFields = [{ id: 'cf_source', name: 'Source', type: 'text' }];
const typedRows = [
  { id: 11, cf_candidate: 'Alex', f_owner: '', f_status: '', f_pay: null, f_score: 0, f_due: '', cf_source: '',
    history: ['2026-09-22 | Import: preserved blank cells.'], activity: 'Imported', health: 'Needs review' },
  { id: 12, cf_candidate: '', f_owner: 'Ravi', f_status: 'Interview', f_pay: 123.45, f_score: -2.5, f_due: '2026-09-22', cf_source: 'Referral',
    history: ['2026-09-22 | Person: changed status.'], activity: '', health: '' }
];
const ok = data => ({ data, error: null, status: 200 });
const clone = value => structuredClone(value);
const errorIs = status => error => {
  assert(error instanceof SharedBackendError);
  assert.equal(error.status, status);
  assert.doesNotMatch(error.message, /Xano|DO_NOT_EXPOSE/);
  assert(!JSON.stringify(error).includes(secret));
  assert.equal(error.cause, undefined);
  return true;
};

function response(existing) {
  const headers = new Map(existing == null ? [] : [['set-cookie', existing]]);
  return { headersSent: false, getHeader: name => headers.get(name.toLowerCase()),
    setHeader: (name, value) => headers.set(name.toLowerCase(), value) };
}

function fixture({ auth = {}, rpc, serverFactory, healthRpc, ...options } = {}) {
  const clients = [], calls = [], healthCalls = [];
  const backend = createSupabaseBackend({ ...config,
    createClient: (url, key, opts) => {
      healthCalls.push({ url, key, options: opts });
      return { rpc: async name => { healthCalls.push(name); return healthRpc ? healthRpc(name) : ok(health); } };
    },
    createServerClient: (url, key, opts) => {
      const client = serverFactory ? serverFactory(opts) : {
        auth: {
          getUser: async (...args) => { assert.equal(args.length, 0); return ok({ user }); },
          signInWithPassword: async () => ok({ session: { access_token: secret, refresh_token: secret }, user }),
          signUp: async () => ok({ session: { access_token: secret, refresh_token: secret }, user }),
          signOut: async input => { calls.push({ signOut: input }); return { error: null }; },
          getSession: () => { throw new Error('Do not trust getSession'); }, ...auth
        },
        rpc: async (name, args) => {
          calls.push({ name, args });
          if (rpc) return rpc(name, args);
          if (name === 'pipechat_read_crm') return ok(empty);
          if (name === 'pipechat_reserve_usage') return ok({ reservationId: 'reservation-1', usage: counters });
          return ok(counters);
        }
      };
      clients.push({ client, options: opts, url, key });
      return client;
    }, ...options
  });
  const request = (cookie = '', secureCookie = false, existing) => {
    const res = response(existing), req = { headers: { cookie, authorization: `Bearer ${secret}` } };
    return { adapter: backend.forRequest(req, res, { secureCookie }), req, res };
  };
  return { backend, clients, calls, healthCalls, request };
}

test('Supabase shares the existing BackendError identity', () => assert.equal(BackendError, SharedBackendError));

test('configuration accepts hosted publishable/anon keys, rejecting privileged keys and untrusted destinations', async () => {
  const jwt = role => [Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url'),
    Buffer.from(JSON.stringify({ role })).toString('base64url'), 'test_signature'].join('.');
  fixture({ publishableKey: jwt('anon') });
  for (const publishableKey of [undefined, '', secret, `sb_secret_${secret}`, jwt('service_role'), jwt('authenticated'), 'e30.e30.signature', `${config.publishableKey}\r\n${secret}`]) {
    assert.throws(() => fixture({ publishableKey }), errorIs(503));
  }
  for (const url of [undefined, `https://${secret}@demo.supabase.co`, 'http://demo.supabase.co', 'https://supabase.co',
    'https://demo.supabase.co.attacker.test', 'https://demo.supabase.co:8443', 'https://demo.supabase.co/auth/v1',
    `https://demo.supabase.co/?key=${secret}`, 'https://demo.supabase.co/#token', 'http://127.0.0.1:54321']) {
    assert.throws(() => fixture({ url }), errorIs(503));
  }
  assert.throws(() => fixture({ url: 'http://localhost:54321', allowLocalhost: true }), errorIs(503));
  fixture({ url: 'http://localhost:54321', allowLocalhost: true, fetchImpl: async () => { throw new Error('unused mock'); } });
  assert.throws(() => fixture({ createClient: () => { throw new Error(secret); } }), errorIs(503));
  await assert.rejects(fixture({ serverFactory: () => { throw new Error(secret); } }).request().adapter.getUser(), errorIs(503));
  for (const limits of [{ timeoutMs: 0 }, { timeoutMs: NaN }, { maxResponseBytes: Infinity }]) assert.throws(() => fixture(limits), errorIs(503));
});

test('health uses only a sessionless client and verifies the exact migration contract', async () => {
  const f = fixture();
  assert.equal(f.clients.length, 0);
  assert.deepEqual(f.healthCalls[0].options.auth, { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false });
  assert.deepEqual(await f.backend.check({ requireDatabase: true }), health);
  assert.equal(f.healthCalls[1], 'pipechat_health');
  assert.equal(f.clients.length, 0);
  for (const bad of [{}, { ...health, ok: false }, { ...health, contract: 'wrong' }, { ...health, schemaVersion: 2 }, { ...health, database: secret }]) {
    await assert.rejects(fixture({ healthRpc: () => ok(bad) }).backend.check({ requireDatabase: true }), errorIs(503));
  }
});

test('SSR receives chunk-aware callbacks and hardened cookies; refresh preserves existing response cookies', async () => {
  const f = fixture();
  const { res, req, adapter } = f.request('pipechat_supabase.0=old%3Dpart; pipechat_supabase.1=old-tail; csrf=abc', true, ['csrf=untouched; Path=/', 'pipechat_supabase.0=obsolete']);
  assert.equal(f.clients.length, 0, 'Construct only when an auth operation is awaited');
  assert.deepEqual(await adapter.getUser(), safeUser);
  const { cookies, cookieOptions } = f.clients[0].options;
  assert.deepEqual(cookieOptions, { name: 'pipechat_supabase', httpOnly: true, sameSite: 'lax', path: '/', secure: true });
  assert.equal(cookies.getAll().find(item => item.name === 'pipechat_supabase.0').value, 'old=part');
  cookies.setAll([
    { name: 'pipechat_supabase.0', value: 'fresh-part', options: { maxAge: 3600, httpOnly: false, secure: false, sameSite: 'none', path: '/bad', domain: 'attacker.test' } },
    { name: 'pipechat_supabase.1', value: '', options: { maxAge: 0 } }
  ], { 'Cache-Control': 'public' });
  const set = res.getHeader('Set-Cookie');
  assert.equal(set[0], 'csrf=untouched; Path=/');
  assert.equal(set.length, 3);
  assert.match(set[1], /^pipechat_supabase\.0=fresh-part;/);
  for (const value of set.slice(1)) {
    assert.match(value, /HttpOnly/); assert.match(value, /Secure/); assert.match(value, /SameSite=Lax/); assert.match(value, /Path=\//);
    assert.doesNotMatch(value, /Domain=|Path=\/bad|SameSite=None/);
  }
  assert.match(set[2], /Max-Age=0/);
  assert.deepEqual(cookies.getAll(), [{ name: 'pipechat_supabase.0', value: 'fresh-part' }, { name: 'csrf', value: 'abc' }]);
  assert.match(res.getHeader('Cache-Control'), /private.*no-store/);
  assert.equal(res.getHeader('Pragma'), 'no-cache'); assert.equal(res.getHeader('Expires'), '0');
  assert.match(req.headers.cookie, /old/);
  assert.deepEqual(await adapter.getUser(secret), safeUser);
});

test('production always requires Secure; cookie failures and malicious headers are sanitized', async () => {
  const previous = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    const f = fixture();
    await f.request('', false).adapter.getUser();
    assert.equal(f.clients[0].options.cookieOptions.secure, true);
    assert.throws(() => fixture({ url: 'http://localhost:54321', allowLocalhost: true, fetchImpl: async () => {} }), errorIs(503));
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous;
  }
  const f = fixture();
  assert.throws(() => f.request(`cookie=x\r\n${secret}`), errorIs(503));
  const { res, adapter } = f.request('', false, 'csrf=untouched');
  await adapter.getUser();
  const { cookies } = f.clients[0].options;
  assert.throws(() => cookies.setAll([{ name: 'other', value: secret }]), errorIs(503));
  cookies.setAll([{ name: 'pipechat_supabase', value: 'session', options: {} }]);
  assert.equal(res.getHeader('Set-Cookie')[0], 'csrf=untouched');
  res.headersSent = true;
  assert.throws(() => cookies.setAll([{ name: 'pipechat_supabase', value: secret, options: {} }]), errorIs(503));
});

test('one verification refresh serves concurrent operations while every request has its own client and cookies', async () => {
  let verifications = 0;
  const f = fixture({ serverFactory: options => {
    const id = options.cookies.getAll().find(cookie => cookie.name === 'identity').value;
    let verified = false;
    return { auth: { getUser: async (...args) => {
      assert.equal(args.length, 0);
      verifications++;
      await new Promise(resolve => setTimeout(resolve, 5));
      options.cookies.setAll([{ name: 'pipechat_supabase', value: `refreshed-${id}`, options: {} }]);
      verified = true;
      return ok({ user: { ...user, id } });
    } }, rpc: async name => {
      assert(verified);
      assert.equal(options.cookies.getAll().find(cookie => cookie.name === 'pipechat_supabase').value, `refreshed-${id}`);
      return ok(name === 'pipechat_read_crm' ? { ...empty, deals: [{ ...legacyRow, account: id }] } : counters);
    } };
  } });
  const a = f.request('identity=alice; pipechat_supabase=expired-a');
  const b = f.request('identity=bob; pipechat_supabase=expired-b');
  const [aUser, aCrm, aUsage, bUser, bCrm] = await Promise.all([
    a.adapter.getUser('forged'), a.adapter.readCrm('forged'), a.adapter.readUsage(), b.adapter.getUser(), b.adapter.readCrm()
  ]);
  assert.equal(verifications, 2); assert.equal(f.clients.length, 2);
  assert.notEqual(f.clients[0].client, f.clients[1].client);
  assert.equal(aUser.id, 'alice'); assert.equal(bUser.id, 'bob');
  assert.equal(aCrm.deals[0].account, 'alice'); assert.equal(bCrm.deals[0].account, 'bob');
  assert.deepEqual(aUsage, counters);
  assert.match(a.res.getHeader('Set-Cookie')[0], /refreshed-alice/);
  assert.match(b.res.getHeader('Set-Cookie')[0], /refreshed-bob/);
  assert.equal(f.healthCalls.length, 1);
});

test('authentication sends only credentials and signup name, returns verified public users without tokens', async () => {
  const seen = [];
  const f = fixture({ auth: {
    signInWithPassword: async input => { seen.push(input); return ok({ session: { access_token: secret }, user: { ...user, id: 'untrusted' } }); },
    signUp: async input => { seen.push(input); return ok({ session: { access_token: secret }, user }); }
  } });
  const { adapter } = f.request();
  assert.deepEqual(await adapter.authenticate('login', { email: user.email, password: 'test-password', user_id: 'victim', options: { role: 'admin' } }), { user: safeUser });
  assert.deepEqual(await adapter.authenticate('signup', { email: user.email, password: 'test-password', name: 'Person', role: 'admin' }), { user: safeUser });
  assert.deepEqual(seen, [
    { email: user.email, password: 'test-password' },
    { email: user.email, password: 'test-password', options: { data: { name: 'Person' } } }
  ]);
});

test('confirmation-only signup exposes no user/session and does not trust a signup user as authenticated', async () => {
  let verifications = 0;
  const f = fixture({ auth: {
    signUp: async () => ok({ session: null, user }),
    getUser: async () => { verifications++; throw new Error(secret); }
  } });
  const { adapter } = f.request();
  const result = await adapter.authenticate('signup', { email: user.email, password: 'test-password' });
  assert.equal(result.confirmationRequired, true); assert.match(result.message, /confirm/);
  assert.deepEqual(Object.keys(result).sort(), ['confirmationRequired', 'message']);
  assert.equal(await adapter.getUser(), null); assert.equal(verifications, 0);
  await assert.rejects(adapter.readCrm(), errorIs(401)); assert.equal(f.calls.length, 0);
});

test('logout uses only local scope and invalidates request verification', async () => {
  const f = fixture();
  const { adapter } = f.request();
  await adapter.getUser(); await adapter.logout(secret);
  assert.deepEqual(f.calls, [{ signOut: { scope: 'local' } }]);
  assert.equal(await adapter.getUser(), null);
  await assert.rejects(adapter.readUsage(), errorIs(401));
});

test('missing, invalid, and expired sessions cannot reach authenticated RPCs', async () => {
  for (const result of [ok({ user: null }), { data: { user: null }, error: { name: 'AuthSessionMissingError', message: secret } },
    { data: null, error: { code: 'refresh_token_not_found', status: 400, message: secret } }]) {
    const f = fixture({ auth: { getUser: async () => result } });
    const { adapter } = f.request();
    assert.equal(await adapter.getUser(secret), null);
    await assert.rejects(adapter.readCrm(secret), errorIs(401));
    await assert.rejects(adapter.reserveUsage(secret, 'request-1'), errorIs(401));
    assert.equal(f.calls.length, 0);
  }
  for (const result of [ok({}), ok({ user: { id: {}, email: user.email } }), ok({ user: { ...user, user_metadata: { name: {} } } }), {}]) {
    await assert.rejects(fixture({ auth: { getUser: async () => result } }).request().adapter.getUser(), errorIs(503));
  }
});

test('CRM read/write round-trips typed blanks, custom primary IDs, histories, field metadata and zero values', async () => {
  let stored = { deals: clone(typedRows), customFields: clone(customFields), tableSchema: clone(schema), updatedAt: 'v1' };
  const f = fixture({ rpc: (name, args) => {
    if (name === 'pipechat_read_crm') return ok({ ...clone(stored), secret, user_id: 'ignored' });
    assert.equal(name, 'pipechat_write_crm');
    assert.deepEqual(Object.keys(args).sort(), ['p_custom_fields', 'p_deals', 'p_expected_updated_at', 'p_table_schema']);
    assert.equal(args.p_expected_updated_at, 'v1');
    stored = { deals: args.p_deals, customFields: args.p_custom_fields, tableSchema: args.p_table_schema, updatedAt: 'v2' };
    return ok(clone(stored));
  } });
  const { adapter } = f.request();
  assert.deepEqual(await adapter.readCrm(secret), stored);
  const result = await adapter.writeCrm(secret, typedRows.map(row => ({ ...row, user_id: 'victim', access_token: secret })), 'v1', customFields, schema);
  assert.deepEqual(result, { deals: typedRows, customFields, tableSchema: schema, updatedAt: 'v2' });
  assert.equal(result.deals[0].f_pay, null); assert.equal(result.deals[0].f_score, 0);
  assert.equal(result.deals[1].cf_candidate, '');
  assert(!JSON.stringify(f.calls).includes(secret));
});

test('legacy blanks and custom text values remain compatible; omitted metadata is preserved', async () => {
  const f = fixture({ rpc: (name, args) => name === 'pipechat_read_crm' ? ok({ ...empty, customFields, deals: [{ ...legacyRow, cf_source: 'Referral' }] }) :
    ok({ deals: args.p_deals, customFields: args.p_custom_fields, tableSchema: args.p_table_schema, updatedAt: 'v1' }) });
  const { adapter } = f.request();
  const result = await adapter.writeCrm('ignored', [{ ...legacyRow, cf_source: 'Referral' }], null);
  assert.deepEqual(result.customFields, customFields); assert.equal(result.tableSchema, null);
  assert.equal(result.deals[0].value, null); assert.equal(result.deals[0].stage, '');
  assert.equal(result.deals[0].cf_source, 'Referral');
});

test('setup transitions require an empty table and cannot revert or silently change types', async () => {
  const f = fixture({ rpc: (name, args) => name === 'pipechat_read_crm' ? ok({ ...empty, tableSchema: { status: 'pending' } }) :
    ok({ deals: args.p_deals, customFields: args.p_custom_fields, tableSchema: args.p_table_schema, updatedAt: 'v1' }) });
  const { adapter } = f.request();
  await assert.rejects(adapter.writeCrm(null, typedRows, null, customFields, schema), errorIs(409));
  assert(!f.calls.some(call => call.name === 'pipechat_write_crm'));
  assert.deepEqual((await adapter.writeCrm(null, [], null, [], schema)).tableSchema, schema);
  for (const next of [null, { status: 'pending' }, { ...schema, fields: schema.fields.map(field => field.id === 'f_pay' ? { ...field, type: 'number' } : field) }]) {
    const current = fixture({ rpc: () => ok({ ...empty, tableSchema: schema }) });
    await assert.rejects(current.request().adapter.writeCrm(null, [], null, [], next), errorIs(409));
    assert(!current.calls.some(call => call.name === 'pipechat_write_crm'));
  }
});

test('malformed CRM responses fail closed without an empty local fallback', async () => {
  const good = { deals: typedRows, customFields, tableSchema: schema, updatedAt: 'v1' };
  for (const data of [null, {}, { ...empty, tableSchema: undefined }, { deals: [], updatedAt: null },
    { ...good, deals: [typedRows[0], typedRows[0]] }, { ...good, deals: [{ ...typedRows[0], history: [secret, {}] }] },
    { ...good, deals: [{ ...typedRows[0], f_pay: {} }] }, { ...good, deals: [{ ...typedRows[0], f_unknown: secret }] },
    { ...good, customFields: [{ id: '__proto__', name: secret, type: 'text' }] }, { ...good, updatedAt: {} },
    { ...good, tableSchema: { status: 'pending' } }]) {
    await assert.rejects(fixture({ rpc: () => ok(data) }).request().adapter.readCrm(), errorIs(503));
  }
});

test('writes reject invalid versions and malicious field definitions before any mutation', async () => {
  const f = fixture();
  const { adapter } = f.request();
  for (const version of [undefined, {}, '', secret + '\r\n']) await assert.rejects(adapter.writeCrm(null, [], version), errorIs(400));
  assert.equal(f.calls.length, 0);
  for (const deals of [[{ ...legacyRow, id: -1 }], [{ ...legacyRow, history: [{}] }], [{ ...legacyRow, cf_unknown: secret }]]) {
    await assert.rejects(adapter.writeCrm(null, deals, null, [], null), errorIs(400));
  }
  await assert.rejects(adapter.writeCrm(null, [], null, [{ id: '__proto__', name: secret, type: 'text' }], null), errorIs(400));
  assert(!f.calls.some(call => call.name === 'pipechat_write_crm'));
  assert.equal({}.polluted, undefined);
});

test('write acknowledgement must retain rows, metadata and a fresh version', async () => {
  const current = { deals: typedRows, customFields, tableSchema: schema, updatedAt: 'v1' };
  for (const change of [{ deals: [] }, { customFields: [] }, { tableSchema: { ...schema, title: 'Other' } }, { updatedAt: 'v1' }, { updatedAt: null }]) {
    const f = fixture({ rpc: name => ok(name === 'pipechat_read_crm' ? current : { ...current, updatedAt: 'v2', ...change }) });
    await assert.rejects(f.request().adapter.writeCrm(null, typedRows, 'v1', customFields, schema), errorIs(503));
  }
});

test('usage RPC arguments contain no supplied token, owner or quota; reserve and finish preserve usage', async () => {
  const f = fixture();
  const { adapter } = f.request();
  assert.deepEqual(await adapter.readUsage(secret), counters);
  assert.deepEqual(await adapter.reserveUsage(secret, 'request-1'), { reservationId: 'reservation-1', usage: counters });
  assert.deepEqual(await adapter.finishUsage(secret, 'reservation-1', 'commit'), counters);
  await adapter.finishUsage(secret, 'reservation-1', 'release');
  assert.deepEqual(f.calls, [
    { name: 'pipechat_read_usage', args: undefined },
    { name: 'pipechat_reserve_usage', args: { p_request_id: 'request-1' } },
    { name: 'pipechat_finish_usage', args: { p_reservation_id: 'reservation-1', p_outcome: 'commit' } },
    { name: 'pipechat_finish_usage', args: { p_reservation_id: 'reservation-1', p_outcome: 'release' } }
  ]);
  for (const id of ['', {}, 'x\r\n', 'x'.repeat(129), 'id; DROP TABLE users']) {
    await assert.rejects(adapter.reserveUsage(null, id), errorIs(400));
    await assert.rejects(adapter.finishUsage(null, id, 'release'), errorIs(400));
  }
  await assert.rejects(adapter.finishUsage(null, 'reservation-1', 'refund'), errorIs(400));
  assert.equal(f.calls.length, 4);
});

test('invalid usage counters and reservation responses fail closed', async () => {
  for (const data of [{}, { ...counters, used: -1 }, { ...counters, used: 1.5 }, { ...counters, remaining: 99 },
    { ...counters, paymentRequired: true }, { ...counters, updatedAt: {} }, { ...counters, reserved: Number.MAX_SAFE_INTEGER }]) {
    await assert.rejects(fixture({ rpc: () => ok(data) }).request().adapter.readUsage(), errorIs(503));
  }
  for (const data of [{ reservationId: '', usage: counters }, { reservationId: {}, usage: counters }, { reservationId: 'valid', usage: {} }]) {
    await assert.rejects(fixture({ rpc: () => ok(data) }).request().adapter.reserveUsage(null, 'request-1'), errorIs(503));
  }
  const nested = { ...counters, usage: { ...counters, updatedAt: secret } };
  assert.deepEqual(await fixture({ rpc: () => ok(nested) }).request().adapter.readUsage(), counters);
});

test('PT402 maps safe usage details but never echoes malformed SQL details', async () => {
  const quota = { used: 10, limit: 10, reserved: 0, remaining: 0, paymentRequired: true, updatedAt: counters.updatedAt };
  for (const detail of [quota, { usage: { ...quota, secret } }]) {
    const f = fixture({ rpc: () => ({ data: null, error: { code: 'PT402', message: secret, details: JSON.stringify(detail) } }) });
    await assert.rejects(f.request().adapter.reserveUsage(null, 'request-1'), error => {
      errorIs(402)(error); assert.deepEqual(error.usage, quota); return true;
    });
  }
  for (const details of [secret, JSON.stringify({ usage: secret }), JSON.stringify({ ...quota, updatedAt: secret }), 'x'.repeat(17000)]) {
    const f = fixture({ rpc: () => ({ data: null, error: { code: 'PT402', details, message: secret } }) });
    await assert.rejects(f.request().adapter.reserveUsage(null, 'request-1'), error => {
      errorIs(402)(error); assert.equal(error.usage, undefined); return true;
    });
  }
});

test('SQL/auth/network failures use static public messages and preserve expected statuses', async () => {
  for (const [code, status] of [['PT400', 400], ['PT401', 401], ['PT409', 409], ['42501', 503], ['P0001', 503], ['__proto__', 503], ['constructor', 503]]) {
    const f = fixture({ rpc: () => ({ data: null, error: { code, message: secret, details: secret, hint: secret } }) });
    await assert.rejects(f.request().adapter.readCrm(), errorIs(status));
    await assert.rejects(f.request().adapter.reserveUsage(null, 'request-1'), errorIs(status));
  }
  const failed = fixture({ rpc: () => { throw new BackendError(secret, 400); } });
  await assert.rejects(failed.request().adapter.readCrm(), error => { errorIs(503)(error); assert.match(error.message, /No local fallback/); return true; });
  const login = fixture({ auth: { signInWithPassword: async () => ({ error: { code: 'invalid_credentials', status: 400, message: secret } }) } });
  await assert.rejects(login.request().adapter.authenticate('login', { email: user.email, password: 'password' }), errorIs(401));
});

test('malicious authentication inputs are rejected before invoking auth', async () => {
  let calls = 0;
  const { adapter } = fixture({ auth: { signInWithPassword: async () => { calls++; }, signUp: async () => { calls++; } } }).request();
  for (const [mode, input] of [['unknown', {}], ['login', null], ['login', { email: {}, password: secret }],
    ['login', { email: 'a@b\r\n', password: secret }], ['signup', { email: user.email, password: 'short' }],
    ['signup', { email: user.email, password: 'password', name: { role: 'admin' } }]]) {
    await assert.rejects(adapter.authenticate(mode, input), errorIs(400));
  }
  assert.equal(calls, 0);
});

test('installed SDK health calls use the bounded fetch and expose only the contract', async () => {
  const seen = [];
  const backend = createSupabaseBackend({ ...config, fetchImpl: async (url, options) => {
    seen.push({ url: String(url), options });
    return Response.json({ ...health, access_token: secret });
  } });
  assert.deepEqual(await backend.check({ requireDatabase: true }), health);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, `${config.url}/rest/v1/rpc/pipechat_health`);
  assert.equal(seen[0].options.redirect, 'error');
  assert.equal(new Headers(seen[0].options.headers).get('apikey'), config.publishableKey);
});

function authSession(expiresAt, extraMetadata = {}) {
  const encode = data => Buffer.from(JSON.stringify(data)).toString('base64url');
  const payload = { exp: expiresAt, sub: user.id, session_id: 'session-1', role: 'authenticated' };
  return { access_token: `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.testsignature`, refresh_token: 'offline-refresh-token',
    expires_at: expiresAt, expires_in: Math.max(expiresAt - Math.floor(Date.now() / 1000), 0), token_type: 'bearer',
    user: { ...user, user_metadata: { ...user.user_metadata, ...extraMetadata } } };
}

test('installed SSR signup supports per-flow PKCE cookies, confirmation-only signup, and chunked session cookies', async () => {
  for (const confirmation of [false, true]) {
    const session = authSession(Math.floor(Date.now() / 1000) + 3600, { padding: 'x'.repeat(5000) });
    const seen = [];
    const backend = createSupabaseBackend({ ...config, fetchImpl: async (input, init) => {
      const url = new URL(input); seen.push(url.pathname);
      if (url.pathname === '/auth/v1/signup') {
        const body = JSON.parse(init.body);
        assert(body.code_challenge); assert.equal(body.code_challenge_method, 's256');
        return Response.json(confirmation ? session.user : session);
      }
      assert.equal(url.pathname, '/auth/v1/user');
      return Response.json(session.user);
    } });
    const res = response('csrf=keep; Path=/');
    const adapter = backend.forRequest({ headers: {} }, res, { secureCookie: true });
    const result = await adapter.authenticate('signup', { email: user.email, password: 'test-password', name: 'Person' });
    const cookies = res.getHeader('Set-Cookie');
    assert.equal(cookies[0], 'csrf=keep; Path=/');
    const names = cookies.slice(1).map(cookie => cookie.slice(0, cookie.indexOf('=')));
    assert(names.some(name => /^pipechat_supabase-flow-[A-Za-z0-9_-]{8,64}-code-verifier$/.test(name)));
    assert(names.includes('pipechat_supabase-flows-code-verifier'));
    assert(names.includes('pipechat_supabase-code-verifier'));
    for (const cookie of cookies.slice(1)) {
      assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/); assert.match(cookie, /SameSite=Lax/);
    }
    assert.match(res.getHeader('Cache-Control'), /no-store/);
    assert(!JSON.stringify(result).includes('access_token'));
    assert(!JSON.stringify(result).includes(session.refresh_token));
    if (confirmation) {
      assert.equal(result.confirmationRequired, true);
      assert(!names.some(name => /^pipechat_supabase(?:\.[0-9]+)?$/.test(name)));
      assert.equal(await adapter.getUser(), null);
      assert.deepEqual(seen, ['/auth/v1/signup']);
    } else {
      assert.deepEqual(result, { user: safeUser });
      assert(names.includes('pipechat_supabase.0')); assert(names.includes('pipechat_supabase.1'));
      assert.deepEqual(seen, ['/auth/v1/signup', '/auth/v1/user']);
    }
  }
});

test('installed SSR refreshes expired chunked sessions independently for concurrent requests', async () => {
  const { createChunks } = require('@supabase/ssr');
  const expired = authSession(Math.floor(Date.now() / 1000) - 3600, { padding: 'x'.repeat(5000) });
  const fresh = authSession(Math.floor(Date.now() / 1000) + 3600);
  const initialCookies = createChunks('pipechat_supabase', 'base64-' + Buffer.from(JSON.stringify(expired)).toString('base64url'));
  assert(initialCookies.length > 1);
  const cookie = initialCookies.map(({ name, value }) => `${name}=${encodeURIComponent(value)}`).join('; ');
  let refreshes = 0, verifications = 0;
  const backend = createSupabaseBackend({ ...config, fetchImpl: async (input, init) => {
    const url = new URL(input);
    if (url.pathname === '/auth/v1/token') {
      assert.equal(url.searchParams.get('grant_type'), 'refresh_token');
      assert.equal(JSON.parse(init.body).refresh_token, expired.refresh_token);
      refreshes++;
      // Model Supabase's refresh-token reuse interval for simultaneous loads.
      return Response.json(fresh);
    }
    assert.equal(new Headers(init.headers).get('Authorization'), `Bearer ${fresh.access_token}`);
    if (url.pathname === '/auth/v1/user') { verifications++; return Response.json(user); }
    if (url.pathname === '/rest/v1/rpc/pipechat_read_crm') return Response.json(empty);
    assert.equal(url.pathname, '/rest/v1/rpc/pipechat_read_usage');
    return Response.json(counters);
  } });
  const aResponse = response('csrf=a'), bResponse = response('csrf=b');
  const a = backend.forRequest({ headers: { cookie } }, aResponse);
  const b = backend.forRequest({ headers: { cookie } }, bResponse);
  const [aUser, aCrm, bUser, bUsage] = await Promise.all([a.getUser(), a.readCrm(), b.getUser(), b.readUsage()]);
  assert.deepEqual(aUser, safeUser); assert.deepEqual(bUser, safeUser);
  assert.deepEqual(aCrm, empty); assert.deepEqual(bUsage, counters);
  assert.equal(refreshes, 2); assert.equal(verifications, 2);
  for (const [res, csrf] of [[aResponse, 'csrf=a'], [bResponse, 'csrf=b']]) {
    const set = res.getHeader('Set-Cookie');
    assert.equal(set[0], csrf);
    assert(set.some(value => /^pipechat_supabase=base64-/.test(value)));
    assert(set.filter(value => /^pipechat_supabase\.[0-9]+=/.test(value)).every(value => /Max-Age=0/.test(value)));
    assert.match(res.getHeader('Cache-Control'), /no-store/);
  }
});

test('request deadlines cover stalled fetch and body reads, and honor caller cancellation', async () => {
  for (const fetchImpl of [async () => new Promise(() => {}), async () => new Response(new ReadableStream({ start() {} }))]) {
    const start = Date.now();
    const backend = createSupabaseBackend({ ...config, timeoutMs: 30, fetchImpl });
    await assert.rejects(backend.check(), errorIs(503));
    assert(Date.now() - start < 1500);
  }
  let signal;
  const backend = createSupabaseBackend({ ...config, timeoutMs: 5000, fetchImpl: async (url, options) => {
    signal = options.signal;
    return new Response(new ReadableStream({ start() {} }));
  } });
  const controller = new AbortController();
  const pending = backend.check({ signal: controller.signal });
  const timer = setTimeout(() => controller.abort(secret), 20);
  try { await assert.rejects(pending, errorIs(503)); } finally { clearTimeout(timer); }
  assert.equal(signal.aborted, true);
  controller.abort();
  await assert.rejects(backend.check({ signal: controller.signal }), errorIs(503));
});

test('response byte limits cover content-length and streamed bytes; malformed JSON is sanitized', async () => {
  for (const fetchImpl of [
    async () => new Response(secret.repeat(20), { headers: { 'Content-Length': '1000000' } }),
    async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.from(secret.repeat(20))); controller.close(); } })),
    async () => new Response(secret),
    async () => { throw new Error(secret); }
  ]) {
    const backend = createSupabaseBackend({ ...config, maxResponseBytes: 128, fetchImpl });
    await assert.rejects(backend.check(), errorIs(503));
  }
});

test('transport cannot send project credentials to another origin', async () => {
  let requests = 0;
  const backend = fixture({ fetchImpl: async () => { requests++; throw new Error(secret); },
    createClient: (url, key, options) => ({ rpc: async () => ok(await options.global.fetch('https://attacker.test/collect')) })
  }).backend;
  await assert.rejects(backend.check(), errorIs(503));
  assert.equal(requests, 0);
});
