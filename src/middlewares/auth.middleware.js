const { getSupabaseClients } = require('../config/supabase');
const { AppError } = require('../shared/errors/app-error');

async function requireAuth(request, _response, next) {
  try {
    const authorization = request.get('authorization') || '';
    const match = authorization.match(/^Bearer\s+(.+)$/i);

    if (!match) {
      throw new AppError(401, 'UNAUTHORIZED', 'A Bearer access token is required');
    }

    const { adminClient } = getSupabaseClients();
    const { data, error } = await adminClient.auth.getUser(match[1]);

    if (error || !data.user) {
      throw new AppError(401, 'UNAUTHORIZED', 'The access token is invalid or expired');
    }

    request.user = data.user;
    request.accessToken = match[1];
    next();
  } catch (error) {
    next(error);
  }
}

module.exports = { requireAuth };
