const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');
const { createTradeRouter } = require('../src/modules/trades/trade.routes');
const { createInvestmentService } = require('../src/modules/trades/investment.service');
const { createDomesticMarketService } = require('../src/modules/trades/domestic-market.service');
const { errorHandler } = require('../src/middlewares/error.middleware');
const TIME = Date.parse('2026-10-21T08:00:00Z');
test('HTTP Thai logo opt-in exposes SET URL and fallback without any domestic provider call', async t => {
  const investments = createInvestmentService({
    repository: { holdings: async user => {
      assert.equal(user, 'owner');
      return { items: itemsFor('A') };
    } },
    marketPrices: { getLogos: async () => new Map() },
    domesticPrices: { getQuotes: () => { throw new Error('Unexpected price request'); } },
  });
  const base = await serverFor(t, investments);
  const response = await fetch(base + '/holdings?includeLogos=true&symbol=PTT&userId=other');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.equal(body.items[0].symbol, 'ASK');
  assert.equal(body.items[0].logoUrl, 'https://media.set.or.th/common/logo/company/ASK.png');
  assert.equal(body.items[0].logo.status, 'UNVERIFIED');
  assert.equal(body.items[0].logo.fallbackText, 'ASK');
  assert.equal(body.items[0].marketValuation, undefined);
  assert.equal(body.items[1].logoUrl, null);
});
async function serverFor(t, investments) {
  const app = express();
  app.use('/trades', createTradeRouter({ investments, authenticate: (req, _res, next) => {
    req.user = { id: req.headers['x-test-owner'] || 'owner' }; next();
  } }));
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return 'http://127.0.0.1:' + server.address().port + '/trades';
}
const itemsFor = user => [
  { assetType: 'THAI_STOCK', symbol: 'ASK', currency: 'THB', quantity: user === 'A' ? 100 : 200,
    costBasisMethod: 'FIFO', costBasis: [{ currency: 'THB', status: 'CALCULATED', remainingCost: user === 'A' ? 800 : 1600 }] },
  { assetType: 'MUTUAL_FUND', symbol: 'KKP US500-UH-E', currency: 'THB', quantity: user === 'A' ? 10 : 20,
    costBasisMethod: 'MOVING_WEIGHTED_AVERAGE', costBasis: [{ currency: 'THB', status: 'CALCULATED', remainingCost: user === 'A' ? 100 : 200 }] },
];
function provider(key = 'private-sec-key') {
  let calls = 0;
  const service = createDomesticMarketService({ secApiKey: key, now: () => TIME, fetchData: async input => {
    calls++;
    const path = new URL(input).pathname;
    let data;
    if (path.includes('/profiles')) data = { message: 'success', next_cursor: '', items: [
      { proj_id: 'M0123_2563', fund_class_name: 'KKPUS500-UH-E', fund_status: 'Registered' }] };
    else if (path.includes('/daily-info/nav')) data = { message: 'success', next_cursor: '', items: [
      { proj_id: 'M0123_2563', fund_class_name: 'KKPUS500-UH-E', nav_date: '2026-10-20', last_val: 12 },
      { proj_id: 'M0123_2563', fund_class_name: 'KKPUS500-UH-E', nav_date: '2026-10-19', last_val: 10 }] };
    else data = { chart: { result: [{ meta: { symbol: 'ASK.BK', currency: 'THB', exchangeName: 'SET',
      instrumentType: 'EQUITY', regularMarketPrice: 10, regularMarketTime: TIME / 1000 },
      timestamp: [TIME / 1000 - 86400, TIME / 1000], indicators: { quote: [{ close: [8, 10] }] } }] } };
    return { ok: true, status: 200, json: async () => data };
  } });
  return { service, calls: () => calls };
}
test('HTTP holdings shares only provider snapshots, never quantities/costs across authenticated owners', async t => {
  const p = provider();
  const investments = createInvestmentService({
    repository: { holdings: async user => { assert.ok(['A', 'B'].includes(user)); return { items: itemsFor(user) }; } },
    domesticPrices: p.service, marketPrices: { cacheTtlSeconds: 900, getQuotes: async () => new Map() },
  });
  const base = await serverFor(t, investments);
  const responses = await Promise.all(['A', 'B'].map(owner => fetch(base + '/holdings?includeMarket=true&userId=other&symbol=ARBITRARY',
    { headers: { 'x-test-owner': owner } })));
  assert.ok(responses.every(r => r.status === 200 && r.headers.get('cache-control') === 'no-store'));
  const [a, b] = await Promise.all(responses.map(r => r.json()));
  assert.equal(p.calls(), 3);
  assert.equal(a.items[0].marketValuation.thb.marketValue, 1000);
  assert.equal(b.items[0].marketValuation.thb.marketValue, 2000);
  assert.equal(a.items[0].marketValuation.thb.unrealizedPnl, 200);
  assert.equal(a.items[1].marketValuation.thb.unrealizedPnl, 20);
  assert.equal(a.items[1].marketValuation.quote.navDate, '2026-10-20');
  assert.equal(a.items[1].marketValuation.quote.priceAt, null);
  assert.equal(a.items[0].marketValuation.quote.previousClose, 8);
  assert.equal(a.items[0].marketValuation.quote.change, 2);
  assert.equal(a.items[0].marketValuation.quote.changePercent, 25);
  assert.equal(a.items[1].marketValuation.quote.previousNav, 10);
  assert.equal(a.items[1].marketValuation.quote.previousNavDate, '2026-10-19');
  assert.equal(a.items[1].marketValuation.quote.change, 2);
  assert.equal(a.items[1].marketValuation.quote.changePercent, 20);
  assert.equal(a.items[0].costBasisMethod, 'FIFO');
  assert.equal(a.items[1].costBasisMethod, 'MOVING_WEIGHTED_AVERAGE');
  assert.equal(a.thaiStockValuation.thb.marketValue, 1000);
  assert.equal(a.mutualFundValuation.thb.marketValue, 120);
  assert.equal(JSON.stringify(a).includes('private-sec-key'), false);
});
test('HTTP missing SEC key is advisory; Thai price stays available and fund cost is not erased', async t => {
  const p = provider('');
  const investments = createInvestmentService({
    repository: { holdings: async () => ({ items: itemsFor('A') }) },
    domesticPrices: p.service, marketPrices: { cacheTtlSeconds: 900, getQuotes: async () => new Map() },
  });
  const base = await serverFor(t, investments);
  const response = await fetch(base + '/holdings?includeMarket=true');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.items[0].marketValuation.thb.marketValue, 1000);
  assert.equal(body.items[1].marketValuation.quote.errorCode, 'SEC_API_KEY_MISSING');
  assert.equal(body.items[1].marketValuation.thb.marketValue, null);
  assert.equal(body.items[1].marketValuation.thb.remainingCost, 100);
  assert.equal(body.mutualFundValuation.thb.unrealizedPnl, null);
  assert.equal(body.mutualFundValuation.isComplete, false);
  assert.equal(p.calls(), 1);
});
test('HTTP opt-in false or invalid never invokes domestic provider', async t => {
  let calls = 0;
  const investments = createInvestmentService({
    repository: { holdings: async () => ({ items: itemsFor('A') }) },
    domesticPrices: { getQuotes: async () => { calls++; throw new Error('Unexpected provider request'); } },
  });
  const base = await serverFor(t, investments);
  assert.equal((await fetch(base + '/holdings')).status, 200);
  assert.equal((await fetch(base + '/holdings?includeMarket=no')).status, 400);
  assert.equal(calls, 0);
});
