const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');
const { createInvestmentService } = require('../src/modules/trades/investment.service');
const { createTradeRouter } = require('../src/modules/trades/trade.routes');
const { errorHandler } = require('../src/middlewares/error.middleware');
const { createPortfolioHistoryMarket } = require('../src/modules/trades/portfolio-history-market');

test('combined chart HTTP uses Yahoo offshore and Thai, SEC NAV and historical FX without invoking Finnhub', async t => {
  const orders = [
    { assetType: 'OFFSHORE_STOCK', symbol: 'NVDA', exchange: 'XNAS', currency: 'USD', units: 2, transactionType: 'BUY' },
    { assetType: 'THAI_STOCK', symbol: 'ASK', currency: 'THB', units: 5, transactionType: 'BUY' },
    { assetType: 'MUTUAL_FUND', symbol: 'FUND', currency: 'THB', units: 10, transactionType: 'SUBSCRIPTION' },
  ].map(order => ({ ...order, tradeDate: '2026-10-23' }));
  let calls = 0;
  const historyMarket = createPortfolioHistoryMarket({
    domesticPrices: { getFundDailyHistory: async () => ({ status: 'AVAILABLE', source: 'SEC_OPEN_API',
      points: [{ date: '2026-10-23', price: 12 }] }) },
    fetchData: async input => {
      calls++;
      const url = new URL(input);
      const body = url.hostname === 'api.frankfurter.dev'
        ? [{ base: 'USD', quote: 'THB', date: '2026-10-23', rate: 34 }]
        : { chart: { result: [{ meta: { symbol: url.pathname.endsWith('/NVDA') ? 'NVDA' : 'ASK.BK',
          currency: url.pathname.endsWith('/NVDA') ? 'USD' : 'THB',
          exchangeName: url.pathname.endsWith('/NVDA') ? 'NMS' : 'SET', instrumentType: 'EQUITY' },
          timestamp: [Date.parse('2026-10-23T14:00Z') / 1000],
          indicators: { quote: [{ close: [url.pathname.endsWith('/NVDA') ? 100 : 10] }] } }] } };
      return { ok: true, status: 200, json: async () => body };
    },
  });
  const investments = createInvestmentService({ historyMarket, historyNow: () => Date.parse('2026-10-24T08:00Z'),
    repository: { portfolioOrders: async owner => { assert.equal(owner, 'owner'); return { orders }; } },
    marketPrices: new Proxy({}, { get: () => { throw new Error('History must not invoke Finnhub'); } }) });
  const app = express();
  app.use('/trades', createTradeRouter({ investments, authenticate: (req, res, next) => { req.user = { id: 'owner' }; next(); } }));
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/trades/portfolio-history?range=ALL`;
  for (let i = 0; i < 2; i++) {
    const response = await fetch(url);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.status, 'COMPLETE');
    assert.equal(result.points[0].marketValue, 6970);
    assert.deepEqual(result.points[0].byAssetType.map(row => row.marketValue), [6800, 50, 120]);
    assert.deepEqual(result.positions.map(row => row.source), ['YAHOO_FINANCE', 'YAHOO_FINANCE', 'SEC_OPEN_API']);
  }
  assert.equal(calls, 3);
});

test('historical chart HTTP requires auth and preserves owner-specific quantities, no-store and range validation', async t => {
  let calls = 0;
  const investments = createInvestmentService({ historyNow: () => Date.parse('2026-10-24T08:00Z'),
    repository: { portfolioOrders: async user => { calls++; return { orders: [{ assetType: 'THAI_STOCK', symbol: 'ASK', currency: 'THB',
      units: user === 'A' ? 10 : 20, transactionType: 'BUY', tradeDate: '2026-10-23' }] }; } },
    historyMarket: { getSeries: async () => ({ status: 'AVAILABLE', points: [{ date: '2026-10-23', price: 10 }] }) } });
  const app = express();
  app.use('/trades', createTradeRouter({ investments, authenticate: (req, res, next) => {
    if (!['A', 'B'].includes(req.headers['x-test-user'])) return res.status(401).json({ error: { code: 'UNAUTHORIZED' } });
    req.user = { id: req.headers['x-test-user'] }; next();
  } }));
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/trades/portfolio-history`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal(calls, 0);
  assert.equal((await fetch(url + '?range=BAD', { headers: { 'x-test-user': 'A' } })).status, 400);
  assert.equal(calls, 0);
  for (const user of ['A', 'B']) {
    const response = await fetch(url + '?range=ALL&userId=other', { headers: { 'x-test-user': user } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const result = await response.json();
    assert.equal(result.points[0].marketValue, user === 'A' ? 100 : 200);
  }
});
