const test = require('node:test');
const assert = require('node:assert/strict');
const { createStockPriceService, instrument } = require('../src/modules/trades/stock-price.service');
const { createInvestmentService } = require('../src/modules/trades/investment.service');
const NOW = Date.parse('2026-10-25T14:00Z');
const item = { assetType: 'OFFSHORE_STOCK', symbol: 'QS', exchange: 'XNYS', currency: 'USD', quantity: 0, status: 'CLOSED' };
const url = 'https://static2.finnhub.io/file/publicdatany/finnhubimage/stock_logo/QS.png';
const ok = data => ({ ok: true, status: 200, json: async () => data });
function fixture(options = {}) {
  const calls = [];
  const service = createStockPriceService({ apiKey: 'secret-test-key', now: () => NOW, fetchQuote: async input => {
    const path = new URL(input).pathname; calls.push(path);
    if (path.endsWith('/stock/symbol')) return ok(options.listings || [{ symbol: 'QS', mic: 'XNAS', currency: 'USD', type: 'Common Stock' }]);
    if (path.endsWith('/stock/profile2')) return ok({ ticker: 'QS', currency: 'USD', exchange: 'NASDAQ NMS - GLOBAL MARKET', logo: url, ...options.profile });
    if (path.endsWith('/quote')) return ok({ c: 25, t: NOW / 1000 - 60 });
    assert.fail('Unexpected request ' + path);
  } });
  return { service, calls, logo: () => service.getLogos([item], { includeClosed: true }).then(result => result.get(instrument(item).key)) };
}

test('old-market QS logo resolves catalog + profile, preserves PDF identity, and does not relax quotes/news', async () => {
  const f = fixture();
  const copy = structuredClone(item);
  const logo = await f.logo();
  assert.equal(logo.status, 'AVAILABLE');
  assert.equal(logo.micCode, 'XNYS');
  assert.equal(logo.providerMicCode, 'XNAS');
  assert.equal(logo.listingResolution.type, 'CURRENT_LISTING_FOR_LOGO');
  assert.equal(logo.listingResolution.pdfMarketPreserved, true);
  assert.equal(logo.listingResolution.effectiveDate, null);
  assert.deepEqual(item, copy);
  const before = f.calls.length;
  assert.equal((await f.logo()).fromCache, true);
  const oldHeld = { ...item, quantity: 1 };
  assert.equal((await f.service.getQuotes([oldHeld])).get(instrument(oldHeld).key).status, 'UNAVAILABLE');
  assert.equal((await f.service.getNews(oldHeld)).status, 'UNAVAILABLE');
  assert.equal(f.calls.length, before);
  const current = { ...oldHeld, exchange: 'XNAS' };
  assert.equal((await f.service.getQuotes([current])).get(instrument(current).key).price, 25);
  assert.equal(f.calls.filter(path => path.endsWith('/quote')).length, 1);
});

test('logo fallback handles a unique Nasdaq MIC family and rejects multiple current families or security types', async () => {
  const variants = [
    { rows: [{ mic: 'XNGS', type: 'Common Stock' }, { mic: 'XNMS', type: 'Common Stock' }], available: true },
    { rows: [{ mic: 'XNAS', type: 'Common Stock' }, { mic: 'ARCX', type: 'Common Stock' }], available: false },
    { rows: [{ mic: 'XNAS', type: 'Common Stock' }, { mic: 'XNAS', type: 'ADR' }], available: false },
    { rows: [{ mic: 'XNAS', type: 'Unknown' }], available: false },
    { rows: [{ mic: 'XNAS' }], available: false },
    { rows: [{ mic: 'OTHER', type: 'Common Stock' }], available: false },
  ];
  for (const variant of variants) {
    const f = fixture({ listings: variant.rows.map(row => ({ symbol: 'QS', currency: 'USD', ...row })) });
    const logo = await f.logo();
    assert.equal(logo.status, variant.available ? 'AVAILABLE' : 'UNAVAILABLE');
    if (!variant.available) assert.equal(f.calls.filter(path => path.endsWith('/stock/profile2')).length, 0);
  }
});

test('fallback requires exact ticker, USD, matching profile exchange and safe image URL', async () => {
  for (const profile of [{ ticker: 'OTHER' }, { currency: 'EUR' }, { currency: undefined },
    { exchange: 'NEW YORK STOCK EXCHANGE, INC.' }, { exchange: 'NYSE ARCA' }, { exchange: 'Unknown' },
    { exchange: undefined }, { logo: 'https://evil.example/logo.png' }, { logo: url + '?token=secret-test-key' }]) {
    const f = fixture({ profile });
    const result = await f.logo();
    assert.equal(result.status, 'UNAVAILABLE');
    assert.equal(result.url, null);
    assert.equal(JSON.stringify(result).includes('secret-test-key'), false);
  }
});

test('unchanged-market/ADR issuer-logo handling remains compatible, but issuer aliases cannot bypass fallback', async () => {
  for (const oldMarket of ['XNYS', 'XNAS']) {
    const f = fixture({ listings: [{ symbol: 'ASML', currency: 'USD', mic: 'XNAS', type: 'ADR' }],
      profile: { ticker: 'ASML.AS', currency: 'EUR', logo: url } });
    const adr = { ...item, symbol: 'ASML', exchange: oldMarket };
    const logo = (await f.service.getLogos([adr], { includeClosed: true })).get(instrument(adr).key);
    assert.equal(logo.status, oldMarket === 'XNAS' ? 'AVAILABLE' : 'UNAVAILABLE');
    if (oldMarket === 'XNAS') assert.equal(logo.listingResolution, null);
  }
});

test('holdings join remains on original market for closed positions, reuses cache and does not alter costs', async () => {
  const f = fixture();
  const data = { items: [{ ...item, costBasis: [{ currency: 'USD', remainingCost: 0 }], rawQuantity: 0 }] };
  const original = structuredClone(data);
  const investments = createInvestmentService({ marketPrices: f.service,
    repository: { holdings: async (owner, includeClosed) => { assert.equal(owner, 'owner'); assert.equal(includeClosed, true); return data; } },
    exchangeRates: { getRate: () => assert.fail('No FX') },
    domesticPrices: { getQuotes: () => assert.fail('No domestic price') } });
  for (let i = 0; i < 2; i++) {
    const response = await investments.holdings('owner', { includeClosed: 'true', includeLogos: 'true' });
    assert.equal(response.items[0].exchange, 'XNYS');
    assert.equal(response.items[0].logoUrl, url);
    assert.equal(response.items[0].logo.providerMicCode, 'XNAS');
    assert.deepEqual(response.items[0].costBasis, data.items[0].costBasis);
  }
  assert.deepEqual(data, original);
  assert.deepEqual(f.calls, ['/api/v1/stock/symbol', '/api/v1/stock/profile2']);
});
