// Real provider observations + SYNTHETIC units with the affected dates from the supplied response.
// No Supabase reads/writes. Not a valuation of the user's actual holdings.
const { createPortfolioHistoryService } = require('../../src/modules/trades/portfolio-history.service');
const { createPortfolioHistoryMarket } = require('../../src/modules/trades/portfolio-history-market');
const { domesticMarketService } = require('../../src/modules/trades/domestic-market.service');
(async () => {
  const stock = (symbol, exchange, transactionType, tradeDate, units = 1) => ({
    assetType: 'OFFSHORE_STOCK', currency: 'USD', symbol, exchange, transactionType, tradeDate, units,
  });
  const orders = [stock('NVDA', 'XNAS', 'BUY', '2025-06-16'),
    stock('NFLX', 'XNAS', 'BUY', '2025-07-17'), stock('NFLX', 'XNAS', 'SELL', '2025-09-10'),
    stock('QS', 'XNYS', 'BUY', '2025-07-18'), stock('QS', 'XNYS', 'SELL', '2025-09-22'),
    { assetType: 'THAI_STOCK', currency: 'THB', symbol: 'ASK', transactionType: 'BUY', tradeDate: '2026-10-15', units: 5 },
    { assetType: 'MUTUAL_FUND', currency: 'THB', symbol: 'KKP US500-UH-E', transactionType: 'SUBSCRIPTION', tradeDate: '2026-10-15', units: 10 },
  ];
  const market = createPortfolioHistoryMarket({ domesticPrices: domesticMarketService });
  const service = createPortfolioHistoryService({ market, repository: { portfolioOrders: async () => ({ orders }) } });
  const result = await service.get('synthetic-only', { range: 'ALL' });
  console.log(JSON.stringify({ mode: 'REAL_HISTORY_SYNTHETIC_QUANTITIES_NO_DATABASE',
    status: result.status, startDate: result.startDate, endDate: result.endDate,
    pointCount: result.points.length, missingPointCount: result.missingPointCount,
    positions: result.positions.map(({ symbol, exchange, source, errorCode, priceBasis, corporateActions, listingTransfer }) =>
      ({ symbol, exchange, source, errorCode, priceBasis, corporateActions, listingTransfer })),
    formerlyMissingWindow: {
      from: '2025-07-17', to: '2025-09-21',
      missing: result.points.filter(p => p.date >= '2025-07-17' && p.date <= '2025-09-21' && !p.isComplete).length,
    } }, null, 2));
  if (result.status !== 'COMPLETE') process.exitCode = 1;
})().catch(() => { console.error('Corporate action history verification failed; sensitive details omitted'); process.exitCode = 1; });
