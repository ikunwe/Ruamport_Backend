const round = value => Math.round((value + Number.EPSILON) * 100) / 100;
const FIELDS = {
  BUY: 'totalBuy', SELL: 'totalSell', SUBSCRIPTION: 'totalSubscription',
  REDEMPTION: 'totalRedemption', SWITCH_IN: 'totalSwitchIn', SWITCH_OUT: 'totalSwitchOut',
};

// Reusable for newly parsed previews and old cached previews: never overwrite
// the document's summary/display or the original per-order amounts.
function preparePreview(preview) {
  const orders = preview.orders || [];
  const totals = { source: 'ORDER_TOTALS', currency: 'THB' };
  for (const [type, field] of Object.entries(FIELDS)) {
    const amounts = orders.filter(order => order.transactionType === type)
      .map(order => typeof order.totalAmount === 'object' ? order.totalAmount?.thb : order.totalAmount);
    totals[field] = amounts.every(Number.isFinite) ? round(amounts.reduce((sum, amount) => sum + amount, 0)) : null;
  }
  const warningFields = {
    TOTAL_BUY_MISMATCH: 'totalBuy', TOTAL_SELL_MISMATCH: 'totalSell',
    THAI_STOCK_TOTAL_BUY_MISMATCH: 'totalBuy', THAI_STOCK_TOTAL_SELL_MISMATCH: 'totalSell',
    MUTUAL_FUND_SUBSCRIPTION_TOTAL_MISMATCH: 'totalSubscription',
    MUTUAL_FUND_REDEMPTION_TOTAL_MISMATCH: 'totalRedemption',
    MUTUAL_FUND_SWITCH_IN_TOTAL_MISMATCH: 'totalSwitchIn', MUTUAL_FUND_SWITCH_OUT_TOTAL_MISMATCH: 'totalSwitchOut',
  };
  const warnings = (preview.validation?.warnings || []).map(warning => {
    const field = warningFields[warning.code];
    if (!field) return { ...warning, blocking: false };
    const calculatedValue = totals[field];
    const pdfValue = preview.summary?.[field] ?? null;
    return { ...warning, blocking: false, field, currency: 'THB', calculatedValue, pdfValue,
      difference: Number.isFinite(calculatedValue) && Number.isFinite(pdfValue) ? round(calculatedValue - pdfValue) : null,
      message: 'ยอดรวมจากรายการที่อ่านได้ไม่ตรงกับยอดสรุปใน PDF คุณยังสามารถยืนยันบันทึกได้',
    };
  });
  return {
    ...preview,
    calculation: { ...preview.calculation, investmentTotals: totals },
    validation: { ...preview.validation, warnings, blocksImport: false },
  };
}
module.exports = { preparePreview };
