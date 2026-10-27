const test = require('node:test');
const assert = require('node:assert/strict');
const { createFrankfurterService } = require('../src/modules/trades/frankfurter.service');
const TIME = Date.parse('2026-10-24T08:00:00Z');
const row = (date, rate = 33.7) => ({ base: 'USD', quote: 'THB', date, rate });
const ok = body => ({ ok: true, json: async () => body });

test('future latest triggers one bounded history query, chooses newest valid date and shares/cache snapshots', async () => {
  let calls = 0;
  let firstSignal;
  const service = createFrankfurterService({ now: () => TIME, fetchRate: async (url, init) => {
    calls++;
    if (calls === 1) { firstSignal = init.signal; return ok(row('2026-10-25')); }
    const parsed = new URL(url);
    assert.equal(parsed.origin + parsed.pathname, 'https://api.frankfurter.dev/v2/rates');
    assert.deepEqual(Object.fromEntries(parsed.searchParams), { base: 'USD', quotes: 'THB', from: '2026-10-18', to: '2026-10-24' });
    assert.equal(init.signal, firstSignal);
    assert.equal(init.redirect, 'error');
    return ok([row('2026-10-22', 33.6), row('2026-10-25', 999), row('2026-10-24', 33.708), row('2026-10-23', 33.65)]);
  } });
  const results = await Promise.all(Array.from({ length: 5 }, () => service.getRate()));
  for (const rate of results) {
    assert.equal(rate.rateDate, '2026-10-24');
    assert.equal(rate.rate, 33.708);
    assert.equal(rate.selectionMode, 'HISTORICAL_FALLBACK');
    assert.equal(rate.fallbackReason, 'FUTURE_RATE_DATE');
    assert.equal(rate.requestedThroughDate, '2026-10-24');
    assert.equal(rate.isStale, false);
  }
  assert.equal((await service.getRate()).fromCache, true);
  assert.equal(calls, 2);
});

test('weekend selects actual previous publication date, never rewrites it to today', async () => {
  let calls = 0;
  const service = createFrankfurterService({ now: () => TIME, fetchRate: async () =>
    ok(++calls === 1 ? row('2026-10-25') : [row('2026-10-23', 33.6), row('2026-10-22', 33.5)]) });
  assert.equal((await service.getRate()).rateDate, '2026-10-23');
});

test('no eligible history, bad schema or conflicting latest date fails closed and backs off', async () => {
  for (const [history, reason] of [
    [[], 'HISTORICAL_RATE_UNAVAILABLE'], [[row('2026-10-25')], 'HISTORICAL_RATE_UNAVAILABLE'],
    [[row('2026-10-17')], 'HISTORICAL_RATE_UNAVAILABLE'], [{}, 'INVALID_RESPONSE'],
    [[row('2026-10-24', 0)], 'INVALID_RESPONSE'],
    [[{ ...row('2026-10-24'), quote: 'EUR' }], 'INVALID_RESPONSE'],
    [[row('2026-10-24', 33), row('2026-10-24', 34)], 'INVALID_RESPONSE'],
  ]) {
    let calls = 0;
    const service = createFrankfurterService({ now: () => TIME,
      fetchRate: async () => ok(++calls === 1 ? row('2026-10-25') : history) });
    for (let i = 0; i < 2; i++) await assert.rejects(service.getRate(), { code: 'FX_RATE_UNAVAILABLE', reason });
    assert.equal(calls, 2);
  }
});

test('normal latest does not call history and historical request failure preserves valid cache', async () => {
  let calls = 0;
  let time = TIME;
  const service = createFrankfurterService({ now: () => time, fetchRate: async () => {
    calls++;
    if (calls === 1) return ok(row('2026-10-23', 33.6));
    if (calls === 2) return ok(row('2026-10-25'));
    return { ok: false, status: 429 };
  } });
  assert.equal((await service.getRate()).selectionMode, 'LATEST');
  assert.equal(calls, 1);
  time += 3600000;
  const stale = await service.getRate();
  assert.equal(stale.rateDate, '2026-10-23');
  assert.equal(stale.isStale, true);
  assert.equal(stale.reason, 'UPSTREAM_RATE_LIMITED');
  assert.equal(calls, 3);
});
