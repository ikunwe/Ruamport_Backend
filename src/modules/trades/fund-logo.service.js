const { env } = require('../../config/env');
const { createPublicMarketCache } = require('./public-market-cache');
const { domesticInstrument } = require('./domestic-market.service');
const { parseAimc, parseCurrentIds, parseCompany, normalizeName, phoneNameMatches } = require('./amc-directory');
const HOUR = 3_600_000;
const AIMC = 'https://association.aimc.or.th/members/';
const CURRENT = 'https://market.sec.or.th/LicenseCheck/views/Intermediaries?lang=en';
const COMPANY = 'https://market.sec.or.th/LicenseCheck/CompanyDetail/';
function createFundLogoService({ getFundIdentity, fetchData = globalThis.fetch, now = Date.now,
  publishableKey = env.logoDevPublishableKey, ttlMs = HOUR, directoryTtlMs = 6 * HOUR,
  maxEntries = 1000, timeoutMs = 5000 } = {}) {
  for (const value of [ttlMs, directoryTtlMs, maxEntries, timeoutMs]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid fund logo limits');
  }
  if (ttlMs > 24 * HOUR || directoryTtlMs > 24 * HOUR || maxEntries > 10000 || timeoutMs > 30000) {
    throw new Error('Fund logo limits too large');
  }
  const error = (code, retryAt = now() + 300_000) =>
    Object.assign(new Error('Fund logo unavailable'), { safeCode: code, retryAt });
  const resources = createPublicMarketCache({ now, ttlMs: directoryTtlMs, maxAgeMs: directoryTtlMs, maxEntries });
  const domains = createPublicMarketCache({ now, ttlMs, maxAgeMs: ttlMs, maxEntries });
  const logos = createPublicMarketCache({ now, ttlMs, maxAgeMs: ttlMs, maxEntries });
  const budgets = new Map();
  async function readText(url) {
    // Only these fixed official pages are fetched; never fetch a discovered domain or client URL.
    if (url !== AIMC && url !== CURRENT && !/^https:\/\/market\.sec\.or\.th\/LicenseCheck\/CompanyDetail\/\d{10}$/.test(url)) {
      throw error('LOGO_DIRECTORY_UNAVAILABLE');
    }
    const host = new URL(url).host;
    const budget = budgets.get(host) || { attempts: [], blockedUntil: 0 };
    budgets.set(host, budget);
    budget.attempts = budget.attempts.filter(time => now() - time < 60000);
    if (budget.blockedUntil > now()) throw error('LOGO_DIRECTORY_RATE_LIMITED', budget.blockedUntil);
    if (budget.attempts.length >= 20) throw error('LOGO_DIRECTORY_RATE_LIMITED', budget.attempts[0] + 60000);
    budget.attempts.push(now());
    let response;
    try {
      response = await fetchData(url, { headers: { Accept: 'text/html', 'User-Agent': 'PortfolioManage-Backend/1.0' },
        signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
      if (!response.ok) {
        await response.body?.cancel();
        if ([421, 429].includes(response.status)) {
          const header = response.headers?.get?.('retry-after');
          const hint = header && /^\d+$/.test(header) ? now() + Number(header) * 1000 : Date.parse(header);
          budget.blockedUntil = Math.max(now() + 300000, Number.isFinite(hint) ? Math.min(hint, now() + HOUR) : 0);
          throw error('LOGO_DIRECTORY_RATE_LIMITED', budget.blockedUntil);
        }
        throw error('LOGO_DIRECTORY_UNAVAILABLE');
      }
      const type = response.headers?.get?.('content-type');
      if (!type || !/^text\/html\b/i.test(type)) throw error('LOGO_DIRECTORY_UNAVAILABLE');
      const limit = 2 * 1024 * 1024;
      const declared = Number(response.headers?.get?.('content-length'));
      if (declared > limit) throw error('LOGO_DIRECTORY_UNAVAILABLE');
      if (response.body?.getReader) {
        const reader = response.body.getReader();
        const chunks = [];
        let length = 0;
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > limit) throw error('LOGO_DIRECTORY_UNAVAILABLE');
            chunks.push(Buffer.from(value));
          }
        } finally { await reader.cancel(); }
        return Buffer.concat(chunks).toString('utf8');
      }
      const html = await response.text();
      if (typeof html !== 'string' || Buffer.byteLength(html) > limit) throw error('LOGO_DIRECTORY_UNAVAILABLE');
      return html;
    } catch (caught) {
      if (caught.safeCode) throw caught;
      throw error('LOGO_DIRECTORY_UNAVAILABLE');
    }
  }
  async function resource(key, url, parse) {
    const value = await resources(key, async () => {
      const items = parse(await readText(url));
      if (!items?.length) throw error('LOGO_DIRECTORY_UNAVAILABLE');
      return { status: 'AVAILABLE', items };
    }, safe => ({ status: 'UNAVAILABLE', errorCode: safe.code, retryAt: safe.retryAt }));
    if (value.status !== 'AVAILABLE') throw error(value.errorCode, value.retryAt);
    return value;
  }
  async function resolve(fund) {
    const value = await domains(fund.amcId, async () => {
      const current = await resource('SEC_CURRENT', CURRENT, parseCurrentIds);
      if (!current.items.includes(fund.amcId)) throw error('LOGO_AMC_NOT_CURRENTLY_LISTED', now() + HOUR);
      const directory = await resource('AIMC_MEMBERS', AIMC, parseAimc);
      const matches = directory.items.filter(row => row.key === normalizeName(fund.amcNameEn));
      let row;
      let method;
      if (matches.length > 1 || (matches.length === 1 && matches[0].domains.length > 1)) throw error('LOGO_AMC_AMBIGUOUS');
      if (matches.length === 1 && matches[0].domains.length === 1) {
        row = matches[0]; method = 'EXACT_NAME';
      } else {
        const company = await resources('SEC_COMPANY:' + fund.amcId, async () => {
          const data = parseCompany(await readText(COMPANY + fund.amcId.slice(1)), fund.amcNameEn);
          if (!data) throw error('LOGO_AMC_DOMAIN_UNRESOLVED');
          return { status: 'AVAILABLE', ...data };
        }, safe => ({ status: 'UNAVAILABLE', errorCode: safe.code, retryAt: safe.retryAt }));
        if (company.status !== 'AVAILABLE') throw error(company.errorCode, company.retryAt);
        const candidates = phoneNameMatches(fund.amcNameEn, company, directory.items);
        if (candidates.length !== 1) throw error(candidates.length ? 'LOGO_AMC_AMBIGUOUS' : 'LOGO_AMC_DOMAIN_UNRESOLVED');
        row = candidates[0]; method = 'OFFICIAL_PHONE_AND_NAME';
      }
      return { status: 'AVAILABLE', amcId: fund.amcId, amcName: fund.amcNameEn, domain: row.domains[0],
        matchedDirectoryName: row.name, matchMethod: method, directorySource: 'AIMC',
        directoryUrl: AIMC, directoryFetchedAt: directory.fetchedAt,
        secRegistryCheckedAt: current.fetchedAt };
    }, safe => ({ status: 'UNAVAILABLE', errorCode: safe.code, retryAt: safe.retryAt }));
    if (value.status !== 'AVAILABLE') throw error(value.errorCode, value.retryAt);
    // Cached domains must never cross company names after a renamed/changed profile.
    if (normalizeName(value.amcName) !== normalizeName(fund.amcNameEn)) throw error('LOGO_AMC_DOMAIN_UNRESOLVED');
    return value;
  }
  async function getLogo(item, target) {
    return logos(target.key, async () => {
      if (typeof publishableKey !== 'string' || !/^pk_[A-Za-z0-9_-]{10,128}$/.test(publishableKey)) {
        throw error('LOGO_DEV_KEY_MISSING');
      }
      let fund;
      try { fund = await getFundIdentity(item); }
      catch (caught) {
        throw error(/^NAV_[A-Z_]+$/.test(caught.safeCode || '') ? caught.safeCode.replace(/^NAV_/, 'LOGO_') : 'LOGO_NOT_AVAILABLE',
          Number.isFinite(caught.retryAt) ? caught.retryAt : undefined);
      }
      if (!/^C\d{10}$/.test(fund?.amcId || '') || typeof fund.amcNameEn !== 'string'
        || !normalizeName(fund.amcNameEn) || fund.amcNameEn.length > 300 || fund.amcAmbiguous) {
        throw error('LOGO_AMC_IDENTITY_UNAVAILABLE');
      }
      const match = await resolve(fund);
      const url = new URL('https://img.logo.dev/' + encodeURIComponent(match.domain));
      url.search = new URLSearchParams({ token: publishableKey, format: 'png', size: '128', fallback: '404' });
      return { status: 'UNVERIFIED', source: 'LOGO_DEV', symbol: item.symbol, providerSymbol: fund.fundClassName,
        projectId: fund.projectId, fundClassName: fund.fundClassName,
        amcId: match.amcId, amcName: match.amcName, domain: match.domain,
        directorySource: match.directorySource, directoryUrl: match.directoryUrl,
        matchedDirectoryName: match.matchedDirectoryName, matchMethod: match.matchMethod,
        directoryFetchedAt: match.directoryFetchedAt, secRegistryCheckedAt: match.secRegistryCheckedAt,
        url: url.toString(), domainVerified: true, verified: false, logoRepresents: 'AMC',
        fallbackText: item.symbol };
    }, safe => ({ status: 'UNAVAILABLE', source: 'LOGO_DEV', symbol: item.symbol, url: null,
      logoRepresents: 'AMC', fallbackText: item.symbol, verified: false, domainVerified: false,
      errorCode: safe.code, retryAt: new Date(safe.retryAt).toISOString() }));
  }
  return {
    async getLogos(items) {
      const targets = new Map();
      for (const item of items) {
        if (item.assetType !== 'MUTUAL_FUND' || typeof item.quantity !== 'number' || !Number.isFinite(item.quantity) || item.quantity <= 0) continue;
        const target = domesticInstrument(item);
        if (target) targets.set(target.key, { item, target });
      }
      const result = new Map();
      for (const [key, { item, target }] of targets) result.set(key, await getLogo(item, target));
      return result;
    },
  };
}
module.exports = { createFundLogoService };

