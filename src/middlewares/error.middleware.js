const multer = require('multer');
const { publicFxError } = require('../shared/errors/fx-error');

function errorHandler(error, _request, response, _next) {
  let status = Number.isInteger(error.status) ? error.status : 500;
  let code = error.code || 'INTERNAL_SERVER_ERROR';
  let message = status >= 500 ? 'An unexpected error occurred' : error.message;
  const fxError = publicFxError(error);
  if (fxError) message = fxError.message;

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
