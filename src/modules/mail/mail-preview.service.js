const { AppError } = require('../../shared/errors/app-error');
const { extractPdfText } = require('../ingestion/pdf/pdf-reader.service');
const { parseDimeDocument } = require('../ingestion/pdf/dime-document-parser.service');
const FILE_LIMIT = 10 * 1024 * 1024;
const BATCH_LIMIT = 25 * 1024 * 1024;
function dateRange(months, end = new Date()) {
  if (months === 'all') return { start: null, end: end.toISOString() };
  const start = new Date(end);
  const day = start.getUTCDate();
  start.setUTCDate(1);
  start.setUTCMonth(start.getUTCMonth() - months);
  const lastDay = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
  start.setUTCDate(Math.min(day, lastDay));
  return { start: start.toISOString(), end: end.toISOString() };
}
function pdfParts(payload) {
  const parts = [];
  function visit(part) {
    if (!part) return;
    if (part.filename && (/\.pdf$/i.test(part.filename) || part.mimeType === 'application/pdf')) parts.push(part);
    for (const child of part.parts || []) visit(child);
  }
  visit(payload);
  return parts;
}
function isMonthlyFilename(filename) {
  // Dime's monthly filename is visible even while the PDF content is locked.
  // This is only a temporary exclusion hint, never a positive confirmation ID.
  return /(?:^|[^a-z])monthly[\s_.-]*statement(?:[^a-z]|$)|รายงานบัญชีหลักทรัพย์.*ประจำเดือน/i.test(String(filename || '').normalize('NFKC'));
}
function senderAllowed(sender, domains) {
  const address = /<([^<>]+)>/.exec(sender)?.[1] || sender.trim();
  const domain = address.slice(address.lastIndexOf('@') + 1).toLowerCase();
  return address.includes('@') && domains.some(allowed => domain === allowed || domain.endsWith(`.${allowed}`));
}
function mailQuery(range, domains) {
  const after = range.start === null ? '' : ` after:${Math.floor(Date.parse(range.start) / 1000)}`;
  return `{${domains.map(domain => `from:(${domain})`).join(' ')}} has:attachment filename:pdf${after} before:${Math.ceil(Date.parse(range.end) / 1000)}`;
}
async function collectPreview({ client, token, range, domains, pageToken, password, extract = extractPdfText, parse = parseDimeDocument, persistence, userId, mailbox }) {
  const listing = await client.listMessages(token, mailQuery(range, domains), pageToken);
  const results = [];
  const seen = new Map();
  let totalBytes = 0;
  let processedFiles = 0;
  let foundPdfCount = 0;
  let unreadableMessages = 0;
  function appendPreview(source, preview, record) {
    if (record?.status === 'IMPORTED') {
      results.push({ source, status: 'ALREADY_IMPORTED', record });
      return;
    }
    if (record?.alreadyRead) {
      results.push({ source, status: 'ALREADY_READ', record });
      return;
    }
    const key = preview.document?.deduplicationKey;
    const duplicateOf = key && seen.get(key);
    results.push({ source, status: 'READY', preview, ...(record ? { record } : {}), duplicateOf: duplicateOf || null });
    if (key && !duplicateOf) seen.set(key, source);
  }
  for (const item of listing.messages || []) {
    let message;
    try { message = await client.message(token, item.id); }
    catch (error) {
      if ([401, 403, 429].includes(error.status)) throw error;
      unreadableMessages++;
      results.push({ source: { messageId: item.id }, status: 'MAIL_READ_FAILED', error: { code: 'GMAIL_MESSAGE_FAILED', message: 'Could not read this email' } });
      continue;
    }
    const headers = message.payload?.headers || [];
    const header = name => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
    const time = Number(message.internalDate);
    if (!senderAllowed(header('From'), domains) || !Number.isFinite(time) || (range.start !== null && time < Date.parse(range.start)) || time >= Date.parse(range.end)) continue;
    const history = persistence ? await persistence.history(userId, mailbox, item.id) : [];
    const knownParts = new Map(history.map(entry => [entry.attachment_key, entry]));
    for (const [partIndex, part] of pdfParts(message.payload).entries()) {
      foundPdfCount++;
      const source = { messageId: item.id, attachmentId: part.body?.attachmentId || null, partId: part.partId || null, sender: header('From'), subject: header('Subject'), receivedAt: new Date(time).toISOString(), filename: part.filename };
      const attachmentKey = part.body?.attachmentId ? `attachment:${part.body.attachmentId}` : `part:${part.partId ?? partIndex}`;
      if (persistence && knownParts.has(attachmentKey)) {
        const cached = await persistence.known(userId, knownParts.get(attachmentKey));
        if (cached?.ignored) continue;
        if (cached) { appendPreview(source, cached.preview, cached.record); continue; }
      }
      if (isMonthlyFilename(part.filename)) {
        if (persistence) await persistence.remember(userId, mailbox, item.id, attachmentKey);
        continue;
      }
      if (processedFiles >= 20 || !(part.body?.size > 0) || part.body.size > FILE_LIMIT || totalBytes + part.body.size > BATCH_LIMIT) {
        results.push({ source, status: 'LIMIT_SKIPPED', error: { code: 'MAIL_PDF_LIMIT', message: 'Limit: 20 PDFs, 10 MB per file and 25 MB per batch' } });
        continue;
      }
      // Count advertised sizes even if download/parsing fails to bound the batch.
      totalBytes += part.body.size;
      processedFiles++;
      try {
        const body = part.body.attachmentId ? await client.attachment(token, item.id, part.body.attachmentId) : part.body;
        const buffer = Buffer.from(body.data || '', 'base64url');
        if (buffer.length > FILE_LIMIT || buffer.length > part.body.size) throw new AppError(422, 'MAIL_PDF_LIMIT', 'Attachment exceeds its advertised size');
        let stored = persistence ? await persistence.cached(userId, buffer) : null;
        if (!stored) {
          const extraction = await extract(buffer, password);
          const preview = { file: { name: part.filename, size: buffer.length, mimeType: 'application/pdf', pageCount: extraction.pageCount }, ...parse(extraction.text) };
          stored = persistence ? await persistence.stage(userId, buffer, preview) : { preview };
        }
        if (persistence) await persistence.remember(userId, mailbox, item.id, attachmentKey, stored.record.id);
        appendPreview(source, stored.preview, stored.record);
      } catch (error) {
        if ([401, 403, 429].includes(error.status) || error.code === 'INVESTMENT_STORAGE_UNAVAILABLE') throw error;
        const code = error instanceof AppError ? error.code : 'PDF_PARSE_FAILED';
        // Do not surface Monthly/Gold/other unsupported products as preview errors.
        // Known confirmation documents that fail their parser remain visible errors.
        if (code === 'DIME_MONTHLY_TEMPORARILY_DISABLED' || code === 'DIME_DOCUMENT_UNSUPPORTED') {
          if (persistence) await persistence.remember(userId, mailbox, item.id, attachmentKey);
          continue;
        }
        results.push({ source, status: code === 'PDF_PASSWORD_REQUIRED' ? 'PASSWORD_REQUIRED' : code === 'PDF_PASSWORD_INVALID' ? 'PASSWORD_INVALID' : 'PARSE_FAILED', error: { code, message: error instanceof AppError ? error.message : 'Could not parse this PDF' } });
      }
    }
  }
  return { results, nextPageToken: listing.nextPageToken || null, scannedMessages: (listing.messages || []).length, foundPdfCount, unreadableMessages };
}
module.exports = { dateRange, pdfParts, senderAllowed, mailQuery, collectPreview, isMonthlyFilename };
