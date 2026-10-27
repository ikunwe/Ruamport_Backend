// Parse only the narrowly selected public directory fields; never execute remote scripts.
function decode(value) {
  return String(value || '').replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code) => {
    const n = /^x/i.test(code) ? parseInt(code.slice(1), 16) : Number(code);
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '';
  }).replace(/&(?:amp|quot|apos|nbsp|lt|gt);/gi, entity =>
    ({ '&amp;': '&', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ', '&lt;': '<', '&gt;': '>' })[entity.toLowerCase()]);
}
const text = html => decode(String(html || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
function attributes(tag) {
  const result = {};
  for (const m of String(tag || '').matchAll(/([a-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi)) {
    result[m[1].toLowerCase()] = decode(m[2] ?? m[3] ?? m[4]);
  }
  return result;
}
function normalizeName(value) {
  return text(value).toUpperCase()
    .replace(/\b(?:COMPANY\s+LIMITED|CO\.?\s*,?\s*LTD\.?|LIMITED|LTD\.?)\.?\s*$/, '')
    .replace(/[^A-Z0-9]/g, '');
}
function publicDomain(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port
      || host.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)
      || /\.(?:localhost|local|internal|invalid|test|example)$/.test(host)) return null;
    return host.replace(/^www\./, '');
  } catch { return null; }
}
function parseAimc(html) {
  const records = [];
  for (const block of html.split(/(?=<h2\b)/i)) {
    const heading = block.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i)?.[1];
    if (!heading) continue;
    const cells = [...block.matchAll(/<li\b[^>]*>[\s\S]*?<\/li>/gi)].map(m => m[0]);
    // Do not collect every URL in a member block (footers contain unrelated links).
    const web = cells.find(cell => /Website\s*:/i.test(text(cell)));
    const domains = [...new Set((web?.match(/<a\b[^>]*>/gi) || [])
      .map(tag => publicDomain(attributes(tag).href)).filter(Boolean))];
    const telephone = cells.find(cell => /โทรศัพท์\s*:/.test(text(cell)));
    const phones = [...new Set((telephone?.match(/<a\b[^>]*>/gi) || [])
      .map(tag => attributes(tag).href).filter(href => /^tel:/i.test(href || ''))
      .map(href => href.slice(4).replace(/\D/g, '')).filter(value => value.length >= 9))];
    const name = text(heading);
    if (name.length <= 300 && normalizeName(name)) records.push({ name, key: normalizeName(name), domains, phones });
  }
  return records;
}
function parseCurrentIds(html) {
  const ids = new Set();
  for (const tag of html.match(/<a\b[^>]*>/gi) || []) {
    try {
      const url = new URL(attributes(tag).href, 'https://market.sec.or.th');
      const id = url.pathname.match(/^\/LicenseCheck\/CompanyDetail\/(\d{10})\/?$/i)?.[1];
      if (url.hostname === 'market.sec.or.th' && id) ids.add('C' + id);
    } catch { /* Missing/non-URL link, not a company record. */ }
  }
  return [...ids];
}
function parseCompany(html, expectedName) {
  const match = html.match(/var company\s*=\s*(\{[^\r\n]*\})\s*;/);
  if (!match) return null;
  try {
    const data = JSON.parse(match[1]); // JSON only, not eval/vm.
    if (!normalizeName(expectedName) || normalizeName(data.CompanyName_EN) !== normalizeName(expectedName)) return null;
    const currentKeys = ['License_UnderSecuritiesAndExchange', 'License_RegisterType', 'License_UnderDerivatives',
      'License_RegisterType2', 'License_UnderTrust', 'License_UnderDigitalAsset', 'License_RegisterType3'];
    if (!currentKeys.some(key => Array.isArray(data[key]) && data[key].length > 0)) return null;
    const phone = typeof data.Telephone === 'string' ? data.Telephone.replace(/\D/g, '') : '';
    return { name: data.CompanyName_EN, phone };
  } catch { return null; }
}
function phoneNameMatches(name, company, records) {
  if (!company || company.phone.length < 9) return [];
  const tokens = value => new Set(text(value).toUpperCase().match(/[A-Z]+/g) || []);
  const source = tokens(name);
  return records.filter(row => {
    if (row.domains.length !== 1 || !row.phones.includes(company.phone)) return false;
    const target = tokens(row.name);
    const union = new Set([...source, ...target]).size;
    const intersection = [...source].filter(token => target.has(token)).length;
    return union > 0 && intersection / union >= 0.7;
  });
}
module.exports = { parseAimc, parseCurrentIds, parseCompany, normalizeName, phoneNameMatches, publicDomain };

