const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const core = require('./conversation-core.js');
const { BackendError } = require('./backend-contract.js');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fields = ['epoch', 'version', 'messages', 'state', 'summary', 'summaryThrough'];
const copy = value => JSON.parse(JSON.stringify(value));
const empty = () => ({ epoch: crypto.randomUUID(), version: 0, messages: [], state: null, summary: '', summaryThrough: 0 });
const snapshot = data => copy(Object.fromEntries(fields.map(key => [key, data[key]])));
const conflict = () => { throw new BackendError('This conversation changed in another window. Reload chat before continuing.', 409); };
function uuid(value) {
  if (typeof value !== 'string' || value.length !== 36 || !UUID.test(value)) throw new BackendError('Invalid conversation ID.', 400);
  return value.toLowerCase();
}
function expected(input, keys) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== keys.length ||
    keys.some(key => !Object.hasOwn(input, key)) || !Number.isSafeInteger(input.version) || input.version < 0) throw new BackendError('Invalid conversation request.', 400);
  return { ...input, epoch: uuid(input.epoch) };
}
function title(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 160 || /[\x00-\x1f\x7f]/.test(value)) throw new BackendError('Invalid conversation title.', 400);
  return value.trim();
}
function resumedState(state, invalidated) {
  if (!state || invalidated) return null;
  return Object.fromEntries(Object.entries(state).filter(([key]) => !['clarification', 'sourceAction', 'originalCommand', 'workspaceVersion', 'savedAt'].includes(key)));
}
function page(data, before = null) {
  const eligible = data.messages.filter(message => before === null || message.seq < before), messages = eligible.slice(-50);
  const metadata = Object.fromEntries(fields.filter(key => key !== 'messages').map(key => [key, data[key]]));
  return core.validatePage({ ...metadata, messages, before: eligible.length > 50 ? messages[0].seq : null,
    memoryMessages: before === null ? data.messages.filter(message => message.seq > data.summaryThrough && message.seq <= data.messages.length - 12).slice(0, 20) : [] });
}
const terminalStatuses = ['succeeded', 'failed', 'cancelled', 'interrupted'];
const publicFailures = {
  unknown: 'The request could not be completed. Check saved activity before trying again.',
  timeout: 'The request timed out before a durable reply was saved.',
  unavailable: 'The assistant is temporarily unavailable.',
  invalid_response: "Sorry, I couldn't prepare a reliable answer. Please try again or rephrase the request.",
  validation: "Sorry, I couldn't prepare every part of that request reliably. Please try again or narrow the request.", conflict: 'The workspace changed while this request was running.',
  unauthorized: 'The request could not be completed because access changed.', quota: 'The chat usage limit was reached.'
};
function terminalPayload(status, publicErrorCode, content, resultReceipt) {
  if (!terminalStatuses.includes(status)) throw new BackendError('Invalid terminal status.', 400);
  if (status === 'succeeded') {
    if (publicErrorCode !== 'none' || typeof content !== 'string' || !content.trim() || content.length > 32000 ||
      resultReceipt !== null && (!resultReceipt || typeof resultReceipt !== 'object' || Array.isArray(resultReceipt))) throw new BackendError('Invalid successful turn.', 400);
    const safe = core.validateState({sourceAction: resultReceipt});
    return {status, publicErrorCode, content, resultReceipt: safe.sourceAction};
  }
  if (content !== null || resultReceipt !== null ||
    (status === 'failed' ? !Object.hasOwn(publicFailures, publicErrorCode) : publicErrorCode !== (status === 'cancelled' ? 'cancelled' : 'timeout'))) {
    throw new BackendError('Failures require a public error code, not raw provider text.', 400);
  }
  return {status, publicErrorCode, resultReceipt: null, content: status === 'failed' ? publicFailures[publicErrorCode] : status === 'cancelled' ?
    'The request was cancelled. Check saved activity for any completed changes.' :
    'This request was interrupted before a durable result was saved. It was not rerun.'};
}

// Local JSON mode only. The server authenticates userId and supplies its per-user
// lock. begin/finish/complete/recover are server-only, never browser-controlled
// writes. Derive the actor from the authenticated session, not request JSON.
// The legacy active fields remain at the file root. Catalog, snapshots, epoch
// aliases and completion receipts commit together with them in one atomic rename.
// Parent flow: flush user message -> begin -> only shouldRun=true calls provider
// -> await finish even after HTTP disconnect. Use the persisted user message as
// model input, not an unverified retry body. Choose a lease longer than the full
// provider timeout; expired claims cannot be renewed or rerun. A server worker
// must call recover after crashes; readConversationTurn alone is read-only.
function createConversationStore(directory, lock, {clock = () => new Date()} = {}) {
  function timestamp() {
    const at = clock();
    if (!(at instanceof Date) || !Number.isFinite(at.getTime())) throw new BackendError('Invalid server clock.', 500);
    return at.toISOString();
  }
  function filename(userId) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(userId)) throw new BackendError('Invalid account.', 400);
    return path.join(directory, 'conversations', `${userId}.json`);
  }
  async function write(file, value) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, file);
    }
    finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  }
  async function run(id, task) {
    const file = filename(id);
    return lock(`conversation:${id}`, async () => {
      let data;
      try { data = JSON.parse(await fs.readFile(file, 'utf8')); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        data = empty();
      }
      if (!Object.hasOwn(data, 'threadStore')) {
        const id = crypto.randomUUID(), at = timestamp();
        data.threadStore = { formatVersion: 1, activeId: id, turns: [], items: [{ id, title: 'New chat',
          createdAt: data.messages[0]?.createdAt || at, updatedAt: at, epochs: [data.epoch], snapshot: null,
          resetInvalidated: false, completions: [] }] };
        await write(file, data);
      }
      if (data.threadStore.formatVersion !== 1 || !Array.isArray(data.threadStore.items) ||
        !data.threadStore.items.some(item => item.id === data.threadStore.activeId)) throw new BackendError('Invalid conversation archive.', 500);
      if (!Object.hasOwn(data.threadStore, 'turns')) { data.threadStore.turns = []; await write(file, data); }
      if (!Array.isArray(data.threadStore.turns)) throw new BackendError('Invalid turn archive.', 500);
      return task(data, value => write(file, value));
    });
  }
  function current(data) { return data.threadStore.items.find(item => item.id === data.threadStore.activeId); }
  function archive(data) { current(data).snapshot = snapshot(data); }
  function touch(data) { current(data).updatedAt = timestamp(); }
  function fresh(data, name) {
    archive(data);
    const next = empty(), id = crypto.randomUUID(), at = timestamp();
    data.threadStore.items.push({ id, title: name, createdAt: at, updatedAt: at, epochs: [next.epoch], snapshot: null, resetInvalidated: false, completions: [] });
    data.threadStore.activeId = id;
    Object.assign(data, next);
    return id;
  }
  function appendTerminal(data, target, requestId, message, at) {
    const active = target.id === data.threadStore.activeId, destination = active ? data : target.snapshot;
    const prior = target.completions.find(item => item.requestId === requestId);
    const existing = destination.messages.find(item => item.id === message.id);
    if (prior && prior.messageId !== message.id || target.completions.some(item => item.messageId === message.id && item.requestId !== requestId) ||
      existing && (existing.role !== 'assistant' || existing.content !== message.content)) conflict();
    if (prior && !existing) throw new BackendError('Incomplete terminal reply receipt.', 500);
    if (!existing) {
      if (destination.version === Number.MAX_SAFE_INTEGER) throw new BackendError('Conversation version limit reached.', 400);
      destination.messages.push({...message, seq: destination.messages.length + 1, createdAt: at}); destination.version++;
    }
    if (!prior) { target.completions.push({requestId, messageId: message.id}); target.updatedAt = at; }
    return {changed: !prior, message: copy(existing || destination.messages.at(-1)), receipt: {
      threadId: target.id, messageId: message.id, seq: (existing || destination.messages.at(-1)).seq,
      version: destination.version, active, inserted: !existing }};
  }
  function finish(data, turn, payload, at) {
    if (terminalStatuses.includes(turn.status)) {
      if (!isDeepStrictEqual(payload, {status: turn.status, publicErrorCode: turn.publicErrorCode,
        content: turn.assistantMessage.content, resultReceipt: turn.resultReceipt})) conflict();
      return false;
    }
    if (at >= turn.leaseUntil) payload = terminalPayload('interrupted', 'timeout', null, null);
    const target = data.threadStore.items.find(item => item.id === turn.threadId);
    const result = appendTerminal(data, target, turn.requestId, {id: turn.assistantMessageId, role: 'assistant', content: payload.content}, at);
    Object.assign(turn, {status: payload.status, publicErrorCode: payload.publicErrorCode, resultReceipt: payload.resultReceipt,
      assistantMessage: result.message, finishedAt: at, threadVersion: result.receipt.version});
    return true;
  }
  return userId => ({
    readConversation(before = null) {
      return run(userId, async data => page(data, before));
    },
    writeConversation(input) {
      const update = core.validateWrite(input);
      return run(userId, async (data, save) => {
        if (update.epoch !== data.epoch || update.version !== data.version) conflict();
        let changed = !isDeepStrictEqual(data.state, update.state);
        for (const message of update.messages) {
          if (data.threadStore.turns.some(turn => turn.threadId === data.threadStore.activeId && turn.assistantMessageId === message.id &&
            !terminalStatuses.includes(turn.status))) throw new BackendError('This assistant message is reserved for a running turn.', 409);
          const existing = data.messages.find(item => item.id === message.id);
          if (existing && (existing.role !== message.role || existing.content !== message.content)) throw new BackendError('Conflicting chat message.', 409);
          if (!existing) { data.messages.push({ ...message, seq: data.messages.length + 1, createdAt: timestamp() }); changed = true; }
        }
        data.state = update.state;
        if (changed) {
          if (data.version === Number.MAX_SAFE_INTEGER) throw new BackendError('Conversation version limit reached.', 400);
          data.version++; touch(data); await save(data);
        }
        return { epoch: data.epoch, version: data.version };
      });
    },
    searchConversation(query, before = null) {
      const words = query.toLowerCase().split(/\s+OR\s+/i).filter(Boolean);
      return run(userId, async data => data.messages.filter(message => (before === null || message.seq < before) && words.some(word => message.content.toLowerCase().includes(word))).slice(-6));
    },
    saveConversationMemory(epoch, update, summary) {
      return run(userId, async (data, save) => {
        if (data.epoch !== epoch || data.summaryThrough !== update.expectedThrough || update.through <= data.summaryThrough || update.through > data.messages.length - 12 || typeof summary !== 'string' || !summary.trim() || summary.length > 3200) return { saved: false };
        data.summary = summary; data.summaryThrough = update.through; touch(data); await save(data); return { saved: true };
      });
    },
    listConversationThreads() {
      return run(userId, async data => ({ activeThreadId: data.threadStore.activeId, epoch: data.epoch, version: data.version,
        threads: data.threadStore.items.map(item => ({ id: item.id,
          title: item.title === 'New chat' ? (item.id === data.threadStore.activeId ? data : item.snapshot).messages.find(message => message.role === 'user')?.content.replace(/\s+/g,' ').trim().slice(0,80) || item.title : item.title,
          createdAt: item.createdAt, updatedAt: item.updatedAt,
          messageCount: (item.id === data.threadStore.activeId ? data : item.snapshot).messages.length, active: item.id === data.threadStore.activeId }))
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)) }));
    },
    newConversationThread(input) {
      const update = expected(input, ['epoch', 'version', 'title']), name = title(update.title);
      return run(userId, async (data, save) => {
        if (update.epoch !== data.epoch || update.version !== data.version) conflict();
        const threadId = fresh(data, name); await save(data);
        return { threadId, conversation: page(data) };
      });
    },
    switchConversationThread(input) {
      const update = expected(input, ['epoch', 'version', 'threadId']), id = uuid(update.threadId);
      return run(userId, async (data, save) => {
        if (update.epoch !== data.epoch || update.version !== data.version) conflict();
        const target = data.threadStore.items.find(item => item.id === id);
        if (!target) throw new BackendError('Conversation unavailable.', 404);
        if (id !== data.threadStore.activeId) {
          archive(data);
          const restored = copy(target.snapshot);
          restored.epoch = crypto.randomUUID(); restored.state = resumedState(restored.state, target.resetInvalidated);
          Object.assign(data, restored);
          target.epochs.push(restored.epoch); target.resetInvalidated = false;
          data.threadStore.activeId = id; touch(data); await save(data);
        }
        return { threadId: id, conversation: page(data) };
      });
    },
    completeConversationTurn(input) {
      if (!input || Object.keys(input).length !== 4 || !['epoch', 'requestId', 'messageId', 'content'].every(key => Object.hasOwn(input, key))) throw new BackendError('Invalid completion.', 400);
      const requestId = uuid(input.requestId);
      const checked = core.validateWrite({ epoch: input.epoch, version: 0, messages: [{ id: input.messageId, role: 'assistant', content: input.content }], state: null });
      const message = checked.messages[0];
      return run(userId, async (data, save) => {
        if (data.threadStore.turns.some(turn => turn.requestId === requestId || turn.assistantMessageId === message.id)) throw new BackendError('Use finishConversationTurn for an accepted turn.', 409);
        const target = data.threadStore.items.find(item => item.epochs.includes(checked.epoch));
        if (!target) throw new BackendError('Conversation unavailable.', 404);
        const result = appendTerminal(data, target, requestId, message, timestamp());
        if (result.changed) await save(data);
        return result.receipt;
      });
    },
    // Commit this claim before provider work. Only the FIRST acknowledged begin
    // returns shouldRun=true. A lost begin response must not trigger another call.
    // Usage/telemetry remain caller-owned; bind their identities to requestId.
    beginConversationTurn(input) {
      const update = expected(input, ['threadId','epoch','version','requestId','userMessageId','assistantMessageId','leaseSeconds']);
      for (const key of ['threadId','requestId','userMessageId','assistantMessageId']) update[key] = uuid(update[key]);
      if (!Number.isInteger(update.leaseSeconds) || update.leaseSeconds < 1 || update.leaseSeconds > 3600 || update.userMessageId === update.assistantMessageId) throw new BackendError('Invalid turn lease or message IDs.', 400);
      return run(userId, async (data, save) => {
        const at = timestamp(), prior = data.threadStore.turns.find(turn => turn.requestId === update.requestId);
        if (prior) {
          if (['threadId','epoch','userMessageId','assistantMessageId'].some(key => prior[key] !== update[key])) conflict();
          if (!terminalStatuses.includes(prior.status) && at >= prior.leaseUntil) { finish(data, prior, terminalPayload('interrupted','timeout',null,null), at); await save(data); }
          return {...copy(prior), shouldRun:false};
        }
        if (data.epoch !== update.epoch || data.version !== update.version || data.threadStore.activeId !== update.threadId) conflict();
        if (!data.messages.some(message => message.id === update.userMessageId && message.role === 'user')) throw new BackendError('Flush the user message before beginning its turn.', 409);
        if (data.messages.some(message => message.id === update.assistantMessageId) || data.threadStore.items.some(item => item.completions.some(receipt => receipt.requestId === update.requestId)) ||
          data.threadStore.turns.some(turn => turn.assistantMessageId === update.assistantMessageId || turn.threadId === update.threadId && turn.userMessageId === update.userMessageId)) conflict();
        const turn = {requestId:update.requestId, threadId:update.threadId, epoch:update.epoch,
          userMessageId:update.userMessageId, assistantMessageId:update.assistantMessageId, attempt:1, status:'running',
          acceptedAt:at, leaseUntil:new Date(Date.parse(at) + update.leaseSeconds * 1000).toISOString(), finishedAt:null,
          publicErrorCode:null, threadVersion:data.version, resultReceipt:null, assistantMessage:null};
        data.threadStore.turns.push(turn); await save(data);
        return {...copy(turn), shouldRun:true};
      });
    },
    finishConversationTurn(input) {
      if (!input || Object.keys(input).length !== 6 || !['threadId','requestId','status','publicErrorCode','content','resultReceipt'].every(key => Object.hasOwn(input,key))) throw new BackendError('Invalid terminal turn.', 400);
      const threadId = uuid(input.threadId), requestId = uuid(input.requestId);
      const payload = terminalPayload(input.status,input.publicErrorCode,input.content,input.resultReceipt);
      return run(userId, async (data, save) => {
        const turn = data.threadStore.turns.find(item => item.requestId === requestId && item.threadId === threadId);
        if (!turn) throw new BackendError('Turn unavailable.',404);
        if (finish(data,turn,payload,timestamp())) await save(data);
        return copy(turn);
      });
    },
    readConversationTurn(threadId, requestId) {
      threadId = uuid(threadId); requestId = uuid(requestId);
      return run(userId, async data => {
        const turn = data.threadStore.turns.find(item => item.threadId === threadId && item.requestId === requestId);
        if (!turn) throw new BackendError('Turn unavailable.',404);
        return copy(turn);
      });
    },
    // Server recovery worker only, including after process death or user logout.
    // Recovery records interruption; there is deliberately no reclaim/rerun API.
    recoverConversationTurns(limit = 50) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new BackendError('Invalid recovery limit.',400);
      return run(userId, async (data,save) => {
        const at = timestamp(), recovered = [];
        for (const turn of data.threadStore.turns.filter(item => !terminalStatuses.includes(item.status) && item.leaseUntil <= at).slice(0,limit)) {
          finish(data,turn,terminalPayload('interrupted','timeout',null,null),at); recovered.push(copy(turn));
        }
        if (recovered.length) await save(data);
        return {recovered};
      });
    },
    reset() {
      return run(userId, async (data, save) => {
        for (const item of data.threadStore.items) item.resetInvalidated = true;
        fresh(data, 'New chat'); await save(data);
      });
    }
  });
}
module.exports = { createConversationStore };
