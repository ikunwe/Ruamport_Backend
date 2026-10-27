// Read-only diagnostic. No environment file, database, credentials or production changes.
// node --use-system-ca scripts/verification/verify-yahoo-index-history.cjs
const { createPortfolioHistoryMarket } = require('../../src/modules/trades/portfolio-history-market');
const stamp = value => Number.isSafeInteger(value) && value > 0 ? new Date(value * 1000).toISOString() : null;
const sec = date => String(Date.parse(date) / 1000);
async function main() {
  const results = [];
  let blocked = false;
  const variants = [
    ['range_1mo', { range: '1mo', interval: '1d' }],
    ['range_1y', { range: '1y', interval: '1d' }],
    ['range_max', { range: 'max', interval: '1d' }],
    ['past_2024', { period1: sec('2024-01-01'), period2: sec('2025-01-01'), interval: '1d' }],
    ['thai_midnight_2026', { period1: sec('2026-08-01T00:00:00+07:00'), period2: sec('2026-10-27T00:00:00+07:00'), interval: '1d', events: 'history', includeAdjustedClose: 'true' }],
    ['weekly_5y', { range: '5y', interval: '1wk' }],
  ];
  for (const symbol of ['^SET.BK', '^SET50.BK']) {
    for (const [variant, params] of variants) {
      if (blocked) break;
      const host = 'query1.finance.yahoo.com';
      const response = await fetch(`https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?${new URLSearchParams(params)}`,
        { signal: AbortSignal.timeout(15000), redirect: 'error', headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' } });
      if ([421, 429].includes(response.status)) blocked = true;
      let body; try { body = await response.json(); } catch { body = null; }
      const chart = body?.chart?.result?.[0], meta = chart?.meta, timestamps = chart?.timestamp || [];
      const closes = chart?.indicators?.quote?.[0]?.close || [];
      results.push({ host, symbol, variant, status: response.status, chartErrorCode: body?.chart?.error?.code || null,
        responseSymbol: meta?.symbol, instrumentType: meta?.instrumentType, exchange: meta?.exchangeName,
        timeZone: meta?.exchangeTimezoneName, firstTradeAt: stamp(meta?.firstTradeDate),
        granularity: meta?.dataGranularity, rawTimestampCount: timestamps.length,
        nonNullCloseCount: closes.filter(value => typeof value === 'number' && Number.isFinite(value)).length,
        firstTimestamp: stamp(timestamps[0]), lastTimestamp: stamp(timestamps.at(-1)),
        validRanges: meta?.validRanges });
    }
  }
  for (const [symbol, host] of [['^SET.BK', 'query2.finance.yahoo.com'], ['^SET50.BK', 'query2.finance.yahoo.com'],
    ['^GSPC', 'query1.finance.yahoo.com'], ['^IXIC', 'query1.finance.yahoo.com'], ['ASK.BK', 'query1.finance.yahoo.com']]) {
    if (blocked) break;
    const response = await fetch(`https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d`,
      { signal: AbortSignal.timeout(15000), redirect: 'error', headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' } });
    if ([421, 429].includes(response.status)) blocked = true;
    let body; try { body = await response.json(); } catch { body = null; }
    const chart = body?.chart?.result?.[0];
    results.push({ host, symbol, variant: 'control_1y', status: response.status, chartErrorCode: body?.chart?.error?.code || null,
      rawTimestampCount: chart?.timestamp?.length || 0, firstTimestamp: stamp(chart?.timestamp?.[0]), lastTimestamp: stamp(chart?.timestamp?.at(-1)) });
  }
  const adapterResults = [];
  if (!blocked) {
    const market = createPortfolioHistoryMarket();
    for (const id of ['SET', 'SET50', 'SP500', 'NASDAQ_COMPOSITE']) {
      const result = await market.getIndexSeries(id, '2026-08-01', '2026-10-26');
      adapterResults.push({ id, status: result.status, errorCode: result.errorCode || null,
        pointCount: result.points.length, firstDate: result.points[0]?.date, lastDate: result.points.at(-1)?.date });
    }
  }
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), productionChanged: false,
    stoppedForRateLimit: blocked, results, adapterResults }, null, 2));
}
main().catch(() => { console.error('Public Yahoo history diagnostic failed; upstream details omitted'); process.exitCode = 1; });
