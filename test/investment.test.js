const test = require('node:test');
const assert = require('node:assert/strict');
const { createInvestmentService, fileHash, identityKey } = require('../src/modules/trades/investment.service');
const { collectPreview, dateRange } = require('../src/modules/mail/mail-preview.service');
const { AppError } = require('../src/shared/errors/app-error');
const USER = 'user-a';
const OTHER = 'user-b';
function preview(type = 'DIME_OFFSHORE_CONFIRMATION_NOTE', invoice = 'DIMEOS123') {
  return { file: { name: 'example.pdf', size: 5, pageCount: 1 }, document: { type, taxInvoiceNumber: invoice, documentNumber: invoice, accountNumber: '123' },
    orders: [{ orderId: '001', symbol: 'ABC', units: 1, transactionType: 'BUY', currency: 'USD' }],
    summary: { totalBuy: 100 }, display: { totalFeeIncludeVatAfterDiscount: 0 }, calculation: { totalFeeIncludeVatAfterDiscount: 1 }, validation: { isValid: true, warnings: [] } };
}
function fixture() {
  const docs = new Map();
  const history = new Map();
  const transactions = [];
  let sequence = 0;
  const repository = {
    byHash: async (user, hash) => [...docs.values()].find(d => d.user_id === user && d.content_hash === hash) || null,
    byId: async (user, id) => { const row = docs.get(id); return row?.user_id === user ? row : null; },
    register: async (user, hash, identity, value) => {
      let row = [...docs.values()].find(d => d.user_id === user && (d.content_hash === hash || (identity && d.identity_key === identity)));
      if (row) return { document: row, alreadyRead: true };
      const id = `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
      row = { id, user_id: user, content_hash: hash, identity_key: identity, status: 'PREVIEW', preview: value, created_at: '2026-10-18T00:00:00Z', imported_at: null };
      docs.set(id, row);
      return { document: row, alreadyRead: false };
    },
    importDocument: async (user, id) => {
      const row = await repository.byId(user, id);
      if (!row) return { documentId: id, outcome: 'NOT_FOUND' };
      if (row.status === 'IMPORTED') return { documentId: id, outcome: 'ALREADY_IMPORTED', transactionCount: row.preview.orders.length };
      if (!row.identity_key) return { documentId: id, outcome: 'DOCUMENT_NUMBER_REQUIRED' };
      row.status = 'IMPORTED'; row.imported_at = '2026-10-18T01:00:00Z';
      transactions.push(...row.preview.orders.map(details => ({ user_id: user, document_id: id, details })));
      return { documentId: id, outcome: 'IMPORTED', transactionCount: row.preview.orders.length };
    },
    prepareImport: async (user, id, value) => {
      const row = await repository.byId(user, id);
      if (row?.status === 'PREVIEW') row.preview = value;
    },
    history: async (user, mailbox, messageId) => [...history.values()].filter(row => row.user_id === user && row.mailbox === mailbox && row.message_id === messageId),
    saveHistory: async row => history.set(JSON.stringify([row.user_id, row.mailbox, row.message_id, row.attachment_key]), row),
    list: async (user, table, offset, limit) => (table === 'investment_documents' ? [...docs.values()] : transactions).filter(row => row.user_id === user).slice(offset, offset + limit + 1),
  };
  return { service: createInvestmentService({ repository }), repository, docs, transactions };
}
test('hash and invoice identity dedup renamed/reencoded PDFs within a user, never across users/accounts', async () => {
  const f = fixture();
  const first = await f.service.stage(USER, Buffer.from('one'), preview());
  const sameHash = await f.service.cached(USER, Buffer.from('one'));
  assert.equal(sameHash.record.id, first.record.id);
  const sameInvoice = await f.service.stage(USER, Buffer.from('different bytes'), preview());
  assert.equal(sameInvoice.record.id, first.record.id);
  assert.equal(sameInvoice.record.alreadyRead, true);
  const other = await f.service.stage(OTHER, Buffer.from('one'), preview());
  assert.notEqual(other.record.id, first.record.id);
  assert.equal(await f.service.cached('stranger', Buffer.from('one')), null);
  assert.notEqual(identityKey(preview().document), identityKey({ ...preview().document, accountNumber: 'other' }));
  assert.equal(fileHash(Buffer.from('one')).length, 64);
});
test('confirm import is idempotent and preserves server PDF amounts/each transaction', async () => {
  const f = fixture();
  const document = preview();
  document.orders.push({ ...document.orders[0], orderId: '002', transactionType: 'REWARD' });
  const stored = await f.service.stage(USER, Buffer.from('one'), document);
  assert.equal(stored.record.canImport, true);
  const first = await f.service.importMany(USER, { documentIds: [stored.record.id, stored.record.id], orders: [{ fakeAmount: 999 }] });
  assert.equal(first.counts.imported, 1);
  assert.equal(first.results[0].transactionCount, 2);
  const retry = await f.service.importMany(USER, { documentIds: [stored.record.id] });
  assert.equal(retry.counts.alreadyImported, 1);
  assert.equal(f.transactions.length, 2);
  const saved = await f.service.get(USER, stored.record.id);
  assert.equal(saved.display.totalFeeIncludeVatAfterDiscount, 0);
  assert.equal(saved.calculation.totalFeeIncludeVatAfterDiscount, 1);
  assert.equal(saved.record.status, 'IMPORTED');
  assert.equal(saved.record.canImport, false);
  assert.equal((await f.service.importMany(OTHER, { documentIds: [stored.record.id] })).results[0].outcome, 'NOT_FOUND');
  await assert.rejects(f.service.get(OTHER, stored.record.id), { code: 'DOCUMENT_NOT_FOUND' });
  assert.deepEqual((await f.service.list(OTHER, {})).items, []);
});
test('missing document number still blocks import but validation warnings do not', async () => {
  const f = fixture();
  const missing = preview(); missing.document.taxInvoiceNumber = null; missing.document.documentNumber = null;
  const invalid = preview('DIME_THAI_STOCK_CONFIRMATION_NOTE', 'DIMETH123'); invalid.validation.isValid = false;
  const a = await f.service.stage(USER, Buffer.from('a'), missing);
  const b = await f.service.stage(USER, Buffer.from('b'), invalid);
  assert.equal(a.record.canImport, false);
  assert.equal(b.record.canImport, true);
  const result = await f.service.importMany(USER, { documentIds: [a.record.id, b.record.id] });
  assert.deepEqual(result.results.map(r => r.outcome), ['DOCUMENT_NUMBER_REQUIRED', 'IMPORTED']);
  assert.equal(f.transactions.length, 1);
  await assert.rejects(f.service.importMany(USER, { documentIds: [] }), { code: 'INVALID_DOCUMENT_IDS' });
  await assert.rejects(f.service.importMany(USER, { documentIds: ['not-a-uuid'] }), { code: 'INVALID_DOCUMENT_IDS' });
  await assert.rejects(f.service.stage(USER, Buffer.from('gold'), preview('GOLD')), { code: 'DIME_DOCUMENT_UNSUPPORTED' });
});

test('confirmed mismatch preserves PDF display and stores independent investment totals with warning values', async () => {
  const f = fixture();
  const value = preview();
  value.orders[0].totalAmount = { foreign: 4, thb: 123 };
  value.summary.totalBuy = 130;
  value.display.totalBuy = 130;
  value.validation = { isValid: false, warnings: [{ code: 'TOTAL_BUY_MISMATCH' }] };
  const stored = await f.service.stage(USER, Buffer.from('mismatch'), value);
  assert.equal(stored.record.canImport, true);
  assert.equal(stored.record.hasWarnings, true);
  assert.equal(stored.preview.display.totalBuy, 130);
  assert.equal(stored.preview.calculation.investmentTotals.totalBuy, 123);
  const outcome = await f.service.importMany(USER, { documentIds: [stored.record.id] });
  assert.equal(outcome.results[0].outcome, 'IMPORTED');
  const warning = outcome.results[0].warnings[0];
  assert.equal(warning.calculatedValue, 123);
  assert.equal(warning.pdfValue, 130);
  assert.equal(warning.difference, -7);
  assert.equal(warning.blocking, false);
  const row = f.docs.get(stored.record.id);
  assert.equal(row.preview.validation.isValid, false);
  assert.equal(row.preview.validation.blocksImport, false);
  assert.equal(row.preview.calculation.investmentTotals.totalBuy, 123);
  assert.equal(row.preview.summary.totalBuy, 130);
  assert.equal(f.transactions.length, 1);
});

test('old cached preview is enriched without reparsing and can import with warnings', async () => {
  const f = fixture();
  const saved = await f.service.stage(USER, Buffer.from('old'), preview());
  const row = f.docs.get(saved.record.id);
  delete row.preview.calculation.investmentTotals;
  row.preview.orders[0].totalAmount = { thb: 100 };
  row.preview.validation = { isValid: false, warnings: [{ code: 'TOTAL_BUY_MISMATCH' }] };
  const old = await f.service.get(USER, row.id);
  assert.equal(old.record.canImport, true);
  assert.equal(old.calculation.investmentTotals.totalBuy, 100);
  await f.service.importMany(USER, { documentIds: [row.id] });
  assert.equal(row.status, 'IMPORTED');
  assert.equal(row.preview.calculation.investmentTotals.totalBuy, 100);
});
function mailFixture(f, { ignored = false, locked = false } = {}) {
  let downloads = 0; let parses = 0; let reads = 0;
  const client = {
    listMessages: async () => ({ messages: [{ id: 'mail-1' }] }),
    message: async () => ({ internalDate: String(Date.parse('2026-10-01')), payload: { headers: [{ name: 'From', value: 'x@dime.co.th' }], parts: [{ filename: 'renamed.pdf', body: { size: 5, attachmentId: 'attachment-1' } }] } }),
    attachment: async () => { downloads++; return { data: Buffer.from('%PDF-').toString('base64url') }; },
  };
  const run = () => collectPreview({ client, token: 'a', range: dateRange('all', new Date('2026-10-18')), domains: ['dime.co.th'], persistence: f.service, userId: USER, mailbox: 'user@gmail.com',
    extract: async () => { reads++; if (locked) throw new AppError(422, 'PDF_PASSWORD_REQUIRED', 'password'); return { text: 'doc', pageCount: 1 }; },
    parse: () => { parses++; if (ignored) throw new AppError(422, 'DIME_DOCUMENT_UNSUPPORTED', 'unsupported'); return preview(); },
  });
  return { run, stats: () => ({ downloads, parses, reads }) };
}
test('Gmail records read/imported identity and skips PDF download and parsing on later sync', async () => {
  const f = fixture(); const mail = mailFixture(f);
  const first = await mail.run();
  assert.equal(first.results[0].status, 'READY');
  const id = first.results[0].record.id;
  const second = await mail.run();
  assert.equal(second.results[0].status, 'ALREADY_READ');
  assert.equal(second.results[0].preview, undefined);
  assert.deepEqual(mail.stats(), { downloads: 1, reads: 1, parses: 1 });
  await f.service.importMany(USER, { documentIds: [id] });
  const third = await mail.run();
  assert.equal(third.results[0].status, 'ALREADY_IMPORTED');
  assert.equal(third.results[0].preview, undefined);
  assert.deepEqual(mail.stats(), { downloads: 1, reads: 1, parses: 1 });
  assert.equal((await f.service.history(OTHER, 'user@gmail.com', 'mail-1')).length, 0);
  assert.equal((await f.service.history(USER, 'another@gmail.com', 'mail-1')).length, 0);
});
test('upload followed by Gmail uses byte hash before PDF parsing and remembers the source', async () => {
  const f = fixture();
  const stored = await f.service.stage(USER, Buffer.from('%PDF-'), preview());
  const mail = mailFixture(f);
  const result = await mail.run();
  assert.equal(result.results[0].record.id, stored.record.id);
  assert.equal(result.results[0].status, 'ALREADY_READ');
  assert.equal(result.results[0].preview, undefined);
  assert.deepEqual(mail.stats(), { downloads: 1, reads: 0, parses: 0 });
  await mail.run();
  assert.equal(mail.stats().downloads, 1);
});

test('same filename in a different email must not hide a genuinely new confirmation', async () => {
  const f = fixture();
  let id = 'one'; let downloads = 0;
  const client = {
    listMessages: async () => ({ messages: [{ id }] }),
    message: async () => ({ internalDate: String(Date.parse('2026-10-01')), payload: { headers: [{ name: 'From', value: 'x@dime.co.th' }], parts: [{ filename: 'confirmation.pdf', body: { size: 3, attachmentId: id } }] } }),
    attachment: async () => { downloads++; return { data: Buffer.from(id).toString('base64url') }; },
  };
  const run = () => collectPreview({ client, token: 'a', range: dateRange('all', new Date('2026-10-18')), domains: ['dime.co.th'], persistence: f.service, userId: USER, mailbox: 'user@gmail.com', extract: async buffer => ({ text: buffer.toString(), pageCount: 1 }), parse: text => preview('DIME_OFFSHORE_CONFIRMATION_NOTE', `DIMEOS-${text}`) });
  const first = await run();
  id = 'two';
  const second = await run();
  assert.equal(first.results[0].status, 'READY');
  assert.equal(second.results[0].status, 'READY');
  assert.notEqual(first.results[0].record.id, second.results[0].record.id);
  assert.equal(downloads, 2);
});
test('unsupported PDFs are remembered and hidden while password failures remain retryable', async () => {
  const f = fixture(); const ignored = mailFixture(f, { ignored: true });
  assert.deepEqual((await ignored.run()).results, []);
  assert.deepEqual((await ignored.run()).results, []);
  assert.deepEqual(ignored.stats(), { downloads: 1, reads: 1, parses: 1 });
  const locked = mailFixture(fixture(), { locked: true });
  assert.equal((await locked.run()).results[0].status, 'PASSWORD_REQUIRED');
  assert.equal((await locked.run()).results[0].status, 'PASSWORD_REQUIRED');
  assert.equal(locked.stats().downloads, 2);
});

test('monthly filenames are deferred before downloading/decrypting even with a wrong password', async () => {
  const f = fixture();
  let reads = 0; let downloads = 0;
  const client = {
    listMessages: async () => ({ messages: [{ id: 'monthly-mail' }] }),
    message: async () => ({ internalDate: String(Date.parse('2026-10-01')), payload: { headers: [{ name: 'From', value: 'x@dime.co.th' }], parts: [
      { filename: 'Dime_monthly_statement_DIME17499081552335s_62026.pdf', body: { size: 5, attachmentId: 'monthly' } },
      { filename: 'Dime_offshore_confirmationNote_DIMEOS123.pdf', body: { size: 5, attachmentId: 'confirmation' } },
    ] } }),
    attachment: async (_token, _message, id) => { assert.equal(id, 'confirmation'); downloads++; return { data: Buffer.from('%PDF-').toString('base64url') }; },
  };
  const run = () => collectPreview({ client, token: 'a', range: dateRange('all', new Date('2026-10-18')), domains: ['dime.co.th'], persistence: f.service, userId: USER, mailbox: 'user@gmail.com', password: 'wrong',
    extract: async () => { reads++; throw new AppError(422, 'PDF_PASSWORD_INVALID', 'Wrong password'); },
  });
  const first = await run();
  assert.equal(first.foundPdfCount, 2);
  assert.deepEqual(first.results.map(item => item.source.attachmentId), ['confirmation']);
  assert.equal(first.results[0].status, 'PASSWORD_INVALID');
  const history = await f.service.history(USER, 'user@gmail.com', 'monthly-mail');
  assert.equal(history.length, 1);
  assert.equal(history[0].attachment_key, 'attachment:monthly');
  assert.equal(history[0].status, 'IGNORED');
  await run();
  assert.equal(downloads, 2);
  assert.equal(reads, 2);
});
test('storage failures are not disguised as bad PDFs or silently skipped', async () => {
  const f = fixture();
  f.repository.register = async () => { throw new AppError(503, 'INVESTMENT_STORAGE_UNAVAILABLE', 'storage unavailable'); };
  await assert.rejects(mailFixture(f).run(), { code: 'INVESTMENT_STORAGE_UNAVAILABLE' });
  assert.equal((await f.service.history(USER, 'user@gmail.com', 'mail-1')).length, 0);
});

test('order dedup warnings and source document references from SQL are not overwritten by preview warnings', async () => {
  const f = fixture();
  const value = preview();
  value.validation = { isValid: false, warnings: [{ code: 'TOTAL_BUY_MISMATCH' }] };
  const stored = await f.service.stage(USER, Buffer.from('new-pdf'), value);
  f.repository.importDocument = async () => ({ documentId: stored.record.id, outcome: 'IMPORTED', transactionCount: 0, duplicateOrderCount: 1,
    duplicateOrders: [{ orderId: '001', existingDocumentId: 'previous-document', existingPdfNumber: 'previous-pdf-number' }],
    warnings: [...f.docs.get(stored.record.id).preview.validation.warnings, { code: 'DUPLICATE_ORDERS_SKIPPED', count: 1, blocking: false }],
  });
  const response = await f.service.importMany(USER, { documentIds: [stored.record.id] });
  assert.equal(response.results[0].warnings.length, 2);
  assert.ok(response.results[0].warnings.some(w => w.code === 'DUPLICATE_ORDERS_SKIPPED'));
  assert.equal(response.results[0].duplicateOrders[0].existingPdfNumber, 'previous-pdf-number');
  assert.equal(response.results[0].transactionCount, 0);
  assert.equal(response.results[0].hasWarnings, true);
});

test('order identity conflicts are reported as failed documents, not successful duplicate imports', async () => {
  const f = fixture();
  const stored = await f.service.stage(USER, Buffer.from('conflict'), preview());
  f.repository.importDocument = async () => ({ documentId: stored.record.id, outcome: 'ORDER_ID_CONFLICT', orderId: '001', warnings: [{ code: 'ORDER_ID_CONFLICT' }] });
  const response = await f.service.importMany(USER, { documentIds: [stored.record.id] });
  assert.equal(response.counts.failed, 1);
  assert.equal(response.counts.imported, 0);
  assert.equal(response.results[0].warnings[0].code, 'ORDER_ID_CONFLICT');
  assert.equal(f.docs.get(stored.record.id).status, 'PREVIEW');
});
