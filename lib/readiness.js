// Cached, single-flight read probes prevent public health checks amplifying DB load.
function createReadiness({ probe, now = Date.now, ttlMs = 30000, timeoutMs = 3500, write = line => console.log(line) }) {
  let cached = null, checkedAt = -Infinity, inFlight = null, previous;
  async function check() {
    if (cached && now() - checkedAt < ttlMs) return cached;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      let timer, ok = false;
      try {
        const controller = new AbortController();
        await Promise.race([
          Promise.resolve().then(() => probe(controller.signal)),
          new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Probe timeout')); }, timeoutMs); })
        ]);
        ok = true;
      } catch { /* Never log provider errors, URLs, keys, or response payloads. */ }
      finally { clearTimeout(timer); }
      checkedAt = now(); cached = Object.freeze({ ok });
      if (previous !== ok) {
        try { write(JSON.stringify({ event: 'pipechat.readiness', timestamp: new Date(checkedAt).toISOString(), state: ok ? 'ready' : 'unavailable' })); } catch {}
        previous = ok;
      }
      return cached;
    })();
    try { return await inFlight; } finally { inFlight = null; }
  }
  return { check };
}
module.exports = { createReadiness };
