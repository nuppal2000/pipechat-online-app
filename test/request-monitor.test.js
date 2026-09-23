const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { monitorRequest, routeLabel } = require('../lib/request-monitor.js');

function fixture() {
  const res = new EventEmitter();
  res.headers = {};
  res.setHeader = (key, value) => { res.headers[key] = value; };
  res.statusCode = 200;
  return res;
}

test('request events have a closed schema and exclude credentials, bodies and URL data', () => {
  const secret = 'PRIVATE_CANARY_password_token_crm';
  const req = { method: 'POST', url: `/api/auth/login?token=${secret}`,
    headers: { cookie: secret, authorization: secret, 'x-request-id': secret, referer: secret },
    body: { password: secret }, socket: { remoteAddress: secret } };
  const res = fixture(), logs = [];
  const id = monitorRequest(req, res, line => logs.push(line));
  res.emit('finish'); res.emit('close');
  assert.equal(logs.length, 1);
  assert(!logs[0].includes(secret));
  const event = JSON.parse(logs[0]);
  assert.deepEqual(Object.keys(event).sort(), ['durationMs', 'event', 'method', 'outcome', 'requestId', 'route', 'status', 'timestamp']);
  assert.match(id, /^[a-f0-9-]{36}$/);
  assert.equal(res.headers['X-Request-Id'], id);
  assert.equal(event.requestId, id);
  assert.equal(event.route, '/api/auth/login');
  assert.equal(event.method, 'POST');
  assert.equal(event.status, 200);
  assert.equal(event.outcome, 'finished');
  assert(Number.isSafeInteger(event.durationMs) && event.durationMs >= 0);
  assert(!Number.isNaN(Date.parse(event.timestamp)));
});

test('unknown paths, malformed URLs and nonstandard methods never become log labels', () => {
  assert.equal(routeLabel('/api/password-secret?key=secret'), 'other_api');
  assert.equal(routeLabel('/customer-private-name/secret'), 'static');
  assert.equal(routeLabel('http://[malformed-secret'), 'unknown');
  const logs = [], res = fixture();
  monitorRequest({ method: 'SECRET_METHOD', url: '/secret' }, res, line => logs.push(line));
  res.emit('finish');
  assert.equal(JSON.parse(logs[0]).method, 'OTHER');
  assert(!logs[0].includes('SECRET_METHOD'));
});

test('aborted requests are recorded once and do not look like HTTP 200 successes', () => {
  const logs = [], res = fixture();
  monitorRequest({ method: 'PUT', url: '/api/crm-data' }, res, line => logs.push(line));
  res.emit('close'); res.emit('finish');
  assert.equal(logs.length, 1);
  assert.equal(JSON.parse(logs[0]).outcome, 'aborted');
  assert.equal(JSON.parse(logs[0]).status, null);
});

test('a failed log writer does not throw into the completed request', () => {
  const res = fixture();
  monitorRequest({ method: 'GET', url: '/api/health' }, res, () => { throw new Error('writer down'); });
  assert.doesNotThrow(() => res.emit('finish'));
  assert.doesNotThrow(() => res.emit('close'));
});
