const crypto = require('node:crypto');
const { AppError } = require('../../shared/errors/app-error');
const { createInvestmentRepository } = require('./investment.repository');
const { preparePreview } = require('./preview-analysis');
const { frankfurterService } = require('./frankfurter.service');
const { withHoldingsFx } = require('./holdings-fx');
const { stockPriceService, instrument } = require('./stock-price.service');
const { withHoldingsValuation } = require('./holdings-valuation');
const { domesticMarketService, domesticInstrument } = require('./domestic-market.service');
const { withDomesticValuation } = require('./domestic-valuation');
const { withHoldingsLatestChange } = require('./holdings-latest-change');
const { thaiStockLogo } = require('./thai-stock-logo');
const { createFundLogoService } = require('./fund-logo.service');
const { createPortfolioHistoryService } = require('./portfolio-history.service');
const { createPortfolioHistoryMarket } = require('./portfolio-history-market');
const { createAnalyticsService } = require('./analytics.service');
const { createSellSimulatorService } = require('./sell-simulator.service');
const TYPES = new Set(['DIME_OFFSHORE_CONFIRMATION_NOTE', 'DIME_THAI_STOCK_CONFIRMATION_NOTE', 'DIME_MUTUAL_FUND_CONFIRMATION_NOTE']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PARSER_VERSION = 1;
const fileHash = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
function identityKey(document) {
  const identifier = document.taxInvoiceNumber || document.documentNumber;
  if (!identifier) return null;
  // JSON encodes field boundaries; accounts/users never share an identity.
  return JSON.stringify([document.type, String(document.accountNumber || '').replace(/\s+/g, ''), String(identifier).replace(/\s+/g, '').toUpperCase()]);
}
function record(row, alreadyRead = true) {
  return { id: row.id, status: row.status, alreadyRead, readAt: row.created_at, importedAt: row.imported_at, orderCount: row.preview.orders.length,
    importedOrderCount: row.preview.importResult?.transactionCount ?? null,
    duplicateOrderCount: row.preview.importResult?.duplicateOrderCount ?? null,
    hasWarnings: Boolean(row.preview.validation?.warnings?.length || row.preview.importResult?.warnings?.length),
    canImport: row.status === 'PREVIEW' && Boolean(row.identity_key) };
}
function createInvestmentService({ repository = createInvestmentRepository(), exchangeRates = frankfurterService,
  marketPrices = stockPriceService, domesticPrices = domesticMarketService, fundLogos, historyMarket, historyNow = Date.now } = {}) {
  const fundLogoReader = fundLogos || createFundLogoService({ getFundIdentity: item => domesticPrices.getFundIdentity(item) });
  const historicalMarket = historyMarket || createPortfolioHistoryMarket({ marketPrices, domesticPrices });
  const portfolioHistory = createPortfolioHistoryService({ repository, now: historyNow, market: historicalMarket });
  const analytics = createAnalyticsService({ repository, market: historicalMarket, now: historyNow });
  const simulator = createSellSimulatorService({ repository, now: historyNow });
  return {
    simulateSale: (userId, request) => simulator.simulate(userId, request),
    analyticsPerformance: (userId, query) => analytics.performance(userId, query),
    analyticsWinRate: (userId, query) => analytics.winRate(userId, query),
    portfolioHistory: (userId, query) => portfolioHistory.get(userId, query),
    async cached(userId, buffer) {
      const row = await repository.byHash(userId, fileHash(buffer));
      return row ? { preview: preparePreview(row.preview), record: record(row) } : null;
    },
    async stage(userId, buffer, preview) {
      if (!TYPES.has(preview.document?.type) || !Array.isArray(preview.orders) || !preview.orders.length) throw new AppError(422, 'DIME_DOCUMENT_UNSUPPORTED', 'Only supported confirmations can be saved');
      const result = await repository.register(userId, fileHash(buffer), identityKey(preview.document), preparePreview(preview));
      return { preview: preparePreview(result.document.preview), record: record(result.document, result.alreadyRead) };
    },
    async history(userId, mailbox, messageId) {
      return repository.history(userId, mailbox.toLowerCase(), messageId);
    },
    async known(userId, entry) {
      if (entry.status === 'IGNORED') return entry.parser_version === PARSER_VERSION ? { ignored: true } : null;
      const row = await repository.byId(userId, entry.document_id);
      return row ? { preview: preparePreview(row.preview), record: record(row) } : null;
    },
    async remember(userId, mailbox, messageId, attachmentKey, documentId = null) {
      return repository.saveHistory({ user_id: userId, mailbox: mailbox.toLowerCase(), message_id: messageId, attachment_key: attachmentKey, document_id: documentId, status: documentId ? 'READ' : 'IGNORED', parser_version: PARSER_VERSION });
    },
    async importMany(userId, body) {
      const ids = body?.documentIds;
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > 50 || ids.some(id => typeof id !== 'string' || !UUID.test(id))) throw new AppError(400, 'INVALID_DOCUMENT_IDS', 'Send 1 to 50 document UUIDs in documentIds');
      // Atomic per document. Other documents can succeed if a document is invalid.
      const results = [];
      for (const id of new Set(ids)) {
        const row = await repository.byId(userId, id);
        const preview = row ? preparePreview(row.preview) : null;
        if (row?.status === 'PREVIEW') await repository.prepareImport(userId, id, preview);
        const result = await repository.importDocument(userId, id);
        const warnings = [...new Map([...(preview?.validation.warnings || []), ...(result.warnings || [])]
          .map(warning => [JSON.stringify(warning), warning])).values()];
        results.push({ ...result, warnings, hasWarnings: warnings.length > 0 });
      }
      return { results, counts: { imported: results.filter(r => r.outcome === 'IMPORTED').length, alreadyImported: results.filter(r => r.outcome === 'ALREADY_IMPORTED').length, failed: results.filter(r => !['IMPORTED', 'ALREADY_IMPORTED'].includes(r.outcome)).length } };
    },
    async get(userId, id) {
      if (!UUID.test(id)) throw new AppError(400, 'INVALID_DOCUMENT_ID', 'Invalid document UUID');
      const row = await repository.byId(userId, id);
      if (!row) throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Document not found');
      return { ...preparePreview(row.preview), record: record(row) };
    },
    async list(userId, query, transactions = false) {
      const offset = Number(query.offset ?? 0);
      const limit = Number(query.limit ?? 20);
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new AppError(400, 'INVALID_PAGINATION', 'offset must be non-negative; limit must be 1 to 100');
      const rows = await repository.list(userId, transactions ? 'investment_transactions' : 'investment_documents', offset, limit);
      const items = rows.slice(0, limit).map(row => transactions ? row : { ...record(row), document: row.preview.document, file: row.preview.file });
      return { items, offset, limit, hasMore: rows.length > limit, nextOffset: rows.length > limit ? offset + limit : null };
    },
    async news(userId, symbol, query = {}) {
      if (typeof symbol !== 'string' || !/^[A-Z0-9][A-Z0-9.-]{0,31}$/i.test(symbol)
        || (query.exchange !== undefined && (typeof query.exchange !== 'string' || !/^[A-Z0-9]{4}$/.test(query.exchange)))
        || (query.limit !== undefined && (typeof query.limit !== 'string' || !/^\d+$/.test(query.limit)))) {
        throw new AppError(400, 'INVALID_STOCK_NEWS_QUERY', 'Invalid stock symbol, exchange or limit');
      }
      const limit = Number(query.limit ?? 20);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new AppError(400, 'INVALID_STOCK_NEWS_QUERY', 'limit must be 1 to 50');
      const holdings = await repository.holdings(userId, false);
      const matches = holdings.items.filter(item => item.quantity > 0 && instrument(item)
        && item.symbol.toUpperCase() === symbol.toUpperCase() && (!query.exchange || item.exchange === query.exchange));
      if (!matches.length) throw new AppError(404, 'STOCK_NOT_FOUND', 'A held offshore USD position is required');
      if (new Set(matches.map(item => instrument(item).key)).size > 1) {
        throw new AppError(400, 'AMBIGUOUS_STOCK_MARKET', 'Specify exchange for this symbol');
      }
      const result = await marketPrices.getNews(matches[0]);
      return { ...result, items: result.items.slice(0, limit), limit,
        hasMore: result.items.length > limit, maxItems: 50, cacheTtlSeconds: marketPrices.newsCacheTtlSeconds };
    },
    async holdings(userId, query = {}) {
      const includeClosed = query.includeClosed ?? 'false';
      if (!['true', 'false'].includes(includeClosed)) throw new AppError(400, 'INVALID_HOLDINGS_FILTER', 'includeClosed must be true or false');
      const includeFx = query.includeFx ?? 'false';
      if (!['true', 'false'].includes(includeFx)) throw new AppError(400, 'INVALID_HOLDINGS_FILTER', 'includeFx must be true or false');
      const includeMarket = query.includeMarket ?? 'false';
      if (!['true', 'false'].includes(includeMarket)) throw new AppError(400, 'INVALID_HOLDINGS_FILTER', 'includeMarket must be true or false');
      const includeLogos = query.includeLogos ?? 'false';
      if (!['true', 'false'].includes(includeLogos)) throw new AppError(400, 'INVALID_HOLDINGS_FILTER', 'includeLogos must be true or false');
      let holdings = await repository.holdings(userId, includeClosed === 'true');
      if (includeFx === 'true') {
        let fx;
        try { fx = await exchangeRates.getRate(); }
        catch (error) {
          if (error.code !== 'FX_RATE_UNAVAILABLE') throw error;
          // An FX outage must not hide the user's historical holdings or invent a rate.
          fx = { status: 'UNAVAILABLE', source: 'FRANKFURTER', baseCurrency: 'USD', quoteCurrency: 'THB',
            rate: null, rateDate: null, errorCode: error.code };
        }
        holdings = withHoldingsFx(holdings, fx);
      }
      if (includeMarket === 'true') {
        holdings = withHoldingsValuation(holdings,
          await marketPrices.getQuotes(holdings.items), marketPrices.cacheTtlSeconds);
        holdings = withDomesticValuation(holdings, await domesticPrices.getQuotes(holdings.items),
          domesticPrices.thaiCacheTtlSeconds, domesticPrices.navCacheTtlSeconds);
        holdings = withHoldingsLatestChange(holdings);
      }
      if (includeLogos === 'true') {
        const logos = await marketPrices.getLogos(holdings.items, { includeClosed: includeClosed === 'true' });
        const fundImages = await fundLogoReader.getLogos(holdings.items);
        holdings = { ...holdings, items: holdings.items.map(item => {
          const logoEligible = typeof item.quantity === 'number' && Number.isFinite(item.quantity)
            && (item.quantity > 0 || (includeClosed === 'true' && item.quantity === 0));
          const target = logoEligible ? instrument(item) : null;
          const fundTarget = item.assetType === 'MUTUAL_FUND' && typeof item.quantity === 'number'
            && Number.isFinite(item.quantity) && item.quantity > 0 ? domesticInstrument(item) : null;
          const logo = target ? logos.get(target.key) || null : fundTarget ? fundImages.get(fundTarget.key) || null
            : thaiStockLogo(item, { includeClosed: includeClosed === 'true' });
          const logoUrl = logo?.status === 'AVAILABLE' || (['SET', 'LOGO_DEV'].includes(logo?.source) && logo.status === 'UNVERIFIED')
            ? logo.url : null;
          return { ...item, logoUrl, logo };
        }) };
      }
      return holdings;
    },
  };
}
module.exports = { createInvestmentService, fileHash, identityKey, PARSER_VERSION };
