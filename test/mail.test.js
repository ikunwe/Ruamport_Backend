const test = require('node:test');
const assert = require('node:assert/strict');
const { encryptionKey, encrypt, decrypt } = require('../src/modules/mail/mail-crypto');
const { READ_SCOPE, createGmailClient } = require('../src/modules/mail/gmail-client');
const { createMailService } = require('../src/modules/mail/mail.service');
const { dateRange, senderAllowed, pdfParts, collectPreview } = require('../src/modules/mail/mail-preview.service');
const user = { id: 'user-1', email: 'test@gmail.com' };
const config = { gmailClientId: 'client', gmailClientSecret: 'secret', gmailRedirectUri: 'http://localhost:3000/api/v1/mail/gmail/callback', gmailFrontendReturnUrl: 'http://localhost:4200/mail/return', mailTokenEncryptionKey: Buffer.alloc(32, 7).toString('base64'), dimeMailSenderDomains: ['dime.co.th'] };
function fixture() {
  let connection = null;
  const states = new Map();
  let clock = new Date('2026-10-08T10:00:00Z');
  const repository = { connection: async () => connection, saveConnection: async row => { connection = row; }, saveState: async row => states.set(row.state_hash, row), consumeState: async key => { const row = states.get(key); states.delete(key); return row; }, disconnect: async () => { connection = null; states.clear(); } };
  const client = { exchangeCode: async () => ({ access_token: 'access', refresh_token: 'refresh', scope: READ_SCOPE }), profile: async () => ({ emailAddress: user.email }), refresh: async () => ({ access_token: 'access' }), revoke: async () => true };
  const collect = async options => ({ results: [{ status: 'READY', preview: { document: { deduplicationKey: 'dime:1' } } }], nextPageToken: options.pageToken ? null : 'page-2', scannedMessages: 1 });
  const service = createMailService({ config, repository, client, collect, now: () => clock });
  const authorize = async () => { const result = await service.connect(user); const state = new URL(result.authorizationUrl).searchParams.get('state'); await service.callback({ state, code: 'code' }); return state; };
  return { service, client, repository, authorize, setClock: value => { clock = new Date(value); } };
}
test('AES-GCM encrypts, detects tampering and rejects invalid keys', () => {
  const key = encryptionKey(config.mailTokenEncryptionKey);
  const token = encrypt('refresh-secret', key);
  assert.equal(decrypt(token, key), 'refresh-secret');
  assert.ok(!token.includes('refresh-secret'));
  assert.throws(() => decrypt(token, Buffer.alloc(32, 9)), { code: 'MAIL_TOKEN_UNREADABLE' });
  assert.throws(() => encryptionKey('abc'), { code: 'MAIL_CONFIG_MISSING' });
});
test('OAuth uses offline read-only consent and PKCE, persists encrypted token, rejects replay', async () => {
  const f = fixture();
  const result = await f.service.connect(user);
  const url = new URL(result.authorizationUrl);
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('scope'), READ_SCOPE);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  const state = url.searchParams.get('state');
  await f.service.callback({ state, code: 'code' });
  assert.notEqual((await f.repository.connection()).refresh_token_encrypted, 'refresh');
  const status = await f.service.status(user);
  assert.equal(status.connected, true);
  assert.ok(!JSON.stringify(status).includes('encrypted'));
  await assert.rejects(f.service.callback({ state, code: 'code' }), { code: 'MAIL_OAUTH_STATE_INVALID' });
});
test('expired, denied, missing permission and wrong-mailbox consent cannot connect', async () => {
  for (const scenario of ['expired', 'denied', 'scope', 'email']) {
    const f = fixture();
    const state = new URL((await f.service.connect(user)).authorizationUrl).searchParams.get('state');
    if (scenario === 'expired') f.setClock('2026-10-08T11:00:00Z');
    if (scenario === 'scope') f.client.exchangeCode = async () => ({ access_token: 'a', refresh_token: 'r', scope: 'openid' });
    if (scenario === 'email') f.client.profile = async () => ({ emailAddress: 'other@gmail.com' });
    const codes = { expired: 'MAIL_OAUTH_STATE_INVALID', denied: 'MAIL_CONSENT_DENIED', scope: 'MAIL_PERMISSION_REQUIRED', email: 'MAIL_EMAIL_MISMATCH' };
    await assert.rejects(f.service.callback({ state, code: 'code', error: scenario === 'denied' ? 'access_denied' : undefined }), { code: codes[scenario] });
    assert.equal(await f.repository.connection(), null);
  }
});
test('sync is preview-only, stable pagination/retry is encrypted and bound to user/month/expiry', async () => {
  const f = fixture();
  await assert.rejects(f.service.sync(user), { code: 'MAIL_NOT_CONNECTED' });
  await f.authorize();
  const first = await f.service.sync(user, { months: 2 });
  assert.equal(first.mode, 'PREVIEW_ONLY');
  const second = await f.service.sync(user, { months: 2, cursor: first.nextCursor });
  assert.deepEqual(second.range, first.range);
  assert.equal(second.hasMore, false);
  const retry = await f.service.sync(user, { months: 2, cursor: first.retryCursor, pdfPassword: '1234' });
  assert.equal(retry.hasMore, true);
  await assert.rejects(f.service.sync({ ...user, id: 'other' }, { months: 2, cursor: first.nextCursor }), { code: 'INVALID_MAIL_CURSOR' });
  await assert.rejects(f.service.sync(user, { months: 1, cursor: first.nextCursor }), { code: 'INVALID_MAIL_CURSOR' });
  f.setClock('2026-10-08T12:00:00Z');
  await assert.rejects(f.service.sync(user, { months: 2, cursor: first.nextCursor }), { code: 'INVALID_MAIL_CURSOR' });
});
test('invalid months/password, unsupported provider and reconnect errors are explicit', async () => {
  const f = fixture();
  await assert.rejects(f.service.connect({ ...user, email: 'a@outlook.com' }), { code: 'MAIL_PROVIDER_UNSUPPORTED' });
  await assert.rejects(f.service.sync(user, { months: 3 }), { code: 'INVALID_SYNC_MONTHS' });
  await assert.rejects(f.service.sync(user, { pdfPassword: 123 }), { code: 'INVALID_PDF_PASSWORD' });
  await f.authorize();
  f.client.refresh = async () => { const e = new Error(); e.code = 'MAIL_RECONNECT_REQUIRED'; throw e; };
  await assert.rejects(f.service.sync(user), { code: 'MAIL_RECONNECT_REQUIRED' });
  assert.deepEqual(await f.service.disconnect(user), { connected: false, googleRevoked: true });
  assert.equal((await f.service.status(user)).connected, false);
});
test('date range clamps month end, sender domains and nested attachment selection are safe', () => {
  assert.equal(dateRange(1, new Date('2026-03-31T10:00:00Z')).start, '2026-02-28T10:00:00.000Z');
  assert.equal(senderAllowed('Dime <notify@dime.co.th>', ['dime.co.th']), true);
  assert.equal(senderAllowed('Dime <notify@evil-dime.co.th>', ['dime.co.th']), false);
  assert.equal(senderAllowed('Dime <notify@dime.co.th.evil.com>', ['dime.co.th']), false);
  assert.equal(pdfParts({ parts: [{ parts: [{ filename: 'renamed.pdf', mimeType: 'application/pdf' }, { filename: 'image.png' }] }] }).length, 1);
});
test('batch reuses parser, handles password failures, duplicates and ignores unrelated senders', async () => {
  const range = dateRange(1, new Date('2026-10-08T10:00:00Z'));
  const message = (id, sender) => ({ internalDate: String(Date.parse('2026-10-01')), payload: { headers: [{ name: 'From', value: sender }], parts: [{ filename: `${id}.pdf`, body: { size: 5, attachmentId: id } }] } });
  const client = { listMessages: async () => ({ messages: ['1', '2', '3', '4'].map(id => ({ id })) }), message: async (_token, id) => message(id, id === '4' ? 'x@evil.com' : 'Dime <x@dime.co.th>'), attachment: async (_token, id) => ({ data: Buffer.from(id === '2' ? 'lock!' : '%PDF-').toString('base64url') }) };
  const result = await collectPreview({ client, token: 'a', range, domains: ['dime.co.th'], extract: async buffer => { if (buffer.toString() === 'lock!') { const { AppError } = require('../src/shared/errors/app-error'); throw new AppError(422, 'PDF_PASSWORD_REQUIRED', 'Password required'); } return { text: 'document', pageCount: 2 }; }, parse: () => ({ document: { deduplicationKey: 'dime:1' }, summary: {} }) });
  assert.deepEqual(result.results.map(item => item.status), ['READY', 'PASSWORD_REQUIRED', 'READY']);
  assert.equal(result.results[2].duplicateOf.messageId, '1');
  assert.equal(result.results[0].preview.file.pageCount, 2);
});
test('Google invalid grant never exposes token response', async () => {
  const client = createGmailClient(config, async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant', error_description: 'secret' }) }));
  await assert.rejects(client.refresh('secret'), { code: 'MAIL_RECONNECT_REQUIRED', message: 'Reconnect Gmail' });
});
test('oversized attachment is skipped without download; inline PDF is supported', async () => {
  let downloads = 0;
  const client = {
    listMessages: async () => ({ messages: [{ id: '1' }], nextPageToken: 'next' }),
    message: async () => ({ internalDate: String(Date.parse('2026-10-01')), payload: { headers: [{ name: 'from', value: 'x@dime.co.th' }], parts: [
      { filename: 'large.pdf', body: { size: 11 * 1024 * 1024, attachmentId: 'big' } },
      { filename: 'small.pdf', partId: '2', body: { size: 5, data: Buffer.from('%PDF-').toString('base64url') } },
    ] } }),
    attachment: async () => { downloads++; throw new Error('Should not download'); },
  };
  const result = await collectPreview({ client, token: 'a', range: dateRange(1, new Date('2026-10-08')), domains: ['dime.co.th'], extract: async () => ({ text: 'doc', pageCount: 1 }), parse: () => ({ document: { type: 'DIME_OFFSHORE_CONFIRMATION_NOTE' } }) });
  assert.equal(downloads, 0);
  assert.deepEqual(result.results.map(item => item.status), ['LIMIT_SKIPPED', 'READY']);
  assert.equal(result.nextPageToken, 'next');
});
test('preview handles mail/PDF failures without exposing unexpected error details', async () => {
  const client = {
    listMessages: async () => ({ messages: [{ id: '1' }, { id: '2' }] }),
    message: async (_token, id) => {
      if (id === '1') throw new Error('secret from provider');
      return { internalDate: String(Date.parse('2026-10-01')), payload: { headers: [{ name: 'From', value: 'x@dime.co.th' }], parts: [{ filename: 'bad.pdf', body: { size: 5, data: Buffer.from('bad!!').toString('base64url') } }] } };
    },
  };
  const result = await collectPreview({ client, token: 'a', range: dateRange(1, new Date('2026-10-08')), domains: ['dime.co.th'], extract: async () => { throw new Error('secret file content'); } });
  assert.deepEqual(result.results.map(item => item.status), ['MAIL_READ_FAILED', 'PARSE_FAILED']);
  assert.ok(!JSON.stringify(result).includes('secret'));
});
test('sync refuses simultaneous requests and always releases its per-user lock', async () => {
  const f = fixture();
  await f.authorize();
  let release;
  f.client.refresh = () => new Promise(resolve => { release = () => resolve({ access_token: 'a' }); });
  const pending = f.service.sync(user);
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(f.service.sync(user), { code: 'MAIL_SYNC_BUSY' });
  release();
  await pending;
  f.client.refresh = async () => ({ access_token: 'a' });
  assert.equal((await f.service.sync(user)).mode, 'PREVIEW_ONLY');
});
