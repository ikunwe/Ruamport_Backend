const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');
const { createInvestmentService } = require('../src/modules/trades/investment.service');
const { createTradeRouter } = require('../src/modules/trades/trade.routes');
const { instrument } = require('../src/modules/trades/stock-price.service');
const { domesticInstrument } = require('../src/modules/trades/domestic-market.service');
const { AppError } = require('../src/shared/errors/app-error');

for (const outage of [false, true]) test(`HTTP latest changes preserve ownership, opt-in and FX outage=${outage}`, async t => {
  let fxCalls = 0;
  let priceCalls = 0;
  const items = [{ assetType: 'OFFSHORE_STOCK', symbol: 'AMD', exchange: 'XNAS', currency: 'USD', quantity: 2 },
    { assetType: 'THAI_STOCK', symbol: 'ASK', currency: 'THB', quantity: 10 },
    { assetType: 'MUTUAL_FUND', symbol: 'KKP US500-UH-E', currency: 'THB', quantity: 20 }];
  const quote = (price, previous, currency) => ({ status: 'AVAILABLE', price, previousClose: previous,
    previousNav: previous, currency, priceAt: '2026-10-21T08:00:00Z', navDate: '2026-10-21',
    previousNavDate: '2026-10-20', previousCloseDate: '2026-10-20' });
  const investments = createInvestmentService({
    repository: { holdings: async owner => { assert.equal(owner, 'actual-user'); return { items }; } },
    exchangeRates: { getRate: async () => { fxCalls++; if (outage) throw new AppError(503, 'FX_RATE_UNAVAILABLE', 'Unavailable');
      return { status: 'AVAILABLE', rate: 34, rateDate: '2026-10-21' }; } },
    marketPrices: { getQuotes: async () => { priceCalls++; return new Map([[instrument(items[0]).key, quote(110, 100, 'USD')]]); } },
    domesticPrices: { getQuotes: async () => { priceCalls++; return new Map([
      [domesticInstrument(items[1]).key, quote(9, 10, 'THB')], [domesticInstrument(items[2]).key, quote(11, 10, 'THB')],
    ]); } },
  });
  const app = express();
  app.use('/trades', createTradeRouter({ investments, authenticate: (req, res, next) => { req.user = { id: 'actual-user' }; next(); } }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/trades/holdings`;
  const plain = await (await fetch(url)).json();
  assert.equal(plain.latestChange, undefined);
  assert.equal(priceCalls, 0);
  assert.equal(fxCalls, 0);
  const response = await fetch(url + '?includeMarket=true&includeFx=true&userId=foreign');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.equal(body.latestChange.portfolio.change, outage ? null : 690);
  assert.equal(body.items[0].latestChange.native.change, 20);
  assert.equal(body.latestChange.byAssetType[1].change, -10);
  assert.equal(body.latestChange.byAssetType[2].change, 20);
  assert.equal(priceCalls, 2);
  assert.equal(fxCalls, 1);
});
