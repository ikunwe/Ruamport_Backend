const { AppError } = require('../../shared/errors/app-error');
const READ_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
function createGmailClient(config, fetchImpl = fetch) {
  async function request(url, options = {}) {
    let response;
    try { response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(20000) }); }
    catch { throw new AppError(502, 'GMAIL_UNAVAILABLE', 'Gmail did not respond; try again'); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 || data.error === 'invalid_grant') throw new AppError(401, 'MAIL_RECONNECT_REQUIRED', 'Reconnect Gmail');
      if (response.status === 403) throw new AppError(403, 'GMAIL_ACCESS_DENIED', 'Check Gmail API and mail-read permission');
      if (response.status === 429) throw new AppError(429, 'GMAIL_RATE_LIMITED', 'Gmail rate limit reached; try later');
      throw new AppError(502, 'GMAIL_REQUEST_FAILED', 'Gmail request failed');
    }
    return data;
  }
  const tokenRequest = params => request('https://oauth2.googleapis.com/token', {
    method: 'POST', body: new URLSearchParams({ client_id: config.gmailClientId, client_secret: config.gmailClientSecret, ...params }),
  });
  function api(path, token, params = {}) {
    const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`);
    for (const [key, value] of Object.entries(params)) if (value) url.searchParams.set(key, value);
    return request(url, { headers: { Authorization: `Bearer ${token}` } });
  }
  return {
    exchangeCode: (code, verifier) => tokenRequest({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: config.gmailRedirectUri }),
    refresh: refresh_token => tokenRequest({ grant_type: 'refresh_token', refresh_token }),
    profile: token => api('profile', token),
    listMessages: (token, q, pageToken) => api('messages', token, { q, pageToken, maxResults: '10' }),
    message: (token, id) => api(`messages/${encodeURIComponent(id)}`, token, { format: 'full' }),
    attachment: (token, messageId, id) => api(`messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(id)}`, token),
    async revoke(token) {
      try { return (await fetchImpl('https://oauth2.googleapis.com/revoke', { method: 'POST', body: new URLSearchParams({ token }), signal: AbortSignal.timeout(10000) })).ok; }
      catch { return false; }
    },
  };
}
module.exports = { createGmailClient, READ_SCOPE };
