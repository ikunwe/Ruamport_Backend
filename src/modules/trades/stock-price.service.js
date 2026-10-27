const { env } = require('../../config/env');
const { usMarketSchedule } = require('./us-market-calendar');

const DAY = 86_400_000;
const NASDAQ_MICS = new Set(['XNAS', 'XNGS', 'XNMS', 'XNCM']);
const SUPPORTED_MICS = new Set([...NASDAQ_MICS, 'XNYS', 'ARCX', 'XASE', 'BATS']);
// Confirmed issuer profiles returned by Finnhub for these US ADR requests.
// This mapping is ONLY for company logos, never price identity/currency.
const ADR_PROFILE_TICKERS = Object.freeze({ ASML: 'ASML.AS', TSM: '2330.TW' });
const micFamily = mic => NASDAQ_MICS.has(mic) ? 'XNAS' : mic;
function logoProfileMarket(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim().toUpperCase();
  if (/^NASDAQ(?:\b|$)/.test(name)) return 'XNAS';
  if (/^(?:NYSE ARCA|ARCA)(?:\b|$)/.test(name)) return 'ARCX';
  if (/^(?:NYSE AMERICAN|NYSE MKT|AMEX)(?:\b|$)/.test(name)) return 'XASE';
  if (/^(?:NYSE|NEW YORK STOCK EXCHANGE)(?:\b|$)/.test(name)) return 'XNYS';
  if (/^(?:BATS|CBOE)(?:\b|$)/.test(name)) return 'BATS';
  return null;
}
const copy = value => structuredClone(value);
function instrument(item) {
  if (item.assetType !== 'OFFSHORE_STOCK' || item.currency !== 'USD') return null;
  const symbol = typeof item.symbol === 'string' ? item.symbol.trim().toUpperCase() : '';
  const micCode = typeof item.exchange === 'string' ? item.exchange.trim().toUpperCase() : '';
  if (!/^[A-Z0-9][A-Z0-9.-]{0,31}$/.test(symbol) || !SUPPORTED_MICS.has(micCode)) return null;
  return { symbol, micCode, currency: 'USD', key: micCode + ':' + symbol + ':USD' };
}
function regularUsHours(time) {
  return usMarketSchedule(time).state === 'OPEN';
}

function createStockPriceService({ apiKey = env.finnhubApiKey, fetchQuote = globalThis.fetch, now = Date.now,
  ttlMs = env.stockPriceCacheTtlSeconds * 1000, perMinute = env.finnhubCallsPerMinute,
  perDay = env.finnhubCallsPerDay, timeoutMs = 5000, catalogTimeoutMs = 20000, maxEntries = 2000,
  logoTtlMs = env.stockLogoCacheTtlSeconds * 1000, newsTtlMs = env.stockNewsCacheTtlSeconds * 1000 } = {}) {
  for (const value of [ttlMs, logoTtlMs, newsTtlMs, perMinute, timeoutMs, catalogTimeoutMs, maxEntries]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Market data limits must be positive integers');
  }
  if (!Number.isSafeInteger(perDay) || perDay < 0) throw new Error('Daily limit must be non-negative');
  if (catalogTimeoutMs > 30000) throw new Error('Catalog timeout too large');
  if (ttlMs > 3 * DAY || logoTtlMs > 30 * DAY || newsTtlMs > DAY) throw new Error('Market data TTL too large');
  const cache = new Map();
  const pending = new Map();
  let catalog;
  let catalogPending;
  let attempts = [];
  let day;
  let usedToday = 0;
  let blockedUntil = 0;
  let blockedReason = 'RATE_LIMITED';
  const iso = time => time ? new Date(time).toISOString() : null;
  function quoteCacheInfo(value, time) {
    const marketSchedule = usMarketSchedule(time);
    const fetchedMs = Date.parse(value.fetchedAt);
    const requestedMs = Date.parse(value.requestedAt);
    let expiresMs = fetchedMs + ttlMs;
    let cachePolicy = 'CALENDAR_FALLBACK_TTL';
    let postCloseRefreshPending = false;
    let pricePending = false;
    if (marketSchedule.state === 'OPEN') {
      cachePolicy = 'MARKET_OPEN_TTL';
      expiresMs = requestedMs < Date.parse(marketSchedule.sessionOpenAt) ? Date.parse(marketSchedule.sessionOpenAt)
        : Math.min(expiresMs, Date.parse(marketSchedule.sessionCloseAt));
    } else if (marketSchedule.state === 'CLOSED') {
      const close = Date.parse(marketSchedule.lastCloseAt);
      const nextOpen = Date.parse(marketSchedule.nextOpenAt);
      const ready = close + 5 * 60_000;
      cachePolicy = 'POST_CLOSE_REFRESH_PENDING';
      postCloseRefreshPending = true;
      if (requestedMs < close) expiresMs = Math.min(expiresMs, close);
      else if (requestedMs < ready) expiresMs = Math.min(ready, nextOpen);
      else if (Date.parse(value.priceAt) < close - 60_000) {
        // A provider may still return the previous day's price. Don't lock it.
        pricePending = true;
        expiresMs = Math.min(expiresMs, nextOpen);
      } else {
        cachePolicy = 'MARKET_CLOSED_UNTIL_OPEN';
        postCloseRefreshPending = false;
        expiresMs = nextOpen;
      }
    }
    return { expiresMs, cachePolicy, marketSchedule, postCloseRefreshPending, pricePending };
  }
  function fault(reason, retryAt = now() + 60_000) {
    return Object.assign(new Error('Market data unavailable'), { reason, retryAt });
  }
  function reserve() {
    const time = now();
    const today = new Date(time).toISOString().slice(0, 10);
    if (day !== today) { day = today; usedToday = 0; }
    attempts = attempts.filter(at => time - at < 60_000);
    if (time < blockedUntil) throw fault(blockedReason, blockedUntil);
    if (perDay && usedToday >= perDay) throw fault('DAILY_LIMIT', Date.parse(today + 'T00:00:00Z') + DAY);
    if (attempts.length >= perMinute) throw fault('RATE_LIMITED', attempts[0] + 60_000);
    const second = attempts.filter(at => time - at < 1000);
    if (second.length >= 30) throw fault('RATE_LIMITED', second[0] + 1000);
    attempts.push(time);
    usedToday++;
  }
  async function request(path, params) {
    if (!apiKey?.trim()) throw fault('CONFIG_MISSING', null);
    reserve();
    const isCatalog = path === 'stock/symbol' && params.exchange === 'US';
    let signal;
    try {
      const url = new URL('https://finnhub.io/api/v1/' + path);
      url.search = new URLSearchParams(params).toString();
      // The large US catalog needs a larger cold-start budget, including its
      // allowlisted redirect and JSON body. Individual quotes keep their short timeout.
      signal = AbortSignal.timeout(isCatalog ? catalogTimeoutMs : timeoutMs);
      let response = await fetchQuote(url.toString(), {
        headers: { Accept: 'application/json', 'X-Finnhub-Token': apiKey },
        signal, redirect: isCatalog ? 'manual' : 'error',
      });
      if (isCatalog && [301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers?.get?.('location');
        if (typeof location !== 'string' || location.length > 8192) throw fault('NOT_AVAILABLE');
        const destination = new URL(location, url);
        // Finnhub's signed catalog lives on this exact static endpoint. Never
        // forward X-Finnhub-Token or allow an arbitrary host/path/redirect chain.
        if (destination.origin !== 'https://static2.finnhub.io'
          || destination.username || destination.password || destination.hash
          || destination.pathname !== '/file/privatedatany2/exchange/USf.json'
          || destination.searchParams.getAll('Authorization').length !== 1
          || !destination.searchParams.get('Authorization')
          || [...destination.searchParams.keys()].some(key => key !== 'Authorization')) throw fault('NOT_AVAILABLE');
        await response.body?.cancel();
        reserve(); // Count the extra outbound hop in the same application budget.
        response = await fetchQuote(destination.toString(), {
          headers: { Accept: 'application/json' }, signal, redirect: 'error',
        });
      }
      if (!response.ok) {
        const reason = response.status === 429 ? 'RATE_LIMITED'
          : [401, 403].includes(response.status) ? 'ACCESS_DENIED' : 'NOT_AVAILABLE';
        const retryHeader = response.headers?.get?.('retry-after');
        const seconds = typeof retryHeader === 'string' && /^\d+$/.test(retryHeader) ? Number(retryHeader) : NaN;
        const headerTime = Number.isFinite(seconds) ? now() + seconds * 1000 : Date.parse(retryHeader);
        const retryAt = now() + (reason === 'ACCESS_DENIED' ? 300_000 : 60_000);
        const retry = Number.isFinite(headerTime) ? Math.max(retryAt, Math.min(headerTime, now() + DAY)) : retryAt;
        if (['RATE_LIMITED', 'ACCESS_DENIED'].includes(reason)) { blockedUntil = retry; blockedReason = reason; }
        throw fault(reason, retry);
      }
      const row = await response.json();
      if (row && !Array.isArray(row) && typeof row.error === 'string') throw fault('NOT_AVAILABLE');
      return row;
    } catch (error) {
      // Never expose/log upstream messages, URLs, headers or the secret.
      if (error.reason) throw error;
      if (isCatalog && signal?.aborted) throw fault('CATALOG_TIMEOUT');
      throw fault('NOT_AVAILABLE');
    }
  }
  function put(key, entry) {
    cache.delete(key);
    cache.set(key, entry);
    while (cache.size > maxEntries) {
      const removable = [...cache.keys()].find(candidate => !pending.has(candidate));
      if (!removable) break;
      cache.delete(removable);
    }
  }
  async function listings() {
    if (catalog?.rows && now() < catalog.expires) return catalog.rows;
    if (catalogPending) return catalogPending;
    if (catalog?.retryAt > now()) throw fault(catalog.reason, catalog.retryAt);
    catalogPending = (async () => {
      try {
        const rows = await request('stock/symbol', { exchange: 'US' });
        if (!Array.isArray(rows) || !rows.length || rows.length > 100_000) throw fault('NOT_AVAILABLE');
        // Currency is listing currency, not profile2's company-filings currency.
        const indexed = new Map();
        for (const row of rows) {
          if (typeof row?.symbol !== 'string' || typeof row?.mic !== 'string' || row.currency !== 'USD') continue;
          const key = row.symbol.toUpperCase();
          const group = indexed.get(key) || [];
          group.push({ mic: row.mic.toUpperCase(), exchange: row.description || null,
            securityType: typeof row.type === 'string' ? row.type : null });
          indexed.set(key, group);
        }
        if (!indexed.size) throw fault('NOT_AVAILABLE');
        catalog = { rows: indexed, expires: now() + DAY };
        return indexed;
      } catch (error) {
        // Do not validate identity against expired metadata after a failed refresh.
        catalog = { reason: error.reason, retryAt: error.retryAt };
        throw error;
      }
    })();
    try { return await catalogPending; } finally { catalogPending = null; }
  }
  async function listing(target) {
    const rows = (await listings()).get(target.symbol) || [];
    const match = rows.find(row => row.mic === target.micCode
      || (target.micCode === 'XNAS' && NASDAQ_MICS.has(row.mic)));
    if (!match) throw fault('NOT_AVAILABLE');
    return match;
  }
  function safeUrl(value, logo = false) {
    if (typeof value !== 'string' || value.length > 2048 || (apiKey && value.includes(apiKey))) return null;
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || url.port
        || !url.hostname.includes('.') || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(url.hostname)
        || url.hostname.endsWith('.local') || url.hostname.endsWith('.internal')
        || /(?:token|api[_-]?key)=/i.test(url.search)) return null;
      if (logo && (!['static.finnhub.io', 'static2.finnhub.io', 'finnhub.io'].includes(url.hostname)
        || url.search || url.hash || !url.pathname.startsWith('/file/'))) return null;
      return url.toString();
    } catch { return null; }
  }
  function failure(target, kind, error) {
    const reason = error.reason || 'NOT_AVAILABLE';
    return { status: 'UNAVAILABLE', source: 'FINNHUB', symbol: target.symbol, micCode: target.micCode,
      ...(kind === 'PRICE' ? { currency: 'USD', price: null, priceAt: null, previousClose: null, change: null, changePercent: null }
        : kind === 'LOGO' ? { url: null } : { items: [] }),
      errorCode: reason === 'CONFIG_MISSING' ? 'MARKET_DATA_CONFIG_MISSING' : kind + '_' + reason,
      retryAt: iso(error.retryAt) };
  }
  async function cached(target, kind, key, ttl, maxAge, load) {
    const previous = cache.get(key);
    const info = kind === 'PRICE' && previous?.value ? quoteCacheInfo(previous.value, now()) : null;
    const plannedClosedCache = info?.cachePolicy === 'MARKET_CLOSED_UNTIL_OPEN' && now() < info.expiresMs;
    const valid = previous?.value && now() - previous.fetchedMs < (plannedClosedCache ? 7 * DAY : maxAge)
      && (kind !== 'PRICE' || now() - Date.parse(previous.value.priceAt) < 7 * DAY);
    function present(value, fromCache, forceStale = false) {
      if (kind !== 'PRICE') return { ...copy(value), fromCache, isStale: forceStale };
      const policy = quoteCacheInfo(value, now());
      return { ...copy(value), expiresAt: iso(policy.expiresMs), fromCache,
        isStale: forceStale || policy.pricePending || now() >= policy.expiresMs,
        cachePolicy: policy.cachePolicy, marketSchedule: policy.marketSchedule,
        postCloseRefreshPending: policy.postCloseRefreshPending,
        ...(policy.pricePending ? { warning: 'POST_CLOSE_PRICE_PENDING' } : {}) };
    }
    function fallback(error) {
      return valid ? { ...present(previous.value, true, true),
        warning: error.reason === 'CONFIG_MISSING' ? 'MARKET_DATA_CONFIG_MISSING' : kind + '_' + error.reason,
        retryAt: iso(error.retryAt) } : failure(target, kind, error);
    }
    if (valid && now() < (info?.expiresMs ?? previous.fetchedMs + ttl)) return present(previous.value, true);
    if (pending.has(key)) return copy(await pending.get(key));
    if (previous?.retryAt > now()) return fallback(previous);
    const work = (async () => {
      try {
        const data = await load();
        const fetchedMs = now();
        let value = { status: 'AVAILABLE', source: 'FINNHUB', symbol: target.symbol, micCode: target.micCode,
          ...data, fetchedAt: iso(fetchedMs), expiresAt: iso(fetchedMs + ttl), fromCache: false, isStale: false };
        value = present(value, false);
        put(key, { value, fetchedMs });
        return value;
      } catch (error) {
        const safe = { reason: error.reason || 'NOT_AVAILABLE', retryAt: error.retryAt ?? now() + 60_000 };
        put(key, { ...(valid ? previous : {}), ...safe });
        return fallback(safe);
      }
    })();
    pending.set(key, work);
    try { return copy(await work); } finally { pending.delete(key); }
  }
  function getQuote(target) {
    return cached(target, 'PRICE', 'price:' + target.key, ttlMs, 3 * DAY, async () => {
      const identity = await listing(target);
      const requestedMs = now();
      const row = await request('quote', { symbol: target.symbol });
      const stamp = typeof row?.t === 'number' ? row.t * 1000 : NaN;
      if (typeof row?.c !== 'number' || !Number.isFinite(row.c) || row.c <= 0
        || !Number.isSafeInteger(stamp) || stamp <= 0 || stamp > now() + 60_000 || now() - stamp >= 7 * DAY) throw fault('NOT_AVAILABLE');
      return { currency: 'USD', price: row.c, priceAt: iso(stamp), requestedAt: iso(requestedMs), providerMicCode: identity.mic,
        previousClose: typeof row.pc === 'number' && Number.isFinite(row.pc) && row.pc > 0 ? row.pc : null,
        change: typeof row.d === 'number' && Number.isFinite(row.d) ? row.d : null,
        changePercent: typeof row.dp === 'number' && Number.isFinite(row.dp) ? row.dp : null,
        providerExchange: null, interval: null, session: 'PROVIDER_QUOTE', marketOpen: null };
    });
  }
  function getLogo(target) {
    return cached(target, 'LOGO', 'logo:' + target.key, logoTtlMs, 30 * DAY, async () => {
      const rows = (await listings()).get(target.symbol) || [];
      let identity = rows.find(row => row.mic === target.micCode
        || (target.micCode === 'XNAS' && NASDAQ_MICS.has(row.mic)));
      const resolvesCurrentMarket = !identity;
      if (resolvesCurrentMarket) {
        // Logo-only fallback, never used by quote/news identity checks. A
        // unique current US/USD listing must also agree with profile2 below.
        const candidates = rows.filter(row => SUPPORTED_MICS.has(row.mic));
        if (!candidates.length) throw fault('IDENTITY_UNVERIFIED');
        if (new Set(candidates.map(row => micFamily(row.mic))).size !== 1
          || new Set(candidates.map(row => row.securityType)).size !== 1) throw fault('IDENTITY_AMBIGUOUS');
        if (!['Common Stock', 'ADR', 'REIT', 'Preferred Stock', 'Closed-End Fund', 'Limited Partnership', 'ETP']
          .includes(candidates[0].securityType)) throw fault('IDENTITY_UNVERIFIED');
        identity = candidates[0];
      }
      const row = await request('stock/profile2', { symbol: target.symbol });
      if (row?.ticker !== target.symbol && row?.ticker !== ADR_PROFILE_TICKERS[target.symbol]) throw fault('NOT_AVAILABLE');
      if (typeof row?.ticker !== 'string' || !row.ticker) throw fault('NOT_AVAILABLE');
      if (resolvesCurrentMarket && (row.ticker !== target.symbol || row.currency !== 'USD'
        || logoProfileMarket(row.exchange) !== micFamily(identity.mic))) throw fault('IDENTITY_UNVERIFIED');
      if (!row.logo) throw fault('NOT_FOUND', now() + DAY);
      const url = safeUrl(row.logo, true);
      if (!url) throw fault('NOT_AVAILABLE');
      return { url, providerSymbol: row.ticker, providerMicCode: identity.mic,
        listingResolution: resolvesCurrentMarket ? { type: 'CURRENT_LISTING_FOR_LOGO',
          source: 'FINNHUB_CATALOG_AND_PROFILE', fromMic: target.micCode, toMic: identity.mic,
          verifiedAt: iso(now()), effectiveDate: null, pdfMarketPreserved: true } : null };
    });
  }
  function getNews(item) {
    const target = instrument(item);
    if (!target || !(item.quantity > 0)) throw new Error('News requires a held offshore USD instrument');
    const to = new Date(now()).toISOString().slice(0, 10);
    const from = new Date(Date.parse(to + 'T00:00:00Z') - 6 * DAY).toISOString().slice(0, 10);
    const range = { from, to };
    return cached(target, 'NEWS', 'news:' + target.key + ':' + from + ':' + to, newsTtlMs, DAY, async () => {
      await listing(target);
      const rows = await request('company-news', { symbol: target.symbol, ...range });
      if (!Array.isArray(rows)) throw fault('NOT_AVAILABLE');
      const seen = new Set();
      const items = [];
      for (const row of rows) {
        const stamp = typeof row?.datetime === 'number' ? row.datetime * 1000 : NaN;
        const url = safeUrl(row?.url);
        const related = typeof row?.related === 'string' ? row.related.split(',').map(s => s.trim().toUpperCase()).filter(Boolean) : [];
        if (!url || typeof row.headline !== 'string' || !row.headline.trim()
          || !Number.isSafeInteger(stamp) || stamp < Date.parse(from + 'T00:00:00Z') || stamp > now() + 60_000
          || (related.length && !related.includes(target.symbol))) continue;
        const id = Number.isSafeInteger(row.id) ? String(row.id) : url;
        if (seen.has(id) || seen.has(url)) continue;
        seen.add(id); seen.add(url);
        items.push({ id, headline: row.headline.slice(0, 500), source: typeof row.source === 'string' ? row.source.slice(0, 100) : null,
          publishedAt: iso(stamp), url, imageUrl: safeUrl(row.image),
          summary: typeof row.summary === 'string' ? row.summary.slice(0, 1000) : null, relatedSymbols: related.slice(0, 50) });
      }
      items.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
      return { ...range, items: items.slice(0, 50) };
    }).then(result => ({ ...range, ...result }));
  }
  function targetsFor(items, includeClosed = false) {
    const targets = new Map();
    for (const item of items) {
      if (typeof item.quantity !== 'number' || !Number.isFinite(item.quantity)
        || item.quantity < 0 || (item.quantity === 0 && !includeClosed)) continue;
      const target = instrument(item);
      if (target) targets.set(target.key, target);
    }
    return targets;
  }
  return {
    cacheTtlSeconds: ttlMs / 1000, logoCacheTtlSeconds: logoTtlMs / 1000, newsCacheTtlSeconds: newsTtlMs / 1000,
    async getQuotes(items) {
      const results = new Map();
      for (const [key, target] of targetsFor(items)) results.set(key, await getQuote(target));
      return results;
    },
    async getLogos(items, { includeClosed = false } = {}) {
      const results = new Map();
      // Historical decoration only. Quotes/news keep their positive-quantity gate.
      for (const [key, target] of targetsFor(items, includeClosed === true)) results.set(key, await getLogo(target));
      return results;
    },
    async getHistoricalListingIdentity(item) {
      // Graph-only corroboration, not proof of a historical transfer date.
      // Quote/news checks stay strict; logo fallback is implemented separately.
      const target = instrument(item);
      if (!target) return { status: 'UNAVAILABLE', errorCode: 'HISTORY_IDENTITY_UNSUPPORTED' };
      try {
        const rows = (await listings()).get(target.symbol) || [];
        const eligible = rows.filter(row => SUPPORTED_MICS.has(row.mic));
        const family = mic => NASDAQ_MICS.has(mic) ? 'XNAS' : mic;
        if (!eligible.length || new Set(eligible.map(row => family(row.mic))).size !== 1)
          return { status: 'UNAVAILABLE', errorCode: 'HISTORY_IDENTITY_AMBIGUOUS' };
        const kind = row => row.securityType === 'ETP' ? 'ETF'
          : ['Common Stock', 'ADR', 'REIT', 'Preferred Stock', 'Closed-End Fund', 'Limited Partnership'].includes(row.securityType) ? 'EQUITY' : null;
        if (!kind(eligible[0]) || new Set(eligible.map(kind)).size !== 1)
          return { status: 'UNAVAILABLE', errorCode: 'HISTORY_IDENTITY_TYPE_UNAVAILABLE' };
        return { status: 'AVAILABLE', source: 'FINNHUB_LISTING_CATALOG', symbol: target.symbol,
          currency: 'USD', micCode: eligible[0].mic, instrumentType: kind(eligible[0]), verifiedAt: iso(now()) };
      } catch (error) {
        return { status: 'UNAVAILABLE', errorCode: 'HISTORY_IDENTITY_' + (error.reason || 'NOT_AVAILABLE') };
      }
    },
    getNews,
  };
}
const stockPriceService = createStockPriceService();
module.exports = { createStockPriceService, stockPriceService, instrument, regularUsHours };
