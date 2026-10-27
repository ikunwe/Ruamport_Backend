// Decimal arithmetic on serialized inputs. Round only at the API boundary.
function decimal(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const [coefficient, exponent = '0'] = String(value).toLowerCase().split('e');
  return { n: BigInt(coefficient.replace('.', '')), s: (coefficient.split('.')[1]?.length || 0) - Number(exponent) };
}
function add(a, b) {
  if (!a || !b) return null;
  const s = Math.max(a.s, b.s);
  return { n: a.n * 10n ** BigInt(s - a.s) + b.n * 10n ** BigInt(s - b.s), s };
}
const subtract = (a, b) => b ? add(a, { ...b, n: -b.n }) : null;
const multiply = (a, b) => a && b ? { n: a.n * b.n, s: a.s + b.s } : null;
function ratio(a, b, places = 4) {
  if (!a || !b || b.n === 0n) return null;
  const shift = b.s - a.s + places;
  let n = a.n * (shift >= 0 ? 10n ** BigInt(shift) : 1n);
  let d = b.n * (shift < 0 ? 10n ** BigInt(-shift) : 1n);
  const negative = (n < 0n) !== (d < 0n);
  n = n < 0n ? -n : n;
  d = d < 0n ? -d : d;
  let rounded = n / d + (n % d * 2n >= d ? 1n : 0n);
  if (negative) rounded = -rounded;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER) || rounded < -BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(rounded) / 10 ** places;
}
const number = (value, places = 2) => ratio(value, { n: 1n, s: 0 }, places);
module.exports = { decimal, add, subtract, multiply, ratio, number };
