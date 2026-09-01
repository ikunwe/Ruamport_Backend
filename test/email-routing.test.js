const assert = require('node:assert/strict');
const test = require('node:test');

const { detectIngestionRoute } = require('../src/modules/ingestion/email-routing.service');

test('Gmail users are routed to Gmail API sync', () => {
  const route = detectIngestionRoute('Investor@GMAIL.com');

  assert.equal(route.channel, 'GMAIL_API');
  assert.equal(route.connectionProvider, 'GOOGLE');
  assert.equal(route.nextAction, 'CONNECT_GOOGLE_MAIL');
});

test('Microsoft email domains are routed to Microsoft Graph', () => {
  for (const email of ['a@hotmail.com', 'b@outlook.co.th', 'c@live.com']) {
    assert.equal(detectIngestionRoute(email).channel, 'MICROSOFT_GRAPH');
  }
});

test('iCloud and other domains are routed to direct upload', () => {
  for (const email of ['a@icloud.com', 'b@example.org']) {
    const route = detectIngestionRoute(email);
    assert.equal(route.channel, 'DIRECT_UPLOAD');
    assert.equal(route.requiresMailConnection, false);
  }
});

test('an account without a usable email is rejected', () => {
  assert.throws(() => detectIngestionRoute('invalid'), { code: 'EMAIL_REQUIRED' });
});
