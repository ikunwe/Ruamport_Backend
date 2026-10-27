const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');
const { createTradeRouter } = require('../src/modules/trades/trade.routes');
const { createInvestmentService } = require('../src/modules/trades/investment.service');

test('holdings HTTP preserves database realized PnL currencies, nulls, negatives and closed scope', async t => {
  const rows = [
    { currency: 'USD', status: 'CALCULATED', soldCost: 100, realizedPnl: -20, feesIncluded: false },
    { currency: 'THB', status: 'INCOMPLETE', soldCost: null, realizedPnl: null, issues: ['SELL_VALUE_REQUIRED'] },
  ];
  const totals = [{ currency: 'USD', soldCost: 100, realizedPnl: -20, isComplete: true }];
  const investments = createInvestmentService({ repository: { holdings: async (user, closed) => {
    assert.equal(user, 'actual-owner');
    assert.equal(closed, true);
    return { items: [{ symbol: 'AMD', status: 'CLOSED', realizedPnl: rows }], realizedPnlTotals: totals };
  } } });
  const app = express();
  app.use('/trades', createTradeRouter({ investments, authenticate: (req, res, next) => {
    req.user = { id: 'actual-owner' }; next();
  } }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/trades/holdings?includeClosed=true&userId=other`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.deepEqual(body.items[0].realizedPnl, rows);
  assert.deepEqual(body.realizedPnlTotals, totals);
});
