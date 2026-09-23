const { randomUUID, createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { BASE, identities } = require('./supabase-browser-qa-guard.cjs');

const RUN_ID = '60abf0b7-1d6c-402b-8297-dbce9727580b';
const ACCOUNTS = identities(RUN_ID);
const RPCS = ['pipechat_read_crm', 'pipechat_write_crm', 'pipechat_read_usage', 'pipechat_reserve_usage', 'pipechat_finish_usage'];
class CheckFailure extends Error {}
function check(value, message) { if (!value) throw new CheckFailure(message); }
async function together(tasks) {
  const results = await Promise.allSettled(tasks);
  const failed = results.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  return results.map(result => result.value);
}
function expectStatus(result, status, label) {
  check(result?.status === status, `${label}: expected HTTP ${status}, received ${Number.isInteger(result?.status) ? result.status : 'no response'}.`);
  return result.data;
}
function content(snapshot) {
  return { deals: snapshot.deals, customFields: snapshot.customFields, tableSchema: snapshot.tableSchema };
}
function fingerprint(snapshot) {
  function sorted(value) {
    if (Array.isArray(value)) return value.map(sorted);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]));
    return value;
  }
  return createHash('sha256').update(JSON.stringify(sorted(content(snapshot)))).digest('hex');
}
function writeArgs(snapshot, version) {
  return { p_deals: snapshot.deals, p_custom_fields: snapshot.customFields, p_table_schema: snapshot.tableSchema, p_expected_updated_at: version };
}
function validateInput(input) {
  check(input?.authorization === 'TEST' && input.runId === RUN_ID, 'Explicit approval and the fixed QA run ID are required.');
  check(/^sb_publishable_[A-Za-z0-9_-]{16,}$/.test(input.publishableKey || ''), 'A publishable key is required; privileged keys are refused.');
  for (const label of ['a', 'b']) check(typeof input[label] === 'string' && input[label].length >= 1 && input[label].length <= 4096 && !input[label].includes('\0'), 'Both private QA passwords are required.');
  return input;
}

function makeTransport(key, fetchImpl = fetch) {
  check(/^sb_publishable_[A-Za-z0-9_-]{16,}$/.test(key || ''), 'Publishable key required.');
  return async (route, { method = 'POST', body, token, profile } = {}) => {
    const allowed = ['/auth/v1/token?grant_type=password', '/auth/v1/token?grant_type=refresh_token', '/auth/v1/logout?scope=local', '/auth/v1/user',
      '/rest/v1/crm_records?select=record_id&limit=1', ...['pipechat_health', ...RPCS].map(name => `/rest/v1/rpc/${name}`)];
    check(allowed.includes(route) && ['GET', 'POST'].includes(method), 'QA transport destination refused.');
    const headers = { apikey: key, 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (profile) { check(profile === 'pipechat', 'Unexpected schema probe refused.'); headers['Accept-Profile'] = profile; }
    try {
      const response = await fetchImpl(BASE + route, { method, headers, redirect: 'error', signal: AbortSignal.timeout(20000),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const reader = response.body?.getReader(), chunks = []; let size = 0;
      if (reader) try {
        while (true) {
          const part = await reader.read(); if (part.done) break;
          size += part.value.byteLength;
          if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error(); }
          chunks.push(Buffer.from(part.value));
        }
      } finally { reader.releaseLock(); }
      let data = null;
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* Some Auth responses have no body. */ }
      return { status: response.status, data };
    } catch { throw new CheckFailure('QA network request failed or timed out; no provider payload or credentials printed.'); }
  };
}

async function login(transport, label, password) {
  const account = ACCOUNTS.find(item => item.label === label);
  check(account, 'Only the fixed QA accounts are permitted.');
  let session = expectStatus(await transport('/auth/v1/token?grant_type=password', { body: { email: account.email, password } }), 200, 'QA sign-in');
  check(session?.user?.email === account.email && /^[0-9a-f-]{36}$/.test(session.user.id || '') && typeof session.access_token === 'string' && typeof session.refresh_token === 'string', 'QA identity verification failed.');
  const id = session.user.id;
  return {
    id,
    rpc(name, body = {}) { check(RPCS.includes(name), 'Unexpected QA RPC.'); return transport(`/rest/v1/rpc/${name}`, { body, token: session.access_token }); },
    privateTable() { return transport('/rest/v1/crm_records?select=record_id&limit=1', { method: 'GET', profile: 'pipechat', token: session.access_token }); },
    forgedUser(otherId) {
      const parts = session.access_token.split('.');
      check(parts.length === 3, 'Unexpected QA token format.');
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
      parts[1] = Buffer.from(JSON.stringify({ ...claims, sub: otherId })).toString('base64url');
      return transport('/rest/v1/rpc/pipechat_read_crm', { body: {}, token: parts.join('.') });
    },
    async refresh() {
      const next = expectStatus(await transport('/auth/v1/token?grant_type=refresh_token', { body: { refresh_token: session.refresh_token } }), 200, 'QA refresh');
      check(next?.user?.id === id && next.user.email === account.email && typeof next.access_token === 'string' && typeof next.refresh_token === 'string', 'Refreshed QA identity mismatch.');
      session = next;
      expectStatus(await transport('/auth/v1/user', { method: 'GET', token: session.access_token }), 200, 'Refreshed QA profile');
    },
    logout() { return transport('/auth/v1/logout?scope=local', { token: session.access_token, body: {} }); }
  };
}

async function restoreOwnedSnapshot(client, original, owned, forceVersion = false) {
  const current = expectStatus(await client.rpc('pipechat_read_crm'), 200, 'Read before QA cleanup');
  if (isDeepStrictEqual(content(current), content(original)) && !forceVersion) return;
  check(owned.has(fingerprint(current)), 'Cleanup stopped: the QA table changed outside this test; no overwrite attempted.');
  const saved = expectStatus(await client.rpc('pipechat_write_crm', writeArgs(original, current.updatedAt)), 200, 'Restore QA starting snapshot');
  check(isDeepStrictEqual(content(saved), content(original)), 'QA starting snapshot restore did not match.');
}

async function runChecks({ a, a2, b, transport, emit = console.log, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), expiryWaitMs = 305000 }) {
  check(expiryWaitMs >= 305000, 'Live expiry tests must wait five real minutes plus a safety margin.');
  const reservations = new Set(), owned = new Set(); let original, beforeB, usageA, failure, writesAttempted = false;
  const read = client => client.rpc('pipechat_read_crm').then(result => expectStatus(result, 200, 'QA CRM read'));
  const usage = client => client.rpc('pipechat_read_usage').then(result => expectStatus(result, 200, 'QA usage read'));
  const reserve = (client, id = randomUUID()) => client.rpc('pipechat_reserve_usage', { p_request_id: id });
  const finish = (client, id, outcome) => client.rpc('pipechat_finish_usage', { p_reservation_id: id, p_outcome: outcome });
  const track = result => { if (result.status === 200 && result.data?.reservationId) reservations.add(result.data.reservationId); return result; };
  try {
    const health = expectStatus(await transport('/rest/v1/rpc/pipechat_health', { body: {} }), 200, 'Anonymous health');
    check(isDeepStrictEqual(health, { ok: true, contract: 'pipechat-supabase-v1', database: 'ok', schemaVersion: 1 }), 'Unexpected health contract.');
    const anonymousArgs = [{}, { p_deals: [], p_custom_fields: [], p_table_schema: { status: 'pending' }, p_expected_updated_at: null }, {}, { p_request_id: randomUUID() }, { p_reservation_id: randomUUID(), p_outcome: 'release' }];
    for (let i = 0; i < RPCS.length; i++) expectStatus(await transport(`/rest/v1/rpc/${RPCS[i]}`, { body: anonymousArgs[i] }), 401, 'Anonymous data denial');
    const privateRead = await a.privateTable(); check([401, 403, 404, 406].includes(privateRead.status), 'Private schema was unexpectedly readable.');
    expectStatus(await a.forgedUser(b.id), 401, 'Forged user token denial');
    expectStatus(await a.rpc('pipechat_read_crm', { p_user_id: b.id }), 404, 'Caller-supplied owner denial');
    emit('PASS: anonymous data denial, private-schema denial, forged-token rejection and no caller-selected owner.');
    original = await read(a); beforeB = await read(b); usageA = await usage(a);
    check(a.id !== b.id && a.id === a2.id, 'QA users are not distinct as expected.');
    check(original.tableSchema?.status === 'ready' && original.tableSchema.title === 'QA simulated Recruiting pipeline' && original.deals.length === 3 && beforeB.tableSchema?.title === 'QA simulated Work tracker', 'Expected existing QA-only tables; refusing other snapshots.');
    check(usageA.reserved === 0 && usageA.limit === usageA.used + 1, 'Give only QA A exactly one remaining slot with no active reservations, then rerun. No CRM changes made.');
    owned.add(fingerprint(original));
    const primary = original.tableSchema.fields.find(field => field.role === 'primary')?.id;
    const numeric = original.tableSchema.fields.find(field => ['number', 'currency'].includes(field.type))?.id;
    check(primary && numeric, 'QA field definitions unavailable.');
    const candidates = ['Race A', 'Race B'].map(label => {
      const candidate = structuredClone(original); candidate.deals[0][primary] = `Reliability QA ${label}`; owned.add(fingerprint(candidate)); return candidate;
    });
    writesAttempted = true;
    const race = await together([a.rpc('pipechat_write_crm', writeArgs(candidates[0], original.updatedAt)), a2.rpc('pipechat_write_crm', writeArgs(candidates[1], original.updatedAt)), read(a)]);
    check([race[0].status, race[1].status].sort().join(',') === '200,409', 'Concurrent saves did not yield exactly one success and one conflict.');
    const winner = race[0].status === 200 ? 0 : 1;
    const saved = await read(a);
    check(isDeepStrictEqual(content(saved), content(candidates[winner])) && [original, ...candidates].some(item => isDeepStrictEqual(content(item), content(race[2]))), 'Concurrent save/read produced a mixed snapshot.');
    expectStatus(await a.rpc('pipechat_write_crm', writeArgs(original, original.updatedAt)), 409, 'Stale save');
    const invalid = structuredClone(saved); invalid.deals[0][numeric] = 'not a number';
    expectStatus(await a.rpc('pipechat_write_crm', writeArgs(invalid, saved.updatedAt)), 400, 'Invalid typed value');
    check(isDeepStrictEqual(await read(a), saved) && isDeepStrictEqual(await read(b), beforeB), 'Rejected save or account A write altered other data.');
    emit('PASS: concurrent saves, coherent reader, stale-save and invalid-payload rejection; account B unchanged.');

    const duplicateId = randomUUID();
    const duplicate = await together([reserve(a, duplicateId).then(track), reserve(a2, duplicateId).then(track)]);
    duplicate.forEach(result => expectStatus(result, 200, 'Concurrent duplicate reservation'));
    const duplicateReservation = duplicate[0].data.reservationId;
    check(duplicateReservation === duplicate[1].data.reservationId && (await usage(a)).reserved === 1, 'Duplicate request occupied multiple slots.');
    const beforeBUsage = await usage(b);
    expectStatus(await finish(b, duplicateReservation, 'commit'), 409, 'Foreign reservation denial');
    check(isDeepStrictEqual(await usage(b), beforeBUsage) && (await usage(a)).reserved === 1, 'Foreign finalize altered counters.');
    const releases = await together([finish(a, duplicateReservation, 'release'), finish(a2, duplicateReservation, 'release')]);
    releases.forEach(result => expectStatus(result, 200, 'Duplicate release'));
    expectStatus(await finish(a, duplicateReservation, 'commit'), 409, 'Commit after release');
    const slots = await together([reserve(a).then(track), reserve(a2).then(track)]);
    check(slots.map(result => result.status).sort().join(',') === '200,402', 'Last-slot race did not grant exactly one request.');
    const granted = slots.find(result => result.status === 200).data.reservationId;
    expectStatus(await finish(a, granted, 'release'), 200, 'Release last-slot reservation');
    check((await usage(a)).used === usageA.used && (await usage(a)).reserved === 0, 'Reserve/release unexpectedly charged usage.');
    emit('PASS: last-slot race, active duplicate retry, concurrent release, ownership and zero-charge release.');

    const expiredKey = randomUUID();
    const expiring = track(await reserve(a, expiredKey)); expectStatus(expiring, 200, 'Expiry reservation');
    emit('WAIT: real five-minute Supabase reservation expiry. Keep this PowerShell window open; do not edit the QA accounts.');
    await sleep(expiryWaitMs);
    expectStatus(await finish(a, expiring.data.reservationId, 'commit'), 409, 'Late commit');
    expectStatus(await reserve(a, expiredKey), 409, 'Expired-key retry');
    const expiredUsage = await usage(a);
    check(expiredUsage.used === usageA.used && expiredUsage.reserved === 0 && expiredUsage.remaining === 1, 'Expiry failed to restore allowance without charging.');
    expectStatus(await finish(a, expiring.data.reservationId, 'release'), 200, 'Expired release');
    emit('PASS: real reservation expiry, rejected late commit/retry, recovered allowance and zero charges.');

    const contested = track(await reserve(a)); expectStatus(contested, 200, 'Finalize-race reservation');
    const outcomes = await together([finish(a, contested.data.reservationId, 'commit'), finish(a2, contested.data.reservationId, 'release')]);
    check(outcomes.map(result => result.status).sort().join(',') === '200,409', 'Commit/release race did not have exactly one winning outcome.');
    let committedId = contested.data.reservationId;
    if (outcomes[1].status === 200) {
      const final = track(await reserve(a)); expectStatus(final, 200, 'Commit retry reservation'); committedId = final.data.reservationId;
    }
    const commits = await together([finish(a, committedId, 'commit'), finish(a2, committedId, 'commit')]);
    commits.forEach(result => expectStatus(result, 200, 'Concurrent commit/retry'));
    expectStatus(await finish(a, committedId, 'release'), 409, 'No refund after commit');
    expectStatus(await reserve(a), 402, 'Exhausted quota');
    const finalUsage = await usage(a);
    check(finalUsage.used === usageA.used + 1 && finalUsage.reserved === 0 && finalUsage.remaining === 0, 'Final accounting did not charge exactly once.');
    const current = await read(a);
    const atCap = expectStatus(await a.rpc('pipechat_write_crm', writeArgs(original, current.updatedAt)), 200, 'Manual snapshot save at cap');
    check(isDeepStrictEqual(content(atCap), content(original)), 'Manual save at cap changed CRM contents.');
    emit('PASS: commit/release race, duplicate commit accounting, no refund and manual save at the cap; exactly one synthetic chat charged.');

    await a2.refresh();
    expectStatus(await a2.logout(), 204, 'QA session logout');
    for (let i = 0; i < RPCS.length; i++) expectStatus(await a2.rpc(RPCS[i], anonymousArgs[i]), 401, 'Revoked session replay');
    check(isDeepStrictEqual(content(await read(a)), content(original)) && isDeepStrictEqual(await read(b), beforeB), 'Session revocation affected another user or session.');
    emit('PASS: token refresh, revoked-session rejection on all five RPCs, other-session continuity and account isolation.');
  } catch (error) { failure = error; }
  finally {
    for (const id of reservations) {
      try { const result = await finish(a, id, 'release'); check([200, 409].includes(result.status), 'Reservation cleanup failed.'); }
      catch { failure ||= new CheckFailure('QA reservation cleanup could not be verified; uncommitted reservations expire after five minutes.'); }
    }
    if (original) {
      try { await restoreOwnedSnapshot(a, original, owned, writesAttempted); emit('PASS: QA A CRM contents restored/read-back matched; no automatic quota reset.'); }
      catch (error) { failure ||= error; }
    }
  }
  if (failure) throw failure;
  emit('HOSTED RELIABILITY CHECKS PASSED. Restore only QA A limit to 1000; keep its incremented used count. No production switch was made.');
}

async function main() {
  check(process.argv.slice(2).join(' ') === '--approved-qa', 'Explicit --approved-qa required.');
  let bytes = 0, raw = '';
  for await (const chunk of process.stdin) { bytes += chunk.length; check(bytes <= 24000, 'Private input is too large.'); raw += chunk; }
  const input = validateInput(JSON.parse(raw)); raw = '';
  const transport = makeTransport(input.publishableKey); const clients = [];
  try {
    const a = await login(transport, 'a', input.a); clients.push(a);
    const a2 = await login(transport, 'a', input.a); clients.push(a2);
    const b = await login(transport, 'b', input.b); clients.push(b);
    input.a = ''; input.b = '';
    console.log('PASS: fixed disposable QA identities verified. Passwords/tokens stay in process memory; no OpenAI requests.');
    await runChecks({ a, a2, b, transport });
  } finally {
    input.a = ''; input.b = '';
    for (const client of clients) {
      try { check([204, 401, 403].includes((await client.logout()).status), 'QA session cleanup failed.'); }
      catch { console.log('FAIL: A runner-owned QA session could not be revoked. Review QA sessions before cutover.'); process.exitCode = 1; }
    }
  }
}
if (require.main === module) main().catch(error => {
  console.log(`FAIL: ${error instanceof CheckFailure ? error.message : 'Unexpected QA runner failure; private details suppressed.'}`);
  console.log('Restore QA A limit to 1000 without resetting used. Share only PASS/FAIL/WAIT lines, never passwords or tokens.');
  process.exitCode = 1;
});
module.exports = { RUN_ID, ACCOUNTS, RPCS, CheckFailure, validateInput, makeTransport, login, runChecks, restoreOwnedSnapshot, content, fingerprint, writeArgs, expectStatus, together };
