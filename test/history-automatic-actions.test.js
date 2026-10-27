const test = require('node:test');
const assert = require('node:assert/strict');
const { createPortfolioHistoryMarket } = require('../src/modules/trades/portfolio-history-market');
const { createPortfolioHistoryService } = require('../src/modules/trades/portfolio-history.service');
const { createStockPriceService } = require('../src/modules/trades/stock-price.service');
const { applySplit, parseSplitEvents } = require('../src/modules/trades/history-corporate-actions');
const { decimal, number } = require('../src/modules/trades/valuation-decimal');
const sec = date => Date.parse(date + 'T14:30:00Z') / 1000;
const ok = value => ({ ok: true, status: 200, json: async () => value });
const stock = { assetType: 'OFFSHORE_STOCK', symbol: 'SPLT', exchange: 'XNAS', currency: 'USD' };

test('unknown ticker multiple forward/reverse splits restore prices and replay quantities without a manual symbol map', async () => {
  const market = createPortfolioHistoryMarket({ fetchData: async () => ok({ chart: { result: [{
    meta: { symbol: 'SPLT', currency: 'USD', exchangeName: 'NMS', instrumentType: 'EQUITY', priceHint: 2 },
    timestamp: [sec('2026-01-01'), sec('2026-01-02'), sec('2026-01-05')], indicators: { quote: [{ close: [250, 250, 250] }] },
    events: { splits: { b: { date: sec('2026-01-05'), numerator: 1, denominator: 5, splitRatio: '1:5' },
      a: { date: sec('2026-01-02'), numerator: 2, denominator: 1, splitRatio: '2:1' } } },
  }] } }) });
  const series = await market.getSeries(stock, '2026-01-01', '2026-01-06');
  assert.equal(series.status, 'AVAILABLE');
  assert.deepEqual(series.points.map(p => p.price), [100, 50, 250]);
  const service = createPortfolioHistoryService({ now: () => Date.parse('2026-01-06T08:00Z'),
    repository: { portfolioOrders: async () => ({ orders: [{ ...stock, transactionType: 'BUY', tradeDate: '2026-01-01', units: 10 }] }) },
    market: { getSeries: async () => series, getFxSeries: async () => ({ status: 'AVAILABLE', points: [{ date: '2026-01-01', price: 1 }] }) } });
  const chart = await service.get('user', { range: 'ALL' });
  assert.equal(chart.status, 'COMPLETE');
  assert.ok(chart.points.every(p => p.marketValue === 1000));
});

test('reverse split fractional units use high-precision arithmetic and malformed actions are rejected', () => {
  assert.equal(number(applySplit(decimal(1), { numerator: 1, denominator: 3 }), 8), 0.33333333);
  for (const value of [null, [], { a: { date: sec('2026-01-02'), numerator: 1, denominator: 0 } },
    { a: { date: sec('2026-01-02'), numerator: 1000001, denominator: 1 } },
    { a: { date: sec('2026-01-02'), numerator: 1.5, denominator: 1 } }]) {
    assert.throws(() => parseSplitEvents(value, 'America/New_York', '2026-01-01', '2026-01-06'));
  }
});

test('recent chart obtains actions since acquisition and does not discard an apparently closed raw balance', async () => {
  const action = { type: 'SPLIT', date: '2026-01-02', numerator: 2, denominator: 1 };
  const service = createPortfolioHistoryService({ now: () => Date.parse('2026-01-06T08:00Z'),
    repository: { portfolioOrders: async () => ({ orders: [
      { ...stock, transactionType: 'BUY', tradeDate: '2025-01-01', units: 10 },
      { ...stock, transactionType: 'SELL', tradeDate: '2026-01-03', units: 10 },
    ] }) }, market: {
      getSeries: async (item, start, end, options) => {
        assert.equal(options.eventStart, '2025-01-01');
        return { status: 'AVAILABLE', corporateActions: [action], points: [{ date: '2026-01-05', price: 50 }] };
      }, getFxSeries: async () => ({ status: 'AVAILABLE', points: [{ date: '2026-01-05', price: 1 }] }),
    } });
  const result = await service.get('user', { range: '1D' });
  assert.equal(result.status, 'COMPLETE');
  assert.ok(result.points.every(point => point.marketValue === 500));
});

test('automatic listing mismatch requires independent exact ticker, currency, market and instrument type agreement', async () => {
  const identity = { status: 'AVAILABLE', source: 'FINNHUB_LISTING_CATALOG', symbol: 'MOVED', currency: 'USD', micCode: 'XNAS', instrumentType: 'EQUITY' };
  for (const extra of [{}, { symbol: 'OTHER' }, { currency: 'EUR' }, { micCode: 'XNYS' }, { instrumentType: 'ETF' }, { status: 'UNAVAILABLE' }]) {
    const market = createPortfolioHistoryMarket({ marketPrices: { getHistoricalListingIdentity: async () => ({ ...identity, ...extra }) },
      fetchData: async () => ok({ chart: { result: [{ meta: { symbol: 'MOVED', currency: 'USD', exchangeName: 'NMS', instrumentType: 'EQUITY' },
        timestamp: [sec('2026-01-02')], indicators: { quote: [{ close: [50] }] } }] } }) });
    const result = await market.getSeries({ ...stock, symbol: 'MOVED', exchange: 'XNYS' }, '2026-01-01', '2026-01-06');
    assert.equal(result.status, Object.keys(extra).length ? 'UNAVAILABLE' : 'AVAILABLE');
    if (!Object.keys(extra).length) {
      assert.equal(result.listingTransfer.type, 'CORROBORATED_CURRENT_LISTING');
      assert.equal(result.listingTransfer.effectiveDate, null);
    }
  }
});

test('independent catalog handles MIC families, rejects ambiguous listings and leaves strict latest quotes unchanged', async () => {
  for (const rows of [
    [{ symbol: 'MOVED', mic: 'XNGS', currency: 'USD', type: 'Common Stock' }],
    [{ symbol: 'MOVED', mic: 'XNGS', currency: 'USD', type: 'Common Stock' }, { symbol: 'MOVED', mic: 'XNYS', currency: 'USD', type: 'Common Stock' }],
  ]) {
    let quotes = 0;
    const market = createStockPriceService({ apiKey: 'test-key', now: () => Date.parse('2026-01-06T08:00Z'), fetchQuote: async input => {
      if (new URL(input).pathname.endsWith('/stock/symbol')) return ok(rows);
      quotes++; return ok({ c: 10, t: sec('2026-01-05') });
    } });
    const oldMarketItem = { ...stock, symbol: 'MOVED', exchange: 'XNYS', quantity: 1 };
    const identity = await market.getHistoricalListingIdentity(oldMarketItem);
    assert.equal(identity.status, rows.length === 1 ? 'AVAILABLE' : 'UNAVAILABLE');
    if (rows.length === 1) {
      assert.equal([...await market.getQuotes([oldMarketItem])][0][1].status, 'UNAVAILABLE');
      assert.equal(quotes, 0);
    }
  }
});

test('chart reconciles old-market buys with new-market sells only in the same corroborated account', async () => {
  for (const differentAccount of [false, true]) {
    const service = createPortfolioHistoryService({ now: () => Date.parse('2026-01-06T08:00Z'),
      repository: { portfolioOrders: async () => ({ orders: [
        { ...stock, exchange: 'XNYS', accountNumber: 'A', transactionType: 'BUY', tradeDate: '2026-01-01', units: 10 },
        { ...stock, exchange: 'XNAS', accountNumber: differentAccount ? 'B' : 'A', transactionType: 'SELL', tradeDate: '2026-01-05', units: 10 },
      ] }) }, market: {
        getSeries: async item => ({ status: 'AVAILABLE', source: 'YAHOO_FINANCE', providerMicCode: 'XNAS', instrumentType: 'EQUITY',
          corporateActions: [], points: [{ date: '2026-01-01', price: 10 }],
          listingTransfer: item.exchange === 'XNYS' ? { type: 'CORROBORATED_CURRENT_LISTING' } : null }),
        getFxSeries: async () => ({ status: 'AVAILABLE', points: [{ date: '2026-01-01', price: 1 }] }),
      } });
    const result = await service.get('user', { range: 'ALL' });
    assert.equal(result.points[0].marketValue, 100);
    if (differentAccount) {
      assert.equal(result.points.at(-1).marketValue, null);
      assert.equal(result.positions.length, 2);
    } else {
      assert.equal(result.points.at(-1).marketValue, 0);
      assert.deepEqual(result.positions[0].pdfExchanges, ['XNYS', 'XNAS']);
    }
  }
});
