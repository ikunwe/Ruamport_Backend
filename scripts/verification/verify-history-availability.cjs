// Synthetic request ranges and real public prices; no database or private holdings.
// node --use-system-ca scripts/verification/verify-history-availability.cjs
const { createPortfolioHistoryMarket } = require('../../src/modules/trades/portfolio-history-market');
const { thaiToday, shiftDate } = require('../../src/modules/trades/history-dates');
(async () => {
  const end = thaiToday(Date.now());
  const recentStart = shiftDate(end, -30);
  const allStart = '2020-01-01';
  const results = [];
  for (const symbol of ['SPCX', 'CRWV']) {
    const requests = [];
    const fetchData = async (input, init) => {
      const url = new URL(input);
      const response = await fetch(input, init);
      requests.push({ from: new Date(Number(url.searchParams.get('period1')) * 1000).toISOString().slice(0, 10),
        through: shiftDate(new Date(Number(url.searchParams.get('period2')) * 1000).toISOString().slice(0, 10), -1),
        httpStatus: response.status });
      return response;
    };
    const item = { assetType: 'OFFSHORE_STOCK', symbol, currency: 'USD', exchange: 'XNAS' };
    const market = createPortfolioHistoryMarket({ fetchData });
    const recent = await market.getSeries(item, recentStart, end);
    const beforeAll = requests.length;
    const all = await market.getSeries(item, allStart, end);
    const beforeRepeat = requests.length;
    const repeated = await market.getSeries(item, allStart, end);
    const repeatAdditionalRequests = requests.length - beforeRepeat;
    const coldMarket = createPortfolioHistoryMarket({ fetchData });
    const cold = await coldMarket.getSeries(item, allStart, end);
    const sameAsCold = JSON.stringify(all.points) === JSON.stringify(cold.points);
    const sameRecent = JSON.stringify(all.points.filter(point => point.date >= recentStart)) === JSON.stringify(recent.points);
    let preHistoryOnlyExtension = null;
    if (recent.historyAvailableFrom) {
      const primedMarket = createPortfolioHistoryMarket({ fetchData });
      await primedMarket.getSeries(item, recentStart, end, { eventStart: recent.historyAvailableFrom });
      const beforeExpansion = requests.length;
      const expanded = await primedMarket.getSeries(item, allStart, end);
      preHistoryOnlyExtension = { status: expanded.status, additionalRequests: requests.length - beforeExpansion,
        sameAsCold: JSON.stringify(expanded.points) === JSON.stringify(cold.points) };
    }
    results.push({ symbol, recentStatus: recent.status, allStatus: all.status, coldStatus: cold.status,
      historyAvailableFrom: all.historyAvailableFrom, firstPriceDate: all.points[0]?.date,
      pointCount: all.points.length, allAdditionalRequests: beforeRepeat - beforeAll,
      repeatAdditionalRequests, repeatCacheStatus: repeated.cacheStatus, sameAsCold, sameRecent, preHistoryOnlyExtension, requests });
    if ([recent, all, cold].some(row => row.status !== 'AVAILABLE') || !sameAsCold || !sameRecent
      || repeatAdditionalRequests !== 0 || requests.some(row => row.httpStatus !== 200)
      || preHistoryOnlyExtension?.status !== 'AVAILABLE' || preHistoryOnlyExtension.additionalRequests !== 0
      || !preHistoryOnlyExtension.sameAsCold) process.exitCode = 1;
  }
  console.log(JSON.stringify({ mode: 'REAL_PUBLIC_HISTORY_SHORT_TO_ALL_NO_DATABASE', results }, null, 2));
})().catch(() => { console.error('History availability verification failed; private/upstream details omitted'); process.exitCode = 1; });
