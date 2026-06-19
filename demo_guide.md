# 15-Minute Technical Demo Guide & Talk Track
## Multi-Tenant API Key Gateway with Rate Limiting & Rotation

Use this guide as a structured walkthrough during your live 15-minute presentation. It is designed to showcase the system architecture, code quality, rate-limiting mathematics, key management, and the interactive developer console.

---

### Part 1: Introduction & Architecture (3 Minutes)
- **What to say**: 
  - Introduce the core problem: SaaS public APIs (like Stripe, Twilio) require highly secure, low-latency API credential management, token security, and strict rate limits.
  - Explain the containerized stack: Node.js Express API service, PostgreSQL for persistent storage, and Redis for high-speed rate-limit check queues.
  - Highlight the core security principle: API keys are treated like passwords. We never store them in plaintext; they are generated securely, and only their SHA-256 cryptographic hashes are stored.
  - Showcase the schema design: `tenants`, `api_keys`, and `audit_logs` tables.

---

### Part 2: Code Architecture & Algorithms (5 Minutes)
- **What to show**: Open your IDE and show the following code snippets.
- **Key Hashing & Generation** (`utils/crypto.js`):
  - Show the secure random generator prepending the `sk_live_` prefix and encoding to URL-safe Base64.
  - Show the SHA-256 hashing.
- **Sliding-Window Rate Limiting** (`middleware/rateLimiter.js`):
  - Explain why sliding window log is superior to fixed window (prevents traffic bursts at the boundary).
  - Walk through the Redis sorted set commands inside the transaction:
    1. `ZREMRANGEBYSCORE`: Removes logs older than 60 seconds to keep the memory footprint clean.
    2. `ZADD`: Inserts a unique entry (timestamp + UUID) representing the current request.
    3. `ZCARD`: Returns the count of requests in the active 60-second window.
  - Show how `Retry-After` is calculated using the oldest request timestamp in the set.
- **Authentication Middleware** (`middleware/auth.js`):
  - Show the SQL verification check, explaining how the query allows active keys and handles keys during their rotation grace period:
    ```sql
    WHERE is_active = true AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
    ```
- **Key Rotation Endpoint** (`server.js`):
  - Show how rotating a key generates a new key and schedules the old key to expire in 1 minute by setting `expires_at = NOW() + INTERVAL '1 minute'`.

---

### Part 3: Live Developer Console & Sandbox Demo (5 Minutes)
- **What to do**: Open the browser console at `http://localhost:3000`.
- **Tenant Management**:
  - Show the tenant dropdown selector. Choose "Acme Corp".
- **Key Creation**:
  - Click **Create API Key**. Enter a low rate limit (e.g., `5` requests per minute) for testing.
  - Copy the generated plaintext key. Highlight the security warning: "This key is shown only once."
- **Sandbox Testing**:
  - Paste the key into the **Gateway Sandbox** test input.
  - Click **Send Request** 5 times in quick succession. Show the status `200 OK` responses appearing in the console.
  - Click a 6th time. Show the `429 Too Many Requests` response appearing, along with the `Retry-After` countdown.
  - Scroll down to the **Audit Logs** and show that all requests (both successful `200`s and rate-limited `429`s) were logged correctly.
- **Key Rotation**:
  - Click **Rotate** on the key. Copy the new key.
  - Send sandbox requests using both the old key and new key to demonstrate they both work during the grace period.
- **Immediate Revocation**:
  - Click **Revoke** on the old key. Show that requests using the old key now immediately return `401 Unauthorized` while the new key remains active.

---

### Part 4: Automated Test Runner & Q&A (2 Minutes)
- **What to do**: 
  - Run the terminal command `node test-docker.js`.
  - Explain that this automated test suite validates the gateway's entire API contract including rate-limiting status codes, body response keys, and headers.
  - Conclude the presentation and invite questions about Redis sorted set usage or security practices.
