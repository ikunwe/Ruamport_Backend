const crypto = require('node:crypto');
const { env } = require('../../config/env');
const { AppError } = require('../../shared/errors/app-error');
const { detectIngestionRoute } = require('../ingestion/email-routing.service');
const { encryptionKey, encrypt, decrypt, hash } = require('./mail-crypto');
const { createGmailClient, READ_SCOPE } = require('./gmail-client');
const { createMailRepository } = require('./mail.repository');
const { dateRange, collectPreview } = require('./mail-preview.service');
function createMailService({ config = env, repository = createMailRepository(), client = createGmailClient(config), now = () => new Date(), collect = collectPreview } = {}) {
  const syncing = new Set();
  function configured() {
    const names = ['gmailClientId', 'gmailClientSecret', 'gmailRedirectUri', 'gmailFrontendReturnUrl'];
    if (names.some(name => !config[name])) throw new AppError(503, 'MAIL_CONFIG_MISSING', 'Configure Gmail OAuth environment variables');
    for (const name of ['gmailRedirectUri', 'gmailFrontendReturnUrl']) {
      let url;
      try { url = new URL(config[name]); } catch { throw new AppError(503, 'MAIL_CONFIG_MISSING', 'Invalid Gmail callback or frontend URL'); }
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new AppError(503, 'MAIL_CONFIG_MISSING', 'OAuth URLs must use HTTPS except localhost');
    }
    if (!config.dimeMailSenderDomains?.length || config.dimeMailSenderDomains.some(domain => !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(domain))) throw new AppError(503, 'MAIL_CONFIG_MISSING', 'Configure valid Dime sender domains');
    return encryptionKey(config.mailTokenEncryptionKey);
  }
  function requireGmail(user) {
    if (detectIngestionRoute(user.email).channel !== 'GMAIL_API') throw new AppError(422, 'MAIL_PROVIDER_UNSUPPORTED', 'This test supports Gmail accounts only; use PDF upload for other accounts');
  }
  function cursor(data, key) { return encrypt(JSON.stringify(data), key); }
  function readCursor(value, user, months, key) {
    try {
      if (typeof value !== 'string' || value.length > 8192) throw new Error();
      const data = JSON.parse(decrypt(value, key));
      if (data.userId !== user.id || data.months !== months || data.expiresAt <= now().getTime() || !Number.isFinite(Date.parse(data.range?.start)) || !Number.isFinite(Date.parse(data.range?.end))) throw new Error();
      return data;
    } catch { throw new AppError(400, 'INVALID_MAIL_CURSOR', 'Preview cursor is invalid or expired; start a new sync'); }
  }
  return {
    async status(user) {
      const route = detectIngestionRoute(user.email);
      const stored = await repository.connection(user.id);
      const connected = Boolean(stored && stored.email.toLowerCase() === user.email.toLowerCase());
      return { ...route, supported: route.channel === 'GMAIL_API', connected, connection: connected ? { provider: stored.provider, email: stored.email, connectedAt: stored.connected_at } : null };
    },
    async connect(user) {
      requireGmail(user);
      const key = configured();
      const state = crypto.randomBytes(32).toString('base64url');
      const verifier = crypto.randomBytes(48).toString('base64url');
      const expiresAt = new Date(now().getTime() + 10 * 60 * 1000).toISOString();
      await repository.saveState({ state_hash: hash(state), user_id: user.id, expected_email: user.email.toLowerCase(), verifier_encrypted: encrypt(verifier, key), expires_at: expiresAt });
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      const params = { client_id: config.gmailClientId, redirect_uri: config.gmailRedirectUri, response_type: 'code', scope: READ_SCOPE, state, access_type: 'offline', prompt: 'consent', login_hint: user.email, code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' };
      for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
      return { authorizationUrl: url.toString(), expiresAt };
    },
    async callback(query) {
      const key = configured();
      if (typeof query.state !== 'string' || query.state.length > 256) throw new AppError(400, 'MAIL_OAUTH_STATE_INVALID', 'Missing OAuth state');
      const state = await repository.consumeState(hash(query.state));
      if (!state || Date.parse(state.expires_at) <= now().getTime()) throw new AppError(400, 'MAIL_OAUTH_STATE_INVALID', 'OAuth state expired or already used');
      if (query.error) throw new AppError(400, 'MAIL_CONSENT_DENIED', 'Gmail connection was not authorized');
      if (typeof query.code !== 'string' || query.code.length > 4096) throw new AppError(400, 'MAIL_OAUTH_CODE_INVALID', 'Missing authorization code');
      const tokens = await client.exchangeCode(query.code, decrypt(state.verifier_encrypted, key));
      if (!tokens.access_token || !tokens.refresh_token || !(tokens.scope || '').split(' ').includes(READ_SCOPE)) throw new AppError(422, 'MAIL_PERMISSION_REQUIRED', 'Grant Gmail read access and reconnect');
      const profile = await client.profile(tokens.access_token);
      if (profile.emailAddress?.toLowerCase() !== state.expected_email) {
        await client.revoke(tokens.refresh_token);
        throw new AppError(422, 'MAIL_EMAIL_MISMATCH', 'Connect the same Gmail address as the signed-in account');
      }
      await repository.saveConnection({ user_id: state.user_id, provider: 'GOOGLE', email: profile.emailAddress.toLowerCase(), refresh_token_encrypted: encrypt(tokens.refresh_token, key), scopes: tokens.scope, connected_at: now().toISOString() });
    },
    returnUrl(errorCode) {
      configured();
      const url = new URL(config.gmailFrontendReturnUrl);
      url.searchParams.set('mailConnection', errorCode ? 'error' : 'connected');
      if (errorCode) url.searchParams.set('code', errorCode);
      return url.toString();
    },
    async sync(user, body = {}) {
      requireGmail(user);
      const key = configured();
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError(400, 'INVALID_SYNC_REQUEST', 'Send a JSON object');
      const months = body.months ?? 1;
      if (![1, 2].includes(months)) throw new AppError(400, 'INVALID_SYNC_MONTHS', 'months must be 1 or 2');
      if (body.pdfPassword !== undefined && (typeof body.pdfPassword !== 'string' || body.pdfPassword.length > 128)) throw new AppError(400, 'INVALID_PDF_PASSWORD', 'PDF password must be a string of at most 128 characters');
      const data = body.cursor !== undefined ? readCursor(body.cursor, user, months, key) : { userId: user.id, months, range: dateRange(months, now()), pageToken: null, expiresAt: now().getTime() + 60 * 60 * 1000 };
      if (syncing.has(user.id)) throw new AppError(409, 'MAIL_SYNC_BUSY', 'A preview sync is already running');
      syncing.add(user.id);
      try {
        const connection = await repository.connection(user.id);
        if (!connection || connection.email.toLowerCase() !== user.email.toLowerCase()) throw new AppError(409, 'MAIL_NOT_CONNECTED', 'Connect Gmail first');
        const tokens = await client.refresh(decrypt(connection.refresh_token_encrypted, key));
        if (!tokens.access_token) throw new AppError(401, 'MAIL_RECONNECT_REQUIRED', 'Reconnect Gmail');
        const batch = await collect({ client, token: tokens.access_token, range: data.range, domains: config.dimeMailSenderDomains, pageToken: data.pageToken, password: body.pdfPassword });
        return { mode: 'PREVIEW_ONLY', months, range: data.range, scannedMessages: batch.scannedMessages, results: batch.results, hasMore: Boolean(batch.nextPageToken), nextCursor: batch.nextPageToken ? cursor({ ...data, pageToken: batch.nextPageToken }, key) : null, retryCursor: cursor(data, key), counts: { ready: batch.results.filter(item => item.status === 'READY').length, failed: batch.results.filter(item => item.status !== 'READY').length } };
      } finally { syncing.delete(user.id); }
    },
    async disconnect(user) {
      const key = configured();
      const connection = await repository.connection(user.id);
      // Remove local credentials even if Google is unavailable or the key was rotated.
      await repository.disconnect(user.id);
      let googleRevoked = !connection;
      if (connection) {
        try { googleRevoked = await client.revoke(decrypt(connection.refresh_token_encrypted, key)); } catch { googleRevoked = false; }
      }
      return { connected: false, googleRevoked };
    },
  };
}
module.exports = { createMailService };
