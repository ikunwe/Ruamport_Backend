const { createPublicMarketCache, createProviderClient, providerFailureDetails } = require('./public-market-cache');
const { decimal, subtract, multiply, number, ratio } = require('./valuation-decimal');
const { marketDate } = require('./history-dates');
const DAY = 86_400_000;
const INDICES = [
  { id: 'SP500', symbol: '^GSPC', name: 'S&P 500', region: 'US', currency: 'USD', timeZone: 'America/New_York', exchanges: ['SNP'] },
  { id: 'NASDAQ_COMPOSITE', symbol: '^IXIC', name: 'Nasdaq Composite', region: 'US', currency: 'USD', timeZone: 'America/New_York', exchanges: ['NIM', 'NAS', 'NMS'] },
  { id: 'DOW_JONES', symbol: '^DJI', name: 'Dow Jones Industrial Average', region: 'US', currency: 'USD', timeZone: 'America/New_York', exchanges: ['DJI'] },
  { id: 'SET', symbol: '^SET.BK', name: 'SET Index', region: 'TH', currency: 'THB', timeZone: 'Asia/Bangkok', exchanges: ['SET', 'BKK'] },
  { id: 'SET50', symbol: '^SET50.BK', name: 'SET50 Index', region: 'TH', currency: 'THB', timeZone: 'Asia/Bangkok', exchanges: ['SET', 'BKK'] },
];
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
function identity(target) {
  const { exchanges, ...fields } = target;
  return { ...fields, source: 'YAHOO_FINANCE', unit: 'POINTS' };
}
function createMarketIndexService({ fetchData = globalThis.fetch, now = Date.now,
  ttlMs = 15 * 60_000, maxAgeMs = DAY, timeoutMs = 10_000 } = {}) {
  if (![ttlMs, maxAgeMs, timeoutMs].every(value => Number.isSafeInteger(value) && value > 0)
    || ttlMs > maxAgeMs || maxAgeMs > DAY || timeoutMs > 30_000) throw new Error('Invalid market index cache limits');
  const cache = createPublicMarketCache({ now, ttlMs, maxAgeMs, maxEntries: 5 });
  const yahoo = createProviderClient({ origin: 'https://query1.finance.yahoo.com', fetchData,
    now, prefix: 'INDEX', perMinute: 20, timeoutMs });
  const validStamp = stamp => Number.isSafeInteger(stamp) && stamp > 0
    && stamp <= now() + 60_000 && now() - stamp < 7 * DAY;
  async function quote(target) {
    const snapshot = await cache(target.id, async () => {
      // previousClose is the previous-session baseline in this 1-day query.
      // Do not use chartPreviousClose from a multi-day range as a daily baseline.
      const body = await yahoo.get('/v8/finance/chart/' + encodeURIComponent(target.symbol),
        { range: '1d', interval: '5m' });
      const meta = body?.chart?.result?.[0]?.meta;
      const stamp = typeof meta?.regularMarketTime === 'number' ? meta.regularMarketTime * 1000 : NaN;
      if (body?.chart?.error || meta?.symbol !== target.symbol || meta?.instrumentType !== 'INDEX'
        || meta?.currency !== target.currency || !target.exchanges.includes(meta?.exchangeName)
        || (meta.exchangeTimezoneName && meta.exchangeTimezoneName !== target.timeZone)
        || !positive(meta?.regularMarketPrice) || !validStamp(stamp)) throw yahoo.error('INDEX_RESPONSE_INVALID');
      const value = meta.regularMarketPrice;
      const previousClose = positive(meta.previousClose) ? meta.previousClose : null;
      const difference = previousClose === null ? null : subtract(decimal(value), decimal(previousClose));
      const change = difference === null ? null : number(difference, 8);
      const changePercent = difference === null ? null : ratio(multiply(difference, decimal(100)), decimal(previousClose), 4);
      return { ...identity(target), status: 'AVAILABLE', value, previousClose, change, changePercent,
        valueAt: new Date(stamp).toISOString(), valueDate: marketDate(stamp, target.timeZone),
        changeBasis: previousClose === null ? null : 'PREVIOUS_SESSION_CLOSE',
        previousCloseDate: null, marketStatus: 'UNKNOWN', errorCode: null, retryAt: null,
        issues: change === null || changePercent === null ? ['PREVIOUS_CLOSE_UNAVAILABLE'] : [] };
    }, error => ({ ...identity(target), status: 'UNAVAILABLE', value: null, previousClose: null,
      change: null, changePercent: null, valueAt: null, valueDate: null, changeBasis: null,
      previousCloseDate: null, marketStatus: 'UNKNOWN', errorCode: error.code,
      reason: null, limitSource: null, providerStatus: null, ...providerFailureDetails(error),
      retryAt: new Date(error.retryAt).toISOString(), fetchedAt: null, expiresAt: null,
      fromCache: null, isStale: false, issues: [error.code] }), value => validStamp(Date.parse(value.valueAt)));
    return { ...snapshot, issues: [...snapshot.issues, ...(snapshot.isStale ? ['STALE_CACHE'] : [])],
      dataAgeSeconds: snapshot.valueAt ? Math.max(0, Math.floor((now() - Date.parse(snapshot.valueAt)) / 1000)) : null };
  }
  return {
    async getIndices() {
      const requestedAt = new Date(now()).toISOString();
      // Only public snapshots are shared. No holdings, quantities or user IDs enter this cache.
      const items = await Promise.all(INDICES.map(quote));
      const available = items.filter(item => item.status === 'AVAILABLE').length;
      return { source: 'YAHOO_FINANCE', status: available === items.length ? 'COMPLETE' : available ? 'PARTIAL' : 'UNAVAILABLE',
        requestedAt, cacheTtlSeconds: ttlMs / 1000, items };
    },
  };
}
const marketIndexService = createMarketIndexService();
module.exports = { createMarketIndexService, marketIndexService, INDICES };
