const { createApp } = require('./app');
const { env } = require('./config/env');

const app = createApp();

const server = app.listen(env.port, () => {
  console.log(`Portfolio API listening on port ${env.port}`);
});

function shutdown(signal) {
  console.log(`${signal} received. Shutting down gracefully.`);
  server.close(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
