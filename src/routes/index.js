const express = require('express');

const { healthRouter } = require('../modules/health/health.routes');
const { authRouter } = require('../modules/auth/auth.routes');

const apiRouter = express.Router();

apiRouter.use('/health', healthRouter);
apiRouter.use('/auth', authRouter);

module.exports = { apiRouter };
