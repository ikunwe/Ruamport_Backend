const test = require('node:test');
const assert = require('node:assert/strict');
const { createPortfolioHistoryMarket } = require('../src/modules/trades/portfolio-history-market');
const { createPortfolioHistoryService } = require('../src/modules/trades/portfolio-history.service');
const { shiftDate, marketDate } = require('../src/modules/trades/history-dates');
const { decimal, number } = require('../src/modules/trades/valuation-decimal');
const { applySplit } = require('../src/modules/trades/history-corporate-actions');
const stock = { assetType: 'OFFSHORE_STOCK', symbol: 'SPLITTEST', exchange: 'XNAS', currency: 'USD' };
const START = '2025-11-14', END = '2025-12-03';
const split = (date, numerator, denominator) => ({ date, numerator, denominator });
const rows = (start, end, price = 1) => {
  const points = [];
  for (let date = start; date <= end; date = shiftDate(date, 1)) points.push({ date, price });
  return points;
};
function fixture(actions, { raw = 111.21699523925781, hint = 2, time = Date.parse('2025-12-03T21:00Z'), evolving = false } = {}) {
  let current = time;
  const calls = [];
  const market = createPortfolioHistoryMarket({ now: () => current, fetchData: async input => {
    const url = new URL(input);
    const from = new Date(Number(url.searchParams.get('period1')) * 1000).toISOString().slice(0, 10);
    const to = shiftDate(new Date(Number(url.searchParams.get('period2')) * 1000).toISOString().slice(0, 10), -1);
    calls.push({ from, to });
    const asOf = marketDate(current, 'America/New_York');
    const visible = actions.filter(action => action.date <= asOf);
    const points = rows(from, to);
    return { ok: true, status: 200, json: async () => ({ chart: { result: [{
      meta: { symbol: stock.symbol, currency: 'USD', exchangeName: 'NMS', instrumentType: 'EQUITY', priceHint: hint },
      timestamp: points.map(point => Date.parse(point.date + 'T14:30Z') / 1000),
      indicators: { quote: [{ close: points.map(point => {
        if (!evolving) return raw;
        // A constant as-traded value before the action; Yahoo only adjusts old
        // bars after the action has taken effect in the provider's generation.
        const asTraded = actions.filter(action => action.date <= point.date).reduce((value, action) =>
          applySplit(value, { numerator: action.denominator, denominator: action.numerator }), decimal(1000));
        return number(visible.filter(action => point.date < action.date).reduce((value, action) =>
          applySplit(value, { numerator: action.denominator, denominator: action.numerator }), asTraded), 8);
      }) }] },
      events: { splits: Object.fromEntries(visible.filter(action => action.date >= from && action.date <= to)
        .map(action => [action.date, { ...action, date: Date.parse(action.date + 'T14:30Z') / 1000,
          splitRatio: `${action.numerator}:${action.denominator}` }])) },
    }] } }) };
  } });
  return { market, calls, time: value => { current = value; } };
}

for (const [name, actions, expected] of [
  ['forward 10:1', [split('2025-11-17', 10, 1)], 1112.17],
  ['reverse 1:5', [split('2025-11-17', 1, 5)], 22.24],
  ['reverse 1:3', [split('2025-11-17', 1, 3)], 37.07],
  ['forward then reverse', [split('2025-11-17', 10, 1), split('2025-12-01', 1, 5)], 222.43],
  ['two reverse splits', [split('2025-11-17', 1, 5), split('2025-12-01', 1, 3)], 7.41],
]) {
  test(`${name}: split-day cache -> ALL matches cold ALL including rounding and every portfolio value`, async () => {
    const warm = fixture(actions);
    await warm.market.getSeries(stock, actions.at(-1).date, END);
    const expanded = await warm.market.getSeries(stock, START, END);
    const coldFixture = fixture(actions);
    const cold = await coldFixture.market.getSeries(stock, START, END);
    assert.equal(expanded.status, 'AVAILABLE');
    assert.equal(expanded.priceBasis, 'AS_TRADED_UNADJUSTED');
    assert.deepEqual(expanded.points, cold.points);
    assert.deepEqual(expanded.corporateActions, cold.corporateActions);
    assert.equal(expanded.points[0].price, expected);
    assert.ok(expanded.points.every(point => Object.keys(point).sort().join(',') === 'date,price'));
    assert.equal(Object.hasOwn(expanded, 'normalizationActions'), false);
    const before = warm.calls.length;
    const repeated = await warm.market.getSeries(stock, START, END);
    assert.deepEqual(repeated.points, cold.points);
    assert.equal(warm.calls.length, before);

    const orders = [{ ...stock, transactionType: 'BUY', tradeDate: START, units: 30 },
      { ...stock, transactionType: 'BUY', tradeDate: '2025-11-18', units: 3 },
      { ...stock, transactionType: 'SELL', tradeDate: '2025-12-02', units: 1 }];
    const originals = structuredClone(orders);
    const chart = market => createPortfolioHistoryService({ now: () => Date.parse(END + 'T21:00Z'),
      repository: { portfolioOrders: async () => ({ orders }) },
      market: { getSeries: market.getSeries, getFxSeries: async (start, end) => ({ status: 'AVAILABLE', points: rows(start, end) }) } });
    const a = await chart(warm.market).get('synthetic-owner-A', { range: 'ALL' });
    const b = await chart(coldFixture.market).get('synthetic-owner-B', { range: 'ALL' });
    assert.equal(a.status, 'COMPLETE');
    assert.equal(b.status, 'COMPLETE');
    assert.deepEqual(a.points, b.points);
    assert.deepEqual(orders, originals);
  });
}

test('multiple disjoint intervals merge all actions before normalization; smaller end dates still use known later adjustments', async () => {
  const actions = [split('2025-11-17', 10, 1), split('2025-12-01', 1, 5)];
  const warm = fixture(actions, { hint: 8, raw: 500.0617 });
  await warm.market.getSeries(stock, '2025-11-17', '2025-11-20');
  await warm.market.getSeries(stock, '2025-12-01', END);
  const expanded = await warm.market.getSeries(stock, START, END);
  const cold = await fixture(actions, { hint: 8, raw: 500.0617 }).market.getSeries(stock, START, END);
  assert.deepEqual(expanded.points, cold.points);
  assert.equal(expanded.points[0].price, 1000.1234);
  assert.equal(expanded.points.find(point => point.date === '2025-11-18').price, 100.01234);
  assert.equal(expanded.points.at(-1).price, 500.0617);
  const before = warm.calls.length;
  const earlier = await warm.market.getSeries(stock, START, '2025-11-16');
  assert.deepEqual(earlier.points, cold.points.filter(point => point.date <= '2025-11-16'));
  assert.deepEqual(earlier.corporateActions, []); // Not future events for quantity replay.
  assert.equal(warm.calls.length, before);
});

for (const [numerator, denominator] of [[10, 1], [1, 5]]) {
  test(`cache crosses a new ${numerator}:${denominator} action: pre-action raw generation is not adjusted twice`, async () => {
    const actions = [split('2025-11-17', numerator, denominator)];
    const before = Date.parse('2025-11-17T04:30Z'); // Nov 16 in New York.
    const after = Date.parse('2025-11-17T06:30Z'); // Nov 17, cache age only 2h.
    const warm = fixture(actions, { time: before, evolving: true, hint: 8 });
    await warm.market.getSeries(stock, START, '2025-11-16');
    warm.time(after);
    const expanded = await warm.market.getSeries(stock, START, '2025-11-17');
    const cold = await fixture(actions, { time: after, evolving: true, hint: 8 }).market.getSeries(stock, START, '2025-11-17');
    assert.equal(expanded.status, 'AVAILABLE');
    assert.deepEqual(expanded.points, cold.points);
    assert.equal(expanded.points[0].price, 1000);
    assert.deepEqual(warm.calls.at(-1), { from: '2025-11-17', to: '2025-11-17' });
  });
}
