const test = require('node:test');
const assert = require('node:assert/strict');
const { createFundLogoService } = require('../src/modules/trades/fund-logo.service');
const { domesticInstrument, createDomesticMarketService } = require('../src/modules/trades/domestic-market.service');
const { parseAimc, parseCompany, parseCurrentIds, phoneNameMatches } = require('../src/modules/trades/amc-directory');
const START = Date.parse('2026-10-22T08:00:00Z');
const HOUR = 3600000;
const NAME = 'KIATNAKIN PHATRA ASSET MANAGEMENT COMPANY LIMITED';
const ID = 'C0000005025';
const item = extra => ({ assetType: 'MUTUAL_FUND', symbol: 'KKP US500-UH-E', currency: 'THB', quantity: 10, ...extra });
const member = (name = NAME, domain = 'am.kkpfg.com', phone = '02-305-9800') =>
  '<h2>' + name + '</h2><ul><li>โทรศัพท์ : <a href="tel:' + phone + '">' + phone + '</a></li>'
  + '<li><div>Website :</div><a href="https://' + domain + '">https://' + domain + '/</a></li></ul>';
const current = ids => ids.map(id => '<a href="/LicenseCheck/CompanyDetail/' + id.slice(1) + '">Company</a>').join('');
const company = (name, phone) => '<script>var company = ' + JSON.stringify({
  CompanyName_EN: name, Telephone: phone, License_UnderSecuritiesAndExchange: [{}],
}) + ';</script>';
function fixture(options = {}) {
  let time = START;
  let calls = [];
  let identities = 0;
  let fail = false;
  const service = createFundLogoService({
    publishableKey: 'pk_public-test-key', now: () => time,
    getFundIdentity: async value => {
      identities++;
      return { amcId: ID, amcNameEn: NAME, projectId: 'M0301_2567', fundClassName: value.symbol, ...options.identity };
    },
    ...options,
    fetchData: async (input, init) => {
      const url = new URL(input);
      calls.push(url.toString());
      assert.equal(init.redirect, 'error');
      assert.ok(init.signal);
      assert.equal(init.headers.Authorization, undefined);
      assert.equal(init.headers.Cookie, undefined);
      assert.equal(init.headers['Ocp-Apim-Subscription-Key'], undefined);
      assert.equal(url.searchParams.has('token'), false);
      assert.equal(url.hostname === 'img.logo.dev', false);
      if (options.fetchData) return options.fetchData(url, init);
      if (fail) return { ok: false, status: 503 };
      let html;
      if (url.pathname.endsWith('/Intermediaries')) html = options.currentHtml ?? current([ID]);
      else if (url.pathname === '/members/') html = options.aimcHtml ?? member();
      else html = options.companyHtml ?? company(NAME, '02-305-9800');
      return { ok: true, status: 200, headers: { get: name => name === 'content-type' ? 'text/html; charset=utf-8' : null },
        text: async () => html };
    },
  });
  return { service, calls, get identities() { return identities; }, time: value => { time = value; },
    fail: () => { fail = true; }, get: async (value = item()) => (await service.getLogos([value])).get(domesticInstrument(value).key) };
}
test('fund logo resolves SEC AMC -> AIMC -> fixed Logo.dev URL, without fetching image bytes', async () => {
  const f = fixture();
  const result = await f.get();
  assert.equal(result.status, 'UNVERIFIED');
  assert.equal(result.domain, 'am.kkpfg.com');
  assert.equal(result.amcId, ID);
  assert.equal(result.logoRepresents, 'AMC');
  assert.equal(result.fallbackText, 'KKP US500-UH-E');
  assert.equal(result.domainVerified, true);
  assert.equal(result.verified, false);
  assert.equal(result.matchMethod, 'EXACT_NAME');
  const url = new URL(result.url);
  assert.equal(url.origin, 'https://img.logo.dev');
  assert.equal(url.pathname, '/am.kkpfg.com');
  assert.equal(url.searchParams.get('fallback'), '404');
  assert.equal(url.searchParams.get('token'), 'pk_public-test-key');
  assert.equal(f.calls.length, 2);
  assert.equal(result.expiresAt, new Date(START + HOUR).toISOString());
});
test('concurrent holdings and different fund classes share public directory/domain caches', async () => {
  const f = fixture();
  const [a, b, c] = await Promise.all([f.get(), f.get(), f.get(item({ symbol: 'KKP US500-UH-ES' }))]);
  assert.equal(f.calls.length, 2);
  assert.equal(f.identities, 2);
  a.domain = 'wrong';
  assert.equal(b.domain, 'am.kkpfg.com');
  assert.equal(c.domain, 'am.kkpfg.com');
  assert.equal((await f.get()).fromCache, true);
});
test('missing/secret CDN key fails safely without SEC or public network calls', async () => {
  for (const publishableKey of ['', 'sk_never-expose-this', 'pk_bad space', 'https://evil.test']) {
    const f = fixture({ publishableKey });
    const logo = await f.get();
    assert.equal(logo.errorCode, 'LOGO_DEV_KEY_MISSING');
    assert.equal(logo.url, null);
    assert.equal(f.identities, 0);
    assert.equal(f.calls.length, 0);
    assert.equal(JSON.stringify(logo).includes(publishableKey || 'not-present'), false);
  }
});
test('only supported positive held mutual funds are eligible', async () => {
  const f = fixture();
  const result = await f.service.getLogos([item(), item(), item({ quantity: 0 }), item({ quantity: -1 }),
    item({ quantity: Infinity }), item({ quantity: '1' }), item({ assetType: 'THAI_STOCK' }),
    item({ assetType: 'OFFSHORE_STOCK' }), item({ currency: 'USD' }), item({ symbol: '../evil' })]);
  assert.equal(result.size, 1);
  assert.equal(f.identities, 1);
});
test('First Plus trailing slash and display URL do not create false ambiguity; footer URLs ignored', async () => {
  const html = member('First Plus Asset Management (Thailand) Company Limited', 'th.firstplus.com')
    + '<footer><a href="https://unrelated.test">web developer</a></footer>';
  const result = await fixture({ identity: { amcNameEn: 'FIRST PLUS ASSET MANAGEMENT (THAILAND) COMPANY LIMITED' }, aimcHtml: html }).get();
  assert.equal(result.domain, 'th.firstplus.com');
  assert.equal(result.matchMethod, 'EXACT_NAME');
});
test('Aberdeen name difference requires a unique official phone AND similar full name', async () => {
  const name = 'ABERDEEN ASSET MANAGEMENT (THAILAND) LIMITED';
  const directory = member('Aberdeen Standard Asset Management (Thailand) Limited', 'aberdeenstandard.com', '0 2352 3333');
  const f = fixture({ identity: { amcNameEn: name }, aimcHtml: directory, companyHtml: company(name, '0-2352-3333') });
  const result = await f.get();
  assert.equal(result.matchMethod, 'OFFICIAL_PHONE_AND_NAME');
  assert.equal(result.domain, 'aberdeenstandard.com');
  assert.equal(f.calls.length, 3);
  const wrongPhone = await fixture({ identity: { amcNameEn: name }, aimcHtml: directory, companyHtml: company(name, '0999999999') }).get();
  assert.equal(wrongPhone.url, null);
});
test('never choose parent bank, unrelated brand, or ambiguous directory match', async () => {
  for (const html of [member('KIATNAKIN PHATRA BANK PUBLIC COMPANY LIMITED', 'bank.kkpfg.com'),
    member() + member(NAME, 'other-company.com'),
    '<h2>' + NAME + '</h2><li>Website : <a href="https://one.com">one</a><a href="https://two.com">two</a></li>']) {
    const result = await fixture({ aimcHtml: html }).get();
    assert.equal(result.status, 'UNAVAILABLE');
    assert.equal(result.url, null);
  }
});
test('historical/not-current AMC is not silently replaced with successor', async () => {
  const f = fixture({ currentHtml: current(['C0000000001']) });
  const result = await f.get();
  assert.equal(result.errorCode, 'LOGO_AMC_NOT_CURRENTLY_LISTED');
  assert.equal(result.fallbackText, item().symbol);
  assert.equal(f.calls.length, 1);
});
test('missing/malformed/conflicting SEC AMC identity cannot produce a logo', async () => {
  for (const identity of [{ amcId: null }, { amcId: '../../evil' }, { amcNameEn: '' },
    { amcNameEn: 'X'.repeat(301) }, { amcAmbiguous: true }]) {
    const f = fixture({ identity });
    assert.equal((await f.get()).errorCode, 'LOGO_AMC_IDENTITY_UNAVAILABLE');
    assert.equal(f.calls.length, 0);
  }
});
test('directory timeout/403/invalid response cannot hide holdings or leak upstream messages', async () => {
  for (const fetchData of [
    async () => { throw new Error('private-secret-key'); },
    async () => ({ ok: false, status: 403 }),
    async () => ({ ok: true, status: 200, headers: { get: () => 'application/json' } }),
    async () => ({ ok: true, status: 200, headers: { get: name => name === 'content-length' ? '3000000' : 'text/html' } }),
    async () => ({ ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => '<h1>Challenge</h1>' }),
  ]) {
    const f = fixture({ fetchData });
    const logo = await f.get();
    assert.equal(logo.status, 'UNAVAILABLE');
    assert.equal(logo.errorCode, 'LOGO_DIRECTORY_UNAVAILABLE');
    assert.equal(JSON.stringify(logo).includes('private-secret-key'), false);
    await f.get();
    assert.equal(f.calls.length, 1);
  }
});
test('rate-limited directory pauses across funds and respects Retry-After', async () => {
  const f = fixture({ fetchData: async () => ({ ok: false, status: 429, headers: { get: () => '600' } }) });
  const a = await f.get();
  const b = await f.get(item({ symbol: 'OTHER' }));
  assert.equal(a.errorCode, 'LOGO_DIRECTORY_RATE_LIMITED');
  assert.equal(b.errorCode, 'LOGO_DIRECTORY_RATE_LIMITED');
  assert.equal(a.retryAt, new Date(START + 600000).toISOString());
  assert.equal(f.calls.length, 1);
});
test('expired domain/metadata is not silently reused if refreshing the official directory fails', async () => {
  const f = fixture({ ttlMs: 1000, directoryTtlMs: 1000 });
  assert.equal((await f.get()).status, 'UNVERIFIED');
  f.fail();
  f.time(START + 1001);
  const result = await f.get();
  assert.equal(result.status, 'UNAVAILABLE');
  assert.equal(result.url, null);
});
test('AIMC parser handles entities/single quotes and rejects private, credentialed and javascript domains', () => {
  assert.equal(parseAimc(member('A &amp; B Asset Management Company Limited'))[0].name, 'A & B Asset Management Company Limited');
  assert.equal(parseAimc(member().replaceAll('"', "'"))[0].domains[0], 'am.kkpfg.com');
  for (const href of ['javascript:alert(1)', 'https://127.0.0.1', 'https://user:pass@example.com',
    'https://localhost', 'https://internal.local', 'https://example.com:8080']) {
    const record = parseAimc('<h2>' + NAME + '</h2><li>Website : <a href="' + href + '">link</a></li>')[0];
    assert.deepEqual(record.domains, []);
  }
  assert.deepEqual(parseCurrentIds('<a href="https://evil.test/LicenseCheck/CompanyDetail/0000005025">evil</a>'), []);
});
test('SEC embedded company JSON is parsed not executed; name/license mismatch fails closed', () => {
  assert.equal(parseCompany(company(NAME, '023059800'), NAME).phone, '023059800');
  assert.equal(parseCompany(company('Another Company', '023059800'), NAME), null);
  assert.equal(parseCompany('<script>var company = {bad: process.exit()};</script>', NAME), null);
  assert.equal(parseCompany('<script>var company = ' + JSON.stringify({ CompanyName_EN: NAME, Telephone: '023059800',
    License_EverReceived: [{}] }) + ';</script>', NAME), null);
  const rows = parseAimc(member() + member(NAME, 'second.com'));
  assert.equal(phoneNameMatches(NAME, { phone: '023059800' }, rows).length, 2);
});
test('SEC fund profile identity exposes AMC metadata without changing NAV contract', async () => {
  const service = createDomesticMarketService({ secApiKey: 'private-sec-key', now: () => START, fetchData: async () => ({
    ok: true, status: 200, json: async () => ({ message: 'success', next_cursor: '', items: [{
      proj_id: 'M0301_2567', fund_class_name: item().symbol, fund_status: 'Registered', unique_id: ID, comp_name_en: NAME,
    }] }),
  }) });
  const identity = await service.getFundIdentity(item());
  assert.equal(identity.amcId, ID);
  assert.equal(identity.amcNameEn, NAME);
  assert.equal(identity.amcAmbiguous, false);
});
test('conflicting duplicate profile AMC data is flagged rather than overwritten for logos', async () => {
  const row = { proj_id: 'M0301_2567', fund_class_name: item().symbol, fund_status: 'Registered', unique_id: ID, comp_name_en: NAME };
  const service = createDomesticMarketService({ secApiKey: 'private-sec-key', now: () => START, fetchData: async () => ({
    ok: true, status: 200, json: async () => ({ message: 'success', next_cursor: '', items: [row, { ...row, unique_id: 'C0000000001' }] }),
  }) });
  assert.equal((await service.getFundIdentity(item())).amcAmbiguous, true);
});

