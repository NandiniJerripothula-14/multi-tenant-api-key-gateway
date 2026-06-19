// Mock Database and Redis services for local execution/testing without Docker

const crypto = require('crypto');

// In-memory tables
const tenants = [
  { id: 1, name: 'Acme Corp', created_at: new Date() }
];

const apiKeys = [];
let keyIdCounter = 1;

const auditLogs = [];
let logIdCounter = 1;

// Mock DB Pool
class MockDbPool {
  async connect() {
    console.log('Mock PostgreSQL connected');
    return this;
  }

  async query(text, params = []) {
    const cleanText = text.replace(/\s+/g, ' ').trim();

    // 1. SELECT * FROM tenants
    if (cleanText.includes('SELECT * FROM tenants ORDER BY id ASC')) {
      return { rows: tenants };
    }

    // 2. Check if tenant exists
    if (cleanText.includes('SELECT id FROM tenants WHERE id = $1')) {
      const tenant = tenants.find(t => t.id === parseInt(params[0]));
      return { rows: tenant ? [tenant] : [] };
    }

    // 3. Insert API Key (handles both initial and rotated keys)
    if (cleanText.includes('INSERT INTO api_keys')) {
      const [tenantId, keyHash, keyPrefix, lastFour, rateLimitPerMinute] = params;
      const newKey = {
        id: keyIdCounter++,
        tenant_id: parseInt(tenantId),
        key_hash: keyHash,
        key_prefix: keyPrefix,
        last_four: lastFour,
        rate_limit_per_minute: parseInt(rateLimitPerMinute),
        is_active: true,
        expires_at: null,
        created_at: new Date()
      };
      apiKeys.push(newKey);
      return { rows: [newKey] };
    }

    // 4. List keys for a tenant
    if (cleanText.includes('SELECT id, key_prefix, last_four, created_at, is_active, expires_at FROM api_keys')) {
      const tenantId = parseInt(params[0]);
      const filtered = apiKeys.filter(k => k.tenant_id === tenantId && k.is_active);
      return { rows: filtered };
    }

    // 5. Auth validation query
    if (cleanText.includes('SELECT ak.*, t.name as tenant_name FROM api_keys ak JOIN tenants t ON ak.tenant_id = t.id WHERE ak.key_hash = $1')) {
      const hashed = params[0];
      const match = apiKeys.find(k => {
        const isExpired = k.expires_at && new Date(k.expires_at) < new Date();
        return k.key_hash === hashed && k.is_active && !isExpired;
      });
      if (match) {
        const tenant = tenants.find(t => t.id === match.tenant_id);
        return {
          rows: [{
            ...match,
            tenant_name: tenant ? tenant.name : 'Unknown'
          }]
        };
      }
      return { rows: [] };
    }

    // 6. Revoke key
    if (cleanText.includes('UPDATE api_keys SET is_active = false WHERE id = $1')) {
      const keyId = parseInt(params[0]);
      const key = apiKeys.find(k => k.id === keyId);
      if (key) {
        key.is_active = false;
      }
      return { rows: [] };
    }

    // 7. Get key by ID
    if (cleanText.includes('SELECT * FROM api_keys WHERE id = $1 AND is_active = true')) {
      const keyId = parseInt(params[0]);
      const key = apiKeys.find(k => k.id === keyId && k.is_active);
      return { rows: key ? [key] : [] };
    }

    // 9. Update key expires_at for rotation
    if (cleanText.includes('UPDATE api_keys SET expires_at = NOW() + INTERVAL \'1 minute\' WHERE id = $1')) {
      const keyId = parseInt(params[0]);
      const key = apiKeys.find(k => k.id === keyId);
      if (key) {
        key.expires_at = new Date(Date.now() + 60 * 1000);
      }
      return { rows: [] };
    }

    // 10. Insert audit log
    if (cleanText.includes('INSERT INTO audit_logs (api_key_id, endpoint, status_code)')) {
      const [apiKeyId, endpoint, statusCode] = params;
      const log = {
        id: logIdCounter++,
        api_key_id: parseInt(apiKeyId),
        endpoint: endpoint,
        status_code: parseInt(statusCode),
        timestamp: new Date()
      };
      auditLogs.push(log);
      return { rows: [log] };
    }

    // 11. Count audit logs
    if (cleanText.includes('SELECT COUNT(*) FROM audit_logs')) {
      const tenantId = parseInt(params[0]);
      const tenantKeys = apiKeys.filter(k => k.tenant_id === tenantId).map(k => k.id);
      const count = auditLogs.filter(l => tenantKeys.includes(l.api_key_id)).length;
      return { rows: [{ count: count.toString() }] };
    }

    // 12. Fetch audit logs
    if (cleanText.includes('SELECT al.id, al.endpoint, al.status_code, al.timestamp, ak.key_prefix, ak.last_four')) {
      const tenantId = parseInt(params[0]);
      const limit = parseInt(params[1]);
      const offset = parseInt(params[2]);

      const tenantKeys = apiKeys.filter(k => k.tenant_id === tenantId);
      const tenantKeyIds = tenantKeys.map(k => k.id);
      
      const filteredLogs = auditLogs
        .filter(l => tenantKeyIds.includes(l.api_key_id))
        .map(l => {
          const key = tenantKeys.find(k => k.id === l.api_key_id);
          return {
            id: l.id,
            endpoint: l.endpoint,
            status_code: l.status_code,
            timestamp: l.timestamp,
            key_prefix: key ? key.key_prefix : 'sk_live_',
            last_four: key ? key.last_four : 'xxxx'
          };
        })
        .sort((a, b) => b.timestamp - a.timestamp);

      const sliced = filteredLogs.slice(offset, offset + limit);
      return { rows: sliced };
    }

    // 13. Fetch analytics
    if (cleanText.includes('SELECT TO_CHAR(al.timestamp, \'HH24:MI\') as minute')) {
      const tenantId = parseInt(params[0]);
      const tenantKeys = apiKeys.filter(k => k.tenant_id === tenantId);
      const tenantKeyIds = tenantKeys.map(k => k.id);

      const cutoff = new Date(Date.now() - 15 * 60 * 1000);
      const logs = auditLogs.filter(l => tenantKeyIds.includes(l.api_key_id) && l.timestamp >= cutoff);

      const minuteMap = {};
      logs.forEach(l => {
        const minStr = l.timestamp.toTimeString().substring(0, 5); // "HH:MM"
        if (!minuteMap[minStr]) {
          minuteMap[minStr] = { minute: minStr, success: 0, blocked: 0 };
        }
        if (l.status_code === 200) {
          minuteMap[minStr].success++;
        } else if (l.status_code === 429) {
          minuteMap[minStr].blocked++;
        }
      });

      const rows = Object.values(minuteMap).sort((a, b) => a.minute.localeCompare(b.minute));
      return { rows };
    }

    throw new Error(`Unhandled mock query: ${text}`);
  }
}

// Mock Redis Client
class MockRedisClient {
  constructor() {
    this.sets = new Map(); // key -> array of { score, value }
  }

  on(event, callback) {
    // Event listener stub
  }

  async connect() {
    console.log('Mock Redis connected');
    return this;
  }

  // Helper: clean set by removing scores
  zRemRangeByScoreSync(key, min, max) {
    let arr = this.sets.get(key) || [];
    const beforeLen = arr.length;
    arr = arr.filter(item => item.score < min || item.score > max);
    this.sets.set(key, arr);
    return beforeLen - arr.length;
  }

  zAddSync(key, score, value) {
    let arr = this.sets.get(key) || [];
    // remove duplicate if exists
    arr = arr.filter(item => item.value !== value);
    arr.push({ score, value });
    arr.sort((a, b) => a.score - b.score);
    this.sets.set(key, arr);
    return 1;
  }

  zCardSync(key) {
    const arr = this.sets.get(key) || [];
    return arr.length;
  }

  zRangeWithScoresSync(key, start, end) {
    const arr = this.sets.get(key) || [];
    const sliced = arr.slice(start, end === -1 ? undefined : end + 1);
    return sliced;
  }

  async zRem(key, value) {
    let arr = this.sets.get(key) || [];
    const beforeLen = arr.length;
    arr = arr.filter(item => item.value !== value);
    this.sets.set(key, arr);
    return beforeLen - arr.length;
  }

  multi() {
    const transaction = [];
    const client = this;

    const builder = {
      zRemRangeByScore: (key, min, max) => {
        transaction.push(() => client.zRemRangeByScoreSync(key, min, max));
        return builder;
      },
      zAdd: (key, obj) => {
        transaction.push(() => client.zAddSync(key, obj.score, obj.value));
        return builder;
      },
      zCard: (key) => {
        transaction.push(() => client.zCardSync(key));
        return builder;
      },
      zRangeWithScores: (key, start, end) => {
        transaction.push(() => client.zRangeWithScoresSync(key, start, end));
        return builder;
      },
      expire: (key, seconds) => {
        transaction.push(() => true);
        return builder;
      },
      exec: async () => {
        const results = [];
        for (const op of transaction) {
          results.push(op());
        }
        return results;
      }
    };

    return builder;
  }
}

module.exports = {
  MockDbPool,
  MockRedisClient
};
