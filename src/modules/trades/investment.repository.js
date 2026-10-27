const { getSupabaseClients } = require('../../config/supabase');
const { AppError } = require('../../shared/errors/app-error');

function createInvestmentRepository(getClient = () => getSupabaseClients().adminClient) {
  async function checked(query) {
    const { data, error } = await query;
    if (error) throw new AppError(503, 'INVESTMENT_STORAGE_UNAVAILABLE', 'Investment storage unavailable; check migrations 007-022');
    return data;
  }
  return {
    byHash: (userId, hash) => checked(getClient().from('investment_documents').select('*').eq('user_id', userId).eq('content_hash', hash).maybeSingle()),
    byId: (userId, id) => checked(getClient().from('investment_documents').select('*').eq('user_id', userId).eq('id', id).maybeSingle()),
    register: (userId, contentHash, identityKey, preview) => checked(getClient().rpc('register_investment_preview', { p_user_id: userId, p_content_hash: contentHash, p_identity_key: identityKey, p_preview: preview })),
    importDocument: (userId, id) => checked(getClient().rpc('import_investment_document', { p_user_id: userId, p_document_id: id })),
    prepareImport: (userId, id, preview) => checked(getClient().from('investment_documents').update({ preview }).eq('user_id', userId).eq('id', id).eq('status', 'PREVIEW')),
    holdings: (userId, includeClosed) => checked(getClient().rpc('get_stock_holdings', { p_user_id: userId, p_include_closed: includeClosed })),
    portfolioOrders: userId => checked(getClient().rpc('get_portfolio_history_orders', { p_user_id: userId })),
    analyticsOrders: userId => checked(getClient().rpc('get_analytics_orders', { p_user_id: userId })),
    simulateSale: (userId, request) => checked(getClient().rpc('simulate_investment_sale', { p_user_id: userId, p_request: request })),
    list: (userId, table, offset, limit) => checked(getClient().from(table).select('*').eq('user_id', userId).order('created_at', { ascending: false }).order('id', { ascending: false }).range(offset, offset + limit)),
    history: (userId, mailbox, messageId) => checked(getClient().from('gmail_pdf_history').select('*').eq('user_id', userId).eq('mailbox', mailbox).eq('message_id', messageId)),
    saveHistory: row => checked(getClient().from('gmail_pdf_history').upsert(row, { onConflict: 'user_id,mailbox,message_id,attachment_key' })),
  };
}
module.exports = { createInvestmentRepository };
