const { AppError } = require('../../shared/errors/app-error');
const { detectIngestionRoute } = require('../ingestion/email-routing.service');
const {
  loginWithUsername,
  getProfile,
  updateUsernameCredentials,
} = require('./auth.service');
const {
  validateUsername,
  validatePassword,
} = require('./auth.validation');

async function loginUsername(request, response) {
  const username = validateUsername(request.body?.username);
  const password = request.body?.password;

  if (!username) {
    throw new AppError(400, 'INVALID_USERNAME', 'Username must be 3-50 characters and cannot contain @');
  }
  if (typeof password !== 'string' || password.length === 0) {
    throw new AppError(400, 'PASSWORD_REQUIRED', 'Password is required');
  }

  const data = await loginWithUsername(username, password);
  response.status(200).json({ user: data.user, session: data.session });
}

async function me(request, response) {
  const profile = await getProfile(request.user.id);
  const ingestionRoute = detectIngestionRoute(request.user.email);

  response.status(200).json({
    user: { id: request.user.id, email: request.user.email },
    profile,
    usernameLoginEnabled: Boolean(profile?.password_enabled),
    ingestionRoute,
  });
}

async function updateCredentials(request, response) {
  const hasUsername = Object.hasOwn(request.body || {}, 'username');
  const hasPassword = Object.hasOwn(request.body || {}, 'password');

  if (!hasUsername && !hasPassword) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Provide username or password to update');
  }

  const changes = {};
  if (hasUsername) {
    const username = validateUsername(request.body.username);
    if (!username) {
      throw new AppError(400, 'INVALID_USERNAME', 'Username must be 3-50 characters and cannot contain @');
    }
    changes.username = username;
  }
  if (hasPassword) {
    if (!validatePassword(request.body.password)) {
      throw new AppError(400, 'INVALID_PASSWORD', 'Password must be between 8 and 72 characters');
    }
    changes.password = request.body.password;
  }

  const result = await updateUsernameCredentials(request.user.id, changes);
  response.status(200).json({
    profile: result.profile,
    usernameLoginEnabled: Boolean(result.profile.password_enabled),
    session: result.session,
  });
}

module.exports = { loginUsername, me, updateCredentials };
