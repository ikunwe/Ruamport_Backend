// Public market data only. No database, API keys or portfolio access.
// node --use-system-ca scripts/verification/verify-market-indices.cjs
const { createMarketIndexService } = require('../../src/modules/trades/market-index.service');
(async () => {
  let calls = 0;
  const httpStatusCounts = {};
  const service = createMarketIndexService({ fetchData: async (...args) => {
    calls++;
    const response = await fetch(...args);
    httpStatusCounts[response.status] = (httpStatusCounts[response.status] || 0) + 1;
    return response;
  } });
  const response = await service.getIndices();
  const before = calls;
  const cached = await service.getIndices();
  console.log(JSON.stringify({ mode: 'PUBLIC_INDICES_NO_DATABASE', ...response, httpStatusCounts,
    initialProviderCalls: before, repeatAdditionalProviderCalls: calls - before,
    repeatedFromCache: cached.items.map(({ id, fromCache }) => ({ id, fromCache })) }, null, 2));
  if (response.status !== 'COMPLETE' || response.items.some(row => row.changePercent === null)
    || calls !== before || !cached.items.every(row => row.fromCache)) process.exitCode = 1;
})().catch(() => { console.error('Index verification failed; private/upstream details omitted'); process.exitCode = 1; });
