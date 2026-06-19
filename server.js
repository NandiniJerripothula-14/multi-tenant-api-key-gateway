const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { createClient } = require('redis');
const path = require('path');

const { generateApiKey, hashApiKey } = require('./utils/crypto');
const { createAuthMiddleware } = require('./middleware/auth');
const { createRateLimiter } = require('./middleware/rateLimiter');

const app = express();
app.use(cors());
app.use(express.json());

// Serve frontend static assets from public folder
app.use(express.static(path.join(__dirname, 'public')));

let dbPool;
let redisClient;

if (process.env.USE_MOCK === 'true') {
  const { MockDbPool, MockRedisClient } = require('./utils/mockServices');
  dbPool = new MockDbPool();
  redisClient = new MockRedisClient();
  console.log('Running Gateway Service in MOCK mode (in-memory DB & Redis)');
} else {
  dbPool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:secret_password@localhost:5432/gateway_db'
  });

  redisClient = createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379'
  });

  redisClient.on('error', (err) => console.error('Redis Client Error', err));
}

// Initialize connections
async function initializeConnections() {
  try {
    if (process.env.USE_MOCK !== 'true') {
      await dbPool.connect();
      console.log('Connected to PostgreSQL database');
      await redisClient.connect();
      console.log('Connected to Redis');
    } else {
      await dbPool.connect();
      await redisClient.connect();
    }
  } catch (err) {
    console.error('Failed to connect to services, retrying in 5 seconds...', err);
    setTimeout(initializeConnections, 5000);
  }
}
initializeConnections();

// Initialize Middlewares
const authMiddleware = createAuthMiddleware(dbPool);
const rateLimiterMiddleware = createRateLimiter(redisClient, dbPool);

// Helper endpoint: Get all tenants (for UI tenant selector)
app.get('/api/tenants', async (req, res) => {
  try {
    const result = await dbPool.query('SELECT * FROM tenants ORDER BY id ASC');
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching tenants:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 3. Issue a new API key for a tenant
app.post('/api/tenants/:tenantId/keys', async (req, res) => {
  const { tenantId } = req.params;
  const rateLimitPerMinute = req.body.rateLimitPerMinute || 100;

  try {
    // Check if tenant exists
    const tenantCheck = await dbPool.query('SELECT id FROM tenants WHERE id = $1', [tenantId]);
    if (tenantCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const plainKey = generateApiKey();
    const hashedKey = hashApiKey(plainKey);
    const keyPrefix = 'sk_live_';
    const lastFour = plainKey.slice(-4);

    const insertText = `
      INSERT INTO api_keys (tenant_id, key_hash, key_prefix, last_four, rate_limit_per_minute)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, last_four, rate_limit_per_minute
    `;
    const result = await dbPool.query(insertText, [tenantId, hashedKey, keyPrefix, lastFour, rateLimitPerMinute]);
    const inserted = result.rows[0];

    res.status(201).json({
      apiKey: plainKey,
      keyRecord: {
        id: inserted.id,
        lastFour: inserted.last_four,
        rateLimitPerMinute: inserted.rate_limit_per_minute
      }
    });
  } catch (err) {
    console.error('Error issuing key:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 4. List all API keys for a tenant (masked values)
app.get('/api/tenants/:tenantId/keys', async (req, res) => {
  const { tenantId } = req.params;

  try {
    const queryText = `
      SELECT id, key_prefix, last_four, created_at, is_active, expires_at
      FROM api_keys
      WHERE tenant_id = $1 AND is_active = true
      ORDER BY created_at DESC
    `;
    const result = await dbPool.query(queryText, [tenantId]);

    const mappedKeys = result.rows.map(row => {
      // If expires_at is set and already in past, it's effectively inactive
      const isExpired = row.expires_at && new Date(row.expires_at) < new Date();
      return {
        id: row.id,
        maskedKey: `${row.key_prefix}...${row.last_four}`,
        createdAt: row.created_at,
        isActive: row.is_active && !isExpired
      };
    });

    res.json(mappedKeys);
  } catch (err) {
    console.error('Error listing keys:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 5. Protected Endpoint (authenticated & rate-limited)
app.get('/api/protected', authMiddleware, rateLimiterMiddleware, async (req, res) => {
  const apiKeyId = req.apiKeyRecord.id;
  try {
    await dbPool.query(
      'INSERT INTO audit_logs (api_key_id, endpoint, status_code) VALUES ($1, $2, $3)',
      [apiKeyId, req.path, 200]
    );
  } catch (dbErr) {
    console.error('Audit Log Insertion Error (200):', dbErr);
  }

  res.status(200).json({
    message: "Success! Access granted to protected endpoint.",
    tenant: req.tenant,
    apiKeyId: apiKeyId
  });
});

// 7. Immediate Revocation of an API key
app.delete('/api/keys/:keyId', async (req, res) => {
  const { keyId } = req.params;

  try {
    const result = await dbPool.query('UPDATE api_keys SET is_active = false WHERE id = $1', [keyId]);
    res.status(204).send();
  } catch (err) {
    console.error('Error revoking key:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 8. Key rotation with 1 minute grace period
app.post('/api/keys/:keyId/rotate', async (req, res) => {
  const { keyId } = req.params;

  try {
    // 1. Retrieve the existing key info
    const keyCheck = await dbPool.query('SELECT * FROM api_keys WHERE id = $1 AND is_active = true', [keyId]);
    if (keyCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Active API key not found' });
    }

    const oldKey = keyCheck.rows[0];

    // 2. Generate and hash the new API key
    const newPlainKey = generateApiKey();
    const newHash = hashApiKey(newPlainKey);
    const keyPrefix = 'sk_live_';
    const lastFour = newPlainKey.slice(-4);

    // 3. Insert the new key under the same tenant and rate limit settings
    const insertQuery = `
      INSERT INTO api_keys (tenant_id, key_hash, key_prefix, last_four, rate_limit_per_minute)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id
    `;
    await dbPool.query(insertQuery, [
      oldKey.tenant_id,
      newHash,
      keyPrefix,
      lastFour,
      oldKey.rate_limit_per_minute
    ]);

    // 4. Mark old key to expire in 1 minute
    const updateQuery = `
      UPDATE api_keys
      SET expires_at = NOW() + INTERVAL '1 minute'
      WHERE id = $1
    `;
    await dbPool.query(updateQuery, [keyId]);

    // 5. Return the new plaintext key
    res.status(200).json({
      newApiKey: newPlainKey
    });
  } catch (err) {
    console.error('Error rotating key:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Helper endpoint: Get audit logs for the dashboard
app.get('/api/tenants/:tenantId/audit-logs', async (req, res) => {
  const { tenantId } = req.params;
  const limit = parseInt(req.query.limit) || 10;
  const offset = parseInt(req.query.offset) || 0;

  try {
    const countQuery = `
      SELECT COUNT(*)
      FROM audit_logs al
      JOIN api_keys ak ON al.api_key_id = ak.id
      WHERE ak.tenant_id = $1
    `;
    const countResult = await dbPool.query(countQuery, [tenantId]);
    const totalCount = parseInt(countResult.rows[0].count);

    const logsQuery = `
      SELECT al.id, al.endpoint, al.status_code, al.timestamp, ak.key_prefix, ak.last_four
      FROM audit_logs al
      JOIN api_keys ak ON al.api_key_id = ak.id
      WHERE ak.tenant_id = $1
      ORDER BY al.timestamp DESC
      LIMIT $2 OFFSET $3
    `;
    const logsResult = await dbPool.query(logsQuery, [tenantId, limit, offset]);

    res.json({
      total: totalCount,
      logs: logsResult.rows.map(row => ({
        id: row.id,
        endpoint: row.endpoint,
        statusCode: row.status_code,
        timestamp: row.timestamp,
        maskedKey: `${row.key_prefix}...${row.last_four}`
      }))
    });
  } catch (err) {
    console.error('Error fetching audit logs:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Helper endpoint: Get analytics for the dashboard chart
app.get('/api/tenants/:tenantId/analytics', async (req, res) => {
  const { tenantId } = req.params;

  try {
    // Get aggregated success vs rate limit counts in the last 15 minutes grouped by minute
    const queryText = `
      SELECT TO_CHAR(al.timestamp, 'HH24:MI') as minute,
             SUM(CASE WHEN al.status_code = 200 THEN 1 ELSE 0 END) as success,
             SUM(CASE WHEN al.status_code = 429 THEN 1 ELSE 0 END) as blocked
      FROM audit_logs al
      JOIN api_keys ak ON al.api_key_id = ak.id
      WHERE ak.tenant_id = $1 AND al.timestamp >= NOW() - INTERVAL '15 minutes'
      GROUP BY TO_CHAR(al.timestamp, 'HH24:MI')
      ORDER BY minute ASC
    `;
    const result = await dbPool.query(queryText, [tenantId]);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching analytics:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Fallback to serving the UI
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Gateway API Service running on port ${PORT}`);
});
