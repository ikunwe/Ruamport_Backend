const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');
const { createMailRouter } = require('../src/modules/mail/mail.routes');
const { createMailService } = require('../src/modules/mail/mail.service');
const { errorHandler } = require('../src/middlewares/error.middleware');
const { AppError } = require('../src/shared/errors/app-error');
const { READ_SCOPE } = require('../src/modules/mail/gmail-client');
const { decrypt, encryptionKey } = require('../src/modules/mail/mail-crypto');

const config = {
  gmailClientId: 'fixture-client', gmailClientSecret: 'fixture-secret',
  gmailRedirectUri: 'http://localhost:3000/api/v1/mail/gmail/callback',
  gmailFrontendReturnUrl: 'http://localhost:4200/mail/return',
  mailTokenEncryptionKey: Buffer.alloc(32, 7).toString('base64'), dimeMailSenderDomains: ['dime.co.th'],
};
const users = { a: { id: 'owner-a', email: 'a@gmail.com' }, b: { id: 'owner-b', email: 'b@gmail.com' } };

async function fixture(t) {
  const states = new Map(), connections = new Map();
  const calls = { exchange: 0, save: 0, consume: 0, revoke: 0 };
  const repository = {
    connection: async id => connections.get(id) || null,
    saveConnection: async row => { calls.save++; connections.set(row.user_id, row); },
    saveState: async row => {
      // Model the existing repository's sequential latest-pending-per-owner policy.
      for (const [key, value] of states) if (value.user_id === row.user_id) states.delete(key);
      states.set(row.state_hash, row);
    },
    consumeState: async key => { calls.consume++; const row = states.get(key); states.delete(key); return row; },
    disconnect: async id => {
      connections.delete(id);
      for (const [key, row] of states) if (row.user_id === id) states.delete(key);
    },
  };
  const client = {
    exchangeCode: async () => { calls.exchange++; return { access_token: 'private-access', refresh_token: 'private-refresh', scope: READ_SCOPE }; },
    profile: async () => ({ emailAddress: users.a.email }),
    revoke: async () => { calls.revoke++; return true; },
  };
  const service = createMailService({ config, repository, client });
  const app = express(); app.use(express.json());
  app.use('/api/v1/mail', createMailRouter(service, (req, _res, next) => {
    const user = users[req.get('authorization')?.replace('Bearer ', '')];
    if (!user) return next(new AppError(401, 'UNAUTHORIZED', 'Missing fixture token'));
    req.user = user; next();
  }));
  app.use(errorHandler);
  const http = app.listen(0, '127.0.0.1'); await once(http, 'listening');
  t.after(() => new Promise(resolve => http.close(resolve)));
  const base = `http://127.0.0.1:${http.address().port}/api/v1/mail`;
  const start = async (who = 'a', body = '{"client":"mobile"}') => {
    const response = await fetch(base + '/gmail/connect', { method: 'POST',
      headers: { Authorization: `Bearer ${who}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body }) });
    return { response, data: await response.json() };
  };
  const callback = (authorizationUrl, params = {}) => fetch(base + '/gmail/callback?' + new URLSearchParams({
    state: new URL(authorizationUrl).searchParams.get('state'), code: 'private-google-code', ...params,
  }), { redirect: 'manual' });
  return { base, states, connections, calls, repository, client, service, start, callback };
}

function result(response, mobile, code) {
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  const location = response.headers.get('location');
  const url = new URL(location);
  assert.equal(url.protocol + '//' + url.host + url.pathname,
    mobile ? 'io.ruamport.mobile://mail/return' : 'http://localhost:4200/mail/return');
  assert.equal(url.searchParams.get('mailConnection'), code ? 'error' : 'connected');
  assert.equal(url.searchParams.get('code'), code || null);
  assert.deepEqual([...url.searchParams.keys()].sort(), code ? ['code', 'mailConnection'] : ['mailConnection']);
  for (const forbidden of ['private-', 'state=', 'verifier', '@gmail.com', 'access_token', 'refresh_token']) {
    assert.ok(!location.includes(forbidden), forbidden);
  }
}

test('HTTP connect handles missing body/default web, explicit web/mobile and invalid JSON shapes without extra states', async t => {
  const f = await fixture(t);
  for (const body of ['null', '[]', '"mobile"', '42', '{"client":null}', '{"client":false}', '{"client":"other"}', '{"returnUrl":"https://evil.invalid"}', '{"client":']) {
    const { response, data } = await f.start('a', body);
    assert.equal(response.status, 400, body); assert.equal(data.error.code, 'INVALID_MAIL_CLIENT', body);
    assert.equal(f.states.size, 0);
    assert.ok(!JSON.stringify(data).includes('evil.invalid'));
  }
  for (const body of ['', '{}', '{"client":"web"}', '{"client":"mobile"}']) {
    const { response, data } = await f.start('a', body);
    assert.equal(response.status, 200, body);
    assert.deepEqual(Object.keys(data).sort(), ['authorizationUrl', 'expiresAt']);
    assert.ok(Date.parse(data.expiresAt) > Date.now());
    result(await f.callback(data.authorizationUrl), body.includes('mobile'));
  }
  const noBody = await fetch(f.base + '/gmail/connect', { method: 'POST', headers: { Authorization: 'Bearer a' } });
  assert.equal(noBody.status, 200);
  result(await f.callback((await noBody.json()).authorizationUrl), false);
});

test('mobile controlled errors retain destination through real service and HTTP route; raw errors never enter redirect', async t => {
  for (const scenario of ['deny', 'email', 'scope', 'provider', 'storage']) {
    await t.test(scenario, async t => {
      const f = await fixture(t);
      const { data } = await f.start();
      const expected = { deny: 'MAIL_CONSENT_DENIED', email: 'MAIL_EMAIL_MISMATCH', scope: 'MAIL_PERMISSION_REQUIRED',
        provider: 'MAIL_CONNECTION_FAILED', storage: 'MAIL_STORAGE_UNAVAILABLE' }[scenario];
      if (scenario === 'email') f.client.profile = async () => ({ emailAddress: users.b.email });
      if (scenario === 'scope') f.client.exchangeCode = async () => ({ access_token: 'private-access', refresh_token: 'private-refresh', scope: 'openid' });
      if (scenario === 'provider') f.client.exchangeCode = async () => { throw new Error('private-provider-details'); };
      if (scenario === 'storage') f.repository.saveConnection = async () => { throw new AppError(503, expected, 'private-storage-details'); };
      result(await f.callback(data.authorizationUrl, { ...(scenario === 'deny' ? { error: 'access_denied' } : {}),
        client: 'web', returnUrl: 'https://evil.invalid', userId: users.b.id }), true, expected);
      assert.equal(f.connections.size, 0);
      if (scenario === 'deny') assert.equal(f.calls.exchange, 0);
      if (scenario === 'email') assert.equal(f.calls.revoke, 1);
    });
  }
});

test('simultaneous callbacks consume one state: exactly one exchange/write, second falls back safely to web', async t => {
  const f = await fixture(t); const { data } = await f.start();
  let release; const secondConsume = new Promise(resolve => { release = resolve; });
  const originalConsume = f.repository.consumeState;
  f.repository.consumeState = async key => {
    const row = await originalConsume(key);
    if (f.calls.consume === 2) release();
    return row;
  };
  const originalExchange = f.client.exchangeCode;
  f.client.exchangeCode = async (...args) => {
    const timer = setTimeout(release, 2000);
    try { await secondConsume; return await originalExchange(...args); } finally { clearTimeout(timer); }
  };
  const responses = await Promise.all([f.callback(data.authorizationUrl), f.callback(data.authorizationUrl)]);
  const success = responses.find(r => new URL(r.headers.get('location')).searchParams.get('mailConnection') === 'connected');
  const failure = responses.find(r => r !== success);
  assert.ok(success); result(success, true); result(failure, false, 'MAIL_OAUTH_STATE_INVALID');
  assert.equal(f.calls.consume, 2); assert.equal(f.calls.exchange, 1); assert.equal(f.calls.save, 1);
});

test('status/disconnect use authenticated owner; callback query cannot write a different owner', async t => {
  const f = await fixture(t); const { data } = await f.start();
  result(await f.callback(data.authorizationUrl, { userId: users.b.id, email: users.b.email, client: 'web' }), true);
  assert.equal(f.connections.get(users.a.id).email, users.a.email); assert.equal(f.connections.has(users.b.id), false);
  const statusA = await fetch(f.base + '/connection?userId=owner-b', { headers: { Authorization: 'Bearer a' } });
  const a = await statusA.json(); assert.equal(a.connected, true); assert.equal(a.connection.email, users.a.email);
  assert.ok(!JSON.stringify(a).includes('encrypted'));
  const statusB = await fetch(f.base + '/connection?userId=owner-a', { headers: { Authorization: 'Bearer b' } });
  assert.deepEqual((await statusB.json()).connection, null);
  assert.equal((await f.service.status(users.b)).connected, false);
  assert.equal((await fetch(f.base + '/connection')).status, 401);
  await fetch(f.base + '/gmail/connection?userId=owner-a', { method: 'DELETE', headers: { Authorization: 'Bearer b' } });
  assert.equal(f.connections.has(users.a.id), true);
  assert.equal((await f.service.status({ ...users.a, email: users.b.email })).connected, false);
});

test('sequential web/mobile connects replace only that owner pending state and preserve the other owner', async t => {
  const f = await fixture(t);
  const aWeb = (await f.start('a', '{"client":"web"}')).data;
  const bWeb = (await f.start('b', '{"client":"web"}')).data;
  const aMobile = (await f.start('a', '{"client":"mobile"}')).data;
  assert.equal(f.states.size, 2);
  result(await f.callback(aWeb.authorizationUrl, { client: 'mobile' }), false, 'MAIL_OAUTH_STATE_INVALID');
  result(await f.callback(aMobile.authorizationUrl), true);
  f.client.profile = async () => ({ emailAddress: users.b.email });
  result(await f.callback(bWeb.authorizationUrl, { error: 'access_denied' }), false, 'MAIL_CONSENT_DENIED');
  const newB = (await f.start('b', '{"client":"web"}')).data;
  result(await f.callback(newB.authorizationUrl), false);
  assert.equal(f.connections.size, 2);
});

test('expired and unreadable mobile states fall back to web without exchanging a code', async t => {
  for (const scenario of ['expired', 'unreadable']) {
    const f = await fixture(t); const { data } = await f.start();
    const row = [...f.states.values()][0];
    if (scenario === 'expired') row.expires_at = '2000-01-01T00:00:00Z';
    else row.verifier_encrypted = 'not-an-encrypted-verifier';
    result(await f.callback(data.authorizationUrl, { client: 'mobile' }), false,
      scenario === 'expired' ? 'MAIL_OAUTH_STATE_INVALID' : 'MAIL_TOKEN_UNREADABLE');
    assert.equal(f.calls.exchange, 0); assert.equal(f.calls.save, 0);
  }
});

test('current state payload preserves PKCE verifier while defaulting legacy ciphertext to web', async t => {
  const f = await fixture(t); const { data } = await f.start();
  const row = [...f.states.values()][0]; const key = encryptionKey(config.mailTokenEncryptionKey);
  const { encrypt } = require('../src/modules/mail/mail-crypto');
  const payload = JSON.parse(decrypt(row.verifier_encrypted, key));
  row.verifier_encrypted = encrypt(payload.verifier, key);
  f.client.exchangeCode = async (_code, verifier) => {
    assert.equal(verifier, payload.verifier); return { access_token: 'private-access', refresh_token: 'private-refresh', scope: READ_SCOPE };
  };
  result(await f.callback(data.authorizationUrl, { client: 'mobile' }), false);
});
