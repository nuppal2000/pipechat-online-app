const { AsyncLocalStorage } = require('node:async_hooks');
const { isDeepStrictEqual } = require('node:util');
const schemaCore = require('../public/table-schema.js');
const conversation = require('./conversation-core.js');
const businessWorkspace = require('../public/business-workspace.js');
const { createBusinessAutomationService } = require('./business-automation-service.js');
const { BackendError, snapshotResult, usageResult } = require('./backend-contract.js');

const COOKIE_NAME = 'pipechat_supabase';
const unavailable = () => new BackendError('Supabase could not complete the request. No local fallback was used.');
const invalidResponse = () => new BackendError('Supabase returned invalid data. No local fallback was used.');
const validVersion = value => value === null || (typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value));
const validTimestamp = value => value === null || (typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)));
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const conversationId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
function turnReceipt(value) {
  try {
    if (!value || !['requestId','threadId','epoch','userMessageId','assistantMessageId'].every(key => conversationId(value[key])) ||
      !['running','accepted','succeeded','failed','cancelled','interrupted'].includes(value.status) || value.attempt !== 1 ||
      !validTimestamp(value.acceptedAt) || !value.acceptedAt || !validTimestamp(value.leaseUntil) || !value.leaseUntil ||
      !Number.isSafeInteger(value.threadVersion) || value.threadVersion < 0) throw new Error();
    const terminal = !['accepted','running'].includes(value.status);
    if (terminal) {
      if (!validTimestamp(value.finishedAt) || !value.finishedAt || value.assistantMessage?.id !== value.assistantMessageId || value.assistantMessage?.role !== 'assistant') throw new Error();
      conversation.validatePage({epoch:value.epoch,version:value.threadVersion,messages:[value.assistantMessage],state:null,before:null,summary:'',summaryThrough:0,memoryMessages:[]});
      conversation.validateState({sourceAction:value.resultReceipt});
    } else if (value.assistantMessage !== null || value.finishedAt !== null || value.resultReceipt !== null) throw new Error();
    if (Object.hasOwn(value,'shouldRun') && (typeof value.shouldRun !== 'boolean' || value.shouldRun && terminal)) throw new Error();
    return value;
  } catch { throw invalidResponse(); }
}

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
  const sqlStatuses = { PT400: 400, PT401: 401, PT402: 402, PT403: 403, PT404: 404, PT409: 409 };
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
    404: 'The requested conversation or turn is unavailable.',
    409: operation === 'signup' ? 'An account with that email already exists.' : operation.includes('usage') ?
      'The chat reservation is no longer available. No CRM changes were applied.' : operation.includes('conversation') ?
      'This conversation changed in another window. Reload chat before continuing.' :
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
      if (result?.ok !== true || result.contract !== 'pipechat-supabase-v1' || result.schemaVersion !== 1 || result.featureVersion !== 2) {
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

      const workflowService = createBusinessAutomationService({ rpc });
      async function workflowMutation(method, input) {
        let pending;
        try { pending = workflowService[method](input); }
        catch { throw new BackendError('Invalid workflow request. Review it again.', 400); }
        try {
          const result = await pending;
          return { ...result, snapshot: { ...snapshot(result.snapshot), workflows: result.snapshot.workflows } };
        } catch (error) { if (error instanceof BackendError) throw error; throw invalidResponse(); }
      }
      const adapter = {
        getUser,
        async readWorkflows() {
          try { return await workflowService.read(); }
          catch (error) { if (error instanceof BackendError) throw error; throw invalidResponse(); }
        },
        createWorkflow(input) { return workflowMutation('create', input); },
        setWorkflowActivation(input) { return workflowMutation('setActivation', input); },
        retryWorkflowEvent(input) { return workflowMutation('retry', input); },
        async readWorkflowHistory(workflowId, limit = 50) {
          if (typeof workflowId !== 'string' || !/^workflow_[a-z0-9_]{1,60}$/.test(workflowId) ||
            !Number.isInteger(limit) || limit < 1 || limit > 200) throw new BackendError('Invalid workflow history request.', 400);
          const collection = await adapter.readWorkflows();
          if (!collection.workflows.some(w => w.id === workflowId)) throw new BackendError('Workflow unavailable.', 404);
          return require('./business-workflows.js').plan({ action: 'workflow_history', workflowId, limit }, collection);
        },
        async readBusiness(workspaceId=null) {
          if(workspaceId!==null&&!/^[0-9a-f-]{36}$/.test(workspaceId))throw new BackendError('Invalid workspace.',400);
          const result=await rpc('business_workspace_get',{p_workspace:workspaceId});
          try{
            if(!result||!Number.isSafeInteger(result.version)||!['owner','editor','viewer'].includes(result.role)||!Array.isArray(result.primary?.records))throw new Error();
            businessWorkspace.validate(result.state,{workspaceId:result.workspaceId,legacyRecordIds:result.primary.records.map(row=>row.recordId)});
          }catch{throw invalidResponse();}
          return result;
        },
        async listBusinessWorkspaces(){
          const result=await rpc('business_workspace_list');if(!Array.isArray(result))throw invalidResponse();return {workspaces:result};
        },
        async readBusinessHistory(workspaceId,entityId,after='0'){
          if(typeof workspaceId!=='string'||!/^[0-9a-f-]{36}$/.test(workspaceId)||typeof entityId!=='string'||
            !/^(?:ent_[0-9a-f-]{36}|legacy:[0-9a-f-]{36}:[1-9][0-9]*)$/.test(entityId)||
            typeof after!=='string'||!/^(0|[1-9][0-9]{0,18})$/.test(after)||BigInt(after)>9223372036854775807n)throw new BackendError('Invalid record history request.',400);
          const result=await rpc('business_workspace_history',{p_workspace:workspaceId,p_entity_id:entityId,p_after:after});
          if(!result||result.workspaceId!==workspaceId||result.entityId!==entityId||!Array.isArray(result.events)||result.events.length>50||
            result.events.some(event=>!event||!['create','update','delete','link','unlink'].includes(event.kind)||typeof event.id!=='string')||
            result.nextAfter!==null&&(typeof result.nextAfter!=='string'||!/^[1-9][0-9]*$/.test(result.nextAfter)))throw invalidResponse();
          return result;
        },
        async writeBusiness(input){
          const current=await adapter.readBusiness(input.workspaceId);
          if(current.scope!=='workspace'||!['owner','editor'].includes(current.role))throw new BackendError('This workspace is read-only.',403);
          try{businessWorkspace.validate(input.next,{workspaceId:current.workspaceId,legacyRecordIds:current.primary.records.map(row=>row.recordId)});businessWorkspace.transition(current.state,input.next);}
          catch{throw new BackendError('Invalid entity change. Nothing was saved.',400);}
          return rpc('business_workspace_cas',{p_workspace:current.workspaceId,p_expected_version:input.expectedVersion,p_state:input.next,p_expected_primary_updated_at:input.expectedPrimaryUpdatedAt});
        },
        async shareBusiness(input,revoke=false){
          if(!input||!['workspace','entity','view'].includes(input.scope)||typeof input.email!=='string'||input.email.length>320||!Number.isSafeInteger(input.expectedVersion))throw new BackendError('Choose a workspace, recipient and access scope.',400);
          return rpc(revoke?'business_workspace_revoke':'business_workspace_share',{p_workspace:input.workspaceId,p_email:input.email,p_scope:input.scope,p_resource_id:input.resourceId??null,...(!revoke?{p_role:input.role}:{}),p_expected_version:input.expectedVersion});
        },
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
        async readCrm() { return snapshot(await rpc('pipechat_read_workspace')); },
        async listConversationThreads() {
          const result = await rpc('pipechat_list_conversation_threads');
          if (!conversationId(result?.activeThreadId) || !conversationId(result?.epoch) || !Number.isSafeInteger(result.version) || result.version < 0 ||
            !Array.isArray(result.threads) || !result.threads.some(item => item.id === result.activeThreadId && item.active) ||
            result.threads.some(item => !conversationId(item.id) || typeof item.title !== 'string' || item.title.length > 160 ||
              !Number.isSafeInteger(item.messageCount) || item.messageCount < 0 || typeof item.active !== 'boolean' || !validTimestamp(item.createdAt) || !validTimestamp(item.updatedAt))) throw invalidResponse();
          return result;
        },
        async newConversationThread({epoch,version,title}) {
          if (!conversationId(epoch) || !Number.isSafeInteger(version) || version < 0 || typeof title !== 'string' || !title.trim() || title.length > 160) throw new BackendError('Invalid conversation request.',400);
          const result = await rpc('pipechat_new_conversation_thread',{p_epoch:epoch,p_expected_version:version,p_title:title});
          try { if (!conversationId(result.threadId)) throw new Error(); return {threadId:result.threadId,conversation:conversation.validatePage(result.conversation)}; } catch { throw invalidResponse(); }
        },
        async switchConversationThread({epoch,version,threadId}) {
          if (!conversationId(epoch) || !conversationId(threadId) || !Number.isSafeInteger(version) || version < 0) throw new BackendError('Invalid conversation request.',400);
          const result = await rpc('pipechat_switch_conversation_thread',{p_epoch:epoch,p_expected_version:version,p_thread_id:threadId});
          try { if (result.threadId !== threadId) throw new Error(); return {threadId:result.threadId,conversation:conversation.validatePage(result.conversation)}; } catch { throw invalidResponse(); }
        },
        async beginConversationTurn(input) {
          if (!input || !['threadId','epoch','requestId','userMessageId','assistantMessageId'].every(key => conversationId(input[key])) ||
            !Number.isSafeInteger(input.version) || input.version < 0 || !Number.isInteger(input.leaseSeconds) || input.leaseSeconds < 1 || input.leaseSeconds > 3600) throw new BackendError('Invalid turn request.',400);
          const result = turnReceipt(await rpc('pipechat_begin_conversation_turn',{p_thread_id:input.threadId,p_epoch:input.epoch,p_expected_version:input.version,
            p_request_id:input.requestId,p_user_message_id:input.userMessageId,p_assistant_message_id:input.assistantMessageId,p_lease_seconds:input.leaseSeconds}));
          if (['threadId','epoch','requestId','userMessageId','assistantMessageId'].some(key => result[key] !== input[key]) || typeof result.shouldRun !== 'boolean') throw invalidResponse();
          return result;
        },
        async finishConversationTurn(input) {
          if (!input || !conversationId(input.threadId) || !conversationId(input.requestId)) throw new BackendError('Invalid turn request.',400);
          const result = turnReceipt(await rpc('pipechat_finish_conversation_turn',{p_thread_id:input.threadId,p_request_id:input.requestId,
            p_status:input.status,p_public_error_code:input.publicErrorCode,p_content:input.content,p_result_receipt:input.resultReceipt}));
          if (result.threadId !== input.threadId || result.requestId !== input.requestId) throw invalidResponse();
          return result;
        },
        async readConversationTurn(threadId,requestId) {
          if (!conversationId(threadId) || !conversationId(requestId)) throw new BackendError('Invalid turn request.',400);
          const result = turnReceipt(await rpc('pipechat_read_conversation_turn',{p_thread_id:threadId,p_request_id:requestId}));
          if (result.threadId !== threadId || result.requestId !== requestId) throw invalidResponse();
          return result;
        },
        async recoverConversationTurns(limit=50) {
          if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new BackendError('Invalid recovery limit.',400);
          const result = await rpc('pipechat_recover_conversation_turns',{p_limit:limit});
          if (!Array.isArray(result?.recovered) || result.recovered.length > limit) throw invalidResponse();
          return {recovered:result.recovered.map(turnReceipt)};
        },
        async readConversation(before = null) {
          if (before !== null && (!Number.isSafeInteger(before) || before < 1)) throw new BackendError('Invalid chat page.', 400);
          const result = await rpc('pipechat_read_conversation', { p_before: before });
          try { return conversation.validatePage(result); } catch { throw invalidResponse(); }
        },
        async writeConversation(input) {
          let data;
          try { data = conversation.validateWrite(input); } catch { throw new BackendError('Invalid conversation update.', 400); }
          const result = await rpc('pipechat_write_conversation', { p_epoch: data.epoch, p_expected_version: data.version,
            p_messages: data.messages, p_state: data.state });
          if (result?.epoch !== data.epoch || !Number.isSafeInteger(result.version) || result.version < data.version) throw invalidResponse();
          return result;
        },
        async searchConversation(query, before = null) {
          if (typeof query !== 'string' || query.length > 300 || before !== null && (!Number.isSafeInteger(before) || before < 1)) throw new BackendError('Invalid conversation search.', 400);
          const result = await rpc('pipechat_search_conversation', { p_query: query, p_before: before });
          if (!Array.isArray(result) || result.length > 6) throw invalidResponse();
          return result;
        },
        async saveConversationMemory(epoch, update, summary) {
          if (typeof summary !== 'string' || !summary.trim() || summary.length > 3200) return { saved: false };
          const result = await rpc('pipechat_save_conversation_memory', { p_epoch: epoch, p_expected_through: update.expectedThrough,
            p_through: update.through, p_summary: summary });
          if (typeof result?.saved !== 'boolean') throw invalidResponse();
          return result;
        },
        async resetCrm(ignoredToken, expectedUpdatedAt) {
          if (!validVersion(expectedUpdatedAt)) throw new BackendError('Refresh before resetting. A valid CRM version is required.', 400);
          const result = snapshot(await rpc('pipechat_reset_crm', { p_expected_updated_at: expectedUpdatedAt, p_confirm: true }));
          if (result.deals.length || result.customFields.length || result.todoCards?.length || !isDeepStrictEqual(result.tableSchema, { status: 'pending' }) ||
              result.updatedAt === null || result.updatedAt === expectedUpdatedAt) {
            throw new BackendError('Supabase did not confirm the reset. Reload before retrying.');
          }
          return result;
        },
        async writeCrm(ignoredToken, deals, expectedUpdatedAt, customFields, tableSchema, todoCards, metadata = {}) {
          if (!validVersion(expectedUpdatedAt)) throw new BackendError('Refresh before saving. A valid CRM version is required.', 400);
          const current = await adapter.readCrm();
          const data = snapshot({ deals, updatedAt: expectedUpdatedAt, todoCards: todoCards === undefined ? require('../public/todo-core.js').reconcile(current.todoCards, deals) : todoCards,
            customFields: customFields === undefined ? current.customFields : customFields,
            tableSchema: tableSchema === undefined ? current.tableSchema : tableSchema }, 400);
          // A stale request can be an exact retry. Let the atomic RPC replay it
          // before evaluating current-state transition rules or rejecting its CAS.
          try { if (current.updatedAt === expectedUpdatedAt) schemaCore.transition(current.tableSchema, data.tableSchema, data.deals); }
          catch { throw new BackendError('This table schema change is not supported. Refresh before saving.', 409); }
          if (Buffer.byteLength(JSON.stringify(data)) > maxResponseBytes) throw new BackendError('The CRM snapshot is too large.', 400);
          const journal = require('./action-journal.js');
          let meta;
          try { meta = journal.prepareMetadata(metadata, { kind: 'crm', data }); }
          catch { throw new BackendError('Invalid action or import receipt metadata.', 400); }
          if (meta.schemaChanges !== undefined && current.updatedAt === expectedUpdatedAt) {
            try { require('./schema-changes').transition(current, data, meta.schemaChanges); }
            catch { throw new BackendError('The explicit choice rename does not match the current schema and cells.', 409); }
          }
          const result = await adapter.journalSaveResult(await rpc('pipechat_commit_action', {
            p_action_id: meta.actionId, p_request_id: meta.requestId, p_conversation_id: meta.conversationId,
            p_plan_id: meta.planId, p_expected_updated_at: expectedUpdatedAt,
            p_workspace: { deals: data.deals, customFields: data.customFields, tableSchema: data.tableSchema, todoCards: data.todoCards },
            p_metadata: { ...(meta.importReceipt ? { importReceipt: meta.importReceipt } : {}),
              ...(meta.schemaChanges === undefined ? {} : { schemaChanges: meta.schemaChanges }) }
          }), meta, expectedUpdatedAt);
          if (meta.schemaChanges !== undefined) {
            try {
              if (!Array.isArray(result.workflows)) throw new Error();
              for (const workflow of result.workflows) require('../public/business-actions.js').validateWorkflowSpec(workflow.spec, data.tableSchema, data.customFields);
            } catch { throw new BackendError('Supabase did not confirm the workflow dependencies of this schema change. Reload before retrying.'); }
          }
          const generated = new Set((result.workflows || []).flatMap(w => w.executions.filter(e => e.status === 'succeeded').map(e => e.taskId)));
          const requested = new Map(data.todoCards.map(card => [card.id, card]));
          const cardsMatch = data.todoCards.every(card => result.todoCards.some(saved => isDeepStrictEqual(saved, card))) &&
            result.todoCards.every(card => requested.has(card.id) || generated.has(card.id));
          if (!isDeepStrictEqual(result.tableSchema, data.tableSchema) || !isDeepStrictEqual(result.customFields, data.customFields) ||
              !isDeepStrictEqual(result.deals, data.deals) || !cardsMatch) {
            throw new BackendError('Supabase did not confirm the complete CRM snapshot. Reload before retrying.');
          }
          return result;
        },
        async writeTodo(cards, expectedUpdatedAt, metadata = {}) {
          if (!validVersion(expectedUpdatedAt)) throw new BackendError('Refresh before saving. A valid CRM version is required.', 400);
          const current = await adapter.readCrm();
          let data;
          if (current.updatedAt === expectedUpdatedAt) data = snapshot({ ...current, todoCards: cards }, 400);
          else {
            // A committed retry can refer to a record subsequently deleted. Check
            // card structure here; the RPC compares receipts before current CAS.
            try {
              if (!Array.isArray(cards)) throw new Error();
              const references = cards.filter(c => Number.isSafeInteger(c?.recordId) && c.recordId > 0).map(c => ({ id: c.recordId }));
              data = { todoCards: require('../public/todo-core.js').validate(cards, references) };
            } catch { throw new BackendError('Invalid To Do cards.', 400); }
          }
          let meta;
          try {
            meta = require('./action-journal.js').prepareMetadata(metadata, { kind: 'todo', cards: data.todoCards, expectedUpdatedAt });
            if (meta.importReceipt) throw new Error();
          } catch { throw new BackendError('Invalid card action metadata.', 400); }
          const result = await adapter.journalSaveResult(await rpc('pipechat_commit_todo_action', {
            p_action_id: meta.actionId, p_request_id: meta.requestId, p_conversation_id: meta.conversationId,
            p_plan_id: meta.planId, p_todo_cards: data.todoCards, p_expected_updated_at: expectedUpdatedAt, p_metadata: {}
          }), meta, expectedUpdatedAt);
          if ((!result.replayed && (!isDeepStrictEqual(result.deals, current.deals) || !isDeepStrictEqual(result.tableSchema, current.tableSchema) ||
              !isDeepStrictEqual(result.customFields, current.customFields))) || !isDeepStrictEqual(result.todoCards, data.todoCards)) {
            throw new BackendError('Supabase did not confirm the card-only save. Reload before retrying.');
          }
          return result;
        },
        journalSaveResult(raw, meta, expectedUpdatedAt, undoOf = null) {
          try {
            const receipt = require('./action-journal.js').validateReceipt(raw?.receipt);
            if (typeof raw.replayed !== 'boolean' || receipt.actionId !== meta.actionId || receipt.requestId !== meta.requestId ||
                receipt.undoOf !== undoOf || receipt.beforeVersion !== expectedUpdatedAt ||
                !undoOf && (receipt.conversationId !== meta.conversationId || receipt.planId !== meta.planId ||
                  !isDeepStrictEqual(receipt.importReceipt, meta.importReceipt))) throw new Error();
            const result = snapshot(raw.snapshot);
            if (!Array.isArray(result.todoCards) || result.updatedAt === null || result.updatedAt === expectedUpdatedAt || result.updatedAt !== receipt.afterVersion) throw new Error();
            if (raw.snapshot.workflows !== undefined) {
              if (!Array.isArray(raw.snapshot.workflows) || raw.snapshot.workflows.length > 1000) throw new Error();
              result.workflows = raw.snapshot.workflows.map(require('./business-workflows.js').validateState);
            }
            return { ...result, actionReceipt: receipt, replayed: raw.replayed,
              ...(receipt.importReceipt ? { importReceipt: receipt.importReceipt } : {}) };
          } catch { throw new BackendError('Supabase did not confirm the journaled save. Reload before retrying.'); }
        },
        async undoAction(actionId, expectedUpdatedAt, metadata = {}) {
          const journal = require('./action-journal.js');
          let target, meta;
          try {
            target = journal.identifier(actionId);
            if (!validVersion(expectedUpdatedAt) || expectedUpdatedAt === null ||
                Object.keys(metadata).some(key => !['actionId', 'requestId'].includes(key))) throw new Error();
            meta = journal.prepareMetadata(metadata, { kind: 'undo', actionId: target, expectedUpdatedAt });
          } catch { throw new BackendError('Invalid undo request.', 400); }
          return adapter.journalSaveResult(await rpc('pipechat_undo_action', { p_action_id: target,
            p_undo_action_id: meta.actionId, p_request_id: meta.requestId, p_expected_updated_at: expectedUpdatedAt }), meta, expectedUpdatedAt, target);
        },
        async readAction(actionId) {
          const journal = require('./action-journal.js');
          let id;
          try { id = journal.identifier(actionId); } catch { throw new BackendError('Invalid action ID.', 400); }
          const raw = await rpc('pipechat_read_action', { p_action_id: id });
          if (raw === null) return null;
          try {
            const entry = journal.validateEntry(raw.entry), receipt = journal.validateReceipt(raw.receipt);
            if (entry.actionId !== id || receipt.actionId !== id || typeof raw.undoInvalidated !== 'boolean') throw new Error();
            for (const key of ['requestId','conversationId','planId','undoOf','beforeVersion','afterVersion']) if (entry[key] !== receipt[key]) throw new Error();
            return { entry, receipt, undoneBy: raw.undoneBy === null ? null : journal.identifier(raw.undoneBy), undoInvalidated: raw.undoInvalidated };
          } catch { throw invalidResponse(); }
        },
        async listActions({ before = null, limit = 20 } = {}) {
          const journal = require('./action-journal.js');
          let cursor;
          try { cursor = journal.validateCursor(before); if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error(); }
          catch { throw new BackendError('Invalid action page.', 400); }
          const raw = await rpc('pipechat_list_actions', { p_before: cursor, p_limit: limit });
          try {
            if (!Array.isArray(raw.actions) || raw.actions.length > limit) throw new Error();
            const actions = raw.actions.map(item => {
              const receipt = journal.validateReceipt(item.receipt);
              journal.validateCursor({ createdAt: item.createdAt, actionId: receipt.actionId });
              if (typeof item.undoInvalidated !== 'boolean') throw new Error();
              if(item.paths!==undefined&&(!Array.isArray(item.paths)||item.paths.some(p=>!Array.isArray(p)||p.some(v=>typeof v!=='string'))))throw new Error();
              return { receipt, createdAt: item.createdAt, undoneBy: item.undoneBy === null ? null : journal.identifier(item.undoneBy), undoInvalidated: item.undoInvalidated,...(item.paths?{paths:item.paths}:{}) };
            });
            return { actions, before: journal.validateCursor(raw.before) };
          } catch { throw invalidResponse(); }
        },
        async recordTelemetry(input) {
          const telemetry = require('./beta-telemetry.js');
          let event;
          try { event = input?.formatVersion === 1 ? telemetry.validateStoredEvent(input) : telemetry.sanitizeEvent(input); }
          catch { throw new BackendError('Invalid telemetry event.', 400); }
          const result = await rpc('pipechat_record_beta_event', { p_event: event });
          if (result?.eventId !== event.eventId || typeof result.inserted !== 'boolean') throw invalidResponse();
          return { eventId: result.eventId, inserted: result.inserted };
        },
        async readTelemetry({ limit = 20, requestId = null } = {}) {
          if (!Number.isInteger(limit) || limit < 1 || limit > 100 || requestId !== null &&
              (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId))) {
            throw new BackendError('Invalid telemetry page.', 400);
          }
          const result = await rpc('pipechat_list_beta_events', { p_limit: limit, p_request_id: requestId?.toLowerCase() ?? null });
          try {
            if (!Array.isArray(result) || result.length > limit) throw new Error();
            return result.map(item => {
              const event = require('./beta-telemetry.js').validateStoredEvent(item.event);
              if (!validTimestamp(item.recordedAt) || item.recordedAt === null || requestId && event.requestId !== requestId.toLowerCase()) throw new Error();
              return { event, recordedAt: item.recordedAt };
            });
          } catch { throw invalidResponse(); }
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
