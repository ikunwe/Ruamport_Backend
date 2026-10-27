const test = require('node:test');
const assert = require('node:assert/strict');
const { createPortfolioHistoryMarket } = require('../src/modules/trades/portfolio-history-market');
const { createDomesticMarketService } = require('../src/modules/trades/domestic-market.service');
const TIME = Date.parse('2026-10-24T08:00:00Z');
const item = { assetType: 'THAI_STOCK', symbol: 'ASK', currency: 'THB' };
const ok = row => ({ ok: true, status: 200, json: async () => row });

test('offshore history uses Yahoo USD US listing including ADRs, never the latest Finnhub service', async () => {
  for (const [symbol, mic, exchange] of [['NVDA', 'XNAS', 'NMS'], ['ASML', 'XNAS', 'NMS'], ['TSM', 'XNYS', 'NYQ'], ['SPCX', 'XNAS', 'NMS']]) {
    let calls = 0;
    const market = createPortfolioHistoryMarket({
      marketPrices: { getDailyHistory: () => { throw new Error('Finnhub history must not be called'); } },
      fetchData: async (input, init) => {
        calls++;
        assert.equal(new URL(input).pathname, '/v8/finance/chart/' + symbol);
        assert.equal(Object.hasOwn(init.headers, 'X-Finnhub-Token'), false);
        return ok({ chart: { result: [{ meta: { symbol, currency: 'USD', exchangeName: exchange,
          instrumentType: symbol === 'SPCX' ? 'ETF' : 'EQUITY', priceHint: 2 },
          timestamp: [Date.parse('2026-10-20T13:30Z') / 1000], indicators: { quote: [{ close: [100.12000274658203] }] } }] } });
      } });
    const stock = { assetType: 'OFFSHORE_STOCK', symbol, exchange: mic, currency: 'USD' };
    const result = await market.getSeries(stock, '2026-10-18', '2026-10-24');
    assert.equal(result.status, 'AVAILABLE');
    assert.equal(result.source, 'YAHOO_FINANCE');
    assert.equal(result.currency, 'USD');
    assert.deepEqual(result.points, [{ date: '2026-10-20', price: 100.12 }]);
    await market.getSeries({ ...stock, accountNumber: 'different-owner' }, '2026-10-18', '2026-10-24');
    assert.equal(calls, 1);
  }
});

test('offshore historical validation rejects foreign ADR issuer, wrong currency/exchange and split events', async () => {
  for (const extra of [{ symbol: 'ASML.AS' }, { currency: 'EUR' }, { exchangeName: 'AMS' },
    { exchangeName: 'NYQ' }, { instrumentType: 'CRYPTOCURRENCY' }, { split: true }]) {
    const market = createPortfolioHistoryMarket({ fetchData: async () => ok({ chart: { result: [{
      meta: { symbol: 'ASML', currency: 'USD', exchangeName: 'NMS', instrumentType: 'EQUITY', ...extra },
      events: extra.split ? { splits: { x: { numerator: 2, denominator: 1 } } } : {},
      timestamp: [], indicators: { quote: [{ close: [] }] },
    }] } }) });
    const result = await market.getSeries({ assetType: 'OFFSHORE_STOCK', symbol: 'ASML', exchange: 'XNAS', currency: 'USD' }, '2026-10-18', '2026-10-24');
    assert.equal(result.status, 'UNAVAILABLE');
  }
});

test('historical Thai prices and FX use bounded fixed endpoints and shared immutable public cache', async () => {
  let calls = 0;
  const market = createPortfolioHistoryMarket({ now: () => TIME, fetchData: async input => {
    calls++;
    const url = new URL(input);
    if (url.hostname === 'api.frankfurter.dev') {
      assert.equal(url.searchParams.get('base'), 'USD');
      assert.equal(url.searchParams.get('quotes'), 'THB');
      return ok([{ date: '2026-10-20', base: 'USD', quote: 'THB', rate: 34 }]);
    }
    assert.equal(url.hostname, 'query1.finance.yahoo.com');
    assert.equal(url.pathname, '/v8/finance/chart/ASK.BK');
    return ok({ chart: { result: [{ meta: { symbol: 'ASK.BK', currency: 'THB', exchangeName: 'SET', instrumentType: 'EQUITY' },
      timestamp: [Date.parse('2026-10-20T08:00Z') / 1000], indicators: { quote: [{ close: [9.6] }] } }] } });
  } });
  const a = await market.getSeries(item, '2026-10-18', '2026-10-24');
  assert.equal(a.points[0].price, 9.6);
  a.points[0].price = 999;
  assert.equal((await market.getSeries(item, '2026-10-18', '2026-10-24')).points[0].price, 9.6);
  assert.equal((await market.getFxSeries('2026-10-18', '2026-10-24')).points[0].price, 34);
  await market.getFxSeries('2026-10-18', '2026-10-24');
  assert.equal(calls, 2);
});

test('Thai split events or wrong market fail closed rather than mixing adjusted prices with raw PDF units', async () => {
  for (const bad of [{ currency: 'USD' }, { exchangeName: 'NMS' }, { split: true }]) {
    const market = createPortfolioHistoryMarket({ fetchData: async () => ok({ chart: { result: [{
      meta: { symbol: 'ASK.BK', currency: 'THB', exchangeName: 'SET', instrumentType: 'EQUITY', ...bad },
      events: bad.split ? { splits: { x: { numerator: 2, denominator: 1 } } } : {}, timestamp: [], indicators: { quote: [{ close: [] }] },
    }] } }) });
    assert.equal((await market.getSeries(item, '2026-10-18', '2026-10-24')).status, 'UNAVAILABLE');
  }
});


test('fund history uses matching SEC class across bounded pages without changing latest NAV', async () => {
  let calls = 0;
  const market = createDomesticMarketService({ secApiKey: 'secret', now: () => TIME, fetchData: async input => {
    calls++;
    const url = new URL(input);
    if (url.pathname.includes('/profiles')) return ok({ items: [{ proj_id: 'M1_2567', fund_class_name: 'FUND', fund_status: 'Registered' }], next_cursor: '' });
    assert.equal(url.searchParams.get('start_nav_date'), '2026-10-18');
    return ok({ items: [{ proj_id: 'M1_2567', fund_class_name: 'FUND', nav_date: '2026-10-20', last_val: 10 },
      { proj_id: 'M1_2567', fund_class_name: 'OTHER', nav_date: '2026-10-20', last_val: 999 }], next_cursor: '' });
  } });
  const result = await market.getFundDailyHistory({ assetType: 'MUTUAL_FUND', symbol: 'FUND', currency: 'THB' }, '2026-10-18', '2026-10-24');
  assert.equal(result.status, 'AVAILABLE');
  assert.deepEqual(result.points, [{ date: '2026-10-20', price: 10 }]);
  assert.equal(calls, 2);
});
