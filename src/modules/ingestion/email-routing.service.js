const { AppError } = require('../../shared/errors/app-error');

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);
const MICROSOFT_DOMAIN_PREFIXES = ['hotmail.', 'outlook.', 'live.'];

function getEmailDomain(email) {
  if (typeof email !== 'string') return null;

  const normalizedEmail = email.trim().toLowerCase();
  const separatorIndex = normalizedEmail.lastIndexOf('@');
  if (separatorIndex <= 0 || separatorIndex === normalizedEmail.length - 1) return null;

  return normalizedEmail.slice(separatorIndex + 1);
}

function detectIngestionRoute(email) {
  const emailDomain = getEmailDomain(email);

  if (!emailDomain) {
    throw new AppError(422, 'EMAIL_REQUIRED', 'The authenticated account does not have a usable email address');
  }

  if (GMAIL_DOMAINS.has(emailDomain)) {
    return {
      emailDomain,
      channel: 'GMAIL_API',
      connectionProvider: 'GOOGLE',
      requiresMailConnection: true,
      nextAction: 'CONNECT_GOOGLE_MAIL',
    };
  }

  if (MICROSOFT_DOMAIN_PREFIXES.some((prefix) => emailDomain.startsWith(prefix))) {
    return {
      emailDomain,
      channel: 'MICROSOFT_GRAPH',
      connectionProvider: 'MICROSOFT',
      requiresMailConnection: true,
      nextAction: 'CONNECT_MICROSOFT_MAIL',
    };
  }

  return {
    emailDomain,
    channel: 'DIRECT_UPLOAD',
    connectionProvider: null,
    requiresMailConnection: false,
    nextAction: 'UPLOAD_PDF',
  };
}

module.exports = { getEmailDomain, detectIngestionRoute };
