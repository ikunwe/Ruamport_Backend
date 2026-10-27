const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');
const { createTradeRouter } = require('../src/modules/trades/trade.routes');
const { createInvestmentService } = require('../src/modules/trades/investment.service');
const { createFundLogoService } = require('../src/modules/trades/fund-logo.service');
const { domesticInstrument } = require('../src/modules/trades/domestic-market.service');
const { instrument } = require('../src/modules/trades/stock-price.service');
const NAME = 'KIATNAKIN PHATRA ASSET MANAGEMENT COMPANY LIMITED';
const ID = 'C0000005025';
const token = 'pk_public-test-key';
const fund = { assetType: 'MUTUAL_FUND', symbol: 'KKP US500-UH-E', currency: 'THB', quantity: 10,
  costBasis: [{ currency: 'THB', status: 'CALCULATED', remainingCost: 100 }] };
const stock = { assetType: 'THAI_STOCK', symbol: 'ASK', currency: 'THB', quantity: 100,
  costBasis: [{ currency: 'THB', status: 'CALCULATED', remainingCost: 800 }] };
const offshore = { assetType: 'OFFSHORE_STOCK', symbol: 'AMD', currency: 'USD', exchange: 'XNAS', quantity: 2 };
async function serverFor(t, options = {}) {
  let calls = 0;
  const logos = createFundLogoService({
    publishableKey: options.missingKey ? '' : token,
    getFundIdentity: async item => ({ projectId: 'M0301_2567', fundClassName: item.symbol, amcId: ID, amcNameEn: NAME }),
    fetchData: async input => {
      calls++;
      const url = new URL(input);
      if (options.directoryFailure) throw new Error('sk_do-not-expose-this');
      const html = url.pathname.includes('/Intermediaries')
        ? '<a href="/LicenseCheck/CompanyDetail/0000005025">KKPAM</a>'
        : '<h2>' + NAME + '</h2><li>Website : <a href="https://am.kkpfg.com/th/home">site</a></li>';
      return { ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => html };
    },
  });
  const investments = createInvestmentService({
    fundLogos: logos,
    repository: { holdings: async user => {
      assert.ok(['A', 'B'].includes(user));
      const quantity = user === 'A' ? 10 : 25;
      return { items: [{ ...fund, quantity }, stock, offshore, { ...fund, symbol: 'CLOSED', quantity: 0 }] };
    } },
    domesticPrices: { thaiCacheTtlSeconds: 900, navCacheTtlSeconds: 3600,
      getQuotes: async items => new Map(items.filter(x => x.assetType !== 'OFFSHORE_STOCK' && x.quantity > 0).map(x => [
        domesticInstrument(x).key, { status: 'AVAILABLE', source: x.assetType === 'THAI_STOCK' ? 'YAHOO_FINANCE' : 'SEC_OPEN_API',
          price: x.assetType === 'THAI_STOCK' ? 9.6 : 12, currency: 'THB' },
      ])) },
    marketPrices: { cacheTtlSeconds: 900, getQuotes: async () => new Map(), getLogos: async () => new Map([
      [instrument(offshore).key, { status: 'AVAILABLE', source: 'FINNHUB', url: 'https://static2.finnhub.io/example.png' }],
    ]) },
  });
  const app = express();
  app.use('/trades', createTradeRouter({ investments, authenticate: (req, _res, next) => {
    req.user = { id: req.headers['x-test-owner'] || 'A' }; next();
  } }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { url: 'http://127.0.0.1:' + server.address().port + '/trades/holdings', calls: () => calls };
}
test('HTTP combined portfolio returns fund Logo.dev, Thai SET and offshore Finnhub unchanged', async t => {
  const f = await serverFor(t);
  const response = await fetch(f.url + '?includeLogos=true&includeMarket=true&userId=B&symbol=OTHER');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.equal(body.items[0].quantity, 10);
  assert.equal(body.items[0].logo.status, 'UNVERIFIED');
  assert.equal(body.items[0].logo.source, 'LOGO_DEV');
  assert.equal(body.items[0].logo.domain, 'am.kkpfg.com');
  assert.equal(new URL(body.items[0].logoUrl).searchParams.get('fallback'), '404');
  assert.equal(body.items[0].marketValuation.thb.marketValue, 120);
  assert.equal(body.items[0].marketValuation.thb.remainingCost, 100);
  assert.equal(body.items[1].logo.source, 'SET');
  assert.equal(body.items[1].marketValuation.quote.source, 'YAHOO_FINANCE');
  assert.equal(body.items[2].logo.source, 'FINNHUB');
  assert.equal(body.items[2].logoUrl, 'https://static2.finnhub.io/example.png');
  assert.equal(body.items[3].logoUrl, null);
  assert.equal(body.items[3].logo, null);
  assert.equal(f.calls(), 2);
});
test('HTTP cache shares AMC metadata but never one owners quantity/costs with another', async t => {
  const f = await serverFor(t);
  const a = await (await fetch(f.url + '?includeLogos=true')).json();
  const b = await (await fetch(f.url + '?includeLogos=true', { headers: { 'x-test-owner': 'B' } })).json();
  assert.equal(a.items[0].quantity, 10);
  assert.equal(b.items[0].quantity, 25);
  assert.equal(a.items[0].logoUrl, b.items[0].logoUrl);
  assert.equal(b.items[0].logo.fromCache, true);
  assert.equal(f.calls(), 2);
});
test('HTTP fund logo failure/key missing is advisory 200, original NAV/costs remain', async t => {
  for (const options of [{ directoryFailure: true }, { missingKey: true }]) {
    const f = await serverFor(t, options);
    const response = await fetch(f.url + '?includeLogos=true&includeMarket=true');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.items[0].logoUrl, null);
    assert.equal(body.items[0].logo.status, 'UNAVAILABLE');
    assert.equal(body.items[0].logo.fallbackText, fund.symbol);
    assert.equal(body.items[0].marketValuation.thb.marketValue, 120);
    assert.equal(body.items[1].logo.source, 'SET');
    assert.equal(body.items[2].logo.source, 'FINNHUB');
    assert.equal(JSON.stringify(body).includes('sk_do-not-expose-this'), false);
  }
});
test('HTTP opt-in absent/false/invalid never fetches fund directory metadata', async t => {
  const f = await serverFor(t);
  for (const query of ['', '?includeLogos=false']) {
    const response = await fetch(f.url + query);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).items[0].logo, undefined);
  }
  assert.equal((await fetch(f.url + '?includeLogos=invalid')).status, 400);
  assert.equal(f.calls(), 0);
});

