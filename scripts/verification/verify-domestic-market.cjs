// Read-only provider smoke test; no Supabase access, imports or database writes.
// Run: node --use-system-ca --env-file=.env scripts/verification/verify-domestic-market.cjs
const { createDomesticMarketService, domesticInstrument } = require('../../src/modules/trades/domestic-market.service');
const { env } = require('../../src/config/env');
(async () => {
  let outboundRequests = 0;
  const market = createDomesticMarketService({ fetchData: async (...args) => {
    outboundRequests++;
    return fetch(...args);
  } });
  const items = [
    { assetType: 'THAI_STOCK', symbol: 'ASK', currency: 'THB', quantity: 1 },
    { assetType: 'MUTUAL_FUND', symbol: 'KKP US500-UH-E', currency: 'THB', quantity: 1 },
  ];
  const results = await market.getQuotes(items);
  const before = outboundRequests;
  const repeated = await market.getQuotes(items);
  console.log(JSON.stringify({
    mode: 'PUBLIC_PROVIDER_SMOKE_TEST_NO_DATABASE_WRITES',
    secKeyConfigured: Boolean(env.secApiKey.trim()),
    items: items.map(item => {
      const result = results.get(domesticInstrument(item).key);
      return { assetType: item.assetType, ...result };
    }),
    outboundRequests, repeatedAdditionalRequests: outboundRequests - before,
    repeatedStatuses: [...repeated.values()].map(result => result.status),
  }, null, 2));
  const yahoo = results.get(domesticInstrument(items[0]).key);
  const sec = results.get(domesticInstrument(items[1]).key);
  if (yahoo.status !== 'AVAILABLE' || (env.secApiKey.trim() && sec.status !== 'AVAILABLE')) process.exitCode = 1;
})().catch(() => {
  // Never print raw provider/network errors: they may carry credentials.
  console.error('Domestic market verification failed; upstream details have been withheld.');
  process.exitCode = 1;
});
