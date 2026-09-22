const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const net = require('node:net');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

for (const corrupted of [false, true]) {
  test(`HTTP readiness ${corrupted ? 'rejects corrupt' : 'accepts empty initialized'} JSON storage without leaking payloads`, { timeout: 15000 }, async () => {
    const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
    const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
    const temp = await fs.mkdtemp(path.join(__dirname, 'test-data-ready-'));
    if (corrupted) await fs.writeFile(path.join(temp, 'pipechat-auth.json'), 'PRIVATE_CORRUPT_CANARY');
    const child = spawn(process.execPath, [path.join(__dirname, '../server.js')], {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PORT: String(port), PIPECHAT_HOST: '127.0.0.1',
        PIPECHAT_STORAGE_PROVIDER: 'json', PIPECHAT_DATA_DIR: temp, NODE_ENV: 'test' },
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    let logs = ''; child.stdout.on('data', value => { logs += value; }); child.stderr.on('data', value => { logs += value; });
    try {
      for (let i = 0; i < 100; i++) { try { await fetch(`http://127.0.0.1:${port}/api/health`); break; } catch { await delay(50); } }
      for (const route of ['/api/ready', '/api/monitor-status']) {
        const res = await fetch(`http://127.0.0.1:${port}${route}`);
        assert.equal(res.status, corrupted ? 503 : 200);
        assert.deepEqual(await res.json(), { ok: !corrupted });
        assert.equal(res.headers.get('cache-control'), 'no-store');
        assert.equal(res.headers.get('access-control-allow-origin'), null);
        assert.match(res.headers.get('x-request-id'), /^[a-f0-9-]{36}$/);
      }
      assert(!logs.includes('PRIVATE_CORRUPT_CANARY'));
      assert.equal(logs.split('\n').filter(line => line.includes('pipechat.readiness')).length, 1);
    } finally {
      const exited = once(child, 'exit'); child.kill(); await exited;
      if (path.dirname(temp) === __dirname && path.basename(temp).startsWith('test-data-ready-')) await fs.rm(temp, { recursive: true, force: true });
    }
  });
}
