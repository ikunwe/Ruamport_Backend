const { shiftDate, validateHistoryRange, validDate } = require('./history-dates');
const { providerFailureDetails } = require('./public-market-cache');

// Public daily observations only; never store orders, balances or portfolio values.
// Coverage means a successful provider query, including weekends with no observations.
function createHistoryRangeCache({ now = Date.now, ttlMs = 6 * 3600000, maxEntries = 100 } = {}) {
  const entries = new Map();
  return async function cached(key, start, end, load, unavailable) {
    validateHistoryRange(start, end);
    let state = entries.get(key);
    if (!state) {
      state = { segments: [], failures: [], tail: Promise.resolve(), busy: 0 };
      entries.set(key, state);
    }
    entries.delete(key);
    entries.set(key, state);
    state.busy++;
    const work = state.tail.then(async () => {
      state.segments = state.segments.filter(row => row.at + ttlMs > now());
      state.failures = state.failures.filter(row => row.retryAt > now());
      const hadCoverage = state.segments.some(row => row.start <= end && row.end >= start);
      let providerLoads = 0;
      const gaps = [];
      let cursor = start;
      for (const row of [...state.segments].sort((a, b) => a.start.localeCompare(b.start))) {
        if (row.end < cursor || row.start > end) continue;
        if (row.start > cursor) gaps.push([cursor, shiftDate(row.start, -1)]);
        if (row.end >= cursor) cursor = shiftDate(row.end, 1);
      }
      if (cursor <= end) gaps.push([cursor, end]);
      for (const [from, to] of gaps) {
        // Only the Yahoo adapter supplies this lower bound after validating the
        // instrument and firstTradeDate. Never infer it from the first bar in a
        // requested window, or reinterpret an arbitrary HTTP 400 as empty data.
        const anchors = state.segments.filter(row => row.data.source === 'YAHOO_FINANCE'
          && validDate(row.data.historyAvailableFrom));
        const bounds = new Set(anchors.map(row => row.data.historyAvailableFrom));
        const anchor = bounds.size === 1 ? anchors[0] : null;
        let loadFrom = from;
        if (anchor && from < anchor.data.historyAvailableFrom) {
          const beforeEnd = shiftDate(anchor.data.historyAvailableFrom, -1);
          const emptyEnd = beforeEnd < to ? beforeEnd : to;
          state.segments.push({ start: from, end: emptyEnd, at: anchor.at,
            data: { ...structuredClone(anchor.data), points: [], corporateActions: [],
              eventCoverageStart: from, eventCoverageEnd: emptyEnd } });
          loadFrom = shiftDate(emptyEnd, 1);
          if (loadFrom > to) continue;
        }
        const blocked = state.failures.find(row => row.start <= to && row.end >= loadFrom);
        if (blocked) return { ...unavailable(blocked), cacheStatus: 'RETRY_WAIT' };
        try {
          providerLoads++;
          const data = await load(loadFrom, to);
          if (data?.status !== 'AVAILABLE') throw Object.assign(new Error('History unavailable'),
            { safeCode: data?.errorCode || 'HISTORY_NOT_AVAILABLE' });
          state.segments.push({ start: loadFrom, end: to, at: now(), data: structuredClone(data) });
        } catch (error) {
          const failure = { start: loadFrom, end: to, code: error.safeCode || 'HISTORY_NOT_AVAILABLE', ...providerFailureDetails(error),
            retryAt: Number.isFinite(error.retryAt) ? error.retryAt : now() + 60_000 };
          state.failures.push(failure);
          state.failures = state.failures.slice(-64);
          return { ...unavailable(failure), cacheStatus: 'LOAD_FAILED' };
        }
      }
      const rows = state.segments.filter(row => row.start <= end && row.end >= start);
      const points = [];
      const actions = [];
      for (const row of rows) {
        for (const point of row.data.points) {
          // Preserve duplicate observations so the engine can reject conflicting prices.
          if (point.date >= start && point.date <= end && point.date >= row.start && point.date <= row.end) points.push(point);
        }
        for (const action of row.data.corporateActions || []) {
          if (action.date >= start && action.date <= end && action.date >= row.start && action.date <= row.end) actions.push(action);
        }
      }
      const at = Math.min(...rows.map(row => row.at));
      const data = rows.at(-1).data;
      // Raw Yahoo closes can already reflect splits outside the requested
      // price slice. Supply all fresh known events for normalization, while
      // corporateActions below remains limited to the requested replay range.
      const normalizationActions = data.priceBasis === 'YAHOO_SPLIT_ADJUSTED'
        ? state.segments.flatMap(row => (row.data.corporateActions || [])
          .filter(action => action.date >= row.start && action.date <= row.end))
          .sort((a, b) => a.date.localeCompare(b.date)) : null;
      const result = { ...data, points: points.sort((a, b) => a.date.localeCompare(b.date)),
        ...(normalizationActions ? { normalizationActions } : {}),
        ...(data.corporateActions ? { corporateActions: actions.sort((a, b) => a.date.localeCompare(b.date)),
          eventCoverageStart: start, eventCoverageEnd: end } : {}),
        listingTransfer: rows.find(row => row.data.listingTransfer)?.data.listingTransfer || data.listingTransfer,
        fetchedAt: new Date(at).toISOString(), expiresAt: new Date(at + ttlMs).toISOString(),
        fromCache: providerLoads === 0, isStale: false,
        cacheStatus: providerLoads === 0 ? 'HIT' : hadCoverage ? 'PARTIAL' : 'MISS' };
      // Bound both instrument count and segment count. Eviction is safe: it only costs a refetch.
      state.segments = state.segments.slice(-64);
      return structuredClone(result);
    });
    state.tail = work.catch(() => {});
    try { return await work; } finally {
      state.busy--;
      while (entries.size > maxEntries) {
        const candidate = [...entries].find(([, value]) => !value.busy);
        if (!candidate) break;
        entries.delete(candidate[0]);
      }
    }
  };
}
module.exports = { createHistoryRangeCache };
