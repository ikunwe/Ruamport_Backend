const multer = require('multer');
const { publicFxError } = require('../shared/errors/fx-error');

function errorHandler(error, request, response, _next) {
  let status = Number.isInteger(error.status) ? error.status : 500;
  let code = error.code || 'INTERNAL_SERVER_ERROR';
  let message = status >= 500 ? 'An unexpected error occurred' : error.message;
  const fxError = publicFxError(error);
  if (fxError) message = fxError.message;

  // Strict JSON parsing rejects scalar/null bodies before the mail service runs.
  // Keep that endpoint's validation contract without relaxing parsing elsewhere.
  const apiPrefix = (process.env.API_PREFIX || '/api/v1').replace(/\/+$/, '');
  const mailConnectPath = `${apiPrefix}/mail/gmail/connect`.toLowerCase();
  if (status === 400 && error.type === 'entity.parse.failed' && request.method === 'POST'
    && request.path.replace(/\/+$/, '').toLowerCase() === mailConnectPath) {
    code = 'INVALID_MAIL_CLIENT';
    message = 'Send a JSON object with client web or mobile';
    response.set('Cache-Control', 'no-store');
  }

  if (error instanceof multer.MulterError) {
    status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    code = error.code === 'LIMIT_FILE_SIZE' ? 'PDF_TOO_LARGE' : 'UPLOAD_ERROR';
    message = error.code === 'LIMIT_FILE_SIZE'
      ? 'PDF file size must not exceed 10 MB'
      : 'The PDF upload request is invalid';
  }

  if (status >= 500) {
    console.error(error);
  }

  response.status(status).json({
    error: {
      code,
      message,
      ...(fxError ? { reason: fxError.reason, ...(fxError.retryAt ? { retryAt: fxError.retryAt } : {}) } : {}),
    },
  });
}

module.exports = { errorHandler };
