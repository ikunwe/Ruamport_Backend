const test = require('node:test');
const assert = require('node:assert/strict');
const { createFrankfurterService } = require('../src/modules/trades/frankfurter.service');
const { errorHandler } = require('../src/middlewares/error.middleware');
const { fxUnavailable, publicFxError } = require('../src/shared/errors/fx-error');
const { AppError } = require('../src/shared/errors/app-error');
const TIME = Date.parse('2026-10-23T18:00:00Z'); // Thai date October 24.
const row = { base: 'USD', quote: 'THB', date: '2026-10-24', rate: 33.7 };

test('FX errors distinguish safe reasons and retain them throughout retry backoff', async () => {
  for (const [reason, fetchRate] of [
    ['HISTORICAL_RATE_UNAVAILABLE', async url => ({ ok: true,
      json: async () => new URL(url).pathname.endsWith('/rates') ? [] : ({ ...row, date: '2026-10-25' }) })],
    ['RATE_TOO_OLD', async () => ({ ok: true, json: async () => ({ ...row, date: '2026-10-17' }) })],
    ['INVALID_RESPONSE', async () => ({ ok: true, json: async () => ({ ...row, rate: -1 }) })],
    ['INVALID_RESPONSE', async () => ({ ok: true, json: async () => { throw new Error('private-body'); } })],
    ['NETWORK_ERROR', async () => { throw new Error('private-host'); }],
    ['UPSTREAM_HTTP_ERROR', async () => ({ ok: false, status: 502 })],
    ['UPSTREAM_RATE_LIMITED', async () => ({ ok: false, status: 429 })],
  ]) {
    let calls = 0;
    const service = createFrankfurterService({ now: () => TIME, fetchRate: async (...args) => { calls++; return fetchRate(...args); } });
    for (let i = 0; i < 2; i++) await assert.rejects(service.getRate(), error => {
      assert.equal(error.code, 'FX_RATE_UNAVAILABLE');
      assert.equal(error.reason, reason);
      assert.equal(error.retryAt, new Date(TIME + 60000).toISOString());
      assert.equal(error.message.includes('private-'), false);
      return true;
    });
    assert.equal(calls, reason === 'HISTORICAL_RATE_UNAVAILABLE' ? 2 : 1);
  }
});

test('FX timeout is differentiated without leaking the AbortSignal details', async () => {
  const service = createFrankfurterService({ timeoutMs: 5, fetchRate: async (_url, { signal }) => {
    await new Promise(resolve => setTimeout(resolve, 15));
    signal.throwIfAborted();
  } });
  await assert.rejects(service.getRate(), { code: 'FX_RATE_UNAVAILABLE', reason: 'TIMEOUT' });
});

test('middleware exposes only allowlisted FX messages; unrelated 5xx and untrusted reasons remain hidden', t => {
  t.mock.method(console, 'error', () => {});
  const error = Object.assign(fxUnavailable('FUTURE_RATE_DATE'), { message: 'private raw details', retryAt: '2026-10-23T18:01:00.000Z' });
  const response = { status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
  errorHandler(error, {}, response, () => {});
  assert.equal(response.code, 503);
  assert.equal(response.body.error.reason, 'FUTURE_RATE_DATE');
  assert.ok(response.body.error.message.includes('Thailand'));
  assert.equal(JSON.stringify(response.body).includes('private'), false);
  assert.equal(response.body.error.retryAt, error.retryAt);
  for (const bad of [new AppError(503, 'OTHER_ERROR', 'private'),
    Object.assign(new AppError(503, 'FX_RATE_UNAVAILABLE', 'private'), { reason: 'private' }),
    { status: 503, code: 'FX_RATE_UNAVAILABLE', reason: 'TIMEOUT', message: 'private' }]) {
    errorHandler(bad, {}, response, () => {});
    assert.equal(response.body.error.message, 'An unexpected error occurred');
    assert.equal(response.body.error.reason, undefined);
  }
  assert.equal(publicFxError(Object.assign(fxUnavailable(), { retryAt: 'secret' })).retryAt, undefined);
});
