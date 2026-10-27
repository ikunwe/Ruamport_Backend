// Real public Finnhub metadata, synthetic historical position. No database access.
// node --use-system-ca --env-file=.env scripts/verification/verify-moved-stock-logo.cjs
const { createStockPriceService, instrument } = require('../../src/modules/trades/stock-price.service');
(async () => {
  const requests = [];
  let profile;
  let currentListings;
  const prices = createStockPriceService({ fetchQuote: async (input, init) => {
    const url = new URL(input);
    const response = await fetch(input, init);
    // Never print API keys, request headers, redirect URLs or signed queries.
    requests.push({ kind: url.pathname.endsWith('/stock/profile2') ? 'PROFILE'
      : url.pathname.endsWith('/stock/symbol') || url.pathname.endsWith('/USf.json') ? 'CATALOG' : 'OTHER',
    httpStatus: response.status });
    if (response.ok && requests.at(-1).kind !== 'OTHER') {
      const data = await response.clone().json();
      if (Array.isArray(data)) currentListings = data.filter(row => row.symbol === 'QS')
        .map(({ symbol, mic, currency, type }) => ({ symbol, mic, currency, type }));
      else if (requests.at(-1).kind === 'PROFILE') profile = { ticker: data.ticker, currency: data.currency, exchange: data.exchange };
    }
    return response;
  } });
  const item = { assetType: 'OFFSHORE_STOCK', symbol: 'QS', exchange: 'XNYS', currency: 'USD', quantity: 0, status: 'CLOSED' };
  const original = structuredClone(item);
  const logo = (await prices.getLogos([item], { includeClosed: true })).get(instrument(item).key);
  const beforeRepeat = requests.length;
  const repeated = (await prices.getLogos([item], { includeClosed: true })).get(instrument(item).key);
  // Strict price check must reject the old market before sending /quote.
  const oldMarketQuote = (await prices.getQuotes([{ ...item, quantity: 1 }])).get(instrument(item).key);
  let imageCheck = null;
  if (logo?.status === 'AVAILABLE') {
    try {
      let imageUrl = new URL(logo.url);
      for (let hop = 0; hop < 3; hop++) {
        const image = await fetch(imageUrl, { signal: AbortSignal.timeout(10000), redirect: 'manual' });
        const status = image.status;
        const location = image.headers.get('location');
        imageCheck = { httpStatus: status, contentType: image.headers.get('content-type'), redirected: hop > 0 };
        await image.body?.cancel();
        if (![301, 302, 303, 307, 308].includes(status) || !location) break;
        const next = new URL(location, imageUrl);
        if (next.protocol !== 'https:' || next.username || next.password || next.port || next.search || next.hash
          || !['finnhub.io', 'static.finnhub.io', 'static2.finnhub.io', 'static9.finnhub.io'].includes(next.hostname)
          || !next.pathname.startsWith('/file/')) break;
        imageUrl = next;
      }
    } catch { imageCheck = { available: false }; }
  }
  console.log(JSON.stringify({ mode: 'REAL_QS_LOGO_SYNTHETIC_POSITION_NO_DATABASE', currentListings, profile, logo,
    repeatAdditionalRequests: requests.length - beforeRepeat, repeatedFromCache: repeated?.fromCache,
    oldMarketPriceStatus: oldMarketQuote?.status, oldMarketPriceError: oldMarketQuote?.errorCode,
    originalPositionUnchanged: JSON.stringify(item) === JSON.stringify(original), imageCheck, requests }, null, 2));
  if (logo?.status !== 'AVAILABLE' || logo.listingResolution?.type !== 'CURRENT_LISTING_FOR_LOGO'
    || oldMarketQuote?.status !== 'UNAVAILABLE' || requests.length !== beforeRepeat
    || requests.some(row => row.kind === 'OTHER') || JSON.stringify(item) !== JSON.stringify(original)
    || imageCheck?.httpStatus !== 200 || !imageCheck.contentType?.startsWith('image/')) process.exitCode = 1;
})().catch(() => { console.error('Moved-stock logo verification failed; private/upstream details omitted'); process.exitCode = 1; });
