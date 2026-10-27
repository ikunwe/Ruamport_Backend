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

test('daily price fields come from the same quote and retain sign, zero and cache snapshot', async () => {
  for (const [d, dp] of [[5, 3.4483], [-5, -3.2258], [0, 0]]) {
    const { service, calls } = fixture({ fetchQuote: async url => url.pathname.endsWith('/stock/symbol')
      ? ok([listing()]) : ok({ c: 150, pc: 150 - d, d, dp, t: START / 1000 }) });
    const first = await quote(service);
    assert.equal(first.previousClose, 150 - d);
    assert.equal(first.change, d);
    assert.equal(first.changePercent, dp);
    first.change = 999;
    const second = await quote(service);
    assert.equal(second.change, d);
    assert.equal(second.fromCache, true);
    assert.equal(calls.length, 2);
  }
});

test('missing or invalid daily values become null without discarding a usable current price', async () => {
  for (const extra of [{}, { pc: null, d: null, dp: null }, { pc: '145', d: '5', dp: '3' },
    { pc: 0, d: NaN, dp: Infinity }, { pc: -1, d: false, dp: {} }]) {
    const { service } = fixture({ fetchQuote: async url => url.pathname.endsWith('/stock/symbol')
      ? ok([listing()]) : ok({ c: 150, t: START / 1000, ...extra }) });
    const result = await quote(service);
    assert.equal(result.status, 'AVAILABLE');
    assert.equal(result.previousClose, null);
    assert.equal(result.change, null);
    assert.equal(result.changePercent, null);
  }
});

test('stale fallback keeps daily fields with the old quote timestamp', async () => {
  let fail = false;
  const f = fixture({ fetchQuote: async url => {
    if (url.pathname.endsWith('/stock/symbol')) return ok([listing()]);
    if (fail) throw new Error('upstream failure');
    return ok({ c: 150, pc: 155, d: -5, dp: -3.2258, t: START / 1000 });
  } });
  const first = await quote(f.service);
  fail = true;
  f.time(START + 16 * 60000);
  const old = await quote(f.service);
  assert.equal(old.isStale, true);
  assert.equal(old.change, -5);
  assert.equal(old.changePercent, -3.2258);
  assert.equal(old.priceAt, first.priceAt);
});

test('Finnhub quote validates listing currency/MIC and uses private header, not URL token', async () => {
  const { service, calls } = fixture();
  const result = await quote(service);
  assert.equal(result.source, 'FINNHUB');
  assert.equal(result.price, 150);
  assert.equal(result.micCode, 'XNAS');
  assert.equal(result.providerMicCode, 'XNGS');
  assert.equal(result.interval, null);
  assert.equal(result.session, 'PROVIDER_QUOTE');
  assert.equal(result.marketOpen, null);
  assert.equal(result.fromCache, false);
  assert.deepEqual(calls, ['/api/v1/stock/symbol', '/api/v1/quote']);
  assert.equal(JSON.stringify(result).includes('private-key'), false);
});
test('only persisted positive offshore USD positions are fetched, with deduplication', async () => {
  const { service, calls } = fixture();
  const map = await service.getQuotes([held(), held(), held('CLOSED', 'XNAS', { quantity: 0 }),
    held('NEG', 'XNAS', { quantity: -1 }), held('NAN', 'XNAS', { quantity: NaN }),
    held('THAI', 'XNAS', { assetType: 'THAI_STOCK' }), held('BAD', 'XNAS', { currency: 'THB' }), held('AMD', 'XXXX')]);
  assert.equal(map.size, 1);
  assert.equal(calls.length, 2);
});
test('catalog and quote are single-flight across owners; callers receive immutable copies', async () => {
  const { service, calls } = fixture();
  const results = await Promise.all([quote(service), quote(service), service.getLogos([held()])]);
  assert.equal(calls.filter(p => p.endsWith('/stock/symbol')).length, 1);
  assert.equal(calls.filter(p => p.endsWith('/quote')).length, 1);
  results[0].price = 1;
  assert.equal((await quote(service)).price, 150);
  assert.equal((await quote(service)).fromCache, true);
});
test('NYSE ADRs are validated by listing, not issuer country or filings currency', async () => {
  const { service } = fixture({ fetchQuote: async url => url.pathname.endsWith('/stock/symbol')
    ? ok([listing('TSM', 'XNYS')]) : ok({ c: 425, t: START / 1000 }) });
  assert.equal((await quote(service, held('TSM', 'XNYS'))).price, 425);
});
test('wrong currency, MIC or symbol never fetches an unverified quote', async () => {
  for (const row of [listing('AMD', 'XNYS'), listing('OTHER'), listing('AMD', 'XNGS', 'EUR'), listing('AMD', 'XETR')]) {
    const { service, calls } = fixture({ fetchQuote: async () => ok([row]) });
    assert.equal((await quote(service)).status, 'UNAVAILABLE');
    assert.equal(calls.length, 1);
  }
});
test('Nasdaq operating MIC permits its known listing segments; explicit MIC stays exact', async () => {
  for (const mic of ['XNAS', 'XNGS', 'XNMS', 'XNCM']) {
    const { service } = fixture({ fetchQuote: async url => url.pathname.endsWith('/stock/symbol')
      ? ok([listing('AMD', mic)]) : ok({ c: 150, t: START / 1000 }) });
    assert.equal((await quote(service)).status, 'AVAILABLE');
  }
  const { service } = fixture();
  assert.equal((await quote(service, held('AMD', 'XNCM'))).status, 'UNAVAILABLE');
});
test('missing key never calls upstream and remains advisory', async () => {
  const { service, calls } = fixture({ apiKey: '' });
  assert.equal((await quote(service)).errorCode, 'MARKET_DATA_CONFIG_MISSING');
  assert.equal((await service.getLogos([held()])).get(key(held())).errorCode, 'MARKET_DATA_CONFIG_MISSING');
  assert.equal((await service.getNews(held())).errorCode, 'MARKET_DATA_CONFIG_MISSING');
  assert.equal(calls.length, 0);
});
test('malformed, zero, stale and future quote values are rejected', async () => {
  for (const row of [null, {}, { c: '150', t: START / 1000 }, { c: 0, t: START / 1000 },
    { c: -1, t: START / 1000 }, { c: Infinity, t: START / 1000 }, { c: 150, t: 0 },
    { c: 150, t: START / 1000 + 120 }, { c: 150, t: START / 1000 - 7 * 86400 }]) {
    const { service } = fixture({ fetchQuote: async url => url.pathname.endsWith('/stock/symbol') ? ok([listing()]) : ok(row) });
    assert.equal((await quote(service)).errorCode, 'PRICE_NOT_AVAILABLE');
  }
});
test('open-market price TTL refreshes on demand', async () => {
  const { service, calls, time } = fixture({ ttlMs: 1000 });
  const first = await quote(service);
  time(START + 1001);
  assert.equal((await quote(service)).fromCache, false);
  assert.equal(calls.length, 3);
  assert.notEqual((await quote(service)).fetchedAt, first.fetchedAt);
});
test('failure serves bounded stale quote without changing original timestamps', async () => {
  let failed = false;
  const { service, time } = fixture({ ttlMs: 1000, fetchQuote: async url => {
    if (url.pathname.endsWith('/stock/symbol')) return ok([listing()]);
    if (failed) throw new Error('private-key');
    return ok({ c: 150, t: START / 1000 });
  } });
  const first = await quote(service);
  failed = true;
  time(START + 1001);
  const stale = await quote(service);
  assert.equal(stale.isStale, true);
  assert.equal(stale.fetchedAt, first.fetchedAt);
  assert.equal(stale.warning, 'PRICE_NOT_AVAILABLE');
  time(START + 3 * 86400000 + 1);
  assert.equal((await quote(service)).status, 'UNAVAILABLE');
});
test('all endpoints share rolling minute budget including catalog request', async () => {
  const { service, calls, time } = fixture({ perMinute: 2 });
  assert.equal((await quote(service)).status, 'AVAILABLE');
  assert.equal((await service.getLogos([held()])).get(key(held())).errorCode, 'LOGO_RATE_LIMITED');
  assert.equal((await service.getNews(held())).errorCode, 'NEWS_RATE_LIMITED');
  assert.equal(calls.length, 2);
  time(START + 60001);
  assert.equal((await service.getLogos([held()])).get(key(held())).status, 'AVAILABLE');
});
test('optional daily cap counts every call and resets at UTC midnight', async () => {
  const { service, time } = fixture({ perDay: 2 });
  assert.equal((await quote(service)).status, 'AVAILABLE');
  assert.equal((await service.getNews(held())).errorCode, 'NEWS_DAILY_LIMIT');
  time(Date.parse('2026-10-21T00:00:01Z'));
  assert.equal((await service.getNews(held())).status, 'AVAILABLE');
});
test('shared 30 calls/second ceiling applies even with high minute budget', async () => {
  const items = Array.from({ length: 35 }, (_, i) => held('S' + i));
  const { service, calls } = fixture({ perMinute: 100, fetchQuote: async url => url.pathname.endsWith('/stock/symbol')
    ? ok(items.map(item => listing(item.symbol))) : ok({ c: 1, t: START / 1000 }) });
  const quotes = await service.getQuotes(items);
  assert.equal(calls.length, 30);
  assert.equal([...quotes.values()].filter(row => row.status === 'AVAILABLE').length, 29);
});
test('401/403/429 globally pause quote/logo/news requests without leaking provider messages', async () => {
  for (const status of [401, 403, 429]) {
    const { service, calls } = fixture({ fetchQuote: async () => ({
      ok: false, status, headers: { get: () => '120' }, json: async () => ({ error: 'private-key' }),
    }) });
    const result = await quote(service);
    assert.equal(result.errorCode, status === 429 ? 'PRICE_RATE_LIMITED' : 'PRICE_ACCESS_DENIED');
    await service.getLogos([held('TSLA')]);
    await service.getNews(held('NVDA'));
    assert.equal(calls.length, 1);
    assert.equal(JSON.stringify(result).includes('private-key'), false);
    assert.ok(Date.parse(result.retryAt) >= START + 120000);
  }
});
test('network and malformed JSON failures use negative cache and safe messages', async () => {
  for (const fail of [async () => { throw new Error('private-key'); },
    async () => ({ ok: true, json: async () => { throw new Error('private-key'); } }),
    async () => ok({ error: 'private-key' }), async () => ok([])]) {
    const { service, calls } = fixture({ fetchQuote: fail });
    const first = await quote(service);
    assert.equal(first.errorCode, 'PRICE_NOT_AVAILABLE');
    assert.equal((await quote(service)).errorCode, 'PRICE_NOT_AVAILABLE');
    assert.equal(calls.length, 1);
    assert.equal(JSON.stringify(first).includes('private-key'), false);
  }
});
test('bounded cache evicts old entries and catalog expires after one day', async () => {
  const { service, calls, time } = fixture({ maxEntries: 1 });
  await quote(service);
  await quote(service, held('NVDA'));
  await quote(service);
  assert.equal(calls.filter(p => p.endsWith('/quote')).length, 3);
  time(START + 86400001);
  await quote(service);
  assert.equal(calls.filter(p => p.endsWith('/stock/symbol')).length, 2);
});
test('limits reject invalid settings and market clock remains DST-aware', () => {
  for (const settings of [{ perMinute: 0 }, { perDay: -1 }, { ttlMs: 4 * 86400000 }, { newsTtlMs: 2 * 86400000 }, { maxEntries: 0 }]) {
    assert.throws(() => createStockPriceService(settings));
  }
  assert.equal(regularUsHours(Date.parse('2026-10-20T15:00:00Z')), true);
  assert.equal(regularUsHours(Date.parse('2026-10-18T15:00:00Z')), false);
});

test('news uses fixed last seven UTC dates, caches across callers and returns safe normalized metadata', async () => {
  const { service, calls } = fixture({ fetchQuote: async url => {
    if (url.pathname.endsWith('/stock/symbol')) return ok([listing()]);
    assert.equal(url.pathname, '/api/v1/company-news');
    assert.equal(url.searchParams.get('from'), '2026-10-14');
    assert.equal(url.searchParams.get('to'), '2026-10-20');
    return ok([{ id: 3, headline: 'AMD news', datetime: START / 1000, related: 'AMD,NVDA', source: 'Publisher',
      url: 'https://publisher.example/a', image, summary: 'x'.repeat(1500) }]);
  } });
  const first = await service.getNews(held());
  assert.equal(first.source, 'FINNHUB');
  assert.equal(first.items[0].publishedAt, new Date(START).toISOString());
  assert.equal(first.items[0].summary.length, 1000);
  first.items[0].headline = 'changed';
  const second = await service.getNews(held());
  assert.equal(second.items[0].headline, 'AMD news');
  assert.equal(second.fromCache, true);
  assert.equal(calls.length, 2);
});
test('news filters unsafe URLs, duplicates, unrelated symbols and invalid/out-of-window timestamps', async () => {
  const row = { id: 1, headline: 'News', datetime: START / 1000, related: 'AMD', url: 'https://publisher.example/a' };
  const { service } = fixture({ fetchQuote: async url => url.pathname.endsWith('/stock/symbol') ? ok([listing()]) : ok([
    row, row, { ...row, id: 2, url: 'javascript:evil()' }, { ...row, id: 3, related: 'TSLA' },
    { ...row, id: 4, datetime: 0 }, { ...row, id: 5, datetime: START / 1000 + 1000 },
    { ...row, id: 6, url: 'https://127.0.0.1/private' }, { ...row, id: 7, url: 'https://publisher.example/a?token=secret' },
  ]) });
  assert.equal((await service.getNews(held())).items.length, 1);
});
test('empty news is a successful cached result; malformed payload is unavailable', async () => {
  for (const rows of [[], {}]) {
    const { service, calls } = fixture({ fetchQuote: async url => url.pathname.endsWith('/stock/symbol') ? ok([listing()]) : ok(rows) });
    const result = await service.getNews(held());
    assert.equal(result.status, Array.isArray(rows) ? 'AVAILABLE' : 'UNAVAILABLE');
    assert.deepEqual(result.items, []);
    await service.getNews(held());
    assert.equal(calls.length, 2);
  }
});
test('news stale fallback is bounded to one day and never crosses date-window keys', async () => {
  let fail = false;
  const { service, time } = fixture({ newsTtlMs: 1000, fetchQuote: async url => {
    if (url.pathname.endsWith('/stock/symbol')) return ok([listing()]);
    if (fail) throw new Error('offline');
    return ok([]);
  } });
  const original = await service.getNews(held());
  fail = true;
  time(START + 1001);
  const stale = await service.getNews(held());
  assert.equal(stale.isStale, true);
  assert.equal(stale.fetchedAt, original.fetchedAt);
  time(START + 86400001);
  assert.equal((await service.getNews(held())).status, 'UNAVAILABLE');
});
