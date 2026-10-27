const test = require('node:test');
const assert = require('node:assert/strict');
const { createPortfolioHistoryService } = require('../src/modules/trades/portfolio-history.service');
const now = () => Date.parse('2026-10-24T08:00:00Z');
const order = (type, date, units, extra = {}) => ({ assetType: 'OFFSHORE_STOCK', currency: 'USD', symbol: 'AMD',
  exchange: 'XNAS', accountNumber: 'A', transactionType: type, tradeDate: date, units, ...extra });
const series = points => ({ status: 'AVAILABLE', source: 'MOCK_HISTORY', points: points.map(([date, price]) => ({ date, price })) });
function fixture(orders, options = {}) {
  const calls = [];
  const market = { getSeries: async (item, start, end) => { calls.push(item.symbol); return options.series?.(item)
    || series([['2026-10-20', 100], ['2026-10-22', 110], ['2026-10-23', 120]]); },
    getFxSeries: async () => options.fx || series([['2026-10-20', 34], ['2026-10-23', 35]]) };
  return { calls, service: createPortfolioHistoryService({ now, market,
    repository: { portfolioOrders: async user => { assert.equal(user, 'owner'); return { orders, ...options.data }; } } }) };
}

test('replay quantities by effective day, not current holdings; includes past fully sold positions and excludes cash', async () => {
  const f = fixture([order('SELL', '2026-10-23', 10), order('BUY', '2026-10-20', 10)]);
  const r = await f.service.get('owner', { range: 'ALL' });
  assert.deepEqual(r.points.map(p => p.marketValue), [34000, 34000, 37400, 0, 0]);
  assert.equal(r.positions.length, 1);
  assert.equal(r.points[1].carriedPositionCount, 1);
  assert.equal(r.points[3].heldPositionCount, 0);
});

test('mixed assets value at historical price/NAV and historical FX; carry only backward, never future prices', async () => {
  const orders = [order('BUY', '2026-10-20', 2), order('BUY', '2026-10-20', 10, { assetType: 'THAI_STOCK', currency: 'THB', symbol: 'ASK' }),
    order('SUBSCRIPTION', '2026-10-20', 20, { assetType: 'MUTUAL_FUND', currency: 'THB', symbol: 'FUND' })];
  const f = fixture(orders, { series: item => item.assetType === 'OFFSHORE_STOCK' ? series([['2026-10-20', 100]])
    : item.assetType === 'THAI_STOCK' ? series([['2026-10-20', 10]]) : series([['2026-10-21', 12]]) });
  const r = await f.service.get('owner', { range: 'ALL' });
  assert.equal(r.points[0].marketValue, null);
  assert.equal(r.points[0].availableMarketValue, 6900);
  assert.equal(r.points[1].marketValue, 7140);
  assert.equal(r.points[3].marketValue, 7340); // USD200 at historical 35, not rate 34.
});

test('recent range replays earlier buys and checks earlier split coverage even for apparently closed positions', async () => {
  const f = fixture([order('BUY', '2026-09-01', 2), order('BUY', '2026-09-01', 1, { symbol: 'OLD' }),
    order('SELL', '2026-09-02', 1, { symbol: 'OLD' })]);
  const r = await f.service.get('owner', { range: '1W' });
  assert.equal(r.startDate, '2026-10-17');
  assert.deepEqual(f.calls, ['AMD', 'OLD']);
  assert.equal(r.points.at(-1).marketValue, 8400);
});

test('missing permission is explicit; partial values are not complete and no prices are invented', async () => {
  const f = fixture([order('BUY', '2026-10-20', 2)], { series: () => ({ status: 'UNAVAILABLE', source: 'FINNHUB', errorCode: 'HISTORY_ACCESS_DENIED' }) });
  const r = await f.service.get('owner', { range: 'ALL' });
  assert.equal(r.status, 'INCOMPLETE');
  assert.equal(r.positions[0].errorCode, 'HISTORY_ACCESS_DENIED');
  assert.ok(r.points.every(p => p.marketValue === null && p.availableMarketValue === 0));
});

test('missing historical FX and conflicting prices produce gaps; stale stock data is bounded', async () => {
  const f = fixture([order('BUY', '2026-10-15', 2)], { fx: series([]), series: () => series([['2026-10-15', 100]]) });
  const r = await f.service.get('owner', { range: 'ALL' });
  assert.ok(r.points.every(p => p.marketValue === null));
  assert.ok(r.points.at(-1).issues.includes('HISTORICAL_PRICE_MISSING'));
  const conflict = fixture([order('BUY', '2026-10-20', 1)], { series: () => series([['2026-10-20', 10], ['2026-10-20', 11]]) });
  assert.equal((await conflict.service.get('owner', { range: 'ALL' })).positions[0].errorCode, 'HISTORY_CONFLICTING_OBSERVATIONS');
});

test('same-day end quantities, tiny stock closure and fund switches are replayed without cost-basis assumptions', async () => {
  const f = fixture([order('BUY', '2026-10-20', 1), order('SELL', '2026-10-22', 0.9999998),
    order('SWITCH_IN', '2026-10-20', 2, { assetType: 'MUTUAL_FUND', currency: 'THB', symbol: 'FUND' }),
    order('SWITCH_OUT', '2026-10-22', 2, { assetType: 'MUTUAL_FUND', currency: 'THB', symbol: 'FUND' })]);
  const r = await f.service.get('owner', { range: 'ALL' });
  assert.equal(r.points[2].marketValue, 0);
});

test('collisions, special orders and negative balances block misleading chart values from that day', async () => {
  for (const bad of [order('BUY', '2026-10-22', 1, { collision: true }), order('REW', '2026-10-22', 1), order('SELL', '2026-10-22', 3)]) {
    const f = fixture([order('BUY', '2026-10-20', 1), bad]);
    const r = await f.service.get('owner', { range: 'ALL' });
    assert.equal(r.points[0].isComplete, true);
    assert.equal(r.points.at(-1).isComplete, false);
  }
});

test('invalid ranges, missing trade dates, truncation and overlong ALL fail explicitly; empty account is empty', async () => {
  const f = fixture([]);
  assert.equal((await f.service.get('owner')).status, 'EMPTY');
  for (const range of ['BAD', ['1W', '1Y']]) await assert.rejects(f.service.get('owner', { range }), { code: 'INVALID_HISTORY_RANGE' });
  await assert.rejects(fixture([order('BUY', null, 1)]).service.get('owner'), { code: 'HISTORY_TRADE_DATE_REQUIRED' });
  await assert.rejects(fixture([], { data: { truncated: true } }).service.get('owner'), { code: 'HISTORY_ORDER_LIMIT_EXCEEDED' });
  await assert.rejects(fixture([order('BUY', '2000-01-01', 1)]).service.get('owner', { range: 'ALL' }), { code: 'HISTORY_RANGE_TOO_LARGE' });
});
