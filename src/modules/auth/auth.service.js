const { getSupabaseClients } = require('../../config/supabase');
const { AppError } = require('../../shared/errors/app-error');

const PROFILE_FIELDS = 'id, email, username, full_name, avatar_url, password_enabled, created_at, updated_at';

async function loginWithUsername(username, password) {
  const { adminClient, publicClient } = getSupabaseClients();
  const { data: profile, error: profileError } = await adminClient
    .from('profiles')
    .select('email, password_enabled')
    .eq('username', username)
    .maybeSingle();

  if (profileError) {
    throw profileError;
  }

  if (!profile?.password_enabled) {
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid username or password');
  }

  const { data, error } = await publicClient.auth.signInWithPassword({
    email: profile.email,
    password,
  });

  if (error || !data.session) {
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid username or password');
  }

  return data;
}

async function getProfile(userId) {
  const { adminClient } = getSupabaseClients();
  const { data, error } = await adminClient
    .from('profiles')
    .select(PROFILE_FIELDS)
    .eq('id', userId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function updateUsernameCredentials(userId, changes) {
  const { adminClient, publicClient } = getSupabaseClients();
  const currentProfile = await getProfile(userId);

  if (!currentProfile) {
    throw new AppError(404, 'PROFILE_NOT_FOUND', 'Profile was not found for this account');
  }

  if (changes.username && changes.username !== currentProfile.username) {
    const { data: existing, error: lookupError } = await adminClient
      .from('profiles')
      .select('id')
      .eq('username', changes.username)
      .maybeSingle();

    if (lookupError) throw lookupError;
    if (existing && existing.id !== userId) {
      throw new AppError(409, 'USERNAME_TAKEN', 'This username is unavailable');
    }
  }

  if (changes.password) {
    const { error: passwordError } = await adminClient.auth.admin.updateUserById(userId, {
      password: changes.password,
    });
    if (passwordError) throw passwordError;
  }

  const profileChanges = {};
  if (changes.username) profileChanges.username = changes.username;
  if (changes.password) profileChanges.password_enabled = true;

  const { data: profile, error: profileError } = await adminClient
    .from('profiles')
    .update(profileChanges)
    .eq('id', userId)
    .select(PROFILE_FIELDS)
    .single();

  if (profileError?.code === '23505') {
    throw new AppError(409, 'USERNAME_TAKEN', 'This username is unavailable');
  }
  if (profileError) throw profileError;

  let session = null;

  // การเปลี่ยน Password อาจยกเลิก access token เดิม จึงสร้าง Session ใหม่
  // และส่งให้ Frontend นำไปแทน Session เก่าทันที
  if (changes.password) {
    const { data: signInData, error: signInError } = await publicClient.auth.signInWithPassword({
      email: currentProfile.email,
      password: changes.password,
    });

    if (signInError || !signInData.session) {
      throw new AppError(
        500,
        'SESSION_REFRESH_FAILED',
        'Password was updated, but a new session could not be created',
      );
    }

    session = signInData.session;
  }

  return { profile, session };
}

module.exports = {
  loginWithUsername,
  getProfile,
  updateUsernameCredentials,
};
