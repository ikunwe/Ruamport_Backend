const test = require('node:test');
const assert = require('node:assert/strict');
const { createMailRepository } = require('../src/modules/mail/mail.repository');

// Capture actual repository query chains, not an alternate service implementation.
function recorder(errorAt = -1) {
  const queries = [];
  const client = { from(table) {
    const index = queries.length; const entry = { table, steps: [] }; queries.push(entry);
    const response = () => Promise.resolve({ data: null, error: index === errorAt ? { message: 'private-storage-details' } : null });
    const query = { then: (resolve, reject) => response().then(resolve, reject) };
    for (const method of ['select', 'eq', 'lt', 'delete', 'insert', 'upsert']) {
      query[method] = (...args) => { entry.steps.push([method, ...args]); return query; };
    }
    query.maybeSingle = () => { entry.steps.push(['maybeSingle']); return response(); };
    return query;
  } };
  return { queries, repository: createMailRepository(() => client) };
}

test('mail repository scopes connection/disconnect by owner and consumes state with one DELETE RETURNING chain', async () => {
  const f = recorder();
  await f.repository.connection('owner-a');
  await f.repository.consumeState('state-hash');
  await f.repository.disconnect('owner-b');
  assert.deepEqual(f.queries, [
    { table: 'mail_connections', steps: [['select', '*'], ['eq', 'user_id', 'owner-a'], ['maybeSingle']] },
    { table: 'mail_oauth_states', steps: [['delete'], ['eq', 'state_hash', 'state-hash'], ['select', '*'], ['maybeSingle']] },
    { table: 'mail_oauth_states', steps: [['delete'], ['eq', 'user_id', 'owner-b']] },
    { table: 'mail_connections', steps: [['delete'], ['eq', 'user_id', 'owner-b']] },
  ]);
});

test('saveState retains latest sequential pending policy and aborts insert if cleanup fails without leaking storage errors', async () => {
  const row = { user_id: 'owner-a', state_hash: 'new-state', verifier_encrypted: 'ciphertext' };
  const f = recorder(); await f.repository.saveState(row);
  assert.equal(f.queries[0].table, 'mail_oauth_states');
  assert.equal(f.queries[0].steps[0][0], 'delete');
  assert.equal(f.queries[0].steps[1][0], 'lt');
  assert.equal(f.queries[0].steps[1][1], 'expires_at');
  assert.deepEqual(f.queries[1], { table: 'mail_oauth_states', steps: [['delete'], ['eq', 'user_id', 'owner-a']] });
  assert.deepEqual(f.queries[2], { table: 'mail_oauth_states', steps: [['insert', row]] });
  const failing = recorder(1);
  await assert.rejects(failing.repository.saveState(row), e => e.code === 'MAIL_STORAGE_UNAVAILABLE' && !e.message.includes('private'));
  assert.equal(failing.queries.length, 2);
});
