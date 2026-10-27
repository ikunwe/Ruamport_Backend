// Deterministic public URL only: do not fetch/proxy images or involve Yahoo sessions.
function thaiStockLogo(item, { includeClosed = false } = {}) {
  if (item.assetType !== 'THAI_STOCK' || item.currency !== 'THB'
    || typeof item.quantity !== 'number' || !Number.isFinite(item.quantity) || item.quantity < 0
    || (item.quantity === 0 && includeClosed !== true)
    || typeof item.symbol !== 'string'
    || (item.exchange && !['XBKK', 'SET', 'MAI'].includes(String(item.exchange).toUpperCase()))) return null;
  const symbol = item.symbol.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9.-]{0,31}$/.test(symbol)) return null;
  return {
    status: 'UNVERIFIED', source: 'SET', symbol, providerSymbol: symbol,
    url: 'https://media.set.or.th/common/logo/company/' + encodeURIComponent(symbol) + '.png',
    verified: false, fallbackText: item.symbol.trim(),
  };
}
module.exports = { thaiStockLogo };

