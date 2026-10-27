// Isolated live diagnostic; no .env, Supabase, or production imports.
// node --use-system-ca verify-yahoo-finance2.cjs
const YahooFinance = require(require.resolve('yahoo-finance2', { paths: [require('node:path').resolve(__dirname, '../../tmp/yahoo-finance2-validation')] })).default;
const today = new Date(), oneYearAgo = new Date();
oneYearAgo.setFullYear(today.getFullYear() - 1);
const query = { period1: oneYearAgo.toISOString().split('T')[0],
  period2: today.toISOString().split('T')[0], interval: '1d' };
const thaiDates = process.argv.includes('--thai-dates');
if (thaiDates) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Bangkok',
    year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(today).map(part => [part.type, part.value]));
  query.period2 = `${parts.year}-${parts.month}-${parts.day}`;
  query.period1 = `${Number(parts.year) - 1}-${parts.month}-${parts.day}`;
}
const calls = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url || String(input));
  const signals = [init.signal, AbortSignal.timeout(12000)].filter(Boolean);
  const response = await originalFetch(input, { ...init, signal: AbortSignal.any(signals) });
  calls.push({ host: url.hostname, path: url.pathname, status: response.status });
  return response;
};
const safeError = error => ({ name: error.name,
  needsInstance: /new YahooFinance/.test(error.message || ''),
  noData: /No data found|No historical data|delisted|Not Found/i.test(error.message || ''),
  validation: /validation/i.test(error.name || ''),
  timeout: /timeout|aborted/i.test(error.message || '') });
(async () => {
  let originalSnippet;
  try {
    const data = await YahooFinance.historical('^SET50', query);
    originalSnippet = { success: true, count: data.length };
  } catch (error) { originalSnippet = { success: false, ...safeError(error) }; }
  const noop = () => {};
  const client = new YahooFinance({ versionCheck: false,
    logger: { info: noop, warn: noop, error: noop, debug: noop, dir: noop } });
  const results = [];
  for (const symbol of ['^SET50', '^SET50.BK', '^SET.BK', '^GSPC']) {
    const before = calls.length;
    try {
      const rows = await client.historical(symbol, query);
      const data = rows.filter(row => row.date instanceof Date).sort((a, b) => a.date - b.date);
      results.push({ symbol, success: true, count: data.length, first: data[0] || null,
        last: data.at(-1) || null, requests: calls.slice(before) });
    } catch (error) { results.push({ symbol, success: false, ...safeError(error), requests: calls.slice(before) }); }
    if (calls.some(row => [421, 429].includes(row.status))) break;
  }
  console.log(JSON.stringify({ version: '4.0.5', dateBasis: thaiDates ? 'ASIA_BANGKOK' : 'UTC_AS_IN_USER_SNIPPET',
    query, originalSnippet, results, productionChanged: false }, null, 2));
})().catch(error => { console.error(JSON.stringify({ failure: safeError(error) })); process.exitCode = 1; });
