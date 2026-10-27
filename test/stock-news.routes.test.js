const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');
const { createTradeRouter } = require('../src/modules/trades/trade.routes');
const { createInvestmentService } = require('../src/modules/trades/investment.service');
const { createStockPriceService } = require('../src/modules/trades/stock-price.service');
const { errorHandler } = require('../src/middlewares/error.middleware');
const held = extra => ({ assetType: 'OFFSHORE_STOCK', symbol: 'AMD', exchange: 'XNAS', currency: 'USD', quantity: 2, ...extra });
async function serverFor(t, investments, authenticate = (req, _res, next) => { req.user = { id: req.headers['x-test-owner'] || 'owner' }; next(); }) {
  const app = express();
  app.use('/trades', createTradeRouter({ investments, authenticate }));
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return 'http://127.0.0.1:' + server.address().port + '/trades';
}
test('stock news endpoint requires authentication before DB/provider work', async t => {
  const app = express();
  app.use('/trades', createTradeRouter({ investments: { news: () => { throw new Error('Should not run'); } } }));
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch('http://127.0.0.1:' + server.address().port + '/trades/stocks/AMD/news');
  assert.equal(response.status, 401);
});
test('news route uses authenticated ownership and validates queries before DB access', async t => {
  let dbCalls = 0;
  let newsCalls = 0;
  const investments = createInvestmentService({
    repository: { holdings: async (user, closed) => { dbCalls++; assert.equal(user, 'owner'); assert.equal(closed, false); return { items: [held()] }; } },
    marketPrices: { newsCacheTtlSeconds: 1800, getNews: async item => {
      newsCalls++; assert.equal(item.symbol, 'AMD');
      return { status: 'AVAILABLE', source: 'FINNHUB', items: [{ id: '1' }, { id: '2' }] };
    } },
  });
  const base = await serverFor(t, investments);
  for (const query of ['limit=0', 'limit=51', 'limit=foo', 'limit=1&limit=2', 'exchange=XNAS&exchange=XNYS', 'exchange=http://evil']) {
    assert.equal((await fetch(base + '/stocks/AMD/news?' + query)).status, 400);
  }
  assert.equal(dbCalls, 0);
  const response = await fetch(base + '/stocks/amd/news?exchange=XNAS&limit=1&userId=someone-else');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.equal(body.items.length, 1);
  assert.equal(body.hasMore, true);
  assert.equal(body.maxItems, 50);
  assert.equal(newsCalls, 1);
});
test('unheld, closed, fund and unsupported instruments cannot spend news quota', async t => {
  for (const item of [held({ quantity: 0 }), held({ quantity: -1 }), held({ currency: 'THB' }),
    held({ assetType: 'MUTUAL_FUND' }), held({ symbol: 'OTHER' })]) {
    const investments = createInvestmentService({ repository: { holdings: async () => ({ items: [item] }) },
      marketPrices: { getNews: async () => { throw new Error('Unexpected upstream call'); } } });
    const base = await serverFor(t, investments);
    assert.equal((await fetch(base + '/stocks/AMD/news')).status, 404);
  }
});
test('ambiguous stock market requires exchange selection', async () => {
  const investments = createInvestmentService({ repository: { holdings: async () => ({ items: [held(), held({ exchange: 'XNYS' })] }) },
    marketPrices: { newsCacheTtlSeconds: 1800, getNews: async () => ({ status: 'AVAILABLE', items: [] }) } });
  await assert.rejects(() => investments.news('owner', 'AMD'), { code: 'AMBIGUOUS_STOCK_MARKET' });
  assert.equal((await investments.news('owner', 'AMD', { exchange: 'XNAS' })).status, 'AVAILABLE');
});
test('news provider cache is shared across owners but never stores or returns their private holdings', async t => {
  let calls = 0;
  const time = Date.parse('2026-10-20T15:00:00Z');
  const marketPrices = createStockPriceService({ apiKey: 'private-key', now: () => time, fetchQuote: async input => {
    calls++;
    const path = new URL(input).pathname;
    return { ok: true, status: 200, json: async () => path.endsWith('/stock/symbol')
      ? [{ symbol: 'AMD', mic: 'XNGS', currency: 'USD' }] : [{ id: 1, headline: 'Update', related: 'AMD',
        datetime: time / 1000, url: 'https://publisher.example/article' }] };
  } });
  const investments = createInvestmentService({ marketPrices,
    repository: { holdings: async user => ({ items: [held({ quantity: user === 'A' ? 2 : 900 })] }) } });
  const base = await serverFor(t, investments);
  const bodies = await Promise.all(['A', 'B'].map(async owner => (await fetch(base + '/stocks/AMD/news', { headers: { 'x-test-owner': owner } })).json()));
  assert.equal(calls, 2);
  assert.ok(bodies.every(body => body.source === 'FINNHUB' && body.items.length === 1));
  assert.ok(bodies.every(body => !JSON.stringify(body).includes('private-key') && !Object.hasOwn(body, 'quantity')));
});
test('holdings HTTP exposes daily quote fields without extra provider calls or FX conversion', async t => {
  let calls = 0;
  const time = Date.parse('2026-10-20T15:00:00Z');
  const marketPrices = createStockPriceService({ apiKey: 'private-key', now: () => time,
    fetchQuote: async input => {
      calls++;
      return { ok: true, status: 200, json: async () => new URL(input).pathname.endsWith('/stock/symbol')
        ? [{ symbol: 'AMD', mic: 'XNGS', currency: 'USD' }]
        : { c: 150, pc: 155, d: -5, dp: -3.2258, t: time / 1000 } };
    } });
  const investments = createInvestmentService({ marketPrices,
    exchangeRates: { getRate: async () => ({ status: 'AVAILABLE', rate: 34 }) },
    domesticPrices: { getQuotes: async () => new Map() },
    repository: { holdings: async () => ({ items: [held({ costBasis: [
      { currency: 'USD', status: 'CALCULATED', remainingCost: 200 },
    ] })] }) } });
  const base = await serverFor(t, investments);
  for (let i = 0; i < 2; i++) {
    const response = await fetch(base + '/holdings?includeMarket=true&includeFx=true');
    assert.equal(response.status, 200);
    const body = await response.json();
    const value = body.items[0].marketValuation;
    assert.equal(value.quote.previousClose, 155);
    assert.equal(value.quote.change, -5);
    assert.equal(value.quote.changePercent, -3.2258);
    assert.equal(value.usd.unrealizedPnlPercent, 50);
    assert.equal(value.quote.currency, 'USD');
  }
  assert.equal(calls, 2);
});

test('news setup failure is advisory HTTP 200, not a holdings failure', async t => {
  const investments = createInvestmentService({ repository: { holdings: async () => ({ items: [held()] }) },
    marketPrices: createStockPriceService({ apiKey: '' }) });
  const base = await serverFor(t, investments);
  const response = await fetch(base + '/stocks/AMD/news');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.errorCode, 'MARKET_DATA_CONFIG_MISSING');
  assert.deepEqual(body.items, []);
});
