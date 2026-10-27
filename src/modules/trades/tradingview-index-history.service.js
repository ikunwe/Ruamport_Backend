const { createHistoryRangeCache } = require('./history-range-cache');
const { historyFailure } = require('./history-failure');
const { DAY, validateHistoryRange, shiftDate, marketDate, thaiToday } = require('./history-dates');
const THAI_INDICES = Object.freeze({ SET: 'SET:SET', SET50: 'SET:SET50' });
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
function fault(code, reason, retryAt, limitSource) {
  return Object.assign(new Error('Historical index data unavailable'), { safeCode: code, reason, retryAt, limitSource });
}
// One anonymous, finite-lived connection; the maintained v4 API cleans each chart
// operation on completion/error/abort. No streaming to browsers or account cookies.
async function readTradingViewHistory({ symbol, from, to, signal, timeoutMs }, library) {
  const { TradingViewClient, getCandles, getSymbolInfo } = library || await import('@mathieuc/tradingview');
  const client = new TradingViewClient({ connectTimeoutMs: timeoutMs });
  client.on('error', () => {}); // Operations receive the same error; never log upstream payloads.
  try {
    const info = await getSymbolInfo({ symbol, client, signal, timeoutMs });
    const candles = await getCandles({ symbol, client, signal, timeoutMs, timeframe: 'D', adjustment: 'none',
      from: new Date(from), to: new Date(to), maxCount: 4000 });
    return { info, candles };
  } finally { await client.close(); }
}
function createTradingViewIndexHistoryService({ load = readTradingViewHistory, now = Date.now,
  timeoutMs = 25000, perMinute = 6, ttlMs = 6 * 3600000 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000
    || !Number.isInteger(perMinute) || perMinute < 1 || perMinute > 20
    || !Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 6 * 3600000) throw new Error('Invalid index history limits');
  const cache = createHistoryRangeCache({ now, ttlMs, maxEntries: 2 });
  let starts = [];
  return {
    async getSeries(id, start, end) {
      validateHistoryRange(start, end);
      if (!Object.hasOwn(THAI_INDICES, id)) return historyFailure('TRADINGVIEW', { code: 'BENCHMARK_UNSUPPORTED' });
      const symbol = THAI_INDICES[id];
      return cache(symbol, start, end, async (from, to) => {
        starts = starts.filter(at => at > now() - 60000);
        if (starts.length >= perMinute)
          throw fault('HISTORY_RATE_LIMITED', 'BACKEND_PER_MINUTE_LIMIT', starts[0] + 60000, 'BACKEND');
        starts.push(now());
        const controller = new AbortController();
        let timer;
        try {
          const timedOut = new Promise((_, reject) => { timer = setTimeout(() => {
            controller.abort(); reject(fault('HISTORY_NOT_AVAILABLE', 'PROVIDER_TIMEOUT', now() + 60000));
          }, timeoutMs); });
          // Include a preceding observation to verify the lower bound. If the
          // provider silently limits old history, do not cache false coverage.
          const raw = await Promise.race([load({ symbol, from: shiftDate(from, -7), to: shiftDate(to, 1),
            signal: controller.signal, timeoutMs }), timedOut]);
          const info = raw?.info;
          const currency = info?.currency_code || info?.currency_id;
          if (!info || info.pro_name !== symbol || ![symbol, `SET_DLY:${id}`].includes(info.full_name)
            || info.type !== 'index' || info.exchange !== 'SET' || info.listed_exchange !== 'SET'
            || info.timezone !== 'Asia/Bangkok' || (currency && currency !== 'THB'))
            throw fault('HISTORY_LISTING_UNVERIFIED', 'PROVIDER_RESPONSE_INVALID', now() + 300000);
          if (!Array.isArray(raw.candles) || raw.candles.length === 0 || raw.candles.length > 4000)
            throw fault('HISTORY_RESPONSE_INVALID', 'PROVIDER_RESPONSE_INVALID', now() + 60000);
          const values = new Map();
          for (const row of raw.candles) {
            if (!Number.isSafeInteger(row.time) || row.time <= 0 || row.time * 1000 > now() + 60000
              || ![row.open, row.high, row.low, row.close].every(positive)
              || row.high < Math.max(row.open, row.close, row.low) || row.low > Math.min(row.open, row.close))
              throw fault('HISTORY_RESPONSE_INVALID', 'PROVIDER_RESPONSE_INVALID', now() + 60000);
            const date = marketDate(row.time * 1000, 'Asia/Bangkok');
            if (values.has(date) && values.get(date) !== row.close)
              throw fault('HISTORY_CONFLICTING_OBSERVATIONS', 'PROVIDER_RESPONSE_INVALID', now() + 60000);
            values.set(date, row.close);
          }
          const rows = [...values].sort(([a], [b]) => a.localeCompare(b));
          const preceding = rows.filter(([date]) => date <= from).at(-1);
          if (!preceding || Date.parse(from) - Date.parse(preceding[0]) >= 7 * DAY)
            throw fault('HISTORY_COVERAGE_INCOMPLETE', 'PROVIDER_RESPONSE_INVALID', now() + 300000);
          return { status: 'AVAILABLE', source: 'TRADINGVIEW', providerSymbol: symbol,
            resolvedSymbol: info.full_name, currency: 'THB',
            currencyBasis: currency ? 'PROVIDER_METADATA' : 'VERIFIED_INDEX_IDENTITY',
            timeZone: 'Asia/Bangkok', dataDelay: info.full_name.startsWith('SET_DLY:') ? 'DELAYED' : 'UNKNOWN',
            lastPointMayBeProvisional: to >= thaiToday(now()),
            points: rows.filter(([date]) => date >= from && date <= to && date <= thaiToday(now()))
              .map(([date, price]) => ({ date, price })) };
        } catch (error) {
          if (error.safeCode) throw error;
          // Never propagate messages, socket packets, cookies or stack traces.
          const timeout = ['TIMEOUT', 'ABORTED'].includes(error.code) || controller.signal.aborted;
          throw fault(error.code === 'SYMBOL_ERROR' ? 'HISTORY_LISTING_UNVERIFIED' : 'HISTORY_NOT_AVAILABLE',
            timeout ? 'PROVIDER_TIMEOUT' : error.code === 'NO_DATA' ? undefined : 'NETWORK_ERROR', now() + 60000);
        } finally { clearTimeout(timer); controller.abort(); }
      }, error => historyFailure('TRADINGVIEW', error));
    },
  };
}
const tradingViewIndexHistoryService = createTradingViewIndexHistoryService();
module.exports = { THAI_INDICES, readTradingViewHistory, createTradingViewIndexHistoryService, tradingViewIndexHistoryService };
