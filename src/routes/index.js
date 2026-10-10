const express = require('express');

const { healthRouter } = require('../modules/health/health.routes');
const { authRouter } = require('../modules/auth/auth.routes');
const { tradeRouter } = require('../modules/trades/trade.routes');
const { mailRouter } = require('../modules/mail/mail.routes');

const apiRouter = express.Router();

apiRouter.use('/health', healthRouter);
apiRouter.use('/auth', authRouter);
apiRouter.use('/trades', tradeRouter);
apiRouter.use('/mail', mailRouter);

module.exports = { apiRouter };
