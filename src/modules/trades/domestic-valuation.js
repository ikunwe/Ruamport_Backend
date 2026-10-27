const { domesticInstrument } = require('./domestic-market.service');
const { amounts } = require('./holdings-valuation');
const { decimal, add, multiply, number } = require('./valuation-decimal');

function withDomesticValuation(holdings, quotes, thaiCacheTtlSeconds, navCacheTtlSeconds) {
  let result = holdings;
  for (const [assetType, summaryKey, source, ttl] of [
    ['THAI_STOCK', 'thaiStockValuation', 'YAHOO_FINANCE', thaiCacheTtlSeconds],
    ['MUTUAL_FUND', 'mutualFundValuation', 'SEC_OPEN_API', navCacheTtlSeconds],
  ]) {
    let marketTotal = decimal(0);
    let costTotal = decimal(0);
    let heldPositionCount = 0;
    let pricedPositionCount = 0;
    let incompleteCostCount = 0;
    let stalePriceCount = 0;
    const dates = [];
    const items = result.items.map(item => {
      if (item.assetType !== assetType) return item;
      const base = { currency: item.currency, quantity: item.quantity, quote: null, usd: null, thb: null };
      if (!(typeof item.quantity === 'number' && Number.isFinite(item.quantity) && item.quantity > 0)) {
        return { ...item, marketValuation: { ...base, status: 'NOT_HELD', issues: ['POSITIVE_QUANTITY_REQUIRED'] } };
      }
      if (item.currency !== 'THB') return { ...item, marketValuation: { ...base, status: 'UNSUPPORTED', issues: ['THB_ONLY'] } };
      heldPositionCount++;
      const target = domesticInstrument(item);
      const quote = target ? quotes.get(target.key) || null : null;
      const costRow = item.costBasis?.find(row => row.currency === 'THB');
      const cost = costRow?.status === 'CALCULATED' && typeof costRow.remainingCost === 'number'
        && Number.isFinite(costRow.remainingCost) && costRow.remainingCost >= 0 ? decimal(costRow.remainingCost) : null;
      if (cost) costTotal = add(costTotal, cost);
      else incompleteCostCount++;
      const available = quote?.status === 'AVAILABLE' && typeof quote.price === 'number' && Number.isFinite(quote.price) && quote.price > 0;
      const market = available ? multiply(decimal(item.quantity), decimal(quote.price)) : null;
      if (market) {
        pricedPositionCount++;
        marketTotal = add(marketTotal, market);
        if (quote.isStale) stalePriceCount++;
        const date = assetType === 'MUTUAL_FUND' ? quote.navDate : quote.priceAt;
        if (date) dates.push(date);
      }
      const thb = { currency: 'THB', ...amounts(market, cost) };
      const issues = [];
      if (!target) issues.push('MARKET_INSTRUMENT_UNSUPPORTED');
      else if (!available) issues.push(quote?.errorCode || (assetType === 'MUTUAL_FUND' ? 'NAV_NOT_AVAILABLE' : 'PRICE_NOT_AVAILABLE'));
      if (!cost) issues.push('COST_BASIS_INCOMPLETE');
      if (cost?.n === 0n) issues.push('ZERO_COST_PERCENT_UNDEFINED');
      if (quote?.isStale) issues.push(assetType === 'MUTUAL_FUND' ? 'STALE_NAV' : 'STALE_PRICE');
      const overflow = (market && thb.marketValue === null) || (cost && thb.remainingCost === null)
        || (market && cost && thb.unrealizedPnl === null);
      if (overflow) issues.push('VALUATION_OUT_OF_RANGE');
      return { ...item, marketValuation: { ...base, quote, thb,
        status: !available ? 'PRICE_UNAVAILABLE' : !cost ? 'COST_INCOMPLETE' : overflow ? 'INCOMPLETE' : 'CALCULATED', issues } };
    });
    const allPriced = heldPositionCount === pricedPositionCount;
    const allCosts = incompleteCostCount === 0;
    const totals = amounts(allPriced ? marketTotal : null, allCosts ? costTotal : null);
    const sorted = dates.sort();
    result = { ...result, items, [summaryKey]: {
      scope: assetType === 'THAI_STOCK' ? 'HELD_THAI_THB_POSITIONS' : 'HELD_MUTUAL_FUND_THB_POSITIONS',
      source, currency: 'THB', cacheTtlSeconds: ttl, heldPositionCount, pricedPositionCount,
      missingPriceCount: heldPositionCount - pricedPositionCount, incompleteCostCount, stalePriceCount,
      isComplete: allPriced && allCosts && totals.marketValue !== null && totals.remainingCost !== null && totals.unrealizedPnl !== null,
      thb: { currency: 'THB', ...totals, availableMarketValue: number(marketTotal) },
      ...(assetType === 'MUTUAL_FUND' ? { oldestNavDate: sorted[0] || null, newestNavDate: sorted.at(-1) || null }
        : { oldestPriceAt: sorted[0] || null, newestPriceAt: sorted.at(-1) || null }),
      limitations: ['UNREALIZED_PRICE_PNL_ONLY', 'FEES_AND_DIVIDENDS_EXCLUDED',
        ...(assetType === 'MUTUAL_FUND' ? ['PUBLISHED_NAV_NOT_REALTIME', 'NOT_NET_REDEMPTION_PROCEEDS']
          : ['UNOFFICIAL_YAHOO_API', 'DELAY_NOT_GUARANTEED', 'FIXED_TTL_NO_THAI_SESSION_CALENDAR']),
        'CONFIRMATIONS_ONLY_CORPORATE_ACTIONS_NOT_RECONCILED'],
    } };
  }
  if (Array.isArray(result.limitations)) result = { ...result, limitations: [
    ...result.limitations.filter(value => !['NO_MARKET_VALUE', 'MARKET_VALUE_OFFSHORE_USD_ONLY'].includes(value)),
    'MARKET_VALUE_HELD_SUPPORTED_POSITIONS_ONLY',
  ] };
  return result;
}
module.exports = { withDomesticValuation };
