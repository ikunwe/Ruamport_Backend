const { AppError } = require('./app-error');
const MESSAGES = Object.freeze({
  TIMEOUT: 'The exchange-rate provider did not respond within the allowed time',
  NETWORK_ERROR: 'Unable to connect to the exchange-rate provider',
  UPSTREAM_HTTP_ERROR: 'The exchange-rate provider returned an unsuccessful HTTP response',
  UPSTREAM_RATE_LIMITED: 'The exchange-rate provider temporarily limited requests',
  INVALID_RESPONSE: 'The exchange-rate provider returned invalid USD/THB rate data',
  FUTURE_RATE_DATE: 'The provider rate date is later than the current date in Thailand',
  RATE_TOO_OLD: 'The provider rate date is seven or more Thai calendar days old',
  HISTORICAL_RATE_UNAVAILABLE: 'No valid USD/THB rate was found for today or the previous six Thai calendar days',
});
function fxUnavailable(reason = 'INVALID_RESPONSE') {
  const safeReason = Object.hasOwn(MESSAGES, reason) ? reason : 'INVALID_RESPONSE';
  return Object.assign(new AppError(503, 'FX_RATE_UNAVAILABLE', MESSAGES[safeReason]), { reason: safeReason });
}
function publicFxError(error) {
  if (!(error instanceof AppError) || error.status !== 503 || error.code !== 'FX_RATE_UNAVAILABLE'
    || !Object.hasOwn(MESSAGES, error.reason)) return null;
  return { reason: error.reason, message: MESSAGES[error.reason],
    ...(typeof error.retryAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(error.retryAt)
      && Number.isFinite(Date.parse(error.retryAt)) ? { retryAt: error.retryAt } : {}) };
}
module.exports = { fxUnavailable, publicFxError };
