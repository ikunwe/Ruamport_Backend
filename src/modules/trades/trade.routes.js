const express = require('express');

const { requireAuth } = require('../../middlewares/auth.middleware');
const { uploadPdf } = require('../../middlewares/pdf-upload.middleware');
const { createPreviewPdf } = require('./trade.controller');
const { createInvestmentService } = require('./investment.service');
const { frankfurterService } = require('./frankfurter.service');

function createTradeRouter({ exchangeRates = frankfurterService, investments = createInvestmentService({ exchangeRates }), authenticate = requireAuth, upload = uploadPdf, preview = createPreviewPdf({ investments }) } = {}) {
  const tradeRouter = express.Router();
  tradeRouter.use(authenticate);
  tradeRouter.use((_request, response, next) => { response.set('Cache-Control', 'no-store'); next(); });
  tradeRouter.post('/upload-preview', upload, preview);
  tradeRouter.post('/import', async (request, response) => response.json(await investments.importMany(request.user.id, request.body)));
  tradeRouter.get('/documents', async (request, response) => response.json(await investments.list(request.user.id, request.query)));
  tradeRouter.get('/documents/:id', async (request, response) => response.json(await investments.get(request.user.id, request.params.id)));
  tradeRouter.get('/transactions', async (request, response) => response.json(await investments.list(request.user.id, request.query, true)));
  tradeRouter.get('/holdings', async (request, response) => response.json(await investments.holdings(request.user.id, request.query)));
  tradeRouter.get('/exchange-rate', async (_request, response) => response.json(await exchangeRates.getRate()));
  return tradeRouter;
}

module.exports = { tradeRouter: createTradeRouter(), createTradeRouter };
