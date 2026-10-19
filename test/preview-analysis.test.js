const test = require('node:test');
const assert = require('node:assert/strict');
const { preparePreview } = require('../src/modules/trades/preview-analysis');
test('analysis sums THB order totals, separates all transaction types and is idempotent', () => {
  const original = {
    orders: [{ transactionType: 'BUY', totalAmount: { foreign: 3, thb: 100 } }, { transactionType: 'BUY', totalAmount: { thb: 50 } }, { transactionType: 'SELL', totalAmount: { thb: 30 } }, { transactionType: 'REWARD', totalAmount: { thb: 999 } }, { transactionType: 'SUBSCRIPTION', totalAmount: 20 }, { transactionType: 'REDEMPTION', totalAmount: 10 }, { transactionType: 'SWITCH_IN', totalAmount: 8 }, { transactionType: 'SWITCH_OUT', totalAmount: 7 }],
    summary: { totalBuy: 155 }, display: { totalBuy: 155 },
    validation: { isValid: false, warnings: [{ code: 'TOTAL_BUY_MISMATCH' }] },
  };
  const result = preparePreview(original);
  assert.deepEqual(result.calculation.investmentTotals, { source: 'ORDER_TOTALS', currency: 'THB', totalBuy: 150, totalSell: 30, totalSubscription: 20, totalRedemption: 10, totalSwitchIn: 8, totalSwitchOut: 7 });
  assert.equal(result.validation.warnings[0].pdfValue, 155);
  assert.equal(result.validation.warnings[0].calculatedValue, 150);
  assert.deepEqual(preparePreview(result), result);
  assert.equal(original.calculation, undefined);
  assert.equal(original.validation.warnings[0].blocking, undefined);
});
test('missing amounts stay null rather than becoming zero, while no orders of a type sums to zero', () => {
  const result = preparePreview({ orders: [{ transactionType: 'BUY', totalAmount: null }], validation: { warnings: [{ code: 'TOTAL_BUY_MISMATCH' }] } });
  assert.equal(result.calculation.investmentTotals.totalBuy, null);
  assert.equal(result.calculation.investmentTotals.totalSell, 0);
  assert.equal(result.validation.warnings[0].pdfValue, null);
  assert.equal(result.validation.warnings[0].difference, null);
  assert.equal(result.validation.warnings[0].blocking, false);
});
