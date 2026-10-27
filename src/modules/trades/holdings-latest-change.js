const { decimal, add, subtract, multiply, ratio, number } = require('./valuation-decimal');
const TYPES = ['OFFSHORE_STOCK', 'THAI_STOCK', 'MUTUAL_FUND'];
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const validDate = date => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
  && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
function quoteDate(value, zone) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(value));
  const part = type => parts.find(row => row.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
function money(current, reference, currency) {
  const change = subtract(current, reference);
  return { currency, currentValue: number(current), referenceValue: number(reference),
    change: number(change), changePercent: ratio(multiply(change, decimal(100)), reference) };
}
const usable = row => row && ['currentValue', 'referenceValue', 'change', 'changePercent'].every(key => row[key] !== null);
function withHoldingsLatestChange(holdings) {
  const fx = holdings.fx?.status === 'AVAILABLE' && positive(holdings.fx.rate) ? holdings.fx : null;
  const records = [];
  const items = holdings.items.map(item => {
    if (!positive(item.quantity)) return { ...item, latestChange: { status: 'NOT_HELD', native: null, thb: null,
      currentDate: null, previousDate: null, isStale: false, issues: ['POSITIVE_QUANTITY_REQUIRED'] } };
    const supported = TYPES.includes(item.assetType)
      && item.currency === (item.assetType === 'OFFSHORE_STOCK' ? 'USD' : 'THB');
    const quote = item.marketValuation?.quote;
    const offshore = item.assetType === 'OFFSHORE_STOCK';
    const fund = item.assetType === 'MUTUAL_FUND';
    const currentDate = fund ? (validDate(quote?.navDate) ? quote.navDate : null)
      : quoteDate(quote?.priceAt, offshore ? 'America/New_York' : 'Asia/Bangkok');
    const previousDate = fund ? quote?.previousNavDate : offshore ? null : quote?.previousCloseDate;
    const previous = fund ? quote?.previousNav : quote?.previousClose;
    const available = supported && quote?.status === 'AVAILABLE' && quote.currency === item.currency;
    const issues = [];
    if (!supported) issues.push('LATEST_CHANGE_INSTRUMENT_UNSUPPORTED');
    else if (!available || !positive(quote?.price)) issues.push('LATEST_PRICE_UNAVAILABLE');
    if (supported && !positive(previous)) issues.push('PREVIOUS_VALUE_UNAVAILABLE');
    if (offshore && !fx) issues.push('FX_RATE_UNAVAILABLE');
    if (quote?.isStale) issues.push('STALE_QUOTE');
    if (offshore && fx?.isStale) issues.push('STALE_FX_RATE');
    const quantity = decimal(item.quantity);
    const current = available && positive(quote.price) ? multiply(quantity, decimal(quote.price)) : null;
    const reference = available && positive(previous) ? multiply(quantity, decimal(previous)) : null;
    const native = money(current, reference, item.currency);
    const rate = offshore ? (fx ? decimal(fx.rate) : null) : decimal(1);
    const thbCurrent = multiply(current, rate);
    const thbReference = multiply(reference, rate);
    const thb = money(thbCurrent, thbReference, 'THB');
    const complete = supported && usable(native) && usable(thb);
    if (current && reference && rate && !complete) issues.push('LATEST_CHANGE_OUT_OF_RANGE');
    const result = { status: !supported ? 'UNSUPPORTED' : complete ? 'CALCULATED'
      : offshore && !fx && usable(native) ? 'FX_UNAVAILABLE' : 'INCOMPLETE',
      currentDate, previousDate: validDate(previousDate) ? previousDate : null,
      priceAt: quote?.priceAt || null, isStale: Boolean(quote?.isStale || (offshore && fx?.isStale)),
      native, thb, issues };
    records.push({ assetType: item.assetType, complete, current: thbCurrent, reference: thbReference, result });
    return { ...item, latestChange: result };
  });
  function summary(rows) {
    const included = rows.filter(row => row.complete);
    const current = included.reduce((total, row) => add(total, row.current), decimal(0));
    const reference = included.reduce((total, row) => add(total, row.reference), decimal(0));
    const availableTotals = money(current, reference, 'THB');
    const allValues = ['currentValue', 'referenceValue', 'change'].every(key => availableTotals[key] !== null);
    const complete = included.length === rows.length && allValues;
    const periods = [...new Map(rows.map(row => {
      const period = { assetType: row.assetType, currentDate: row.result.currentDate, previousDate: row.result.previousDate };
      return [JSON.stringify(period), period];
    })).values()];
    return { status: complete ? 'CALCULATED' : 'INCOMPLETE', currency: 'THB', isComplete: complete,
      heldPositionCount: rows.length, calculatedPositionCount: included.length,
      missingPositionCount: rows.length - included.length, stalePositionCount: rows.filter(row => row.result.isStale).length,
      currentValue: complete ? availableTotals.currentValue : null,
      referenceValue: complete ? availableTotals.referenceValue : null,
      change: complete ? availableTotals.change : null,
      changePercent: complete ? availableTotals.changePercent : null,
      availableTotals, referencePeriods: periods,
      mixedReferencePeriods: new Set(periods.map(row => `${row.currentDate}:${row.previousDate}`)).size > 1,
      referenceDatesComplete: periods.every(row => row.currentDate && row.previousDate),
      issues: [...new Set([...rows.flatMap(row => row.result.issues), ...(!allValues ? ['LATEST_CHANGE_OUT_OF_RANGE'] : [])])] };
  }
  return { ...holdings, items, latestChange: {
    scope: 'CURRENT_HELD_POSITIONS_LATEST_REFERENCE_CHANGE', currency: 'THB',
    fxRate: fx?.rate ?? null, fxRateDate: fx?.rateDate ?? null, fxDailyEffectIncluded: false,
    portfolio: summary(records),
    byAssetType: TYPES.map(assetType => ({ assetType, ...summary(records.filter(row => row.assetType === assetType)) })),
    limitations: ['CURRENT_QUANTITIES_NOT_HISTORICAL_HOLDINGS', 'REFERENCE_DATES_MAY_DIFFER',
      'NOT_ACTUAL_DAILY_PORTFOLIO_RETURN', 'FX_DAILY_EFFECT_EXCLUDED', 'FEES_TAXES_DIVIDENDS_AND_CASH_FLOWS_EXCLUDED',
      'CORPORATE_ACTIONS_NOT_RECONCILED', 'OFFSHORE_PREVIOUS_CLOSE_DATE_NOT_PROVIDED'],
  } };
}
module.exports = { withHoldingsLatestChange };
