// Explicit opt-in; runs real app code with in-memory providers, never live credentials.
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

async function main() {
  if (!process.argv.includes('--offline')) throw new Error('Use --offline to start the disposable local QA server.');
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const env = {};
  for (const name of ['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP']) if (process.env[name]) env[name] = process.env[name];
  Object.assign(env, { PORT: String(port), PIPECHAT_HOST: '127.0.0.1', NODE_ENV: 'test',
    PIPECHAT_SESSION_COOKIE: 'pipechat_local_qa_session', PIPECHAT_LOCAL_QA: '1',
    PIPECHAT_STORAGE_PROVIDER: 'xano', XANO_API_BASE_URL: 'https://pipechat-qa.invalid/api:pipechat',
    XANO_SERVER_KEY: 'local-qa-fake-server-key-not-a-real-key', OPENAI_API_KEY: 'local-qa-fake-model-key',
    PIPECHAT_MODEL: 'offline-fixture', PIPECHAT_PUBLIC_ORIGIN: `http://127.0.0.1:${port}` });
  const child = spawn(process.execPath, ['--require', path.join(__dirname, '../test/fixtures/local-qa-provider.cjs'), path.join(__dirname, '../server.js')], {
    env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
  console.log('OFFLINE QA ONLY. In-memory records; no real Xano/OpenAI calls. Stop with Ctrl+C.');
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill());
  child.once('error', () => { console.error('Unable to start the offline QA process.'); process.exitCode = 1; });
  const [code] = await once(child, 'exit'); process.exitCode = code || 0;
}
main().catch(() => { console.error('Offline QA startup failed. Use --offline and verify a loopback port is available.'); process.exitCode = 1; });
