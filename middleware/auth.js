const { hashApiKey } = require('../utils/crypto');

function createAuthMiddleware(dbPool) {
  return async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized: Missing or malformed token' });
    }

    const apiKey = authHeader.substring(7).trim();
    if (!apiKey) {
      return res.status(401).json({ error: 'Unauthorized: Empty token' });
    }

    const hashedKey = hashApiKey(apiKey);

    try {
      const queryText = `
        SELECT ak.*, t.name as tenant_name
        FROM api_keys ak
        JOIN tenants t ON ak.tenant_id = t.id
        WHERE ak.key_hash = $1
          AND ak.is_active = true
          AND (ak.expires_at IS NULL OR ak.expires_at > CURRENT_TIMESTAMP)
      `;
      const result = await dbPool.query(queryText, [hashedKey]);

      if (result.rows.length === 0) {
        return res.status(401).json({ error: 'Unauthorized: Invalid or expired API key' });
      }

      const keyRecord = result.rows[0];
      req.tenant = { id: keyRecord.tenant_id, name: keyRecord.tenant_name };
      req.apiKeyRecord = keyRecord;
      next();
    } catch (err) {
      console.error('Auth Middleware Error:', err);
      return res.status(500).json({ error: 'Internal Server Error in Authentication' });
    }
  };
}

module.exports = {
  createAuthMiddleware
};
