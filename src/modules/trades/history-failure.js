const { providerFailureDetails } = require('./public-market-cache');
function historyFailure(source, error) {
  return { status: 'UNAVAILABLE', source, points: [], errorCode: error.code,
    reason: null, limitSource: null, providerStatus: null, ...providerFailureDetails(error),
    retryAt: Number.isFinite(error.retryAt) ? new Date(error.retryAt).toISOString() : null };
}
module.exports = { historyFailure };
