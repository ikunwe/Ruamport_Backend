function getHealth(_request, response) {
  response.status(200).json({
    status: 'ok',
    service: 'portfolio-api',
    timestamp: new Date().toISOString(),
  });
}

module.exports = { getHealth };
