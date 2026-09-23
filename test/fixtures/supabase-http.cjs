// Offline HTTP contract fixture, not a substitute for hosted Supabase acceptance tests.
const http = require('node:http');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const originalListen = http.Server.prototype.listen;
http.Server.prototype.listen = function (...args) {
  this.once('listening', () => console.log('QA_LISTEN_PORT=' + this.address().port));
  return originalListen.apply(this, args);
};
const users = new Map(), sessions = new Map(), snapshots = new Map(), meters = new Map(), reservations = new Map();
const response = (status, body) => new Response(body === null ? null : JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
});
const error = (status, code, message, details) => response(status, { code, message, details });
const usage = id => {
  const meter = meters.get(id), remaining = Math.max(0, meter.limit - meter.used - meter.reserved);
  return { ...meter, remaining, paymentRequired: remaining === 0, updatedAt: new Date().toISOString() };
};
function sessionFor(user) {
  const id = crypto.randomUUID();
  const payload = { sub: user.id, session_id: id, aud: 'authenticated', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000) };
  const encode = data => Buffer.from(JSON.stringify(data)).toString('base64url');
  const access_token = encode({ alg: 'HS256', typ: 'JWT' }) + '.' + encode(payload) + '.testsignature';
  const session = { access_token, refresh_token: crypto.randomUUID(), token_type: 'bearer', expires_in: 3600, expires_at: payload.exp, user };
  sessions.set(access_token, session);
  return session;
}
global.fetch = async (input, options = {}) => {
  const url = new URL(String(input)), body = options.body ? JSON.parse(options.body) : {}, headers = new Headers(options.headers);
  if (url.origin === 'https://api.openai.com') {
    assert.equal(url.pathname, '/v1/responses');
    const prompt = JSON.parse(body.input[0].content[0].text);
    if (prompt.userCommand === 'fail model') throw new Error('Synthetic provider failure');
    const result = body.text.format.schema.properties.fields ? {
      title: 'Recruiting pipeline', recordLabel: 'candidate', fields: [
        { name: 'Candidate name', type: 'text', role: 'primary', options: [] },
        { name: 'Compensation', type: 'currency', role: 'none', options: [] }
      ]
    } : { assistantMessage: 'Synthetic reply', crmAction: null, memoryNote: null };
    return response(200, { output_text: JSON.stringify(result) });
  }
  assert.equal(url.origin, 'https://pipechat-test.supabase.co', 'Only synthetic Supabase traffic is permitted');
  assert.equal(headers.get('apikey'), process.env.SUPABASE_PUBLISHABLE_KEY);
  if (url.pathname === '/auth/v1/signup') {
    if (users.has(body.email)) return error(422, 'user_already_exists', 'User already registered');
    const user = { id: crypto.randomUUID(), email: body.email, role: 'authenticated', aud: 'authenticated', user_metadata: body.data || {}, created_at: new Date().toISOString() };
    users.set(body.email, { user, password: body.password });
    snapshots.set(user.id, { deals: [], customFields: [], tableSchema: { status: 'pending' }, updatedAt: null });
    meters.set(user.id, { used: 0, reserved: 0, limit: 1 });
    return response(200, body.email.startsWith('confirm-') ? user : sessionFor(user));
  }
  if (url.pathname === '/auth/v1/token') {
    if (url.searchParams.get('grant_type') === 'password') {
      const entry = users.get(body.email);
      if (!entry || entry.password !== body.password) return error(400, 'invalid_credentials', 'Invalid login credentials');
      return response(200, sessionFor(entry.user));
    }
    const previous = [...sessions.values()].find(item => item.refresh_token === body.refresh_token);
    if (!previous) return error(400, 'refresh_token_not_found', 'Invalid refresh token');
    sessions.delete(previous.access_token);
    return response(200, sessionFor(previous.user));
  }
  if (url.pathname === '/rest/v1/rpc/pipechat_health') {
    return response(200, { ok: true, contract: 'pipechat-supabase-v1', database: 'ok', schemaVersion: 1 });
  }
  const token = headers.get('Authorization')?.replace(/^Bearer /, ''), session = sessions.get(token);
  if (!session) return error(401, 'PT401', 'Session no longer valid');
  const id = session.user.id;
  if (url.pathname === '/auth/v1/user') return response(200, session.user);
  if (url.pathname === '/auth/v1/logout') {
    assert.equal(url.searchParams.get('scope'), 'local');
    sessions.delete(token);
    return response(204, null);
  }
  if (session.user.email.startsWith('outage-')) return error(500, 'XX000', 'private provider detail must not escape');
  const rpc = url.pathname.replace('/rest/v1/rpc/', '');
  if (rpc === 'pipechat_read_crm') return response(200, snapshots.get(id));
  if (rpc === 'pipechat_write_crm') {
    const current = snapshots.get(id);
    if (current.updatedAt !== body.p_expected_updated_at) return error(409, 'PT409', 'Stale save');
    const next = { deals: body.p_deals, customFields: body.p_custom_fields, tableSchema: body.p_table_schema, updatedAt: crypto.randomUUID() };
    snapshots.set(id, next);
    return response(200, next);
  }
  if (rpc === 'pipechat_read_usage') return response(200, usage(id));
  if (rpc === 'pipechat_reserve_usage') {
    if (!usage(id).remaining) return error(402, 'PT402', 'Usage limit reached', JSON.stringify({ usage: usage(id) }));
    const reservationId = crypto.randomUUID();
    reservations.set(reservationId, { userId: id, state: 'reserved' });
    meters.get(id).reserved++;
    return response(200, { reservationId, usage: usage(id) });
  }
  if (rpc === 'pipechat_finish_usage') {
    const reservation = reservations.get(body.p_reservation_id);
    if (reservation?.userId !== id) return error(409, 'PT409', 'Invalid reservation');
    if (reservation.state === 'reserved') {
      meters.get(id).reserved--;
      if (body.p_outcome === 'commit') meters.get(id).used++;
      reservation.state = body.p_outcome;
    }
    return response(200, usage(id));
  }
  throw new Error('Unexpected synthetic Supabase endpoint: ' + url.pathname);
};
