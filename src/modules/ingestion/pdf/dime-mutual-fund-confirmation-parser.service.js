const { AppError } = require('../../../shared/errors/app-error');

const TRANSACTION_TYPES = {
  SUB: 'SUBSCRIPTION',
  RED: 'REDEMPTION',
  SWI: 'SWITCH_IN',
  SWO: 'SWITCH_OUT',
};

function parseNumber(value) {
  if (typeof value !== 'string') return null;
  const number = Number(value.trim().replace(/[(),]/g, ''));
  return Number.isFinite(number) ? number : null;
}

function parseDmyDate(value) {
  if (!value) return null;
  const [day, month, year] = value.split('/').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) return null;
  return date.toISOString().slice(0, 10);
}

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function extractDocument(text) {
  const match = text.match(
    /(?:^|\n)(?<accountNumber>\d{13,16})\s*\n(?<documentNumber>DN\s*\d+)\s*\n(?<taxInvoiceNumber>DIMEMF\d+)\s*\n(?<issueDate>\d{2}\/\d{2}\/\d{4})/i,
  );
  const effectiveDateMatch = text.match(
    /(?<date>\d{2}\/\d{2}\/\d{4})\s*\nเลขที่บัญชี\s*\nAccount No\.?\s*\nวันที่คำสั่งมีผล\s*\nEffective Date/i,
  );
  const documentNumber = match?.groups.documentNumber.replace(/\s+/g, ' ').trim() ?? null;

  return {
    type: 'DIME_MUTUAL_FUND_CONFIRMATION_NOTE',
    documentNumber,
    taxInvoiceNumber: match?.groups.taxInvoiceNumber ?? null,
    accountNumber: match?.groups.accountNumber ?? null,
    issueDate: match ? parseDmyDate(match.groups.issueDate) : null,
    effectiveDate: effectiveDateMatch ? parseDmyDate(effectiveDateMatch.groups.date) : null,
    deduplicationKey: documentNumber
      ? `DIME_MUTUAL_FUND_CONFIRMATION_NOTE:${documentNumber.replace(/\s+/g, '-')}`
      : null,
  };
}

function extractOrders(text, tradeDate) {
  const pattern = /(?:^|\n)(?<orderId>\d{16})\s+(?<code>SUB|RED|SWI|SWO)\s+(?<fundName>[^\n]+?)\s+(?<units>[\d,.]+)\s+(?<feeIncludeVat>[\d,.]+)\s+(?<totalAmount>[\d,.]+)\s+(?<navPerUnit>[\d,.]+)(?:\n|$)/g;

  return [...text.matchAll(pattern)].map((match) => ({
    orderId: match.groups.orderId,
    tradeDate,
    transactionCode: match.groups.code,
    transactionType: TRANSACTION_TYPES[match.groups.code],
    fundName: match.groups.fundName.trim(),
    units: parseNumber(match.groups.units),
    navPerUnit: parseNumber(match.groups.navPerUnit),
    currency: 'THB',
    totalAmount: parseNumber(match.groups.totalAmount),
    feeIncludeVat: parseNumber(match.groups.feeIncludeVat),
  }));
}

function extractSummary(text) {
  const subscription = text.match(
    /Total Subscription[\s\S]{0,1600}?\n(?<value>[\d,]+\.\d+)\s*\nThe above transaction/i,
  );
  const switchIn = text.match(/(?<value>[\d,]+\.\d+)\s*\nรวมมูลค่าสับเปลี่ยนเข้า\s*\nTotal Switch in/i);
  const redemption = text.match(/(?<value>[\d,]+\.\d+)\s*\nรวมมูลค่าขาย\s*\nTotal Redemption/i);
  const switchOut = text.match(/(?<value>[\d,]+\.\d+)\s*\nรวมมูลค่าสับเปลี่ยนออก\s*\nTotal Switch out/i);
  const fee = text.match(/(?<value>[\d,]+\.\d+)\s*\nค่าธรรมเนียมไม่รวมภาษีมูลค่าเพิ่ม\s*\nTotal Fee \(Exclude VAT\)/i);
  const vat = text.match(/(?<value>[\d,]+\.\d+)\s*\nภาษีมูลค่าเพิ่ม\s*\nTotal Vat/i);
  const brokerage = text.match(/(?<value>[\d,]+\.\d+)\s*\nค่าใช้จ่ายในการซื้อขายหลักทรัพย์\s*\nBrokerage Expense paid to Fund/i);

  if (!subscription || !switchIn || !redemption || !switchOut || !fee || !vat || !brokerage) {
    return null;
  }

  const totalFeeExcludeVat = parseNumber(fee.groups.value);
  const totalVat = parseNumber(vat.groups.value);
  return {
    currency: 'THB',
    totalSubscription: parseNumber(subscription.groups.value),
    totalSwitchIn: parseNumber(switchIn.groups.value),
    totalRedemption: parseNumber(redemption.groups.value),
    totalSwitchOut: parseNumber(switchOut.groups.value),
    totalFeeExcludeVat,
    totalVat,
    totalFeeIncludeVat: roundMoney(totalFeeExcludeVat + totalVat),
    brokerageExpensePaidToFund: parseNumber(brokerage.groups.value),
  };
}

function validate(orders, summary) {
  const warnings = [];
  if (orders.length === 0) warnings.push({ code: 'MUTUAL_FUND_ORDERS_NOT_FOUND' });
  if (!summary) warnings.push({ code: 'MUTUAL_FUND_SUMMARY_NOT_FOUND' });

  for (const order of orders) {
    if (Math.abs((order.units * order.navPerUnit) - order.totalAmount) > 0.02) {
      warnings.push({ code: 'MUTUAL_FUND_ORDER_TOTAL_MISMATCH', orderId: order.orderId });
    }
  }

  if (summary) {
    const orderFeeTotal = roundMoney(orders.reduce((sum, order) => sum + order.feeIncludeVat, 0));
    if (Math.abs(orderFeeTotal - summary.totalFeeIncludeVat) > 0.02) {
      warnings.push({ code: 'MUTUAL_FUND_FEE_TOTAL_MISMATCH' });
    }

    const mappings = [
      ['SUBSCRIPTION', 'totalSubscription', 'MUTUAL_FUND_SUBSCRIPTION_TOTAL_MISMATCH'],
      ['REDEMPTION', 'totalRedemption', 'MUTUAL_FUND_REDEMPTION_TOTAL_MISMATCH'],
      ['SWITCH_IN', 'totalSwitchIn', 'MUTUAL_FUND_SWITCH_IN_TOTAL_MISMATCH'],
      ['SWITCH_OUT', 'totalSwitchOut', 'MUTUAL_FUND_SWITCH_OUT_TOTAL_MISMATCH'],
    ];
    for (const [type, field, code] of mappings) {
      const orderTotal = roundMoney(orders
        .filter((order) => order.transactionType === type)
        .reduce((sum, order) => sum + order.totalAmount, 0));
      if (Math.abs(orderTotal - summary[field]) > 0.02) warnings.push({ code });
    }
  }

  return { isValid: warnings.length === 0, warnings };
}

function parseDimeMutualFundConfirmation(text) {
  if (!/Mutual Fund/i.test(text) || !/DIMEMF\s*\d+/i.test(text)) {
    throw new AppError(
      422,
      'NOT_DIME_MUTUAL_FUND_CONFIRMATION',
      'The PDF is not a Dime mutual fund confirmation note',
    );
  }

  const document = extractDocument(text);
  const orders = extractOrders(text, document.effectiveDate);
  if (orders.length === 0) {
    throw new AppError(422, 'MUTUAL_FUND_ORDERS_NOT_FOUND', 'No mutual fund orders could be extracted');
  }
  const summary = extractSummary(text);
  const netCashFlow = summary
    ? roundMoney(summary.totalRedemption - summary.totalSubscription)
    : null;

  return {
    document,
    orders,
    summary,
    calculation: {
      netCashFlow,
      cashFlowType: netCashFlow === null
        ? null
        : netCashFlow < 0 ? 'CASH_OUT' : netCashFlow > 0 ? 'CASH_IN' : 'NONE',
    },
    validation: validate(orders, summary),
  };
}

module.exports = {
  parseDimeMutualFundConfirmation,
  extractDocument,
  extractOrders,
  extractSummary,
};
