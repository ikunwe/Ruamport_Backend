const { AppError } = require('../../../shared/errors/app-error');
const { parseDimeOffshoreConfirmation } = require('./dime-parser.service');
const { parseDimeMonthlyStatement } = require('./dime-monthly-statement-parser.service');
const {
  parseDimeMutualFundConfirmation,
} = require('./dime-mutual-fund-confirmation-parser.service');
const {
  parseDimeThaiStockConfirmation,
} = require('./dime-thai-stock-confirmation-parser.service');

function parseDimeDocument(text) {
  if (/DIMETH\s*\d+/i.test(text)) {
    return parseDimeThaiStockConfirmation(text);
  }

  if (/Mutual Fund/i.test(text) && /DIMEMF\s*\d+/i.test(text)) {
    return parseDimeMutualFundConfirmation(text);
  }

  if (/Offshore Securities Account Monthly Statement/i.test(text)) {
    return parseDimeMonthlyStatement(text);
  }

  if (/Confirmation Note|ใบยืนยันการซื้อขาย/i.test(text)) {
    return parseDimeOffshoreConfirmation(text);
  }

  throw new AppError(422, 'DIME_DOCUMENT_UNSUPPORTED', 'The PDF is not a supported Dime document');
}

module.exports = { parseDimeDocument };
