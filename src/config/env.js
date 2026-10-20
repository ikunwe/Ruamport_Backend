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

module.exports = { env, requireSupabaseEnv };
