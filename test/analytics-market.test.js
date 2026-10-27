const test = require('node:test');
const assert = require('node:assert/strict');
const { createPortfolioHistoryMarket } = require('../src/modules/trades/portfolio-history-market');
const now = () => Date.parse('2026-10-26T10:00Z');
test('public benchmark history validates identity, merges missing ranges and single-flights across owners without latest-price calls', async () => {
  const calls = [];
  const market = createPortfolioHistoryMarket({ now, fetchData: async input => {
    const url = new URL(input); calls.push(url);
    return { ok: true, status: 200, json: async () => ({ chart: { result: [{
      meta: { symbol: '^GSPC', instrumentType: 'INDEX', currency: 'USD', exchangeName: 'SNP', exchangeTimezoneName: 'America/New_York' },
      timestamp: [Date.parse('2026-10-23T20:00Z') / 1000], indicators: { quote: [{ close: [6000] }] },
    }] } }) };
  } });
  const [a, b] = await Promise.all([market.getIndexSeries('SP500', '2026-10-01', '2026-10-26'), market.getIndexSeries('SP500', '2026-10-01', '2026-10-26')]);
  assert.equal(a.status, 'AVAILABLE'); assert.equal(b.fromCache, true); assert.equal(calls.length, 1);
  assert.deepEqual(a.points, [{ date: '2026-10-23', price: 6000 }]);
  const short = await market.getIndexSeries('SP500', '2026-10-20', '2026-10-26');
  assert.equal(short.fromCache, true); assert.equal(calls.length, 1);
  await market.getIndexSeries('SP500', '2026-09-01', '2026-10-26');
  assert.equal(calls.length, 2); assert.equal(calls[1].searchParams.get('period2'), String(Date.parse('2026-10-01') / 1000));
  assert.equal(calls[0].searchParams.get('interval'), '1d');
});
test('wrong index symbol, currency, market or type is rejected; provider 429 diagnostics preserved and negatively cached', async () => {
  for (const meta of [{ symbol: 'SPY' }, { currency: 'THB' }, { exchangeName: 'NMS' }, { instrumentType: 'EQUITY' }]) {
    const market = createPortfolioHistoryMarket({ now, fetchData: async () => ({ ok: true, status: 200, json: async () => ({ chart: { result: [{
      meta: { symbol: '^GSPC', currency: 'USD', exchangeName: 'SNP', instrumentType: 'INDEX', ...meta },
      timestamp: [], indicators: { quote: [{ close: [] }] },
    }] } }) }) });
    assert.equal((await market.getIndexSeries('SP500', '2026-10-01', '2026-10-26')).status, 'UNAVAILABLE');
  }
  let calls = 0;
  const market = createPortfolioHistoryMarket({ now, fetchData: async () => { calls++; return { ok: false, status: 429, headers: new Headers() }; } });
  const r = await market.getIndexSeries('SP500', '2026-10-01', '2026-10-26');
  assert.equal(r.providerStatus, 429); assert.equal(r.limitSource, 'PROVIDER');
  await market.getIndexSeries('SP500', '2026-10-01', '2026-10-26'); assert.equal(calls, 1);
});
