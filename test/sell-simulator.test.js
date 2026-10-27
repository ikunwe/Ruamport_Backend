const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');
const { createSellSimulatorService } = require('../src/modules/trades/sell-simulator.service');
const { createInvestmentService } = require('../src/modules/trades/investment.service');
const { createInvestmentRepository } = require('../src/modules/trades/investment.repository');
const { createTradeRouter } = require('../src/modules/trades/trade.routes');
const { errorHandler } = require('../src/middlewares/error.middleware');
const now = () => Date.parse('2026-10-27T12:00Z');
const body = extra => ({ action: 'SELL', assetType: 'OFFSHORE_STOCK', accountNumber: '00123',
  symbol: 'AMD', exchange: 'XNAS', currency: 'USD', quantity: 0.5, price: 100, tradeDate: '2026-10-27', ...extra });
const calculated = { status: 'CALCULATED', persisted: false, proceeds: 50, soldCost: 40, realizedPnl: 10,
  realizedPnlPercent: 25, before: { quantity: 1, remainingCost: 80 }, after: { quantity: 0.5, remainingCost: 40 },
  snapshot: { revision: 'sim-v1:' + 'a'.repeat(32) } };
test('validated simulation uses one owner-scoped read RPC, preserves account leading zeros and does not fetch prices/FX', async () => {
  const calls = [];
  const noProvider = new Proxy({}, { get: () => () => { throw new Error('Unexpected provider call'); } });
  const service = createInvestmentService({ historyNow: now, repository: { simulateSale: async (id, request) => {
    calls.push({ id, request }); return calculated;
  } }, marketPrices: noProvider, domesticPrices: noProvider, exchangeRates: noProvider });
  const r = await service.simulateSale('owner', body());
  assert.equal(r, calculated); assert.deepEqual(calls, [{ id: 'owner', request: body() }]);
});
test('repository invokes only simulate_investment_sale with parameterized owner/request', async () => {
  const calls = [];
  const repository = createInvestmentRepository(() => ({ rpc: async (name, params) => { calls.push({ name, params }); return { data: calculated, error: null }; } }));
  assert.deepEqual(await repository.simulateSale('owner', body()), calculated);
  assert.deepEqual(calls, [{ name: 'simulate_investment_sale', params: { p_user_id: 'owner', p_request: body() } }]);
});
test('rejects malformed, excessive, non-finite and client-supplied cost/user data before touching storage', async () => {
  let calls = 0;
  const service = createSellSimulatorService({ now, repository: { simulateSale: async () => { calls++; return calculated; } } });
  for (const input of [null, [], {}, body({ action: 'BUY' }), body({ quantity: 0 }), body({ quantity: -1 }),
    body({ quantity: '1' }), body({ quantity: NaN }), body({ quantity: 1e-13 }), body({ price: Infinity }),
    body({ quantity: 1e9, price: 1e9 }), body({ price: 0 }), body({ currency: 'THB' }), body({ assetType: 'GOLD' }),
    body({ accountNumber: 123 }), body({ symbol: '' }), body({ exchange: ['XNAS'] }), body({ exchange: 'bad space' }),
    body({ tradeDate: '2026-02-30' }), body({ tradeDate: '2026-10-26' }), body({ tradeDate: '2028-01-01' }),
    body({ userId: 'victim' }), body({ soldCost: 1 }), body({ remainingCost: 1 }),
    body({ expectedSnapshotRevision: 'old' }), body({ expectedSnapshotRevision: null }),
    (({ exchange, ...other }) => other)(body())]) {
    await assert.rejects(service.simulate('owner', input), { status: 400, code: 'INVALID_SIMULATION_REQUEST' });
  }
  assert.equal(calls, 0);
});
test('null identity dimensions and native fund THB are accepted; INCOMPLETE values remain null', async () => {
  const inputs = [];
  const incomplete = { ...calculated, status: 'INCOMPLETE', soldCost: null, realizedPnl: null, realizedPnlPercent: null,
    issues: ['INTRADAY_ORDER_AMBIGUOUS'] };
  const service = createSellSimulatorService({ now, repository: { simulateSale: async (_id, request) => { inputs.push(request); return incomplete; } } });
  const r = await service.simulate('owner', body({ assetType: 'MUTUAL_FUND', currency: 'THB', symbol: 'KKP US500-UH-E',
    accountNumber: null, exchange: null, expectedSnapshotRevision: calculated.snapshot.revision }));
  assert.deepEqual(r, incomplete); assert.equal(inputs[0].accountNumber, null); assert.equal(inputs[0].exchange, null);
});
test('simulation date follows Thai calendar rather than UTC; known SQL errors map to explicit HTTP codes', async () => {
  const service = createSellSimulatorService({ now: () => Date.parse('2026-10-26T19:00Z'),
    repository: { simulateSale: async () => calculated } });
  await service.simulate('owner', body());
  const errors = { SIMULATION_POSITION_NOT_FOUND: 404, SIMULATION_POSITION_NOT_HELD: 409,
    SIMULATION_QUANTITY_EXCEEDED: 422, SIMULATION_SNAPSHOT_CHANGED: 409, SIMULATION_DATE_BEFORE_SNAPSHOT: 409,
    SIMULATION_ORDER_LIMIT_EXCEEDED: 422 };
  for (const [code, status] of Object.entries(errors)) {
    const service = createSellSimulatorService({ now, repository: { simulateSale: async () => ({ errorCode: code }) } });
    await assert.rejects(service.simulate('owner', body()), { status, code });
  }
  const unavailable = createSellSimulatorService({ now, repository: { simulateSale: async () => null } });
  await assert.rejects(unavailable.simulate('owner', body()), { status: 503, code: 'SIMULATION_UNAVAILABLE' });
});
async function server(t, options) {
  const app = express(); app.use(express.json()); app.use('/trades', createTradeRouter(options)); app.use(errorHandler);
  const http = app.listen(0, '127.0.0.1'); await once(http, 'listening');
  t.after(() => new Promise(resolve => http.close(resolve)));
  return `http://127.0.0.1:${http.address().port}/trades/simulate-sale`;
}
test('POST is authenticated, no-store and read-only; HTTP returns native results and validates before DB', async t => {
  const protectedUrl = await server(t);
  assert.equal((await fetch(protectedUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body()) })).status, 401);
  const owners = [];
  const investments = createInvestmentService({ historyNow: now, repository: { simulateSale: async (owner, request) => {
    owners.push(owner); assert.equal(request.accountNumber, '00123'); return { ...calculated, currency: request.currency };
  } } });
  const url = await server(t, { investments, authenticate: (req, _res, next) => { req.user = { id: 'token-owner' }; next(); } });
  const response = await fetch(url + '?userId=victim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body()) });
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const result = await response.json(); assert.equal(result.currency, 'USD'); assert.equal(result.persisted, false);
  assert.deepEqual(owners, ['token-owner']);
  const invalid = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body({ userId: 'victim' })) });
  assert.equal(invalid.status, 400); assert.deepEqual(owners, ['token-owner']);
});
