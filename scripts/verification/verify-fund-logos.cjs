// Read-only provider smoke test. No Supabase/database access, no image downloads.
const { createDomesticMarketService, domesticInstrument } = require('../../src/modules/trades/domestic-market.service');
const { createFundLogoService } = require('../../src/modules/trades/fund-logo.service');
(async () => {
  const domestic = createDomesticMarketService();
  const upstream = [];
  const logos = createFundLogoService({
    getFundIdentity: item => domestic.getFundIdentity(item),
    fetchData: async (input, init) => {
      const response = await fetch(input, init);
      const url = new URL(input);
      upstream.push({ host: url.hostname, path: url.pathname, status: response.status });
      return response;
    },
  });
  const symbols = process.argv.slice(2);
  const items = (symbols.length ? symbols : ['KKP US500-UH-E', 'K-US500X-A(A)', 'SCBS&P500'])
    .map(symbol => ({ assetType: 'MUTUAL_FUND', symbol, currency: 'THB', quantity: 1 }));
  const result = await logos.getLogos(items);
  for (const item of items) {
    const logo = result.get(domesticInstrument(item)?.key);
    console.log(JSON.stringify({ symbol: item.symbol, status: logo?.status, amcId: logo?.amcId,
      amcName: logo?.amcName, domain: logo?.domain, matchMethod: logo?.matchMethod,
      imageHost: logo?.url ? new URL(logo.url).hostname : null,
      errorCode: logo?.errorCode, retryAt: logo?.retryAt }, null, 2));
  }
  const count = upstream.length;
  await logos.getLogos(items);
  console.log(JSON.stringify({ upstream, repeatedAdditionalDirectoryCalls: upstream.length - count }, null, 2));
})().catch(() => { console.error('Fund logo smoke test failed; credentials omitted'); process.exitCode = 1; });

