// Synthetic owner/orders + real public price, NAV, index and FX observations.
// No Supabase access or writes. Never print tokens, request headers or provider URLs.
// node --use-system-ca --env-file=.env scripts/verification/verify-analytics.cjs
const assert = require('node:assert/strict');
const { createAnalyticsService, sampler } = require('../../src/modules/trades/analytics.service');
const { decimal, multiply, number } = require('../../src/modules/trades/valuation-decimal');
const { createPortfolioHistoryMarket } = require('../../src/modules/trades/portfolio-history-market');
const { createDomesticMarketService } = require('../../src/modules/trades/domestic-market.service');
const { thaiToday, shiftDate } = require('../../src/modules/trades/history-dates');
const { createTradingViewIndexHistoryService, readTradingViewHistory } = require('../../src/modules/trades/tradingview-index-history.service');
(async () => {
  const end = thaiToday(Date.now());
  const start = shiftDate(end, -60);
  let calls = 0;
  let tradingViewLoads = 0;
  const httpStatuses = {};
  const fetchData = async (...args) => {
    calls++;
    const response = await fetch(...args);
    const host = new URL(args[0]).hostname;
    httpStatuses[host] ||= {};
    httpStatuses[host][response.status] = (httpStatuses[host][response.status] || 0) + 1;
    return response;
  };
  const domesticPrices = createDomesticMarketService({ fetchData });
  const thaiIndexHistory = createTradingViewIndexHistoryService({ load: async options => {
    tradingViewLoads++; return readTradingViewHistory(options);
  } });
  const market = createPortfolioHistoryMarket({ domesticPrices, fetchData, thaiIndexHistory });
  const orders = [
    { assetType: 'OFFSHORE_STOCK', symbol: 'NVDA', exchange: 'XNAS', currency: 'USD', units: 2, transactionType: 'BUY', flowAmount: 100 },
    { assetType: 'THAI_STOCK', symbol: 'ASK', currency: 'THB', units: 5, transactionType: 'BUY', flowAmount: 100 },
    { assetType: 'MUTUAL_FUND', symbol: 'KKP US500-UH-E', currency: 'THB', units: 10, transactionType: 'SUBSCRIPTION', flowAmount: 100 },
  ].map(row => ({ ...row, tradeDate: start, accountNumber: 'SYNTHETIC_ONLY' }));
  // Synthetic executions at the first available close/NAV, rounded like PDF gross.
  // Price/NAV history is real; these are not actual user executions.
  for (const row of orders) {
    const result = await market.getSeries(row, shiftDate(start, -14), end);
    const price = sampler(result, row.assetType === 'MUTUAL_FUND' ? 14 : 7)(start).price;
    assert.ok(price > 0);
    row.flowAmount = number(multiply(decimal(row.units), decimal(price)));
  }
  const service = createAnalyticsService({ repository: { analyticsOrders: async () => ({ orders }) }, market });
  const first = await service.performance('synthetic', { range: 'ALL' });
  const winRate = await service.winRate('synthetic', { range: 'ALL', unit: 'MONTH' });
  const indexCoverage = [];
  for (const id of ['SP500', 'NASDAQ_COMPOSITE', 'SET', 'SET50']) {
    const r = await market.getIndexSeries(id, shiftDate(start, -14), end);
    indexCoverage.push({ id, count: r.points.length, first: r.points[0]?.date, last: r.points.at(-1)?.date,
      duplicateDates: r.points.filter((row, i) => r.points.findIndex(p => p.date === row.date) !== i).map(row => row.date) });
  }
  const beforeRepeat = calls;
  const tradingViewBeforeRepeat = tradingViewLoads;
  const repeated = await service.performance('synthetic', { range: 'ALL' });
  const categories = [];
  for (const category of ['OFFSHORE_STOCK', 'THAI_STOCK', 'MUTUAL_FUND']) {
    const r = await service.performance('synthetic', { range: '1M', category, benchmarkId: category === 'OFFSHORE_STOCK' ? 'SP500' : 'SET' });
    categories.push({ category, status: r.status, returnPercent: r.portfolio.cumulativeReturnPercent,
      issues: r.issues, incompleteDateCount: r.points.filter(row => !row.isComplete).length,
      benchmarkDiagnostics: r.benchmark.diagnostics });
  }
  assert.deepEqual(repeated.points, first.points);
  assert.equal(calls - beforeRepeat, 0);
  assert.equal(tradingViewLoads - tradingViewBeforeRepeat, 0);
  assert.equal(first.calculationVersion, 2);
  assert.equal(first.portfolio.baselineBasis, 'FIRST_DAY_GROSS_BUYS');
  assert.ok(first.portfolio.initialCapitalThb > 0);
  assert.equal(first.points[0].dailyReturnPercent, first.points[0].portfolioReturnPercent);
  const p = winRate.markets[0].periods[0];
  assert.equal(p.startDate, start);
  assert.equal(p.isFirstInvestmentPeriod, true);
  console.log(JSON.stringify({ mode: 'SYNTHETIC_ORDERS_REAL_PROVIDERS_NO_DATABASE', status: first.status,
    startDate: first.startDate, endDate: first.endDate, baselineDate: first.baselineDate,
    pointCount: first.points.length, calculationVersion: first.calculationVersion,
    initialCapitalThb: first.portfolio.initialCapitalThb, firstDayReturnPercent: first.points[0].dailyReturnPercent,
    firstPeriod: { startDate: p.startDate, calendarStartDate: p.calendarStartDate,
      isPartialPeriod: p.isPartialPeriod, outcome: p.outcome },
    portfolioReturnPercent: first.portfolio.cumulativeReturnPercent,
    benchmarkReturnPercent: first.benchmark.cumulativeReturnPercent, spreadPercentagePoints: first.spreadPercentagePoints,
    categories, markets: winRate.markets.map(({ id, wins, losses, ties, incompleteCount, pendingCount, comparedPeriodCount, winRatePercent, diagnostics, periods }) =>
      ({ id, wins, losses, ties, incompleteCount, pendingCount, comparedPeriodCount, winRatePercent, diagnostics,
        periodIssues: periods.map(row => ({ startDate: row.startDate, outcome: row.outcome, issues: row.issues })) })),
    issues: first.issues, indexCoverage, totalHttpRequests: calls, tradingViewLoads,
    repeatAndCategoryAdditionalRequests: calls - beforeRepeat,
    repeatAndCategoryAdditionalTradingViewLoads: tradingViewLoads - tradingViewBeforeRepeat,
    httpStatuses }, null, 2));
  if (first.status !== 'COMPLETE' || categories.some(row => row.status !== 'COMPLETE')) process.exitCode = 1;
  if (winRate.markets.some(row => row.comparedPeriodCount === 0 || row.incompleteCount > 0)) process.exitCode = 1;
})().catch(() => { console.error('Analytics verification failed; private/upstream details omitted'); process.exitCode = 1; });
