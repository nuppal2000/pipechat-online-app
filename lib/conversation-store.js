const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const core = require('./conversation-core.js');
const { BackendError } = require('./backend-contract.js');

// Local JSON mode only. Hosted accounts never fall back to this store.
function createConversationStore(directory, lock) {
  function filename(userId) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(userId)) throw new BackendError('Invalid account.', 400);
    return path.join(directory, 'conversations', `${userId}.json`);
  }
  async function write(file, value) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600 }); await fs.rename(temporary, file); }
    finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  }
  async function run(id, task) {
    const file = filename(id);
    return lock(`conversation:${id}`, async () => {
      let data;
      try { data = JSON.parse(await fs.readFile(file, 'utf8')); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        data = { epoch: crypto.randomUUID(), version: 0, messages: [], state: null, summary: '', summaryThrough: 0 };
        await write(file, data);
      }
      return task(data, value => write(file, value));
    });
  }
  return userId => ({
    readConversation(before = null) {
      return run(userId, async data => {
        const eligible = data.messages.filter(message => before === null || message.seq < before);
        const messages = eligible.slice(-50);
        return core.validatePage({ ...data, messages, before: eligible.length > 50 ? messages[0].seq : null,
          memoryMessages: before === null ? data.messages.filter(message => message.seq > data.summaryThrough && message.seq <= data.messages.length - 12).slice(0, 20) : [] });
      });
    },
    writeConversation(input) {
      const update = core.validateWrite(input);
      return run(userId, async (data, save) => {
        if (update.epoch !== data.epoch || update.version !== data.version) throw new BackendError('This conversation changed in another window. Reload chat before continuing.', 409);
        let changed = !isDeepStrictEqual(data.state, update.state);
        for (const message of update.messages) {
          const existing = data.messages.find(item => item.id === message.id);
          if (existing && (existing.role !== message.role || existing.content !== message.content)) throw new BackendError('Conflicting chat message.', 409);
          if (!existing) { data.messages.push({ ...message, seq: data.messages.length + 1, createdAt: new Date().toISOString() }); changed = true; }
        }
        data.state = update.state;
        if (changed) { data.version++; await save(data); }
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
        data.summary = summary; data.summaryThrough = update.through; await save(data); return { saved: true };
      });
    },
    reset() {
      return run(userId, async (data, save) => save({ epoch: crypto.randomUUID(), version: 0, messages: [], state: null, summary: '', summaryThrough: 0 }));
    }
  });
}
module.exports = { createConversationStore };
