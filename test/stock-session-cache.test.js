const test = require('node:test');
const assert = require('node:assert/strict');
const { usMarketSchedule } = require('../src/modules/trades/us-market-calendar');
const { createStockPriceService, instrument } = require('../src/modules/trades/stock-price.service');
const ms = value => Date.parse(value);
const held = symbol => ({ assetType: 'OFFSHORE_STOCK', currency: 'USD', quantity: 1, symbol, exchange: 'XNAS' });
const ok = row => ({ ok: true, status: 200, json: async () => row });
function fixture(start, options = {}) {
  let time = ms(start);
  let priceAt = null;
  let fail = false;
  const calls = [];
  const service = createStockPriceService({ apiKey: 'test-key', now: () => time, ...options,
    fetchQuote: async input => {
      const url = new URL(input);
      calls.push(url.pathname);
      if (url.pathname.endsWith('/stock/symbol')) return ok(['AMD', 'NVDA'].map(symbol => ({ symbol, mic: 'XNAS', currency: 'USD' })));
      if (fail) throw new Error('safe test outage');
      return ok({ c: 100, t: (priceAt ?? time) / 1000 });
    } });
  return { service, calls, at: value => { time = ms(value); }, priceAt: value => { priceAt = ms(value); },
    fail: value => { fail = value; }, count: () => calls.filter(p => p.endsWith('/quote')).length,
    get: async (symbol = 'AMD') => (await service.getQuotes([held(symbol)])).get(instrument(held(symbol)).key) };
}
test('calendar uses New York DST with correct Thai-time equivalents', () => {
  const summer = usMarketSchedule(ms('2026-10-21T21:30:00+07:00'));
  assert.equal(summer.state, 'OPEN');
  assert.equal(summer.sessionOpenAt, '2026-10-21T13:30:00.000Z');
  assert.equal(summer.sessionCloseAt, '2026-10-21T20:00:00.000Z');
  const winter = usMarketSchedule(ms('2026-11-03T21:29:00+07:00'));
  assert.equal(winter.state, 'CLOSED');
  assert.equal(winter.nextOpenAt, '2026-11-03T14:30:00.000Z');
  assert.equal(usMarketSchedule(ms('2026-11-03T21:30:00+07:00')).state, 'OPEN');
  assert.equal(usMarketSchedule(ms('2026-11-03T21:30:00+07:00')).sessionCloseAt, '2026-11-03T21:00:00.000Z');
  assert.equal(usMarketSchedule(ms('2026-11-03T21:30:00Z')).state, 'CLOSED');
});
test('calendar skips weekends/holidays, handles early closes and stops at coverage boundary', () => {
  const thanksgiving = usMarketSchedule(ms('2026-11-26T15:00:00Z'));
  assert.equal(thanksgiving.state, 'CLOSED');
  assert.equal(thanksgiving.nextOpenAt, '2026-11-27T14:30:00.000Z');
  const early = usMarketSchedule(ms('2026-11-27T18:00:00Z'));
  assert.equal(early.state, 'CLOSED');
  assert.equal(early.sessionCloseAt, '2026-11-27T18:00:00.000Z');
  assert.equal(early.nextOpenAt, '2026-11-30T14:30:00.000Z');
  assert.equal(usMarketSchedule(ms('2026-12-24T18:01:00Z')).nextOpenAt, '2026-12-28T14:30:00.000Z');
  assert.equal(usMarketSchedule(ms('2028-07-03T17:01:00Z')).sessionCloseAt, '2028-07-03T17:00:00.000Z');
  assert.equal(usMarketSchedule(ms('2028-01-01T15:00:00Z')).nextOpenAt, '2028-01-03T14:30:00.000Z');
  assert.equal(usMarketSchedule(ms('2029-01-02T15:00:00Z')).state, 'UNKNOWN');
});
test('open session keeps 15-minute TTL, refreshes at expiry and caps expiry at close', async () => {
  const f = fixture('2026-10-20T15:00:00Z');
  const first = await f.get();
  assert.equal(first.cachePolicy, 'MARKET_OPEN_TTL');
  assert.equal(first.expiresAt, '2026-10-20T15:15:00.000Z');
  assert.equal(first.marketOpen, null);
  assert.equal(first.marketSchedule.state, 'OPEN');
  f.at('2026-10-20T15:14:59Z');
  assert.equal((await f.get()).fromCache, true);
  f.at('2026-10-20T15:15:00Z');
  assert.equal((await f.get()).fromCache, false);
  assert.equal(f.count(), 2);
  f.at('2026-10-20T19:55:00Z');
  assert.equal((await f.get()).expiresAt, '2026-10-20T20:00:00.000Z');
});
test('first request after close refreshes even if old price is less than 15 minutes old', async () => {
  const f = fixture('2026-10-20T19:59:00Z');
  await f.get();
  f.at('2026-10-20T20:01:00Z');
  const closing = await f.get();
  assert.equal(f.count(), 2);
  assert.equal(closing.cachePolicy, 'POST_CLOSE_REFRESH_PENDING');
  assert.equal(closing.postCloseRefreshPending, true);
  assert.equal(closing.expiresAt, '2026-10-20T20:05:00.000Z');
  f.at('2026-10-20T20:04:59Z');
  assert.equal((await f.get()).fromCache, true);
  assert.equal(f.count(), 2);
  f.at('2026-10-20T20:05:00Z');
  f.priceAt('2026-10-20T20:00:00Z');
  const final = await f.get();
  assert.equal(f.count(), 3);
  assert.equal(final.cachePolicy, 'MARKET_CLOSED_UNTIL_OPEN');
  assert.equal(final.expiresAt, '2026-10-21T13:30:00.000Z');
  assert.equal(final.postCloseRefreshPending, false);
  assert.equal(final.isStale, false);
});
test('closed snapshot survives TTL and refreshes on the first request at next open', async () => {
  const f = fixture('2026-10-20T20:10:00Z');
  f.priceAt('2026-10-20T20:00:00Z');
  const first = await f.get();
  f.at('2026-10-21T13:29:59Z');
  const cached = await f.get();
  assert.equal(f.count(), 1);
  assert.equal(cached.isStale, false);
  assert.equal(cached.fetchedAt, first.fetchedAt);
  assert.equal(cached.marketSchedule.state, 'CLOSED');
  f.at('2026-10-21T13:30:00Z');
  f.priceAt('2026-10-21T13:30:00Z');
  const open = await f.get();
  assert.equal(f.count(), 2);
  assert.equal(open.cachePolicy, 'MARKET_OPEN_TTL');
  assert.equal(open.expiresAt, '2026-10-21T13:45:00.000Z');
  assert.equal(open.marketSchedule.state, 'OPEN');
});
test('long holiday closure remains valid beyond 72 hours until next open', async () => {
  const f = fixture('2026-04-02T20:10:00Z');
  f.priceAt('2026-04-02T20:00:00Z');
  const first = await f.get();
  assert.equal(first.expiresAt, '2026-04-06T13:30:00.000Z');
  f.at('2026-04-06T12:00:00Z');
  const next = await f.get();
  assert.equal(f.count(), 1);
  assert.equal(next.isStale, false);
  assert.equal(next.fetchedAt, first.fetchedAt);
});
test('missing stock fetches once while other closed-market snapshots remain cached', async () => {
  const f = fixture('2026-10-20T20:10:00Z');
  f.priceAt('2026-10-20T20:00:00Z');
  await f.get();
  f.at('2026-10-21T10:00:00Z');
  const newStock = await f.get('NVDA');
  assert.equal(newStock.status, 'AVAILABLE');
  assert.equal(newStock.cachePolicy, 'MARKET_CLOSED_UNTIL_OPEN');
  assert.equal(f.count(), 2);
  await f.get();
  assert.equal(f.count(), 2);
});
test('stale provider price after close retries on short TTL instead of freezing for the night', async () => {
  const f = fixture('2026-10-20T20:10:00Z');
  f.priceAt('2026-10-19T20:00:00Z');
  const old = await f.get();
  assert.equal(old.isStale, true);
  assert.equal(old.warning, 'POST_CLOSE_PRICE_PENDING');
  assert.equal(old.cachePolicy, 'POST_CLOSE_REFRESH_PENDING');
  assert.equal(old.expiresAt, '2026-10-20T20:25:00.000Z');
  f.at('2026-10-20T20:24:00Z');
  assert.equal((await f.get()).isStale, true);
  assert.equal(f.count(), 1);
  f.at('2026-10-20T20:25:00Z');
  f.priceAt('2026-10-20T20:00:00Z');
  const recovered = await f.get();
  assert.equal(recovered.isStale, false);
  assert.equal(recovered.cachePolicy, 'MARKET_CLOSED_UNTIL_OPEN');
  assert.equal(Object.hasOwn(recovered, 'warning'), false);
});
test('early-close refresh observes the actual shortened session, not normal 16:00', async () => {
  const f = fixture('2026-11-27T17:59:00Z');
  await f.get();
  f.at('2026-11-27T18:06:00Z');
  f.priceAt('2026-11-27T18:00:00Z');
  const result = await f.get();
  assert.equal(f.count(), 2);
  assert.equal(result.cachePolicy, 'MARKET_CLOSED_UNTIL_OPEN');
  assert.equal(result.expiresAt, '2026-11-30T14:30:00.000Z');
});
test('post-close fetch failures use stale fallback/backoff, not a falsely refreshed snapshot', async () => {
  const f = fixture('2026-10-20T19:59:00Z');
  const first = await f.get();
  f.at('2026-10-20T20:10:00Z');
  f.fail(true);
  const failed = await f.get();
  assert.equal(failed.fetchedAt, first.fetchedAt);
  assert.equal(failed.isStale, true);
  assert.equal(failed.warning, 'PRICE_NOT_AVAILABLE');
  assert.equal(failed.cachePolicy, 'POST_CLOSE_REFRESH_PENDING');
  await f.get();
  assert.equal(f.count(), 2);
  f.at('2026-10-20T20:11:00Z');
  f.fail(false);
  const recovered = await f.get();
  assert.equal(recovered.cachePolicy, 'MARKET_CLOSED_UNTIL_OPEN');
  assert.equal(f.count(), 3);
});
test('reopen forces refresh even when configured TTL overlaps the opening boundary', async () => {
  const f = fixture('2026-10-21T13:29:00Z');
  f.priceAt('2026-10-20T20:00:00Z');
  await f.get();
  f.at('2026-10-21T13:30:00Z');
  f.priceAt('2026-10-21T13:30:00Z');
  assert.equal((await f.get()).fromCache, false);
  assert.equal(f.count(), 2);
});
test('unknown calendar uses ordinary TTL with no invented next-opening date', async () => {
  const f = fixture('2029-01-02T15:00:00Z');
  const result = await f.get();
  assert.equal(result.cachePolicy, 'CALENDAR_FALLBACK_TTL');
  assert.equal(result.marketSchedule.state, 'UNKNOWN');
  assert.equal(result.marketSchedule.nextOpenAt, null);
  assert.equal(result.expiresAt, '2029-01-02T15:15:00.000Z');
});
test('simultaneous first post-close requests share one refresh', async () => {
  const f = fixture('2026-10-20T19:59:00Z');
  await f.get();
  f.at('2026-10-20T20:10:00Z');
  await Promise.all([f.get(), f.get(), f.get()]);
  assert.equal(f.count(), 2);
});
