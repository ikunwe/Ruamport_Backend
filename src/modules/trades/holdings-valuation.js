const { instrument } = require('./stock-price.service');
const { decimal, add, subtract, multiply, ratio, number } = require('./valuation-decimal');

const percent = (pnl, cost) => cost?.n > 0n ? ratio(multiply(pnl, decimal(100)), cost) : null;
function amounts(market, cost, fxRate = null) {
  const pnl = subtract(market, cost);
  const scale = value => fxRate === null ? value : multiply(value, decimal(fxRate));
  return { marketValue: number(scale(market)), remainingCost: number(scale(cost)),
    unrealizedPnl: number(scale(pnl)), unrealizedPnlPercent: percent(pnl, cost) };
}
function costOf(item) {
  const row = item.costBasis?.find(cost => cost.currency === 'USD');
  return row?.status === 'CALCULATED' && typeof row.remainingCost === 'number'
    && Number.isFinite(row.remainingCost) && row.remainingCost >= 0 ? decimal(row.remainingCost) : null;
}

function withHoldingsValuation(holdings, quotes, cacheTtlSeconds) {
  const fx = holdings.fx?.status === 'AVAILABLE' ? holdings.fx : null;
  let marketTotal = decimal(0);
  let costTotal = decimal(0);
  let heldPositionCount = 0;
  let pricedPositionCount = 0;
  let incompleteCostCount = 0;
  let stalePriceCount = 0;
  const times = [];
  const items = holdings.items.map(item => {
    if (item.assetType !== 'OFFSHORE_STOCK') return { ...item, marketValuation: null };
    const base = { currency: item.currency, quantity: item.quantity, quote: null, usd: null, thb: null };
    if (!(typeof item.quantity === 'number' && Number.isFinite(item.quantity) && item.quantity > 0)) {
      return { ...item, marketValuation: { ...base, status: 'NOT_HELD', issues: ['POSITIVE_QUANTITY_REQUIRED'] } };
    }
    if (item.currency !== 'USD') return { ...item, marketValuation: { ...base, status: 'UNSUPPORTED', issues: ['USD_ONLY'] } };
    heldPositionCount++;
    const target = instrument(item);
    const quote = target ? quotes.get(target.key) : null;
    const cost = costOf(item);
    if (!cost) incompleteCostCount++;
    else costTotal = add(costTotal, cost);
    const available = quote?.status === 'AVAILABLE' && typeof quote.price === 'number' && Number.isFinite(quote.price) && quote.price > 0;
    const market = available ? multiply(decimal(item.quantity), decimal(quote.price)) : null;
    if (market) {
      pricedPositionCount++;
      marketTotal = add(marketTotal, market);
      if (quote.isStale) stalePriceCount++;
      times.push(quote.priceAt);
    }
    const usd = amounts(market, cost);
    const issues = [];
    if (!target) issues.push('MARKET_INSTRUMENT_UNSUPPORTED');
    else if (!available) issues.push(quote?.errorCode || 'PRICE_NOT_AVAILABLE');
    if (!cost) issues.push('COST_BASIS_INCOMPLETE');
    if (cost?.n === 0n) issues.push('ZERO_COST_PERCENT_UNDEFINED');
    if (quote?.isStale) issues.push('STALE_PRICE');
    if (fx?.isStale) issues.push('STALE_FX_RATE');
    const overflow = (market && usd.marketValue === null) || (cost && usd.remainingCost === null)
      || (market && cost && usd.unrealizedPnl === null);
    if (overflow) issues.push('VALUATION_OUT_OF_RANGE');
    return { ...item, marketValuation: { ...base,
      status: !available ? 'PRICE_UNAVAILABLE' : !cost ? 'COST_INCOMPLETE' : overflow ? 'INCOMPLETE' : 'CALCULATED',
      quote: quote || null, usd, thb: fx ? { currency: 'THB', ...amounts(market, cost, fx.rate) } : null, issues } };
  });
  const allPriced = pricedPositionCount === heldPositionCount;
  const allCosts = incompleteCostCount === 0;
  const usd = amounts(allPriced ? marketTotal : null, allCosts ? costTotal : null);
  const isComplete = allPriced && allCosts && usd.marketValue !== null && usd.remainingCost !== null && usd.unrealizedPnl !== null;
  const oldestPriceAt = times.length ? [...times].sort()[0] : null;
  const newestPriceAt = times.length ? [...times].sort().at(-1) : null;
  return { ...holdings, items,
    ...(Array.isArray(holdings.limitations) ? { limitations: [
      ...holdings.limitations.filter(value => value !== 'NO_MARKET_VALUE'), 'MARKET_VALUE_OFFSHORE_USD_ONLY',
    ] } : {}),
    offshoreValuation: { scope: 'HELD_OFFSHORE_USD_POSITIONS', source: 'FINNHUB',
      cacheTtlSeconds, heldPositionCount, pricedPositionCount,
      missingPriceCount: heldPositionCount - pricedPositionCount, incompleteCostCount, stalePriceCount,
      isComplete, oldestPriceAt, newestPriceAt,
      usd: { currency: 'USD', ...usd, availableMarketValue: number(marketTotal) },
      thb: fx ? { currency: 'THB', ...amounts(allPriced ? marketTotal : null, allCosts ? costTotal : null, fx.rate),
        availableMarketValue: number(multiply(marketTotal, decimal(fx.rate))) } : null,
      limitations: ['UNREALIZED_PRICE_PNL_ONLY', 'FEES_AND_DIVIDENDS_EXCLUDED', 'FX_PROFIT_LOSS_NOT_CALCULATED',
        'PROVIDER_QUOTE_SESSION_NOT_CLASSIFIED', 'PRICE_TIMES_MAY_DIFFER', 'CONFIRMATIONS_ONLY_CORPORATE_ACTIONS_NOT_RECONCILED'],
    } };
}

module.exports = { withHoldingsValuation, amounts };
