const { AppError } = require('../../shared/errors/app-error');
const { extractPdfText } = require('../ingestion/pdf/pdf-reader.service');
const { parseDimeDocument } = require('../ingestion/pdf/dime-document-parser.service');
const FILE_LIMIT = 10 * 1024 * 1024;
const BATCH_LIMIT = 25 * 1024 * 1024;
function dateRange(months, end = new Date()) {
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
function senderAllowed(sender, domains) {
  const address = /<([^<>]+)>/.exec(sender)?.[1] || sender.trim();
  const domain = address.slice(address.lastIndexOf('@') + 1).toLowerCase();
  return address.includes('@') && domains.some(allowed => domain === allowed || domain.endsWith(`.${allowed}`));
}
function mailQuery(range, domains) {
  return `{${domains.map(domain => `from:(${domain})`).join(' ')}} has:attachment filename:pdf after:${Math.floor(Date.parse(range.start) / 1000)} before:${Math.ceil(Date.parse(range.end) / 1000)}`;
}
async function collectPreview({ client, token, range, domains, pageToken, password, extract = extractPdfText, parse = parseDimeDocument }) {
  const listing = await client.listMessages(token, mailQuery(range, domains), pageToken);
  const results = [];
  const seen = new Map();
  let totalBytes = 0;
  for (const item of listing.messages || []) {
    let message;
    try { message = await client.message(token, item.id); }
    catch (error) {
      if ([401, 403, 429].includes(error.status)) throw error;
      results.push({ source: { messageId: item.id }, status: 'MAIL_READ_FAILED', error: { code: 'GMAIL_MESSAGE_FAILED', message: 'Could not read this email' } });
      continue;
    }
    const headers = message.payload?.headers || [];
    const header = name => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
    const time = Number(message.internalDate);
    if (!senderAllowed(header('From'), domains) || !Number.isFinite(time) || time < Date.parse(range.start) || time >= Date.parse(range.end)) continue;
    for (const part of pdfParts(message.payload)) {
      const source = { messageId: item.id, attachmentId: part.body?.attachmentId || null, partId: part.partId || null, sender: header('From'), subject: header('Subject'), receivedAt: new Date(time).toISOString(), filename: part.filename };
      if (results.length >= 20 || !(part.body?.size > 0) || part.body.size > FILE_LIMIT || totalBytes + part.body.size > BATCH_LIMIT) {
        results.push({ source, status: 'LIMIT_SKIPPED', error: { code: 'MAIL_PDF_LIMIT', message: 'Limit: 20 PDFs, 10 MB per file and 25 MB per batch' } });
        continue;
      }
      // Count advertised sizes even if download/parsing fails to bound the batch.
      totalBytes += part.body.size;
      try {
        const body = part.body.attachmentId ? await client.attachment(token, item.id, part.body.attachmentId) : part.body;
        const buffer = Buffer.from(body.data || '', 'base64url');
        if (buffer.length > FILE_LIMIT || buffer.length > part.body.size) throw new AppError(422, 'MAIL_PDF_LIMIT', 'Attachment exceeds its advertised size');
        const extraction = await extract(buffer, password);
        const preview = { file: { name: part.filename, size: buffer.length, mimeType: 'application/pdf', pageCount: extraction.pageCount }, ...parse(extraction.text) };
        const key = preview.document?.deduplicationKey;
        const duplicateOf = key && seen.get(key);
        results.push({ source, status: 'READY', preview, duplicateOf: duplicateOf || null });
        if (key && !duplicateOf) seen.set(key, source);
      } catch (error) {
        if ([401, 403, 429].includes(error.status)) throw error;
        const code = error instanceof AppError ? error.code : 'PDF_PARSE_FAILED';
        results.push({ source, status: code === 'PDF_PASSWORD_REQUIRED' ? 'PASSWORD_REQUIRED' : code === 'PDF_PASSWORD_INVALID' ? 'PASSWORD_INVALID' : 'PARSE_FAILED', error: { code, message: error instanceof AppError ? error.message : 'Could not parse this PDF' } });
      }
    }
  }
  return { results, nextPageToken: listing.nextPageToken || null, scannedMessages: (listing.messages || []).length };
}
module.exports = { dateRange, pdfParts, senderAllowed, mailQuery, collectPreview };
