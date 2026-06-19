const crypto = require('crypto');

/**
 * Sliding Window Rate Limiter using Redis sorted sets.
 * This middleware runs AFTER the auth middleware (which attaches req.tenant and req.apiKey).
 */
function createRateLimiter(redisClient, dbPool) {
  return async (req, res, next) => {
    if (!req.apiKeyRecord) {
      return res.status(500).json({ error: 'Auth record missing in request' });
    }

    const { id: apiKeyId, rate_limit_per_minute } = req.apiKeyRecord;
    const redisKey = `rate_limit:${apiKeyId}`;
    const now = Date.now();
    const windowMs = 60000; // 60 seconds
    const minTime = now - windowMs;
    const member = `${now}:${crypto.randomUUID()}`;

    try {
      // Execute Redis transaction
      const results = await redisClient.multi()
        .zRemRangeByScore(redisKey, 0, minTime)
        .zAdd(redisKey, { score: now, value: member })
        .zCard(redisKey)
        .zRangeWithScores(redisKey, 0, 0)
        .expire(redisKey, 60)
        .exec();

      // results: [removedCount, addedCount, totalCount, oldestArray, expireStatus]
      const totalCount = results[2];
      const oldestArray = results[3];

      if (totalCount > rate_limit_per_minute) {
        // Remove the member we just added because this request is rate-limited and shouldn't consume quota
        await redisClient.zRem(redisKey, member);

        // Calculate Retry-After header
        let retryAfter = 1; // Fallback to 1 second
        if (oldestArray && oldestArray.length > 0) {
          const oldestScore = oldestArray[0].score;
          const timeUntilExpiryMs = (oldestScore + windowMs) - now;
          retryAfter = Math.ceil(timeUntilExpiryMs / 1000);
          if (retryAfter < 1) retryAfter = 1;
        }

        res.setHeader('Retry-After', retryAfter);
        
        // Log the rate-limited request in the database
        try {
          await dbPool.query(
            'INSERT INTO audit_logs (api_key_id, endpoint, status_code) VALUES ($1, $2, $3)',
            [apiKeyId, req.path, 429]
          );
        } catch (dbErr) {
          console.error('Audit Log Insertion Error (429):', dbErr);
        }

        return res.status(429).json({ error: 'Too Many Requests' });
      }

      next();
    } catch (err) {
      console.error('Rate Limiter Error:', err);
      // Fail open or fail closed? Standard is usually fail closed or open. Let's return 500 for safety or pass error.
      return res.status(500).json({ error: 'Internal Server Error in Rate Limiter' });
    }
  };
}

module.exports = {
  createRateLimiter
};
