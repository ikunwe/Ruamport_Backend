// Scheduled US-equity CORE sessions only; not a live exchange-status service.
// Verified against https://www.nyse.com/trade/hours-calendars (2026-2028).
// Outside coverage, fail safely to the ordinary TTL instead of guessing holidays.
const DAY = 86_400_000;
const FIRST = '2026-01-01';
const LAST = '2028-12-31';
const HOLIDAYS = new Set([
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
  '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31',
  '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
  '2028-01-17', '2028-02-21', '2028-04-14', '2028-05-29', '2028-06-19',
  '2028-07-04', '2028-09-04', '2028-11-23', '2028-12-25',
]);
const EARLY_CLOSE = new Set(['2026-11-27', '2026-12-24', '2027-11-26', '2028-07-03', '2028-11-24']);
const clock = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const parts = time => Object.fromEntries(clock.formatToParts(time).map(p => [p.type, p.value]));
const shift = (date, amount) => new Date(Date.parse(date + 'T12:00:00Z') + amount * DAY).toISOString().slice(0, 10);
const sessions = new Map();
function session(date) {
  if (date < FIRST || date > LAST) return null;
  if (sessions.has(date)) return sessions.get(date);
  const weekday = new Date(date + 'T12:00:00Z').getUTCDay();
  if (weekday === 0 || weekday === 6 || HOLIDAYS.has(date)) {
    sessions.set(date, null);
    return null;
  }
  function at(hour, minute) {
    const [year, month, day] = date.split('-').map(Number);
    const guess = Date.UTC(year, month - 1, day, hour, minute);
    const local = parts(guess);
    const wall = Date.UTC(Number(local.year), Number(local.month) - 1, Number(local.day), Number(local.hour), Number(local.minute));
    return guess + (guess - wall);
  }
  const value = { date, open: at(9, 30), close: at(EARLY_CLOSE.has(date) ? 13 : 16, 0) };
  sessions.set(date, value);
  return value;
}
function usMarketSchedule(time) {
  const local = parts(time);
  const date = local.year + '-' + local.month + '-' + local.day;
  const base = { source: 'US_EQUITIES_SCHEDULE', timeZone: 'America/New_York', calendarThrough: LAST,
    evaluatedAt: new Date(time).toISOString() };
  const today = session(date);
  let previous;
  let next;
  for (let distance = 0; distance <= 10; distance++) {
    const candidate = session(shift(date, -distance));
    if (candidate && candidate.close <= time) { previous = candidate; break; }
  }
  for (let distance = 0; distance <= 10; distance++) {
    const candidate = session(shift(date, distance));
    if (candidate && candidate.open > time) { next = candidate; break; }
  }
  if (date < FIRST || date > LAST || !previous || !next) return { ...base, state: 'UNKNOWN',
    sessionDate: null, sessionOpenAt: null, sessionCloseAt: null, lastCloseAt: null, nextOpenAt: null };
  return { ...base, state: today && time >= today.open && time < today.close ? 'OPEN' : 'CLOSED',
    sessionDate: today?.date || null, sessionOpenAt: today ? new Date(today.open).toISOString() : null,
    sessionCloseAt: today ? new Date(today.close).toISOString() : null,
    lastCloseAt: new Date(previous.close).toISOString(), nextOpenAt: new Date(next.open).toISOString() };
}
module.exports = { usMarketSchedule };
