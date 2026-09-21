const core = require('../public/pipeline-core.js');

class BackendError extends Error {
  constructor(message, status = 503, usage) {
    super(message);
    this.name = 'BackendError';
    this.status = status;
    this.usage = usage;
  }
}

function publicUser(input) {
  const user = input?.user ?? input;
  if (!user || !['string', 'number'].includes(typeof user.id) || !String(user.id) ||
      typeof user.email !== 'string' || !user.email.includes('@') ||
      (user.name != null && typeof user.name !== 'string')) {
    throw new BackendError('Xano returned an invalid user. Check the auth endpoint response.');
  }
  return { id: user.id, email: user.email, name: user.name || '' };
}

function usageResult(input) {
  const usage = input?.usage ?? input;
  for (const key of ['used', 'limit', 'reserved']) {
    if (!Number.isSafeInteger(usage?.[key]) || usage[key] < 0) {
      throw new BackendError('Xano returned invalid usage data.');
    }
  }
  const remaining = Math.max(usage.limit - usage.used - usage.reserved, 0);
  if (usage.remaining !== remaining) throw new BackendError('Xano usage totals are inconsistent.');
  return { used: usage.used, limit: usage.limit, reserved: usage.reserved, remaining,
    paymentRequired: remaining === 0, updatedAt: usage.updatedAt ?? null };
}

function snapshotResult(input) {
  if (!input || !Array.isArray(input.deals) || input.deals.length > 2000 ||
      !(input.updatedAt === null || (typeof input.updatedAt === 'string' && input.updatedAt.length > 0))) {
    throw new BackendError('Xano returned invalid CRM data. Nothing has been replaced locally.');
  }
  const ids = new Set();
  const deals = input.deals.map(record => {
    if (!record || !Number.isSafeInteger(record.id) || record.id < 1 || ids.has(record.id)) {
      throw new BackendError('Xano returned invalid or duplicate deal IDs.');
    }
    ids.add(record.id);
    const result = { id: record.id };
    try {
      for (const field of Object.keys(core.fields)) result[field] = core.validateValue(field, record[field]);
      if (!Array.isArray(record.history) || record.history.some(item => typeof item !== 'string')) throw new Error('Invalid history');
      result.history = record.history;
      result.activity = typeof record.activity === 'string' ? record.activity : '';
      result.health = typeof record.health === 'string' ? record.health : '';
    } catch {
      throw new BackendError('Xano returned a deal that does not match the PipeChat schema.');
    }
    return result;
  });
  // Do not leak internal Xano IDs, credentials or fields through the proxy.
  return { deals, updatedAt: input.updatedAt };
}

function createXanoBackend({ baseUrl, serverKey, fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  let url;
  try { url = new URL(baseUrl); } catch { throw new Error('Set XANO_API_BASE_URL to the HTTPS URL of your PipeChat API group.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname.includes('/api:meta')) {
    throw new Error('XANO_API_BASE_URL must be an HTTPS application API group URL, not a metadata URL or token.');
  }
  if (typeof serverKey !== 'string' || serverKey.trim().length < 32 || /[\r\n]/.test(serverKey)) {
    throw new Error('Set XANO_SERVER_KEY to a private server-to-server key of at least 32 characters.');
  }
  const base = url.toString().replace(/\/$/, '') + '/';
  async function request(endpoint, { method = 'GET', token, body } = {}) {
    const headers = { Accept: 'application/json', 'X-PipeChat-Key': serverKey };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    let response, payload;
    try {
      response = await fetchImpl(new URL(endpoint, base), {
        method, headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      payload = await response.json();
    } catch {
      // Upstream errors can contain tokens, request bodies or infrastructure details.
      throw new BackendError('Xano could not be reached or returned an unreadable response. No local fallback was used.');
    }
    if (!response.ok) {
      let usage;
      if (response.status === 402 && payload?.usage) usage = usageResult(payload.usage);
      const messages = {
        400: 'Xano rejected this request. Check the input and endpoint configuration.',
        401: endpoint === 'auth/login' ? 'Email or password is incorrect.' : 'Your session has expired. Please sign in again.',
        403: 'Xano denied access. Check the server key and user permissions.',
        404: 'A required PipeChat endpoint is missing in Xano.',
        409: endpoint === 'auth/signup' ? 'An account with that email already exists.' : endpoint.startsWith('chat-usage/') ? 'The chat reservation is no longer available. No CRM changes were applied.' : 'This CRM changed in another window. Refresh before saving; this change was not applied.',
        402: 'Free chatbot usage limit reached. Manual CRM editing is still available.',
        429: 'Xano is temporarily rate limiting requests. Please try again shortly.'
      };
      const status = [400, 401, 403, 409, 402, 429].includes(response.status) ? response.status : 503;
      throw new BackendError(messages[response.status] || 'Xano could not complete the request. No local fallback was used.', status, usage);
    }
    return payload;
  }

  return {
    async check() {
      const result = await request('pipechat/health');
      const required = ['auth', 'user-scoped-crm', 'atomic-crm-save', 'atomic-usage-reservations', 'token-revocation'];
      if (result?.contract !== 'pipechat-xano-v1' || required.some(item => !result.capabilities?.includes(item))) {
        throw new BackendError('The Xano API does not match the PipeChat integration contract. Finish the Xano setup before switching backends.');
      }
      return { ok: true, contract: result.contract, capabilities: required };
    },
    async authenticate(mode, input) {
      if (!['login', 'signup'].includes(mode)) throw new Error('Unsupported authentication operation.');
      const body = { email: input.email, password: input.password, ...(mode === 'signup' ? { name: input.name || '' } : {}) };
      const response = await request(`auth/${mode}`, { method: 'POST', body });
      if (typeof response?.authToken !== 'string' || response.authToken.length < 16 || response.authToken.length > 3000 || /[\s\x00-\x1f]/.test(response.authToken)) {
        throw new BackendError('Xano did not return a valid authentication token.');
      }
      const user = publicUser(await request('auth/me', { token: response.authToken }));
      return { token: response.authToken, user };
    },
    async getUser(token) {
      if (!token) return null;
      try { return publicUser(await request('auth/me', { token })); }
      catch (error) { if (error.status === 401) return null; throw error; }
    },
    async logout(token) {
      if (!token) return;
      try { await request('auth/logout', { method: 'POST', token, body: {} }); }
      catch (error) { if (error.status !== 401) throw error; }
    },
    async readCrm(token) { return snapshotResult(await request('crm', { token })); },
    async writeCrm(token, deals, expectedUpdatedAt) {
      if (expectedUpdatedAt === undefined) throw new BackendError('Refresh before saving. A CRM version is required.', 400);
      const data = snapshotResult({ deals, updatedAt: expectedUpdatedAt });
      return snapshotResult(await request('crm', { method: 'PUT', token, body: { deals: data.deals, expectedUpdatedAt } }));
    },
    async readUsage(token) { return usageResult(await request('chat-usage', { token })); },
    async reserveUsage(token, requestId) {
      const result = await request('chat-usage/reserve', { method: 'POST', token, body: { requestId } });
      if (typeof result?.reservationId !== 'string' || !result.reservationId) throw new BackendError('Xano did not return a usage reservation.');
      return { reservationId: result.reservationId, usage: usageResult(result.usage) };
    },
    async finishUsage(token, reservationId, outcome) {
      if (!['commit', 'release'].includes(outcome)) throw new Error('Invalid usage outcome.');
      return usageResult(await request('chat-usage/finalize', { method: 'POST', token, body: { reservationId, outcome } }));
    }
  };
}

module.exports = { createXanoBackend, BackendError, snapshotResult, usageResult };
