const test = require('node:test');
const assert = require('node:assert/strict');
const { createDomesticMarketService, domesticInstrument } = require('../src/modules/trades/domestic-market.service');
const { withDomesticValuation } = require('../src/modules/trades/domestic-valuation');
const { createInvestmentService } = require('../src/modules/trades/investment.service');
const START = Date.parse('2026-10-21T08:00:00Z');
const DAY = 86400000;
const stock = extra => ({ assetType: 'THAI_STOCK', currency: 'THB', symbol: 'ASK', exchange: null, quantity: 100, ...extra });
const fund = extra => ({ assetType: 'MUTUAL_FUND', currency: 'THB', symbol: 'KKP US500-UH-E', quantity: 10, ...extra });
const key = item => domesticInstrument(item).key;
const profile = extra => ({ proj_id: 'M0123_2563', proj_abbr_name: 'KKP US500-UH',
  fund_class_name: 'KKPUS500-UH-E', fund_status: 'Registered', ...extra });
const nav = extra => ({ proj_id: 'M0123_2563', fund_class_name: 'KKPUS500-UH-E',
  nav_date: '2026-10-20', last_val: 12.3456, net_asset: 99999999, buy_price: 12.3, sell_price: 12.5, ...extra });
const page = (items, next_cursor = '') => ({ message: 'success', items, next_cursor });
const ok = row => ({ ok: true, status: 200, json: async () => row });
function fixture(options = {}) {
  let time = START;
  const calls = [];
  const service = createDomesticMarketService({ secApiKey: 'private-sec-key', now: () => time, ...options,
    fetchData: async (input, init) => {
      const url = new URL(input);
      calls.push({ path: url.pathname, params: Object.fromEntries(url.searchParams) });
      assert.equal(init.redirect, 'error');
      assert.ok(init.signal);
      assert.equal(url.toString().includes('private-sec-key'), false);
      if (url.hostname === 'api.sec.or.th') assert.equal(init.headers['Ocp-Apim-Subscription-Key'], 'private-sec-key');
      else {
        assert.equal(url.hostname, 'query1.finance.yahoo.com');
        assert.equal(Object.hasOwn(init.headers, 'Ocp-Apim-Subscription-Key'), false);
      }
      if (options.fetchData) return options.fetchData(url, init);
      if (url.pathname.includes('/profiles')) return ok(page([profile()]));
      if (url.pathname.includes('/daily-info/nav')) return ok(page([nav()]));
      const symbol = decodeURIComponent(url.pathname.split('/').at(-1));
      return ok({ chart: { result: [{ meta: { symbol, currency: 'THB', exchangeName: 'SET',
        instrumentType: 'EQUITY', regularMarketPrice: 9.6, regularMarketTime: time / 1000 } }], error: null } });
    } });
  return { service, calls, time: value => { time = value; },
    get: async (item = stock()) => (await service.getQuotes([item])).get(key(item)) };
}
test('Yahoo Thai quote uses exact .BK identity, THB, safe endpoint and no subscription key', async () => {
  const f = fixture();
  const result = await f.get();
  assert.equal(result.status, 'AVAILABLE');
  assert.equal(result.source, 'YAHOO_FINANCE');
  assert.equal(result.providerSymbol, 'ASK.BK');
  assert.equal(result.price, 9.6);
  assert.equal(result.priceAt, new Date(START).toISOString());
  assert.equal(result.expiresAt, new Date(START + 900000).toISOString());
  assert.equal(result.cachePolicy, 'FIXED_TTL');
  assert.deepEqual(f.calls[0].params, { interval: '1d', range: '5d' });
});

test('Thai daily change uses previous trading-date bar, not chart range baseline or current-day close', async () => {
  const f = fixture({ fetchData: async () => ok({ chart: { result: [{ meta: {
    symbol: 'ASK.BK', currency: 'THB', exchangeName: 'SET', instrumentType: 'EQUITY',
    regularMarketPrice: 9.6, regularMarketTime: START / 1000, chartPreviousClose: 999 },
    timestamp: [START / 1000 - 3 * 86400, START / 1000, START / 1000 - 86400],
    indicators: { quote: [{ close: [9, 9.6, 10] }] } }] } }) });
  const a = await f.get();
  assert.equal(a.previousClose, 10);
  assert.equal(a.previousCloseDate, '2026-10-20');
  assert.equal(a.change, -0.4);
  assert.equal(a.changePercent, -4);
  const b = await f.get();
  assert.equal(b.change, -0.4);
  assert.equal(b.fromCache, true);
  assert.equal(f.calls.length, 1);
});

test('Thai missing, invalid or conflicting nearest close does not discard valid price or skip to older date', async () => {
  for (const closes of [[9, null], [9, 0], [9, '10'], [9, -10], [9, NaN]]) {
    const f = fixture({ fetchData: async () => ok({ chart: { result: [{ meta: {
      symbol: 'ASK.BK', currency: 'THB', exchangeName: 'SET', instrumentType: 'EQUITY',
      regularMarketPrice: 9.6, regularMarketTime: START / 1000 },
      timestamp: [START / 1000 - 2 * 86400, START / 1000 - 86400],
      indicators: { quote: [{ close: closes }] } }] } }) });
    const result = await f.get();
    assert.equal(result.status, 'AVAILABLE');
    assert.equal(result.previousClose, null);
    assert.equal(result.change, null);
    assert.equal(result.changePercent, null);
  }
});

test('Yahoo provider priceHint removes candle float noise without a false daily loss', async () => {
  const f = fixture({ fetchData: async () => ok({ chart: { result: [{ meta: {
    symbol: 'ASK.BK', currency: 'THB', exchangeName: 'SET', instrumentType: 'EQUITY',
    regularMarketPrice: 9.6, regularMarketTime: START / 1000, priceHint: 2 },
    timestamp: [START / 1000 - 86400], indicators: { quote: [{ close: [9.600000381469727] }] } }] } }) });
  const result = await f.get();
  assert.equal(result.previousClose, 9.6);
  assert.equal(result.change, 0);
  assert.equal(result.changePercent, 0);
});

test('fund daily change selects same class previous distinct NAV date, retains both dates and caches with latest NAV', async () => {
  const f = fixture({ fetchData: async url => url.pathname.includes('/profiles') ? ok(page([profile()]))
    : ok(page([nav({ nav_date: '2026-10-19', last_val: 10 }), nav({ last_val: 11 }),
      nav({ nav_date: '2026-10-19', last_val: 10 }),
      nav({ fund_class_name: 'OTHER', nav_date: '2026-10-20', last_val: 999 })])) });
  const result = await f.get(fund());
  assert.equal(result.navDate, '2026-10-20');
  assert.equal(result.previousNavDate, '2026-10-19');
  assert.equal(result.previousNav, 10);
  assert.equal(result.change, 1);
  assert.equal(result.changePercent, 10);
  assert.equal((await f.get(fund())).fromCache, true);
  assert.equal(f.calls.length, 2);
});

test('fund previous NAV may be missing or invalid while latest remains available; never skips invalid preceding date', async () => {
  for (const before of [[], [nav({ nav_date: '2026-10-19', last_val: null })],
    [nav({ nav_date: '2026-10-19', last_val: 0 })],
    [nav({ nav_date: '2026-10-19', last_val: 10 }), nav({ nav_date: '2026-10-19', last_val: 12 })]]) {
    const f = fixture({ fetchData: async url => url.pathname.includes('/profiles') ? ok(page([profile()]))
      : ok(page([nav(), ...before, ...(before.length ? [nav({ nav_date: '2026-10-18', last_val: 9 })] : [])])) });
    const result = await f.get(fund());
    assert.equal(result.status, 'AVAILABLE');
    assert.equal(result.previousNav, null);
    assert.equal(result.change, null);
    assert.equal(result.changePercent, null);
    assert.equal(result.previousNavDate, before.length ? '2026-10-19' : null);
  }
});

test('fund unchanged and falling NAV preserve zero/negative daily movements across non-consecutive dates', async () => {
  for (const latest of [10, 9]) {
    const f = fixture({ fetchData: async url => url.pathname.includes('/profiles') ? ok(page([profile()]))
      : ok(page([nav({ last_val: latest }), nav({ nav_date: '2026-10-16', last_val: 10 })])) });
    const result = await f.get(fund());
    assert.equal(result.change, latest - 10);
    assert.equal(result.changePercent, (latest - 10) * 10);
    assert.equal(result.previousNavDate, '2026-10-16');
  }
});
test('domestic provider only fetches eligible held positions and deduplicates across accounts', async () => {
  const f = fixture();
  const map = await f.service.getQuotes([stock(), stock({ accountNumber: 'other' }),
    stock({ quantity: 0 }), stock({ quantity: -1 }), stock({ quantity: Infinity }),
    stock({ currency: 'USD' }), stock({ exchange: 'XNAS' }), stock({ symbol: 'http://evil' }),
    stock({ assetType: 'OFFSHORE_STOCK' }), fund({ quantity: 0 })]);
  assert.equal(map.size, 1);
  assert.equal(f.calls.length, 1);
});
test('Yahoo concurrent refresh/cache copies are shared but immutable', async () => {
  const f = fixture();
  const [a, b] = await Promise.all([f.get(), f.get()]);
  assert.equal(f.calls.length, 1);
  a.price = 0;
  assert.equal(b.price, 9.6);
  assert.equal((await f.get()).price, 9.6);
  assert.equal((await f.get()).fromCache, true);
  f.time(START + 900000);
  assert.equal((await f.get()).fromCache, false);
  assert.equal(f.calls.length, 2);
});
test('Yahoo rejects wrong symbol/currency/market/type, nonnumeric or invalid timestamps', async () => {
  const base = { symbol: 'ASK.BK', currency: 'THB', exchangeName: 'SET', instrumentType: 'EQUITY',
    regularMarketPrice: 10, regularMarketTime: START / 1000 };
  for (const extra of [{ symbol: 'ASK.US' }, { currency: 'USD' }, { exchangeName: 'NMS' }, { instrumentType: 'ETF' },
    { regularMarketPrice: '10' }, { regularMarketPrice: 0 }, { regularMarketPrice: Infinity },
    { regularMarketTime: 0 }, { regularMarketTime: START / 1000 + 120 }, { regularMarketTime: START / 1000 - 7 * 86400 }]) {
    const f = fixture({ fetchData: async () => ok({ chart: { result: [{ meta: { ...base, ...extra } }] } }) });
    assert.equal((await f.get()).errorCode, 'PRICE_NOT_AVAILABLE');
  }
});
test('Yahoo rate limit pauses uncached stocks and respects retry-after, without leaking upstream body', async () => {
  const f = fixture({ fetchData: async () => ({ ok: false, status: 429, headers: { get: () => '120' },
    json: async () => ({ secret: 'private-sec-key' }) }) });
  const a = await f.get();
  const b = await f.get(stock({ symbol: 'PTT' }));
  assert.equal(a.errorCode, 'PRICE_RATE_LIMITED');
  assert.equal(b.errorCode, 'PRICE_RATE_LIMITED');
  assert.equal(Date.parse(a.retryAt), START + 120000);
  assert.equal(f.calls.length, 1);
  assert.equal(JSON.stringify(a).includes('private-sec-key'), false);
});
test('Yahoo failure preserves bounded stale quote and negative-caches failures', async () => {
  let fail = false;
  const f = fixture({ thaiTtlMs: 1000, fetchData: async () => {
    if (fail) throw new Error('private-sec-key');
    return ok({ chart: { result: [{ meta: { symbol: 'ASK.BK', currency: 'THB', exchangeName: 'SET',
      instrumentType: 'EQUITY', regularMarketPrice: 9.6, regularMarketTime: START / 1000 } }] } });
  } });
  const initial = await f.get();
  fail = true;
  f.time(START + 1001);
  const stale = await f.get();
  assert.equal(stale.isStale, true);
  assert.equal(stale.fetchedAt, initial.fetchedAt);
  assert.equal(stale.warning, 'PRICE_NOT_AVAILABLE');
  await f.get();
  assert.equal(f.calls.length, 2);
  f.time(START + 3 * DAY + 1);
  assert.equal((await f.get()).status, 'UNAVAILABLE');
});
test('SEC missing key is advisory, never calls upstream or prevents Yahoo quotes', async () => {
  const f = fixture({ secApiKey: '' });
  const missing = await f.get(fund());
  assert.equal(missing.errorCode, 'SEC_API_KEY_MISSING');
  assert.equal(missing.price, null);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.get()).source, 'YAHOO_FINANCE');
});
test('SEC resolves exact class and uses last_val, not net assets or offer/redemption price', async () => {
  const f = fixture();
  const result = await f.get(fund());
  assert.equal(result.source, 'SEC_OPEN_API');
  assert.equal(result.kind, 'NAV');
  assert.equal(result.projectId, 'M0123_2563');
  assert.equal(result.fundClassName, 'KKPUS500-UH-E');
  assert.equal(result.price, 12.3456);
  assert.equal(result.navPerUnit, 12.3456);
  assert.equal(result.navDate, '2026-10-20');
  assert.equal(result.priceAt, null);
  assert.equal(result.expiresAt, new Date(START + 3600000).toISOString());
  assert.deepEqual(f.calls[1].params, { proj_id: 'M0123_2563', fund_class_name: 'KKPUS500-UH-E',
    start_nav_date: '2026-10-07', end_nav_date: '2026-10-21', page_size: '100' });
});
test('SEC NAV and profile are single-flight, profile reused on hourly NAV refresh', async () => {
  const f = fixture({ navTtlMs: 1000 });
  const [a, b] = await Promise.all([f.get(fund()), f.get(fund())]);
  assert.equal(f.calls.length, 2);
  a.price = 0;
  assert.equal(b.price, 12.3456);
  f.time(START + 1001);
  await f.get(fund());
  assert.equal(f.calls.filter(c => c.path.includes('/profiles')).length, 1);
  assert.equal(f.calls.filter(c => c.path.includes('/daily-info/nav')).length, 2);
});
test('SEC class lookup never silently chooses master fund, another class, fuzzy match or cancelled profile', async () => {
  for (const row of [profile({ fund_class_name: 'KKPUS500-UH-A' }), profile({ fund_class_name: 'main' }),
    profile({ fund_status: 'Cancelled' }), profile({ fund_class_name: 'KKPUS500-UH-E-SSF' }),
    profile({ fund_class_name: undefined }), profile({ proj_id: 'invalid' })]) {
    const f = fixture({ fetchData: async url => { assert.ok(url.pathname.includes('/profiles')); return ok(page([row])); } });
    assert.equal((await f.get(fund())).errorCode, 'NAV_FUND_NOT_FOUND');
  }
});
test('SEC ambiguity fails instead of selecting the first matching class', async () => {
  const f = fixture({ fetchData: async () => ok(page([profile(), profile({ proj_id: 'M9999_2563' })])) });
  assert.equal((await f.get(fund())).errorCode, 'NAV_FUND_AMBIGUOUS');
  assert.equal(f.calls.length, 1);
});
test('SEC non-class fund requires exact project abbreviation and explicit main marker', async () => {
  const item = fund({ symbol: 'MY-FUND' });
  const f = fixture({ fetchData: async url => url.pathname.includes('/profiles')
    ? ok(page([profile({ proj_abbr_name: 'MY-FUND', fund_class_name: 'main' })]))
    : ok(page([nav({ fund_class_name: 'main' })])) });
  const result = await f.get(item);
  assert.equal(result.status, 'AVAILABLE');
  assert.equal(result.providerSymbol, 'main');
});
test('SEC pagination finds latest correct NAV across pages, not first row or another project/class', async () => {
  const f = fixture({ fetchData: async url => {
    if (url.pathname.includes('/profiles')) return ok(page([profile()]));
    return url.searchParams.get('next_cursor') === 'next'
      ? ok(page([nav(), nav({ nav_date: '2026-10-21', last_val: 13 })]))
      : ok(page([nav({ nav_date: '2026-10-19' }), nav({ fund_class_name: 'OTHER', last_val: 900 }),
        nav({ proj_id: 'M9999_2563', last_val: 900 })], 'next'));
  } });
  const result = await f.get(fund());
  assert.equal(result.price, 13);
  assert.equal(result.navDate, '2026-10-21');
  assert.equal(f.calls.length, 3);
});
test('SEC profile pagination must finish before deciding identity is unique', async () => {
  const f = fixture({ fetchData: async url => url.searchParams.has('next_cursor')
    ? ok(page([profile({ proj_id: 'M9999_2563' })])) : ok(page([profile()], 'next')) });
  assert.equal((await f.get(fund())).errorCode, 'NAV_FUND_AMBIGUOUS');
});
test('SEC repeated/missing cursor or bounded incomplete pagination cannot produce a partial NAV', async () => {
  for (const mode of ['repeat', 'missing', 'limit']) {
    const f = fixture({ maxPages: 2, fetchData: async url => {
      if (url.pathname.includes('/profiles')) return ok(page([profile()]));
      if (mode === 'missing') return ok({ items: [nav()] });
      return ok(page([nav()], mode === 'repeat' ? 'same' : url.searchParams.has('next_cursor') ? 'two' : 'one'));
    } });
    assert.equal((await f.get(fund())).status, 'UNAVAILABLE');
  }
});
test('SEC rejects future, invalid, too-old dates, zero NAV and conflicting latest records', async () => {
  for (const rows of [[nav({ nav_date: '2026-10-22' })], [nav({ nav_date: '2026-02-30' })],
    [nav({ nav_date: '2026-09-01' })], [nav({ last_val: 0 })], [nav({ last_val: '12' })],
    [nav(), nav({ last_val: 13 })], [nav(), nav({ nav_date: '2026-10-21', last_val: null })]]) {
    const f = fixture({ fetchData: async url => ok(page(url.pathname.includes('/profiles') ? [profile()] : rows)) });
    assert.equal((await f.get(fund())).status, 'UNAVAILABLE');
  }
});
test('SEC 401/403/421/429 are sanitized and globally backed off, not retried with a secondary key', async () => {
  for (const status of [401, 403, 421, 429]) {
    const f = fixture({ fetchData: async () => ({ ok: false, status, json: async () => ({ error: 'private-sec-key' }) }) });
    const a = await f.get(fund());
    const b = await f.get(fund({ symbol: 'OTHER-FUND' }));
    assert.equal(a.errorCode, status < 420 ? 'NAV_ACCESS_DENIED' : 'NAV_RATE_LIMITED');
    assert.equal(b.errorCode, a.errorCode);
    assert.equal(f.calls.length, 1);
    assert.equal(JSON.stringify(a).includes('private-sec-key'), false);
  }
});
test('SEC updates stale data honestly, keeps timestamp and stops serving expired NAV dates', async () => {
  let fail = false;
  const f = fixture({ navTtlMs: 1000, fetchData: async url => {
    if (url.pathname.includes('/profiles')) return ok(page([profile()]));
    if (fail) throw new Error('private-sec-key');
    return ok(page([nav()]));
  } });
  const original = await f.get(fund());
  fail = true;
  f.time(START + 1001);
  const stale = await f.get(fund());
  assert.equal(stale.fetchedAt, original.fetchedAt);
  assert.equal(stale.isStale, true);
  assert.equal(stale.warning, 'NAV_NOT_AVAILABLE');
  f.time(START + 15 * DAY);
  assert.equal((await f.get(fund())).status, 'UNAVAILABLE');
});
test('Thai date range uses Bangkok date, not UTC date', async () => {
  const f = fixture();
  f.time(Date.parse('2026-10-22T00:30:00+07:00'));
  await f.get(fund());
  assert.equal(f.calls[1].params.end_nav_date, '2026-10-22');
});
test('limits are bounded and independent provider budgets do not invent quota entitlements', async () => {
  assert.throws(() => createDomesticMarketService({ navTtlMs: 2 * DAY }));
  assert.throws(() => createDomesticMarketService({ maxPages: 21 }));
  const f = fixture();
  const items = Array.from({ length: 21 }, (_, i) => stock({ symbol: 'S' + i }));
  const result = await f.service.getQuotes(items);
  assert.equal([...result.values()].filter(q => q.status === 'AVAILABLE').length, 20);
  assert.equal(result.get(key(items[20])).errorCode, 'PRICE_RATE_LIMITED');
  assert.equal((await f.get(fund())).status, 'AVAILABLE');
});
const cost = remainingCost => [{ currency: 'THB', status: 'CALCULATED', remainingCost }];
const quoteMap = (items, price = 12) => new Map(items.map(item => [key(item), {
  status: 'AVAILABLE', source: item.assetType === 'THAI_STOCK' ? 'YAHOO_FINANCE' : 'SEC_OPEN_API',
  price, priceAt: item.assetType === 'THAI_STOCK' ? new Date(START).toISOString() : null,
  navDate: item.assetType === 'MUTUAL_FUND' ? '2026-10-20' : null, isStale: false,
}]));
test('THB valuation uses actual remaining FIFO/Average Cost, keeps original history and exact decimal arithmetic', () => {
  const items = [stock({ quantity: 3, costBasis: cost(30), costBasisMethod: 'FIFO' }),
    fund({ quantity: 2.5, costBasis: cost(20), costBasisMethod: 'MOVING_WEIGHTED_AVERAGE' })];
  const data = { items, limitations: ['MARKET_VALUE_OFFSHORE_USD_ONLY'] };
  const original = structuredClone(data);
  const result = withDomesticValuation(data, quoteMap(items, 12.3456), 900, 3600);
  assert.equal(result.items[0].marketValuation.thb.marketValue, 37.04);
  assert.equal(result.items[0].marketValuation.thb.unrealizedPnl, 7.04);
  assert.equal(result.items[1].marketValuation.thb.marketValue, 30.86);
  assert.equal(result.items[1].marketValuation.thb.unrealizedPnl, 10.86);
  assert.equal(result.items[1].marketValuation.usd, null);
  assert.equal(result.thaiStockValuation.thb.marketValue, 37.04);
  assert.equal(result.mutualFundValuation.thb.marketValue, 30.86);
  assert.equal(result.mutualFundValuation.newestNavDate, '2026-10-20');
  assert.equal(result.thaiStockValuation.isComplete, true);
  assert.deepEqual(data, original);
  assert.deepEqual(result.items[0].costBasis, original.items[0].costBasis);
});
test('missing price/cost, zero cost, stale NAV, closed and unsupported positions are explicit', () => {
  const items = [stock({ costBasis: cost(0) }), stock({ symbol: 'PTT', costBasis: cost(200) }),
    fund({ costBasis: cost(100) }), fund({ symbol: 'NO-COST' }), stock({ symbol: 'CLOSED', quantity: 0 }),
    stock({ symbol: 'USD', currency: 'USD' })];
  const quotes = quoteMap([items[0], items[2], items[3]]);
  quotes.get(key(items[2])).isStale = true;
  const result = withDomesticValuation({ items }, quotes, 900, 3600);
  assert.equal(result.items[0].marketValuation.thb.unrealizedPnlPercent, null);
  assert.equal(result.items[1].marketValuation.thb.marketValue, null);
  assert.equal(result.thaiStockValuation.isComplete, false);
  assert.equal(result.thaiStockValuation.thb.marketValue, null);
  assert.equal(result.thaiStockValuation.thb.availableMarketValue, 1200);
  assert.ok(result.items[2].marketValuation.issues.includes('STALE_NAV'));
  assert.equal(result.items[3].marketValuation.status, 'COST_INCOMPLETE');
  assert.equal(result.items[3].marketValuation.thb.unrealizedPnl, null);
  assert.equal(result.items[4].marketValuation.status, 'NOT_HELD');
  assert.equal(result.items[5].marketValuation.status, 'UNSUPPORTED');
});
test('holdings defaults make no provider calls; market opt-in adds domestic valuations without changing offshore results', async () => {
  const items = [stock({ costBasis: cost(800) }), fund({ costBasis: cost(100) })];
  let calls = 0;
  const service = createInvestmentService({ repository: { holdings: async user => { assert.equal(user, 'owner'); return { items }; } },
    marketPrices: { cacheTtlSeconds: 900, getQuotes: async () => new Map() },
    domesticPrices: { thaiCacheTtlSeconds: 900, navCacheTtlSeconds: 3600,
      getQuotes: async rows => { calls++; return quoteMap(rows); } } });
  assert.deepEqual(await service.holdings('owner'), { items });
  assert.equal(calls, 0);
  const result = await service.holdings('owner', { includeMarket: 'true' });
  assert.equal(calls, 1);
  assert.equal(result.items[0].marketValuation.thb.marketValue, 1200);
  assert.equal(result.items[1].marketValuation.thb.marketValue, 120);
  assert.equal(result.offshoreValuation.heldPositionCount, 0);
});
