const test = require('node:test');
const assert = require('node:assert/strict');
const { createStockPriceService, instrument, regularUsHours } = require('../src/modules/trades/stock-price.service');
const START = Date.parse('2026-10-20T15:00:00Z');
const held = (symbol = 'AMD', exchange = 'XNAS', extra = {}) => ({ assetType: 'OFFSHORE_STOCK', currency: 'USD', quantity: 2, symbol, exchange, ...extra });
const key = item => instrument(item).key;
const ok = row => ({ ok: true, status: 200, json: async () => row });
const listing = (symbol = 'AMD', mic = 'XNGS', currency = 'USD') => ({ symbol, mic, currency });
const image = 'https://static2.finnhub.io/file/publicdatany/finnhubimage/stock_logo/AMD.png';
function fixture(options = {}) {
  let time = START;
  const calls = [];
  const service = createStockPriceService({ apiKey: 'private-key', now: () => time, ...options,
    fetchQuote: async (input, init) => {
      const url = new URL(input);
      calls.push(url.pathname);
      assert.equal(url.origin, 'https://finnhub.io');
      assert.equal(url.searchParams.has('token'), false);
      assert.equal(init.headers['X-Finnhub-Token'], 'private-key');
      assert.equal(init.redirect, url.pathname.endsWith('/stock/symbol') ? 'manual' : 'error');
      assert.ok(init.signal);
      if (options.fetchQuote) return options.fetchQuote(url, init);
      if (url.pathname.endsWith('/stock/symbol')) return ok(['AMD', 'TSM', 'NVDA', 'TSLA'].map(s => listing(s, s === 'TSM' ? 'XNYS' : 'XNGS')));
      if (url.pathname.endsWith('/stock/profile2')) return ok({ ticker: url.searchParams.get('symbol'), currency: 'USD', logo: image });
      if (url.pathname.endsWith('/company-news')) return ok([{ id: 1, headline: 'AMD update', source: 'Publisher',
        datetime: time / 1000 - 60, related: 'AMD', summary: 'A summary', image, url: 'https://publisher.example/news/1' }]);
      return ok({ c: 150, t: time / 1000 - 60 });
    } });
  return { service, calls, time: value => { time = value; } };
}
const quote = async (service, item = held()) => (await service.getQuotes([item])).get(key(item));

test('Finnhub logo comes from profile2 and uses separate seven-day cache', async () => {
  const { service, calls } = fixture();
  const first = (await service.getLogos([held()])).get(key(held()));
  assert.equal(first.source, 'FINNHUB');
  assert.equal(first.url, image);
  assert.equal(first.expiresAt, new Date(START + 7 * 86400000).toISOString());
  first.url = 'changed';
  const second = (await service.getLogos([held()])).get(key(held()));
  assert.equal(second.url, image);
  assert.equal(second.fromCache, true);
  assert.deepEqual(calls, ['/api/v1/stock/symbol', '/api/v1/stock/profile2']);
});
test('concurrent logo callers share profile and catalog refresh', async () => {
  const { service, calls } = fixture();
  await Promise.all([service.getLogos([held()]), service.getLogos([held()])]);
  assert.equal(calls.length, 2);
});
test('missing logo is negative cached for one day without suppressing price', async () => {
  const { service, calls, time } = fixture({ fetchQuote: async url => {
    if (url.pathname.endsWith('/stock/symbol')) return ok([listing()]);
    if (url.pathname.endsWith('/stock/profile2')) return ok({ ticker: 'AMD', logo: '' });
    return ok({ c: 150, t: START / 1000 });
  } });
  for (let i = 0; i < 2; i++) assert.equal((await service.getLogos([held()])).get(key(held())).errorCode, 'LOGO_NOT_FOUND');
  assert.equal(calls.length, 2);
  assert.equal((await quote(service)).status, 'AVAILABLE');
  time(START + 86400001);
  await service.getLogos([held()]);
  assert.equal(calls.filter(p => p.endsWith('/stock/profile2')).length, 2);
});
test('untrusted logo identity and URLs never reach Frontend', async () => {
  for (const row of [{}, { ticker: 'OTHER', logo: image }, ...[
    'javascript:alert(1)', 'http://static2.finnhub.io/file/logo.png',
    'https://evil.example/file/logo.png', 'https://static2.finnhub.io.evil.example/file/a.png',
    'https://user:pass@static2.finnhub.io/file/a.png', 'https://static2.finnhub.io:8443/file/a.png',
    image + '?token=private-key', image + '#secret', 'https://static2.finnhub.io/private-key.png',
  ].map(logo => ({ ticker: 'AMD', logo }))]) {
    const { service } = fixture({ fetchQuote: async url => url.pathname.endsWith('/stock/symbol') ? ok([listing()]) : ok(row) });
    const result = (await service.getLogos([held()])).get(key(held()));
    assert.equal(result.status, 'UNAVAILABLE');
    assert.equal(JSON.stringify(result).includes('private-key'), false);
  }
});
test('logo failure preserves old URL but not beyond thirty days', async () => {
  let fail = false;
  const { service, time } = fixture({ logoTtlMs: 1000, fetchQuote: async url => {
    if (url.pathname.endsWith('/stock/symbol')) return ok([listing()]);
    if (fail) throw new Error('private-key');
    return ok({ ticker: 'AMD', logo: image });
  } });
  const first = (await service.getLogos([held()])).get(key(held()));
  fail = true;
  time(START + 1001);
  const stale = (await service.getLogos([held()])).get(key(held()));
  assert.equal(stale.url, image);
  assert.equal(stale.isStale, true);
  assert.equal(stale.fetchedAt, first.fetchedAt);
  time(START + 30 * 86400000 + 1);
  assert.equal((await service.getLogos([held()])).get(key(held())).status, 'UNAVAILABLE');
});
test('holdings defaults never fetch; quote opt-in runs before logo and leaves costs unchanged', async () => {
  const { createInvestmentService } = require('../src/modules/trades/investment.service');
  const { service, calls } = fixture({ perMinute: 2 });
  const data = { items: [held('AMD', 'XNAS', { costBasis: [{ currency: 'USD', status: 'CALCULATED', remainingCost: 200 }] }),
    held('TSM', 'XNYS', { quantity: 0 }), held('FUND', 'XNAS', { assetType: 'MUTUAL_FUND' })] };
  const investments = createInvestmentService({ repository: { holdings: async () => data }, marketPrices: service });
  assert.deepEqual(await investments.holdings('owner'), data);
  assert.equal(calls.length, 0);
  const result = await investments.holdings('owner', { includeMarket: 'true', includeLogos: 'true' });
  assert.equal(result.items[0].marketValuation.usd.marketValue, 300);
  assert.equal(result.items[0].logo.errorCode, 'LOGO_RATE_LIMITED');
  assert.equal(result.items[1].logo, null);
  assert.equal(result.items[2].logo, null);
  assert.deepEqual(result.items[0].costBasis, data.items[0].costBasis);
});
test('logos-only does not fetch quote or FX and invalid filter is rejected before DB', async () => {
  const { createInvestmentService } = require('../src/modules/trades/investment.service');
  const { service, calls } = fixture();
  let dbCalls = 0;
  const investments = createInvestmentService({ repository: { holdings: async () => { dbCalls++; return { items: [held()] }; } },
    exchangeRates: { getRate: async () => { throw new Error('Unexpected FX'); } }, marketPrices: service });
  await assert.rejects(() => investments.holdings('owner', { includeLogos: '1' }), { code: 'INVALID_HOLDINGS_FILTER' });
  assert.equal(dbCalls, 0);
  const result = await investments.holdings('owner', { includeLogos: 'true' });
  assert.equal(result.items[0].logoUrl, image);
  assert.equal(calls.includes('/api/v1/quote'), false);
});
