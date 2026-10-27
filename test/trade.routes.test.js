const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');
const { createTradeRouter } = require('../src/modules/trades/trade.routes');
const { createPreviewPdf } = require('../src/modules/trades/trade.controller');
const { errorHandler } = require('../src/middlewares/error.middleware');
async function serverFor(t, options) {
  const app = express();
  app.use(express.json());
  app.use('/trades', createTradeRouter(options));
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  return `http://127.0.0.1:${server.address().port}/trades`;
}
test('document/history/import/transaction endpoints require authentication', async t => {
  const base = await serverFor(t);
  for (const [method, path] of [['GET', '/documents'], ['GET', '/documents/00000000-0000-4000-8000-000000000001'], ['GET', '/transactions'], ['GET', '/holdings'], ['GET', '/exchange-rate'], ['POST', '/import']]) {
    const response = await fetch(base + path, { method });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, 'UNAUTHORIZED');
  }
});

test('exchange-rate HTTP returns rate/date without accepting a caller-selected currency or URL', async t => {
  const rate = { status: 'AVAILABLE', baseCurrency: 'USD', quoteCurrency: 'THB', rate: 33.498, rateDate: '2026-10-19' };
  const base = await serverFor(t, { authenticate: (req, _res, next) => { req.user = { id: 'owner' }; next(); },
    exchangeRates: { getRate: async (...args) => { assert.equal(args.length, 0); return rate; } } });
  const response = await fetch(base + '/exchange-rate?base=EUR&url=http://private');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), rate);
});

test('holdings HTTP with includeFx converts through the real service with an injected public rate', async t => {
  const { createInvestmentService } = require('../src/modules/trades/investment.service');
  const original = { items: [{ assetType: 'OFFSHORE_STOCK', currency: 'USD', amounts: [{ currency: 'USD', totalBuyGross: 30 }] }] };
  const investments = createInvestmentService({ repository: { holdings: async () => original },
    exchangeRates: { getRate: async () => ({ status: 'AVAILABLE', rate: 33.498, rateDate: '2026-10-19' }) } });
  const base = await serverFor(t, { investments, authenticate: (req, _res, next) => { req.user = { id: 'owner' }; next(); } });
  const response = await fetch(base + '/holdings?includeFx=true');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.fx.rateDate, '2026-10-19');
  assert.equal(body.items[0].displayThb.amounts.totalBuyGross, 1004.94);
  assert.deepEqual(body.items[0].amounts, original.items[0].amounts);
});

test('rate HTTP outage returns 503 while holdings still returns original financial data with 200', async t => {
  const { createInvestmentService } = require('../src/modules/trades/investment.service');
  const { AppError } = require('../src/shared/errors/app-error');
  const exchangeRates = { getRate: async () => { throw new AppError(503, 'FX_RATE_UNAVAILABLE', 'USD/THB reference rate is temporarily unavailable'); } };
  const data = { items: [{ assetType: 'OFFSHORE_STOCK', currency: 'USD', amounts: [{ currency: 'USD', totalBuyGross: 30 }] }] };
  const investments = createInvestmentService({ repository: { holdings: async () => data }, exchangeRates });
  const base = await serverFor(t, { investments, exchangeRates, authenticate: (req, _res, next) => { req.user = { id: 'owner' }; next(); } });
  const failed = await fetch(base + '/exchange-rate');
  assert.equal(failed.status, 503);
  assert.equal((await failed.json()).error.code, 'FX_RATE_UNAVAILABLE');
  const response = await fetch(base + '/holdings?includeFx=true');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.fx.status, 'UNAVAILABLE');
  assert.equal(body.displayThb, null);
  assert.deepEqual(body.items[0].amounts, data.items[0].amounts);
});

test('market holdings HTTP shares only quotes across owners, not private quantities or costs', async t => {
  const { createInvestmentService } = require('../src/modules/trades/investment.service');
  const { createStockPriceService } = require('../src/modules/trades/stock-price.service');
  const time = Date.parse('2026-10-20T15:00:00Z');
  let upstreamCalls = 0;
  const marketPrices = createStockPriceService({ apiKey: 'server-only-key', now: () => time, fetchQuote: async input => {
    upstreamCalls++;
    return { ok: true, status: 200, json: async () => new URL(input).pathname.endsWith('/stock/symbol')
      ? [{ symbol: 'AMD', currency: 'USD', mic: 'XNGS' }] : { c: 150, t: time / 1000 - 60 } };
  } });
  const investments = createInvestmentService({ marketPrices, repository: { holdings: async user => ({ items: [{
    assetType: 'OFFSHORE_STOCK', currency: 'USD', symbol: 'AMD', exchange: 'XNAS', quantity: user === 'A' ? 2 : 5,
    costBasis: [{ currency: 'USD', status: 'CALCULATED', remainingCost: user === 'A' ? 200 : 600 }],
  }] }) } });
  const base = await serverFor(t, { investments, authenticate: (req, _res, next) => { req.user = { id: req.headers['x-test-owner'] }; next(); } });
  const responses = await Promise.all(['A', 'B'].map(owner => fetch(base + '/holdings?includeMarket=true&symbol=ARBITRARY&userId=other', { headers: { 'x-test-owner': owner } })));
  assert.ok(responses.every(response => response.status === 200));
  assert.ok(responses.every(response => response.headers.get('cache-control') === 'no-store'));
  const [a, b] = await Promise.all(responses.map(response => response.json()));
  assert.equal(upstreamCalls, 2);
  assert.equal(a.items[0].marketValuation.usd.marketValue, 300);
  assert.equal(a.items[0].marketValuation.quote.cachePolicy, 'MARKET_OPEN_TTL');
  assert.equal(a.items[0].marketValuation.quote.marketSchedule.state, 'OPEN');
  assert.equal(a.items[0].marketValuation.quote.marketSchedule.sessionCloseAt, '2026-10-20T20:00:00.000Z');
  assert.equal(a.items[0].marketValuation.usd.unrealizedPnl, 100);
  assert.equal(b.items[0].marketValuation.usd.marketValue, 750);
  assert.equal(b.items[0].marketValuation.usd.unrealizedPnl, 150);
  assert.equal(JSON.stringify(a).includes('server-only-key'), false);
  assert.equal(Object.hasOwn(a, 'fx'), false);
});

test('market HTTP setup failure is advisory and invalid includeMarket is a 400', async t => {
  const { createInvestmentService } = require('../src/modules/trades/investment.service');
  const { createStockPriceService } = require('../src/modules/trades/stock-price.service');
  const investments = createInvestmentService({ repository: { holdings: async () => ({ items: [{
    assetType: 'OFFSHORE_STOCK', currency: 'USD', symbol: 'AMD', exchange: 'XNAS', quantity: 2,
  }] }) }, marketPrices: createStockPriceService({ apiKey: '' }) });
  const base = await serverFor(t, { investments, authenticate: (req, _res, next) => { req.user = { id: 'owner' }; next(); } });
  const response = await fetch(base + '/holdings?includeMarket=true');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.items[0].marketValuation.quote.errorCode, 'MARKET_DATA_CONFIG_MISSING');
  assert.equal(body.items[0].marketValuation.usd.marketValue, null);
  const invalid = await fetch(base + '/holdings?includeMarket=yes');
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'INVALID_HOLDINGS_FILTER');
});

test('logo opt-in HTTP returns safe public URL separately from valuation, without exposing the provider key', async t => {
  const { createInvestmentService } = require('../src/modules/trades/investment.service');
  const { createStockPriceService } = require('../src/modules/trades/stock-price.service');
  let calls = 0;
  const marketPrices = createStockPriceService({ apiKey: 'private-key', fetchQuote: async input => {
    assert.ok(['/api/v1/stock/symbol', '/api/v1/stock/profile2'].includes(new URL(input).pathname));
    calls++;
    return { ok: true, status: 200, json: async () => new URL(input).pathname.endsWith('/stock/symbol')
      ? [{ symbol: 'AMD', currency: 'USD', mic: 'XNGS' }] : { ticker: 'AMD', logo: 'https://static2.finnhub.io/file/publicdatany/finnhubimage/stock_logo/AMD.png' } };
  } });
  const investments = createInvestmentService({ marketPrices, repository: { holdings: async user => {
    assert.equal(user, 'owner');
    return { items: [{ assetType: 'OFFSHORE_STOCK', currency: 'USD', symbol: 'AMD', exchange: 'XNAS', quantity: 2 }] };
  } } });
  const base = await serverFor(t, { investments, authenticate: (req, _res, next) => { req.user = { id: 'owner' }; next(); } });
  for (let i = 0; i < 2; i++) {
    const response = await fetch(base + '/holdings?includeLogos=true&symbol=OTHER');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    assert.equal(body.items[0].logoUrl, 'https://static2.finnhub.io/file/publicdatany/finnhubimage/stock_logo/AMD.png');
    assert.equal(body.items[0].logo.status, 'AVAILABLE');
    assert.equal(Object.hasOwn(body.items[0], 'marketValuation'), false);
    assert.equal(JSON.stringify(body).includes('private-key'), false);
  }
  assert.equal(calls, 2);
  assert.equal((await fetch(base + '/holdings?includeLogos=1')).status, 400);
});
test('import and list always use authenticated user, never request userId', async t => {
  const calls = [];
  const investments = {
    importMany: async (user, body) => { calls.push({ user, ids: body.documentIds }); return { results: [], counts: {} }; },
    list: async (user, query, transactions) => { calls.push({ user, transactions }); return { items: [], hasMore: false }; },
    get: async (user, id) => { calls.push({ user, id }); return { record: { id, status: 'IMPORTED' } }; },
    holdings: async (user, query) => { calls.push({ user }); return { scope: 'STOCK_BUY_SELL_ONLY', items: [{ symbol: 'ABC', quantity: 0.3 }] }; },
  };
  const base = await serverFor(t, { investments, authenticate: (req, _res, next) => { req.user = { id: 'trusted-user' }; next(); } });
  const response = await fetch(base + '/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: 'someone-else', documentIds: ['id'] }) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  await fetch(base + '/documents?userId=someone-else');
  await fetch(base + '/transactions?userId=someone-else');
  await fetch(base + '/documents/id');
  const holdings = await fetch(base + '/holdings?userId=someone-else');
  assert.equal(holdings.status, 200);
  assert.equal(holdings.headers.get('cache-control'), 'no-store');
  assert.equal((await holdings.json()).items[0].quantity, 0.3);
  assert.ok(calls.every(call => call.user === 'trusted-user'));
});
test('holdings HTTP response exposes monetary currencies and null values unchanged', async t => {
  const data = { items: [{ symbol: 'AMD', amounts: [{ currency: 'USD', totalBuy: 10, totalSell: 12 }, { currency: 'THB', totalBuy: null, isComplete: false }] }],
    moneyTotals: [{ currency: 'THB', totalBuy: null }], moneySource: 'IMPORTED_ORDER_TOTALS' };
  const base = await serverFor(t, { authenticate: (req, _res, next) => { req.user = { id: 'owner' }; next(); },
    investments: { holdings: async (user, query) => {
      assert.equal(user, 'owner');
      assert.equal(query.includeClosed, 'true');
      return data;
    } } });
  const response = await fetch(base + '/holdings?includeClosed=true&userId=other');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), data);
});

test('holdings HTTP includes gross, fees, stock-only totals and discount metadata', async t => {
  const amounts = [{ currency: 'USD', totalBuy: 30, totalBuyGross: 29.95, totalBuyFeeIncludeVat: 0.05, totalFeeIncludeVat: 0.05 },
    { currency: 'THB', totalBuy: 1050, totalBuyGross: 1048.25, totalBuyFeeIncludeVat: 1.75, totalFeeIncludeVat: 1.75 }];
  const data = { items: [{ symbol: 'AMD', amounts }], moneyTotals: amounts, stockMoneyTotals: amounts, documentDiscountsApplied: false };
  const base = await serverFor(t, { authenticate: (req, _res, next) => { req.user = { id: 'owner' }; next(); },
    investments: { holdings: async user => { assert.equal(user, 'owner'); return data; } } });
  const response = await fetch(base + '/holdings');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), data);
});

test('holdings HTTP exposes cost basis without converting unknown amounts to zero', async t => {
  const data = { costBasisMethod: 'MOVING_WEIGHTED_AVERAGE', items: [{ symbol: 'AMD', costBasis: [
    { currency: 'USD', averageCostPerUnit: 12, remainingCost: 180, status: 'CALCULATED' },
    { currency: 'THB', averageCostPerUnit: null, remainingCost: null, status: 'INCOMPLETE', issues: ['BUY_GROSS_REQUIRED'] },
  ] }], remainingCostTotals: [{ currency: 'THB', remainingCost: null, isComplete: false }] };
  const base = await serverFor(t, { authenticate: (req, _res, next) => { req.user = { id: 'owner' }; next(); },
    investments: { holdings: async user => { assert.equal(user, 'owner'); return data; } } });
  const response = await fetch(base + '/holdings');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), data);
});

test('holdings HTTP returns distinct offshore compressed FIFO, Thai FIFO and fund Average Cost', async t => {
  const data = { costBasisMethod: 'BY_ASSET_TYPE', costBasisGroupingDate: 'TRADE_DATE_AS_PARSED', items: [
    { assetType: 'OFFSHORE_STOCK', costBasisMethod: 'COMPRESSED_FIFO', costBasis: [{ currency: 'USD', method: 'COMPRESSED_FIFO', remainingCost: 700 }] },
    { assetType: 'THAI_STOCK', costBasisMethod: 'FIFO', costBasis: [{ currency: 'THB', method: 'FIFO', remainingCost: 450 }] },
    { assetType: 'MUTUAL_FUND', costBasisMethod: 'MOVING_WEIGHTED_AVERAGE', costBasis: [{ currency: 'THB', method: 'MOVING_WEIGHTED_AVERAGE', remainingCost: null, status: 'INCOMPLETE' }] },
  ] };
  const base = await serverFor(t, { authenticate: (req, _res, next) => { req.user = { id: 'owner' }; next(); },
    investments: { holdings: async user => { assert.equal(user, 'owner'); return data; } } });
  const response = await fetch(base + '/holdings');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), data);
});

test('holdings HTTP sends calculated fund average cost in THB with source metadata', async t => {
  const data = { items: [{ assetType: 'MUTUAL_FUND', quantity: 15, costBasisSource: 'PDF_ORDER_TOTAL_AMOUNT_EXCLUDING_FEES',
    costBasis: [{ currency: 'THB', method: 'MOVING_WEIGHTED_AVERAGE', averageCostPerUnit: 12, remainingCost: 180,
      source: 'PDF_ORDER_TOTAL_AMOUNT_EXCLUDING_FEES', feesIncluded: false, status: 'CALCULATED' }] }] };
  const base = await serverFor(t, { authenticate: (req, _res, next) => { req.user = { id: 'owner' }; next(); },
    investments: { holdings: async user => { assert.equal(user, 'owner'); return data; } } });
  const response = await fetch(base + '/holdings');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), data);
});

test('upload preview reuses cached document without parsing or accepting client preview', async () => {
  let parsed = false;
  const stored = { preview: { file: { name: 'original.pdf' }, summary: { totalBuy: 1 } }, record: { id: 'stored-id', status: 'IMPORTED', alreadyRead: true } };
  const handler = createPreviewPdf({ investments: { cached: async (user, buffer) => { assert.equal(user, 'trusted-user'); assert.equal(buffer.toString(), '%PDF-'); return stored; } }, extract: async () => { parsed = true; throw new Error(); } });
  const response = { set() { return this; }, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
  await handler({ user: { id: 'trusted-user' }, file: { buffer: Buffer.from('%PDF-') }, body: { preview: { fake: true } } }, response);
  assert.equal(parsed, false);
  assert.equal(response.body.record.status, 'IMPORTED');
  assert.equal(response.body.summary.totalBuy, 1);
});
test('fresh upload saves only server-parsed preview and returns document record', async () => {
  const investments = { cached: async () => null, stage: async (user, buffer, preview) => {
    assert.equal(user, 'trusted-user');
    assert.equal(preview.summary.totalBuy, 100);
    assert.equal(preview.pdfPassword, undefined);
    return { preview, record: { id: 'stored-id', status: 'PREVIEW' } };
  } };
  const handler = createPreviewPdf({ investments, extract: async (_buffer, password) => { assert.equal(password, 'secret'); return { text: 'server text', pageCount: 1 }; }, parse: () => ({ summary: { totalBuy: 100 } }) });
  const response = { set() { return this; }, status() { return this; }, json(body) { this.body = body; } };
  await handler({ user: { id: 'trusted-user' }, file: { buffer: Buffer.from('%PDF-'), originalname: 'a.pdf', size: 5, mimetype: 'application/pdf' }, body: { pdfPassword: 'secret', summary: { totalBuy: 999 } } }, response);
  assert.equal(response.body.record.status, 'PREVIEW');
  assert.equal(response.body.file.name, 'a.pdf');
});
