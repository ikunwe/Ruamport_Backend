const { AppError } = require('../../shared/errors/app-error');
const { createPortfolioHistoryService } = require('./portfolio-history.service');
const { DAY, validDate, shiftDate } = require('./history-dates');
const { decimal, add, subtract, multiply, number, ratio } = require('./valuation-decimal');
const { INDICES } = require('./market-index.service');
const { THAI_INDICES } = require('./tradingview-index-history.service');
const CATEGORIES = ['ALL', 'OFFSHORE_STOCK', 'THAI_STOCK', 'MUTUAL_FUND'];
const RANGES = { '1M': 30, '3M': 90, '1Y': 365, ALL: null };
const BENCHMARKS = INDICES.filter(row => row.id !== 'DOW_JONES');
const METHOD = 'DAILY_TWR_APPROXIMATION';
const finite = value => typeof value === 'number' && Number.isFinite(value);
const rounded = (value, places = 6) => finite(value) ? number(decimal(value), places) : null;
const percent = factor => rounded((factor - 1) * 100);
const metadata = {
  currency: 'THB', method: METHOD, cashFlowScope: 'INVESTED_ASSETS_ONLY',
  cashFlowTiming: 'END_OF_DAY_ASSUMPTION', zeroCapitalEntryTiming: 'BEGINNING_OF_DAY_GROSS_BUYS',
  cashFlowSource: 'PDF_GROSS_STOCK_AND_FUND_TOTAL_EXCLUDING_FEES',
  fxBasis: 'HISTORICAL_DAILY_USD_THB_BOUNDED_CARRY_7_DAYS',
  feesIncluded: false, taxesIncluded: false, dividendsIncluded: false, fxIncluded: true,
  firstDayBasis: 'FIRST_DAY_GROSS_BUYS', benchmarkFirstDayBasis: 'PREVIOUS_CALENDAR_DAY_OBSERVATION',
};
const limitations = ['APPROXIMATION_NOT_EXACT_INTRADAY_TWR', 'ASSETS_ONLY_EXCLUDES_CASH_ACCOUNT',
  'FIRST_DAY_GROSS_BUYS_ASSUMED_AT_BEGINNING_OF_DAY',
  'ZERO_CAPITAL_REENTRY_USES_BEGINNING_OF_DAY_BUYS', 'DIVIDENDS_AND_FEES_EXCLUDED',
  'FUND_NAV_MAY_EMBED_FUND_EXPENSES_AND_DISTRIBUTIONS',
  'UNPAIRED_OR_UNBALANCED_SWITCHES_ARE_INCOMPLETE', 'MARKET_AND_NAV_OBSERVATION_DATES_DIFFER',
  'LAST_POINT_MAY_BE_PROVISIONAL', 'CONFIRMATION_HISTORY_MAY_BE_INCOMPLETE'];

// No future observations, no unbounded weekend carry, no conflicting duplicate bars.
function sampler(result, maxDays = 7) {
  const values = new Map();
  let error = result?.status === 'AVAILABLE' ? null : result?.errorCode || 'HISTORY_NOT_AVAILABLE';
  if (!error && (!Array.isArray(result.points) || result.points.length > 4000)) error = 'HISTORY_RESPONSE_INVALID';
  if (!error) for (const row of result.points) {
    if (!validDate(row?.date) || !finite(row.price) || row.price <= 0
      || (values.has(row.date) && values.get(row.date) !== row.price)) { error = 'HISTORY_RESPONSE_INVALID'; break; }
    values.set(row.date, row.price);
  }
  const rows = [...values].sort(([a], [b]) => a.localeCompare(b));
  return date => {
    if (error) return { price: null, date: null, error };
    let lo = 0, hi = rows.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (rows[mid][0] <= date) lo = mid + 1; else hi = mid; }
    const row = rows[lo - 1];
    return row && Date.parse(date) - Date.parse(row[0]) < maxDays * DAY
      ? { date: row[0], price: row[1], error: null } : { date: null, price: null, error: 'HISTORICAL_OBSERVATION_MISSING' };
  };
}
function options(query, winRate = false) {
  const category = query.category ?? 'ALL', range = query.range ?? '1Y';
  if (!CATEGORIES.includes(category)) throw new AppError(400, 'INVALID_ANALYTICS_CATEGORY', 'Unsupported analytics category');
  if (typeof range !== 'string' || !Object.hasOwn(RANGES, range)) throw new AppError(400, 'INVALID_ANALYTICS_RANGE', 'range must be 1M, 3M, 1Y or ALL');
  const benchmarkId = query.benchmarkId ?? 'SP500', unit = query.unit ?? 'MONTH';
  if (!winRate && !BENCHMARKS.some(row => row.id === benchmarkId)) throw new AppError(400, 'INVALID_BENCHMARK', 'Unsupported benchmark');
  if (winRate && !['WEEK', 'MONTH', 'YEAR'].includes(unit)) throw new AppError(400, 'INVALID_ANALYTICS_UNIT', 'unit must be WEEK, MONTH or YEAR');
  return { category, range, benchmarkId, unit };
}
function periodBounds(date, unit) {
  const y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7));
  if (unit === 'YEAR') return [`${y}-01-01`, `${y}-12-31`];
  if (unit === 'MONTH') return [`${date.slice(0, 7)}-01`, shiftDate(new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10), -1)];
  const start = shiftDate(date, -((new Date(date).getUTCDay() + 6) % 7));
  return [start, shiftDate(start, 6)];
}
function safeDiagnostics(result) {
  return Object.fromEntries(['source', 'errorCode', 'reason', 'limitSource', 'providerStatus', 'retryAt',
    'cacheStatus', 'fromCache', 'isStale', 'fetchedAt', 'expiresAt', 'providerSymbol', 'resolvedSymbol',
    'currencyBasis', 'timeZone', 'dataDelay', 'lastPointMayBeProvisional'].map(key => [key, result?.[key] ?? null]));
}
function observationCoverage(result) {
  const dates = (result?.points || []).map(row => row.date).filter(validDate).sort();
  return { firstObservationDate: dates[0] || null, lastObservationDate: dates.at(-1) || null,
    observationCount: new Set(dates).size };
}
function createAnalyticsService({ repository, market, now = Date.now }) {
  async function prepare(userId, opt, ids) {
    const data = await repository.analyticsOrders(userId);
    if (!data || !Array.isArray(data.orders)) throw new AppError(503, 'ANALYTICS_STORAGE_UNAVAILABLE', 'Analytics requires migration 021');
    // A single owner-scoped snapshot supplies quantities and cash flows, including sold-out assets.
    const orders = data.orders.filter(row => opt.category === 'ALL' || row.assetType === opt.category);
    const history = await createPortfolioHistoryService({ repository: { portfolioOrders: async () => ({ ...data, orders }) }, market, now, valuePlaces: 8 })
      .get(userId, { range: 'ALL' });
    const end = history.endDate;
    const requestedStart = opt.range === 'ALL' ? history.firstTradeDate || end : shiftDate(end, -RANGES[opt.range]);
    const lookupStart = shiftDate(history.startDate, -14);
    const needsFx = orders.some(row => row.assetType === 'OFFSHORE_STOCK' && row.tradeDate <= end)
      || ids.some(id => BENCHMARKS.find(row => row.id === id).currency === 'USD');
    const fx = needsFx && history.points.length ? await market.getFxSeries(lookupStart, end)
      : { status: 'AVAILABLE', source: 'NOT_REQUIRED', points: [] };
    const fxAt = sampler(fx);
    const grouped = new Map();
    for (const order of orders) {
      if (order.tradeDate > end) continue;
      const list = grouped.get(order.tradeDate) || []; list.push(order); grouped.set(order.tradeDate, list);
    }
    const days = history.points.map((point, index) => {
      const issues = [...point.issues];
      let flow = decimal(0), buys = decimal(0), sells = decimal(0);
      let switchIn = decimal(0), switchOut = decimal(0), switchIns = 0, switchOuts = 0;
      for (const order of grouped.get(point.date) || []) {
        const buy = ['BUY', 'SUBSCRIPTION', 'SWITCH_IN'].includes(order.transactionType);
        const sell = ['SELL', 'REDEMPTION', 'SWITCH_OUT'].includes(order.transactionType);
        if (order.collision || (!buy && !sell) || !finite(order.flowAmount) || order.flowAmount <= 0) {
          issues.push('ANALYTICS_FLOW_UNVERIFIED'); continue;
        }
        let amount = decimal(order.flowAmount);
        if (order.currency === 'USD' && order.assetType === 'OFFSHORE_STOCK') {
          const rate = fxAt(point.date);
          if (!rate.price) { issues.push(rate.error); continue; }
          amount = multiply(amount, decimal(rate.price));
        } else if (order.currency !== 'THB') { issues.push('ANALYTICS_FLOW_CURRENCY_UNSUPPORTED'); continue; }
        if (order.transactionType === 'SWITCH_IN') { switchIn = add(switchIn, amount); switchIns++; }
        else if (order.transactionType === 'SWITCH_OUT') { switchOut = add(switchOut, amount); switchOuts++; }
        else { flow = add(flow, buy ? amount : { ...amount, n: -amount.n });
          if (buy) buys = add(buys, amount); else sells = add(sells, amount); }
      }
      // Never invent a missing other leg, or count both legs as external money.
      if ((switchIns || switchOuts) && (!switchIns || !switchOuts || subtract(switchIn, switchOut).n !== 0n))
        issues.push('ANALYTICS_SWITCH_FLOW_UNMATCHED');
      const previous = history.points[index - 1];
      let factor = null;
      if (!issues.length && point.isComplete && (!previous || previous.isComplete)) {
        if (previous?.marketValue > 0) factor = ratio(subtract(decimal(point.marketValue), flow), decimal(previous.marketValue), 12);
        else if (point.marketValue === 0 && flow.n === 0n && buys.n === 0n && sells.n === 0n) factor = 1;
        else if (buys.n > 0n && sells.n === 0n && !switchIns && !switchOuts)
          factor = ratio(decimal(point.marketValue), buys, 12);
        else issues.push('ANALYTICS_ZERO_CAPITAL_DENOMINATOR');
        if (factor !== null && (!finite(factor) || factor < 0)) { factor = null; issues.push('ANALYTICS_INVALID_RETURN'); }
      }
      if (factor === null && !issues.length) issues.push('ANALYTICS_PREVIOUS_VALUATION_MISSING');
      return { ...point, factor, grossBuyThb: number(buys, 8), externalFlowThb: number(flow, 8), dailyReturnPercent: factor === null ? null : percent(factor),
        exposure: point.marketValue > 0 || previous?.marketValue > 0, issues: [...new Set(issues)] };
    });
    const series = new Map();
    if (days.length) for (const id of ids) {
      const result = await market.getIndexSeries(id, lookupStart, end);
      const target = BENCHMARKS.find(row => row.id === id), at = sampler(result);
      // Keep the day before inception for the benchmark opening baseline only.
      // Portfolio quantities/values still start on the real first trade date.
      const values = new Map([{ date: shiftDate(history.firstTradeDate, -1) }, ...days].map(day => {
        const price = at(day.date), rate = target.currency === 'USD' ? fxAt(day.date) : { price: 1, date: null };
        const issues = [price.error, rate.error].filter(Boolean);
        const value = price.price && rate.price ? number(multiply(decimal(price.price), decimal(rate.price)), 8) : null;
        if (price.price && rate.price && value === null) issues.push('ANALYTICS_VALUE_OUT_OF_RANGE');
        return [day.date, { value, observationDate: price.date, fxRateDate: rate.date, issues }];
      }));
      series.set(id, { target, result, values });
    }
    const diagnostics = [...history.positions, history.fxHistory, fx, ...[...series.values()].map(row => row.result)].map(safeDiagnostics);
    const retryAt = diagnostics.map(row => row.retryAt).filter(Boolean).sort().at(-1) || null;
    const expiries = diagnostics.map(row => row.expiresAt).filter(Boolean).sort();
    return { opt, history, days, series, requestedStart, end, retryAt, diagnostics,
      cache: { scope: 'SHARED_PUBLIC_OBSERVATIONS_ONLY', privateResponseCached: false,
        cacheTtlSeconds: 21600, expiresAt: expiries[0] || null,
        fromCache: diagnostics.filter(row => row.cacheStatus || row.fromCache !== null).length
          ? diagnostics.filter(row => row.cacheStatus || row.fromCache !== null).every(row => row.cacheStatus === 'HIT' || row.fromCache === true) : null,
        isStale: diagnostics.some(row => row.isStale === true) } };
  }
  function benchmarkMetadata(id) {
    const row = BENCHMARKS.find(row => row.id === id);
    return { id, name: row.name, symbol: THAI_INDICES[id] || row.symbol,
      source: THAI_INDICES[id] ? 'TRADINGVIEW' : 'YAHOO_FINANCE', nativeCurrency: row.currency,
      comparisonCurrency: 'THB', returnBasis: 'PRICE_RETURN', dividendsIncluded: false, fxIncluded: row.currency === 'USD' };
  }
  return {
    async performance(userId, query = {}) {
      const opt = options(query), data = await prepare(userId, opt, [opt.benchmarkId]);
      const selected = data.days.filter(row => row.date >= data.requestedStart);
      // Skip genuinely uninvested leading days only. Never skip a missing valuation to manufacture a baseline.
      const base = selected.find(row => row.marketValue === null || row.marketValue > 0 || row.issues.length);
      const fromInception = Boolean(base && base.date === data.history.firstTradeDate);
      const baselineDate = base ? fromInception ? shiftDate(base.date, -1) : base.date : null;
      const benchmark = data.series.get(opt.benchmarkId);
      const benchmarkBase = benchmark?.values.get(baselineDate);
      let chain = 1, broken = !base || !base.isComplete || base.issues.length > 0;
      let benchmarkBroken = !benchmarkBase?.value;
      const points = selected.map(day => {
        const issues = [...day.issues];
        const beforeBase = !base || day.date < base.date;
        if (!beforeBase && day.date !== baselineDate) {
          if (day.factor === null) broken = true;
          else chain *= day.factor;
          if (!finite(chain) || percent(chain) === null) { broken = true; issues.push('ANALYTICS_RETURN_OUT_OF_RANGE'); }
        }
        const observation = benchmark?.values.get(day.date);
        if (!beforeBase && !observation?.value) benchmarkBroken = true;
        const portfolioReturnPercent = beforeBase || broken ? null : percent(chain);
        const benchmarkReturnPercent = beforeBase || benchmarkBroken ? null : percent(observation.value / benchmarkBase.value);
        if (beforeBase) issues.push('NO_INVESTED_CAPITAL');
        else {
          if (broken) issues.push('ANALYTICS_RETURN_CHAIN_INCOMPLETE');
          if (benchmarkBroken) issues.push(...(observation?.issues || []), 'BENCHMARK_CHAIN_INCOMPLETE');
        }
        return { date: day.date, portfolioReturnPercent, benchmarkReturnPercent,
          dailyReturnPercent: (!fromInception && day.date === baselineDate) || beforeBase ? null : day.dailyReturnPercent,
          marketValueThb: day.marketValue, externalFlowThb: day.externalFlowThb,
          isComplete: portfolioReturnPercent !== null && benchmarkReturnPercent !== null,
          portfolioObservations: { oldestPriceDate: day.oldestPriceDate, newestPriceDate: day.newestPriceDate,
            carriedPositionCount: day.carriedPositionCount },
          benchmarkObservationDate: observation?.observationDate || null,
          fxRateDate: day.fxRateDate, benchmarkFxRateDate: observation?.fxRateDate || null,
          issues: [...new Set(issues)] };
      });
      const effective = points.filter(row => base && row.date >= base.date);
      const isComplete = effective.length > 0 && effective.every(row => row.isComplete);
      const comparable = isComplete;
      const last = points.at(-1), empty = !data.days.length || !base;
      return { calculationVersion: 2, category: opt.category, range: opt.range, requestedStartDate: data.requestedStart, requestedEndDate: data.end,
        startDate: selected[0]?.date || null, endDate: data.end, baselineDate,
        comparisonStartDate: base?.date || null, comparisonEndDate: comparable ? data.end : null,
        comparisonCurrency: 'THB', granularity: 'DAY', timeZone: 'Asia/Bangkok',
        status: empty ? 'EMPTY' : isComplete ? 'COMPLETE' : effective.some(row => row.portfolioReturnPercent !== null || row.benchmarkReturnPercent !== null) ? 'PARTIAL' : 'INCOMPLETE',
        isComplete, comparable,
        portfolio: { ...metadata, baselineBasis: fromInception ? 'FIRST_DAY_GROSS_BUYS' : 'DAILY_CLOSE',
          initialCapitalThb: fromInception ? base.grossBuyThb : null,
          cumulativeReturnPercent: last?.portfolioReturnPercent ?? null },
        benchmark: { ...benchmarkMetadata(opt.benchmarkId), cumulativeReturnPercent: last?.benchmarkReturnPercent ?? null,
          baselineObservationDate: benchmarkBase?.observationDate || null,
          coverage: observationCoverage(benchmark?.result), diagnostics: safeDiagnostics(benchmark?.result) },
        spreadPercentagePoints: comparable ? rounded(last.portfolioReturnPercent - last.benchmarkReturnPercent) : null,
        points, calculatedAt: new Date(now()).toISOString(), retryAt: data.retryAt, cache: data.cache,
        coverage: { firstTradeDate: data.history.firstTradeDate, effectiveBaselineDate: baselineDate,
          leadingUninvestedDayCount: points.filter(row => !base || row.date < base.date).length },
        diagnostics: data.diagnostics, issues: [...new Set(points.flatMap(row => row.issues))], limitations };
    },
    async winRate(userId, query = {}) {
      const opt = options(query, true), data = await prepare(userId, opt, BENCHMARKS.map(row => row.id));
      const bounds = [];
      let [start, end] = periodBounds(data.requestedStart, opt.unit);
      while (start <= data.end) {
        if (end >= data.requestedStart && data.history.firstTradeDate && end >= data.history.firstTradeDate)
          bounds.push([start < data.history.firstTradeDate ? data.history.firstTradeDate : start, end, start]);
        [start, end] = periodBounds(shiftDate(end, 1), opt.unit);
      }
      const byDate = new Map(data.days.map(row => [row.date, row]));
      const markets = BENCHMARKS.map(target => {
        const series = data.series.get(target.id);
        const periods = bounds.map(([startDate, endDate, calendarStartDate]) => {
          const baselineDate = shiftDate(startDate, -1), baseline = byDate.get(baselineDate);
          const fromInception = startDate === data.history.firstTradeDate;
          const firstDay = byDate.get(startDate);
          const pending = endDate >= data.end; // Today is still provisional, even on a calendar period end.
          const issues = [], observations = [], factors = [];
          let exposed = false;
          if (!pending) for (let date = startDate; date <= endDate; date = shiftDate(date, 1)) {
            const row = byDate.get(date), market = series?.values.get(date);
            exposed ||= Boolean(row?.exposure);
            if (!row || row.factor === null || row.issues.length) issues.push(...(row?.issues || []), 'PERIOD_PORTFOLIO_INCOMPLETE');
            else factors.push(row.factor);
            if (!market?.value) issues.push(...(market?.issues || []), 'PERIOD_BENCHMARK_INCOMPLETE');
            observations.push(market);
          }
          const benchmarkBase = series?.values.get(baselineDate);
          const portfolioBaselineReady = fromInception
            ? firstDay?.isComplete && firstDay.factor !== null && firstDay.grossBuyThb > 0 && !firstDay.issues.length
            : baseline?.isComplete;
          if (!pending && (!portfolioBaselineReady || !benchmarkBase?.value)) issues.push('PERIOD_BASELINE_UNAVAILABLE');
          if (!pending && !exposed) issues.push('NO_INVESTED_CAPITAL');
          let p = null, b = null;
          if (!pending && !issues.length) {
            p = percent(factors.reduce((product, value) => product * value, 1));
            b = percent(observations.at(-1).value / benchmarkBase.value);
            if (p === null || b === null) issues.push('ANALYTICS_RETURN_OUT_OF_RANGE');
          }
          const comparable = !pending && !issues.length;
          const pp = comparable ? rounded(p, 2) : null, bp = comparable ? rounded(b, 2) : null;
          const last = byDate.get(endDate);
          return { startDate, endDate, baselineDate, calendarStartDate, calendarEndDate: endDate,
            isFirstInvestmentPeriod: fromInception, isPartialPeriod: startDate !== calendarStartDate,
            periodStartReason: fromInception ? 'FIRST_INVESTMENT' : 'CALENDAR_BOUNDARY',
            baselineBasis: fromInception ? 'FIRST_DAY_GROSS_BUYS' : 'PREVIOUS_DAY_CLOSE',
            initialCapitalThb: fromInception ? firstDay?.grossBuyThb ?? null : null,
            portfolioReturnPercent: comparable ? p : null,
            benchmarkReturnPercent: comparable ? b : null,
            spreadPercentagePoints: comparable ? rounded(p - b) : null,
            outcome: pending ? 'PENDING' : !comparable ? 'INCOMPLETE' : pp > bp ? 'WIN' : pp < bp ? 'LOSS' : 'TIE',
            outcomePortfolioReturnPercent: pp, outcomeBenchmarkReturnPercent: bp,
            isComplete: comparable, comparable, issues: [...new Set(issues)],
            benchmarkBaselineObservationDate: benchmarkBase?.observationDate || null,
            benchmarkEndObservationDate: !pending ? observations.at(-1)?.observationDate || null : null,
            portfolioObservations: {
              baselineOldestPriceDate: baseline?.oldestPriceDate || null,
              baselineNewestPriceDate: baseline?.newestPriceDate || null,
              endOldestPriceDate: last?.oldestPriceDate || null, endNewestPriceDate: last?.newestPriceDate || null,
              baselineFxRateDate: baseline?.fxRateDate || null, endFxRateDate: last?.fxRateDate || null,
            },
            benchmarkBaselineFxRateDate: benchmarkBase?.fxRateDate || null,
            benchmarkEndFxRateDate: !pending ? observations.at(-1)?.fxRateDate || null : null };
        });
        const count = name => periods.filter(row => row.outcome === name).length;
        const wins = count('WIN'), losses = count('LOSS'), ties = count('TIE'), comparedPeriodCount = wins + losses + ties;
        return { ...benchmarkMetadata(target.id), wins, losses, ties, pendingCount: count('PENDING'), incompleteCount: count('INCOMPLETE'),
          comparedPeriodCount, winRatePercent: comparedPeriodCount ? rounded(wins / comparedPeriodCount * 100) : null,
          periods, coverage: observationCoverage(series?.result), diagnostics: safeDiagnostics(series?.result) };
      });
      const incomplete = markets.some(row => row.incompleteCount > 0);
      return { calculationVersion: 2, category: opt.category, range: opt.range, unit: opt.unit, timeZone: 'Asia/Bangkok', weekStartsOn: 'MONDAY',
        requestedStartDate: data.requestedStart, requestedEndDate: data.end,
        startDate: bounds[0]?.[0] || null, endDate: data.end,
        periodSelection: 'CALENDAR_PERIODS_WITH_INCEPTION_STUB_PLUS_CURRENT_PENDING',
        comparisonCurrency: 'THB', portfolioMethod: METHOD, portfolio: metadata, outcomeRoundingDecimals: 2,
        status: !data.days.length ? 'EMPTY' : incomplete ? markets.some(row => row.comparedPeriodCount) ? 'PARTIAL' : 'INCOMPLETE' : 'COMPLETE',
        isComplete: data.days.length > 0 && !incomplete,
        markets, calculatedAt: new Date(now()).toISOString(), retryAt: data.retryAt, cache: data.cache,
        diagnostics: data.diagnostics, issues: [...new Set(markets.flatMap(row => row.periods.flatMap(p => p.issues)))], limitations };
    },
  };
}
module.exports = { createAnalyticsService, sampler, periodBounds };
