// Real production TradingView adapter and cache; no DB, .env or user data.
// node --use-system-ca scripts/verification/verify-thai-index-history.cjs
const assert = require('node:assert/strict');
const { createTradingViewIndexHistoryService, readTradingViewHistory } = require('../../src/modules/trades/tradingview-index-history.service');
const { thaiToday, shiftDate } = require('../../src/modules/trades/history-dates');
(async () => {
  const end = shiftDate(thaiToday(Date.now()), -1); // Compare finished dates; today's live candle may change between loads.
  const start = shiftDate(end, -365), shortStart = shiftDate(end, -30);
  let loads = 0;
  const load = async q => { loads++; return readTradingViewHistory(q); };
  const service = createTradingViewIndexHistoryService({ load });
  const results = [];
  for (const id of ['SET', 'SET50']) {
    const short = await service.getSeries(id, shortStart, end);
    assert.equal(short.status, 'AVAILABLE');
    const expanded = await service.getSeries(id, start, end);
    const cold = await createTradingViewIndexHistoryService({ load }).getSeries(id, start, end);
    assert.equal(expanded.status, 'AVAILABLE'); assert.equal(cold.status, 'AVAILABLE');
    assert.deepEqual(expanded.points, cold.points);
    const before = loads;
    for (const from of [shortStart, shiftDate(end, -90), start]) {
      const cached = await service.getSeries(id, from, end);
      assert.equal(cached.fromCache, true);
      assert.deepEqual(cached.points, expanded.points.filter(row => row.date >= from));
    }
    assert.equal(loads, before);
    results.push({ id, status: expanded.status, source: expanded.source, providerSymbol: expanded.providerSymbol,
      resolvedSymbol: expanded.resolvedSymbol, count: expanded.points.length,
      first: expanded.points[0], last: expanded.points.at(-1), shortToAllEqualsColdAll: true,
      repeatedRangeAdditionalLoads: loads - before });
  }
  console.log(JSON.stringify({ mode: 'REAL_THAI_INDEX_HISTORY_NO_DATABASE', start, end, results, totalLoads: loads }, null, 2));
})().catch(error => { console.error(JSON.stringify({ error: 'Thai index history verification failed',
  code: error.code || null, detailsOmitted: true })); process.exitCode = 1; });
