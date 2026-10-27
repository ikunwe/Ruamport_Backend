const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');
const { createStockPriceService, instrument } = require('../src/modules/trades/stock-price.service');
const { createInvestmentService } = require('../src/modules/trades/investment.service');
const { createTradeRouter } = require('../src/modules/trades/trade.routes');
const { thaiStockLogo } = require('../src/modules/trades/thai-stock-logo');
const START = Date.parse('2026-10-25T09:00Z');
const closed = (symbol = 'AMD', extra = {}) => ({ assetType: 'OFFSHORE_STOCK', symbol,
  exchange: 'XNAS', currency: 'USD', quantity: 0, status: 'CLOSED', ...extra });
const logoUrl = 'https://static2.finnhub.io/file/publicdatany/finnhubimage/stock_logo/AMD.png';
const ok = data => ({ ok: true, status: 200, json: async () => data });
function fixture(options = {}) {
  const calls = [];
  const prices = createStockPriceService({ apiKey: 'test-secret', now: () => START,
    fetchQuote: async input => {
      const url = new URL(input); calls.push(url.pathname);
      if (url.pathname.endsWith('/stock/symbol')) return ok([{ symbol: 'AMD', mic: 'XNGS', currency: 'USD' }]);
      assert.ok(url.pathname.endsWith('/stock/profile2'), 'Only catalog/profile requests are allowed');
      return options.failLogo ? ok({ ticker: 'AMD', logo: '' }) : ok({ ticker: 'AMD', currency: 'USD', logo: logoUrl });
    } });
  return { prices, calls };
}

test('closed offshore logo opt-in shares the existing logo cache with held positions, without quotes/news', async () => {
  const f = fixture();
  const item = closed();
  assert.equal((await f.prices.getLogos([item])).size, 0);
  assert.equal(f.calls.length, 0);
  const logos = await f.prices.getLogos([item, { ...item, accountNumber: 'SECOND' }], { includeClosed: true });
  assert.equal(logos.get(instrument(item).key).url, logoUrl);
  assert.deepEqual(f.calls, ['/api/v1/stock/symbol', '/api/v1/stock/profile2']);
  const held = await f.prices.getLogos([{ ...item, quantity: 2 }]);
  assert.equal(held.get(instrument(item).key).fromCache, true);
  assert.equal((await f.prices.getQuotes([item])).size, 0);
  assert.throws(() => f.prices.getNews(item), /held/);
  assert.equal(f.calls.length, 2);
});

test('closed stock lookup retains validation and rejects negative/nonfinite/missing quantities', async () => {
  const f = fixture();
  const items = [closed('AMD', { quantity: -1 }), closed('AMD', { quantity: NaN }),
    closed('AMD', { quantity: undefined }), closed('AMD', { currency: 'THB' }), closed('AMD', { exchange: 'INVALID' })];
  assert.equal((await f.prices.getLogos(items, { includeClosed: true })).size, 0);
  assert.equal(f.calls.length, 0);
});

test('Thai closed logos remain unverified fixed SET URLs, with default closed exclusion unchanged', () => {
  const item = closed('ASK', { assetType: 'THAI_STOCK', exchange: 'SET', currency: 'THB' });
  assert.equal(thaiStockLogo(item), null);
  const logo = thaiStockLogo(item, { includeClosed: true });
  assert.equal(logo.url, 'https://media.set.or.th/common/logo/company/ASK.png');
  assert.equal(logo.status, 'UNVERIFIED');
  for (const change of [{ quantity: -1 }, { quantity: null }, { symbol: '../PTT' }, { exchange: 'XNAS' }])
    assert.equal(thaiStockLogo({ ...item, ...change }, { includeClosed: true }), null);
});

test('includeClosed+includeLogos attaches offshore/Thai stock images only and leaves data and fund behavior unchanged', async () => {
  const f = fixture();
  const items = [closed(), closed('ASK', { assetType: 'THAI_STOCK', exchange: null, currency: 'THB' }),
    closed('FUND', { assetType: 'MUTUAL_FUND', exchange: null, currency: 'THB' })];
  const before = structuredClone(items);
  const investments = createInvestmentService({ marketPrices: f.prices,
    exchangeRates: { getRate: () => { throw new Error('No FX'); } },
    domesticPrices: { getQuotes: () => { throw new Error('No price/NAV'); }, getFundIdentity: () => { throw new Error('No closed fund lookup'); } },
    repository: { holdings: async (owner, includeClosed) => {
      assert.equal(owner, 'owner'); assert.equal(includeClosed, true); return { items, costBasisMethod: 'UNCHANGED' };
    } } });
  const plain = await investments.holdings('owner', { includeClosed: 'true' });
  assert.deepEqual(plain.items, before); assert.equal(f.calls.length, 0);
  const result = await investments.holdings('owner', { includeClosed: 'true', includeLogos: 'true' });
  assert.equal(result.items[0].logoUrl, logoUrl);
  assert.equal(result.items[1].logo.source, 'SET');
  assert.equal(result.items[2].logo, null);
  assert.equal(result.costBasisMethod, 'UNCHANGED');
  assert.ok(result.items.every(item => !item.quote && !item.marketValuation));
  assert.deepEqual(items, before);
  assert.equal(f.calls.length, 2);
});

test('unavailable closed logo is advisory and does not remove historical holdings or retry continuously', async () => {
  const f = fixture({ failLogo: true });
  const investments = createInvestmentService({ marketPrices: f.prices,
    repository: { holdings: async () => ({ items: [closed()] }) } });
  for (let i = 0; i < 2; i++) {
    const data = await investments.holdings('owner', { includeClosed: 'true', includeLogos: 'true' });
    assert.equal(data.items[0].logoUrl, null);
    assert.equal(data.items[0].logo.errorCode, 'LOGO_NOT_FOUND');
    assert.equal(data.items[0].status, 'CLOSED');
  }
  assert.equal(f.calls.length, 2);
});

test('HTTP closed logos use authenticated holdings only, reuse public profiles across users and require both flags', async t => {
  const f = fixture();
  const dbCalls = [];
  const investments = createInvestmentService({ marketPrices: f.prices, repository: {
    holdings: async (owner, includeClosed) => {
      dbCalls.push({ owner, includeClosed });
      return { items: includeClosed ? [closed('AMD', { accountNumber: owner })] : [] };
    } } });
  const app = express();
  app.use('/trades', createTradeRouter({ investments, authenticate: (req, res, next) => {
    const owner = req.headers['x-owner'];
    if (!owner) return res.sendStatus(401);
    req.user = { id: owner }; next();
  } }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/trades/holdings`;
  assert.equal((await fetch(url + '?includeClosed=true&includeLogos=true')).status, 401);
  assert.equal(dbCalls.length, 0);
  await fetch(url + '?includeClosed=true', { headers: { 'x-owner': 'A' } });
  await fetch(url + '?includeLogos=true', { headers: { 'x-owner': 'A' } });
  assert.equal(f.calls.length, 0);
  for (const owner of ['A', 'B']) {
    const response = await fetch(url + '?includeClosed=true&includeLogos=true&symbol=OTHER&userId=OTHER', { headers: { 'x-owner': owner } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const data = await response.json();
    assert.equal(data.items[0].accountNumber, owner);
    assert.equal(data.items[0].symbol, 'AMD');
    assert.equal(data.items[0].logoUrl, logoUrl);
  }
  assert.equal(f.calls.length, 2);
  assert.ok(dbCalls.every(call => ['A', 'B'].includes(call.owner)));
});
