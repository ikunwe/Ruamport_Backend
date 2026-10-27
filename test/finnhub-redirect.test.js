const test = require('node:test');
const assert = require('node:assert/strict');
const { createStockPriceService, instrument } = require('../src/modules/trades/stock-price.service');
const START = Date.parse('2026-10-20T15:00:00Z');
const held = (symbol = 'NVDA', exchange = 'XNAS') => ({ assetType: 'OFFSHORE_STOCK', currency: 'USD', quantity: 1, symbol, exchange });
const catalog = [{ symbol: 'NVDA', mic: 'XNAS', currency: 'USD' }];
const destination = 'https://static2.finnhub.io/file/privatedatany2/exchange/USf.json?Authorization=signed-secret';
const ok = row => ({ ok: true, status: 200, json: async () => row });
const redirect = (location = destination) => ({ ok: false, status: 302, headers: { get: name => name === 'location' ? location : null } });
const quote = async service => (await service.getQuotes([held()])).get(instrument(held()).key);

test('cold catalog uses a larger bounded budget; quotes retain their short timeout', async t => {
  const budgets = [];
  const original = AbortSignal.timeout;
  t.mock.method(AbortSignal, 'timeout', ms => { budgets.push(ms); return original(ms); });
  const service = createStockPriceService({ apiKey: 'private-key', now: () => START,
    fetchQuote: async input => {
      const path = new URL(input).pathname;
      if (path.endsWith('/stock/symbol')) return redirect();
      if (path.endsWith('/USf.json')) return ok(catalog);
      return ok({ c: 216, t: START / 1000 });
    } });
  assert.equal((await quote(service)).status, 'AVAILABLE');
  assert.deepEqual(budgets, [20000, 5000]);
  assert.throws(() => createStockPriceService({ catalogTimeoutMs: 30001 }));
  assert.throws(() => createStockPriceService({ catalogTimeoutMs: 0 }));
});

test('catalog timeout is identifiable, cached and shared by prices and logos without leaking secrets', async () => {
  let calls = 0;
  const service = createStockPriceService({ apiKey: 'private-key', now: () => START, catalogTimeoutMs: 5,
    fetchQuote: async (_input, init) => {
      calls++;
      await new Promise(resolve => setTimeout(resolve, 15));
      init.signal.throwIfAborted();
      return ok(catalog);
    } });
  const result = await quote(service);
  assert.equal(result.errorCode, 'PRICE_CATALOG_TIMEOUT');
  const logo = (await service.getLogos([held()])).get(instrument(held()).key);
  assert.equal(logo.errorCode, 'LOGO_CATALOG_TIMEOUT');
  assert.equal(logo.retryAt, result.retryAt);
  assert.equal(calls, 1);
  assert.equal(JSON.stringify([result, logo]).includes('private-key'), false);
});
test('catalog redirect follows exactly once, strips API key and preserves one total timeout', async () => {
  const calls = [];
  let initialSignal;
  const service = createStockPriceService({ apiKey: 'private-key', now: () => START, fetchQuote: async (input, init) => {
    const url = new URL(input);
    calls.push(url.origin + url.pathname);
    if (calls.length === 1) {
      assert.equal(init.redirect, 'manual');
      assert.equal(init.headers['X-Finnhub-Token'], 'private-key');
      initialSignal = init.signal;
      return redirect();
    }
    if (url.hostname === 'static2.finnhub.io') {
      assert.deepEqual(init.headers, { Accept: 'application/json' });
      assert.equal(init.signal, initialSignal);
      assert.equal(init.redirect, 'error');
      return ok(catalog);
    }
    assert.equal(init.headers['X-Finnhub-Token'], 'private-key');
    assert.equal(url.searchParams.get('symbol'), 'NVDA');
    return ok({ c: 216, t: START / 1000 });
  } });
  const result = await quote(service);
  assert.equal(result.status, 'AVAILABLE');
  assert.equal(result.price, 216);
  assert.equal(calls.length, 3);
  assert.equal(JSON.stringify(result).includes('signed-secret'), false);
  await quote(service);
  assert.equal(calls.length, 3);
});
test('redirect rejects untrusted host/path/protocol/credentials and missing or unexpected query keys', async () => {
  for (const location of [
    null, '', 'https://evil.example/file/privatedatany2/exchange/USf.json?Authorization=signed-secret',
    destination.replace('static2.finnhub.io', 'static2.finnhub.io.evil.example'),
    destination.replace('https:', 'http:'), destination.replace('https://', 'https://user:pass@'),
    destination.replace('static2.finnhub.io', 'static2.finnhub.io:8443'),
    destination.replace('/USf.json', '/OTHER.json'), destination.replace('/file/', '/other/'),
    destination + '#fragment', destination + '&token=private-key', destination + '&Authorization=second',
    destination.split('?')[0], destination.replace('=signed-secret', '='), 'x'.repeat(8193),
  ]) {
    let calls = 0;
    const service = createStockPriceService({ apiKey: 'private-key', now: () => START,
      fetchQuote: async () => { calls++; return redirect(location); } });
    const result = await quote(service);
    assert.equal(result.errorCode, 'PRICE_NOT_AVAILABLE');
    assert.equal(calls, 1);
    assert.equal(JSON.stringify(result).includes('signed-secret'), false);
    assert.equal(JSON.stringify(result).includes('private-key'), false);
  }
});
test('a second redirect is not followed or exposed', async () => {
  let calls = 0;
  const service = createStockPriceService({ apiKey: 'private-key', now: () => START, fetchQuote: async () => {
    calls++;
    return calls === 1 ? redirect() : redirect('https://evil.example');
  } });
  assert.equal((await quote(service)).status, 'UNAVAILABLE');
  assert.equal(calls, 2);
});
test('signed catalog hop shares quota; 429 pauses remaining work without exposing signed URL', async () => {
  for (const mode of ['budget', '429']) {
    let calls = 0;
    const service = createStockPriceService({ apiKey: 'private-key', now: () => START, perMinute: mode === 'budget' ? 1 : 60,
      fetchQuote: async () => {
        calls++;
        return calls === 1 ? redirect() : { ok: false, status: 429, headers: { get: () => null } };
      } });
    const result = await quote(service);
    assert.equal(result.errorCode, 'PRICE_RATE_LIMITED');
    assert.equal(calls, mode === 'budget' ? 1 : 2);
    const logo = (await service.getLogos([held()])).get(instrument(held()).key);
    assert.equal(logo.errorCode, 'LOGO_RATE_LIMITED');
    assert.equal(JSON.stringify([result, logo]).includes('signed-secret'), false);
  }
});
test('confirmed ADR issuer tickers provide logos but cannot replace USD listing or quote identity', async () => {
  for (const [symbol, exchange, issuer, filingCurrency] of [['ASML', 'XNAS', 'ASML.AS', 'EUR'], ['TSM', 'XNYS', '2330.TW', 'TWD']]) {
    const item = held(symbol, exchange);
    const calls = [];
    const service = createStockPriceService({ apiKey: 'private-key', now: () => START, fetchQuote: async input => {
      const url = new URL(input);
      calls.push(url.pathname);
      if (url.pathname.endsWith('/stock/symbol')) return ok([{ symbol, mic: exchange, currency: 'USD' }]);
      assert.equal(url.searchParams.get('symbol'), symbol);
      if (url.pathname.endsWith('/stock/profile2')) return ok({ ticker: issuer, currency: filingCurrency,
        logo: 'https://static2.finnhub.io/file/publicdatany/finnhubimage/stock_logo/' + issuer + '.png' });
      return ok({ c: 100, t: START / 1000 });
    } });
    const quotes = await service.getQuotes([item]);
    const logos = await service.getLogos([item]);
    const result = logos.get(instrument(item).key);
    assert.equal(result.status, 'AVAILABLE');
    assert.equal(result.symbol, symbol);
    assert.equal(result.micCode, exchange);
    assert.equal(result.providerSymbol, issuer);
    assert.equal(quotes.get(instrument(item).key).currency, 'USD');
    assert.equal(quotes.get(instrument(item).key).price, 100);
    assert.equal(calls.length, 3);
  }
});
test('ADR exception never accepts arbitrary issuer tickers or bypasses listing validation', async () => {
  for (const [mic, issuer] of [['XNAS', 'UNRELATED.AS'], ['XETR', 'ASML.AS']]) {
    let profileCalls = 0;
    const item = held('ASML');
    const service = createStockPriceService({ apiKey: 'private-key', now: () => START, fetchQuote: async input => {
      if (new URL(input).pathname.endsWith('/stock/symbol')) return ok([{ symbol: 'ASML', mic, currency: 'USD' }]);
      profileCalls++;
      return ok({ ticker: issuer, logo: 'https://static2.finnhub.io/file/logo.png' });
    } });
    assert.equal((await service.getLogos([item])).get(instrument(item).key).status, 'UNAVAILABLE');
    assert.equal(profileCalls, mic === 'XNAS' ? 1 : 0);
  }
});
