const { AppError } = require('../../../shared/errors/app-error');

const TRANSACTION_TYPES = {
  BUY: 'BUY',
  SEL: 'SELL',
  SELL: 'SELL',
  REW: 'REWARD',
};

function parseNumber(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const negative = trimmed.startsWith('(') && trimmed.endsWith(')');
  const number = Number(trimmed.replace(/[(),]/g, ''));
  if (!Number.isFinite(number)) return null;
  return negative ? -number : number;
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
    /(?:^|\n)(?<accountNumber>\d{8,12})\s*\n(?<documentNumber>TH\d+)\s*\n(?<taxInvoiceNumber>DIMETH\d+)\s*\n(?<issueDate>\d{2}\/\d{2}\/\d{4})/i,
  );
  const effectiveDateMatch = text.match(
    /(?<date>\d{2}\/\d{2}\/\d{4})\s*\nเลขที่บัญชี\s*\nAccount No\.?\s*\nวันที่ซื้อขาย\s*\nEffective Date/i,
  );
  const documentNumber = match?.groups.documentNumber ?? null;

  return {
    type: 'DIME_THAI_STOCK_CONFIRMATION_NOTE',
    documentNumber,
    taxInvoiceNumber: match?.groups.taxInvoiceNumber ?? null,
    accountNumber: match?.groups.accountNumber ?? null,
    issueDate: match ? parseDmyDate(match.groups.issueDate) : null,
    effectiveDate: effectiveDateMatch ? parseDmyDate(effectiveDateMatch.groups.date) : null,
    deduplicationKey: documentNumber
      ? `DIME_THAI_STOCK_CONFIRMATION_NOTE:${documentNumber}`
      : null,
  };
}

function extractOrders(text, tradeDate) {
  const pattern = /(?:^|\n)(?<orderId>\d{12})\s+(?<code>BUY|SELL|SEL|REW)\s+(?<symbol>[A-Z0-9.-]+)\s+(?<units>[\d,.]+)\s+(?<feeExcludeVat>[\d,.]+)\s+(?<totalAmount>[\d,.]+)\s+(?<pricePerShare>[\d,.]+)\s+(?<settlementDate>\d{2}\/\d{2}\/\d{4})\s+(?<grossAmount>[\d,.]+)\s+(?<vat>[\d,.]+)(?:\n|$)/g;

  return [...text.matchAll(pattern)].map((match) => ({
    orderId: match.groups.orderId,
    tradeDate,
    settlementDate: parseDmyDate(match.groups.settlementDate),
    transactionCode: match.groups.code,
    transactionType: TRANSACTION_TYPES[match.groups.code],
    symbol: match.groups.symbol,
    units: parseNumber(match.groups.units),
    pricePerShare: parseNumber(match.groups.pricePerShare),
    currency: 'THB',
    grossAmount: parseNumber(match.groups.grossAmount),
    feeExcludeVat: parseNumber(match.groups.feeExcludeVat),
    vat: parseNumber(match.groups.vat),
    totalAmount: parseNumber(match.groups.totalAmount),
  }));
}

function extractSummary(text) {
  const totalBuy = text.match(/(?<value>[\d,]+\.\d+)\s*\nThe above transaction[\s\S]*?\n(?<totalSell>[\d,]+\.\d+)\s*\nรวมมูลค่าขาย \(THB\)\s*\nTotal Sell/i);
  const fee = text.match(/(?<value>[\d,]+\.\d+)\s*\nค่าธรรมเนียมไม่รวมภาษีมูลค่าเพิ่ม\s*\nTotal Fee \(Exclude VAT\)/i);
  const vat = text.match(/(?<value>[\d,]+\.\d+)\s*\nภาษีมูลค่าเพิ่ม \(THB\)\s*\nTotal Vat/i);
  const netCustomer = text.match(
    /(?<value>[\d,]+\.\d+)\s*\nลูกค้า[^\n]*สุทธิ\s*\nNet Customer (?<direction>Paid|Received)/i,
  );
  if (!totalBuy || !fee || !vat || !netCustomer) return null;

  return {
    currency: 'THB',
    totalBuy: parseNumber(totalBuy.groups.value),
    totalSell: parseNumber(totalBuy.groups.totalSell),
    totalFeeExcludeVat: parseNumber(fee.groups.value),
    totalVat: parseNumber(vat.groups.value),
    netCustomerAmount: parseNumber(netCustomer.groups.value),
    netCustomerDirection: netCustomer.groups.direction.toUpperCase(),
  };
}

function validate(orders, summary) {
  const warnings = [];
  if (!summary) warnings.push({ code: 'THAI_STOCK_SUMMARY_NOT_FOUND' });

  for (const order of orders) {
    if (Math.abs((order.units * order.pricePerShare) - order.grossAmount) > 0.02) {
      warnings.push({ code: 'THAI_STOCK_ORDER_GROSS_MISMATCH', orderId: order.orderId });
    }
    if (order.transactionType === 'BUY' || order.transactionType === 'SELL') {
      const charges = order.feeExcludeVat + order.vat;
      const expectedTotal = order.transactionType === 'BUY'
        ? order.grossAmount + charges
        : order.grossAmount - charges;
      if (Math.abs(expectedTotal - order.totalAmount) > 0.02) {
        warnings.push({ code: 'THAI_STOCK_ORDER_TOTAL_MISMATCH', orderId: order.orderId });
      }
    }
  }

  if (summary) {
    const hasOnlyCashTrades = orders.every(
      (order) => order.transactionType === 'BUY' || order.transactionType === 'SELL',
    );
    if (hasOnlyCashTrades) {
      const buyTotal = roundMoney(orders
        .filter((order) => order.transactionType === 'BUY')
        .reduce((sum, order) => sum + order.totalAmount, 0));
      const sellTotal = roundMoney(orders
        .filter((order) => order.transactionType === 'SELL')
        .reduce((sum, order) => sum + order.totalAmount, 0));
      if (Math.abs(buyTotal - summary.totalBuy) > 0.02) {
        warnings.push({ code: 'THAI_STOCK_TOTAL_BUY_MISMATCH' });
      }
      if (Math.abs(sellTotal - summary.totalSell) > 0.02) {
        warnings.push({ code: 'THAI_STOCK_TOTAL_SELL_MISMATCH' });
      }
    }
  }

  return { isValid: warnings.length === 0, warnings };
}

function parseDimeThaiStockConfirmation(text) {
  if (!/DIMETH\s*\d+/i.test(text)) {
    throw new AppError(
      422,
      'NOT_DIME_THAI_STOCK_CONFIRMATION',
      'The PDF is not a Dime Thai stock confirmation note',
    );
  }

  const document = extractDocument(text);
  const orders = extractOrders(text, document.effectiveDate);
  if (orders.length === 0) {
    throw new AppError(422, 'THAI_STOCK_ORDERS_NOT_FOUND', 'No Thai stock orders could be extracted');
  }
  const summary = extractSummary(text);
  const netCashFlow = summary ? roundMoney(summary.totalSell - summary.totalBuy) : null;

  return {
    document,
    orders,
    summary,
    calculation: {
      totalFeesAndTaxes: summary
        ? roundMoney(summary.totalFeeExcludeVat + summary.totalVat)
        : null,
      netCashFlow,
      cashFlowType: netCashFlow === null
        ? null
        : netCashFlow < 0 ? 'CASH_OUT' : netCashFlow > 0 ? 'CASH_IN' : 'NONE',
    },
    validation: validate(orders, summary),
  };
}

module.exports = {
  parseDimeThaiStockConfirmation,
  extractDocument,
  extractOrders,
  extractSummary,
};
