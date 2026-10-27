const test = require('node:test');
const assert = require('node:assert/strict');
const { createPortfolioHistoryMarket } = require('../src/modules/trades/portfolio-history-market');
const { createPortfolioHistoryService } = require('../src/modules/trades/portfolio-history.service');
const NFLX_SPLIT = { type: 'SPLIT', date: '2025-11-17', numerator: 10, denominator: 1, source: 'YAHOO_FINANCE' };
const splitStamp = Date.parse('2025-11-17T14:30Z') / 1000;
const stock = (symbol = 'NFLX', exchange = 'XNAS') => ({ assetType: 'OFFSHORE_STOCK', symbol, exchange, currency: 'USD' });
const body = (symbol, extra = {}) => ({ chart: { result: [{ meta: { symbol, currency: 'USD', exchangeName: 'NMS',
  instrumentType: 'EQUITY', priceHint: 2 }, timestamp: [Date.parse('2025-11-14T14:30Z') / 1000, splitStamp],
  indicators: { quote: [{ close: [100.123, 102.5] }] }, events: { splits: { [splitStamp]: {
    date: splitStamp, numerator: 10, denominator: 1, splitRatio: '10:1' } } }, ...extra }] } });
const ok = json => ({ ok: true, status: 200, json: async () => json });

test('NFLX split prices are restored before rounding and the ex-date uses post-split price', async () => {
  const market = createPortfolioHistoryMarket({ fetchData: async () => ok(body('NFLX')) });
  const result = await market.getSeries(stock(), '2025-11-14', '2025-11-18');
  assert.equal(result.status, 'AVAILABLE');
  assert.deepEqual(result.points, [{ date: '2025-11-14', price: 1001.23 }, { date: '2025-11-17', price: 102.5 }]);
  assert.deepEqual(result.corporateActions, [NFLX_SPLIT]);
  assert.equal(result.priceBasis, 'AS_TRADED_UNADJUSTED');
});

test('recent NFLX history still requests the verified split event for pre-existing holdings', async () => {
  const market = createPortfolioHistoryMarket({ fetchData: async input => {
    assert.equal(new URL(input).searchParams.get('period1'), String(Date.parse('2025-11-17') / 1000));
    return ok(body('NFLX'));
  } });
  assert.equal((await market.getSeries(stock(), '2026-10-01', '2026-10-24', { eventStart: '2025-11-17' })).status, 'AVAILABLE');
});

test('malformed, future, ratio-conflicting or duplicate split events fail closed', async () => {
  for (const [symbol, splits] of [
    ['NFLX', { x: { date: splitStamp, numerator: 0, denominator: 1 } }],
    ['NFLX', { x: { date: splitStamp + 10 * 86400, numerator: 10, denominator: 1 } }],
    ['ASML', { x: { date: splitStamp, numerator: 10, denominator: 1, splitRatio: '5:1' } }],
    ['NFLX', { x: { date: splitStamp, numerator: 10, denominator: 1 }, y: { date: splitStamp, numerator: 10, denominator: 1 } }],
  ]) {
    const market = createPortfolioHistoryMarket({ fetchData: async () => ok(body(symbol, { events: { splits } })) });
    assert.equal((await market.getSeries(stock(symbol), '2025-11-14', '2025-11-18')).status, 'UNAVAILABLE');
  }
});

test('corroborated current listing handles QS without rewriting PDF market or guessing a transfer date', async () => {
  const input = stock('QS', 'XNYS');
  const market = createPortfolioHistoryMarket({ marketPrices: { getHistoricalListingIdentity: async () => ({ status: 'AVAILABLE', symbol: 'QS', currency: 'USD', micCode: 'XNAS', instrumentType: 'EQUITY' }) },
    fetchData: async () => ok(body('QS', { events: {} })) });
  const result = await market.getSeries(input, '2025-11-14', '2025-11-18');
  assert.equal(result.status, 'AVAILABLE');
  assert.equal(result.listingTransfer.effectiveDate, null);
  assert.equal(result.listingTransfer.fromMic, 'XNYS');
  assert.equal(input.exchange, 'XNYS');
  const wrong = createPortfolioHistoryMarket({ fetchData: async () => ok(body('OTHER', { events: {} })) });
  assert.equal((await wrong.getSeries(stock('OTHER', 'XNYS'), '2025-11-14', '2025-11-18')).status, 'UNAVAILABLE');
  for (const extra of [{ symbol: 'UNRELATED' }, { currency: 'EUR' }, { exchangeName: 'AMS' }, { instrumentType: 'ETF' }]) {
    const json = body('QS', { events: {} });
    Object.assign(json.chart.result[0].meta, extra);
    const instance = createPortfolioHistoryMarket({ fetchData: async () => ok(json) });
    // ETF is not a verified company identity for this listing exception.
    const r = await instance.getSeries(input, '2025-11-14', '2025-11-18');
    assert.equal(r.status, 'UNAVAILABLE');
  }
});

function chart(orders, now = '2025-11-18T08:00Z', prices = [{ date: '2025-11-14', price: 1000 }, { date: '2025-11-17', price: 100 }]) {
  return createPortfolioHistoryService({ now: () => Date.parse(now),
    repository: { portfolioOrders: async () => ({ orders }) }, market: {
      getSeries: async () => ({ status: 'AVAILABLE', source: 'YAHOO_FINANCE', points: prices, corporateActions: [NFLX_SPLIT], priceBasis: 'AS_TRADED_UNADJUSTED' }),
      getFxSeries: async () => ({ status: 'AVAILABLE', points: prices.map(p => ({ date: p.date, price: 1 })) }),
    } });
}
const order = (transactionType, tradeDate, units) => ({ ...stock(), transactionType, tradeDate, units });
test('holding across split keeps value continuous, applies split before same-day buys and permits full post-split sale', async () => {
  const orders = [order('BUY', '2025-11-14', 2), order('BUY', '2025-11-17', 1), order('SELL', '2025-11-18', 21)];
  const before = structuredClone(orders);
  const result = await chart(orders).get('user', { range: 'ALL' });
  assert.deepEqual(result.points.map(p => p.marketValue), [2000, 2000, 2000, 2100, 0]);
  assert.deepEqual(orders, before);
});
test('closed before split does not create holdings, recent range restores split-adjusted opening quantity', async () => {
  const closed = await chart([order('BUY', '2025-11-14', 2), order('SELL', '2025-11-16', 2)]).get('user', { range: 'ALL' });
  assert.equal(closed.points.at(-1).marketValue, 0);
  const dustClosed = await chart([order('BUY', '2025-11-14', 1), order('SELL', '2025-11-16', 0.9999998)]).get('user', { range: 'ALL' });
  assert.equal(dustClosed.points.at(-1).marketValue, 0);
  const recent = await chart([order('BUY', '2025-07-01', 1), order('SELL', '2026-09-01', 1)], '2026-10-24T08:00Z',
    [{ date: '2026-10-23', price: 100 }]).get('user', { range: '1D' });
  assert.equal(recent.points[0].marketValue, 900);
  assert.equal(recent.points[1].marketValue, 900);
});
