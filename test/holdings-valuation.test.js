const test = require('node:test');
const assert = require('node:assert/strict');
const { createInvestmentService } = require('../src/modules/trades/investment.service');
const { createStockPriceService, instrument } = require('../src/modules/trades/stock-price.service');
const { withHoldingsValuation } = require('../src/modules/trades/holdings-valuation');
const { decimal, add, subtract, multiply, ratio, number } = require('../src/modules/trades/valuation-decimal');

const position = (extra = {}) => ({ assetType: 'OFFSHORE_STOCK', currency: 'USD', exchange: 'XNAS', symbol: 'AMD',
  quantity: 2, costBasis: [
    { currency: 'USD', status: 'CALCULATED', method: 'COMPRESSED_FIFO', remainingCost: 200, averageCostPerUnit: 100 },
    { currency: 'THB', status: 'CALCULATED', remainingCost: 7000, averageCostPerUnit: 3500 },
  ], amounts: [{ currency: 'USD', totalBuyGross: 200 }, { currency: 'THB', totalBuyGross: 7000 }], ...extra });
const quote = (extra = {}) => ({ status: 'AVAILABLE', price: 150, priceAt: '2026-10-20T14:59:00.000Z',
  source: 'FINNHUB', currency: 'USD', isStale: false, ...extra });
const quotesFor = items => new Map(items.filter(item => instrument(item)).map(item => [instrument(item).key, quote()]));

test('market values and unrealized PnL use remaining gross cost, never total buys minus sells or historical THB', async () => {
  const data = { items: [position()], stockMoneyTotals: [{ currency: 'USD', totalBuyGross: 900, totalSellGross: 1000 }] };
  const original = structuredClone(data);
  const service = createInvestmentService({ repository: { holdings: async (user, closed) => {
    assert.equal(user, 'trusted-owner'); assert.equal(closed, false); return data;
  } }, marketPrices: { cacheTtlSeconds: 900, getQuotes: async items => quotesFor(items) },
  exchangeRates: { getRate: async () => ({ status: 'AVAILABLE', rate: 33.498, rateDate: '2026-10-19' }) } });
  const result = await service.holdings('trusted-owner', { includeMarket: 'true', includeFx: 'true', userId: 'other' });
  const valuation = result.items[0].marketValuation;
  assert.equal(valuation.status, 'CALCULATED');
  assert.deepEqual(valuation.usd, { marketValue: 300, remainingCost: 200, unrealizedPnl: 100, unrealizedPnlPercent: 50 });
  assert.deepEqual(valuation.thb, { currency: 'THB', marketValue: 10049.4, remainingCost: 6699.6, unrealizedPnl: 3349.8, unrealizedPnlPercent: 50 });
  assert.equal(result.offshoreValuation.usd.unrealizedPnl, 100);
  assert.equal(result.offshoreValuation.thb.unrealizedPnl, 3349.8);
  assert.equal(result.offshoreValuation.isComplete, true);
  assert.equal(result.fx.rateDate, '2026-10-19');
  assert.deepEqual(data, original);
  assert.equal(result.items[0].costBasis[1].remainingCost, 7000);
});

test('negative PnL, fractional shares and totals are computed before display rounding', () => {
  const item = position({ quantity: 0.5, costBasis: [{ currency: 'USD', status: 'CALCULATED', remainingCost: 1 }] });
  const items = [item, { ...item, accountNumber: 'another-account' }];
  const quotes = new Map([[instrument(item).key, quote({ price: 1.005 })]]);
  const result = withHoldingsValuation({ items, fx: { status: 'AVAILABLE', rate: 33.498 } }, quotes, 900);
  assert.equal(result.items[0].marketValuation.usd.marketValue, 0.5);
  assert.equal(result.items[0].marketValuation.usd.unrealizedPnl, -0.5);
  assert.equal(result.items[0].marketValuation.usd.unrealizedPnlPercent, -49.75);
  assert.equal(result.offshoreValuation.usd.marketValue, 1.01);
  assert.equal(result.offshoreValuation.usd.remainingCost, 2);
  assert.equal(result.offshoreValuation.usd.unrealizedPnl, -1);
  assert.equal(result.offshoreValuation.usd.unrealizedPnlPercent, -49.75);
  assert.equal(result.offshoreValuation.thb.marketValue, 33.67);
});

test('missing prices never become zero losses or an apparently complete partial portfolio', () => {
  const items = [position(), position({ symbol: 'MISSING' })];
  const quotes = new Map([[instrument(items[0]).key, quote()], [instrument(items[1]).key,
    { status: 'UNAVAILABLE', price: null, errorCode: 'PRICE_RATE_LIMITED', retryAt: '2026-10-20T15:01:00.000Z' }]]);
  const result = withHoldingsValuation({ items }, quotes, 900);
  assert.equal(result.items[1].marketValuation.status, 'PRICE_UNAVAILABLE');
  assert.equal(result.items[1].marketValuation.usd.marketValue, null);
  assert.equal(result.items[1].marketValuation.usd.unrealizedPnl, null);
  assert.equal(result.items[1].marketValuation.usd.remainingCost, 200);
  assert.equal(result.offshoreValuation.usd.marketValue, null);
  assert.equal(result.offshoreValuation.usd.availableMarketValue, 300);
  assert.equal(result.offshoreValuation.usd.unrealizedPnl, null);
  assert.equal(result.offshoreValuation.isComplete, false);
  assert.equal(result.offshoreValuation.missingPriceCount, 1);
});

test('incomplete costs allow market value but suppress cost-dependent profit and percent', () => {
  const items = [position({ costBasis: [{ currency: 'USD', status: 'INCOMPLETE', remainingCost: 200 }] })];
  const result = withHoldingsValuation({ items }, quotesFor(items), 900);
  assert.equal(result.items[0].marketValuation.status, 'COST_INCOMPLETE');
  assert.equal(result.items[0].marketValuation.usd.marketValue, 300);
  assert.equal(result.items[0].marketValuation.usd.remainingCost, null);
  assert.equal(result.items[0].marketValuation.usd.unrealizedPnl, null);
  assert.equal(result.offshoreValuation.usd.marketValue, 300);
  assert.equal(result.offshoreValuation.usd.remainingCost, null);
  assert.equal(result.offshoreValuation.usd.unrealizedPnlPercent, null);
  assert.equal(result.offshoreValuation.incompleteCostCount, 1);
});

test('zero cost has valid monetary gain but undefined percentage, not Infinity', () => {
  const items = [position({ costBasis: [{ currency: 'USD', status: 'CALCULATED', remainingCost: 0 }] })];
  const result = withHoldingsValuation({ items }, quotesFor(items), 900);
  assert.equal(result.items[0].marketValuation.usd.unrealizedPnl, 300);
  assert.equal(result.items[0].marketValuation.usd.unrealizedPnlPercent, null);
  assert.ok(result.items[0].marketValuation.issues.includes('ZERO_COST_PERCENT_UNDEFINED'));
  assert.equal(result.offshoreValuation.usd.unrealizedPnlPercent, null);
});

test('closed/negative positions, Thai stocks and funds are excluded; unsupported US mapping is explicit', () => {
  const items = [position({ quantity: 0 }), position({ quantity: -1 }), position({ currency: 'EUR' }),
    position({ assetType: 'THAI_STOCK' }), position({ assetType: 'MUTUAL_FUND' }), position({ exchange: 'UNKNOWN' })];
  const result = withHoldingsValuation({ items }, new Map(), 900);
  assert.equal(result.items[0].marketValuation.status, 'NOT_HELD');
  assert.equal(result.items[1].marketValuation.status, 'NOT_HELD');
  assert.equal(result.items[2].marketValuation.status, 'UNSUPPORTED');
  assert.equal(result.items[3].marketValuation, null);
  assert.equal(result.items[4].marketValuation, null);
  assert.deepEqual(result.items[5].marketValuation.issues, ['MARKET_INSTRUMENT_UNSUPPORTED']);
  assert.equal(result.offshoreValuation.heldPositionCount, 1);
  assert.equal(result.offshoreValuation.missingPriceCount, 1);
});

test('quote and FX freshness are exposed separately; USD survives absent FX', () => {
  const items = [position()];
  const quotes = new Map([[instrument(items[0]).key, quote({ isStale: true })]]);
  const result = withHoldingsValuation({ items, fx: { status: 'AVAILABLE', rate: 33.498, isStale: true } }, quotes, 900);
  assert.equal(result.offshoreValuation.stalePriceCount, 1);
  assert.ok(result.items[0].marketValuation.issues.includes('STALE_PRICE'));
  assert.ok(result.items[0].marketValuation.issues.includes('STALE_FX_RATE'));
  const noFx = withHoldingsValuation({ items, fx: { status: 'UNAVAILABLE', rate: null } }, quotes, 900);
  assert.equal(noFx.items[0].marketValuation.thb, null);
  assert.equal(noFx.offshoreValuation.thb, null);
  assert.equal(noFx.items[0].marketValuation.usd.unrealizedPnl, 100);
});

test('default holdings makes no stock or FX requests; market opt-in validates before accessing DB', async () => {
  const data = { items: [] };
  let dbCalls = 0;
  const service = createInvestmentService({ repository: { holdings: async () => { dbCalls++; return data; } },
    marketPrices: { getQuotes: async () => assert.fail('must not request prices') },
    exchangeRates: { getRate: async () => assert.fail('must not request FX') } });
  assert.deepEqual(await service.holdings('owner'), data);
  assert.deepEqual(await service.holdings('owner', { includeMarket: 'false' }), data);
  for (const includeMarket of ['yes', '1', '', true, ['true'], {}]) {
    await assert.rejects(service.holdings('owner', { includeMarket }), { code: 'INVALID_HOLDINGS_FILTER' });
  }
  assert.equal(dbCalls, 2);
});

test('configured service with no key returns holdings and per-position setup status rather than 500', async () => {
  const data = { items: [position()] };
  const service = createInvestmentService({ repository: { holdings: async () => data }, marketPrices: createStockPriceService({ apiKey: '' }) });
  const result = await service.holdings('owner', { includeMarket: 'true' });
  assert.equal(result.items[0].marketValuation.quote.errorCode, 'MARKET_DATA_CONFIG_MISSING');
  assert.equal(result.offshoreValuation.usd.marketValue, null);
  assert.equal(result.offshoreValuation.usd.remainingCost, 200);
  assert.equal(result.offshoreValuation.isComplete, false);
});

test('decimal calculation preserves exact sub-cent products, negative signs, missing data and safe bounds', () => {
  assert.equal(number(multiply(decimal(0.1), decimal(0.2)), 8), 0.02);
  assert.equal(number(add(decimal(0.1), decimal(0.2))), 0.3);
  assert.equal(number(subtract(decimal(100), decimal(200))), -100);
  assert.equal(number(decimal(-1.005)), -1.01);
  assert.equal(number(decimal(1e-7), 8), 0.0000001);
  assert.equal(ratio(decimal(1), decimal(3)), 0.3333);
  assert.equal(number(decimal(1e30)), null);
  assert.equal(number(null), null);
  assert.equal(ratio(decimal(1), decimal(0)), null);
});

test('out-of-range monetary results are not presented as a calculated gain', () => {
  const items = [position({ quantity: 1e30 })];
  const result = withHoldingsValuation({ items }, quotesFor(items), 900);
  assert.equal(result.items[0].marketValuation.status, 'INCOMPLETE');
  assert.ok(result.items[0].marketValuation.issues.includes('VALUATION_OUT_OF_RANGE'));
  assert.equal(result.offshoreValuation.isComplete, false);
  assert.equal(result.offshoreValuation.usd.marketValue, null);
});

test('opt-in metadata no longer incorrectly claims that there is no market value at all', () => {
  const items = [position()];
  const data = { items, limitations: ['NO_MARKET_VALUE', 'SUPPORTED_TRANSACTIONS_ONLY'] };
  const result = withHoldingsValuation(data, quotesFor(items), 900);
  assert.deepEqual(result.limitations, ['SUPPORTED_TRANSACTIONS_ONLY', 'MARKET_VALUE_OFFSHORE_USD_ONLY']);
  assert.deepEqual(data.limitations, ['NO_MARKET_VALUE', 'SUPPORTED_TRANSACTIONS_ONLY']);
});
