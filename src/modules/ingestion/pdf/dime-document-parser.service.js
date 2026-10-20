const { AppError } = require('../../../shared/errors/app-error');
const { parseDimeOffshoreConfirmation } = require('./dime-parser.service');
const {
  parseDimeMutualFundConfirmation,
} = require('./dime-mutual-fund-confirmation-parser.service');
const {
  parseDimeThaiStockConfirmation,
} = require('./dime-thai-stock-confirmation-parser.service');

function parseDimeDocument(text) {
  // Keep the monthly parser for future development, but disable public ingestion.
  if (/Monthly Statement|รายงานบัญชีหลักทรัพย์ต่างประเทศประจำเดือน/i.test(text)) {
    throw new AppError(422, 'DIME_MONTHLY_TEMPORARILY_DISABLED', 'Monthly statements are temporarily disabled; upload a Dime confirmation note instead');
  }

  if (/DIMETH\s*\d+/i.test(text)) {
    return parseDimeThaiStockConfirmation(text);
  }

  if (/Mutual Fund/i.test(text) && /DIMEMF\s*\d+/i.test(text)) {
    return parseDimeMutualFundConfirmation(text);
  }

  // A generic confirmation heading is also used by other products (e.g. Gold).
  // Route offshore documents by their own invoice identifier, like MF/TH above.
  if (/DIMEOS\s*\d+/i.test(text)) {
    return parseDimeOffshoreConfirmation(text);
  }

  throw new AppError(422, 'DIME_DOCUMENT_UNSUPPORTED', 'Only Dime offshore stock, Thai stock and mutual fund confirmation notes are supported');
}

module.exports = { parseDimeDocument };
