// Read-only cold-cache diagnostic. No database or raw URLs/headers/provider bodies logged.
// node --use-system-ca --env-file=.env scripts/verification/verify-finnhub.cjs
const { createStockPriceService, instrument } = require('../../src/modules/trades/stock-price.service');
const listings = [['ASML', 'XNAS'], ['GOOGL', 'XNAS'], ['NVDA', 'XNAS'], ['RKLB', 'XNAS'],
  ['SPCX', 'XNAS'], ['TSLA', 'XNAS'], ['TSM', 'XNYS']];
(async () => {
  const started = Date.now();
  let calls = 0;
  const service = createStockPriceService({ fetchQuote: async (input, init) => {
    const url = new URL(input);
    const start = Date.now();
    calls++;
    try {
      const response = await fetch(input, init);
      console.log(JSON.stringify({ stage: url.pathname, status: response.status, headersAfterMs: Date.now() - start }));
      return response;
    } catch (error) {
      console.log(JSON.stringify({ stage: url.pathname, error: error.name, elapsedMs: Date.now() - start }));
      throw error;
    }
  } });
  const items = listings.map(([symbol, exchange]) => ({ assetType: 'OFFSHORE_STOCK', currency: 'USD', quantity: 1, symbol, exchange }));
  const quotes = await service.getQuotes(items);
  const logos = await service.getLogos(items);
  let missing = 0;
  for (const item of items) {
    const key = instrument(item).key;
    const quote = quotes.get(key);
    const logo = logos.get(key);
    if (quote.status !== 'AVAILABLE') missing++;
    console.log(JSON.stringify({ symbol: item.symbol, quote: quote.status, price: quote.price,
      priceAt: quote.priceAt, errorCode: quote.errorCode, retryAt: quote.retryAt,
      logo: logo.status, logoError: logo.errorCode }));
  }
  const before = calls;
  await service.getQuotes(items);
  await service.getLogos(items);
  console.log(JSON.stringify({ elapsedMs: Date.now() - started, calls, missingPrices: missing, repeatAdditionalCalls: calls - before }));
  if (missing) process.exitCode = 1;
})().catch(() => { console.error('Finnhub diagnostic failed; sensitive details omitted'); process.exitCode = 1; });
