const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');
const { createTradeRouter } = require('../src/modules/trades/trade.routes');
const { createInvestmentService } = require('../src/modules/trades/investment.service');
const { errorHandler } = require('../src/middlewares/error.middleware');
async function server(t, options) {
  const app = express(); app.use('/trades', createTradeRouter(options)); app.use(errorHandler);
  const http = app.listen(0, '127.0.0.1'); await once(http, 'listening');
  t.after(() => new Promise(resolve => http.close(resolve)));
  return `http://127.0.0.1:${http.address().port}/trades/analytics`;
}
test('analytics endpoints require auth and never accept client userId; no-store and fresh imports per request', async t => {
  const base = await server(t);
  for (const endpoint of ['performance', 'win-rate']) assert.equal((await fetch(base + '/' + endpoint)).status, 401);
  const owners = [], calls = [];
  let imported = false;
  const investments = createInvestmentService({ historyNow: () => Date.parse('2026-10-26T10:00Z'),
    repository: { analyticsOrders: async id => { owners.push(id); return { orders: imported ? [{
      assetType: 'THAI_STOCK', symbol: 'ASK', currency: 'THB', units: 1, tradeDate: '2026-10-25',
      transactionType: 'BUY', flowAmount: 10 }] : [] }; } },
    historyMarket: { getSeries: async () => { calls.push('ASK'); return { status: 'AVAILABLE', points: [
      { date: '2026-10-25', price: 10 }, { date: '2026-10-26', price: 11 }] }; },
    getIndexSeries: async () => ({ status: 'AVAILABLE', points: [{ date: '2026-10-25', price: 100 }] }),
    getFxSeries: async () => ({ status: 'AVAILABLE', points: [{ date: '2026-10-25', price: 35 }] }) } });
  const authenticated = await server(t, { investments, authenticate: (req, _res, next) => { req.user = { id: req.headers['x-test-owner'] }; next(); } });
  const r = await fetch(authenticated + '/performance?userId=victim', { headers: { 'x-test-owner': 'alice' } });
  assert.equal(r.headers.get('cache-control'), 'no-store'); assert.equal((await r.json()).status, 'EMPTY');
  imported = true;
  const second = await fetch(authenticated + '/performance?benchmarkId=SET', { headers: { 'x-test-owner': 'bob' } });
  assert.equal((await second.json()).portfolio.cumulativeReturnPercent, 10);
  assert.deepEqual(owners, ['alice', 'bob']); assert.deepEqual(calls, ['ASK']);
  const invalid = await fetch(authenticated + '/performance?range=bad', { headers: { 'x-test-owner': 'bob' } });
  assert.equal(invalid.status, 400); assert.deepEqual(owners, ['alice', 'bob']);
});
