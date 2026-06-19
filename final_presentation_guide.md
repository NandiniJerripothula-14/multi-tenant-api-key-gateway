# Master Presentation Guide: Multi-Tenant API Key Gateway
## A Comprehensive 15-Minute Technical Demo Script & Reference Manual

This document provides a complete, cohesive talk track and technical explanation for your video demo. Use this as your step-by-step master script.

---

## 1. What the Task is About (Overview & Objective)

### **The Problem Statement**
Modern SaaS platforms (like Stripe, Twilio, and AWS) expose public APIs to developers. The gateway to these APIs is the API key. Managing API keys securely is highly complex. A simple mistake can lead to credential theft, resource abuse, server overload, and terrible developer experiences.

### **The Project Goal**
Our objective is to build a standalone, secure **Multi-Tenant API Key Gateway** from scratch. 
We must support:
1. **Multi-Tenancy**: Multiple organizations managing their own credentials independently.
2. **Secure Generation & Storage**: Creating high-entropy credentials and storing them using SHA-256 (no plaintext storage).
3. **Sliding-Window Rate Limiting**: Building a rolling-window traffic manager from first principles using Redis sorted sets (without libraries).
4. **Key Rotation & Revocation**: Allowing credentials to be rotated smoothly with a 1-minute grace period to prevent API downtime.
5. **Interactive Telemetry Dashboard**: A developer console showing live statistics, paginated logs, and a request tester sandbox.

---

## 2. Technical Approach & Architecture

### **The Technology Stack**
*   **API Gateway**: Node.js and Express.js (selected for asynchronous, non-blocking I/O).
*   **Database**: PostgreSQL (relational structure for strict foreign key constraints and transactional integrity).
*   **In-Memory Store**: Redis (sub-millisecond lookups for rate limiting).
*   **Frontend**: Single Page Application served by Express (HTML5, Vanilla CSS, JS, Chart.js).
*   **Containerization**: Docker Compose orchestrating database, cache, and backend with custom healthchecks to resolve initialization race conditions.

### **Database Schema**
```sql
-- Tenants Table (Profile isolation)
CREATE TABLE tenants (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- API Keys Table (Metadata & Hashed Credentials)
CREATE TABLE api_keys (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    key_hash VARCHAR(255) NOT NULL UNIQUE,
    key_prefix VARCHAR(10) NOT NULL,
    last_four VARCHAR(4) NOT NULL,
    rate_limit_per_minute INTEGER NOT NULL DEFAULT 100,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    expires_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Audit Logs Table (Full Telemetry Trail)
CREATE TABLE audit_logs (
    id SERIAL PRIMARY KEY,
    api_key_id INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
    endpoint VARCHAR(255) NOT NULL,
    status_code INTEGER NOT NULL,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### **Sliding-Window Log vs. Alternative Algorithms**
*   **Fixed Window** reset models suffer from "boundary bursting"—letting twice the quota through near boundary edges. 
*   **Sliding Window Log** tracks every single request timestamp. We model this Rolling Log using a **Redis Sorted Set (ZSet)**:
    *   *Score*: Unix timestamp (milliseconds).
    *   *Member*: `timestamp:UUID` (to ensure uniqueness if two requests hit at the exact same millisecond).
    *   *Slicing*: On every request, we drop outdated logs using `ZREMRANGEBYSCORE` and measure the remaining set cardinality with `ZCARD`.

---

## 3. Code Walkthrough (Step-by-Step)

### **Part A: Cryptographic Utilities**
Show the file: **[utils/crypto.js](file:///c:/Users/jerri/multi-tenant-api-key-gateway/utils/crypto.js)**
*   **Key Generation**: We use Node's `crypto.randomBytes(32)` to generate 256 bits of entropy, formatted as URL-safe Base64.
*   **Stripe-Style Prefixes**: We prepend `sk_live_`. This allows secret scanning engines (like GitHub Secret Scanning) to automatically detect and flag accidentally committed keys.
*   **SHA-256 Hashing**: We hash keys before storing them. Plaintext is returned once and discarded.

### **Part B: Authentication Middleware**
Show the file: **[middleware/auth.js](file:///c:/Users/jerri/multi-tenant-api-key-gateway/middleware/auth.js)**
*   Extracts Bearer token from the `Authorization` header.
*   Hashes it and queries the PostgreSQL database.
*   The query handles rotation grace periods by checking:
    ```sql
    WHERE key_hash = $1 
      AND is_active = true 
      AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
    ```

### **Part C: Sliding-Window Rate Limiter**
Show the file: **[middleware/rateLimiter.js](file:///c:/Users/jerri/multi-tenant-api-key-gateway/middleware/rateLimiter.js)**
*   Executes in a single atomic transaction block (`redisClient.multi()`) to prevent concurrency race conditions:
    1.  `ZREMRANGEBYSCORE` removes timestamps older than 60 seconds (`now - 60000`).
    2.  `ZADD` appends the current request member.
    3.  `ZCARD` counts remaining active requests.
    4.  `EXPIRE` sets a 60-second TTL on the rate limit key to release memory for inactive clients.
*   If blocked, it fetches the oldest timestamp via `ZRANGE` to calculate the precise seconds the client needs to wait, setting the `Retry-After` header.

### **Part D: Rotation Logic**
Show the file: **[server.js](file:///c:/Users/jerri/multi-tenant-api-key-gateway/server.js)** (at `POST /api/keys/:keyId/rotate`)
*   Inserts a new API key record with the same settings.
*   Updates the old key's expiration: `expires_at = NOW() + INTERVAL '1 minute'`.
*   This creates a 1-minute overlap where both keys work seamlessly, preventing downtime.

---

## 4. Live Console Demonstration (Talk Track)

*(Open the Developer Console at `http://localhost:3000`)*

1.  **Overview**: Point out the dashboard metrics (Active Keys, Requests, Blocked Counts) and the live traffic volume chart (Chart.js).
2.  **Creation**: Click "Create API Key", set a rate limit of **5 requests/minute**, copy the plaintext key, and note the warning modal.
3.  **Sandbox Rate Limiting**: Paste the key into the Sandbox and click "Send Request".
    *   Requests 1-5 return `200 OK`.
    *   Request 6 immediately returns `429 Too Many Requests` with a dynamic `Retry-After` header.
    *   Show that both `200` and `429` requests were successfully logged in the **Audit Logs** table below.
4.  **Rotation & Revocation**:
    *   Click "Rotate" on the key. Copy the new key.
    *   Show that both work during the 1-minute window.
    *   Click "Revoke" on the old key and show it immediately returns `401 Unauthorized` in the sandbox.

---

## 5. Conclusion & Verification

### **Automated Verification**
We verify our gateway's API contract using automated tests:
*   Mock Mode verification: `node test-gateway.js`
*   Live Docker verification: `node test-docker.js`
All tests pass successfully, validating:
- Database schema and seed population
- Correct key hashing and prefixing
- Transactional sliding-window rate limit checks (succeeding at limit, blocking at limit + 1)
- Grace-period key rotation
- Immediate key revocation

### **Production Scaling Strategy**
To transition this prototype into a production-grade system:
1.  **Read-Through Cache**: Cache active key hashes in Redis with a 5-minute TTL to bypass PostgreSQL queries on every single request.
2.  **Database Partitioning**: Declaratively partition the `audit_logs` table by date range (e.g., weekly tables) so old logs can be archived or dropped instantly.
3.  **PgBouncer Connection Pooler**: Prevent Node from exhausting database connection limits under high concurrency.
