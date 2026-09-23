// Counts only. No request identifiers, bodies, credentials, customers or raw paths.
const routes = new Set(['/api/auth/me', '/api/auth/signup', '/api/auth/login', '/api/auth/logout', '/api/crm-data', '/api/chat-usage', '/api/pipechat-ai']);
function createOperationalAlerts({ now = Date.now, write = line => console.log(line), minimum = 20 } = {}) {
  const buckets = new Map(), states = new Map();
  const bucketMs = 10000, windowMs = 300000;
  function evaluate() {
    const current = now();
    for (const start of buckets.keys()) if (start <= current - windowMs) buckets.delete(start);
    const total = [...buckets.values()].reduce((a, b) => ({ count: a.count + b.count, failed: a.failed + b.failed, slow: a.slow + b.slow }), { count: 0, failed: 0, slow: 0 });
    const checks = { error_rate: total.count >= minimum && total.failed / total.count >= 0.2,
      latency: total.count >= minimum && total.slow / total.count >= 0.2 };
    for (const [check, firing] of Object.entries(checks)) {
      if (states.get(check) !== firing && (states.has(check) || firing)) {
        try { write(JSON.stringify({ event: 'pipechat.alert', timestamp: new Date(current).toISOString(), check, state: firing ? 'firing' : 'resolved' })); } catch {}
      }
      states.set(check, firing);
    }
    return Object.freeze({ ok: !Object.values(checks).some(Boolean) });
  }
  function observe(event) {
    if (!routes.has(event.route) || event.outcome !== 'finished' || !Number.isInteger(event.status) || event.status < 200 || event.status > 599 || !Number.isFinite(event.durationMs) || event.durationMs < 0) return;
    if (event.status >= 400 && event.status < 500) return;
    const start = Math.floor(now() / bucketMs) * bucketMs;
    const bucket = buckets.get(start) || { count: 0, failed: 0, slow: 0 };
    bucket.count++; if (event.status >= 500) bucket.failed++;
    if (event.durationMs >= (event.route === '/api/pipechat-ai' ? 60000 : 10000)) bucket.slow++;
    buckets.set(start, bucket); evaluate();
  }
  return { observe, check: evaluate };
}
module.exports = { createOperationalAlerts };
