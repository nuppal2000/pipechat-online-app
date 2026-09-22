const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const readline = require('node:readline/promises');
const { BASE, identities } = require('./xano-browser-qa-guard.cjs');

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== '--live-qa') throw new Error('Explicit --live-qa required.');
  if (process.env.XANO_API_BASE_URL !== BASE || !process.env.XANO_SERVER_KEY ||
      process.env.XANO_SERVER_KEY.trim().length < 32 || /[\r\n]/.test(process.env.XANO_SERVER_KEY)) {
    throw new Error('Private Xano configuration is missing or invalid.');
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log('REAL XANO QA: two NEW synthetic accounts only. Real CRM and usage writes; simulated AI, no OpenAI calls.');
  console.log('Pending readiness is acknowledged only in this localhost test. Production/Xano health stay unchanged.');
  console.log('Signups happen only when you submit the browser forms. QA records remain. No customer access.');
  if ((await rl.question('Type TEST to start (anything else cancels): ')).trim() !== 'TEST') { rl.close(); return; }
  const runId = crypto.randomUUID();
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const root = path.resolve(__dirname, '..');
  const artifactDir = path.resolve(root, '../work', `xano-browser-qa-${runId}`);
  const env = {};
  for (const name of ['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP']) if (process.env[name]) env[name] = process.env[name];
  Object.assign(env, { NODE_ENV: 'test', PORT: String(port), PIPECHAT_HOST: '127.0.0.1',
    PIPECHAT_LIVE_BROWSER_QA: '1', PIPECHAT_QA_RUN_ID: runId, PIPECHAT_QA_ARTIFACT_DIR: artifactDir,
    PIPECHAT_SESSION_COOKIE: `pipechat_qa_${runId}`, PIPECHAT_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
    PIPECHAT_STORAGE_PROVIDER: 'xano', XANO_API_BASE_URL: BASE, XANO_SERVER_KEY: process.env.XANO_SERVER_KEY,
    OPENAI_API_KEY: 'qa-simulation-not-a-real-key', PIPECHAT_MODEL: 'qa-simulated-model' });
  const child = spawn(process.execPath, ['-e', "require('./scripts/xano-browser-qa-guard.cjs').install(); require('./server.js');"],
    { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
  console.log(`QA URL: http://127.0.0.1:${port}/`);
  for (const account of identities(runId)) console.log(`QA ${account.label.toUpperCase()} email: ${account.email}`);
  console.log('Use Create an account in the browser. Enter a unique temporary password privately; do not share it in chat.');
  console.log('Terminal commands: usage a/b, backup a/b, restore a/b, outage on/off, stop.');
  console.log('Backup/restore is restricted to this run\'s QA CRM rows. It does not restore users, passwords, schema or counters.');
  rl.on('line', line => { if (child.connected) child.send({ command: line.trim() }); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { if (child.connected) child.send({ command: 'stop' }); });
  child.once('error', () => { console.error('FAIL: QA process could not start.'); });
  const [code] = await once(child, 'exit'); rl.close(); process.exitCode = code || 0;
}
main().catch(() => { console.error('FAIL: QA startup stopped. Check --live-qa and private environment settings. No credentials printed.'); process.exitCode = 1; });
