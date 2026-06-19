const crypto = require('crypto');

/**
 * Generates a cryptographically secure API key.
 * Prepends 'sk_live_' to a Base64 URL-safe random string.
 */
function generateApiKey() {
  const randomBytes = crypto.randomBytes(32);
  const base64UrlSafe = randomBytes.toString('base64url');
  return `sk_live_${base64UrlSafe}`;
}

/**
 * Computes the SHA-256 hash of a string.
 */
function hashApiKey(apiKey) {
  return crypto.createHash('sha256').update(apiKey).digest('hex');
}

module.exports = {
  generateApiKey,
  hashApiKey
};
