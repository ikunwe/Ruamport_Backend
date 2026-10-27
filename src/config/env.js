function parsePort(value) {
  const port = Number(value || 3000);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }

  return port;
}

function parseCorsOrigins(value) {
  return (value || 'http://localhost:4200')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function positiveInteger(value, fallback, name) {
  const parsed = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

const env = Object.freeze({
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parsePort(process.env.PORT),
  corsOrigins: parseCorsOrigins(process.env.CORS_ORIGINS),
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  gmailClientId: process.env.GMAIL_CLIENT_ID,
  gmailClientSecret: process.env.GMAIL_CLIENT_SECRET,
  gmailRedirectUri: process.env.GMAIL_REDIRECT_URI,
  gmailFrontendReturnUrl: process.env.GMAIL_FRONTEND_RETURN_URL,
  mailTokenEncryptionKey: process.env.MAIL_TOKEN_ENCRYPTION_KEY,
  finnhubApiKey: process.env.FINNHUB_API_KEY,
  secApiKey: process.env.SEC_API_KEY || '',
  logoDevPublishableKey: (process.env.LOGO_DEV_PUBLISHABLE_KEY || '').trim(),
  thaiPriceCacheTtlSeconds: positiveInteger(process.env.THAI_PRICE_CACHE_TTL_SECONDS, 900, 'THAI_PRICE_CACHE_TTL_SECONDS'),
  fundNavCacheTtlSeconds: positiveInteger(process.env.FUND_NAV_CACHE_TTL_SECONDS, 3600, 'FUND_NAV_CACHE_TTL_SECONDS'),
  stockPriceCacheTtlSeconds: positiveInteger(process.env.STOCK_PRICE_CACHE_TTL_SECONDS, 900, 'STOCK_PRICE_CACHE_TTL_SECONDS'),
  stockLogoCacheTtlSeconds: positiveInteger(process.env.STOCK_LOGO_CACHE_TTL_SECONDS, 604800, 'STOCK_LOGO_CACHE_TTL_SECONDS'),
  stockNewsCacheTtlSeconds: positiveInteger(process.env.STOCK_NEWS_CACHE_TTL_SECONDS, 1800, 'STOCK_NEWS_CACHE_TTL_SECONDS'),
  finnhubCallsPerMinute: positiveInteger(process.env.FINNHUB_CALLS_PER_MINUTE, 60, 'FINNHUB_CALLS_PER_MINUTE'),
  finnhubCallsPerDay: process.env.FINNHUB_CALLS_PER_DAY === '0' || !process.env.FINNHUB_CALLS_PER_DAY
    ? 0 : positiveInteger(process.env.FINNHUB_CALLS_PER_DAY, 0, 'FINNHUB_CALLS_PER_DAY'),
  dimeMailSenderDomains: (process.env.DIME_MAIL_SENDER_DOMAINS || 'dime.co.th')
    .split(',').map((domain) => domain.trim().toLowerCase()).filter(Boolean),
});

function requireSupabaseEnv() {
  const required = [
    ['SUPABASE_URL', env.supabaseUrl],
    ['SUPABASE_ANON_KEY', env.supabaseAnonKey],
    ['SUPABASE_SERVICE_ROLE_KEY', env.supabaseServiceRoleKey],
  ];
  const missing = required.filter(([, value]) => !value).map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

module.exports = { env, requireSupabaseEnv, positiveInteger };
