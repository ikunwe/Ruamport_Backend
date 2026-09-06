const express = require('express');

const { requireAuth } = require('../../middlewares/auth.middleware');
const { uploadPdf } = require('../../middlewares/pdf-upload.middleware');
const { previewPdf } = require('./trade.controller');

const tradeRouter = express.Router();

tradeRouter.post('/upload-preview', requireAuth, uploadPdf, previewPdf);

module.exports = { tradeRouter };
