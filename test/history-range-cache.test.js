const test = require('node:test');
const assert = require('node:assert/strict');
const { createHistoryRangeCache } = require('../src/modules/trades/history-range-cache');
const { createPortfolioHistoryMarket } = require('../src/modules/trades/portfolio-history-market');
const { createDomesticMarketService } = require('../src/modules/trades/domestic-market.service');
const { createPortfolioHistoryService } = require('../src/modules/trades/portfolio-history.service');
const { shiftDate } = require('../src/modules/trades/history-dates');
const TIME = Date.parse('2026-10-24T08:00Z');
const unavailable = error => ({ status: 'UNAVAILABLE', errorCode: error.code, points: [] });
const series = (start, end) => {
  const points = [];
  for (let date = start; date <= end; date = shiftDate(date, 1)) points.push({ date, price: 10 });
  return { status: 'AVAILABLE', source: 'TEST', points };
};

test('range cache reuses ALL for shorter ranges and requests only missing left/right intervals', async () => {
  const cache = createHistoryRangeCache({ now: () => TIME });
  const calls = [];
  const load = async (start, end) => { calls.push([start, end]); return series(start, end); };
  await cache('A', '2026-10-05', '2026-10-20', load, unavailable);
  const small = await cache('A', '2026-10-18', '2026-10-19', load, unavailable);
  assert.equal(small.fromCache, true);
  small.points[0].price = 999;
  assert.equal((await cache('A', '2026-10-18', '2026-10-19', load, unavailable)).points[0].price, 10);
  const extended = await cache('A', '2026-10-01', '2026-10-24', load, unavailable);
  assert.equal(extended.points.length, 24);
  assert.deepEqual(calls, [['2026-10-05', '2026-10-20'], ['2026-10-01', '2026-10-04'], ['2026-10-21', '2026-10-24']]);
});

test('range cache deduplicates overlapping concurrent calls, includes empty weekend coverage, and expires', async () => {
  let time = TIME, calls = 0;
  const cache = createHistoryRangeCache({ now: () => time, ttlMs: 1000 });
  const load = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 5));
    return { status: 'AVAILABLE', source: 'TEST', points: [] }; };
  await Promise.all([cache('A', '2026-10-01', '2026-10-24', load, unavailable),
    cache('A', '2026-10-23', '2026-10-24', load, unavailable)]);
  assert.equal(calls, 1);
  time += 1000;
  await cache('A', '2026-10-23', '2026-10-24', load, unavailable);
  assert.equal(calls, 2);
});

test('disjoint cached ranges request only the interior gap', async () => {
  const cache = createHistoryRangeCache({ now: () => TIME });
  const calls = [];
  const load = async (start, end) => { calls.push([start, end]); return series(start, end); };
  await cache('A', '2026-10-01', '2026-10-05', load, unavailable);
  await cache('A', '2026-10-10', '2026-10-15', load, unavailable);
  const combined = await cache('A', '2026-10-01', '2026-10-15', load, unavailable);
  assert.deepEqual(calls.at(-1), ['2026-10-06', '2026-10-09']);
  assert.equal(combined.points.length, 15);
});

test('failed extension never discards good coverage or marks a missing interval as cached', async () => {
  let time = TIME, fail = false, calls = 0;
  const cache = createHistoryRangeCache({ now: () => time });
  const load = async (start, end) => { calls++; if (fail) throw Object.assign(new Error(), { safeCode: 'LIMIT', retryAt: time + 1000 });
    return series(start, end); };
  await cache('A', '2026-10-01', '2026-10-20', load, unavailable);
  fail = true;
  assert.equal((await cache('A', '2026-10-01', '2026-10-24', load, unavailable)).errorCode, 'LIMIT');
  assert.equal((await cache('A', '2026-10-18', '2026-10-19', load, unavailable)).status, 'AVAILABLE');
  await cache('A', '2026-10-01', '2026-10-24', load, unavailable);
  assert.equal(calls, 2);
  time += 1000; fail = false;
  await cache('A', '2026-10-01', '2026-10-24', load, unavailable);
  assert.equal(calls, 3);
});

test('bounded instrument eviction and split event coverage survive slicing and extension', async () => {
  const cache = createHistoryRangeCache({ now: () => TIME, maxEntries: 1 });
  let calls = 0;
  const load = async (start, end) => { calls++;
    return { ...series(start, end), corporateActions: start <= '2026-10-10' && end >= '2026-10-10'
      ? [{ type: 'SPLIT', date: '2026-10-10', numerator: 2, denominator: 1 }] : [] }; };
  await cache('A', '2026-10-01', '2026-10-20', load, unavailable);
  const sliced = await cache('A', '2026-10-08', '2026-10-24', load, unavailable);
  assert.equal(sliced.corporateActions.length, 1);
  assert.equal(sliced.eventCoverageStart, '2026-10-08');
  await cache('B', '2026-10-01', '2026-10-20', load, unavailable);
  await cache('A', '2026-10-01', '2026-10-20', load, unavailable);
  assert.equal(calls, 4);
});

test('three-asset chart ALL -> shorter ranges uses no new provider calls and recomputes changed orders', async () => {
  let time = TIME;
  const calls = [];
  const ok = body => ({ ok: true, status: 200, json: async () => body });
  const fetchData = async input => {
    const url = new URL(input); calls.push(url);
    if (url.hostname === 'api.sec.or.th') {
      if (url.pathname.includes('/profiles')) return ok({ items: [{ proj_id: 'M1_2567', fund_class_name: 'FUND', fund_status: 'Registered' }], next_cursor: '' });
      return ok({ items: series(url.searchParams.get('start_nav_date'), url.searchParams.get('end_nav_date')).points
        .map(row => ({ proj_id: 'M1_2567', fund_class_name: 'FUND', nav_date: row.date, last_val: row.price })), next_cursor: '' });
    }
    if (url.hostname === 'api.frankfurter.dev') return ok(series(url.searchParams.get('from'), url.searchParams.get('to')).points
      .map(row => ({ date: row.date, base: 'USD', quote: 'THB', rate: 33 })));
    const symbol = decodeURIComponent(url.pathname.split('/').at(-1));
    const rows = series(new Date(Number(url.searchParams.get('period1')) * 1000).toISOString().slice(0, 10),
      shiftDate(new Date(Number(url.searchParams.get('period2')) * 1000).toISOString().slice(0, 10), -1)).points;
    return ok({ chart: { result: [{ meta: { symbol, currency: symbol.endsWith('.BK') ? 'THB' : 'USD',
      exchangeName: symbol.endsWith('.BK') ? 'SET' : 'NMS', instrumentType: 'EQUITY' },
      timestamp: rows.map(row => Date.parse(row.date + 'T15:00Z') / 1000),
      indicators: { quote: [{ close: rows.map(row => row.price) }] } }] } });
  };
  const domesticPrices = createDomesticMarketService({ secApiKey: 'test', fetchData, now: () => time });
  const market = createPortfolioHistoryMarket({ domesticPrices, fetchData, now: () => time });
  const orders = [
    { assetType: 'OFFSHORE_STOCK', symbol: 'NVDA', exchange: 'XNAS', currency: 'USD', transactionType: 'BUY' },
    { assetType: 'THAI_STOCK', symbol: 'ASK', currency: 'THB', transactionType: 'BUY' },
    { assetType: 'MUTUAL_FUND', symbol: 'FUND', currency: 'THB', transactionType: 'SUBSCRIPTION' },
  ].map(row => ({ ...row, tradeDate: '2026-08-01', accountNumber: 'TEST', units: 2 }));
  const service = createPortfolioHistoryService({ market, now: () => time,
    repository: { portfolioOrders: async () => ({ orders }) } });
  const all = await service.get('owner', { range: 'ALL' });
  assert.equal(all.status, 'COMPLETE');
  const baseline = calls.length;
  for (const range of ['1D', '1W', '1M', '3M', '1Y']) {
    const small = await service.get('owner', { range });
    assert.equal(small.status, 'COMPLETE');
    assert.deepEqual(small.points, all.points.filter(point => point.date >= small.startDate));
    assert.equal(calls.length, baseline, range);
  }
  orders[0].units = 3;
  const changed = await service.get('owner', { range: '1D' });
  assert.equal(changed.points.at(-1).marketValue - all.points.at(-1).marketValue, 330);
  assert.equal(calls.length, baseline);
  // Cross Thai midnight without expiring the 6h snapshots: append only the new day.
  // Initial snapshots at 08:00Z expire; refresh at 16:00Z before crossing midnight.
  time = Date.parse('2026-10-24T16:00Z');
  await service.get('owner', { range: 'ALL' });
  const beforeNewDay = calls.length;
  time = Date.parse('2026-10-24T17:00Z');
  const next = await service.get('owner', { range: '1D' });
  assert.equal(next.status, 'COMPLETE');
  const additional = calls.slice(beforeNewDay);
  assert.equal(additional.length, 4); // Yahoo x2, SEC NAV, historical FX; identity stays cached.
  for (const url of additional) {
    if (url.hostname === 'query1.finance.yahoo.com') {
      assert.equal(Number(url.searchParams.get('period1')), Date.parse('2026-10-25') / 1000);
      assert.equal(Number(url.searchParams.get('period2')), Date.parse('2026-10-26') / 1000);
    } else if (url.hostname === 'api.sec.or.th') {
      assert.equal(url.searchParams.get('start_nav_date'), '2026-10-25');
      assert.equal(url.searchParams.get('end_nav_date'), '2026-10-25');
    } else {
      assert.equal(url.searchParams.get('from'), '2026-10-25');
      assert.equal(url.searchParams.get('to'), '2026-10-25');
    }
  }
});

test('range cache does not hide conflicting same-date observations from downstream validation', async () => {
  const cache = createHistoryRangeCache({ now: () => TIME });
  const result = await cache('A', '2026-10-24', '2026-10-24', async () => ({ status: 'AVAILABLE',
    points: [{ date: '2026-10-24', price: 10 }, { date: '2026-10-24', price: 20 }] }), unavailable);
  assert.deepEqual(result.points.map(point => point.price), [10, 20]);
});

test('Yahoo split replay from ALL stays identical in 1D and retains split events across a tail extension', async () => {
  let calls = 0;
  const market = createPortfolioHistoryMarket({ now: () => TIME, fetchData: async input => {
    calls++;
    const url = new URL(input);
    const start = new Date(Number(url.searchParams.get('period1')) * 1000).toISOString().slice(0, 10);
    const end = shiftDate(new Date(Number(url.searchParams.get('period2')) * 1000).toISOString().slice(0, 10), -1);
    const rows = series(start, end).points;
    const stamp = Date.parse('2026-10-10T15:00Z') / 1000;
    return { ok: true, status: 200, json: async () => ({ chart: { result: [{ meta: {
      symbol: 'SPLT', currency: 'USD', exchangeName: 'NMS', instrumentType: 'EQUITY' },
      timestamp: rows.map(row => Date.parse(row.date + 'T15:00Z') / 1000),
      indicators: { quote: [{ close: rows.map(() => 10) }] },
      events: { splits: start <= '2026-10-10' && end >= '2026-10-10'
        ? { split: { date: stamp, numerator: 2, denominator: 1, splitRatio: '2:1' } } : {} },
    }] } }) };
  } });
  const orders = [{ assetType: 'OFFSHORE_STOCK', symbol: 'SPLT', exchange: 'XNAS', currency: 'USD',
    units: 2, tradeDate: '2026-10-01', transactionType: 'BUY', accountNumber: 'TEST' }];
  const withFx = { getSeries: market.getSeries, getFxSeries: async (start, end) => series(start, end) };
  const service = createPortfolioHistoryService({ now: () => TIME, market: withFx,
    repository: { portfolioOrders: async () => ({ orders }) } });
  const all = await service.get('owner', { range: 'ALL' });
  const small = await service.get('owner', { range: '1D' });
  assert.equal(all.status, 'COMPLETE');
  assert.deepEqual(small.points, all.points.filter(point => point.date >= small.startDate));
  assert.equal(calls, 1);
  const extended = await market.getSeries(orders[0], '2026-10-20', '2026-10-25', { eventStart: '2026-10-01' });
  assert.equal(calls, 2);
  assert.equal(extended.corporateActions.length, 1);
  assert.equal(extended.corporateActions[0].date, '2026-10-10');
});
