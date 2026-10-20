const { getSupabaseClients } = require('../../config/supabase');
const { AppError } = require('../../shared/errors/app-error');
function createMailRepository(getClient = () => getSupabaseClients().adminClient) {
  async function checked(query) {
    const { data, error } = await query;
    if (error) throw new AppError(503, 'MAIL_STORAGE_UNAVAILABLE', 'Mail storage unavailable; check migration 006');
    return data;
  }
  return {
    connection: userId => checked(getClient().from('mail_connections').select('*').eq('user_id', userId).maybeSingle()),
    saveConnection: row => checked(getClient().from('mail_connections').upsert(row, { onConflict: 'user_id' })),
    saveState: async row => {
      await checked(getClient().from('mail_oauth_states').delete().lt('expires_at', new Date().toISOString()));
      await checked(getClient().from('mail_oauth_states').delete().eq('user_id', row.user_id));
      return checked(getClient().from('mail_oauth_states').insert(row));
    },
    // DELETE RETURNING consumes a state atomically, including concurrent callbacks.
    consumeState: stateHash => checked(getClient().from('mail_oauth_states').delete().eq('state_hash', stateHash).select('*').maybeSingle()),
    async disconnect(userId) {
      await checked(getClient().from('mail_oauth_states').delete().eq('user_id', userId));
      await checked(getClient().from('mail_connections').delete().eq('user_id', userId));
    },
  };
}
module.exports = { createMailRepository };
