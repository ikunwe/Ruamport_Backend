// Real public Yahoo prices, synthetic orders and constant test FX=1 only.
// No database/user portfolio access. node --use-system-ca scripts/verification/verify-history-split-cache.cjs
const { createPortfolioHistoryMarket } = require('../../src/modules/trades/portfolio-history-market');
const { createPortfolioHistoryService } = require('../../src/modules/trades/portfolio-history.service');
const { shiftDate, thaiToday } = require('../../src/modules/trades/history-dates');
(async () => {
  const clock = Date.now();
  const end = thaiToday(clock);
  const results = [];
  for (const [symbol, actionDate] of [['NFLX', '2025-11-17'], ['SQQQ', '2025-11-20']]) {
    const item = { assetType: 'OFFSHORE_STOCK', symbol, exchange: 'XNAS', currency: 'USD' };
    const tradeDate = shiftDate(actionDate, -3);
    const requests = [];
    const makeMarket = () => createPortfolioHistoryMarket({ now: () => clock, fetchData: async (input, init) => {
      const url = new URL(input);
      const response = await fetch(input, init);
      requests.push({ from: new Date(Number(url.searchParams.get('period1')) * 1000).toISOString().slice(0, 10),
        through: shiftDate(new Date(Number(url.searchParams.get('period2')) * 1000).toISOString().slice(0, 10), -1),
        httpStatus: response.status });
      return response;
    } });
    const warmMarket = makeMarket();
    const short = await warmMarket.getSeries(item, actionDate, end);
    const orders = [{ ...item, transactionType: 'BUY', tradeDate, units: 100 },
      { ...item, transactionType: 'SELL', tradeDate: shiftDate(actionDate, 1), units: 1 }];
    const fx = async (start, end) => {
      const points = [];
      for (let date = start; date <= end; date = shiftDate(date, 1)) points.push({ date, price: 1 });
      return { status: 'AVAILABLE', source: 'SYNTHETIC_TEST_FX', points };
    };
    const makeChart = market => createPortfolioHistoryService({ now: () => clock,
      repository: { portfolioOrders: async () => ({ orders }) },
      market: { getSeries: market.getSeries, getFxSeries: fx } });
    const warmChart = makeChart(warmMarket);
    const expanded = await warmChart.get('synthetic-old-holder', { range: 'ALL' });
    const coldMarket = makeMarket();
    const cold = await makeChart(coldMarket).get('synthetic-old-holder', { range: 'ALL' });
    const expandedPrices = await warmMarket.getSeries(item, tradeDate, end);
    const coldPrices = await coldMarket.getSeries(item, tradeDate, end);
    const differingPriceDates = expandedPrices.points.filter(point =>
      coldPrices.points.find(other => other.date === point.date)?.price !== point.price).map(point => point.date);
    const differingValueDates = expanded.points.filter((point, index) => point.marketValue !== cold.points[index]?.marketValue).map(point => point.date);
    const beforeRepeat = requests.length;
    for (const range of ['1D', '1W', '1M', 'ALL']) await warmChart.get('synthetic-old-holder', { range });
    const repeatAdditionalRequests = requests.length - beforeRepeat;
    results.push({ symbol, splitEvents: short.corporateActions, expandedStatus: expanded.status, coldStatus: cold.status,
      expandedPreSplitPrice: expandedPrices.points.find(point => point.date === tradeDate),
      coldPreSplitPrice: coldPrices.points.find(point => point.date === tradeDate), pointCount: expanded.points.length,
      differingPriceDates, differingValueDates, sameFullPoints: JSON.stringify(expanded.points) === JSON.stringify(cold.points),
      repeatAdditionalRequests, requests });
    if (expanded.status !== 'COMPLETE' || cold.status !== 'COMPLETE' || differingPriceDates.length || differingValueDates.length
      || repeatAdditionalRequests !== 0 || requests.some(row => row.httpStatus !== 200)) process.exitCode = 1;
  }
  console.log(JSON.stringify({ mode: 'REAL_PRICES_SYNTHETIC_ORDERS_AND_FX_NO_DATABASE', results }, null, 2));
})().catch(() => { console.error('Split/cache verification failed; private/upstream details omitted'); process.exitCode = 1; });
