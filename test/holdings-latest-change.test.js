const test = require('node:test');
const assert = require('node:assert/strict');
const { withHoldingsLatestChange } = require('../src/modules/trades/holdings-latest-change');
const item = (assetType, quantity, price, previous, extra = {}) => ({ assetType, quantity,
  currency: assetType === 'OFFSHORE_STOCK' ? 'USD' : 'THB', symbol: 'TEST',
  marketValuation: { quote: { status: 'AVAILABLE', currency: assetType === 'OFFSHORE_STOCK' ? 'USD' : 'THB',
    price, previousClose: previous, previousNav: previous, previousCloseDate: '2026-10-20',
    navDate: '2026-10-21', previousNavDate: '2026-10-20', priceAt: '2026-10-21T08:00:00Z', ...extra } } });
const fx = { status: 'AVAILABLE', rate: 34, rateDate: '2026-10-21' };

test('latest change weights current quantities and converts both offshore values with the same rate', () => {
  const input = { fx, items: [item('OFFSHORE_STOCK', 2, 110, 100), item('THAI_STOCK', 10, 9, 10),
    item('MUTUAL_FUND', 20, 11, 10)] };
  const copy = structuredClone(input);
  const result = withHoldingsLatestChange(input);
  assert.deepEqual(input, copy);
  assert.equal(result.items[0].latestChange.native.change, 20);
  assert.equal(result.items[0].latestChange.thb.change, 680);
  assert.equal(result.items[0].latestChange.thb.changePercent, 10);
  const total = result.latestChange.portfolio;
  assert.equal(total.currentValue, 7790);
  assert.equal(total.referenceValue, 7100);
  assert.equal(total.change, 690);
  assert.equal(total.changePercent, 9.7183);
  assert.equal(total.isComplete, true);
  assert.equal(result.latestChange.byAssetType[1].change, -10);
  assert.equal(result.latestChange.byAssetType[2].change, 20);
  assert.equal(result.latestChange.fxDailyEffectIncluded, false);
  assert.equal(total.referenceDatesComplete, false); // Finnhub does not supply previous close date.
});

test('missing FX retains offshore native change, domestic totals and explicit partial portfolio', () => {
  const result = withHoldingsLatestChange({ items: [item('OFFSHORE_STOCK', 2, 110, 100), item('THAI_STOCK', 10, 9, 10)] });
  assert.equal(result.items[0].latestChange.status, 'FX_UNAVAILABLE');
  assert.equal(result.items[0].latestChange.native.change, 20);
  assert.equal(result.items[0].latestChange.thb.change, null);
  assert.equal(result.latestChange.portfolio.change, null);
  assert.equal(result.latestChange.portfolio.availableTotals.change, -10);
  assert.equal(result.latestChange.portfolio.calculatedPositionCount, 1);
  assert.equal(result.latestChange.byAssetType[1].isComplete, true);
});

test('missing baseline never becomes zero or hides partial coverage; zero movement remains valid', () => {
  const result = withHoldingsLatestChange({ fx, items: [item('THAI_STOCK', 10, 9, null), item('MUTUAL_FUND', 20, 10, 10)] });
  assert.equal(result.items[0].latestChange.thb.change, null);
  assert.equal(result.items[1].latestChange.thb.change, 0);
  assert.equal(result.latestChange.portfolio.change, null);
  assert.equal(result.latestChange.portfolio.availableTotals.change, 0);
  assert.equal(result.latestChange.portfolio.missingPositionCount, 1);
});

test('closed and invalid quantities do not affect totals; empty totals are zero with undefined percent', () => {
  const result = withHoldingsLatestChange({ items: [item('THAI_STOCK', 0, 10, 9), item('THAI_STOCK', -1, 10, 9),
    item('THAI_STOCK', NaN, 10, 9)] });
  assert.ok(result.items.every(row => row.latestChange.status === 'NOT_HELD'));
  assert.equal(result.latestChange.portfolio.heldPositionCount, 0);
  assert.equal(result.latestChange.portfolio.change, 0);
  assert.equal(result.latestChange.portfolio.changePercent, null);
});

test('stale snapshots and mixed NAV dates are exposed, not treated as same-day actual return', () => {
  const result = withHoldingsLatestChange({ fx: { ...fx, isStale: true }, items: [
    item('OFFSHORE_STOCK', 1, 11, 10, { isStale: true }),
    item('MUTUAL_FUND', 1, 12, 10, { navDate: '2026-10-19', previousNavDate: '2026-10-16' }),
  ] });
  assert.equal(result.latestChange.portfolio.stalePositionCount, 1);
  assert.equal(result.latestChange.portfolio.mixedReferencePeriods, true);
  assert.equal(result.items[1].latestChange.currentDate, '2026-10-19');
  assert.equal(result.items[1].latestChange.previousDate, '2026-10-16');
  assert.ok(result.latestChange.portfolio.issues.includes('STALE_FX_RATE'));
});

test('unavailable quotes, invalid FX and unsupported currency cannot create a complete grand total', () => {
  const result = withHoldingsLatestChange({ fx: { ...fx, rate: 0 }, items: [
    item('THAI_STOCK', 1, 10, 9, { status: 'UNAVAILABLE' }),
    { ...item('MUTUAL_FUND', 1, 10, 9), currency: 'USD' },
  ] });
  assert.equal(result.latestChange.portfolio.isComplete, false);
  assert.equal(result.latestChange.portfolio.change, null);
  assert.equal(result.items[1].latestChange.status, 'UNSUPPORTED');
});

test('aggregate unrounded decimals before rounding; finite overflows are explicit', () => {
  const result = withHoldingsLatestChange({ items: [item('THAI_STOCK', 1, 1.004, 1), item('THAI_STOCK', 1, 1.004, 1)] });
  assert.equal(result.items[0].latestChange.thb.change, 0);
  assert.equal(result.latestChange.portfolio.change, 0.01);
  const huge = withHoldingsLatestChange({ items: [item('THAI_STOCK', 1e100, 1e100, 1)] });
  assert.equal(huge.latestChange.portfolio.isComplete, false);
  assert.ok(huge.items[0].latestChange.issues.includes('LATEST_CHANGE_OUT_OF_RANGE'));
});
