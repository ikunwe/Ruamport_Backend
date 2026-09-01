const express = require('express');

const { getHealth } = require('./health.controller');

const healthRouter = express.Router();

healthRouter.get('/', getHealth);

module.exports = { healthRouter };
