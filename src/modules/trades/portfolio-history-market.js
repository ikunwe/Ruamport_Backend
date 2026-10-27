const { createProviderClient } = require('./public-market-cache');
const { createHistoryRangeCache } = require('./history-range-cache');
const { historyFailure } = require('./history-failure');
const { domesticInstrument } = require('./domestic-market.service');
const { instrument, stockPriceService } = require('./stock-price.service');
const { decimal, number } = require('./valuation-decimal');
const { applySplit, parseSplitEvents, validSplit } = require('./history-corporate-actions');
const { validateHistoryRange, marketDate, shiftDate, validDate } = require('./history-dates');
const { INDICES } = require('./market-index.service');
const { THAI_INDICES, tradingViewIndexHistoryService } = require('./tradingview-index-history.service');
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const YAHOO_US_EXCHANGES = {
  XNAS: ['NMS', 'NGM', 'NCM'], XNGS: ['NMS'], XNMS: ['NGM'], XNCM: ['NCM'],
  XNYS: ['NYQ'], ARCX: ['PCX'], XASE: ['ASE'], BATS: ['BTS', 'BATS'],
};
function createPortfolioHistoryMarket({ marketPrices = stockPriceService, domesticPrices, fetchData = globalThis.fetch, now = Date.now,
  queueWaitMs = 65000, wait, thaiIndexHistory = tradingViewIndexHistoryService } = {}) {
  const cache = createHistoryRangeCache({ now });
  const yahoo = createProviderClient({ origin: 'https://query1.finance.yahoo.com', prefix: 'HISTORY',
    fetchData, now, timeoutMs: 10000, perMinute: 20, queueWaitMs, wait });
  const fx = createProviderClient({ origin: 'https://api.frankfurter.dev', prefix: 'HISTORY_FX',
    fetchData, now, timeoutMs: 10000, perMinute: 20, queueWaitMs, wait });
  const failure = historyFailure;
  return {
    async getIndexSeries(id, start, end) {
      validateHistoryRange(start, end);
      if (Object.hasOwn(THAI_INDICES, id)) return thaiIndexHistory.getSeries(id, start, end);
      const target = INDICES.find(row => row.id === id && row.id !== 'DOW_JONES');
      if (!target) return failure('YAHOO_FINANCE', { code: 'BENCHMARK_UNSUPPORTED' });
      return cache('BENCHMARK:' + id, start, end, async (from, to) => {
        const data = await yahoo.get('/v8/finance/chart/' + encodeURIComponent(target.symbol), {
          interval: '1d', period1: String(Date.parse(from) / 1000),
          period2: String(Date.parse(shiftDate(to, 1)) / 1000),
        });
        const chart = data?.chart?.result?.[0];
        const meta = chart?.meta;
        const stamps = chart?.timestamp;
        const closes = chart?.indicators?.quote?.[0]?.close;
        if (data?.chart?.error || meta?.symbol !== target.symbol || meta?.instrumentType !== 'INDEX'
          || meta.currency !== target.currency || !target.exchanges.includes(meta.exchangeName)
          || (meta.exchangeTimezoneName && meta.exchangeTimezoneName !== target.timeZone)
          || !Array.isArray(stamps) || !Array.isArray(closes) || stamps.length !== closes.length || stamps.length > 4000)
          throw yahoo.error('HISTORY_RESPONSE_INVALID');
        const points = [];
        for (let i = 0; i < stamps.length; i++) {
          if (closes[i] === null) continue;
          if (!Number.isSafeInteger(stamps[i]) || stamps[i] <= 0 || !positive(closes[i]))
            throw yahoo.error('HISTORY_RESPONSE_INVALID');
          const date = marketDate(stamps[i] * 1000, target.timeZone);
          if (date >= from && date <= to) points.push({ date, price: closes[i] });
        }
        return { status: 'AVAILABLE', source: 'YAHOO_FINANCE', currency: target.currency, points };
      }, error => failure('YAHOO_FINANCE', error));
    },
    async getSeries(item, start, end, options = {}) {
      validateHistoryRange(start, end);
      const eventStart = options.eventStart && options.eventStart < start ? options.eventStart : start;
      validateHistoryRange(eventStart, end);
      if (item.assetType === 'MUTUAL_FUND') return domesticPrices.getFundDailyHistory(item, start, end);
      const offshore = item.assetType === 'OFFSHORE_STOCK';
      const target = offshore ? instrument(item) : domesticInstrument(item);
      if (!target || (!offshore && item.assetType !== 'THAI_STOCK')) return failure('NONE', { code: 'HISTORY_INSTRUMENT_UNSUPPORTED' });
      const providerSymbol = offshore ? target.symbol : target.providerSymbol;
      const currency = offshore ? 'USD' : 'THB';
      const result = await cache(`YAHOO:${target.key}`, eventStart, end, async (from, to) => {
        const eventStart = from;
        const end = to;
        const data = await yahoo.get('/v8/finance/chart/' + encodeURIComponent(providerSymbol), {
          interval: '1d', period1: String(Date.parse(eventStart) / 1000),
          period2: String(Date.parse(shiftDate(end, 1)) / 1000), events: 'splits',
        });
        const chart = data?.chart?.result?.[0];
        const meta = chart?.meta;
        const exchanges = offshore ? YAHOO_US_EXCHANGES[target.micCode] : ['SET', 'BKK'];
        let listingTransfer = null;
        if (data?.chart?.error || meta?.symbol !== providerSymbol || meta?.currency !== currency
          || !(offshore ? ['EQUITY', 'ETF'] : ['EQUITY']).includes(meta?.instrumentType))
          throw yahoo.error('HISTORY_RESPONSE_INVALID');
        if (!exchanges?.includes(meta.exchangeName)) {
          if (!offshore || !marketPrices?.getHistoricalListingIdentity) throw yahoo.error('HISTORY_LISTING_UNVERIFIED');
          const identity = await marketPrices.getHistoricalListingIdentity(item);
          if (identity?.status !== 'AVAILABLE' || identity.symbol !== providerSymbol || identity.currency !== 'USD'
            || identity.instrumentType !== meta.instrumentType
            || !YAHOO_US_EXCHANGES[identity.micCode]?.includes(meta.exchangeName)) throw yahoo.error('HISTORY_LISTING_UNVERIFIED');
          listingTransfer = { type: 'CORROBORATED_CURRENT_LISTING', fromMic: target.micCode, toMic: identity.micCode,
            effectiveDate: null, source: 'FINNHUB_LISTING_CATALOG_AND_YAHOO',
            verifiedAt: identity.verifiedAt || null, providerExchange: meta.exchangeName, pdfMarketPreserved: true };
        }
        let corporateActions;
        try { corporateActions = parseSplitEvents(chart.events?.splits, offshore ? 'America/New_York' : 'Asia/Bangkok', eventStart, end); }
        catch { throw yahoo.error('HISTORY_CORPORATE_ACTION_INVALID'); }
        const timestamps = chart.timestamp;
        const closes = chart.indicators?.quote?.[0]?.close;
        if (!Array.isArray(timestamps) || !Array.isArray(closes) || timestamps.length !== closes.length
          || timestamps.length > 4000) throw yahoo.error('HISTORY_RESPONSE_INVALID');
        const points = [];
        const adjustmentAsOfDate = marketDate(now(), offshore ? 'America/New_York' : 'Asia/Bangkok');
        for (let i = 0; i < timestamps.length; i++) {
          if (closes[i] === null) continue; // No trade/bar: preserve a gap, never a zero-price observation.
          if (!Number.isSafeInteger(timestamps[i]) || timestamps[i] <= 0 || !positive(closes[i]))
            throw yahoo.error('HISTORY_RESPONSE_INVALID');
          const date = marketDate(timestamps[i] * 1000, offshore ? 'America/New_York' : 'Asia/Bangkok');
          // Keep the provider's raw precision and adjustment generation in RAM.
          // A split needed by this bar can live in a different cached interval.
          if (date >= eventStart && date <= end) points.push({ date, price: closes[i],
            priceHint: Number.isInteger(meta.priceHint) && meta.priceHint >= 0 && meta.priceHint <= 8 ? meta.priceHint : 8,
            adjustmentAsOfDate });
        }
        let historyAvailableFrom = null;
        const firstStamp = Number.isSafeInteger(meta.firstTradeDate) ? meta.firstTradeDate * 1000 : NaN;
        if (Number.isSafeInteger(firstStamp) && Number.isFinite(new Date(firstStamp).getTime())
          && firstStamp <= now() + 60_000) {
          const firstDate = marketDate(firstStamp, offshore ? 'America/New_York' : 'Asia/Bangkok');
          if (validDate(firstDate) && points.every(point => point.date >= firstDate)
            && corporateActions.every(action => action.date >= firstDate)) historyAvailableFrom = firstDate;
        }
        return { status: 'AVAILABLE', source: 'YAHOO_FINANCE', currency, providerSymbol, points,
          historyAvailableFrom,
          priceBasis: 'YAHOO_SPLIT_ADJUSTED', corporateActions, listingTransfer,
          providerMicCode: offshore ? Object.keys(YAHOO_US_EXCHANGES).find(mic => YAHOO_US_EXCHANGES[mic].includes(meta.exchangeName)) : 'XBKK',
          instrumentType: meta.instrumentType,
          eventCoverageStart: eventStart, eventCoverageEnd: end };
      }, error => failure('YAHOO_FINANCE', error));
      if (result.status !== 'AVAILABLE') return result;
      try {
        const { normalizationActions = [], ...publicResult } = result;
        if (normalizationActions.length > 100 || normalizationActions.some(action => !validSplit(action))
          || new Set(normalizationActions.map(action => action.date)).size !== normalizationActions.length)
          throw yahoo.error('HISTORY_CORPORATE_ACTION_INVALID');
        const points = result.points.filter(point => point.date >= start && point.date <= end).map(point => {
          // A new split must not be applied again to bars fetched before its
          // effective day: those raw bars were not adjusted by that split yet.
          const original = normalizationActions.filter(action => point.date < action.date
            && action.date <= point.adjustmentAsOfDate).reduce((price, action) => applySplit(price, action), decimal(point.price));
          const price = number(original, point.priceHint);
          if (!positive(price)) throw yahoo.error('HISTORY_RESPONSE_INVALID');
          return { date: point.date, price };
        });
        return { ...publicResult, priceBasis: 'AS_TRADED_UNADJUSTED', points };
      } catch (error) {
        return { ...failure('YAHOO_FINANCE', { ...error, code: error.safeCode || 'HISTORY_RESPONSE_INVALID' }), cacheStatus: 'LOAD_FAILED' };
      }
    },
    async getFxSeries(start, end) {
      validateHistoryRange(start, end);
      return cache('FX:USD:THB', start, end, async (start, end) => {
        const rows = await fx.get('/v2/rates', { base: 'USD', quotes: 'THB', from: start, to: end });
        if (!Array.isArray(rows) || rows.length > 4000) throw fx.error('HISTORY_FX_RESPONSE_INVALID');
        const points = rows.map(row => {
          if (row?.base !== 'USD' || row?.quote !== 'THB' || !positive(row.rate)) throw fx.error('HISTORY_FX_RESPONSE_INVALID');
          return { date: row.date, price: row.rate };
        });
        return { status: 'AVAILABLE', source: 'FRANKFURTER', currency: 'THB', points };
      }, error => failure('FRANKFURTER', error));
    },
  };
}
module.exports = { createPortfolioHistoryMarket };
