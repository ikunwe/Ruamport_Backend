const test = require('node:test');
const assert = require('node:assert/strict');
const { createAnalyticsService } = require('../src/modules/trades/analytics.service');
const { shiftDate } = require('../src/modules/trades/history-dates');
const now = () => Date.parse('2026-10-26T10:00Z');
const order = (date, type, units, flowAmount, extra = {}) => ({ assetType: 'THAI_STOCK', symbol: 'ASK', exchange: null,
  currency: 'THB', accountNumber: 'test', tradeDate: date, transactionType: type, units, flowAmount, ...extra });
function daily(start, end, fn) {
  const rows = []; for (let date = start; date <= end; date = shiftDate(date, 1)) rows.push({ date, price: fn(date) }); return rows;
}
const result = points => ({ status: 'AVAILABLE', source: 'TEST', points, cacheStatus: 'HIT' });
function fixture(orders, { price = () => 100, benchmark = () => 100, fx = () => 35, data = {} } = {}) {
  const owners = [], calls = [];
  const market = {
    getSeries: async (item, start, end) => { calls.push(item.symbol); return result(daily(start, end, date => price(date, item)).filter(row => row.price !== null)); },
    getIndexSeries: async (id, start, end) => typeof benchmark(id) === 'object' ? benchmark(id)
      : result(daily(start, end, date => benchmark(date, id)).filter(row => row.price !== null)),
    getFxSeries: async (start, end) => fx === null ? { status: 'UNAVAILABLE', errorCode: 'HISTORY_FX_NOT_AVAILABLE' }
      : result(daily(start, end, fx)),
  };
  return { owners, calls, market, service: createAnalyticsService({ now, market,
    repository: { analyticsOrders: async userId => { owners.push(userId); return { orders, ...data }; } } }) };
}

test('gross purchases and partial/full sales at unchanged price do not create gains/losses; reentry and closed assets retained', async () => {
  const orders = [order('2026-10-01', 'BUY', 10, 1000), order('2026-10-05', 'BUY', 10, 1000),
    order('2026-10-06', 'SELL', 5, 500), order('2026-10-10', 'SELL', 15, 1500), order('2026-10-20', 'BUY', 3, 300)];
  const saved = structuredClone(orders), f = fixture(orders);
  const r = await f.service.performance('alice', { range: 'ALL' });
  assert.equal(r.status, 'COMPLETE');
  assert.equal(r.portfolio.cumulativeReturnPercent, 0);
  assert.ok(r.points.every(row => row.portfolioReturnPercent === 0));
  assert.equal(r.points.find(row => row.date === '2026-10-10').marketValueThb, 0);
  assert.equal(r.points.find(row => row.date === '2026-10-05').externalFlowThb, 1000);
  assert.deepEqual(orders, saved); assert.deepEqual(f.owners, ['alice']);
});

test('daily returns geometrically link and reconcile with card/spread; cash flow adjustment uses execution gross', async () => {
  const f = fixture([order('2026-10-01', 'BUY', 10, 1000), order('2026-10-02', 'BUY', 10, 1100),
    order('2026-10-03', 'SELL', 5, 600)], {
    price: date => date < '2026-10-02' ? 100 : date < '2026-10-03' ? 110 : 120,
    benchmark: date => date < '2026-10-02' ? 100 : 105,
  });
  const r = await f.service.performance('owner', { range: 'ALL', benchmarkId: 'SET' });
  assert.equal(r.portfolio.cumulativeReturnPercent, 20);
  assert.equal(r.benchmark.cumulativeReturnPercent, 5);
  assert.equal(r.spreadPercentagePoints, 15);
  assert.equal(r.points.at(-1).portfolioReturnPercent, r.portfolio.cumulativeReturnPercent);
  assert.equal(r.portfolio.feesIncluded, false);
});

test('offshore and US index both include historical FX in THB; category filter isolates all three asset classes', async () => {
  const orders = [order('2026-10-01', 'BUY', 1, 100, { assetType: 'OFFSHORE_STOCK', currency: 'USD', symbol: 'AMD', exchange: 'XNAS' }),
    order('2026-10-01', 'BUY', 10, 1000), order('2026-10-01', 'SUBSCRIPTION', 10, 1000, { assetType: 'MUTUAL_FUND', symbol: 'FUND' })];
  const f = fixture(orders, { fx: date => date < '2026-10-02' ? 30 : 33 });
  const r = await f.service.performance('owner', { range: 'ALL' });
  assert.equal(r.portfolio.cumulativeReturnPercent, 6); // 5000 -> 5300
  assert.equal(r.benchmark.cumulativeReturnPercent, 10);
  const off = await f.service.performance('owner', { range: 'ALL', category: 'OFFSHORE_STOCK' });
  assert.equal(off.portfolio.cumulativeReturnPercent, 10);
  for (const category of ['THAI_STOCK', 'MUTUAL_FUND']) {
    const r = await f.service.performance('owner', { range: 'ALL', category, benchmarkId: 'SET' });
    assert.equal(r.portfolio.cumulativeReturnPercent, 0);
  }
});

test('missing valuation creates permanent cumulative gap; later good observations never silently rebase', async () => {
  const f = fixture([order('2026-10-01', 'BUY', 1, 100)], { price: date => date >= '2026-10-05' && date <= '2026-10-15' ? null : 100 });
  const r = await f.service.performance('owner', { range: 'ALL' });
  assert.equal(r.points.find(row => row.date === '2026-10-11').portfolioReturnPercent, null);
  assert.equal(r.points.at(-1).portfolioReturnPercent, null);
  assert.equal(r.portfolio.cumulativeReturnPercent, null);
  assert.equal(r.benchmark.cumulativeReturnPercent, 0);
  assert.equal(r.comparable, false);
});

test('benchmark failure preserves portfolio and safe retry diagnostics; no missing value becomes a fake tie', async () => {
  const f = fixture([order('2026-08-31', 'BUY', 1, 100)], { benchmark: id => id === 'SP500'
    ? { status: 'UNAVAILABLE', errorCode: 'HISTORY_RATE_LIMITED', limitSource: 'PROVIDER', providerStatus: 429,
      retryAt: '2026-10-26T10:01:00Z' } : 100 });
  const r = await f.service.performance('owner', { range: 'ALL' });
  assert.equal(r.status, 'PARTIAL'); assert.equal(r.portfolio.cumulativeReturnPercent, 0);
  assert.equal(r.benchmark.cumulativeReturnPercent, null); assert.equal(r.spreadPercentagePoints, null);
  assert.equal(r.benchmark.diagnostics.providerStatus, 429);
  const w = await f.service.winRate('owner', { range: '1M' });
  assert.equal(w.markets[0].comparedPeriodCount, 0);
  assert.equal(w.markets[0].winRatePercent, null);
  assert.equal(w.markets.find(row => row.id === 'SET').ties, 1);
});

test('missing FX does not erase THB portfolio, but disables USD comparisons', async () => {
  const r = await fixture([order('2026-10-01', 'BUY', 1, 100)], { fx: null }).service.performance('owner', { range: 'ALL' });
  assert.equal(r.portfolio.cumulativeReturnPercent, 0);
  assert.equal(r.benchmark.cumulativeReturnPercent, null);
  assert.equal(r.status, 'PARTIAL');
});

test('high-point indices such as Nasdaq remain comparable after THB conversion', async () => {
  const f = fixture([order('2026-08-31', 'BUY', 1, 100)], { benchmark: () => 27000 });
  const r = await f.service.performance('owner', { range: 'ALL', benchmarkId: 'NASDAQ_COMPOSITE' });
  assert.equal(r.status, 'COMPLETE'); assert.equal(r.benchmark.cumulativeReturnPercent, 0);
  const w = await f.service.winRate('owner', { range: '1M' });
  assert.equal(w.markets.find(row => row.id === 'NASDAQ_COMPOSITE').ties, 1);
});

test('missing gross and unsupported orders remain incomplete rather than deriving flows from units times price', async () => {
  for (const extra of [{ flowAmount: null }, { collision: true }, { transactionType: 'REWARD' }]) {
    const r = await fixture([order('2026-10-01', 'BUY', 1, 100), order('2026-10-03', 'BUY', 1, 100, extra)])
      .service.performance('owner', { range: 'ALL' });
    assert.equal(r.portfolio.cumulativeReturnPercent, null);
    assert.equal(r.comparable, false);
  }
});

test('balanced same-day fund switches are internal; missing leg/different value cannot be assumed external', async () => {
  const fund = { assetType: 'MUTUAL_FUND', symbol: 'FUND' };
  const orders = [order('2026-10-01', 'SUBSCRIPTION', 10, 1000, fund),
    order('2026-10-03', 'SWITCH_OUT', 10, 1000, fund),
    order('2026-10-03', 'SWITCH_IN', 10, 1000, { ...fund, symbol: 'FUND2' })];
  const r = await fixture(orders).service.performance('owner', { range: 'ALL' });
  assert.equal(r.portfolio.cumulativeReturnPercent, 0);
  for (const changed of [orders.slice(0, 2), orders.map((row, i) => i === 2 ? { ...row, flowAmount: 999 } : row)]) {
    const r = await fixture(changed).service.performance('owner', { range: 'ALL' });
    assert.equal(r.portfolio.cumulativeReturnPercent, null);
    assert.ok(r.issues.includes('ANALYTICS_SWITCH_FLOW_UNMATCHED'));
  }
});

test('calendar periods use prior-day baseline, count only finished full periods, round both returns to 2 decimals', async () => {
  const f = fixture([order('2026-08-31', 'BUY', 1, 100)], {
    price: date => date >= '2026-09-30' ? 90 : 100,
    benchmark: date => date >= '2026-09-30' ? 80 : 100,
  });
  const r = await f.service.winRate('owner', { range: '1M', unit: 'MONTH' });
  const m = r.markets.find(row => row.id === 'SET');
  assert.deepEqual(m.periods.map(row => row.outcome), ['WIN', 'PENDING']); // -10 beats -20
  assert.equal(m.periods[0].startDate, '2026-09-01');
  assert.equal(m.periods[0].baselineDate, '2026-08-31');
  assert.equal(m.wins, 1); assert.equal(m.comparedPeriodCount, 1); assert.equal(m.winRatePercent, 100);
  assert.equal(m.periods[0].portfolioReturnPercent, -10); assert.equal(m.periods[0].benchmarkReturnPercent, -20);
  const tie = await fixture([order('2026-08-31', 'BUY', 1, 100)], {
    price: date => date >= '2026-09-30' ? 101.004 : 100,
    benchmark: date => date >= '2026-09-30' ? 101.003 : 100,
  }).service.winRate('owner', { range: '1M' });
  assert.equal(tie.markets[0].ties, 1);
  for (const market of r.markets) assert.equal(market.comparedPeriodCount, market.wins + market.losses + market.ties);
});

test('initial partial month is compared from inception; a later period with no exposure remains incomplete', async () => {
  const r = await fixture([order('2026-09-10', 'BUY', 1, 100)]).service.winRate('owner', { range: 'ALL' });
  assert.equal(r.markets[0].periods[0].outcome, 'TIE');
  assert.equal(r.markets[0].periods[0].startDate, '2026-09-10');
  assert.equal(r.markets[0].periods[0].isPartialPeriod, true);
  assert.equal(r.markets[0].winRatePercent, 0);
  const f = fixture([order('2026-08-01', 'BUY', 1, 100), order('2026-08-02', 'SELL', 1, 100)]);
  const noExposure = await f.service.winRate('owner', { range: '1M' });
  assert.equal(noExposure.markets[0].periods[0].outcome, 'INCOMPLETE');
});

test('first gross buy is the capital baseline: first-day gain appears in curve/card and index uses the prior observation', async () => {
  const f = fixture([order('2026-09-09', 'BUY', 10, 1000)], {
    price: () => 102, benchmark: date => date >= '2026-09-09' ? 101 : 100,
  });
  const r = await f.service.performance('owner', { range: 'ALL', benchmarkId: 'SET' });
  assert.equal(r.status, 'COMPLETE');
  assert.equal(r.baselineDate, '2026-09-08'); assert.equal(r.comparisonStartDate, '2026-09-09');
  assert.equal(r.points[0].portfolioReturnPercent, 2); assert.equal(r.points[0].dailyReturnPercent, 2);
  assert.equal(r.points[0].benchmarkReturnPercent, 1);
  assert.equal(r.portfolio.cumulativeReturnPercent, 2); assert.equal(r.portfolio.initialCapitalThb, 1000);
  assert.equal(r.portfolio.baselineBasis, 'FIRST_DAY_GROSS_BUYS');
  assert.equal(r.benchmark.baselineObservationDate, '2026-09-08');
  assert.equal(r.spreadPercentagePoints, 1);
});

test('WEEK/MONTH/YEAR first periods start at the true investment day, include its gain, and expose calendar bounds', async () => {
  for (const [unit, first, calendarStart, expectedEnd] of [
    ['WEEK', '2026-09-09', '2026-09-07', '2026-09-13'],
    ['MONTH', '2026-09-09', '2026-09-01', '2026-09-30'],
    ['YEAR', '2025-08-15', '2025-01-01', '2025-12-31'],
  ]) {
    const f = fixture([order(first, 'BUY', 10, 1000)], {
      price: () => 102, benchmark: date => date >= first ? 101 : 100,
    });
    const r = await f.service.winRate('owner', { range: 'ALL', unit });
    const market = r.markets.find(row => row.id === 'SET'), p = market.periods[0];
    assert.equal(p.startDate, first); assert.equal(p.endDate, expectedEnd);
    assert.equal(p.calendarStartDate, calendarStart); assert.equal(p.calendarEndDate, expectedEnd);
    assert.equal(p.isFirstInvestmentPeriod, true); assert.equal(p.isPartialPeriod, true);
    assert.equal(p.baselineBasis, 'FIRST_DAY_GROSS_BUYS'); assert.equal(p.initialCapitalThb, 1000);
    assert.equal(p.portfolioReturnPercent, 2); assert.equal(p.benchmarkReturnPercent, 1);
    assert.equal(p.outcome, 'WIN'); assert.equal(p.comparable, true);
    assert.equal(p.baselineDate, shiftDate(first, -1));
    assert.equal(p.benchmarkBaselineObservationDate, shiftDate(first, -1));
    assert.equal(r.startDate, first);
    assert.equal(market.wins, market.periods.filter(row => row.outcome === 'WIN').length);
    if (unit !== 'YEAR') assert.equal(market.periods[1].isPartialPeriod, false);
    assert.equal(market.periods.at(-1).outcome, 'PENDING');
  }
});

test('starting on a calendar boundary still includes day one but is not labelled partial', async () => {
  const r = await fixture([order('2026-09-01', 'BUY', 10, 1000)], { price: () => 102 })
    .service.winRate('owner', { range: 'ALL', unit: 'MONTH' });
  const p = r.markets[0].periods[0];
  assert.equal(p.startDate, '2026-09-01'); assert.equal(p.isPartialPeriod, false);
  assert.equal(p.isFirstInvestmentPeriod, true); assert.equal(p.portfolioReturnPercent, 2);
});

test('first capital sums native gross buys converted with day-one FX across all categories, without fees', async () => {
  const orders = [order('2026-09-09', 'BUY', 1, 100, { assetType: 'OFFSHORE_STOCK', currency: 'USD', symbol: 'AMD', exchange: 'XNAS', feeIncludeVat: 5 }),
    order('2026-09-09', 'BUY', 1, 100, { feeIncludeVat: 1 }),
    order('2026-09-09', 'SUBSCRIPTION', 1, 100, { assetType: 'MUTUAL_FUND', symbol: 'FUND', feeIncludeVat: 5 })];
  const f = fixture(orders, { price: () => 102, fx: () => 30 });
  const r = await f.service.performance('owner', { range: 'ALL' });
  assert.equal(r.portfolio.initialCapitalThb, 3200); assert.equal(r.points[0].marketValueThb, 3264);
  assert.equal(r.portfolio.cumulativeReturnPercent, 2);
  for (const category of ['OFFSHORE_STOCK', 'THAI_STOCK', 'MUTUAL_FUND']) {
    const result = await f.service.performance('owner', { range: 'ALL', category });
    assert.equal(result.portfolio.initialCapitalThb, category === 'OFFSHORE_STOCK' ? 3000 : 100);
    assert.equal(result.points[0].portfolioReturnPercent, 2);
  }
});

test('missing first-day gross, first-day price, or previous benchmark baseline does not silently start later', async () => {
  const first = '2026-09-09';
  for (const opt of ['gross', 'price', 'benchmark']) {
    const f = fixture([order(first, 'BUY', 10, opt === 'gross' ? null : 1000)], {
      price: date => opt === 'price' && date <= first ? null : 102,
      benchmark: date => opt === 'benchmark' && date < first ? null : 100,
    });
    const p = (await f.service.winRate('owner', { range: 'ALL', unit: 'MONTH' })).markets[0].periods[0];
    assert.equal(p.startDate, first); assert.equal(p.outcome, 'INCOMPLETE');
    assert.equal(p.portfolioReturnPercent, null); assert.equal(p.benchmarkReturnPercent, null);
    const r = await f.service.performance('owner', { range: 'ALL' });
    assert.equal(r.baselineDate, shiftDate(first, -1)); assert.equal(r.comparable, false);
    if (opt !== 'benchmark') assert.equal(r.portfolio.cumulativeReturnPercent, null);
    else assert.equal(r.portfolio.cumulativeReturnPercent, 2);
  }
});

test('request starting after inception keeps a close baseline and never truncates a normal calendar month to the requested day', async () => {
  const f = fixture([order('2026-08-01', 'BUY', 1, 100)], { price: () => 102 });
  const r = await f.service.performance('owner', { range: '1M' });
  assert.equal(r.baselineDate, '2026-09-26'); assert.equal(r.portfolio.baselineBasis, 'DAILY_CLOSE');
  assert.equal(r.portfolio.initialCapitalThb, null); assert.equal(r.points[0].dailyReturnPercent, null);
  assert.equal(r.portfolio.cumulativeReturnPercent, 0);
  const w = await f.service.winRate('owner', { range: '1M', unit: 'MONTH' });
  const p = w.markets[0].periods[0];
  assert.equal(p.startDate, '2026-09-01'); assert.equal(p.isPartialPeriod, false);
  assert.equal(p.isFirstInvestmentPeriod, false); assert.equal(p.baselineBasis, 'PREVIOUS_DAY_CLOSE');
});

test('WEEK is Monday-Sunday, YEAR uses calendar years, and current period is pending even on its end day', async () => {
  const f = fixture([order('2025-12-31', 'BUY', 1, 100)]);
  const weekly = await f.service.winRate('owner', { range: '1M', unit: 'WEEK' });
  for (const p of weekly.markets[0].periods) {
    assert.equal(new Date(p.startDate).getUTCDay(), 1); assert.equal(new Date(p.endDate).getUTCDay(), 0);
  }
  const year = await f.service.winRate('owner', { range: 'ALL', unit: 'YEAR' });
  assert.equal(year.markets[0].periods.at(-1).startDate, '2026-01-01');
  assert.equal(year.markets[0].periods.at(-1).outcome, 'PENDING');
});

test('empty accounts return identities and null rates, validate query before database access', async () => {
  const f = fixture([]);
  assert.equal((await f.service.performance('owner')).status, 'EMPTY');
  const w = await f.service.winRate('owner'); assert.equal(w.status, 'EMPTY');
  assert.equal(w.markets.length, 4); assert.ok(w.markets.every(row => row.winRatePercent === null));
  for (const query of [{ category: ['ALL'] }, { category: 'OTHER' }, { range: ['ALL'] }, { range: '1D' }, { benchmarkId: 'DOW_JONES' }])
    await assert.rejects(f.service.performance('owner', query), error => error.status === 400);
  await assert.rejects(f.service.winRate('owner', { unit: 'DAY' }), { code: 'INVALID_ANALYTICS_UNIT' });
});

test('selected-range return rebases only from same requested baseline, not lifetime gain', async () => {
  const f = fixture([order('2026-08-01', 'BUY', 1, 100)], { price: date => date >= '2026-09-01' ? 200 : 100 });
  const all = await f.service.performance('owner', { range: 'ALL' });
  const month = await f.service.performance('owner', { range: '1M' });
  assert.equal(all.portfolio.cumulativeReturnPercent, 100);
  assert.equal(month.portfolio.cumulativeReturnPercent, 0);
  assert.equal(month.baselineDate, '2026-09-26');
  assert.equal(month.benchmark.baselineObservationDate, month.baselineDate);
});

test('split and reverse split adjust units with prices without inventing cash flows or return', async () => {
  for (const [numerator, denominator, adjustedPrice] of [[10, 1, 10], [1, 5, 500]]) {
    const f = fixture([order('2026-10-01', 'BUY', 10, 1000)]);
    f.market.getSeries = async (_item, start, end) => ({ ...result(daily(start, end, date => date < '2026-10-05' ? 100 : adjustedPrice)),
      corporateActions: [{ type: 'SPLIT', date: '2026-10-05', numerator, denominator }] });
    const r = await f.service.performance('owner', { range: 'ALL' });
    assert.equal(r.status, 'COMPLETE'); assert.equal(r.portfolio.cumulativeReturnPercent, 0);
    assert.equal(r.points.find(row => row.date === '2026-10-05').externalFlowThb, 0);
  }
});

test('zero-capital reentry uses disclosed beginning-flow rule; same-day buys and sells cannot manufacture a denominator', async () => {
  const orders = [order('2026-10-01', 'BUY', 1, 100), order('2026-10-02', 'SELL', 1, 100), order('2026-10-05', 'BUY', 1, 100)];
  const r = await fixture(orders, { price: date => date >= '2026-10-05' ? 110 : 100 }).service.performance('owner', { range: 'ALL' });
  assert.equal(r.portfolio.cumulativeReturnPercent, 10);
  assert.equal(r.portfolio.zeroCapitalEntryTiming, 'BEGINNING_OF_DAY_GROSS_BUYS');
  const invalid = await fixture([...orders, order('2026-10-05', 'SELL', 0.5, 50)])
    .service.performance('owner', { range: 'ALL' });
  assert.equal(invalid.portfolio.cumulativeReturnPercent, null);
  assert.ok(invalid.issues.includes('ANALYTICS_ZERO_CAPITAL_DENOMINATOR'));
});

test('oversized, truncated, invalid trade dates and missing analytics migration fail explicitly', async () => {
  await assert.rejects(fixture([], { data: { truncated: true } }).service.performance('owner'), { code: 'HISTORY_ORDER_LIMIT_EXCEEDED' });
  await assert.rejects(fixture([order(null, 'BUY', 1, 100)]).service.performance('owner'), { code: 'HISTORY_TRADE_DATE_REQUIRED' });
  const service = createAnalyticsService({ repository: { analyticsOrders: async () => null }, market: {}, now });
  await assert.rejects(service.performance('owner'), { code: 'ANALYTICS_STORAGE_UNAVAILABLE' });
});
