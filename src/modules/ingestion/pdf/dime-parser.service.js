const { AppError } = require('../../../shared/errors/app-error');

const MONEY_TOLERANCE_THB = 0.02;
const THAI_MONTHS = [
  'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม',
];
const TRANSACTION_TYPES = {
  BUY: 'BUY',
  SEL: 'SELL',
  SELL: 'SELL',
  REW: 'REWARD',
  EXC: 'EXERCISE_CALL',
  EXP: 'EXERCISE_PUT',
};

function parseNumber(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const negative = trimmed.startsWith('(') && trimmed.endsWith(')');
  const numeric = Number(trimmed.replace(/[(),]/g, ''));
  if (!Number.isFinite(numeric)) return null;
  return negative ? -numeric : numeric;
}

function parseDmyDate(value) {
  const [day, month, year] = value.split('/').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    return null;
  }

  return date.toISOString().slice(0, 10);
}

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function approximatelyEqual(left, right, tolerance = MONEY_TOLERANCE_THB) {
  return Math.abs(left - right) <= tolerance;
}

function extractEffectiveDate(text) {
  const labelledMatch = text.match(
    /(?<date>\d{2}\/\d{2}\/\d{4})\s*\nเลขที่บัญชี\s*\nAccount No\.?\s*\nวันที่คำสั่งมีผล\s*\nEffective Date/i,
  );
  if (labelledMatch) return parseDmyDate(labelledMatch.groups.date);

  // Dime renders header values before their labels. When spacing differs,
  // the final date before the order-table header is the Effective Date.
  const orderHeaderIndex = text.search(/\nเลขที่คำสั่ง\s*\nOrder ID/i);
  if (orderHeaderIndex < 0) return null;

  const headerDates = [...text.slice(0, orderHeaderIndex).matchAll(/\b\d{2}\/\d{2}\/\d{4}\b/g)];
  const lastHeaderDate = headerDates.at(-1)?.[0];
  return lastHeaderDate ? parseDmyDate(lastHeaderDate) : null;
}

function extractDocumentDetails(text) {
  const match = text.match(
    /(?:^|\n)(?<accountNumber>\d{11})\s*\n(?<documentNumber>\d{16})\s*\n(?<taxInvoiceNumber>DIMEOS\d+)\s*\n(?<issueDate>\d{2}\/\d{2}\/\d{4})(?:\n|$)/i,
  );

  const documentNumber = match?.groups.documentNumber ?? null;

  return {
    type: 'DIME_OFFSHORE_CONFIRMATION_NOTE',
    documentNumber,
    taxInvoiceNumber: match?.groups.taxInvoiceNumber ?? null,
    accountNumber: match?.groups.accountNumber ?? null,
    issueDate: match ? parseDmyDate(match.groups.issueDate) : null,
    effectiveDate: extractEffectiveDate(text),
    deduplicationKey: documentNumber
      ? `DIME_OFFSHORE_CONFIRMATION_NOTE:${documentNumber}`
      : null,
  };
}

function extractDiscountDetails(text) {
  // In some two-page Dime confirmations these values are rendered on page 2,
  // while the rest of the summary values are rendered on page 1. pdf-parse
  // returns the fee-after-discount first, followed by the discount and label.
  const match = text.match(
    /(?:^|\n)(?<feeAfterDiscount>\(?[\d,]+\.\d+\)?)\s*\n(?<discount>\(?[\d,]+\.\d+\)?)\s+Discount\b[\s\S]{0,250}?Total Fee After Discount\b/i,
  );
  if (!match) return null;

  const feeAfterDiscount = parseNumber(match.groups.feeAfterDiscount);
  const discount = parseNumber(match.groups.discount);
  if (feeAfterDiscount === null || discount === null) return null;

  return {
    discount: Math.abs(discount),
    totalFeeAfterDiscountExcludeVat: feeAfterDiscount,
  };
}

function extractOrders(text, tradeDate = extractEffectiveDate(text)) {
  const orderPattern = /(?:^|\n)(?<orderId>\d{6})\s+(?<settlementDate>\d{2}\/\d{2}\/\d{4})\s+(?<side>BUY|SELL|SEL|REW|EXC|EXP)\s+(?<symbol>[A-Z0-9.-]+)\s*\n\[(?<exchange>[A-Z0-9]+)\]\s*\n?(?<units>[\d,.]+)\s+(?<unitPrice>[\d,.]+)\s+(?<currency>[A-Z]{3})\s+(?<values>[\s\S]*?)(?=\n\d{6}\s+\d{2}\/\d{2}\/\d{4}\s+(?:BUY|SELL|SEL|REW|EXC|EXP)|\n\d+\s*\/\s*แผ่นที่|\n--\s*\d+\s+of\s+\d+\s*--|$)/g;
  const orders = [];

  for (const match of text.matchAll(orderPattern)) {
    const values = match.groups.values.match(/\(?\d[\d,]*\.\d+\)?/g)?.map(parseNumber) || [];
    if (values.length < 8) continue;

    const [
      grossForeign,
      feeForeign,
      feeThb,
      withholdingForeign,
      withholdingThb,
      totalForeign,
      totalThb,
      grossThb,
    ] = values;

    orders.push({
      orderId: match.groups.orderId,
      tradeDate,
      settlementDate: parseDmyDate(match.groups.settlementDate),
      transactionCode: match.groups.side,
      transactionType: TRANSACTION_TYPES[match.groups.side],
      symbol: match.groups.symbol,
      exchange: match.groups.exchange,
      units: parseNumber(match.groups.units),
      unitPrice: parseNumber(match.groups.unitPrice),
      currency: match.groups.currency,
      grossAmount: { foreign: grossForeign, thb: grossThb },
      feeIncludeVat: { foreign: feeForeign, thb: feeThb },
      withholdingTax: { foreign: withholdingForeign, thb: withholdingThb },
      totalAmount: { foreign: totalForeign, thb: totalThb },
    });
  }

  return orders;
}

function extractSummary(text) {
  const monthPattern = THAI_MONTHS.join('|');
  const summaryValuesPattern = new RegExp(
    `((?:\\(?[\\d,]+\\.\\d+\\)?\\s*\\n){5,7})\\d{1,2}\\s+(?:${monthPattern})\\s+\\d{4}`,
  );
  const match = text.match(summaryValuesPattern);
  if (!match) return null;

  const values = match[1]
    .trim()
    .split(/\s+/)
    .map(parseNumber)
    .filter((value) => value !== null);

  if (values.length === 5) {
    const [totalBuy, totalSell, totalFeeExcludeVat, withholdingTax, totalVat] = values;
    const discountDetails = extractDiscountDetails(text);
    const hasDiscountSection = /Total Fee After Discount|\bDiscount\b|ส่วนลด/i.test(text);
    return {
      currency: 'THB',
      totalBuy,
      totalSell,
      totalFeeExcludeVat,
      discount: discountDetails?.discount ?? (hasDiscountSection ? null : 0),
      totalFeeAfterDiscountExcludeVat:
        discountDetails?.totalFeeAfterDiscountExcludeVat ?? (hasDiscountSection ? null : totalFeeExcludeVat),
      totalVat,
      withholdingTax,
    };
  }

  if (values.length >= 7) {
    const [
      totalBuy,
      totalSell,
      totalFeeExcludeVat,
      discount,
      totalFeeAfterDiscountExcludeVat,
      totalVat,
      withholdingTax,
    ] = values;
    return {
      currency: 'THB',
      totalBuy,
      totalSell,
      totalFeeExcludeVat,
      discount: Math.abs(discount),
      totalFeeAfterDiscountExcludeVat,
      totalVat,
      withholdingTax,
    };
  }

  return null;
}

function validateParsedDocument(orders, summary) {
  const warnings = [];

  for (const order of orders) {
    const expectedForeignGross = order.units * order.unitPrice;
    if (!approximatelyEqual(expectedForeignGross, order.grossAmount.foreign)) {
      warnings.push({ code: 'ORDER_GROSS_MISMATCH', orderId: order.orderId });
    }

    if (order.transactionType === 'BUY' || order.transactionType === 'SELL') {
      const feeAndTax = order.feeIncludeVat.thb + order.withholdingTax.thb;
      const expectedTotal = order.transactionType === 'SELL'
        ? order.grossAmount.thb - feeAndTax
        : order.grossAmount.thb + feeAndTax;
      if (!approximatelyEqual(expectedTotal, order.totalAmount.thb)) {
        warnings.push({ code: 'ORDER_TOTAL_MISMATCH', orderId: order.orderId });
      }
    }
  }

  if (!summary) {
    warnings.push({ code: 'SUMMARY_NOT_FOUND' });
  } else {
    const orderBuyTotal = roundMoney(orders
      .filter((order) => order.transactionType === 'BUY')
      .reduce((total, order) => total + order.totalAmount.thb, 0));
    const orderSellTotal = roundMoney(orders
      .filter((order) => order.transactionType === 'SELL')
      .reduce((total, order) => total + order.totalAmount.thb, 0));

    const hasOnlyCashTrades = orders.every(
      (order) => order.transactionType === 'BUY' || order.transactionType === 'SELL',
    );
    if (hasOnlyCashTrades) {
      if (!approximatelyEqual(orderBuyTotal, summary.totalBuy)) {
        warnings.push({ code: 'TOTAL_BUY_MISMATCH' });
      }
      if (!approximatelyEqual(orderSellTotal, summary.totalSell)) {
        warnings.push({ code: 'TOTAL_SELL_MISMATCH' });
      }
    }

    if (![summary.totalFeeExcludeVat, summary.discount, summary.totalFeeAfterDiscountExcludeVat].every(Number.isFinite)) {
      warnings.push({ code: 'FEE_DISCOUNT_DETAILS_NOT_FOUND' });
    } else {
      const calculatedFeeAfterDiscount = roundMoney(summary.totalFeeExcludeVat - summary.discount);
      if (!approximatelyEqual(calculatedFeeAfterDiscount, summary.totalFeeAfterDiscountExcludeVat)) {
        warnings.push({ code: 'FEE_AFTER_DISCOUNT_MISMATCH' });
      }
    }
  }

  return { isValid: warnings.length === 0, warnings };
}

function parseDimeOffshoreConfirmation(text) {
  if (!/Confirmation Note|ใบยืนยันการซื้อขาย/i.test(text)) {
    throw new AppError(422, 'NOT_DIME_CONFIRMATION', 'The PDF is not recognized as a Dime confirmation note');
  }

  const document = extractDocumentDetails(text);
  const effectiveDate = document.effectiveDate;
  const orders = extractOrders(text, effectiveDate);
  if (orders.length === 0) {
    throw new AppError(422, 'DIME_ORDERS_NOT_FOUND', 'No Dime trade orders could be extracted from the PDF');
  }

  const summary = extractSummary(text);
  const internalValidation = validateParsedDocument(orders, summary);
  const visibleWarnings = internalValidation.warnings.filter(warning => warning.code !== 'FEE_AFTER_DISCOUNT_MISMATCH');
  const validation = { isValid: visibleWarnings.length === 0, warnings: visibleWarnings };
  const totalFeeIncludeVatAfterDiscount = summary && [summary.totalFeeExcludeVat, summary.discount, summary.totalVat].every(Number.isFinite)
    ? roundMoney(summary.totalFeeExcludeVat - summary.discount + summary.totalVat)
    : null;
  const totalFeesAndTaxes = summary && Number.isFinite(totalFeeIncludeVatAfterDiscount) && Number.isFinite(summary.withholdingTax)
    ? roundMoney(totalFeeIncludeVatAfterDiscount + summary.withholdingTax)
    : null;
  const netCashFlow = summary ? roundMoney(summary.totalSell - summary.totalBuy) : null;
  // Use the PDF's stated net fee, never substitute the independently calculated fee.
  const statedFeeWithVat = summary && [summary.totalFeeAfterDiscountExcludeVat, summary.totalVat].every(Number.isFinite)
    ? roundMoney(summary.totalFeeAfterDiscountExcludeVat + summary.totalVat)
    : null;
  const display = {
    source: 'PDF',
    currency: summary?.currency ?? 'THB',
    totalBuy: summary?.totalBuy ?? null,
    totalSell: summary?.totalSell ?? null,
    totalFeeExcludeVat: summary?.totalFeeExcludeVat ?? null,
    discount: summary?.discount ?? null,
    totalFeeAfterDiscountExcludeVat: summary?.totalFeeAfterDiscountExcludeVat ?? null,
    totalVat: summary?.totalVat ?? null,
    withholdingTax: summary?.withholdingTax ?? null,
    totalFeeIncludeVatAfterDiscount: statedFeeWithVat,
    totalFeesAndTaxes: Number.isFinite(statedFeeWithVat) && Number.isFinite(summary?.withholdingTax)
      ? roundMoney(statedFeeWithVat + summary.withholdingTax)
      : null,
    // These two totals combine stated PDF amounts; they are not printed fields.
    derivedFields: ['totalFeeIncludeVatAfterDiscount', 'totalFeesAndTaxes'],
  };

  return {
    document,
    orders,
    summary,
    display,
    calculation: {
      totalFeeIncludeVatAfterDiscount,
      totalFeesAndTaxes,
      netCashFlow,
      cashFlowType: netCashFlow === null ? null : netCashFlow < 0 ? 'CASH_OUT' : netCashFlow > 0 ? 'CASH_IN' : 'NONE',
    },
    validation,
    diagnostics: { validation: internalValidation },
  };
}

module.exports = {
  parseDimeOffshoreConfirmation,
  // Backward-compatible internal alias; API responses use the offshore-specific type.
  parseDimeConfirmation: parseDimeOffshoreConfirmation,
  extractOrders,
  extractSummary,
  extractDiscountDetails,
  extractDocumentDetails,
  extractEffectiveDate,
  parseNumber,
};
