// Isolated @mathieuc/tradingview v3 test matching the supplied Client/Session.Chart API.
// node --use-system-ca scripts/verification/verify-tradingview-history.cjs SET:SET 5
// Dependency: npm install --prefix tmp/tradingview-validation --no-save --package-lock=false --ignore-scripts @mathieuc/tradingview@3.5.1
const path = require('node:path');
const TradingView = require(require.resolve('@mathieuc/tradingview', {
  paths: [path.resolve(__dirname, '../../tmp/tradingview-validation')],
}));
const symbol = process.argv[2] || 'SET:SET';
const range = Number(process.argv[3] || 5);
const timeframe = process.argv[4] || '1D';
if (!['SET:SET', 'SET:SET50'].includes(symbol) || ![5, 252].includes(range) || !['1D', 'D'].includes(timeframe))
  throw new Error('Use SET:SET or SET:SET50, count 5 or 252, timeframe 1D or D');
let client, chart, finished = false, connected = false, updateTimer;
const timer = setTimeout(() => finish('TIMEOUT'), 18000);
function finish(status, error) {
  if (finished) return;
  finished = true; clearTimeout(timer); clearTimeout(updateTimer);
  const rows = (chart?.periods || []).map(row => ({ date: new Date(row.time * 1000).toISOString().slice(0, 10),
    open: row.open, high: row.max, low: row.min, close: row.close, volume: row.volume })).sort((a, b) => a.date.localeCompare(b.date));
  const info = chart?.infos || {};
  console.log(JSON.stringify({ libraryVersion: '3.5.1', symbol, timeframe, requestedCandles: range, status, connected,
    error: error ? { name: error.name || null, code: error.code || null,
      message: String(error.message || error).replace(/https?:\/\/\S+/g, '[URL]').slice(0, 200) } : null,
    identity: { name: info.full_name || info.name, description: info.description, exchange: info.exchange,
      currency: info.currency_code || info.currency_id, type: info.type, timeZone: info.timezone },
    count: rows.length, first: rows[0] || null, last: rows.at(-1) || null,
    ...(range === 5 ? { rows } : {}), productionChanged: false, accountUsed: false }, null, 2));
  try { client?.end(); } catch {}
  // v3 lacks an underlying websocket error handler; exit this standalone probe cleanly.
  setTimeout(() => process.exit(status === 'AVAILABLE' ? 0 : 1), 100);
}
process.once('uncaughtException', error => finish('CONNECTION_ERROR', error));
process.once('unhandledRejection', error => finish('CONNECTION_ERROR', error));
client = new TradingView.Client();
client.onConnected(() => { connected = true; });
client.onError((...args) => finish('CLIENT_ERROR', new Error(args.map(String).join(' '))));
chart = new client.Session.Chart();
chart.onError((...args) => finish('CHART_ERROR', new Error(args.map(String).join(' '))));
chart.onUpdate(() => {
  if (!chart.periods[0]) return;
  clearTimeout(updateTimer);
  updateTimer = setTimeout(() => finish('AVAILABLE'), 400);
});
chart.setMarket(symbol, { timeframe, range });
