// Verification script to test the Docker deployment of the API gateway

const http = require('http');

// Helper to make HTTP requests
function makeRequest(method, path, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: 3000,
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        let parsed = null;
        try {
          parsed = JSON.parse(data);
        } catch (e) {
          parsed = data;
        }
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: parsed
        });
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function runTests() {
  console.log('\n--- Starting Docker API Gateway Verification Tests ---\n');

  try {
    // 1. Fetch Tenants (Seeded data verification)
    console.log('Testing GET /api/tenants...');
    const tenantsRes = await makeRequest('GET', '/api/tenants');
    if (tenantsRes.statusCode !== 200 || tenantsRes.body[0].name !== 'Acme Corp') {
      throw new Error(`Failed to fetch seeded tenant: ${JSON.stringify(tenantsRes)}`);
    }
    console.log('✔ GET /api/tenants verified.\n');

    const tenantId = 1;

    // 2. Issue API Key
    console.log(`Testing POST /api/tenants/${tenantId}/keys (Issue API Key)...`);
    const issueRes = await makeRequest('POST', `/api/tenants/${tenantId}/keys`, {}, { rateLimitPerMinute: 5 });
    if (issueRes.statusCode !== 201) {
      throw new Error(`Failed to issue key: ${JSON.stringify(issueRes)}`);
    }
    const { apiKey, keyRecord } = issueRes.body;
    if (!apiKey.startsWith('sk_live_') || typeof keyRecord.id !== 'number' || keyRecord.rateLimitPerMinute !== 5) {
      throw new Error(`Invalid issue key response payload: ${JSON.stringify(issueRes.body)}`);
    }
    console.log('✔ POST /api/tenants/:tenantId/keys verified.');
    console.log(`  Hashed key suffix: ...${keyRecord.lastFour}\n`);

    // 3. List API Keys
    console.log(`Testing GET /api/tenants/${tenantId}/keys (List API Keys)...`);
    const listRes = await makeRequest('GET', `/api/tenants/${tenantId}/keys`);
    if (listRes.statusCode !== 200 || !Array.isArray(listRes.body) || listRes.body.length === 0) {
      throw new Error(`Failed to list keys: ${JSON.stringify(listRes)}`);
    }
    const foundKey = listRes.body.find(k => k.id === keyRecord.id);
    if (!foundKey || !foundKey.maskedKey.startsWith('sk_live_...') || foundKey.isActive !== true) {
      throw new Error(`Invalid listed key format: ${JSON.stringify(listRes.body)}`);
    }
    console.log('✔ GET /api/tenants/:tenantId/keys verified.\n');

    // 4. Protected Route - Successful Authentication
    console.log('Testing GET /api/protected (Success case)...');
    const authRes = await makeRequest('GET', '/api/protected', { Authorization: `Bearer ${apiKey}` });
    if (authRes.statusCode !== 200 || authRes.body.message !== 'Success! Access granted to protected endpoint.') {
      throw new Error(`Authentication failed: ${JSON.stringify(authRes)}`);
    }
    console.log('✔ GET /api/protected authenticated successfully.\n');

    // 5. Protected Route - Failure Cases (Missing & Invalid Token)
    console.log('Testing GET /api/protected (Missing token)...');
    const missingRes = await makeRequest('GET', '/api/protected');
    if (missingRes.statusCode !== 401) {
      throw new Error(`Missing token did not return 401: ${JSON.stringify(missingRes)}`);
    }
    console.log('✔ GET /api/protected (Missing token) returned 401.');

    console.log('Testing GET /api/protected (Invalid token)...');
    const invalidRes = await makeRequest('GET', '/api/protected', { Authorization: 'Bearer sk_live_invalidtoken' });
    if (invalidRes.statusCode !== 401) {
      throw new Error(`Invalid token did not return 401: ${JSON.stringify(invalidRes)}`);
    }
    console.log('✔ GET /api/protected (Invalid token) returned 401.\n');

    // 6. Sliding Window Rate Limiting (Limit is set to 5 per minute)
    console.log('Testing Rate Limiting (5 requests per minute)...');
    // We already made 1 request above, let's make 4 more (making total 5 within current minute)
    for (let i = 2; i <= 5; i++) {
      const res = await makeRequest('GET', '/api/protected', { Authorization: `Bearer ${apiKey}` });
      if (res.statusCode !== 200) {
        throw new Error(`Request #${i} unexpectedly failed with status ${res.statusCode}: ${JSON.stringify(res)}`);
      }
    }
    console.log('✔ Sent 5 successful requests within the sliding window.');

    // The 6th request should fail with 429 and include Retry-After header
    console.log('Testing 6th request (should trigger 429)...');
    const rateLimitRes = await makeRequest('GET', '/api/protected', { Authorization: `Bearer ${apiKey}` });
    if (rateLimitRes.statusCode !== 429) {
      throw new Error(`6th request did not return 429. Returned: ${rateLimitRes.statusCode}`);
    }
    const retryAfter = rateLimitRes.headers['retry-after'];
    if (!retryAfter || isNaN(parseInt(retryAfter))) {
      throw new Error(`Missing or invalid Retry-After header: ${JSON.stringify(rateLimitRes.headers)}`);
    }
    console.log(`✔ 6th request returned 429. Retry-After header: ${retryAfter} seconds.\n`);

    // 7. API Key Rotation
    console.log('Issuing a fresh key to test rotation...');
    const freshKeyRes = await makeRequest('POST', `/api/tenants/${tenantId}/keys`, {}, { rateLimitPerMinute: 100 });
    const keyToRotate = freshKeyRes.body.keyRecord;
    const keyToRotatePlain = freshKeyRes.body.apiKey;

    console.log(`Testing POST /api/keys/${keyToRotate.id}/rotate (Key Rotation)...`);
    const rotateRes = await makeRequest('POST', `/api/keys/${keyToRotate.id}/rotate`);
    if (rotateRes.statusCode !== 200 || !rotateRes.body.newApiKey) {
      throw new Error(`Failed to rotate key: ${JSON.stringify(rotateRes)}`);
    }
    const newApiKey = rotateRes.body.newApiKey;
    console.log('✔ Key rotation succeeded.');

    // Immediately test BOTH keys are valid (grace period)
    console.log('Testing both keys during grace period...');
    const testOldKeyRes = await makeRequest('GET', '/api/protected', { Authorization: `Bearer ${keyToRotatePlain}` });
    const testNewKeyRes = await makeRequest('GET', '/api/protected', { Authorization: `Bearer ${newApiKey}` });
    if (testOldKeyRes.statusCode !== 200 || testNewKeyRes.statusCode !== 200) {
      throw new Error(`Grace period failure. Old Key status: ${testOldKeyRes.statusCode}, New Key status: ${testNewKeyRes.statusCode}`);
    }
    console.log('✔ Both old and new keys valid during grace period.\n');

    // 8. API Key Revocation
    console.log(`Testing DELETE /api/keys/${keyToRotate.id} (Immediate Revocation)...`);
    const revokeRes = await makeRequest('DELETE', `/api/keys/${keyToRotate.id}`);
    if (revokeRes.statusCode !== 204) {
      throw new Error(`Failed to revoke key: ${JSON.stringify(revokeRes)}`);
    }
    console.log('✔ DELETE /api/keys/:keyId returned 204 No Content.');

    // Old key must now immediately return 401
    const testRevokedRes = await makeRequest('GET', '/api/protected', { Authorization: `Bearer ${keyToRotatePlain}` });
    if (testRevokedRes.statusCode !== 401) {
      throw new Error(`Revoked key still accessible: ${JSON.stringify(testRevokedRes)}`);
    }
    console.log('✔ Revoked key returned 401 Unauthorized.\n');

    console.log('🎉 ALL DOCKER GATEWAY VERIFICATION TESTS PASSED SUCCESSFULLY!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Docker verification test failed:', err);
    process.exit(1);
  }
}

runTests();
