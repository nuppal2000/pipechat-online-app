const { AsyncLocalStorage } = require('node:async_hooks');
const { isDeepStrictEqual } = require('node:util');
const schemaCore = require('../public/table-schema.js');
const { BackendError, snapshotResult, usageResult } = require('./xano-backend.js');

const COOKIE_NAME = 'pipechat_supabase';
const unavailable = () => new BackendError('Supabase could not complete the request. No local fallback was used.');
const invalidResponse = () => new BackendError('Supabase returned invalid data. No local fallback was used.');
const validVersion = value => value === null || (typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value));
const validTimestamp = value => value === null || (typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)));
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);

function validateConfig(url, key, allowLocalhost, mockFetch) {
  try {
    if (typeof url !== 'string' || url !== url.trim()) throw new Error();
    const parsed = new URL(url);
    const hosted = parsed.protocol === 'https:' && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.supabase\.co$/.test(parsed.hostname) && !parsed.port;
    const local = allowLocalhost === true && mockFetch && process.env.NODE_ENV !== 'production' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) && ['http:', 'https:'].includes(parsed.protocol);
    if ((!hosted && !local) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') throw new Error();
    if (typeof key !== 'string' || key.length > 4096) throw new Error();
    if (!/^sb_publishable_[A-Za-z0-9_-]{16,}$/.test(key)) {
      if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key)) throw new Error();
      const [header, payload] = key.split('.').map(part => Buffer.from(part, 'base64url').toString());
      if (JSON.parse(header).alg !== 'HS256' || JSON.parse(payload).role !== 'anon') throw new Error();
    }
    return parsed.origin;
  } catch {
    throw new BackendError('Configure a valid HTTPS Supabase project URL and publishable or legacy anon key. Secret and service-role keys are not supported.');
  }
}

function snapshot(input, status = 503) {
  try {
    if (!input || !Object.hasOwn(input, 'customFields') || !Array.isArray(input.customFields) ||
        !Object.hasOwn(input, 'tableSchema') || input.tableSchema === undefined || !validVersion(input.updatedAt)) throw new Error();
    const result = snapshotResult(input);
    return { ...result, tableSchema: result.tableSchema ?? null };
  } catch {
    throw new BackendError(status === 400 ? 'Invalid CRM snapshot. Check the records and field definitions.' :
      'Supabase returned invalid CRM data. Nothing has been replaced locally.', status);
  }
}

function usage(input) {
  try {
    if (!input || typeof input.paymentRequired !== 'boolean' || !validTimestamp(input.updatedAt) ||
        !Number.isSafeInteger(input.used + input.reserved)) throw new Error();
    const result = usageResult({ used: input.used, limit: input.limit, reserved: input.reserved,
      remaining: input.remaining, updatedAt: input.updatedAt });
    if (result.paymentRequired !== input.paymentRequired) throw new Error();
    return result;
  } catch { throw invalidResponse(); }
}

function publicUser(user) {
  if (!user || !validId(user.id) || typeof user.email !== 'string' || user.email.length > 320 ||
      !/^[^\s@]+@[^\s@]+$/.test(user.email)) throw invalidResponse();
  const name = user.user_metadata?.name ?? '';
  if (typeof name !== 'string' || name.length > 200 || /[\x00-\x1f\x7f]/.test(name)) throw invalidResponse();
  return { id: user.id, email: user.email, name };
}

function providerError(error, operation, httpStatus) {
  const code = typeof error?.code === 'string' ? error.code : '';
  const sqlStatuses = { PT400: 400, PT401: 401, PT402: 402, PT409: 409 };
  let status = Object.hasOwn(sqlStatuses, code) ? sqlStatuses[code] : undefined;
  if (!status) {
    if (['session_not_found', 'refresh_token_not_found', 'refresh_token_already_used', 'bad_jwt', 'invalid_credentials'].includes(code) ||
        error?.name === 'AuthSessionMissingError') status = 401;
    else if (['email_not_confirmed', 'user_banned'].includes(code)) status = 403;
    else if (code === 'user_already_exists') status = 409;
    else if (code === 'weak_password' || code === 'validation_failed') status = 400;
    else if ([400, 401, 403, 402, 409, 429].includes(error?.status ?? httpStatus)) status = error?.status ?? httpStatus;
    else status = 503;
  }
  let quota;
  if (status === 402 && typeof error?.details === 'string' && error.details.length <= 16384) {
    try {
      const detail = JSON.parse(error.details);
      quota = usage(detail?.usage ?? detail);
    } catch { /* Malformed quota details must not expose provider text. */ }
  }
  const messages = {
    400: 'Supabase rejected this request. Check the input.',
    401: operation === 'login' ? 'Email or password is incorrect.' : 'Your session has expired. Please sign in again.',
    402: 'Free chatbot usage limit reached. Manual CRM editing is still available.',
    403: operation === 'login' ? 'Sign-in is not available. Confirm your email and try again.' : 'Supabase denied access to this request.',
    409: operation === 'signup' ? 'An account with that email already exists.' : operation.includes('usage') ?
      'The chat reservation is no longer available. No CRM changes were applied.' :
      'This CRM changed in another window. Refresh before saving; this change was not applied.',
    429: 'Supabase is temporarily rate limiting requests. Please try again shortly.'
  };
  return new BackendError(messages[status] || unavailable().message, status, quota);
}

// Client factories are injectable for offline tests. Only the health client is shared;
// it has no session storage, and is never used for authenticated operations.
function createSupabaseBackend({ url, publishableKey, fetchImpl = fetch, timeoutMs = 15000,
  maxResponseBytes = 16 * 1024 * 1024, allowLocalhost = false,
  createClient: injectedClient, createServerClient: injectedServerClient } = {}) {
  const base = validateConfig(url, publishableKey, allowLocalhost, fetchImpl !== globalThis.fetch);
  if (typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000 ||
      !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 64 * 1024 * 1024) {
    throw new BackendError('Invalid Supabase request limits.');
  }
  const context = new AsyncLocalStorage();

  async function deadline(task, parentSignal) {
    const controller = new AbortController();
    const signal = parentSignal ? AbortSignal.any([controller.signal, parentSignal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let onAbort;
    try {
      signal.throwIfAborted();
      return await Promise.race([
        new Promise((resolve, reject) => {
          onAbort = () => reject(unavailable());
          signal.addEventListener('abort', onAbort, { once: true });
        }),
        context.run(signal, async () => await task(signal))
      ]);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
      controller.abort();
    }
  }

  async function boundedFetch(input, init = {}) {
    const parentSignals = [context.getStore(), init.signal, input instanceof Request ? input.signal : null].filter(Boolean);
    const parentSignal = parentSignals.length ? AbortSignal.any(parentSignals) : undefined;
    try {
      return await deadline(async signal => {
        const target = new URL(input instanceof Request ? input.url : input);
        if (target.origin !== base || target.username || target.password) throw new Error();
        const response = await fetchImpl(input, { ...init, redirect: 'error', signal });
        if (!response || !Number.isInteger(response.status) || !response.headers?.get) throw new Error();
        if (Number(response.headers.get('content-length')) > maxResponseBytes) {
          if (response.body) void response.body.cancel().catch(() => {});
          throw new Error();
        }
        const chunks = [];
        let size = 0;
        if (response.body) {
          const reader = response.body.getReader();
          const cancel = () => { void reader.cancel().catch(() => {}); };
          signal.addEventListener('abort', cancel, { once: true });
          try {
            while (true) {
              signal.throwIfAborted();
              const { done, value } = await reader.read();
              if (done) break;
              size += value.byteLength;
              if (size > maxResponseBytes) { cancel(); throw new Error(); }
              chunks.push(Buffer.from(value));
            }
          } finally {
            signal.removeEventListener('abort', cancel);
            reader.releaseLock();
          }
        }
        signal.throwIfAborted();
        // Buffer the body under the same deadline, before the SDK starts parsing it.
        return new Response([204, 205, 304].includes(response.status) ? null : Buffer.concat(chunks), {
          status: response.status, headers: response.headers
        });
      }, parentSignal);
    } catch { throw unavailable(); }
  }

  async function call(task, operation, signal) {
    let result;
    try { result = await deadline(task, signal); }
    catch { throw unavailable(); }
    if (!result || typeof result !== 'object' || !Object.hasOwn(result, 'error')) throw invalidResponse();
    if (result.error) throw providerError(result.error, operation, result.status);
    return result.data;
  }

  let healthClient, makeServerClient, parseCookieHeader, serializeCookieHeader;
  try {
    const ssr = require('@supabase/ssr');
    ({ parseCookieHeader, serializeCookieHeader } = ssr);
    makeServerClient = injectedServerClient ?? ssr.createServerClient;
    const makeClient = injectedClient ?? require('@supabase/supabase-js').createClient;
    healthClient = makeClient(base, publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: boundedFetch }
    });
    if (typeof healthClient?.rpc !== 'function' || typeof makeServerClient !== 'function') throw new Error();
  } catch { throw new BackendError('Supabase clients could not be initialized. Check the configuration and installed dependencies.'); }

  return {
    async check({ requireDatabase = false, signal } = {}) {
      const result = await call(() => healthClient.rpc('pipechat_health'), 'health', signal);
      if (result?.ok !== true || result.contract !== 'pipechat-supabase-v1' || result.schemaVersion !== 1) {
        throw new BackendError('Supabase does not match the PipeChat integration contract. Complete the database migration before switching backends.');
      }
      if (requireDatabase && result.database !== 'ok') throw new BackendError('Supabase database readiness has not been verified.');
      if (result.database !== 'ok') throw invalidResponse();
      return { ok: true, contract: result.contract, database: 'ok', schemaVersion: 1 };
    },

    forRequest(req, res, { secureCookie = process.env.NODE_ENV === 'production' } = {}) {
      const cookieOptions = { name: COOKIE_NAME, httpOnly: true, sameSite: 'lax', path: '/',
        secure: process.env.NODE_ENV === 'production' || secureCookie === true };
      const noStore = () => {
        res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate, max-age=0');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
      };
      let client, verified, cookieJar;
      try {
        const header = req.headers?.cookie ?? '';
        if (typeof header !== 'string' || header.length > 65536 || /[\r\n\x00]/.test(header)) throw new Error();
        cookieJar = new Map(parseCookieHeader(header).map(({ name, value }) => [name, value]));
        noStore();
      } catch { throw new BackendError('Supabase request authentication could not be initialized.'); }

      function getClient() {
        if (client) return client;
        // The SDK can refresh cookies as soon as it is constructed. Validate input first.
        try {
          client = makeServerClient(base, publishableKey, {
            cookieOptions,
            global: { fetch: boundedFetch },
            cookies: {
              getAll: () => Array.from(cookieJar, ([name, value]) => ({ name, value })),
              setAll: cookies => {
                try {
                  // Keep the request view current and preserve unrelated response cookies.
                  if (res.headersSent) throw new Error();
                  const serialized = cookies.map(({ name, value, options }) => {
                    if (!/^pipechat_supabase(?:-(?:flow-[A-Za-z0-9_-]{8,64}-|flows-)?code-verifier)?(?:\.[0-9]+)?$/.test(name)) throw new Error();
                    return serializeCookieHeader(name, value, { ...options, ...cookieOptions, domain: undefined });
                  });
                  const old = res.getHeader('Set-Cookie');
                  const existing = old == null ? [] : Array.isArray(old) ? old : [old];
                  const replaced = new Set(cookies.map(cookie => cookie.name));
                  res.setHeader('Set-Cookie', [...existing.filter(value => !replaced.has(String(value).split('=', 1)[0])), ...serialized]);
                  for (const { name, value, options } of cookies) {
                    if (options?.maxAge === 0) cookieJar.delete(name);
                    else cookieJar.set(name, value);
                  }
                  noStore();
                } catch { throw unavailable(); }
              }
            }
          });
          if (!client?.auth || typeof client.rpc !== 'function') throw new Error();
          return client;
        } catch {
          client = undefined;
          throw new BackendError('Supabase request authentication could not be initialized.');
        }
      }

      function getUser() {
        // Coalesce verification/refresh for concurrent work on this request only.
        if (!verified) verified = (async () => {
          let data;
          try { data = await call(() => getClient().auth.getUser(), 'user'); }
          catch (error) { if (error.status === 401) return null; throw error; }
          if (!data || !Object.hasOwn(data, 'user')) throw invalidResponse();
          return data.user === null ? null : publicUser(data.user);
        })();
        return verified;
      }

      async function rpc(name, args) {
        if (!await getUser()) throw providerError({ code: 'PT401' }, name);
        return call(() => getClient().rpc(name, args), name);
      }

      const adapter = {
        getUser,
        async authenticate(mode, input) {
          if (!['login', 'signup'].includes(mode) || !input || typeof input.email !== 'string' ||
              input.email.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(input.email) || typeof input.password !== 'string' ||
              !input.password.length || input.password.length > 4096 || /[\x00]/.test(input.password) ||
              (mode === 'signup' && (input.password.length < 8 || (input.name != null &&
                (typeof input.name !== 'string' || input.name.length > 200 || /[\x00-\x1f\x7f]/.test(input.name)))))) {
            throw new BackendError('Use a valid email, password and name.', 400);
          }
          verified = undefined;
          const client = getClient();
          const credentials = { email: input.email, password: input.password };
          const data = await call(() => mode === 'signup' ? client.auth.signUp({ ...credentials, options: { data: { name: input.name || '' } } }) :
            client.auth.signInWithPassword(credentials), mode);
          if (!data || !Object.hasOwn(data, 'session')) throw invalidResponse();
          if (mode === 'signup' && data.session === null) {
            publicUser(data.user);
            verified = Promise.resolve(null);
            return { confirmationRequired: true, message: 'Check your email to confirm your account, then sign in.' };
          }
          if (!data.session) throw invalidResponse();
          const user = await getUser();
          if (!user) throw providerError({ code: 'PT401' }, mode);
          return { user };
        },
        async logout() {
          try { await call(() => getClient().auth.signOut({ scope: 'local' }), 'logout'); }
          catch (error) { if (error.status !== 401) throw error; }
          verified = Promise.resolve(null);
        },
        async readCrm() { return snapshot(await rpc('pipechat_read_crm')); },
        async writeCrm(ignoredToken, deals, expectedUpdatedAt, customFields, tableSchema) {
          if (!validVersion(expectedUpdatedAt)) throw new BackendError('Refresh before saving. A valid CRM version is required.', 400);
          const current = await adapter.readCrm();
          const data = snapshot({ deals, updatedAt: expectedUpdatedAt,
            customFields: customFields === undefined ? current.customFields : customFields,
            tableSchema: tableSchema === undefined ? current.tableSchema : tableSchema }, 400);
          try { schemaCore.transition(current.tableSchema, data.tableSchema, data.deals); }
          catch { throw new BackendError('This table schema change is not supported. Refresh before saving.', 409); }
          if (Buffer.byteLength(JSON.stringify(data)) > maxResponseBytes) throw new BackendError('The CRM snapshot is too large.', 400);
          const result = snapshot(await rpc('pipechat_write_crm', {
            p_deals: data.deals, p_custom_fields: data.customFields, p_table_schema: data.tableSchema,
            p_expected_updated_at: expectedUpdatedAt
          }));
          if (!isDeepStrictEqual(result.tableSchema, data.tableSchema) || !isDeepStrictEqual(result.customFields, data.customFields) ||
              !isDeepStrictEqual(result.deals, data.deals) || result.updatedAt === null || result.updatedAt === expectedUpdatedAt) {
            throw new BackendError('Supabase did not confirm the complete CRM snapshot. Reload before retrying.');
          }
          return result;
        },
        async readUsage() { return usage(await rpc('pipechat_read_usage')); },
        async reserveUsage(ignoredToken, requestId) {
          if (!validId(requestId)) throw new BackendError('Invalid usage request ID.', 400);
          const result = await rpc('pipechat_reserve_usage', { p_request_id: requestId });
          if (!validId(result?.reservationId)) throw invalidResponse();
          return { reservationId: result.reservationId, usage: usage(result.usage) };
        },
        async finishUsage(ignoredToken, reservationId, outcome) {
          if (!validId(reservationId) || !['commit', 'release'].includes(outcome)) throw new BackendError('Invalid usage finalization.', 400);
          return usage(await rpc('pipechat_finish_usage', { p_reservation_id: reservationId, p_outcome: outcome }));
        }
      };
      return adapter;
    }
  };
}

module.exports = { createSupabaseBackend, BackendError };
