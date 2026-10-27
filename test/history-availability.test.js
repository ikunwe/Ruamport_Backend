const test = require('node:test');
const assert = require('node:assert/strict');
const { createPortfolioHistoryMarket } = require('../src/modules/trades/portfolio-history-market');
const { createPortfolioHistoryService } = require('../src/modules/trades/portfolio-history.service');
const { shiftDate } = require('../src/modules/trades/history-dates');
const TIME = Date.parse('2026-10-25T09:00Z');
const FIRST = '2026-06-12';
const stock = symbol => ({ assetType: 'OFFSHORE_STOCK', symbol, currency: 'USD', exchange: 'XNAS' });
const days = (start, end, price = 10) => {
  const points = [];
  for (let date = start; date <= end; date = shiftDate(date, 1)) points.push({ date, price });
  return points;
};
function fixture({ first = FIRST, meta = {}, fail = false, ttlClock = TIME } = {}) {
  let time = ttlClock;
  const calls = [];
  const market = createPortfolioHistoryMarket({ now: () => time, fetchData: async input => {
    const url = new URL(input);
    const from = new Date(Number(url.searchParams.get('period1')) * 1000).toISOString().slice(0, 10);
    const to = shiftDate(new Date(Number(url.searchParams.get('period2')) * 1000).toISOString().slice(0, 10), -1);
    const symbol = decodeURIComponent(url.pathname.split('/').at(-1));
    calls.push({ symbol, from, to });
    const available = symbol === 'OLD' ? '2020-01-01' : first;
    if (to < available || (fail && calls.length > 1)) return { ok: false, status: 400 };
    const points = days(from > available ? from : available, to);
    return { ok: true, status: 200, json: async () => ({ chart: { result: [{
      meta: { symbol, currency: 'USD', instrumentType: 'EQUITY', exchangeName: 'NMS',
        firstTradeDate: Date.parse(available + 'T13:30Z') / 1000, ...meta },
      timestamp: points.map(point => Date.parse(point.date + 'T14:00Z') / 1000),
      indicators: { quote: [{ close: points.map(point => point.price) }] },
    }] } }) };
  } });
  return { market, calls, time: value => { time = value; } };
}

test('short -> ALL skips wholly pre-history prefix for SPCX and any unknown ticker, retaining cached prices', async () => {
  for (const symbol of ['SPCX', 'NEWLISTING', 'OTHERETF']) {
    const f = fixture();
    await f.market.getSeries(stock(symbol), '2026-10-01', '2026-10-25', { eventStart: FIRST });
    const all = await f.market.getSeries(stock(symbol), '2025-06-02', '2026-10-25');
    assert.equal(all.status, 'AVAILABLE');
    assert.equal(all.historyAvailableFrom, FIRST);
    assert.equal(all.points[0].date, FIRST);
    assert.equal(all.points.at(-1).date, '2026-10-25');
    assert.equal(all.cacheStatus, 'HIT');
    assert.equal(f.calls.length, 1);
    assert.equal(all.points.some(point => point.price === 0), false);
    assert.deepEqual(all.corporateActions, []);
    await f.market.getSeries(stock(symbol), '2025-01-01', '2026-10-25');
    assert.equal(f.calls.length, 1);
  }
});

test('partially pre-history extension clips provider request to firstTradeDate and merges all real prices', async () => {
  const f = fixture();
  await f.market.getSeries(stock('NEW'), '2026-10-01', '2026-10-25');
  const all = await f.market.getSeries(stock('NEW'), '2025-06-02', '2026-10-25');
  assert.equal(all.status, 'AVAILABLE');
  assert.equal(all.cacheStatus, 'PARTIAL');
  assert.deepEqual(f.calls[1], { symbol: 'NEW', from: FIRST, to: '2026-09-30' });
  assert.equal(all.points.length, days(FIRST, '2026-10-25').length);
  assert.equal(new Set(all.points.map(point => point.date)).size, all.points.length);
  const beforeListing = await f.market.getSeries(stock('NEW'), '2025-06-02', '2026-06-11');
  assert.equal(beforeListing.status, 'AVAILABLE');
  assert.deepEqual(beforeListing.points, []);
  assert.equal(f.calls.length, 2);
});

test('cold ALL and short -> ALL produce identical prices, while metadata-derived coverage expires normally', async () => {
  const f = fixture();
  await f.market.getSeries(stock('NEW'), FIRST, '2026-10-25');
  const warm = await f.market.getSeries(stock('NEW'), '2025-06-02', '2026-10-25');
  const cold = await fixture().market.getSeries(stock('NEW'), '2025-06-02', '2026-10-25');
  assert.deepEqual(warm.points, cold.points);
  f.time(TIME + 6 * 3600000);
  const refreshed = await f.market.getSeries(stock('NEW'), '2025-06-02', '2026-10-25');
  assert.equal(refreshed.status, 'AVAILABLE');
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[1], { symbol: 'NEW', from: '2025-06-02', to: '2026-10-25' });
});

test('missing/invalid/future/contradictory metadata does not convert a real HTTP 400 into empty data', async () => {
  for (const firstTradeDate of [undefined, 'invalid', null, 1e100, TIME / 1000 + 86400,
    Date.parse('2026-06-20T13:30Z') / 1000]) {
    const f = fixture({ meta: { firstTradeDate } });
    const warm = await f.market.getSeries(stock('NEW'), FIRST, '2026-10-25');
    assert.equal(warm.historyAvailableFrom, null);
    const failed = await f.market.getSeries(stock('NEW'), '2025-06-02', '2026-10-25');
    assert.equal(failed.status, 'UNAVAILABLE');
    assert.equal(failed.providerStatus, 400);
    const recent = await f.market.getSeries(stock('NEW'), '2026-10-01', '2026-10-25');
    assert.equal(recent.status, 'AVAILABLE');
  }
  const f = fixture({ fail: true });
  await f.market.getSeries(stock('NEW'), '2026-10-01', '2026-10-25');
  const failed = await f.market.getSeries(stock('NEW'), '2025-06-02', '2026-10-25');
  assert.equal(failed.providerStatus, 400); // The failed interval is after the verified first date.
});

test('availability metadata uses market date, is isolated by instrument, and does not mutate order data', async () => {
  const f = fixture({ meta: { firstTradeDate: Date.parse('2026-06-13T00:30Z') / 1000 } });
  const input = stock('NEW');
  const copy = structuredClone(input);
  const result = await f.market.getSeries(input, FIRST, '2026-10-25');
  assert.equal(result.historyAvailableFrom, FIRST); // New York date, not UTC June 13.
  await f.market.getSeries(stock('OLD'), '2025-06-02', '2026-10-25');
  assert.equal(f.calls.length, 2);
  assert.deepEqual(input, copy);
});

test('Thai stocks apply the same generic lower-bound rule using the Bangkok date', async () => {
  let calls = 0;
  const market = createPortfolioHistoryMarket({ now: () => TIME, fetchData: async input => {
    calls++;
    return { ok: true, status: 200, json: async () => ({ chart: { result: [{
      meta: { symbol: 'NEW.BK', currency: 'THB', instrumentType: 'EQUITY', exchangeName: 'SET',
        firstTradeDate: Date.parse('2026-06-11T18:00Z') / 1000 },
      timestamp: [Date.parse('2026-06-12T08:00Z') / 1000], indicators: { quote: [{ close: [12] }] },
    }] } }) };
  } });
  const input = { assetType: 'THAI_STOCK', symbol: 'NEW', currency: 'THB' };
  await market.getSeries(input, FIRST, '2026-10-25');
  const all = await market.getSeries(input, '2025-06-02', '2026-10-25');
  assert.equal(all.historyAvailableFrom, FIRST);
  assert.equal(all.status, 'AVAILABLE');
  assert.deepEqual(all.points, [{ date: FIRST, price: 12 }]);
  assert.equal(calls, 1);
});

test('chart short -> ALL preserves earlier portfolio values and leaves real pre-history holdings missing, never zero-filled', async () => {
  for (const buyDate of [FIRST, '2026-06-01']) {
    const f = fixture();
    const orders = [
      { ...stock('OLD'), units: 1, transactionType: 'BUY', tradeDate: '2025-06-16' },
      { ...stock('NEW'), units: 2, transactionType: 'BUY', tradeDate: buyDate },
    ];
    const original = structuredClone(orders);
    const service = createPortfolioHistoryService({ now: () => TIME,
      market: { getSeries: f.market.getSeries,
        getFxSeries: async (start, end) => ({ status: 'AVAILABLE', points: days(start, end, 34) }) },
      repository: { portfolioOrders: async () => ({ orders }) } });
    const small = await service.get('test', { range: '1M' });
    const all = await service.get('test', { range: 'ALL' });
    assert.deepEqual(small.points, all.points.filter(point => point.date >= small.startDate));
    assert.equal(all.positions.find(point => point.symbol === 'NEW').historyAvailableFrom, FIRST);
    assert.equal(all.points.find(point => point.date === '2026-05-31').marketValue, 340);
    assert.equal(all.points.find(point => point.date === FIRST).marketValue, 1020);
    if (buyDate === FIRST) assert.equal(all.status, 'COMPLETE');
    else {
      assert.equal(all.status, 'INCOMPLETE');
      assert.equal(all.points.find(point => point.date === '2026-06-01').marketValue, null);
      assert.ok(all.points.find(point => point.date === '2026-06-01').issues.includes('HISTORICAL_PRICE_MISSING'));
    }
    assert.deepEqual(orders, original);
  }
});
