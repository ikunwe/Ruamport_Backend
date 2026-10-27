const { fxUnavailable: unavailable, publicFxError } = require('../../shared/errors/fx-error');

const RATE_URL = 'https://api.frankfurter.dev/v2/rate/USD/THB';
const DAY = 86_400_000;
// Calendar-day marker only, not the publication timestamp. Thailand is UTC+7.
const thaiDayMs = time => Date.parse(`${new Date(time + 7 * 3_600_000).toISOString().slice(0, 10)}T00:00:00Z`);

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
  let lastFailureReason = 'INVALID_RESPONSE';
  const usable = time => cached && time - cached.fetchedMs < maxCacheAgeMs
    && cached.rateMs <= thaiDayMs(time) && thaiDayMs(time) - cached.rateMs < 7 * DAY;
  function snapshot(fromCache, isStale) {
    return { status: 'AVAILABLE', source: 'FRANKFURTER', apiVersion: 'v2', providerMode: 'BLENDED',
      baseCurrency: 'USD', quoteCurrency: 'THB', rate: cached.rate, rateDate: cached.date,
      fetchedAt: new Date(cached.fetchedMs).toISOString(),
      expiresAt: new Date(cached.fetchedMs + ttlMs).toISOString(),
      fromCache, isStale, ...(isStale ? { warning: 'FX_REFRESH_FAILED_USING_CACHED_RATE',
        reason: lastFailureReason, retryAt: new Date(retryAt).toISOString() } : {}),
      selectionMode: cached.selectionMode,
      ...(cached.selectionMode === 'HISTORICAL_FALLBACK' ? { fallbackReason: 'FUTURE_RATE_DATE',
        requestedThroughDate: cached.requestedThroughDate } : {}) };
  }
  function validateRow(row) {
    const rateMs = typeof row?.date === 'string' ? Date.parse(`${row.date}T00:00:00Z`) : NaN;
    if (row?.base !== 'USD' || row?.quote !== 'THB' || typeof row.rate !== 'number'
      || !Number.isFinite(row.rate) || row.rate <= 0
      || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) || !Number.isFinite(rateMs)
      || new Date(rateMs).toISOString().slice(0, 10) !== row.date) throw unavailable('INVALID_RESPONSE');
    return rateMs;
  }
  async function refresh() {
    let signal;
    let readingBody = false;
    try {
      // Never send tokens, user identifiers, balances or PDF data to Frankfurter.
      signal = AbortSignal.timeout(timeoutMs);
      const read = async url => {
        readingBody = false;
        const response = await fetchRate(url, { headers: { Accept: 'application/json' }, signal, redirect: 'error' });
        if (!response.ok) throw unavailable(response.status === 429 ? 'UPSTREAM_RATE_LIMITED' : 'UPSTREAM_HTTP_ERROR');
        readingBody = true;
        return response.json();
      };
      let row = await read(RATE_URL);
      let rateMs = validateRow(row);
      let selectionMode = 'LATEST';
      let requestedThroughDate;
      if (rateMs > thaiDayMs(now())) {
        // One bounded history request, only for future-dated latest data. Never
        // rewrite a provider date or walk backward with unbounded requests.
        const today = thaiDayMs(now());
        const start = today - 6 * DAY;
        requestedThroughDate = new Date(today).toISOString().slice(0, 10);
        const historyUrl = new URL('https://api.frankfurter.dev/v2/rates');
        historyUrl.search = new URLSearchParams({ base: 'USD', quotes: 'THB',
          from: new Date(start).toISOString().slice(0, 10), to: requestedThroughDate }).toString();
        const rows = await read(historyUrl.toString());
        if (!Array.isArray(rows) || rows.length > 100) throw unavailable('INVALID_RESPONSE');
        const candidates = rows.map(value => ({ row: value, date: validateRow(value) }))
          .filter(value => value.date >= start && value.date <= today).sort((a, b) => b.date - a.date);
        if (!candidates.length) throw unavailable('HISTORICAL_RATE_UNAVAILABLE');
        if (new Set(candidates.filter(value => value.date === candidates[0].date).map(value => value.row.rate)).size !== 1)
          throw unavailable('INVALID_RESPONSE');
        row = candidates[0].row;
        rateMs = candidates[0].date;
        selectionMode = 'HISTORICAL_FALLBACK';
      }
      const time = now();
      if (rateMs > thaiDayMs(time)) throw unavailable('FUTURE_RATE_DATE');
      if (thaiDayMs(time) - rateMs >= 7 * DAY) throw unavailable('RATE_TOO_OLD');
      cached = { rate: row.rate, date: row.date, rateMs, fetchedMs: time, selectionMode, requestedThroughDate };
      retryAt = 0;
      return snapshot(false, false);
    } catch (error) {
      const time = now();
      retryAt = time + retryMs;
      lastFailureReason = publicFxError(error)?.reason || (signal?.aborted ? 'TIMEOUT'
        : readingBody ? 'INVALID_RESPONSE' : 'NETWORK_ERROR');
      if (usable(time)) return snapshot(true, true);
      throw Object.assign(unavailable(lastFailureReason), { retryAt: new Date(retryAt).toISOString() });
    }
  }
  return {
    async getRate() {
      const time = now();
      if (usable(time) && time - cached.fetchedMs < ttlMs) return snapshot(true, false);
      if (pending) return pending;
      if (time < retryAt) {
        if (usable(time)) return snapshot(true, true);
        throw Object.assign(unavailable(lastFailureReason), { retryAt: new Date(retryAt).toISOString() });
      }
      // Single flight also deduplicates simultaneous cold-cache requests.
      pending = refresh();
      try { return await pending; } finally { pending = undefined; }
    },
  };
}

const frankfurterService = createFrankfurterService();
module.exports = { createFrankfurterService, frankfurterService };
