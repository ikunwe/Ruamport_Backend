const { createClient } = require('@supabase/supabase-js');

const { env, requireSupabaseEnv } = require('./env');

let clients;

function getSupabaseClients() {
  if (!clients) {
    requireSupabaseEnv();
    const options = { auth: { autoRefreshToken: false, persistSession: false } };

    clients = {
      publicClient: createClient(env.supabaseUrl, env.supabaseAnonKey, options),
      adminClient: createClient(env.supabaseUrl, env.supabaseServiceRoleKey, options),
    };
  }

  return clients;
}

module.exports = { getSupabaseClients };
