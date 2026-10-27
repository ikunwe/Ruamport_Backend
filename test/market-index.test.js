const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');
const { createMarketIndexService } = require('../src/modules/trades/market-index.service');
const { createTradeRouter } = require('../src/modules/trades/trade.routes');
const TIME = Date.parse('2026-10-25T09:00Z');
const symbols = ['^GSPC', '^IXIC', '^DJI', '^SET.BK', '^SET50.BK'];
const exchanges = ['SNP', 'NIM', 'DJI', 'SET', 'SET'];
const ok = data => ({ ok: true, status: 200, json: async () => data });
function body(symbol, extra = {}) {
  const thai = symbol.endsWith('.BK');
  return { chart: { result: [{ meta: { symbol, currency: thai ? 'THB' : 'USD', instrumentType: 'INDEX',
    exchangeName: exchanges[symbols.indexOf(symbol)], exchangeTimezoneName: thai ? 'Asia/Bangkok' : 'America/New_York',
    regularMarketTime: Date.parse(thai ? '2026-10-22T09:47Z' : '2026-10-23T20:00Z') / 1000,
    regularMarketPrice: 110, previousClose: 100, chartPreviousClose: 80, ...extra } }] } };
}
function fixture(options = {}) {
  let time = TIME;
  const calls = [];
  const service = createMarketIndexService({ now: () => time, ...options,
    fetchData: async (input, init) => {
      const url = new URL(input); calls.push({ url, init });
      const symbol = decodeURIComponent(url.pathname.split('/').at(-1));
      return options.fetchData ? options.fetchData(symbol, url) : ok(body(symbol));
    } });
  return { service, calls, time: value => { time = value; } };
}

test('five fixed indices use 1-day previousClose, preserve dates/zones and never trust a range baseline', async () => {
  const f = fixture();
  const response = await f.service.getIndices();
  assert.equal(response.status, 'COMPLETE');
  assert.equal(response.cacheTtlSeconds, 900);
  assert.deepEqual(response.items.map(row => row.symbol), symbols);
  for (const item of response.items) {
    assert.equal(item.value, 110); assert.equal(item.previousClose, 100);
    assert.equal(item.change, 10); assert.equal(item.changePercent, 10);
    assert.equal(item.unit, 'POINTS');
    assert.equal(item.valueDate, item.region === 'TH' ? '2026-10-22' : '2026-10-23');
    assert.equal(item.previousCloseDate, null);
    assert.equal(item.marketStatus, 'UNKNOWN');
  }
  for (const { url, init } of f.calls) {
    assert.equal(url.origin, 'https://query1.finance.yahoo.com');
    assert.equal(url.searchParams.get('range'), '1d');
    assert.equal(url.searchParams.get('interval'), '5m');
    assert.equal(init.redirect, 'error');
    assert.equal(Object.hasOwn(init.headers, 'Ocp-Apim-Subscription-Key'), false);
  }
});

test('concurrent readers share immutable provider snapshots and cached calls do not contact Yahoo', async () => {
  const f = fixture();
  const [a, b] = await Promise.all([f.service.getIndices(), f.service.getIndices()]);
  assert.equal(f.calls.length, 5);
  a.items[0].value = 999;
  assert.equal(b.items[0].value, 110);
  const next = await f.service.getIndices();
  assert.equal(next.items[0].value, 110);
  assert.ok(next.items.every(row => row.fromCache && !row.isStale));
  assert.equal(f.calls.length, 5);
});

test('daily changes preserve zero/negative moves and do not invent missing or invalid previousClose', async () => {
  for (const previousClose of [100, 120, 0, null, '100', NaN]) {
    const f = fixture({ fetchData: symbol => ok(body(symbol, { regularMarketPrice: 100, previousClose })) });
    const item = (await f.service.getIndices()).items[0];
    assert.equal(item.status, 'AVAILABLE');
    if (previousClose === 100) { assert.equal(item.change, 0); assert.equal(item.changePercent, 0); }
    else if (previousClose === 120) { assert.equal(item.change, -20); assert.equal(item.changePercent, -16.6667); }
    else { assert.equal(item.changePercent, null); assert.deepEqual(item.issues, ['PREVIOUS_CLOSE_UNAVAILABLE']); }
  }
});

test('expiry refreshes each fixed index once on demand and does not rewrite its observation timestamp', async () => {
  const f = fixture();
  const original = await f.service.getIndices();
  f.time(TIME + 899999);
  await f.service.getIndices();
  assert.equal(f.calls.length, 5);
  f.time(TIME + 900000);
  const [refreshed, shared] = await Promise.all([f.service.getIndices(), f.service.getIndices()]);
  assert.equal(f.calls.length, 10);
  assert.ok(refreshed.items.every(row => row.fetchedAt === new Date(TIME + 900000).toISOString()));
  assert.deepEqual(refreshed.items.map(row => row.valueAt), original.items.map(row => row.valueAt));
  assert.deepEqual(shared.items.map(row => row.value), original.items.map(row => row.value));
});

test('invalid identity/type/currency/market/time/price never becomes an available index', async () => {
  for (const extra of [{ symbol: 'SPY' }, { instrumentType: 'ETF' }, { currency: 'EUR' }, { exchangeName: 'AMS' },
    { exchangeTimezoneName: 'UTC' }, { regularMarketPrice: 0 }, { regularMarketPrice: '100' },
    { regularMarketTime: (TIME + 120000) / 1000 }, { regularMarketTime: (TIME - 8 * 86400000) / 1000 }]) {
    const f = fixture({ fetchData: symbol => ok(body(symbol, extra)) });
    const item = (await f.service.getIndices()).items[0];
    assert.equal(item.status, 'UNAVAILABLE');
    assert.equal(item.errorCode, 'INDEX_RESPONSE_INVALID');
    assert.equal(item.value, null);
  }
  assert.throws(() => createMarketIndexService({ ttlMs: 0 }));
  assert.throws(() => createMarketIndexService({ maxAgeMs: 2 * 86400000 }));
});

test('partial outage preserves other indices, negative-caches safe failures and never leaks upstream data', async () => {
  const f = fixture({ fetchData: symbol => symbol === '^SET50.BK' ? { ok: false, status: 500,
    json: () => { throw new Error('private upstream details'); } } : ok(body(symbol)) });
  const response = await f.service.getIndices();
  assert.equal(response.status, 'PARTIAL');
  assert.equal(response.items.filter(row => row.status === 'AVAILABLE').length, 4);
  assert.equal(response.items.at(-1).providerStatus, 500);
  assert.equal(response.items.at(-1).reason, 'PROVIDER_HTTP_ERROR');
  assert.equal(JSON.stringify(response).includes('private upstream'), false);
  await f.service.getIndices();
  assert.equal(f.calls.length, 5);
});

test('429 honors Retry-After and serves explicitly stale snapshots only within fallback bounds', async () => {
  let fail = false;
  const f = fixture({ fetchData: symbol => fail ? { ok: false, status: 429, headers: { get: () => '120' } } : ok(body(symbol)) });
  await f.service.getIndices();
  fail = true; f.time(TIME + 900000);
  const stale = await f.service.getIndices();
  assert.ok(stale.items.every(row => row.status === 'AVAILABLE' && row.isStale && row.warning === 'INDEX_RATE_LIMITED'));
  assert.ok(stale.items.every(row => row.issues.includes('STALE_CACHE') && row.retryAt));
  const before = f.calls.length;
  await f.service.getIndices();
  assert.equal(f.calls.length, before);
  f.time(TIME + 86400000);
  const unavailable = await f.service.getIndices();
  assert.equal(unavailable.status, 'UNAVAILABLE');
  assert.ok(unavailable.items.every(row => row.value === null && row.limitSource === 'PROVIDER' && row.providerStatus === 429));
});

test('authenticated HTTP endpoint shares index cache across owners, is no-store and ignores arbitrary symbol/user queries', async t => {
  const f = fixture();
  const app = express();
  app.use('/api/v1/trades', createTradeRouter({ marketIndices: f.service, investments: {},
    authenticate: (req, res, next) => {
      if (!req.headers['x-test-user']) return res.sendStatus(401);
      req.user = { id: req.headers['x-test-user'] }; next();
    } }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/v1/trades/market-indices`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal(f.calls.length, 0);
  for (const user of ['owner-A', 'owner-B']) {
    const response = await fetch(url + '?symbol=UNTRUSTED&userId=OTHER', { headers: { 'x-test-user': user } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const data = await response.json();
    assert.deepEqual(data.items.map(row => row.symbol), symbols);
    assert.equal(JSON.stringify(data).includes(user), false);
  }
  assert.equal(f.calls.length, 5);
});
