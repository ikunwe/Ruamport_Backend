const { env } = require('../../config/env');
const { createPublicMarketCache, createProviderClient } = require('./public-market-cache');
const { createHistoryRangeCache } = require('./history-range-cache');
const { historyFailure } = require('./history-failure');
const { decimal, subtract, multiply, ratio, number } = require('./valuation-decimal');
const { validateHistoryRange, validDate, shiftDate } = require('./history-dates');
const DAY = 86_400_000;
const normalize = value => typeof value === 'string' ? value.trim().toUpperCase().replace(/\s+/g, '') : '';
function domesticInstrument(item) {
  if (!['THAI_STOCK', 'MUTUAL_FUND'].includes(item.assetType) || item.currency !== 'THB') return null;
  const symbol = typeof item.symbol === 'string' ? item.symbol.trim() : '';
  if (!symbol || symbol.length > 120) return null;
  if (item.assetType === 'THAI_STOCK' && (!/^[A-Z0-9][A-Z0-9.-]{0,31}$/i.test(symbol)
    || (item.exchange && !['XBKK', 'SET', 'MAI'].includes(String(item.exchange).toUpperCase())))) return null;
  if (item.assetType === 'MUTUAL_FUND' && !/^[A-Z0-9][A-Z0-9 .()&+-]{0,119}$/i.test(symbol)) return null;
  return { assetType: item.assetType, symbol, normalized: normalize(symbol),
    providerSymbol: item.assetType === 'THAI_STOCK' ? symbol.toUpperCase() + '.BK' : null,
    key: item.assetType + ':' + normalize(symbol) + ':THB' };
}
const numeric = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const stampValid = (stamp, now) => Number.isSafeInteger(stamp) && stamp > 0 && stamp <= now + 60_000 && now - stamp < 7 * DAY;
const thaiDay = stamp => new Date(stamp + 7 * 3600000).toISOString().slice(0, 10);
function dailyChange(current, previous) {
  if (!numeric(previous)) return { change: null, changePercent: null };
  const difference = subtract(decimal(current), decimal(previous));
  return { change: number(difference, 8), changePercent: ratio(multiply(difference, decimal(100)), decimal(previous), 4) };
}
function previousTradingClose(chart, stamp, now) {
  const timestamps = chart?.timestamp;
  const closes = chart?.indicators?.quote?.[0]?.close;
  const empty = { previousClose: null, previousCloseDate: null };
  if (!Array.isArray(timestamps) || !Array.isArray(closes) || timestamps.length !== closes.length) return empty;
  // chartPreviousClose refers to the chart range baseline, not necessarily the
  // preceding trading session. Select the actual daily bar before the quote's Thai date.
  const candidates = timestamps.map((seconds, index) => ({ stamp: typeof seconds === 'number' ? seconds * 1000 : NaN,
    close: closes[index] })).filter(row => stampValid(row.stamp, now) && thaiDay(row.stamp) < thaiDay(stamp));
  if (!candidates.length) return empty;
  const date = candidates.map(row => thaiDay(row.stamp)).sort().at(-1);
  const rows = candidates.filter(row => thaiDay(row.stamp) === date);
  const hint = chart?.meta?.priceHint;
  // Yahoo candle closes may contain float32 noise (9.600000381 instead of 9.60).
  // Use only provider-declared display precision, never a guessed tick size.
  const values = rows.map(row => numeric(row.close)
    ? Number.isInteger(hint) && hint >= 0 && hint <= 8 ? number(decimal(row.close), hint) : row.close : null);
  const previousClose = values.every(numeric) && new Set(values).size === 1 ? values[0] : null;
  return { previousClose, previousCloseDate: date };
}
function createDomesticMarketService({ secApiKey = env.secApiKey, fetchData = globalThis.fetch, now = Date.now,
  thaiTtlMs = env.thaiPriceCacheTtlSeconds * 1000, navTtlMs = env.fundNavCacheTtlSeconds * 1000,
  maxEntries = 1000, maxPages = 5, timeoutMs = 5000 } = {}) {
  for (const setting of [thaiTtlMs, navTtlMs, maxEntries, maxPages, timeoutMs]) {
    if (!Number.isSafeInteger(setting) || setting <= 0) throw new Error('Invalid domestic market limits');
  }
  if (thaiTtlMs > DAY || navTtlMs > DAY || maxPages > 20) throw new Error('Domestic market limits too large');
  const yahoo = createProviderClient({ origin: 'https://query1.finance.yahoo.com', prefix: 'PRICE',
    fetchData, now, timeoutMs, perMinute: 20 });
  const sec = createProviderClient({ origin: 'https://api.sec.or.th', prefix: 'NAV',
    apiKey: secApiKey, fetchData, now, timeoutMs, perMinute: 30 });
  const stockCache = createPublicMarketCache({ now, ttlMs: thaiTtlMs, maxAgeMs: 3 * DAY, maxEntries });
  const navCache = createPublicMarketCache({ now, ttlMs: navTtlMs, maxAgeMs: 3 * DAY, maxEntries });
  const identityCache = createPublicMarketCache({ now, ttlMs: 7 * DAY, maxAgeMs: 7 * DAY, maxEntries });
  const historyCache = createHistoryRangeCache({ now });
  const failure = (target, error) => ({ status: 'UNAVAILABLE',
    source: target.assetType === 'THAI_STOCK' ? 'YAHOO_FINANCE' : 'SEC_OPEN_API',
    symbol: target.symbol, providerSymbol: target.providerSymbol, currency: 'THB',
    kind: target.assetType === 'THAI_STOCK' ? 'STOCK_PRICE' : 'NAV',
    price: null, priceAt: null, change: null, changePercent: null,
    ...(target.assetType === 'MUTUAL_FUND' ? { navPerUnit: null, navDate: null, previousNav: null, previousNavDate: null }
      : { previousClose: null, previousCloseDate: null }),
    errorCode: error.code, retryAt: new Date(error.retryAt).toISOString() });
  async function stock(target) {
    return stockCache(target.key, async () => {
      const data = await yahoo.get('/v8/finance/chart/' + encodeURIComponent(target.providerSymbol),
        { interval: '1d', range: '5d' });
      const chart = data?.chart?.result?.[0];
      const meta = chart?.meta;
      const stamp = typeof meta?.regularMarketTime === 'number' ? meta.regularMarketTime * 1000 : NaN;
      if (data?.chart?.error || meta?.symbol !== target.providerSymbol || meta?.currency !== 'THB'
        || !['SET', 'BKK'].includes(meta?.exchangeName) || meta?.instrumentType !== 'EQUITY'
        || !numeric(meta?.regularMarketPrice) || !stampValid(stamp, now())) throw yahoo.error('PRICE_NOT_AVAILABLE');
      const previous = previousTradingClose(chart, stamp, now());
      return { status: 'AVAILABLE', source: 'YAHOO_FINANCE', kind: 'STOCK_PRICE', symbol: target.symbol,
        providerSymbol: target.providerSymbol, providerExchange: meta.exchangeName, currency: 'THB',
        price: meta.regularMarketPrice, priceAt: new Date(stamp).toISOString(),
        ...previous, ...dailyChange(meta.regularMarketPrice, previous.previousClose),
        cachePolicy: 'FIXED_TTL', marketOpen: null, session: 'PROVIDER_QUOTE',
        dataDelayMinutes: typeof meta.exchangeDataDelayedBy === 'number' && Number.isFinite(meta.exchangeDataDelayedBy)
          && meta.exchangeDataDelayedBy >= 0 ? meta.exchangeDataDelayedBy : null };
    }, error => failure(target, error), value => stampValid(Date.parse(value.priceAt), now()));
  }
  async function pages(path, params) {
    const rows = [];
    let cursor = '';
    const seen = new Set();
    for (let page = 0; page < maxPages; page++) {
      const data = await sec.get(path, { ...params, page_size: '100', ...(cursor ? { next_cursor: cursor } : {}) });
      if (data === null) return rows;
      if (!Array.isArray(data?.items) || data.items.length > 100
        || !Object.hasOwn(data, 'next_cursor') || (data.next_cursor !== null && typeof data.next_cursor !== 'string')
        || (data.message && String(data.message).toLowerCase() !== 'success')) throw sec.error('NAV_RESPONSE_INVALID');
      rows.push(...data.items);
      cursor = data.next_cursor || '';
      if (!cursor) return rows;
      if (cursor.length > 4096 || seen.has(cursor)) throw sec.error('NAV_LOOKUP_INCOMPLETE');
      seen.add(cursor);
    }
    throw sec.error('NAV_LOOKUP_INCOMPLETE');
  }
  function matchingIdentities(rows, target) {
    const matches = new Map();
    for (const row of rows) {
      if (!/^M\d+_\d{4}$/.test(row?.proj_id || '') || row?.fund_status !== 'Registered'
        || typeof row.fund_class_name !== 'string') continue;
      const name = normalize(row.fund_class_name);
      const nonClass = ['', '-', 'MAIN'].includes(name);
      if ((!nonClass && name === target.normalized) || (nonClass && normalize(row.proj_abbr_name) === target.normalized)) {
        const key = row.proj_id + ':' + name;
        const old = matches.get(key);
        const amcId = /^C\d{10}$/.test(row.unique_id || '') ? row.unique_id : null;
        const amcNameEn = typeof row.comp_name_en === 'string' && row.comp_name_en.trim().length <= 300
          ? row.comp_name_en.trim() : null;
        matches.set(key, { projectId: row.proj_id, fundClassName: row.fund_class_name,
          projectAbbreviation: row.proj_abbr_name, currency: 'THB', amcId, amcNameEn,
          amcAmbiguous: Boolean(old?.amcAmbiguous || (old && (old.amcId !== amcId || old.amcNameEn !== amcNameEn))) });
      }
    }
    return [...matches.values()];
  }
  async function identity(target) {
    const result = await identityCache(target.key, async () => {
      const queries = [{ fund_class_name: target.symbol }];
      if (target.normalized !== target.symbol) queries.push({ fund_class_name: target.normalized });
      queries.push({ project_info: target.symbol });
      for (const query of queries) {
        const rows = await pages('/v2/fund/general-info/profiles', { ...query, fund_status: 'Registered' });
        const matches = matchingIdentities(rows, target);
        if (matches.length > 1) throw sec.error('NAV_FUND_AMBIGUOUS');
        if (matches.length === 1) return { status: 'AVAILABLE', ...matches[0] };
      }
      throw sec.error('NAV_FUND_NOT_FOUND');
    }, error => ({ status: 'UNAVAILABLE', errorCode: error.code, retryAt: new Date(error.retryAt).toISOString() }));
    if (result.status !== 'AVAILABLE') throw sec.error(result.errorCode, Date.parse(result.retryAt));
    return result;
  }
  const thaiDate = () => {
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' });
    const p = Object.fromEntries(date.formatToParts(now()).map(part => [part.type, part.value]));
    return p.year + '-' + p.month + '-' + p.day;
  };
  function validNavDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const time = Date.parse(value + 'T00:00:00Z');
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value
      && value <= thaiDate() && Date.parse(thaiDate() + 'T00:00:00Z') - time <= 14 * DAY;
  }
  async function nav(target) {
    return navCache(target.key, async () => {
      const fund = await identity(target);
      const end = thaiDate();
      const start = new Date(Date.parse(end + 'T00:00:00Z') - 14 * DAY).toISOString().slice(0, 10);
      const rows = await pages('/v2/fund/daily-info/nav', { proj_id: fund.projectId,
        fund_class_name: fund.fundClassName, start_nav_date: start, end_nav_date: end });
      const candidates = rows.filter(row => row?.proj_id === fund.projectId
        && normalize(row.fund_class_name) === normalize(fund.fundClassName)
        && validNavDate(row.nav_date));
      if (!candidates.length) throw sec.error('NAV_NOT_AVAILABLE');
      const latestDate = candidates.map(row => row.nav_date).sort().at(-1);
      const latest = candidates.filter(row => row.nav_date === latestDate);
      // A bad latest value or conflicting duplicate must not silently become an older NAV.
      if (latest.some(row => !numeric(row.last_val)) || new Set(latest.map(row => row.last_val)).size !== 1) {
        throw sec.error('NAV_RESPONSE_INVALID');
      }
      const row = latest[0];
      const previousNavDate = candidates.map(item => item.nav_date).filter(date => date < latestDate).sort().at(-1) || null;
      const previousRows = candidates.filter(item => item.nav_date === previousNavDate);
      const previousNav = previousRows.length && previousRows.every(item => numeric(item.last_val))
        && new Set(previousRows.map(item => item.last_val)).size === 1 ? previousRows[0].last_val : null;
      return { status: 'AVAILABLE', source: 'SEC_OPEN_API', kind: 'NAV', symbol: target.symbol,
        providerSymbol: fund.fundClassName, projectId: fund.projectId, fundClassName: fund.fundClassName,
        currency: 'THB', price: row.last_val, navPerUnit: row.last_val, priceAt: null, navDate: row.nav_date,
        previousNav, previousNavDate, ...dailyChange(row.last_val, previousNav),
        providerUpdatedAt: typeof row.last_upd_date === 'string' && Number.isFinite(Date.parse(row.last_upd_date))
          ? new Date(row.last_upd_date).toISOString() : null, cachePolicy: 'PUBLISHED_NAV_TTL' };
    }, error => failure(target, error), value => validNavDate(value.navDate));
  }
  return {
    thaiCacheTtlSeconds: thaiTtlMs / 1000, navCacheTtlSeconds: navTtlMs / 1000,
    async getFundIdentity(item) {
      const target = item.assetType === 'MUTUAL_FUND' ? domesticInstrument(item) : null;
      if (!target) throw sec.error('NAV_FUND_NOT_FOUND');
      return identity(target);
    },
    async getFundDailyHistory(item, start, end) {
      validateHistoryRange(start, end);
      const target = domesticInstrument(item);
      if (!target || item.assetType !== 'MUTUAL_FUND') return { status: 'UNAVAILABLE', source: 'SEC_OPEN_API',
        errorCode: 'HISTORY_INSTRUMENT_UNSUPPORTED', points: [] };
      return historyCache(target.key, start, end, async (start, end) => {
        const fund = await identity(target);
        const points = [];
        // Annual chunks fit the bounded existing SEC pagination budget.
        for (let from = start; from <= end;) {
          const to = shiftDate(from, 364) < end ? shiftDate(from, 364) : end;
          const rows = await pages('/v2/fund/daily-info/nav', { proj_id: fund.projectId,
            fund_class_name: fund.fundClassName, start_nav_date: from, end_nav_date: to });
          for (const row of rows) {
            if (row?.proj_id !== fund.projectId || normalize(row.fund_class_name) !== normalize(fund.fundClassName)) continue;
            if (!validDate(row.nav_date) || !numeric(row.last_val)) throw sec.error('HISTORY_RESPONSE_INVALID');
            if (row.nav_date >= from && row.nav_date <= to) points.push({ date: row.nav_date, price: row.last_val });
          }
          from = shiftDate(to, 1);
        }
        return { status: 'AVAILABLE', source: 'SEC_OPEN_API', currency: 'THB', points };
      }, error => historyFailure('SEC_OPEN_API', error));
    },
    async getQuotes(items) {
      const targets = new Map();
      for (const item of items) {
        if (typeof item.quantity !== 'number' || !Number.isFinite(item.quantity) || item.quantity <= 0) continue;
        const target = domesticInstrument(item);
        if (target) targets.set(target.key, target);
      }
      const quotes = new Map();
      for (const [key, target] of targets) quotes.set(key, await (target.assetType === 'THAI_STOCK' ? stock(target) : nav(target)));
      return quotes;
    },
  };
}
const domesticMarketService = createDomesticMarketService();
module.exports = { domesticMarketService, createDomesticMarketService, domesticInstrument };
