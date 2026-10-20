const { AppError } = require('../../shared/errors/app-error');

const RATE_URL = 'https://api.frankfurter.dev/v2/rate/USD/THB';
const DAY = 86_400_000;
const unavailable = () => new AppError(503, 'FX_RATE_UNAVAILABLE', 'USD/THB reference rate is temporarily unavailable');

// Public, non-user-specific cache. Shared by holdings and the rate endpoint in this process.
function createFrankfurterService({ fetchRate = globalThis.fetch, now = Date.now,
  ttlMs = 3_600_000, maxCacheAgeMs = DAY, retryMs = 60_000, timeoutMs = 5_000 } = {}) {
  for (const value of [ttlMs, maxCacheAgeMs, retryMs, timeoutMs]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('FX cache durations must be positive integers');
  }
  if (maxCacheAgeMs < ttlMs) throw new Error('FX max cache age must be at least the cache TTL');
  let cached;
  let pending;
  let retryAt = 0;
  const usable = time => cached && time - cached.fetchedMs < maxCacheAgeMs
    && time - cached.rateMs < 7 * DAY;
  function snapshot(fromCache, isStale) {
    return { status: 'AVAILABLE', source: 'FRANKFURTER', apiVersion: 'v2', providerMode: 'BLENDED',
      baseCurrency: 'USD', quoteCurrency: 'THB', rate: cached.rate, rateDate: cached.date,
      fetchedAt: new Date(cached.fetchedMs).toISOString(),
      expiresAt: new Date(cached.fetchedMs + ttlMs).toISOString(),
      fromCache, isStale, ...(isStale ? { warning: 'FX_REFRESH_FAILED_USING_CACHED_RATE' } : {}) };
  }
  async function refresh() {
    try {
      // Never send tokens, user identifiers, balances or PDF data to Frankfurter.
      const response = await fetchRate(RATE_URL, { headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
      if (!response.ok) throw unavailable();
      const row = await response.json();
      const time = now();
      const rateMs = typeof row?.date === 'string' ? Date.parse(`${row.date}T00:00:00Z`) : NaN;
      if (row?.base !== 'USD' || row?.quote !== 'THB' || typeof row.rate !== 'number'
        || !Number.isFinite(row.rate) || row.rate <= 0
        || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) || !Number.isFinite(rateMs)
        || new Date(rateMs).toISOString().slice(0, 10) !== row.date
        || rateMs > time || time - rateMs >= 7 * DAY) throw unavailable();
      cached = { rate: row.rate, date: row.date, rateMs, fetchedMs: time };
      retryAt = 0;
      return snapshot(false, false);
    } catch {
      const time = now();
      retryAt = time + retryMs;
      if (usable(time)) return snapshot(true, true);
      throw unavailable();
    }
  }
  return {
    async getRate() {
      const time = now();
      if (usable(time) && time - cached.fetchedMs < ttlMs) return snapshot(true, false);
      if (pending) return pending;
      if (time < retryAt) {
        if (usable(time)) return snapshot(true, true);
        throw unavailable();
      }
      // Single flight also deduplicates simultaneous cold-cache requests.
      pending = refresh();
      try { return await pending; } finally { pending = undefined; }
    },
  };
}

const frankfurterService = createFrankfurterService();
module.exports = { createFrankfurterService, frankfurterService };
