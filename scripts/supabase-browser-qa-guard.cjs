// Opt-in QA preload only. Never imported by the production startup path.
const { AsyncLocalStorage } = require('node:async_hooks');
const http = require('node:http');
const { BackendError } = require('../lib/xano-backend.js');
const Core = require('../public/pipeline-core.js');

const BASE = 'https://nzktondjxxxiezkbrhdo.supabase.co';
const RESTORE = Object.freeze({ base: 'https://pznjcsscfthondvvdljq.supabase.co',
  runId: '60abf0b7-1d6c-402b-8297-dbce9727580b', publishableKey: 'sb_publishable_VhMykcdVFgzJMQDPicBwIw_SH4OaXl9' });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MODEL = 'qa-simulated-no-openai';
const SIMULATION_KEY = 'qa-simulation-not-a-real-key';
const deny = () => new BackendError('Only the two approved accounts for this localhost QA run are allowed.', 403);
const networkDenied = () => new Error('QA outbound operation blocked.');
const readOnlyDenied = () => new BackendError('Restore QA is read-only: CRM edits, new accounts and chatbot usage are disabled.', 403);
const jsonResponse = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

function projectBase(restoreOnly, runId) {
  if (typeof restoreOnly !== 'boolean' || restoreOnly && runId !== RESTORE.runId) throw new Error('Invalid restored QA configuration.');
  return restoreOnly ? RESTORE.base : BASE;
}

function identities(runId) {
  if (typeof runId !== 'string' || !UUID.test(runId)) throw new Error('QA run ID must be a lowercase UUID v4.');
  return ['a', 'b'].map(label => ({ label, email: `supabase-qa-${runId}-${label}@example.invalid`, name: `Supabase QA ${label.toUpperCase()}` }));
}

function tableDesign(useCase) {
  const cases = {
    Sales: ['Sales pipeline', 'deal', 'Company', 'Owner', 'Stage', ['Discovery', 'Warm', 'Proposal Sent', 'Won', 'Lost'], 'Value', 'currency'],
    Recruiting: ['Recruiting pipeline', 'candidate', 'Candidate', 'Recruiter', 'Hiring stage', ['Sourced', 'Interview', 'Hired'], 'Expected compensation', 'currency'],
    'Real Estate': ['Property pipeline', 'property', 'Property', 'Agent', 'Listing stage', ['Available', 'Viewing', 'Offer', 'Closed'], 'Asking price', 'currency'],
    Other: ['Work tracker', 'item', 'Item', 'Owner', 'Status', ['New', 'In progress', 'Done'], 'Quantity', 'number']
  };
  if (!Object.hasOwn(cases, useCase)) throw new Error('Unsupported simulated table design.');
  const [title, recordLabel, primary, owner, status, options, amount, type] = cases[useCase];
  return {
    title: `QA simulated ${title}`, recordLabel,
    fields: [
      { name: primary, type: 'text', role: 'primary', options: [] },
      { name: owner, type: 'text', role: 'owner', options: [] },
      { name: status, type: 'choice', role: 'status', options },
      { name: amount, type, role: 'none', options: [] },
      { name: 'Follow-up date', type: 'date', role: 'followup', options: [] },
      { name: useCase === 'Recruiting' ? 'Score' : 'Notes', type: useCase === 'Recruiting' ? 'number' : 'text', role: 'none', options: [] }
    ]
  };
}

function modelReply(body) {
  const request = JSON.parse(body);
  const input = JSON.parse(request.input?.[0]?.content?.[0]?.text);
  if (request.text?.format?.schema?.properties?.fields && input.useCase) {
    return jsonResponse({ output_text: JSON.stringify(tableDesign(input.useCase)) });
  }
  const command = input.userCommand;
  if (command === 'fail model') throw new Error('QA simulated model failure. No AI request was sent.');
  // Unsupported CSV analysis fails explicitly instead of pretending an AI inspected it.
  if (typeof command !== 'string') throw new Error('This QA simulation only supports table setup and scripted chat.');
  const core = Core.create(input.pipeline?.tableSchema), defs = core.definitions(input.pipeline?.customFields);
  const primary = core.role('primary'), owner = core.role('owner'), status = core.role('status'), follow = core.role('followup');
  const amount = defs.find(field => ['currency', 'number'].includes(field.type))?.id;
  let action = null;
  if (command === 'Move Acme QA to Warm' && defs.find(field => field.id === status)?.options.includes('Warm')) {
    action = { action: 'update_record', recordMatch: 'Acme QA', field: status, value: 'Warm' };
  } else if (command === 'Add Gamma QA') {
    action = { action: 'add_record', record: { [primary]: 'Gamma QA', ...(owner ? { [owner]: 'Sarah' } : {}), ...(amount ? { [amount]: 1234 } : {}) } };
  } else if (command === 'Delete Gamma QA') {
    action = { action: 'delete_record', recordMatch: 'Gamma QA' };
  } else if (command === 'Assign Acme QA to Neelam' && owner) {
    action = { action: 'clarify', question: 'QA simulation: assign Neelam as the owner?' };
  } else if (command === 'yes' && owner && input.pendingClarification?.originalCommand === 'Assign Acme QA to Neelam') {
    action = { action: 'update_record', recordMatch: 'Acme QA', field: owner, value: 'Neelam' };
  } else if (command === 'Show follow-ups today' && follow) {
    action = { action: 'filter_view', field: follow, operator: 'equals', value: 'today' };
  } else if (command === 'Add Contact column') {
    action = { action: 'add_field', newFieldName: 'Contact' };
  }
  return jsonResponse({ output_text: JSON.stringify({
    assistantMessage: action ? 'QA simulation: scripted proposal only. Supabase storage and usage are real; no AI service was contacted.' :
      'QA simulation only: no matching scripted action. Nothing was changed and no AI service was contacted.',
    crmAction: action, memoryNote: null
  }) });
}

function restrictedFetch(nativeFetch, { runId, publishableKey, access, signal, restoreOnly = false, onHealthStatus } = {}) {
  const base = projectBase(restoreOnly, runId);
  if (restoreOnly && publishableKey !== RESTORE.publishableKey) throw networkDenied();
  const emails = new Set(identities(runId).map(account => account.email));
  if (typeof nativeFetch !== 'function' || !access?.getStore) throw new Error('Missing QA transport guard.');
  return async (input, init = {}) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request ? request.url : input);
    const method = (init.method || request?.method || 'GET').toUpperCase();
    const headers = new Headers(init.headers || request?.headers);
    const context = access.getStore();
    const body = init.body !== undefined ? init.body : request && !['GET', 'HEAD'].includes(method) ? await request.clone().text() : undefined;
    signal?.throwIfAborted(); init.signal?.throwIfAborted(); request?.signal.throwIfAborted();
    if (url.href === 'https://api.openai.com/v1/responses' && method === 'POST') {
      if (restoreOnly) throw networkDenied();
      if (typeof body !== 'string') throw networkDenied();
      return modelReply(body);
    }
    if (url.origin !== base || url.username || url.password || url.hash || headers.get('apikey') !== publishableKey) throw networkDenied();
    const path = url.pathname;
    const auth = path.startsWith('/auth/v1/');
    let allowed = false;
    if (path === '/rest/v1/rpc/pipechat_health') {
      allowed = ['GET', 'POST'].includes(method) && !url.search;
    } else if (/^\/rest\/v1\/rpc\/pipechat_(read_crm|write_crm|read_usage|reserve_usage|finish_usage)$/.test(path)) {
      allowed = method === 'POST' && !url.search && context?.kind === 'data' &&
        (!restoreOnly || path === '/rest/v1/rpc/pipechat_read_crm');
    } else if (auth && context) {
      if (path === '/auth/v1/user') allowed = method === 'GET' && !url.search;
      if (path === '/auth/v1/signup' || path === '/auth/v1/token' && url.search === '?grant_type=password') {
        const payload = typeof body === 'string' ? JSON.parse(body) : null;
        allowed = method === 'POST' && context.kind === 'authenticate' && emails.has(context.email) &&
          payload?.email === context.email && (path !== '/auth/v1/signup' || !url.search && !restoreOnly);
      }
      if (path === '/auth/v1/token' && url.search === '?grant_type=refresh_token') {
        allowed = method === 'POST' && ['verify', 'authenticate', 'data', 'logout'].includes(context.kind);
      }
      if (path === '/auth/v1/logout') allowed = method === 'POST' && url.search === '?scope=local' && context.kind === 'logout';
    }
    if (!allowed) throw networkDenied();
    if (context?.userId && path !== '/auth/v1/token') {
      // Auth.getUser verified this identity. Bind the RPC bearer to that same user.
      let claims;
      try { claims = JSON.parse(Buffer.from((headers.get('authorization') || '').replace(/^Bearer /i, '').split('.')[1], 'base64url').toString()); }
      catch { throw networkDenied(); }
      if (claims?.sub !== context.userId || claims.role !== 'authenticated') throw networkDenied();
    }
    const signals = [signal, init.signal, request?.signal].filter(Boolean);
    const response = await nativeFetch(input, { ...init, redirect: 'error', ...(signals.length ? { signal: AbortSignal.any(signals) } : {}) });
    if (path === '/rest/v1/rpc/pipechat_health' && Number.isInteger(response.status) && response.status >= 100 && response.status <= 599) {
      onHealthStatus?.(response.status);
    }
    return response;
  };
}

function startupCheck(check, notify) {
  let pending = true;
  return async (...args) => {
    try {
      const result = await check(...args);
      pending = false;
      return result;
    } catch (error) {
      // The server catches this rejection, but IPC keeps the QA child alive.
      // Tell the launcher immediately without forwarding provider messages.
      if (pending) { pending = false; notify({ type: 'qa-startup-failed', stage: 'backend-health' }); }
      throw error;
    }
  };
}

function runtimeDiagnostic(error, origin) {
  const kinds = ['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError'];
  const codes = ['ERR_HTTP_HEADERS_SENT', 'ERR_INVALID_ARG_TYPE', 'ERR_INVALID_CHAR', 'ERR_IPC_CHANNEL_CLOSED', 'EPIPE', 'ECONNRESET'];
  const stack = typeof error?.stack === 'string' ? error.stack.slice(0, 32768) : '';
  const frame = /(?:^|[\\/])(server\.js|supabase-backend\.js|supabase-browser-qa-guard\.cjs):(\d{1,6}):(\d{1,6})(?:\)|$)/m.exec(stack);
  return { type: 'qa-runtime-failed', origin: origin === 'unhandledRejection' ? 'UNHANDLED_REJECTION' : 'UNCAUGHT_EXCEPTION',
    kind: kinds.includes(error?.name) ? error.name : 'Error', code: codes.includes(error?.code) ? error.code : 'UNCLASSIFIED',
    site: frame ? `${frame[1]}:${frame[2]}:${frame[3]}` : 'UNKNOWN' };
}

function guardedBackend(real, { runId, access = new AsyncLocalStorage(), origin, restoreOnly = false } = {}) {
  projectBase(restoreOnly, runId);
  const accounts = identities(runId), users = new Map();
  let closed = false, outage = false;
  function allowed(candidate, expectedEmail, pinned) {
    if (closed || !candidate || !USER_ID.test(candidate.id || '') || !accounts.some(account => account.email === candidate.email) ||
      expectedEmail && candidate.email !== expectedEmail || pinned && (candidate.id !== pinned.id || candidate.email !== pinned.email) ||
      users.has(candidate.email) && users.get(candidate.email) !== candidate.id ||
      [...users].some(([email, id]) => id === candidate.id && email !== candidate.email)) throw deny();
    users.set(candidate.email, candidate.id);
    return { id: candidate.id, email: candidate.email, name: candidate.name || '' };
  }
  return {
    access,
    close() { closed = true; },
    setOutage(enabled) {
      if (closed || typeof enabled !== 'boolean') throw deny();
      outage = enabled;
    },
    wrapped: {
      async check(...args) {
        if (closed) throw deny();
        // No readiness bypass: the real, migrated Supabase contract must pass.
        return real.check(...args);
      },
      forRequest(req, res, options) {
        if (closed) throw deny();
        if (origin) {
          const expected = new URL(origin());
          if (req.headers?.host !== expected.host || !['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress)) throw deny();
        }
        const adapter = access.run({ kind: 'verify' }, () => real.forRequest(req, res, { ...options, secureCookie: false }));
        let pinned = null, rejected = false;
        async function verify(required = false) {
          if (closed || rejected) throw deny();
          const candidate = await access.run({ kind: 'verify' }, () => adapter.getUser());
          if (!candidate && !required && !pinned) return null;
          try { pinned = allowed(candidate, undefined, pinned); }
          catch (error) { rejected = true; throw error; }
          return pinned;
        }
        const wrapped = {
          getUser: () => verify(),
          async authenticate(mode, input) {
            if (restoreOnly && mode !== 'login') throw readOnlyDenied();
            if (closed || rejected || !['login', 'signup'].includes(mode) || !accounts.some(account => account.email === input?.email)) throw deny();
            const result = await access.run({ kind: 'authenticate', email: input.email }, () => adapter.authenticate(mode, input));
            if (mode === 'signup' && result?.confirmationRequired === true && !result.user) {
              return { confirmationRequired: true, message: 'QA account confirmation is required. Use Dashboard Add user with Auto Confirm, then sign in.' };
            }
            try {
              pinned = allowed(result?.user, input.email, pinned);
              await verify(true);
              return { user: pinned };
            } catch (error) { rejected = true; throw error; }
          },
          async logout() {
            const identity = await verify();
            if (!identity) return;
            await access.run({ kind: 'logout', userId: identity.id }, () => adapter.logout());
            rejected = true;
          }
        };
        for (const method of ['readCrm', 'writeCrm', 'readUsage', 'reserveUsage', 'finishUsage']) {
          wrapped[method] = async (...args) => {
            // readUsage also expires reservations, so a strictly read-only CRM
            // restoration check must not call it or any metering operation.
            if (restoreOnly && method !== 'readCrm') throw readOnlyDenied();
            const identity = await verify(true);
            if (outage && ['readCrm', 'writeCrm'].includes(method)) {
              throw new BackendError('QA-only simulated CRM outage. No Supabase CRM request was sent.', 503);
            }
            return access.run({ kind: 'data', userId: identity.id }, () => adapter[method](...args));
          };
        }
        return wrapped;
      }
    }
  };
}

function validateEnvironment(env, argv = process.argv) {
  if (env.PIPECHAT_SUPABASE_RESTORE_QA !== undefined && !['0','1'].includes(env.PIPECHAT_SUPABASE_RESTORE_QA)) throw new Error('Invalid QA mode.');
  const restoreOnly = env.PIPECHAT_SUPABASE_RESTORE_QA === '1';
  const base = projectBase(restoreOnly, env.PIPECHAT_QA_RUN_ID);
  if (!argv.includes('--approved-qa') || env.PIPECHAT_SUPABASE_BROWSER_QA !== '1' || env.NODE_ENV !== 'test' ||
    env.PIPECHAT_HOST !== '127.0.0.1' || env.PORT !== '0' || env.PIPECHAT_STORAGE_PROVIDER !== 'supabase' ||
    env.SUPABASE_URL !== base || !/^sb_publishable_[A-Za-z0-9_-]{16,}$/.test(env.SUPABASE_PUBLISHABLE_KEY || '') ||
    restoreOnly && env.SUPABASE_PUBLISHABLE_KEY !== RESTORE.publishableKey ||
    env.PIPECHAT_PUBLIC_ORIGIN !== 'http://127.0.0.1:0' || env.PIPECHAT_COOKIE_SECURE !== 'false' ||
    env.OPENAI_API_KEY !== SIMULATION_KEY || env.PIPECHAT_MODEL !== MODEL) throw new Error('QA preload requires explicit approval and isolated localhost/test configuration.');
  identities(env.PIPECHAT_QA_RUN_ID);
}

function install() {
  validateEnvironment(process.env);
  const restoreOnly = process.env.PIPECHAT_SUPABASE_RESTORE_QA === '1';
  const base = projectBase(restoreOnly, process.env.PIPECHAT_QA_RUN_ID);
  const access = new AsyncLocalStorage(), controller = new AbortController();
  global.fetch = restrictedFetch(global.fetch, { runId: process.env.PIPECHAT_QA_RUN_ID,
    publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY, access, signal: controller.signal, restoreOnly,
    onHealthStatus: status => process.send?.({ type: 'qa-health-status', status }) });
  const adapter = require('../lib/supabase-backend.js'), original = adapter.createSupabaseBackend;
  let harness, server, stopping = false;
  process.once('uncaughtException', (error, origin) => {
    const diagnostic = runtimeDiagnostic(error, origin);
    // Fatal errors must end this QA child, never resume request handling.
    stopping = true;
    harness?.close(); controller.abort(); server?.closeAllConnections();
    const finish = () => process.exit(1);
    setTimeout(finish, 250).unref();
    if (process.connected) process.send(diagnostic, finish);
    else finish();
  });
  adapter.createSupabaseBackend = config => {
    if (harness || config.url !== base || config.publishableKey !== process.env.SUPABASE_PUBLISHABLE_KEY) throw deny();
    harness = guardedBackend(original({ ...config, fetchImpl: global.fetch }), {
      runId: process.env.PIPECHAT_QA_RUN_ID, access, origin: () => process.env.PIPECHAT_PUBLIC_ORIGIN, restoreOnly
    });
    harness.wrapped.check = startupCheck(harness.wrapped.check, message => process.send?.(message));
    return harness.wrapped;
  };
  require('../lib/xano-backend.js').createXanoBackend = () => { throw deny(); };
  const listen = http.Server.prototype.listen;
  http.Server.prototype.listen = function (...args) {
    if (server || stopping || args[0] !== 0 || args[1] !== '127.0.0.1') throw new Error('QA listener must use an ephemeral loopback port.');
    server = this;
    this.once('listening', () => {
      const port = this.address().port;
      process.env.PIPECHAT_PUBLIC_ORIGIN = `http://127.0.0.1:${port}`;
      process.send?.({ type: 'qa-ready', port });
    });
    this.once('error', () => { process.send?.({ type: 'qa-failed' }); stop(1); });
    return listen.apply(this, args);
  };
  function stop(code = 0) {
    if (stopping) return;
    stopping = true;
    const finish = () => { harness?.close(); controller.abort(); process.exit(code); };
    const timeout = setTimeout(() => { server?.closeAllConnections(); finish(); }, 5000);
    timeout.unref();
    if (server?.listening) { server.close(finish); server.closeIdleConnections(); }
    else finish();
  }
  process.on('message', message => {
    if (message?.type === 'qa-stop') stop();
    else if (message?.type === 'qa-outage' && typeof message.enabled === 'boolean' && harness && !stopping) {
      harness.setOutage(message.enabled);
      process.send?.({ type: 'qa-outage', enabled: message.enabled });
    }
  });
  process.once('disconnect', () => stop());
  process.once('SIGINT', () => stop()); process.once('SIGTERM', () => stop());
  return { stop };
}

module.exports = { BASE, RESTORE, MODEL, SIMULATION_KEY, projectBase, identities, tableDesign, modelReply, restrictedFetch, guardedBackend, validateEnvironment, startupCheck, runtimeDiagnostic, install };
