const crypto = require('node:crypto');
const { AppError } = require('../../shared/errors/app-error');
const { createInvestmentRepository } = require('./investment.repository');
const { preparePreview } = require('./preview-analysis');
const { frankfurterService } = require('./frankfurter.service');
const { withHoldingsFx } = require('./holdings-fx');
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
function createInvestmentService({ repository = createInvestmentRepository(), exchangeRates = frankfurterService } = {}) {
  return {
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
    async holdings(userId, query = {}) {
      const includeClosed = query.includeClosed ?? 'false';
      if (!['true', 'false'].includes(includeClosed)) throw new AppError(400, 'INVALID_HOLDINGS_FILTER', 'includeClosed must be true or false');
      const includeFx = query.includeFx ?? 'false';
      if (!['true', 'false'].includes(includeFx)) throw new AppError(400, 'INVALID_HOLDINGS_FILTER', 'includeFx must be true or false');
      const holdings = await repository.holdings(userId, includeClosed === 'true');
      if (includeFx !== 'true') return holdings;
      let fx;
      try { fx = await exchangeRates.getRate(); }
      catch (error) {
        if (error.code !== 'FX_RATE_UNAVAILABLE') throw error;
        // An FX outage must not hide the user's historical holdings or invent a rate.
        fx = { status: 'UNAVAILABLE', source: 'FRANKFURTER', baseCurrency: 'USD', quoteCurrency: 'THB',
          rate: null, rateDate: null, errorCode: error.code };
      }
      return withHoldingsFx(holdings, fx);
    },
  };
}
module.exports = { createInvestmentService, fileHash, identityKey, PARSER_VERSION };
