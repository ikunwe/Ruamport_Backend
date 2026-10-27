const { AppError } = require('../../shared/errors/app-error');
const { decimal, add, multiply, number } = require('./valuation-decimal');
const { DAY, validDate, shiftDate, thaiToday } = require('./history-dates');
const { validSplit } = require('./history-corporate-actions');
const { replayHistoricalUnits } = require('./history-replay');
const TYPES = ['OFFSHORE_STOCK', 'THAI_STOCK', 'MUTUAL_FUND'];
const RANGES = { '1D': 1, '1W': 7, '1M': 30, '3M': 90, '1Y': 365 };
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
function observations(result, start, end) {
  const prices = new Map();
  let errorCode = result?.status === 'AVAILABLE' ? null : result?.errorCode || 'HISTORY_NOT_AVAILABLE';
  if (!errorCode) {
    if (result.corporateActions !== undefined && (!Array.isArray(result.corporateActions)
      || result.corporateActions.length > 100 || result.corporateActions.some(event => !validSplit(event) || event.date > end)
      || new Set(result.corporateActions.map(event => event.date)).size !== result.corporateActions.length))
      errorCode = 'HISTORY_CORPORATE_ACTION_INVALID';
    if (!Array.isArray(result.points) || result.points.length > 4000) errorCode = 'HISTORY_RESPONSE_INVALID';
    else for (const point of result.points) {
      if (!validDate(point?.date) || !positive(point.price)) { errorCode = 'HISTORY_RESPONSE_INVALID'; break; }
      if (point.date < start || point.date > end) continue;
      if (prices.has(point.date) && prices.get(point.date) !== point.price) { errorCode = 'HISTORY_CONFLICTING_OBSERVATIONS'; break; }
      prices.set(point.date, point.price);
    }
  }
  const rows = [...prices].sort(([a], [b]) => a.localeCompare(b)).map(([date, price]) => ({ date, price }));
  let index = -1;
  return { source: result?.source || 'UNKNOWN', errorCode,
    historyAvailableFrom: result?.historyAvailableFrom || null,
    reason: result?.reason || null, limitSource: result?.limitSource || null,
    providerStatus: result?.providerStatus || null, retryAt: result?.retryAt || null,
    cacheStatus: result?.cacheStatus || null,
    priceBasis: result?.priceBasis || null, corporateActions: result?.corporateActions || [],
    listingTransfer: result?.listingTransfer || null,
    providerMicCode: result?.providerMicCode || null, instrumentType: result?.instrumentType || null,
    at(date, maxAgeDays) {
      if (errorCode) return null;
      while (index + 1 < rows.length && rows[index + 1].date <= date) index++;
      const row = rows[index];
      return row && Date.parse(date) - Date.parse(row.date) < maxAgeDays * DAY ? row : null;
    } };
}
function createPortfolioHistoryService({ repository, market, now = Date.now, valuePlaces = 2 }) {
  return {
    async get(userId, query = {}) {
      const range = query.range ?? '1M';
      if (typeof range !== 'string' || (!Object.hasOwn(RANGES, range) && range !== 'ALL'))
        throw new AppError(400, 'INVALID_HISTORY_RANGE', 'range must be 1D, 1W, 1M, 3M, 1Y or ALL');
      const data = await repository.portfolioOrders(userId);
      if (!data || !Array.isArray(data.orders)) throw new AppError(503, 'HISTORY_STORAGE_UNAVAILABLE', 'Historical orders unavailable; check migration 020');
      if (data.truncated || data.orders.length > 20000) throw new AppError(422, 'HISTORY_ORDER_LIMIT_EXCEEDED', 'History supports up to 20000 imported orders per request');
      if (data.orders.some(row => !validDate(row.tradeDate))) throw new AppError(422, 'HISTORY_TRADE_DATE_REQUIRED', 'Every imported order requires a valid effective trade date for historical valuation');
      const end = thaiToday(now());
      const orders = data.orders.filter(row => row.tradeDate <= end).sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
      const first = orders[0]?.tradeDate || null;
      let start = range === 'ALL' ? first || end : shiftDate(end, -RANGES[range]);
      if (first && start < first) start = first;
      if (Date.parse(end) - Date.parse(start) > 3650 * DAY)
        throw new AppError(422, 'HISTORY_RANGE_TOO_LARGE', 'Select a shorter range; at most 3650 daily intervals are supported');
      const dates = [];
      for (let date = start; date <= end; date = shiftDate(date, 1)) dates.push(date);
      const grouped = new Map();
      for (const row of orders) {
        const key = JSON.stringify([row.assetType, row.accountNumber ?? null, row.symbol, row.exchange ?? null, row.currency]);
        if (!grouped.has(key)) grouped.set(key, { key, item: { assetType: row.assetType, symbol: row.symbol,
          accountNumber: row.accountNumber, exchange: row.exchange, currency: row.currency }, orders: [] });
        grouped.get(key).orders.push(row);
      }
      let groups = [...grouped.values()];
      if (new Set(groups.map(group => JSON.stringify([group.item.assetType, group.item.symbol, group.item.exchange, group.item.currency]))).size > 30)
        throw new AppError(422, 'HISTORY_INSTRUMENT_LIMIT_EXCEEDED', 'At most 30 historical instruments per request are supported');
      const historyStart = shiftDate(start, -14);
      for (const group of groups) {
        const expectedCurrency = group.item.assetType === 'OFFSHORE_STOCK' ? 'USD' : 'THB';
        const eventStart = group.orders[0].tradeDate < historyStart ? group.orders[0].tradeDate : historyStart;
        let result;
        if (!TYPES.includes(group.item.assetType) || group.item.currency !== expectedCurrency)
          result = { status: 'UNAVAILABLE', errorCode: 'HISTORY_INSTRUMENT_UNSUPPORTED' };
        else if (Date.parse(end) - Date.parse(eventStart) > 3675 * DAY)
          result = { status: 'UNAVAILABLE', errorCode: 'HISTORY_EVENT_RANGE_TOO_LARGE' };
        else result = await market.getSeries(group.item, historyStart, end, { eventStart });
        group.series = observations(result, historyStart, end);
        group.days = replayHistoricalUnits(group, dates, group.series.errorCode ? [] : group.series.corporateActions);
        // A zero raw balance cannot prove a position closed if action data could
        // not be read (a split before a partial sale may leave extra shares).
        if (group.series.errorCode && group.item.assetType !== 'MUTUAL_FUND') group.days.forEach((day, index) => {
          if (!day.active && dates[index] >= group.orders[0].tradeDate) {
            day.active = true;
            day.issues.push('HISTORY_QUANTITY_BASIS_UNVERIFIED');
          }
        });
      }
      // A transfer can split BUY/SELL records across old/new PDF markets. Merge
      // only within the same owner/account/ticker/currency when current identity
      // is independently corroborated and both providers' normalized data agree.
      const buckets = new Map();
      for (const group of groups) {
        const canonical = group.item.assetType === 'OFFSHORE_STOCK' && !group.series.errorCode && group.series.providerMicCode
          ? 'LISTING:' + JSON.stringify([group.item.accountNumber ?? null, group.item.symbol.toUpperCase(), group.item.currency, group.series.providerMicCode, group.series.instrumentType])
          : 'ORIGINAL:' + group.key;
        const bucket = buckets.get(canonical) || [];
        bucket.push(group); buckets.set(canonical, bucket);
      }
      groups = [...buckets.values()].flatMap(bucket => {
        if (bucket.length < 2 || !bucket.some(g => g.series.listingTransfer?.type === 'CORROBORATED_CURRENT_LISTING')) return bucket;
        bucket.sort((a, b) => a.orders[0].tradeDate.localeCompare(b.orders[0].tradeDate));
        const primary = bucket[0];
        const actions = primary.series.corporateActions;
        if (bucket.some(g => g.series.corporateActions.some(action => !actions.some(a => a.date === action.date
          && a.numerator === action.numerator && a.denominator === action.denominator)))) return bucket;
        primary.orders = bucket.flatMap(g => g.orders).sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
        primary.item = { ...primary.item, pdfExchanges: [...new Set(bucket.map(g => g.item.exchange))] };
        primary.series.listingTransfer = bucket.find(g => g.series.listingTransfer)?.series.listingTransfer;
        primary.days = replayHistoricalUnits(primary, dates, actions);
        return [primary];
      });
      const needsFx = groups.some(group => group.item.assetType === 'OFFSHORE_STOCK');
      const fx = observations(needsFx ? await market.getFxSeries(historyStart, end)
        : { status: 'AVAILABLE', source: 'NOT_REQUIRED', points: [] }, historyStart, end);
      const points = first ? dates.map((date, dayIndex) => {
        const fxRow = needsFx ? fx.at(date, 7) : null;
        const totals = new Map(TYPES.map(type => [type, { amount: decimal(0), held: 0, valued: 0 }]));
        const issues = new Set();
        const priceDates = [];
        let carriedPositionCount = 0;
        for (const group of groups) {
          const day = group.days[dayIndex];
          if (!day.active) continue;
          const total = totals.get(group.item.assetType);
          if (!total) { issues.add('HISTORY_INSTRUMENT_UNSUPPORTED'); continue; }
          total.held++;
          const price = group.series.at(date, group.item.assetType === 'MUTUAL_FUND' ? 14 : 7);
          day.issues.forEach(issue => issues.add(issue));
          if (day.issues.length) continue;
          if (!price) { issues.add(group.series.errorCode || 'HISTORICAL_PRICE_MISSING'); continue; }
          if (group.item.assetType === 'OFFSHORE_STOCK' && !fxRow) { issues.add(fx.errorCode || 'HISTORICAL_FX_MISSING'); continue; }
          let amount = multiply(day.quantity, decimal(price.price));
          if (group.item.assetType === 'OFFSHORE_STOCK') amount = multiply(amount, decimal(fxRow.price));
          if (number(amount) === null) { issues.add('HISTORY_VALUE_OUT_OF_RANGE'); continue; }
          total.amount = add(total.amount, amount);
          total.valued++;
          priceDates.push(price.date);
          if (price.date !== date) carriedPositionCount++;
        }
        const byAssetType = [...totals].map(([assetType, value]) => ({ assetType, currency: 'THB',
          marketValue: value.held === value.valued ? number(value.amount, valuePlaces) : null,
          availableMarketValue: number(value.amount, valuePlaces), heldPositionCount: value.held,
          valuedPositionCount: value.valued, isComplete: value.held === value.valued && number(value.amount) !== null }));
        const total = [...totals.values()].reduce((sum, value) => add(sum, value.amount), decimal(0));
        const held = byAssetType.reduce((sum, value) => sum + value.heldPositionCount, 0);
        const valued = byAssetType.reduce((sum, value) => sum + value.valuedPositionCount, 0);
        const complete = held === valued && !issues.size && number(total) !== null;
        priceDates.sort();
        return { date, currency: 'THB', marketValue: complete ? number(total, valuePlaces) : null,
          availableMarketValue: number(total, valuePlaces), isComplete: complete, heldPositionCount: held,
          valuedPositionCount: valued, missingPositionCount: held - valued, carriedPositionCount,
          oldestPriceDate: priceDates[0] || null, newestPriceDate: priceDates.at(-1) || null,
          fxRateDate: fxRow?.date || null, byAssetType, issues: [...issues] };
      }) : [];
      return { range, granularity: 'DAY', currency: 'THB', valuationBasis: 'DAILY_OBSERVATIONS_WITH_BOUNDED_CARRY_FORWARD',
        status: !first ? 'EMPTY' : points.every(point => point.isComplete) ? 'COMPLETE' : 'INCOMPLETE',
        startDate: start, endDate: end, firstTradeDate: first, calculatedAt: new Date(now()).toISOString(),
        points, missingPointCount: points.filter(point => !point.isComplete).length,
        positions: groups.map(group => ({ ...group.item, source: group.series.source, errorCode: group.series.errorCode,
          historyAvailableFrom: group.series.historyAvailableFrom,
          reason: group.series.reason, limitSource: group.series.limitSource, providerStatus: group.series.providerStatus,
          retryAt: group.series.retryAt, cacheStatus: group.series.cacheStatus,
          priceBasis: group.series.priceBasis, corporateActions: group.series.corporateActions, listingTransfer: group.series.listingTransfer })),
        fxHistory: { source: fx.source, errorCode: fx.errorCode, reason: fx.reason, limitSource: fx.limitSource,
          providerStatus: fx.providerStatus, retryAt: fx.retryAt, cacheStatus: fx.cacheStatus },
        excludedFutureOrderCount: data.orders.length - orders.length,
        limitations: ['ASSETS_ONLY_EXCLUDES_CASH', 'NOT_PROFIT_OR_RETURN', 'EFFECTIVE_TRADE_DATES_NO_INTRADAY_ORDER',
          'MARKET_DATES_AND_PUBLICATION_TIMES_DIFFER', 'FX_EFFECT_INCLUDED_USING_HISTORICAL_RATES',
          'CONFIRMATION_HISTORY_MAY_BE_INCOMPLETE', 'SPLITS_AUTOMATIC_OTHER_CORPORATE_ACTIONS_UNSUPPORTED',
          'LAST_POINT_MAY_BE_PROVISIONAL', '1D_IS_DAILY_NOT_INTRADAY'],
      };
    },
  };
}
module.exports = { createPortfolioHistoryService };
