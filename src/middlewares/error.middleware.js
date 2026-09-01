function errorHandler(error, _request, response, _next) {
  const status = Number.isInteger(error.status) ? error.status : 500;

  if (status >= 500) {
    console.error(error);
  }

  response.status(status).json({
    error: {
      code: error.code || 'INTERNAL_SERVER_ERROR',
      message: status >= 500 ? 'An unexpected error occurred' : error.message,
    },
  });
}

module.exports = { errorHandler };
