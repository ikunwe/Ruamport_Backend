const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');

const { createApp } = require('../src/app');

let server;
let baseUrl;

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test('GET /api/v1/health reports that the API is ready', async () => {
  const response = await fetch(`${baseUrl}/api/v1/health`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.service, 'portfolio-api');
});

test('unknown routes return the common error shape', async () => {
  const response = await fetch(`${baseUrl}/api/v1/missing`);
  const body = await response.json();

  assert.equal(response.status, 404);
  assert.equal(body.error.code, 'NOT_FOUND');
});

test('mail connect JSON null is a controlled validation error in the real app parser', async () => {
  for (const path of ['/api/v1/mail/gmail/connect', '/api/v1/mail/gmail/connect/', '/api/v1/MAIL/GMAIL/CONNECT']) {
    const response = await fetch(baseUrl + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'null' });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'INVALID_MAIL_CLIENT');
  }
  const other = await fetch(baseUrl + '/api/v1/auth/login-username', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'null' });
  assert.equal(other.status, 400);
  assert.notEqual((await other.json()).error.code, 'INVALID_MAIL_CLIENT');
});

test('CORS preflight allows the configured Angular origin and auth header', async () => {
  const response = await fetch(`${baseUrl}/api/v1/auth/me`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://localhost:4200',
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'authorization',
    },
  });

  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:4200');
  assert.match(response.headers.get('access-control-allow-headers'), /Authorization/i);
});

test('CORS does not allow an unconfigured browser origin', async () => {
  const response = await fetch(`${baseUrl}/api/v1/health`, {
    headers: { Origin: 'https://untrusted.example' },
  });

  assert.equal(response.headers.get('access-control-allow-origin'), null);
});
