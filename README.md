# Multi-Tenant API Key Gateway with Rate Limiting and Rotation

A secure, multi-tenant API key management gateway built from scratch featuring a sliding-window log rate limiter implemented via Redis sorted sets, SHA-256 API key hashing, key rotation with grace periods, and an interactive developer console.

---

## Key Features

1. **Sliding-Window Rate Limiter**: 
   - Implemented from first principles using Redis sorted sets (ZREMRANGEBYSCORE, ZADD, ZCARD, ZRANGE) inside atomic transactions.
   - Accurately blocks requests exceeding quota and responds with `429 Too Many Requests` along with a precise `Retry-After` header.
2. **Secure Key Lifecycle Management**:
   - Keys are generated securely and stored using SHA-256 hashing. Plaintext keys are shown only once upon generation.
   - Supports immediate key revocation and API key rotation with a 1-minute concurrent validity grace period.
3. **Interactive Developer Console**:
   - Vibrant dark-mode UI with live Chart.js traffic visualization, credential management actions (Create, Rotate, Revoke), an audit logging table, and an built-in sandbox request runner to test rate-limiting features interactively.
4. **Audit Logs & Telemetry**:
   - Records all authenticated requests to a PostgreSQL table (`audit_logs`) including endpoint, status code, and api key identifiers.

---

## Tech Stack

- **Backend**: Express.js (Node.js)
- **Database**: PostgreSQL (Persistent storage for tenants, hashed keys, and audit logs)
- **Cache**: Redis (Fast sliding-window rate limit store)
- **Frontend**: Single Page Dashboard (HTML5, Vanilla CSS, JS, Chart.js)
- **Containerization**: Docker & Docker Compose

---

## Project Structure

```text
├── db/
│   └── init.sql                 # Database schema initialization and seeding script
├── middleware/
│   ├── auth.js                  # Bearer token validation and key verification
│   └── rateLimiter.js           # Sliding window rate limiter using Redis
├── public/
│   └── index.html               # Developer console UI
├── utils/
│   ├── crypto.js                # Secure random key generation & SHA-256 hashing
│   └── mockServices.js          # In-memory mock database and Redis client for test runs
├── Dockerfile                   # Docker configuration for Express API gateway
├── docker-compose.yml           # Orchestration for PostgreSQL, Redis, and Gateway API
├── server.js                    # Express application setup and routes
├── test-gateway.js              # Verification test runner using in-memory mock services
└── test-docker.js               # Integration test runner targeting live Docker services
```

---

## Getting Started

### Prerequisites
- Docker and Docker Compose installed and running on your system.

### Option A: Run using Docker (Recommended)
1. Build and launch the containerized stack:
   ```bash
   docker-compose up --build -d
   ```
2. Once the services are healthy, open the developer console in your browser:
   - **Console URL**: `http://localhost:3000`
3. Verify the endpoints using the integration test runner:
   ```bash
   node test-docker.js
   ```

### Option B: Local Mock Mode (Without Docker)
1. Install dependencies locally:
   ```bash
   npm install
   ```
2. Start the test suite which boots the application in mocked configuration:
   ```bash
   node test-gateway.js
   ```

---

## API Documentation

### 1. Issue a New API Key
- **Endpoint**: `POST /api/tenants/:tenantId/keys`
- **Request Body**:
  ```json
  {
    "rateLimitPerMinute": 100
  }
  ```
- **Response (201 Created)**:
  ```json
  {
    "apiKey": "sk_live_...",
    "keyRecord": {
      "id": 1,
      "lastFour": "abcd",
      "rateLimitPerMinute": 100
    }
  }
  ```

### 2. List API Keys (Masked)
- **Endpoint**: `GET /api/tenants/:tenantId/keys`
- **Response (200 OK)**:
  ```json
  [
    {
      "id": 1,
      "maskedKey": "sk_live_...abcd",
      "createdAt": "2026-06-16T10:45:00.000Z",
      "isActive": true
    }
  ]
  ```

### 3. API Key Rotation (1 min Grace Period)
- **Endpoint**: `POST /api/keys/:keyId/rotate`
- **Response (200 OK)**:
  ```json
  {
    "newApiKey": "sk_live_..."
  }
  ```

### 4. Immediate Key Revocation
- **Endpoint**: `DELETE /api/keys/:keyId`
- **Response**: `204 No Content`

### 5. Protected Endpoint
- **Endpoint**: `GET /api/protected`
- **Header**: `Authorization: Bearer <valid_api_key>`
- **Response (200 OK)**:
  ```json
  {
    "message": "Success! Access granted to protected endpoint.",
    "tenant": { "id": 1, "name": "Acme Corp" }
  }
  ```
