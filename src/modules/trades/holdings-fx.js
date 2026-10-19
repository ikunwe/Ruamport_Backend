const MONEY_FIELDS = ['totalBuy', 'totalSell', 'totalSwitchIn', 'totalSwitchOut', 'netBuySellCashFlow',
  'totalBuyGross', 'totalSellGross', 'totalSwitchInGross', 'totalSwitchOutGross',
  'totalBuyFeeIncludeVat', 'totalSellFeeIncludeVat', 'totalSwitchInFeeIncludeVat',
  'totalSwitchOutFeeIncludeVat', 'totalFeeIncludeVat'];

function decimal(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const [coefficient, exponent = '0'] = String(value).toLowerCase().split('e');
  const scale = (coefficient.split('.')[1]?.length || 0) - Number(exponent);
  return { integer: BigInt(coefficient.replace('.', '')), scale };
}

// Exact decimal multiplication of the serialized inputs; half away from zero.
// Final rounding is display-only. Historical numbers are never written back.
function convertUsd(value, rate, places = 2) {
  const a = decimal(value);
  const b = decimal(rate);
  if (!a || !b) return null;
  let product = a.integer * b.integer;
  const shift = a.scale + b.scale - places;
  if (shift > 0) {
    const divisor = 10n ** BigInt(shift);
    const negative = product < 0n;
    const absolute = negative ? -product : product;
    product = absolute / divisor + (absolute % divisor * 2n >= divisor ? 1n : 0n);
    if (negative) product = -product;
  } else product *= 10n ** BigInt(-shift);
  if (product > BigInt(Number.MAX_SAFE_INTEGER) || product < -BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(product) / 10 ** places;
}

function convertMoney(row, rate) {
  if (!row) return null;
  const result = { ...row, currency: 'THB', sourceCurrency: 'USD' };
  for (const key of MONEY_FIELDS) if (Object.hasOwn(row, key)) result[key] = convertUsd(row[key], rate);
  return result;
}
function convertCost(row, rate) {
  if (!row) return null;
  const result = { ...row, currency: 'THB', sourceCurrency: 'USD' };
  for (const key of ['remainingCost', 'rawRemainingCost', 'averageCostPerUnit', 'rawAverageCostPerUnit']) {
    if (Object.hasOwn(row, key)) result[key] = convertUsd(row[key], rate, key.endsWith('CostPerUnit') ? 8 : 2);
  }
  return result;
}
const usd = rows => rows?.find(row => row.currency === 'USD');

function withHoldingsFx(holdings, fx) {
  const rate = fx.status === 'AVAILABLE' ? fx.rate : null;
  return { ...holdings, fx,
    items: holdings.items.map(item => ({ ...item,
      displayThb: item.assetType === 'OFFSHORE_STOCK' && item.currency === 'USD' && rate !== null
        ? { currency: 'THB', sourceCurrency: 'USD',
          amounts: convertMoney(usd(item.amounts), rate), costBasis: convertCost(usd(item.costBasis), rate) }
        : null })),
    displayThb: rate === null ? null : {
      currency: 'THB', sourceCurrency: 'USD',
      scope: 'ALL_IMPORTED_USD_STOCK_POSITIONS_INCLUDING_CLOSED',
      moneyTotals: convertMoney(usd(holdings.stockMoneyTotals), rate),
      remainingCostTotal: convertCost(usd(holdings.stockRemainingCostTotals), rate),
    },
  };
}

module.exports = { withHoldingsFx, convertUsd };
