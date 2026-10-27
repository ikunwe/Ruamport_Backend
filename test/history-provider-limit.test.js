const test = require('node:test');
const assert = require('node:assert/strict');
const { createProviderClient } = require('../src/modules/trades/public-market-cache');
const { createPortfolioHistoryMarket } = require('../src/modules/trades/portfolio-history-market');
const { createPortfolioHistoryService } = require('../src/modules/trades/portfolio-history.service');
const TIME = Date.parse('2026-10-25T08:00Z');
const item = symbol => ({ assetType: 'THAI_STOCK', symbol, currency: 'THB' });
const ok = body => ({ ok: true, status: 200, json: async () => body });
function candle(input) {
  const symbol = decodeURIComponent(new URL(input).pathname.split('/').at(-1));
  return ok({ chart: { result: [{ meta: { symbol, currency: 'THB', exchangeName: 'SET', instrumentType: 'EQUITY' },
    timestamp: [Date.parse('2026-10-23T08:00Z') / 1000], indicators: { quote: [{ close: [10] }] } }] } });
}

test('reproduces old cold-start failure: 21st request is backend budget, not a Yahoo 429', async () => {
  let calls = 0;
  const market = createPortfolioHistoryMarket({ now: () => TIME, queueWaitMs: 0,
    fetchData: async input => { calls++; return candle(input); } });
  let last;
  for (let i = 0; i < 21; i++) last = await market.getSeries(item('S' + i), '2026-10-01', '2026-10-25');
  assert.equal(calls, 20);
  assert.equal(last.errorCode, 'HISTORY_RATE_LIMITED');
  assert.equal(last.limitSource, 'BACKEND');
  assert.equal(last.reason, 'BACKEND_PER_MINUTE_LIMIT');
  assert.equal(last.providerStatus, null);
  assert.equal(last.retryAt, new Date(TIME + 60_000).toISOString());
});

test('30 cold historical instruments finish via bounded queue without increasing 20/minute budget; re-entry is cached', async () => {
  let time = TIME;
  const calls = [], waits = [];
  const market = createPortfolioHistoryMarket({ now: () => time,
    wait: async ms => { waits.push(ms); time += ms; },
    fetchData: async input => { calls.push(time); return candle(input); } });
  const items = Array.from({ length: 30 }, (_, i) => item('S' + i));
  for (const stock of items) assert.equal((await market.getSeries(stock, '2026-10-01', '2026-10-25')).status, 'AVAILABLE');
  assert.deepEqual(waits, [60_000]);
  for (const at of calls) assert.ok(calls.filter(value => value >= at && value < at + 60_000).length <= 20);
  assert.equal(calls.length, 30);
  for (const stock of items) {
    const response = await market.getSeries(stock, '2026-10-24', '2026-10-25');
    assert.equal(response.cacheStatus, 'HIT');
  }
  assert.equal(calls.length, 30);
});

test('provider 429 and 421 retain source/status/retry-after across cache failure and global backoff', async () => {
  for (const status of [429, 421]) {
    let time = TIME, calls = 0, available = false;
    const market = createPortfolioHistoryMarket({ now: () => time, fetchData: async input => {
      calls++;
      return available ? candle(input) : { ok: false, status, headers: { get: () => '120' },
        json: () => { throw new Error('Private provider payload must not be read'); } };
    } });
    const first = await market.getSeries(item('ASK'), '2026-10-01', '2026-10-25');
    assert.equal(first.limitSource, 'PROVIDER');
    assert.equal(first.reason, 'PROVIDER_RATE_LIMIT');
    assert.equal(first.providerStatus, status);
    assert.equal(first.retryAt, new Date(TIME + 120_000).toISOString());
    const cached = await market.getSeries(item('ASK'), '2026-10-20', '2026-10-25');
    assert.equal(cached.cacheStatus, 'RETRY_WAIT');
    assert.equal(cached.reason, first.reason);
    assert.equal(cached.providerStatus, status);
    const other = await market.getSeries(item('PTT'), '2026-10-01', '2026-10-25');
    assert.equal(other.limitSource, 'PROVIDER');
    assert.equal(other.providerStatus, status);
    assert.equal(calls, 1);
    time += 120_000; available = true;
    assert.equal((await market.getSeries(item('ASK'), '2026-10-01', '2026-10-25')).status, 'AVAILABLE');
    assert.equal(calls, 2);
  }
});

test('cached re-entry does not wait behind another uncached instrument pending admission', async () => {
  let time = TIME, calls = 0, unblock;
  let started;
  const waiting = new Promise(resolve => { started = resolve; });
  const market = createPortfolioHistoryMarket({ now: () => time,
    wait: ms => { started(); return new Promise(resolve => { unblock = () => { time += ms; resolve(); }; }); },
    fetchData: async input => { calls++; return candle(input); } });
  for (let i = 0; i < 20; i++) await market.getSeries(item('S' + i), '2026-10-01', '2026-10-25');
  const pending = market.getSeries(item('UNCACHED'), '2026-10-01', '2026-10-25');
  await waiting;
  try {
    const cached = await market.getSeries(item('S0'), '2026-10-24', '2026-10-25');
    assert.equal(cached.cacheStatus, 'HIT');
    assert.equal(calls, 20);
  } finally { unblock(); }
  assert.equal((await pending).status, 'AVAILABLE');
  assert.equal(calls, 21);
});

test('concurrent cold requests obey the rolling budget without duplicated per-instrument loads', async () => {
  let time = TIME, calls = 0;
  const market = createPortfolioHistoryMarket({ now: () => time, wait: async ms => { time += ms; },
    fetchData: async input => { calls++; return candle(input); } });
  const responses = await Promise.all(Array.from({ length: 60 }, (_, index) =>
    market.getSeries(item('S' + (index % 30)), '2026-10-01', '2026-10-25')));
  assert.ok(responses.every(response => response.status === 'AVAILABLE'));
  assert.equal(calls, 30);
  assert.equal(time - TIME, 60_000);
});

test('queue has a deadline and capacity; rejection is BACKEND not PROVIDER and does not call upstream', async () => {
  let calls = 0;
  const client = createProviderClient({ now: () => TIME, origin: 'https://example.com', prefix: 'HISTORY',
    perMinute: 1, queueWaitMs: 10, fetchData: async () => { calls++; return ok({}); } });
  await client.get('/history');
  await assert.rejects(client.get('/history'), error => error.reason === 'BACKEND_QUEUE_TIMEOUT'
    && error.limitSource === 'BACKEND' && error.providerStatus === undefined);
  assert.equal(calls, 1);
  const small = createProviderClient({ now: () => TIME, origin: 'https://example.com', prefix: 'HISTORY',
    perMinute: 1, queueWaitMs: 10, maxQueued: 1, fetchData: async () => ok({}) });
  const first = small.get('/history');
  await assert.rejects(small.get('/history'), error => error.reason === 'BACKEND_QUEUE_FULL');
  await first;
});

test('network/timeout failures are not presented as rate limits or expose raw upstream details', async () => {
  for (const name of ['TimeoutError', 'TypeError']) {
    const market = createPortfolioHistoryMarket({ now: () => TIME, fetchData: async () => {
      throw Object.assign(new Error('secret token and URL'), { name });
    } });
    const result = await market.getSeries(item('ASK'), '2026-10-01', '2026-10-25');
    assert.equal(result.errorCode, 'HISTORY_NOT_AVAILABLE');
    assert.equal(result.reason, name === 'TimeoutError' ? 'PROVIDER_TIMEOUT' : 'NETWORK_ERROR');
    assert.equal(result.limitSource, null);
    assert.equal(JSON.stringify(result).includes('secret'), false);
  }
});

test('chart response propagates position and historical-FX limit diagnostics separately', async () => {
  const market = createPortfolioHistoryMarket({ now: () => TIME,
    fetchData: async () => ({ ok: false, status: 429, headers: { get: () => '90' } }) });
  const service = createPortfolioHistoryService({ market, now: () => TIME,
    repository: { portfolioOrders: async () => ({ orders: [{ assetType: 'OFFSHORE_STOCK', symbol: 'AMD',
      exchange: 'XNAS', currency: 'USD', transactionType: 'BUY', units: 1, tradeDate: '2026-10-20' }] }) } });
  const response = await service.get('test-owner', { range: 'ALL' });
  assert.equal(response.status, 'INCOMPLETE');
  assert.equal(response.positions[0].reason, 'PROVIDER_RATE_LIMIT');
  assert.equal(response.positions[0].providerStatus, 429);
  assert.equal(response.positions[0].limitSource, 'PROVIDER');
  assert.equal(response.positions[0].retryAt, new Date(TIME + 90_000).toISOString());
  assert.equal(response.fxHistory.errorCode, 'HISTORY_FX_RATE_LIMITED');
  assert.equal(response.fxHistory.reason, 'PROVIDER_RATE_LIMIT');
  assert.equal(response.fxHistory.providerStatus, 429);
});
