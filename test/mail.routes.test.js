const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');
const { createMailRouter } = require('../src/modules/mail/mail.routes');
const { errorHandler } = require('../src/middlewares/error.middleware');
const { AppError } = require('../src/shared/errors/app-error');
async function serverFor(t, service, authenticate) {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/mail', createMailRouter(service, authenticate));
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  return `http://127.0.0.1:${server.address().port}/api/v1/mail`;
}
test('all mail endpoints except OAuth callback require bearer authentication', async t => {
  const base = await serverFor(t, {});
  for (const [method, path] of [['GET', '/connection'], ['POST', '/gmail/connect'], ['POST', '/gmail/sync-preview'], ['DELETE', '/gmail/connection']]) {
    const response = await fetch(base + path, { method });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, 'UNAUTHORIZED');
  }
});
test('callback redirects without bearer and exposes only controlled result code', async t => {
  const service = {
    callback: async query => { assert.equal(query.state, 'state'); throw new AppError(422, 'MAIL_EMAIL_MISMATCH', 'not this mailbox'); },
    returnUrl: code => `http://localhost:4200/mail/return?mailConnection=error&code=${code}`,
  };
  const base = await serverFor(t, service);
  const response = await fetch(base + '/gmail/callback?state=state&code=secret-code', { redirect: 'manual' });
  assert.equal(response.status, 303);
  assert.equal(new URL(response.headers.get('location')).searchParams.get('code'), 'MAIL_EMAIL_MISMATCH');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.ok(!response.headers.get('location').includes('secret-code'));
});
test('preview endpoint passes authenticated user, uses JSON and disables caching', async t => {
  const authenticatedUser = { id: 'signed-in-user', email: 'user@gmail.com' };
  const service = { sync: async (user, body) => { assert.deepEqual(user, authenticatedUser); assert.equal(body.months, 2); return { mode: 'PREVIEW_ONLY', results: [] }; } };
  const base = await serverFor(t, service, (request, _response, next) => { request.user = authenticatedUser; next(); });
  const response = await fetch(base + '/gmail/sync-preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ months: 2, userId: 'untrusted-id' }) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).mode, 'PREVIEW_ONLY');
});

test('connect forwards client only through owner-authenticated service; mobile callback redirects without tokens', async t => {
  const owner = { id: 'owner', email: 'user@gmail.com' };
  const service = {
    connect: async (user, body) => { assert.deepEqual(user, owner); assert.deepEqual(body, { client: 'mobile' }); return { authorizationUrl: 'https://accounts.google.com/test' }; },
    callback: async query => {
      if (query.error) { const e = new AppError(400, 'MAIL_CONSENT_DENIED', 'denied'); e.mailReturnClient = 'mobile'; throw e; }
      return { client: 'mobile' };
    },
    returnUrl: (code, client) => { assert.equal(client, 'mobile'); return `io.ruamport.mobile://mail/return?mailConnection=${code ? 'error&code=' + code : 'connected'}`; },
  };
  const base = await serverFor(t, service, (req, _res, next) => { req.user = owner; next(); });
  const connect = await fetch(base + '/gmail/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"client":"mobile"}' });
  assert.equal(connect.status, 200); assert.equal(connect.headers.get('cache-control'), 'no-store');
  for (const suffix of ['', '&error=access_denied']) {
    const result = await fetch(base + '/gmail/callback?state=opaque&code=private-code' + suffix, { redirect: 'manual' });
    assert.equal(result.status, 303); assert.equal(result.headers.get('referrer-policy'), 'no-referrer');
    assert.ok(result.headers.get('location').startsWith('io.ruamport.mobile://mail/return?'));
    assert.ok(!result.headers.get('location').includes('private-code'));
  }
});
