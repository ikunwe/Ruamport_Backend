const express = require('express');

const { requireAuth } = require('../../middlewares/auth.middleware');
const { uploadPdf } = require('../../middlewares/pdf-upload.middleware');
const { createPreviewPdf } = require('./trade.controller');
const { createInvestmentService } = require('./investment.service');
const { frankfurterService } = require('./frankfurter.service');
const { stockPriceService } = require('./stock-price.service');
const { domesticMarketService } = require('./domestic-market.service');
const { marketIndexService } = require('./market-index.service');

function createTradeRouter({ exchangeRates = frankfurterService, marketPrices = stockPriceService,
  domesticPrices = domesticMarketService, marketIndices = marketIndexService,
  investments = createInvestmentService({ exchangeRates, marketPrices, domesticPrices }),
  authenticate = requireAuth, upload = uploadPdf, preview = createPreviewPdf({ investments }) } = {}) {
  const tradeRouter = express.Router();
  tradeRouter.use(authenticate);
  tradeRouter.use((_request, response, next) => { response.set('Cache-Control', 'no-store'); next(); });
  tradeRouter.post('/upload-preview', upload, preview);
  tradeRouter.post('/import', async (request, response) => response.json(await investments.importMany(request.user.id, request.body)));
  tradeRouter.post('/simulate-sale', async (request, response) => response.json(await investments.simulateSale(request.user.id, request.body)));
  tradeRouter.get('/documents', async (request, response) => response.json(await investments.list(request.user.id, request.query)));
  tradeRouter.get('/documents/:id', async (request, response) => response.json(await investments.get(request.user.id, request.params.id)));
  tradeRouter.get('/transactions', async (request, response) => response.json(await investments.list(request.user.id, request.query, true)));
  tradeRouter.get('/holdings', async (request, response) => response.json(await investments.holdings(request.user.id, request.query)));
  tradeRouter.get('/portfolio-history', async (request, response) => response.json(await investments.portfolioHistory(request.user.id, request.query)));
  tradeRouter.get('/analytics/performance', async (request, response) => response.json(await investments.analyticsPerformance(request.user.id, request.query)));
  tradeRouter.get('/analytics/win-rate', async (request, response) => response.json(await investments.analyticsWinRate(request.user.id, request.query)));
  tradeRouter.get('/market-indices', async (_request, response) => response.json(await marketIndices.getIndices()));
  tradeRouter.get('/stocks/:symbol/news', async (request, response) => response.json(await investments.news(request.user.id, request.params.symbol, request.query)));
  tradeRouter.get('/exchange-rate', async (_request, response) => response.json(await exchangeRates.getRate()));
  return tradeRouter;
}

module.exports = { tradeRouter: createTradeRouter(), createTradeRouter };
