const { AppError } = require('../../shared/errors/app-error');
const { decimal, multiply, ratio } = require('./valuation-decimal');
const { validDate, thaiToday, shiftDate } = require('./history-dates');
const FIELDS = new Set(['assetType', 'accountNumber', 'symbol', 'exchange', 'currency', 'action', 'quantity', 'price', 'tradeDate', 'expectedSnapshotRevision']);
const ERRORS = {
  INVALID_SIMULATION_REQUEST: [400, 'Invalid sale simulation request'],
  SIMULATION_POSITION_NOT_FOUND: [404, 'The requested holding was not found'],
  SIMULATION_POSITION_NOT_HELD: [409, 'The position must have a positive held quantity'],
  SIMULATION_QUANTITY_EXCEEDED: [422, 'Simulated sale exceeds the held quantity'],
  SIMULATION_SNAPSHOT_CHANGED: [409, 'Portfolio data changed; refresh the holding and simulate again'],
  SIMULATION_DATE_BEFORE_SNAPSHOT: [409, 'Simulation date must not precede the latest imported trade in this position'],
  SIMULATION_ORDER_LIMIT_EXCEEDED: [422, 'Simulation supports at most 20000 imported portfolio orders'],
};
function validated(body, now) {
  const bad = () => { throw new AppError(400, 'INVALID_SIMULATION_REQUEST', 'Supply SELL, complete holding identity, positive quantity/price and a current or future tradeDate'); };
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !FIELDS.has(key))) bad();
  for (const key of ['assetType', 'accountNumber', 'symbol', 'exchange', 'currency', 'action', 'quantity', 'price', 'tradeDate'])
    if (!Object.hasOwn(body, key)) bad();
  if (!['OFFSHORE_STOCK', 'THAI_STOCK', 'MUTUAL_FUND'].includes(body.assetType) || body.action !== 'SELL'
    || body.currency !== (body.assetType === 'OFFSHORE_STOCK' ? 'USD' : 'THB')) bad();
  if (typeof body.symbol !== 'string' || !body.symbol.trim() || body.symbol.length > 200 || /[\x00-\x1f]/.test(body.symbol)) bad();
  if (body.accountNumber !== null && (typeof body.accountNumber !== 'string' || !body.accountNumber.trim()
    || body.accountNumber.length > 100 || /[\x00-\x1f]/.test(body.accountNumber))) bad();
  if (body.exchange !== null && (typeof body.exchange !== 'string' || !/^[A-Z0-9._-]{1,20}$/.test(body.exchange))) bad();
  if (body.assetType === 'MUTUAL_FUND' && body.exchange !== null) bad();
  for (const key of ['quantity', 'price']) {
    const value = body[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1e9 || decimal(value).s > 12) bad();
  }
  if (ratio(multiply(decimal(body.quantity), decimal(body.price)), decimal(1), 2) === null || body.quantity * body.price > 1e12) bad();
  const today = thaiToday(now);
  if (!validDate(body.tradeDate) || body.tradeDate < today || body.tradeDate > shiftDate(today, 365)) bad();
  if (body.expectedSnapshotRevision !== undefined && (typeof body.expectedSnapshotRevision !== 'string'
    || !/^sim-v1:[a-f0-9]{32}$/.test(body.expectedSnapshotRevision))) bad();
  return { ...body, symbol: body.symbol.trim(), accountNumber: body.accountNumber?.trim() ?? null };
}
function createSellSimulatorService({ repository, now = Date.now }) {
  return {
    async simulate(userId, body) {
      const input = validated(body, now());
      const result = await repository.simulateSale(userId, input);
      if (result?.errorCode && Object.hasOwn(ERRORS, result.errorCode)) {
        const [status, message] = ERRORS[result.errorCode]; throw new AppError(status, result.errorCode, message);
      }
      if (!result || !['CALCULATED', 'INCOMPLETE'].includes(result.status) || result.persisted !== false)
        throw new AppError(503, 'SIMULATION_UNAVAILABLE', 'Sale simulation unavailable; check migration 022');
      return result;
    },
  };
}
module.exports = { createSellSimulatorService };
