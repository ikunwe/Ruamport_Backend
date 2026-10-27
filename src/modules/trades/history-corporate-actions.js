const { decimal, multiply } = require('./valuation-decimal');
const { validDate, marketDate } = require('./history-dates');
// No intermediate floating-point ratio; retain 18 decimal places internally.
function applySplit(value, event) {
  const a = multiply(value, decimal(event.numerator));
  const b = decimal(event.denominator);
  const shift = b.s - a.s + 18;
  let n = a.n * (shift >= 0 ? 10n ** BigInt(shift) : 1n);
  const d = b.n * (shift < 0 ? 10n ** BigInt(-shift) : 1n);
  const negative = n < 0n;
  n = n < 0n ? -n : n;
  let result = n / d + (n % d * 2n >= d ? 1n : 0n);
  if (negative) result = -result;
  return { n: result, s: 18 };
}
function validSplit(event) {
  return event?.type === 'SPLIT' && validDate(event.date)
    && Number.isSafeInteger(event.numerator) && event.numerator > 0 && event.numerator <= 1000000
    && Number.isSafeInteger(event.denominator) && event.denominator > 0 && event.denominator <= 1000000
    && event.numerator !== event.denominator;
}
function parseSplitEvents(raw, zone, start, end) {
  if (raw === undefined) return [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid split events');
  const events = Object.values(raw);
  if (events.length > 100) throw new Error('Too many split events');
  const seen = new Set();
  return events.map(value => {
    if (!Number.isSafeInteger(value?.date) || value.date <= 0) throw new Error('Invalid split date');
    const event = { type: 'SPLIT', date: marketDate(value.date * 1000, zone),
      numerator: value.numerator, denominator: value.denominator, source: 'YAHOO_FINANCE' };
    if (!validSplit(event) || event.date < start || event.date > end || seen.has(event.date)) throw new Error('Invalid split');
    if (value.splitRatio !== undefined && value.splitRatio !== `${event.numerator}:${event.denominator}`)
      throw new Error('Conflicting split ratio');
    seen.add(event.date);
    return event;
  }).sort((a, b) => a.date.localeCompare(b.date));
}
module.exports = { applySplit, validSplit, parseSplitEvents };
