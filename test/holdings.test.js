const test = require('node:test');
const assert = require('node:assert/strict');
const { createInvestmentService } = require('../src/modules/trades/investment.service');
const { createInvestmentRepository } = require('../src/modules/trades/investment.repository');

test('holdings returns offshore compressed FIFO costs without replacing historical gross or fees', async () => {
  const usd = { currency: 'USD', method: 'COMPRESSED_FIFO', averageCostPerUnit: 190 / 15, remainingCost: 190, rawAverageCostPerUnit: 190 / 15, rawRemainingCost: 190,
    quantity: 15, roundingAdjusted: false, status: 'CALCULATED', issues: [] };
  const thb = { ...usd, currency: 'THB', averageCostPerUnit: 6790 / 15, remainingCost: 6790, rawAverageCostPerUnit: 6790 / 15, rawRemainingCost: 6790 };
  const data = { items: [{ assetType: 'OFFSHORE_STOCK', symbol: 'AMD', quantity: 15, costBasisMethod: 'COMPRESSED_FIFO', costBasis: [thb, usd], amounts: [{ currency: 'USD', totalBuyGross: 240, totalFeeIncludeVat: 1 }] }],
    costBasisMethod: 'BY_ASSET_TYPE', costBasisSource: 'GROSS_AMOUNT_EXCLUDING_FEES',
    remainingCostTotals: [{ currency: 'USD', remainingCost: 190, isComplete: true }],
    stockRemainingCostTotals: [{ currency: 'USD', remainingCost: 190, isComplete: true }] };
  const repository = createInvestmentRepository(() => ({ rpc: async (name, params) => {
    assert.equal(name, 'get_stock_holdings');
    assert.equal(params.p_user_id, 'owner');
    return { data, error: null };
  } }));
  assert.deepEqual(await createInvestmentService({ repository }).holdings('owner'), data);
});

test('holdings preserves different methods per asset type rather than labelling every cost as FIFO', async () => {
  const data = { costBasisMethod: 'BY_ASSET_TYPE', costBasisGroupingDate: 'TRADE_DATE_AS_PARSED',
    costBasisMethods: { OFFSHORE_STOCK: 'COMPRESSED_FIFO', THAI_STOCK: 'FIFO', MUTUAL_FUND: 'MOVING_WEIGHTED_AVERAGE' },
    items: [
      { assetType: 'OFFSHORE_STOCK', costBasisMethod: 'COMPRESSED_FIFO', costBasisOrder: 'TRADE_DATE_DAILY_LOTS',
        costBasis: [{ currency: 'USD', method: 'COMPRESSED_FIFO', remainingCost: 700 }] },
      { assetType: 'THAI_STOCK', costBasisMethod: 'FIFO',
        costBasis: [{ currency: 'THB', method: 'FIFO', remainingCost: 450 }] },
      { assetType: 'MUTUAL_FUND', costBasisMethod: 'MOVING_WEIGHTED_AVERAGE',
        costBasis: [{ currency: 'THB', method: 'MOVING_WEIGHTED_AVERAGE', status: 'INCOMPLETE', remainingCost: null, issues: ['BUY_AMOUNT_REQUIRED'] }] },
    ] };
  assert.deepEqual(await createInvestmentService({ repository: { holdings: async () => data } }).holdings('owner'), data);
});

test('holdings preserves unknown cost and raw rounding residue as distinct from displayed zero', async () => {
  const data = { items: [
    { symbol: 'CLOSED', costBasis: [{ currency: 'USD', status: 'CALCULATED', averageCostPerUnit: null, remainingCost: 0,
      rawRemainingCost: -0.0000024, roundingAdjusted: true, issues: ['ROUNDING_CLOSURE_ESTIMATE'] }] },
    { symbol: 'UNKNOWN', costBasis: [{ currency: 'USD', status: 'INCOMPLETE', averageCostPerUnit: null, remainingCost: null,
      issues: ['SELL_EXCEEDS_AVAILABLE_UNITS'] }] },
  ], remainingCostTotals: [{ currency: 'USD', remainingCost: null, isComplete: false, incompletePositionCount: 1 }] };
  const service = createInvestmentService({ repository: { holdings: async () => data } });
  assert.deepEqual(await service.holdings('owner', { includeClosed: 'true' }), data);
});

test('fund Average Cost exposes the stored PDF amount source and no fee deduction', async () => {
  const cost = { currency: 'THB', method: 'MOVING_WEIGHTED_AVERAGE', source: 'PDF_ORDER_TOTAL_AMOUNT_EXCLUDING_FEES',
    feesIncluded: false, status: 'CALCULATED', quantity: 15, averageCostPerUnit: 12,
    remainingCost: 180, rawAverageCostPerUnit: 12, rawRemainingCost: 180, roundingAdjusted: false, issues: [] };
  const data = { items: [{ assetType: 'MUTUAL_FUND', fundName: 'TEST FUND', quantity: 15,
    costBasisMethod: 'MOVING_WEIGHTED_AVERAGE', costBasisSource: 'PDF_ORDER_TOTAL_AMOUNT_EXCLUDING_FEES', costBasis: [cost] }],
    costBasisSources: { MUTUAL_FUND: 'PDF_ORDER_TOTAL_AMOUNT_EXCLUDING_FEES' },
    remainingCostTotals: [{ currency: 'THB', remainingCost: 180, isComplete: true }] };
  const repository = createInvestmentRepository(() => ({ rpc: async (name, params) => {
    assert.equal(name, 'get_stock_holdings'); assert.equal(params.p_user_id, 'owner');
    return { data, error: null };
  } }));
  assert.deepEqual(await createInvestmentService({ repository }).holdings('owner'), data);
});

test('fund missing investment amount remains unknown rather than falling back to NAV or zero', async () => {
  const data = { items: [{ assetType: 'MUTUAL_FUND', costBasis: [{ currency: 'THB', method: 'MOVING_WEIGHTED_AVERAGE',
    remainingCost: null, averageCostPerUnit: null, status: 'INCOMPLETE', issues: ['BUY_AMOUNT_REQUIRED'],
    source: 'PDF_ORDER_TOTAL_AMOUNT_EXCLUDING_FEES', feesIncluded: false }] }] };
  assert.deepEqual(await createInvestmentService({ repository: { holdings: async () => data } }).holdings('owner'), data);
});

test('holdings exposes gross and VAT-inclusive fees separately without changing legacy payment totals', async () => {
  const usd = { currency: 'USD', totalBuy: 30, totalSell: 40, totalBuyGross: 29.95, totalSellGross: 40.1,
    totalBuyFeeIncludeVat: 0.05, totalSellFeeIncludeVat: 0.1, totalFeeIncludeVat: 0.15,
    grossIsComplete: true, missingGrossAmountCount: 0, feeIsComplete: true, missingFeeAmountCount: 0 };
  const thb = { currency: 'THB', totalBuy: 1050, totalSell: 1400, totalBuyGross: 1048.25,
    totalSellGross: 1403.5, totalFeeIncludeVat: 5.25, feeIsComplete: true };
  const data = { items: [{ symbol: 'AMD', amounts: [thb, usd] }], moneyTotals: [thb, usd], stockMoneyTotals: [thb, usd],
    documentDiscountsApplied: false, grossSource: 'PDF_ORDER_GROSS_AMOUNT', feeSource: 'PDF_ORDER_FEES_INCLUDE_VAT_BEFORE_DOCUMENT_DISCOUNTS' };
  const repository = createInvestmentRepository(() => ({ rpc: async (name, params) => {
    assert.equal(name, 'get_stock_holdings');
    assert.equal(params.p_user_id, 'owner');
    return { data, error: null };
  } }));
  const result = await createInvestmentService({ repository }).holdings('owner');
  assert.deepEqual(result, data);
  assert.equal(result.items[0].amounts.find(row => row.currency === 'USD').totalBuy, 30);
  assert.equal(result.items[0].amounts.find(row => row.currency === 'USD').totalBuyGross, 29.95);
  assert.equal(result.documentDiscountsApplied, false);
});

test('holdings retains independently missing gross and fees, rather than deriving either from payments', async () => {
  const data = { items: [{ assetType: 'MUTUAL_FUND', amounts: [{ currency: 'THB', totalBuy: 100,
    totalBuyGross: null, grossIsComplete: false, missingGrossAmountCount: 1,
    totalBuyFeeIncludeVat: 1, totalFeeIncludeVat: 1, feeIsComplete: true }] }],
    moneyTotals: [{ currency: 'THB', totalBuyGross: null, totalFeeIncludeVat: null, feeIsComplete: false }],
    stockMoneyTotals: [{ currency: 'USD', totalBuyGross: 29.95, totalFeeIncludeVat: 0 }] };
  const service = createInvestmentService({ repository: { holdings: async () => data } });
  assert.deepEqual(await service.holdings('owner'), data);
  assert.equal(data.items[0].amounts.some(row => row.currency === 'USD'), false);
});

test('holdings preserves SQL monetary totals, missing amounts and currency scope without frontend recomputation', async () => {
  const totals = [{ currency: 'USD', totalBuy: 100, totalSell: 120, totalSwitchIn: 0, totalSwitchOut: 0, netBuySellCashFlow: -20, isComplete: true, missingAmountCount: 0, orderCount: 2 },
    { currency: 'THB', totalBuy: null, totalSell: 4200, netBuySellCashFlow: null, isComplete: false, missingAmountCount: 1 }];
  const expected = { items: [{ symbol: 'AMD', quantity: 0, status: 'CLOSED', amounts: totals }], moneyTotals: totals,
    moneySource: 'IMPORTED_ORDER_TOTALS', moneyTotalsScope: 'ALL_IMPORTED_SUPPORTED_ORDERS_INCLUDING_CLOSED' };
  const repository = createInvestmentRepository(() => ({ rpc: async (name, params) => {
    assert.equal(name, 'get_stock_holdings');
    assert.deepEqual(params, { p_user_id: 'owner', p_include_closed: true });
    return { data: expected, error: null };
  } }));
  const result = await createInvestmentService({ repository }).holdings('owner', { includeClosed: 'true' });
  assert.deepEqual(result, expected);
  assert.equal(result.items[0].amounts[1].totalBuy, null);
  assert.equal(Object.hasOwn(result, 'marketValue'), false);
});

test('holdings uses authenticated user, supports closed positions and preserves DB quantities', async () => {
  const calls = [];
  const response = { scope: 'STOCK_BUY_SELL_ONLY', items: [{ symbol: 'ABC', quantity: 0.3 }, { symbol: 'XYZ', quantity: -1 }], warnings: [{ code: 'NEGATIVE_HOLDINGS' }] };
  const service = createInvestmentService({ repository: { holdings: async (...args) => { calls.push(args); return response; } } });
  assert.deepEqual(await service.holdings('owner', { userId: 'other' }), response);
  await service.holdings('owner', { includeClosed: 'true' });
  assert.deepEqual(calls, [['owner', false], ['owner', true]]);
});
test('holdings rejects ambiguous filters instead of broadening queries', async () => {
  let called = false;
  const service = createInvestmentService({ repository: { holdings: async () => { called = true; } } });
  for (const includeClosed of ['yes', '1', '', ['true'], {}]) {
    await assert.rejects(service.holdings('owner', { includeClosed }), { code: 'INVALID_HOLDINGS_FILTER' });
  }
  assert.equal(called, false);
});
test('holdings repository delegates complete aggregation to a user-scoped SQL RPC', async () => {
  const calls = [];
  const result = { items: [], excludedTransactions: [], warnings: [] };
  const repository = createInvestmentRepository(() => ({ rpc: async (name, params) => { calls.push({ name, params }); return { data: result, error: null }; } }));
  assert.deepEqual(await repository.holdings('owner', true), result);
  assert.deepEqual(calls, [{ name: 'get_stock_holdings', params: { p_user_id: 'owner', p_include_closed: true } }]);
});
test('holdings storage errors are explicit and do not leak database details', async () => {
  const repository = createInvestmentRepository(() => ({ rpc: async () => ({ data: null, error: { message: 'private SQL details' } }) }));
  await assert.rejects(repository.holdings('owner', false), error => error.code === 'INVESTMENT_STORAGE_UNAVAILABLE' && !error.message.includes('private SQL'));
});

test('holdings API preserves raw quantity and display adjustment separately', async () => {
  const result = { roundingTolerance: 0.0000003, roundingAdjustedCount: 1, items: [{ symbol: 'AMD', rawQuantity: -0.0000002, quantity: 0, roundingAdjusted: true, status: 'CLOSED' }] };
  const service = createInvestmentService({ repository: { holdings: async (_userId, includeClosed) => { assert.equal(includeClosed, true); return result; } } });
  const response = await service.holdings('owner', { includeClosed: 'true' });
  assert.equal(response.items[0].rawQuantity, -0.0000002);
  assert.equal(response.items[0].quantity, 0);
  assert.equal(response.items[0].roundingAdjusted, true);
  assert.equal(response.roundingTolerance, 0.0000003);
});

test('holdings API returns mutual funds and preserves their unit precision and movement fields', async () => {
  const data = { scope: 'STOCKS_AND_MUTUAL_FUNDS', roundingAppliesTo: ['OFFSHORE_STOCK', 'THAI_STOCK'], items: [
    { assetType: 'OFFSHORE_STOCK', symbol: 'AMD', quantity: 1 },
    { assetType: 'MUTUAL_FUND', symbol: 'KKP US500-UH-E', fundName: 'KKP US500-UH-E', boughtUnits: 10, soldUnits: 2, switchInUnits: 3, switchOutUnits: 1, acquiredUnits: 13, disposedUnits: 3, quantity: 10, rawQuantity: 10, roundingAdjusted: false, roundingTolerance: null },
    { assetType: 'MUTUAL_FUND', symbol: 'TINY-FUND', quantity: 0.0000002, rawQuantity: 0.0000002, roundingAdjusted: false, roundingTolerance: null },
  ] };
  const service = createInvestmentService({ repository: { holdings: async userId => { assert.equal(userId, 'owner'); return data; } } });
  const result = await service.holdings('owner');
  assert.equal(result.scope, 'STOCKS_AND_MUTUAL_FUNDS');
  assert.equal(result.items[1].fundName, 'KKP US500-UH-E');
  assert.equal(result.items[1].quantity, 10);
  assert.equal(result.items[2].quantity, 0.0000002);
  assert.equal(result.items[2].roundingAdjusted, false);
});
