const test = require('node:test');
const assert = require('node:assert/strict');
const { createFrankfurterService } = require('../src/modules/trades/frankfurter.service');
const { convertUsd } = require('../src/modules/trades/holdings-fx');
const { createInvestmentService } = require('../src/modules/trades/investment.service');
const { AppError } = require('../src/shared/errors/app-error');

const START = Date.parse('2026-10-20T08:00:00Z');
const ROW = { date: '2026-10-19', base: 'USD', quote: 'THB', rate: 33.498 };
const ok = (row = ROW) => ({ ok: true, json: async () => row });

test('Frankfurter uses the fixed public pair URL, validates response and caches one snapshot', async () => {
  let calls = 0;
  const service = createFrankfurterService({ now: () => START, fetchRate: async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.frankfurter.dev/v2/rate/USD/THB');
    assert.deepEqual(options.headers, { Accept: 'application/json' });
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.redirect, 'error');
    return ok();
  } });
  const first = await service.getRate();
  assert.equal(first.rateDate, ROW.date);
  assert.equal(first.rate, ROW.rate);
  assert.equal(first.fromCache, false);
  assert.equal(first.isStale, false);
  const cached = await service.getRate();
  assert.equal(cached.fromCache, true);
  assert.equal(cached.fetchedAt, first.fetchedAt);
  assert.equal(calls, 1);
  cached.rate = 1;
  assert.equal((await service.getRate()).rate, ROW.rate);
});

test('concurrent cold/expired requests share a refresh; cache expiry fetches the new rate', async () => {
  let calls = 0;
  let time = START;
  const service = createFrankfurterService({ now: () => time, fetchRate: async () => { calls++; return ok({ ...ROW, rate: 30 + calls }); } });
  const results = await Promise.all(Array.from({ length: 10 }, () => service.getRate()));
  assert.equal(calls, 1);
  assert.ok(results.every(row => row.rate === 31));
  time += 3_600_001;
  assert.equal((await service.getRate()).rate, 32);
  assert.equal(calls, 2);
});

test('expired cache falls back explicitly on upstream failure, backs off, then rejects too-old cache', async () => {
  let time = START;
  let calls = 0;
  const service = createFrankfurterService({ now: () => time, fetchRate: async () => {
    if (++calls > 1) throw new Error('private upstream detail');
    return ok();
  } });
  await service.getRate();
  time += 3_600_001;
  const stale = await service.getRate();
  assert.equal(stale.isStale, true);
  assert.equal(stale.warning, 'FX_REFRESH_FAILED_USING_CACHED_RATE');
  assert.equal(stale.rateDate, ROW.date);
  await service.getRate();
  assert.equal(calls, 2);
  time = START + 86_400_000;
  await assert.rejects(service.getRate(), { status: 503, code: 'FX_RATE_UNAVAILABLE' });
});

test('cold upstream failures are sanitized and throttled; successful retries recover', async () => {
  let calls = 0;
  let time = START;
  const service = createFrankfurterService({ now: () => time, fetchRate: async () => {
    if (++calls === 1) throw new Error('secret');
    return ok();
  } });
  for (let i = 0; i < 2; i++) await assert.rejects(service.getRate(), error => error.code === 'FX_RATE_UNAVAILABLE' && !error.message.includes('secret'));
  assert.equal(calls, 1);
  time += 60_000;
  assert.equal((await service.getRate()).rate, ROW.rate);
});

test('invalid, wrong-pair, impossible/future/old-date and nonpositive rates are rejected', async () => {
  const rows = [null, {}, { ...ROW, base: 'THB' }, { ...ROW, quote: 'EUR' },
    { ...ROW, rate: '33' }, { ...ROW, rate: 0 }, { ...ROW, rate: -1 }, { ...ROW, rate: Infinity },
    { ...ROW, date: '2026-02-30' }, { ...ROW, date: '2026-10-21' }, { ...ROW, date: '2026-10-01' }];
  for (const row of rows) {
    const service = createFrankfurterService({ now: () => START, fetchRate: async () => ok(row) });
    await assert.rejects(service.getRate(), { code: 'FX_RATE_UNAVAILABLE' });
  }
  for (const response of [{ ok: false }, { ok: true, json: async () => { throw new Error('bad JSON'); } }]) {
    await assert.rejects(createFrankfurterService({ now: () => START, fetchRate: async () => response }).getRate(), { code: 'FX_RATE_UNAVAILABLE' });
  }
});

test('failed refresh does not overwrite a valid snapshot with a malformed payload', async () => {
  let time = START;
  let calls = 0;
  const service = createFrankfurterService({ now: () => time, fetchRate: async () => ++calls === 1 ? ok() : ok({ ...ROW, rate: -1 }) });
  await service.getRate();
  time += 3_600_000;
  const stale = await service.getRate();
  assert.equal(stale.rate, ROW.rate);
  assert.equal(stale.isStale, true);
  assert.equal(stale.fetchedAt, new Date(START).toISOString());
});

test('a previously valid rate that ages beyond seven days is not served as a fallback', async () => {
  let time = Date.parse('2026-10-20T00:00:00Z');
  let calls = 0;
  const service = createFrankfurterService({ now: () => time, fetchRate: async () => {
    if (++calls > 1) throw new Error('Unavailable');
    return ok({ ...ROW, date: '2026-10-14' });
  } });
  await service.getRate();
  time += 86_400_000 - 1;
  assert.equal((await service.getRate()).isStale, true);
  time += 1;
  await assert.rejects(service.getRate(), { code: 'FX_RATE_UNAVAILABLE' });
});

test('network timeout is bounded and does not expose abort details', async () => {
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const service = createFrankfurterService({ timeoutMs: 5, fetchRate: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }) });
    await assert.rejects(service.getRate(), { code: 'FX_RATE_UNAVAILABLE' });
  } finally { clearTimeout(keepAlive); }
});

test('display conversions use decimal half-away rounding and preserve missing values and zero', () => {
  assert.equal(convertUsd(1.005, 1), 1.01);
  assert.equal(convertUsd(-1.005, 1), -1.01);
  assert.equal(convertUsd(29.95, 33.498), 1003.27);
  assert.equal(convertUsd(1e-7, 33.498, 8), 0.00000335);
  assert.equal(convertUsd(12.3456789, 33.498, 8), 413.55555179);
  assert.equal(convertUsd(0, 33.498), 0);
  for (const value of [null, undefined, NaN, Infinity, '30', 1e30]) assert.equal(convertUsd(value, 33.498), null);
});

function portfolio() {
  return { items: [
    { assetType: 'OFFSHORE_STOCK', currency: 'USD', symbol: 'AAA',
      amounts: [{ currency: 'USD', totalBuyGross: 29.95, totalFeeIncludeVat: 0.05, grossIsComplete: true }, { currency: 'THB', totalBuyGross: 1048.25 }],
      costBasis: [{ currency: 'USD', remainingCost: 20, averageCostPerUnit: 10, method: 'COMPRESSED_FIFO', quantity: 2 }, { currency: 'THB', remainingCost: 700 }] },
    { assetType: 'OFFSHORE_STOCK', currency: 'USD', symbol: 'BBB', amounts: [{ currency: 'USD', totalBuyGross: null, grossIsComplete: false }], costBasis: [{ currency: 'USD', remainingCost: null, averageCostPerUnit: null, status: 'INCOMPLETE' }] },
    { assetType: 'THAI_STOCK', currency: 'THB', amounts: [{ currency: 'THB', totalBuyGross: 999 }] },
    { assetType: 'MUTUAL_FUND', currency: 'THB' },
    { assetType: 'OFFSHORE_STOCK', currency: 'EUR' },
  ], stockMoneyTotals: [{ currency: 'USD', totalBuyGross: 100, orderCount: 10 }],
  stockRemainingCostTotals: [{ currency: 'USD', remainingCost: 20, isComplete: false, positionCount: 2 }],
  remainingCostTotals: [{ currency: 'THB', remainingCost: 1699 }] };
}

test('holdings opt-in converts a single FX snapshot, never mutates historical PDF or cost values', async () => {
  const data = portfolio();
  const original = structuredClone(data);
  let calls = 0;
  const service = createInvestmentService({ repository: { holdings: async (user, closed) => { assert.equal(user, 'owner'); assert.equal(closed, false); return data; } },
    exchangeRates: { getRate: async () => { calls++; return { status: 'AVAILABLE', rate: 33.498, rateDate: ROW.date }; } } });
  assert.deepEqual(await service.holdings('owner'), data);
  assert.equal(calls, 0);
  const result = await service.holdings('owner', { includeFx: 'true' });
  assert.equal(calls, 1);
  assert.equal(result.items[0].displayThb.amounts.totalBuyGross, 1003.27);
  assert.equal(result.items[0].displayThb.costBasis.remainingCost, 669.96);
  assert.equal(result.items[0].displayThb.costBasis.averageCostPerUnit, 334.98);
  assert.equal(result.items[1].displayThb.costBasis.remainingCost, null);
  assert.equal(result.items[1].displayThb.amounts.grossIsComplete, false);
  assert.ok(result.items.slice(2).every(item => item.displayThb === null));
  assert.equal(result.displayThb.moneyTotals.totalBuyGross, 3349.8);
  assert.equal(result.displayThb.remainingCostTotal.isComplete, false);
  assert.equal(result.displayThb.scope, 'ALL_IMPORTED_USD_STOCK_POSITIONS_INCLUDING_CLOSED');
  assert.deepEqual(data, original);
  assert.equal(result.items[0].costBasis[1].remainingCost, 700);
});

test('FX unavailable does not prevent returning holdings and never invents zero conversions', async () => {
  const data = portfolio();
  const service = createInvestmentService({ repository: { holdings: async () => data }, exchangeRates: {
    getRate: async () => { throw new AppError(503, 'FX_RATE_UNAVAILABLE', 'Unavailable'); },
  } });
  const result = await service.holdings('owner', { includeFx: 'true' });
  assert.equal(result.fx.status, 'UNAVAILABLE');
  assert.equal(result.fx.rate, null);
  assert.equal(result.displayThb, null);
  assert.ok(result.items.every(item => item.displayThb === null));
  assert.deepEqual(result.items[0].costBasis, data.items[0].costBasis);
});

test('includeFx rejects ambiguous filters before DB or upstream access', async () => {
  const service = createInvestmentService({ repository: { holdings: async () => assert.fail('DB must not be called') } });
  for (const includeFx of ['1', '', ['true'], true, {}]) {
    await assert.rejects(service.holdings('owner', { includeFx }), { code: 'INVALID_HOLDINGS_FILTER' });
  }
});
