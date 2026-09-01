const express = require('express');

const { requireAuth } = require('../../middlewares/auth.middleware');
const { loginUsername, me, updateCredentials } = require('./auth.controller');

const authRouter = express.Router();

authRouter.post('/login-username', loginUsername);
authRouter.get('/me', requireAuth, me);
authRouter.patch('/credentials', requireAuth, updateCredentials);

module.exports = { authRouter };
