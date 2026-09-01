const assert = require('node:assert/strict');
const test = require('node:test');

const {
  validateUsername,
  validatePassword,
} = require('../src/modules/auth/auth.validation');

test('username is normalized before validation', () => {
  assert.equal(validateUsername('  Portfolio User  '), 'portfolio user');
});

test('username rejects unsupported formats', () => {
  assert.equal(validateUsername('ab'), null);
  assert.equal(validateUsername('user@example.com'), null);
  assert.equal(validateUsername('x'.repeat(51)), null);
});

test('username supports a profile display name in Thai', () => {
  assert.equal(validateUsername(' สมชาย ใจดี '), 'สมชาย ใจดี');
});

test('password requires 8 to 72 characters', () => {
  assert.equal(validatePassword('1234567'), false);
  assert.equal(validatePassword('correct-horse'), true);
  assert.equal(validatePassword('x'.repeat(73)), false);
});
