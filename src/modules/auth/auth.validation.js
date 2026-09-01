function normalizeUsername(value) {
  return typeof value === 'string'
    ? value.trim().replace(/\s+/gu, ' ').toLowerCase()
    : '';
}

function validateUsername(value) {
  const username = normalizeUsername(value);
  const length = [...username].length;
  return length >= 3 && length <= 50 && !username.includes('@') ? username : null;
}

function validatePassword(value) {
  return typeof value === 'string' && value.length >= 8 && value.length <= 72;
}

module.exports = {
  normalizeUsername,
  validateUsername,
  validatePassword,
};
