const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const net = require('node:net');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('HTTP monitoring and errors omit secrets; API no-store and origin protections remain intact', { timeout: 30000 }, async () => {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const temp = await fs.mkdtemp(path.join(__dirname, 'test-data-monitor-'));
  const child = spawn(process.execPath, ['--require', path.join(__dirname, 'mock-monitor.cjs'), path.join(__dirname, '../server.js')], {
    env: { ...process.env, PORT: String(port), PIPECHAT_STORAGE_PROVIDER: 'json', PIPECHAT_DATA_DIR: temp,
      OPENAI_API_KEY: 'PRIVATE_SERVER_KEY_CANARY', PIPECHAT_FREE_CHAT_LIMIT: '1000',
      NODE_ENV: 'test', PIPECHAT_COOKIE_SECURE: 'false', PIPECHAT_PUBLIC_ORIGIN: 'https://pipechat.test' },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const responses = [];
  async function request(route, { method = 'GET', body, cookie = '', headers = {} } = {}) {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method,
      headers: { 'Content-Type': 'application/json', Cookie: cookie, ...headers },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
    const text = await response.text();
    const result = { route, status: response.status, text, body: text && response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : null,
      headers: response.headers, id: response.headers.get('x-request-id') };
    responses.push(result);
    return result;
  }
  try {
    for (let i = 0; i < 80; i++) {
      try { await request('/api/health'); break; } catch { await delay(75); }
    }
    const page = await request('/');
    assert.equal(page.status, 200);
    assert(page.text.includes('authForm'));
    assert.equal((await request('/api/crm-data?token=PRIVATE_QUERY_CANARY', {
      headers: { Authorization: 'Bearer PRIVATE_HEADER_CANARY', 'X-Request-Id': 'PRIVATE_CLIENT_ID_CANARY' }
    })).status, 401);
    const malformed = await request('/api/auth/login', { method: 'POST', body: '{"password":"PRIVATE_JSON_CANARY"' });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.error, 'Request body must be valid JSON.');
    for (const body of ['null', '[]', '"PRIVATE_SCALAR_CANARY"']) {
      assert.equal((await request('/api/auth/login', { method: 'POST', body })).status, 400);
    }
    assert.equal((await request('/api/auth/login', { method: 'POST', body: {},
      headers: { Origin: 'https://attacker.test' } })).status, 403);
    assert.equal((await request('/api/auth/login', { method: 'POST', body: '{}',
      headers: { 'Content-Type': 'text/plain' } })).status, 415);
    const preflight = await request('/api/crm-data', { method: 'OPTIONS',
      headers: { Origin: 'https://attacker.test', 'Access-Control-Request-Method': 'PUT' } });
    assert.equal(preflight.status, 204);
    assert.equal((await request('/api/PRIVATE_PATH_CANARY')).status, 404);
    const signup = await request('/api/auth/signup', { method: 'POST',
      body: { name: 'PRIVATE_NAME_CANARY', email: 'private-email-canary@example.invalid', password: 'PRIVATE_PASSWORD_CANARY' } });
    assert.equal(signup.status, 200);
    // Keep this security regression focused on an existing legacy CRM.
    const authPath=path.join(temp,'pipechat-auth.json'),auth=JSON.parse(await fs.readFile(authPath,'utf8'));
    for(const user of auth.users)delete user.tableSetup;
    await fs.writeFile(authPath,JSON.stringify(auth));
    const cookie = signup.headers.get('set-cookie').split(';')[0];
    const saved = await request('/api/crm-data', { method: 'PUT', cookie,
      body: { deals: [{ id: 1, account: 'PRIVATE_CRM_CANARY', notes: 'PRIVATE_NOTES_CANARY' }], expectedUpdatedAt: null } });
    assert.equal(saved.status, 200);
    const provider = await request('/api/pipechat-ai', { method: 'POST', cookie, body: { userCommand: 'provider-error' } });
    assert.equal(provider.status, 502);
    assert(!provider.text.includes('PRIVATE_PROVIDER_RESPONSE_CANARY'));
    const unexpected = await request('/api/pipechat-ai', { method: 'POST', cookie, body: { userCommand: 'throw-provider-canary' } });
    assert.equal(unexpected.status, 500);
    assert.equal(unexpected.body.error, 'PipeChat could not complete the request. Please try again.');
    assert.equal((await request('/api/chat-usage', { cookie })).body.used, 0);
    for (const result of responses) {
      assert.match(result.id, /^[a-f0-9-]{36}$/);
      if (result.route.startsWith('/api/')) {
        assert.equal(result.headers.get('cache-control'), 'no-store');
        assert.equal(result.headers.get('access-control-allow-origin'), null);
      }
      assert.equal(result.headers.get('access-control-allow-credentials'), null);
      assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(result.headers.get('x-frame-options'), 'DENY');
      assert.equal(result.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(result.headers.get('content-security-policy'), "frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
      assert.equal(result.headers.get('strict-transport-security'), null);
    }
    const events = () => output.split(/\r?\n/).filter(line => line.startsWith('{')).map(line => JSON.parse(line));
    for (let i = 0; i < 40 && events().length < responses.length; i++) await delay(25);
    const logs = events();
    assert.equal(logs.length, responses.length);
    for (const result of responses) {
      const event = logs.find(entry => entry.requestId === result.id);
      assert(event);
      assert.equal(event.status, result.status);
      assert.equal(event.outcome, 'finished');
    }
    assert.equal(logs.find(entry => entry.status === 404).route, 'other_api');
    assert(!output.includes('PRIVATE_'));
    assert(!output.includes('private-email-canary'));
    assert(!output.includes(cookie.split('=')[1]));
  } finally {
    const exited = once(child, 'exit'); child.kill(); await exited;
    if (path.dirname(temp) === __dirname && path.basename(temp).startsWith('test-data-monitor-')) {
      await fs.rm(temp, { recursive: true, force: true });
    }
  }
});
