/* The archive is independent of the small context sent to the model. */
(function (root) {
  'use strict';
  function create({ api, changed = () => {}, uuid = () => crypto.randomUUID() }) {
    let page = null, outbox = [], desired = null, savedState = 'null', stopped = false;
    let timer, running = null, failure = null;
    const clone = value => JSON.parse(JSON.stringify(value));
    const signature = value => JSON.stringify(value, (_, item) => item && !Array.isArray(item) && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
    const dirty = () => Boolean(outbox.length || page && signature(desired) !== savedState);
    function notify() { if (!stopped) changed({ ready: Boolean(page), dirty: dirty(), saving: Boolean(running), error: failure }); }
    async function flush() {
      clearTimeout(timer);
      if (stopped) throw new Error('The conversation is closed.');
      if (running) { await running; return flush(); }
      if (!page) throw new Error('Reload chat before sending a message.');
      if (!dirty()) return { epoch: page.epoch, version: page.version };
      const state = clone(desired), messages = [];
      for (const message of outbox.slice(0, 20)) {
        if (messages.length && new TextEncoder().encode(JSON.stringify({state,messages:[...messages,message]})).length > 60000) break;
        messages.push(message);
      }
      const body = { epoch: page.epoch, version: page.version, messages, state };
      running = (async () => {
        try {
          let result;
          try { result = await api('/api/conversation', { method: 'PUT', body: JSON.stringify(body) }); }
          catch (error) {
            if (error.status !== 409) throw error;
            // A lost acknowledgement may have committed. Recognize it, never replay a paid turn.
            const latest = await api('/api/conversation');
            const same = latest.epoch === body.epoch && messages.every(message => latest.messages.some(item => item.id === message.id && item.role === message.role && item.content === message.content));
            if (!same || signature(latest.state) !== signature(body.state)) throw error;
            result = latest;
          }
          if (stopped) return;
          if (result.epoch !== page.epoch || !Number.isSafeInteger(result.version)) throw new Error('Chat save was not confirmed.');
          page.version = result.version; savedState = signature(state);
          outbox = outbox.slice(messages.length); failure = null;
        } catch (error) {
          if (!stopped) failure = error;
          throw error;
        } finally { running = null; notify(); }
      })();
      notify(); await running;
      if (stopped) throw new Error('The conversation is closed.');
      return flush();
    }
    function schedule() {
      if (!page || stopped) return;
      clearTimeout(timer); timer = setTimeout(() => { flush().catch(() => {}); }, 180); notify();
    }
    return {
      async load() {
        const loaded = await api('/api/conversation');
        if (stopped) return null;
        if (!loaded || !Array.isArray(loaded.messages) || typeof loaded.epoch !== 'string' || !Number.isSafeInteger(loaded.version)) throw new Error('The saved chat could not be loaded.');
        page = loaded; desired = clone(page.state); savedState = signature(desired); failure = null; notify();
        return clone(page);
      },
      async older() {
        if (!page?.before || stopped) return [];
        const epoch = page.epoch, before = page.before;
        const older = await api(`/api/conversation?before=${before}`);
        if (stopped) return [];
        if (older.epoch !== epoch) throw new Error('The workspace was reset. Reload chat.');
        if (page.before !== before) return [];
        page.before = older.before; return older.messages;
      },
      add(role, content) {
        if (!page || stopped) return;
        const text = String(content);
        for (let offset = 0; offset < text.length;) {
          let end = Math.min(offset + 5000, text.length);
          if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
          const part = text.slice(offset, end);
          if (part.trim()) outbox.push({ id: uuid(), role, content: part });
          offset = end;
        }
        schedule();
      },
      state(value) {
        if (!page || stopped) return;
        const next = clone(value);
        if (signature(next) !== signature(desired)) { desired = next; schedule(); }
      },
      flush,
      stop() { stopped = true; clearTimeout(timer); },
      get dirty() { return dirty(); },
      get ready() { return Boolean(page) && !stopped; },
      get before() { return page?.before || null; }
    };
  }
  root.PipeChatConversation = { create };
  if (typeof module === 'object' && module.exports) module.exports = { create };
})(typeof window === 'object' ? window : globalThis);
