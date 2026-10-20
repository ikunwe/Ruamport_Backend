const express = require('express');
const { requireAuth } = require('../../middlewares/auth.middleware');
const { AppError } = require('../../shared/errors/app-error');
const { createMailService } = require('./mail.service');
function createMailRouter(service = createMailService(), authenticate = requireAuth) {
  const router = express.Router();
  router.get('/gmail/callback', async (request, response) => {
    response.set('Cache-Control', 'no-store');
    response.set('Referrer-Policy', 'no-referrer');
    let code;
    try { await service.callback(request.query); }
    catch (error) { code = error instanceof AppError ? error.code : 'MAIL_CONNECTION_FAILED'; }
    response.redirect(303, service.returnUrl(code));
  });
  router.use(authenticate);
  router.use((_request, response, next) => { response.set('Cache-Control', 'no-store'); next(); });
  router.get('/connection', async (request, response) => response.json(await service.status(request.user)));
  router.post('/gmail/connect', async (request, response) => response.json(await service.connect(request.user)));
  router.post('/gmail/sync-preview', async (request, response) => response.json(await service.sync(request.user, request.body)));
  router.delete('/gmail/connection', async (request, response) => response.json(await service.disconnect(request.user)));
  return router;
}
module.exports = { mailRouter: createMailRouter(), createMailRouter };
