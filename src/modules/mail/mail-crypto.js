const crypto = require('node:crypto');
const { AppError } = require('../../shared/errors/app-error');
function encryptionKey(value) {
  const key = Buffer.from(value || '', 'base64');
  if (key.length !== 32) throw new AppError(503, 'MAIL_CONFIG_MISSING', 'Configure a 32-byte base64 MAIL_TOKEN_ENCRYPTION_KEY');
  return key;
}
function encrypt(value, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}
function decrypt(value, key) {
  try {
    const [version, iv, tag, body] = value.split('.');
    if (version !== 'v1') throw new Error();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    throw new AppError(503, 'MAIL_TOKEN_UNREADABLE', 'Stored mail credentials cannot be decrypted; reconnect the mailbox');
  }
}
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
module.exports = { encryptionKey, encrypt, decrypt, hash };
