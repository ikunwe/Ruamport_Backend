const DAY = 86400000;
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const shiftDate = (value, days) => new Date(Date.parse(value) + days * DAY).toISOString().slice(0, 10);
const thaiToday = time => new Date(time + 7 * 3600000).toISOString().slice(0, 10);
function marketDate(time, zone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(time).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function validateHistoryRange(start, end) {
  if (!validDate(start) || !validDate(end) || start > end || Date.parse(end) - Date.parse(start) > 3675 * DAY)
    throw new Error('Invalid historical range');
}
module.exports = { DAY, validDate, shiftDate, thaiToday, marketDate, validateHistoryRange };
