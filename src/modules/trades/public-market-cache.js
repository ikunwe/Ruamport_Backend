// Public provider snapshots only. Never cache a user's quantities or cost basis.
const copy = value => structuredClone(value);
const REASONS = new Set(['BACKEND_PER_MINUTE_LIMIT', 'BACKEND_QUEUE_FULL', 'BACKEND_QUEUE_TIMEOUT',
  'PROVIDER_RATE_LIMIT', 'PROVIDER_ACCESS_DENIED', 'PROVIDER_HTTP_ERROR', 'PROVIDER_TIMEOUT',
  'PROVIDER_RESPONSE_INVALID', 'NETWORK_ERROR']);
function providerFailureDetails(error) {
  return { ...(REASONS.has(error.reason) ? { reason: error.reason } : {}),
    ...(['BACKEND', 'PROVIDER'].includes(error.limitSource) ? { limitSource: error.limitSource } : {}),
    ...(Number.isInteger(error.providerStatus) && error.providerStatus >= 400 && error.providerStatus <= 599
      ? { providerStatus: error.providerStatus } : {}) };
}
function createPublicMarketCache({ now = Date.now, ttlMs, maxAgeMs, maxEntries = 1000 }) {
  const entries = new Map();
  const pending = new Map();
  return async function cached(key, load, unavailable, stillValid = () => true) {
    const old = entries.get(key);
    const usable = old?.value && now() - old.fetchedMs < maxAgeMs && stillValid(old.value);
    const snapshot = (stale, error) => ({ ...copy(old.value), fromCache: true, isStale: stale,
      ...(error ? { warning: error.code, retryAt: new Date(error.retryAt).toISOString() } : {}) });
    if (usable && now() < old.fetchedMs + ttlMs) return snapshot(false);
    if (pending.has(key)) return copy(await pending.get(key));
    if (old?.retryAt > now()) return usable ? snapshot(true, old) : unavailable(old);
    const work = (async () => {
      let entry;
      let result;
      try {
        const data = await load();
        const fetchedMs = now();
        result = { ...data, fetchedAt: new Date(fetchedMs).toISOString(),
          expiresAt: new Date(fetchedMs + ttlMs).toISOString(), fromCache: false, isStale: false };
        entry = { value: result, fetchedMs };
      } catch (error) {
        const safe = { code: error.safeCode || 'MARKET_DATA_NOT_AVAILABLE', ...providerFailureDetails(error),
          retryAt: Number.isFinite(error.retryAt) ? error.retryAt : now() + 60_000 };
        entry = { ...(usable ? old : {}), ...safe };
        result = usable ? snapshot(true, safe) : unavailable(safe);
      }
      entries.delete(key);
      entries.set(key, entry);
      while (entries.size > maxEntries) {
        const removable = [...entries.keys()].find(candidate => !pending.has(candidate));
        if (!removable) break;
        entries.delete(removable);
      }
      return result;
    })();
    pending.set(key, work);
    try { return copy(await work); } finally { pending.delete(key); }
  };
}
function createProviderClient({ fetchData = globalThis.fetch, now = Date.now, origin, apiKey,
  perMinute, prefix, timeoutMs = 5000, queueWaitMs = 0, maxQueued = 64,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (!Number.isSafeInteger(queueWaitMs) || queueWaitMs < 0 || queueWaitMs > 65000
    || !Number.isSafeInteger(maxQueued) || maxQueued < 1 || maxQueued > 1000) throw new Error('Invalid provider queue limits');
  let attempts = [];
  let blockedUntil = 0;
  let blockedCode;
  let blockedDetails;
  let admissionTail = Promise.resolve();
  let queued = 0;
  const error = (code, retryAt = now() + 60_000, details = {}) => Object.assign(new Error('Market data unavailable'),
    { safeCode: code, retryAt, ...providerFailureDetails(details) });
  const localLimit = (reason, retryAt) => error(prefix + '_RATE_LIMITED', retryAt,
    { reason, limitSource: 'BACKEND' });
  async function reserve() {
    if (queued >= maxQueued) throw localLimit('BACKEND_QUEUE_FULL', Math.max(now() + 1000, (attempts[0] || now()) + 60_000));
    const deadline = now() + queueWaitMs;
    const previous = admissionTail;
    let release;
    admissionTail = new Promise(resolve => { release = resolve; });
    queued++;
    try {
      await previous;
      for (;;) {
        attempts = attempts.filter(at => now() - at < 60_000);
        if (now() < blockedUntil) throw error(blockedCode, blockedUntil, blockedDetails);
        if (queueWaitMs && now() > deadline) throw localLimit('BACKEND_QUEUE_TIMEOUT',
          attempts.length >= perMinute ? attempts[0] + 60_000 : now() + 1000);
        if (attempts.length < perMinute) { attempts.push(now()); return; }
        const retryAt = attempts[0] + 60_000;
        if (!queueWaitMs) throw localLimit('BACKEND_PER_MINUTE_LIMIT', retryAt);
        if (retryAt > deadline) throw localLimit('BACKEND_QUEUE_TIMEOUT', retryAt);
        // Admission is FIFO; network I/O is not held under this lock. Keep the
        // original rolling-window budget rather than increasing provider traffic.
        await wait(Math.min(60_000, Math.max(1, retryAt - now())));
      }
    } finally { queued--; release(); }
  }
  return {
    error,
    async get(path, params = {}) {
      if (apiKey !== undefined && !apiKey?.trim()) throw error('SEC_API_KEY_MISSING', now() + 60_000);
      await reserve();
      try {
        const url = new URL(path, origin);
        if (url.origin !== origin) throw error(prefix + '_NOT_AVAILABLE');
        url.search = new URLSearchParams(params).toString();
        const response = await fetchData(url.toString(), { headers: { Accept: 'application/json',
          ...(apiKey === undefined ? { 'User-Agent': 'PortfolioManage-Backend/1.0' } : { 'Ocp-Apim-Subscription-Key': apiKey }) },
        signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
        if (!response.ok) {
          const code = [421, 429].includes(response.status) ? prefix + '_RATE_LIMITED'
            : [401, 403].includes(response.status) ? prefix + '_ACCESS_DENIED' : prefix + '_NOT_AVAILABLE';
          let retryAt = now() + ([401, 403].includes(response.status) ? 300_000 : 60_000);
          const header = response.headers?.get?.('retry-after');
          const hint = header && /^\d+$/.test(header) ? now() + Number(header) * 1000 : Date.parse(header);
          if (Number.isFinite(hint)) retryAt = Math.max(retryAt, Math.min(hint, now() + 3_600_000));
          const details = { providerStatus: response.status,
            reason: [421, 429].includes(response.status) ? 'PROVIDER_RATE_LIMIT'
              : [401, 403].includes(response.status) ? 'PROVIDER_ACCESS_DENIED' : 'PROVIDER_HTTP_ERROR',
            ...([421, 429].includes(response.status) ? { limitSource: 'PROVIDER' } : {}) };
          if ([421, 429, 401, 403].includes(response.status)) {
            blockedUntil = retryAt; blockedCode = code;
            blockedDetails = details;
          }
          throw error(code, retryAt, details);
        }
        if (response.status === 204) return null;
        return await response.json();
      } catch (caught) {
        // Never return upstream messages, response bodies or request headers.
        if (caught.safeCode) throw caught;
        throw error(prefix + '_NOT_AVAILABLE', now() + 60_000, {
          reason: caught.name === 'TimeoutError' || caught.name === 'AbortError' ? 'PROVIDER_TIMEOUT'
            : caught instanceof SyntaxError ? 'PROVIDER_RESPONSE_INVALID' : 'NETWORK_ERROR' });
      }
    },
  };
}
module.exports = { createPublicMarketCache, createProviderClient, providerFailureDetails };
