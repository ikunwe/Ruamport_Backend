// Synthetic holdings + real public/provider history. No Supabase access/writes.
// node --use-system-ca --env-file=.env scripts/verification/verify-portfolio-history.cjs
const { createPortfolioHistoryService } = require('../../src/modules/trades/portfolio-history.service');
const { createPortfolioHistoryMarket } = require('../../src/modules/trades/portfolio-history-market');
const { createDomesticMarketService } = require('../../src/modules/trades/domestic-market.service');
const { thaiToday, shiftDate } = require('../../src/modules/trades/history-dates');
(async () => {
  const end = thaiToday(Date.now());
  const start = shiftDate(end, -14);
  let calls = 0;
  const httpStatusCounts = {};
  const fetchData = async (...args) => {
    calls++;
    const response = await fetch(...args);
    const provider = new URL(args[0]).hostname;
    httpStatusCounts[provider] ||= {};
    httpStatusCounts[provider][response.status] = (httpStatusCounts[provider][response.status] || 0) + 1;
    return response;
  };
  const domesticPrices = createDomesticMarketService({ fetchData });
  const market = createPortfolioHistoryMarket({ domesticPrices, fetchData });
  const orders = [
    { assetType: 'OFFSHORE_STOCK', symbol: 'NVDA', exchange: 'XNAS', currency: 'USD', units: 2, transactionType: 'BUY' },
    { assetType: 'THAI_STOCK', symbol: 'ASK', currency: 'THB', units: 5, transactionType: 'BUY' },
    { assetType: 'MUTUAL_FUND', symbol: 'KKP US500-UH-E', currency: 'THB', units: 10, transactionType: 'SUBSCRIPTION' },
  ].map(order => ({ ...order, tradeDate: start, accountNumber: 'SYNTHETIC_TEST_ONLY' }));
  const service = createPortfolioHistoryService({ market, repository: { portfolioOrders: async () => ({ orders }) } });
  const result = await service.get('synthetic-owner', { range: 'ALL' });
  const beforeRepeat = calls;
  const repeated = await service.get('synthetic-owner', { range: 'ALL' });
  const rangeChecks = [];
  for (const range of ['1D', '1W', '1M', '3M', '1Y']) {
    const before = calls;
    const smaller = await service.get('synthetic-owner', { range });
    const expected = result.points.filter(point => point.date >= smaller.startDate);
    rangeChecks.push({ range, status: smaller.status, additionalProviderRequests: calls - before,
      positionCacheStatuses: smaller.positions.map(({ symbol, cacheStatus }) => ({ symbol, cacheStatus })),
      samePointsAsAll: JSON.stringify(smaller.points) === JSON.stringify(expected) });
  }
  const totalsConsistent = result.points.every(point => point.marketValue === null
    || Math.abs(point.byAssetType.reduce((sum, item) => sum + item.marketValue, 0) - point.marketValue) <= 0.02);
  console.log(JSON.stringify({ mode: 'SYNTHETIC_PORTFOLIO_REAL_HISTORY_NO_DATABASE',
    status: result.status, firstDate: result.startDate, endDate: result.endDate, pointCount: result.points.length,
    missingPointCount: result.missingPointCount, positions: result.positions.map(({ assetType, symbol, source, errorCode, reason, limitSource, providerStatus, retryAt, cacheStatus }) =>
      ({ assetType, symbol, source, errorCode, reason, limitSource, providerStatus, retryAt, cacheStatus })),
    firstPoint: result.points[0], lastPoint: result.points.at(-1), totalsConsistent,
    totalProviderRequests: calls, httpStatusCounts, repeatAndRangeAdditionalProviderRequests: calls - beforeRepeat,
    repeatedStatus: repeated.status, rangeChecks }, null, 2));
  if (result.status !== 'COMPLETE' || !totalsConsistent
    || rangeChecks.some(row => row.additionalProviderRequests !== 0 || !row.samePointsAsAll)) process.exitCode = 1;
})().catch(() => { console.error('Historical chart smoke test failed; private/upstream details omitted'); process.exitCode = 1; });
