const { AppError } = require('../../../shared/errors/app-error');

const ENGLISH_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function parseNumber(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const negative = trimmed.startsWith('(') && trimmed.endsWith(')');
  const numeric = Number(trimmed.replace(/[(),+%]/g, ''));
  if (!Number.isFinite(numeric)) return null;
  return negative ? -numeric : numeric;
}

function parseSignedNumber(sign, value) {
  const number = parseNumber(value);
  if (number === null) return null;
  return sign === '-' ? -Math.abs(number) : Math.abs(number);
}

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function parseStatementPeriod(text) {
  const monthPattern = ENGLISH_MONTHS.join('|');
  const match = text.match(new RegExp(`(?:${monthPattern})\\s+(?<year>\\d{4})`, 'i'));
  if (!match) return null;

  const monthName = match[0].replace(/\s+\d{4}$/, '');
  const month = ENGLISH_MONTHS.findIndex((item) => item.toLowerCase() === monthName.toLowerCase()) + 1;
  return `${match.groups.year}-${String(month).padStart(2, '0')}`;
}

function parseAsOfAndExchangeRate(text) {
  const match = text.match(
    /As of (?<day>\d{1,2}) (?<month>[A-Za-z]+) (?<year>\d{4})\s+1 USD = (?<rate>[\d,.]+) THB/i,
  );
  if (!match) return null;

  const month = ENGLISH_MONTHS.findIndex(
    (item) => item.toLowerCase() === match.groups.month.toLowerCase(),
  ) + 1;
  if (month < 1) return null;

  return {
    asOfDate: `${match.groups.year}-${String(month).padStart(2, '0')}-${String(match.groups.day).padStart(2, '0')}`,
    exchangeRate: parseNumber(match.groups.rate),
  };
}

function parseOverview(text) {
  const portfolioMatch = text.match(
    /(?<usd>[\d,]+\.\d+) USD\s*\nมูลค่าเงินลงทุนรวม\s*\/\s*Total Balance\s*\n≈\s*(?<thb>[\d,]+\.\d+) THB/i,
  );
  const cashMatch = text.match(
    /ยอดเงินคงเหลือในบัญชี\s*\/\s*Cash Balance\s*\n(?<usd>[\d,]+\.\d+) USD\s*\n≈\s*(?<thb>[\d,]+\.\d+) THB/i,
  );
  const returnMatch = text.match(
    /≈\s*(?<thb>[\d,]+\.\d+) THB\s+(?<percentSign>[+-])\s*(?<percentage>[\d,.]+)%\s*\((?<usdSign>[+-])\s*(?<usd>[\d,.]+) USD\)/i,
  );
  if (!portfolioMatch || !cashMatch || !returnMatch) return null;

  const portfolioUsd = parseNumber(portfolioMatch.groups.usd);
  const portfolioThb = parseNumber(portfolioMatch.groups.thb);
  const cashUsd = parseNumber(cashMatch.groups.usd);
  const cashThb = parseNumber(cashMatch.groups.thb);

  return {
    portfolioValue: { usd: portfolioUsd, thb: portfolioThb },
    cashBalance: { usd: cashUsd, thb: cashThb },
    totalAccountValue: {
      usd: roundMoney(portfolioUsd + cashUsd),
      thb: roundMoney(portfolioThb + cashThb),
      derived: true,
    },
    investmentReturn: {
      percentage: parseSignedNumber(returnMatch.groups.percentSign, returnMatch.groups.percentage),
      usd: parseSignedNumber(returnMatch.groups.usdSign, returnMatch.groups.usd),
      thb: parseSignedNumber(returnMatch.groups.percentSign, returnMatch.groups.thb),
      includesDividends: false,
    },
  };
}

function parseAllocations(text) {
  const allocationSection = text.match(
    /Allocation Group by Sector(?<content>[\s\S]*?)(?:\n\d+\s*\/\s*หน้าที่|\n--\s*\d+\s+of\s+\d+\s*--)/i,
  )?.groups.content || '';
  const commonStockMatch = text.match(
    /Allocation Group by Sector[\s\S]{0,180}?(?<usd>[\d,]+\.\d+) USD\s*\n≈\s*(?<thb>[\d,]+\.\d+) THB\s*\n(?<percentage>[\d,.]+)%/i,
  );
  const pattern = /\n(?<name>Consumer Cyclical|Industrials|Technology|Communication Services)\s*\n(?<usd>[\d,]+\.\d+) USD\s*\n≈\s*(?<thb>[\d,]+\.\d+) THB\s*\n(?<percentage>[\d,.]+)%/gi;
  const allocations = [...allocationSection.matchAll(pattern)].map((match) => ({
    name: match.groups.name,
    allocationPercentage: parseNumber(match.groups.percentage),
    marketValue: {
      usd: parseNumber(match.groups.usd),
      thb: parseNumber(match.groups.thb),
    },
  }));

  return {
    assetClasses: commonStockMatch ? [{
      type: 'COMMON_STOCK',
      name: 'Common Stock',
      allocationPercentage: parseNumber(commonStockMatch.groups.percentage),
      marketValue: {
        usd: parseNumber(commonStockMatch.groups.usd),
        thb: parseNumber(commonStockMatch.groups.thb),
      },
    }] : [],
    sectors: allocations,
  };
}

function parseHoldings(text) {
  const investmentSection = text.match(
    /รายละเอียดการลงทุน\s*\/\s*Investment Information(?<content>[\s\S]*?)(?:\nรวม\s+[\d,.]+%|\nกรุณาตรวจสอบ)/i,
  )?.groups.content || '';
  const pattern = /(?:^|\n)(?<symbol>[A-Z][A-Z0-9.-]+)\s*\n(?<name>[^\n]+)\s*\n(?<allocation>[\d,.]+)%\s+(?<shares>[\d,.]+)\s+(?<averageCost>[\d,.]+)\s+(?<price>[\d,.]+)\s+(?<returnPercentSign>[+-])\s*(?<returnPercent>[\d,.]+)%\s+(?<returnSign>[+-])\s*(?<totalReturn>[\d,.]+)\s+(?<marketValue>[\d,.]+)/g;

  return [...investmentSection.matchAll(pattern)].map((match) => ({
    symbol: match.groups.symbol,
    name: match.groups.name,
    assetType: 'COMMON_STOCK',
    currency: 'USD',
    allocationPercentage: parseNumber(match.groups.allocation),
    shares: parseNumber(match.groups.shares),
    averageCost: parseNumber(match.groups.averageCost),
    marketPrice: parseNumber(match.groups.price),
    totalReturnPercentage: parseSignedNumber(
      match.groups.returnPercentSign,
      match.groups.returnPercent,
    ),
    totalReturn: parseSignedNumber(match.groups.returnSign, match.groups.totalReturn),
    marketValue: parseNumber(match.groups.marketValue),
  }));
}

function validateMonthlyStatement(overview, allocations, holdings) {
  const warnings = [];
  if (!overview) warnings.push({ code: 'MONTHLY_OVERVIEW_NOT_FOUND' });
  if (holdings.length === 0) warnings.push({ code: 'MONTHLY_HOLDINGS_NOT_FOUND' });

  if (overview && holdings.length > 0) {
    const holdingValue = roundMoney(holdings.reduce((sum, item) => sum + item.marketValue, 0));
    if (Math.abs(holdingValue - overview.portfolioValue.usd) > 0.02) {
      warnings.push({ code: 'MONTHLY_PORTFOLIO_VALUE_MISMATCH' });
    }
  }

  const holdingAllocation = roundMoney(
    holdings.reduce((sum, item) => sum + item.allocationPercentage, 0),
  );
  if (holdings.length > 0 && Math.abs(holdingAllocation - 100) > 0.02) {
    warnings.push({ code: 'MONTHLY_HOLDING_ALLOCATION_MISMATCH' });
  }

  const sectorAllocation = roundMoney(
    allocations.sectors.reduce((sum, item) => sum + item.allocationPercentage, 0),
  );
  if (allocations.sectors.length > 0 && Math.abs(sectorAllocation - 100) > 0.02) {
    warnings.push({ code: 'MONTHLY_SECTOR_ALLOCATION_MISMATCH' });
  }

  return { isValid: warnings.length === 0, warnings };
}

function parseDimeMonthlyStatement(text) {
  if (!/Offshore Securities Account Monthly Statement/i.test(text)) {
    throw new AppError(422, 'NOT_DIME_MONTHLY_STATEMENT', 'The PDF is not a Dime monthly statement');
  }

  const statementMonth = parseStatementPeriod(text);
  const asOf = parseAsOfAndExchangeRate(text);
  const accountNumber = text.match(/^\d{11}$/m)?.[0] || null;
  const overview = parseOverview(text);
  const assetAllocation = parseAllocations(text);
  const holdings = parseHoldings(text);
  const validation = validateMonthlyStatement(overview, assetAllocation, holdings);

  return {
    document: {
      type: 'DIME_MONTHLY_STATEMENT',
      documentNumber: null,
      statementMonth,
      asOfDate: asOf?.asOfDate ?? null,
      accountNumber,
      baseCurrency: 'USD',
      exchangeRate: asOf ? {
        from: 'USD',
        to: 'THB',
        rate: asOf.exchangeRate,
        source: 'BOT',
      } : null,
      deduplicationKey: accountNumber && statementMonth
        ? `DIME_MONTHLY_STATEMENT:${accountNumber}:${statementMonth}`
        : null,
    },
    overview,
    assetAllocation,
    holdings,
    validation,
  };
}

module.exports = {
  parseDimeMonthlyStatement,
  parseStatementPeriod,
  parseAsOfAndExchangeRate,
  parseOverview,
  parseAllocations,
  parseHoldings,
};
