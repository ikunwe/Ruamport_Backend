const test = require('node:test');
const assert = require('node:assert/strict');
const { createTradingViewIndexHistoryService, readTradingViewHistory } = require('../src/modules/trades/tradingview-index-history.service');
const { createPortfolioHistoryMarket } = require('../src/modules/trades/portfolio-history-market');
const { createAnalyticsService } = require('../src/modules/trades/analytics.service');
const { shiftDate } = require('../src/modules/trades/history-dates');
const NOW = Date.parse('2026-10-27T12:00Z');
function raw(symbol, from, to, changes = {}) {
  const id = symbol.split(':')[1], candles = [];
  for (let date = from; date < to; date = shiftDate(date, 1)) {
    const price = date < '2026-09-01' ? 100 : 101;
    candles.push({ time: Date.parse(date + 'T03:00Z') / 1000, open: price, high: price + 1, low: price - 1, close: price });
  }
  return { info: { pro_name: symbol, full_name: `SET_DLY:${id}`, type: 'index', exchange: 'SET', listed_exchange: 'SET',
    timezone: 'Asia/Bangkok', ...changes }, candles };
}
test('Thai index route uses TradingView only; latest index service continues using Yahoo', async () => {
  const calls = [];
  const thaiIndexHistory = createTradingViewIndexHistoryService({ now: () => NOW, load: async q => { calls.push(q.symbol); return raw(q.symbol, q.from, q.to); } });
  const market = createPortfolioHistoryMarket({ thaiIndexHistory, fetchData: async () => { throw new Error('History must not call Yahoo for SET'); } });
  for (const id of ['SET', 'SET50']) {
    const r = await market.getIndexSeries(id, '2026-09-01', '2026-10-26');
    assert.equal(r.source, 'TRADINGVIEW'); assert.equal(r.providerSymbol, `SET:${id}`);
    assert.equal(r.status, 'AVAILABLE'); assert.equal(r.currency, 'THB'); assert.equal(r.dataDelay, 'DELAYED');
    assert.equal(r.currencyBasis, 'VERIFIED_INDEX_IDENTITY');
  }
  assert.deepEqual(calls, ['SET:SET', 'SET:SET50']);
  const { createMarketIndexService } = require('../src/modules/trades/market-index.service');
  const urls = [];
  await createMarketIndexService({ now: () => NOW, fetchData: async url => { urls.push(url); return { ok: false, status: 503 }; } }).getIndices();
  assert.equal(urls.length, 5); assert.ok(urls.every(url => new URL(url).hostname === 'query1.finance.yahoo.com'));
  assert.ok(urls.some(url => decodeURIComponent(url).includes('^SET.BK')));
  assert.ok(urls.some(url => decodeURIComponent(url).includes('^SET50.BK')));
});
test('ALL cache is single-flight across callers, reused by shorter ranges, extends missing dates and expires after 6h', async () => {
  let time = NOW;
  const calls = [];
  const service = createTradingViewIndexHistoryService({ now: () => time, load: async q => { calls.push(q); return raw(q.symbol, q.from, q.to); } });
  const [a, b] = await Promise.all([service.getSeries('SET', '2026-08-01', '2026-10-26'), service.getSeries('SET', '2026-08-01', '2026-10-26')]);
  assert.equal(calls.length, 1); assert.deepEqual(a.points, b.points); assert.equal(b.fromCache, true);
  const short = await service.getSeries('SET', '2026-09-26', '2026-10-26');
  assert.deepEqual(short.points, a.points.filter(row => row.date >= '2026-09-26')); assert.equal(calls.length, 1);
  await service.getSeries('SET', '2026-08-01', '2026-10-27'); assert.equal(calls.length, 2);
  assert.equal(calls[1].from, '2026-10-20'); // Only one missing day plus lower-bound verification lookback.
  time += 6 * 3600000;
  await service.getSeries('SET', '2026-08-01', '2026-10-26'); assert.equal(calls.length, 3);
});
test('short-first expansion matches cold ALL and does not mark uncovered old history complete', async () => {
  const load = async q => raw(q.symbol, q.from, q.to);
  const warm = createTradingViewIndexHistoryService({ now: () => NOW, load });
  await warm.getSeries('SET50', '2026-10-01', '2026-10-26');
  const all = await warm.getSeries('SET50', '2026-08-01', '2026-10-26');
  const cold = await createTradingViewIndexHistoryService({ now: () => NOW, load }).getSeries('SET50', '2026-08-01', '2026-10-26');
  assert.deepEqual(all.points, cold.points);
  const capped = createTradingViewIndexHistoryService({ now: () => NOW, load: async q => raw(q.symbol, '2026-10-01', q.to) });
  const failed = await capped.getSeries('SET', '2026-08-01', '2026-10-26');
  assert.equal(failed.status, 'UNAVAILABLE'); assert.equal(failed.errorCode, 'HISTORY_COVERAGE_INCOMPLETE');
});
test('wrong symbol, exchange, type, currency and timezone fail closed; metadata is never returned raw', async () => {
  for (const info of [{ pro_name: 'NYSE:SET' }, { full_name: 'SET:SET50' }, { exchange: 'NASDAQ' },
    { listed_exchange: 'NYSE' }, { type: 'fund' }, { currency_code: 'USD' }, { timezone: 'UTC' }]) {
    const service = createTradingViewIndexHistoryService({ now: () => NOW, load: async q => raw(q.symbol, q.from, q.to, info) });
    const r = await service.getSeries('SET', '2026-09-01', '2026-10-26');
    assert.equal(r.status, 'UNAVAILABLE'); assert.equal(r.errorCode, 'HISTORY_LISTING_UNVERIFIED');
  }
});
test('bad candles, conflicting dates and future timestamps cannot produce fake history', async () => {
  for (const mutate of [data => { data.candles[0].close = 0; }, data => { data.candles[0].high = 1; },
    data => { data.candles[0].time = NOW / 1000 + 9999; },
    data => { data.candles.push({ ...data.candles[0], close: 100.1 }); }]) {
    const service = createTradingViewIndexHistoryService({ now: () => NOW, load: async q => { const d = raw(q.symbol, q.from, q.to); mutate(d); return d; } });
    const r = await service.getSeries('SET', '2026-09-01', '2026-10-26'); assert.equal(r.status, 'UNAVAILABLE');
  }
});
test('safe failures are negatively cached and provider errors do not leak tokens or masquerade as HTTP 429', async () => {
  let calls = 0;
  const service = createTradingViewIndexHistoryService({ now: () => NOW, load: async () => { calls++; throw Object.assign(new Error('token=PRIVATE_SAMPLE'), { code: 'DISCONNECTED' }); } });
  const a = await service.getSeries('SET', '2026-09-01', '2026-10-26');
  const b = await service.getSeries('SET', '2026-09-01', '2026-10-26');
  assert.equal(calls, 1); assert.equal(b.cacheStatus, 'RETRY_WAIT'); assert.equal(a.reason, 'NETWORK_ERROR');
  assert.equal(a.providerStatus, null); assert.equal(a.limitSource, null);
  assert.equal(JSON.stringify(b).includes('PRIVATE_SAMPLE'), false);
});
test('timeout aborts provider work and application budget reports BACKEND with retryAt', async () => {
  let aborted = false;
  const timeout = createTradingViewIndexHistoryService({ now: () => NOW, timeoutMs: 15,
    load: ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new Error('stopped')); })) });
  const r = await timeout.getSeries('SET', '2026-09-01', '2026-09-02');
  assert.equal(aborted, true); assert.equal(r.status, 'UNAVAILABLE'); assert.equal(r.reason, 'PROVIDER_TIMEOUT');
  const limited = createTradingViewIndexHistoryService({ now: () => NOW, perMinute: 1, load: async q => raw(q.symbol, q.from, q.to) });
  await limited.getSeries('SET', '2026-09-01', '2026-09-02');
  const blocked = await limited.getSeries('SET50', '2026-09-01', '2026-09-02');
  assert.equal(blocked.errorCode, 'HISTORY_RATE_LIMITED'); assert.equal(blocked.limitSource, 'BACKEND');
  assert.equal(blocked.reason, 'BACKEND_PER_MINUTE_LIMIT'); assert.equal(blocked.retryAt, new Date(NOW + 60000).toISOString());
});
test('reader closes one finite-lived connection on success, failed metadata and failed candles', async () => {
  for (const failing of [null, 'info', 'candles']) {
    let closed = 0;
    class Client { on() {} async close() { closed++; } }
    const library = { TradingViewClient: Client,
      getSymbolInfo: async () => { if (failing === 'info') throw new Error('fail'); return {}; },
      getCandles: async () => { if (failing === 'candles') throw new Error('fail'); return []; } };
    const work = readTradingViewHistory({ symbol: 'SET:SET', from: '2026-09-01', to: '2026-10-01', timeoutMs: 1000 }, library);
    if (failing) await assert.rejects(work); else await work;
    assert.equal(closed, 1);
  }
});
test('graphs and Win rate use Thai index history, isolate private quantities, share public cache and retain USD indices on Yahoo', async () => {
  let loads = 0, reads = [];
  const thaiIndexHistory = createTradingViewIndexHistoryService({ now: () => NOW, load: async q => { loads++; return raw(q.symbol, q.from, q.to); } });
  const market = { getIndexSeries: (id, from, to) => ['SET', 'SET50'].includes(id) ? thaiIndexHistory.getSeries(id, from, to)
    : Promise.resolve({ status: 'AVAILABLE', source: 'YAHOO_FINANCE', points: raw('SET:SET', from, shiftDate(to, 1)).candles.map(row => ({ date: new Date(row.time * 1000).toISOString().slice(0, 10), price: row.close })) }),
    getFxSeries: async (from, to) => ({ status: 'AVAILABLE', points: raw('SET:SET', from, shiftDate(to, 1)).candles.map(row => ({ date: new Date(row.time * 1000).toISOString().slice(0, 10), price: 35 })) }),
    getSeries: async (_item, from, to) => ({ status: 'AVAILABLE', points: raw('SET:SET', from, shiftDate(to, 1)).candles.map(row => ({ date: new Date(row.time * 1000).toISOString().slice(0, 10), price: 100 })) }) };
  const service = createAnalyticsService({ now: () => NOW, market, repository: { analyticsOrders: async owner => {
    reads.push(owner); return { orders: [{ assetType: 'THAI_STOCK', symbol: 'ASK', currency: 'THB', units: owner === 'alice' ? 1 : 2,
      transactionType: 'BUY', tradeDate: '2026-08-28', flowAmount: owner === 'alice' ? 100 : 200 }] };
  } } });
  const graph = await service.performance('alice', { range: 'ALL', benchmarkId: 'SET50' });
  assert.equal(graph.status, 'COMPLETE'); assert.equal(graph.benchmark.source, 'TRADINGVIEW');
  assert.equal(graph.benchmark.symbol, 'SET:SET50'); assert.equal(graph.benchmark.cumulativeReturnPercent, 1);
  const win = await service.winRate('alice', { range: 'ALL', unit: 'MONTH' });
  assert.equal(win.status, 'COMPLETE'); assert.ok(win.markets.every(row => row.comparedPeriodCount === 2));
  assert.ok(win.markets.filter(row => ['SET', 'SET50'].includes(row.id)).every(row => row.source === 'TRADINGVIEW'));
  assert.ok(win.markets.filter(row => ['SP500', 'NASDAQ_COMPOSITE'].includes(row.id)).every(row => row.source === 'YAHOO_FINANCE'));
  const bob = await service.performance('bob', { range: '1M', benchmarkId: 'SET50' });
  assert.equal(loads, 2); assert.equal(bob.cache.fromCache, true);
  assert.equal(bob.points.at(-1).marketValueThb, 200); assert.equal(graph.points.at(-1).marketValueThb, 100);
  assert.deepEqual(reads, ['alice', 'alice', 'bob']);
});
