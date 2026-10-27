const test = require('node:test');
const assert = require('node:assert/strict');
const { thaiStockLogo } = require('../src/modules/trades/thai-stock-logo');
const { createInvestmentService } = require('../src/modules/trades/investment.service');
const stock = extra => ({ assetType: 'THAI_STOCK', symbol: 'ASK', currency: 'THB', quantity: 100, ...extra });
test('SET logos build fixed-origin ASK/PTT URLs without claiming image availability', () => {
  for (const symbol of ['ASK', 'PTT']) {
    const logo = thaiStockLogo(stock({ symbol }));
    assert.equal(logo.url, 'https://media.set.or.th/common/logo/company/' + symbol + '.png');
    assert.equal(logo.source, 'SET');
    assert.equal(logo.status, 'UNVERIFIED');
    assert.equal(logo.verified, false);
    assert.equal(logo.fallbackText, symbol);
  }
  assert.equal(thaiStockLogo(stock({ symbol: ' ptt ' })).providerSymbol, 'PTT');
});
test('SET logos reject invalid paths, unsupported markets and non-held or non-Thai positions', () => {
  for (const change of [{ symbol: '../ASK' }, { symbol: 'https://evil.test' }, { symbol: 'ASK?x' },
    { symbol: '' }, { symbol: 'ASK/../PTT' }, { symbol: 'A'.repeat(33) }, { quantity: 0 },
    { quantity: -1 }, { quantity: NaN }, { quantity: Infinity }, { quantity: '1' },
    { exchange: 'XNAS' }, { currency: 'USD' }, { assetType: 'OFFSHORE_STOCK' }, { assetType: 'MUTUAL_FUND' }]) {
    assert.equal(thaiStockLogo(stock(change)), null, JSON.stringify(change));
  }
});
test('holdings logo opt-in keeps Finnhub contract and does not invoke domestic price service', async () => {
  const offshore = { assetType: 'OFFSHORE_STOCK', symbol: 'AMD', currency: 'USD', exchange: 'XNAS', quantity: 2 };
  const { instrument } = require('../src/modules/trades/stock-price.service');
  const url = 'https://static2.finnhub.io/example.png';
  const snapshots = new Map([[instrument(offshore).key, { status: 'AVAILABLE', source: 'FINNHUB', url }]]);
  let calls = 0;
  const items = [stock(), offshore, stock({ assetType: 'MUTUAL_FUND', symbol: 'KKP' }), stock({ quantity: 0 })];
  const service = createInvestmentService({
    repository: { holdings: async user => { assert.equal(user, 'owner'); return { items }; } },
    marketPrices: { getLogos: async received => { calls++; assert.deepEqual(received, items); return snapshots; } },
    fundLogos: { getLogos: async () => new Map() },
    domesticPrices: { getQuotes: () => { throw new Error('Should not fetch Thai prices for logos'); } },
  });
  const plain = await service.holdings('owner');
  assert.equal(plain.items[0].logoUrl, undefined);
  assert.equal(calls, 0);
  const result = await service.holdings('owner', { includeLogos: 'true' });
  assert.equal(result.items[0].logoUrl, 'https://media.set.or.th/common/logo/company/ASK.png');
  assert.equal(result.items[0].logo.status, 'UNVERIFIED');
  assert.equal(result.items[1].logoUrl, url);
  assert.deepEqual(result.items[1].logo, snapshots.get(instrument(offshore).key));
  assert.equal(result.items[2].logo, null);
  assert.equal(result.items[3].logoUrl, null);
  assert.equal(result.items[0].marketValuation, undefined);
  assert.equal(calls, 1);
});

