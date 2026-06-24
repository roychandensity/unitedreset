const express = require('express');
const jwt = require('jsonwebtoken');
const cookie = require('cookie');
const crypto = require('crypto');
const { Redis } = require('@upstash/redis');
const path = require('path');

const app = express();

const redisUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const redisToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const redis = redisUrl && redisToken ? new Redis({
  url: redisUrl,
  token: redisToken,
}) : null;

const JWT_SECRET = process.env.SESSION_SECRET;
const DENSITY_API_TOKEN = process.env.DENSITY_API_KEY || process.env.DENSITY_API_TOKEN;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function parseList(value) {
  return (value || '').split(',').map(s => s.trim()).filter(Boolean);
}

const LOUNGES = {
  b6: {
    slug: 'b6',
    name: 'United Lounge B6',
    path: '',
    cookieName: 'auth',
    cookiePath: '/',
    password: process.env.B6_APP_PASSWORD || process.env.APP_PASSWORD,
    spaceIds: parseList(process.env.B6_SPACE_IDS || process.env.SPACE_IDS),
    useLegacyRedisKeys: true,
  },
  'iah-c-north': {
    slug: 'iah-c-north',
    name: 'United IAH C-North',
    path: '/iah-c-north',
    cookieName: 'auth_iah_c_north',
    cookiePath: '/iah-c-north',
    password: process.env.IAH_CNORTH_APP_PASSWORD || process.env.IAH_CNORTH_PASSWORD || 'unitediah',
    spaceIds: parseList(process.env.IAH_CNORTH_SPACE_IDS || 'spc_1560021226523460540'),
    useLegacyRedisKeys: false,
  },
};

function getLoungeFromPath(pathname) {
  if (pathname === '/iah-c-north' || pathname.startsWith('/iah-c-north/')) {
    return LOUNGES['iah-c-north'];
  }
  return LOUNGES.b6;
}

function attachLounge(req, res, next) {
  req.lounge = getLoungeFromPath(req.path);
  next();
}

function getSpaceIds(lounge) {
  return lounge.spaceIds;
}

function redisKey(lounge, key) {
  if (lounge.useLegacyRedisKeys) return key;
  return `lounge:${lounge.slug}:${key}`;
}

function requireRedis(res) {
  if (redis) return true;
  res.status(503).json({ error: 'Reset storage is unavailable' });
  return false;
}

// --- Usage tracking helpers ---
function getDateKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function hashIP(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';
  return crypto.createHash('sha256').update(ip).digest('hex').slice(0, 12);
}

async function trackEvent(req, action) {
  if (!redis) return;
  try {
    const lounge = req.lounge || LOUNGES.b6;
    const day = getDateKey();
    const userHash = hashIP(req);
    // Increment daily action counter
    await redis.hincrby(redisKey(lounge, `stats:${day}`), action, 1);
    // Track unique users per day
    await redis.sadd(redisKey(lounge, `stats:${day}:users`), userHash);
    // Append to recent activity log
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      action,
      user: userHash
    });
    await redis.lpush(redisKey(lounge, 'usage_log'), entry);
    await redis.ltrim(redisKey(lounge, 'usage_log'), 0, 499);
  } catch (err) {
    console.error('Usage tracking error:', err.message);
  }
}

// Parse auth from JWT cookie
function getAuth(req, lounge = req.lounge || LOUNGES.b6) {
  const cookies = cookie.parse(req.headers.cookie || '');
  const authCookie = cookies[lounge.cookieName];
  if (!authCookie) return null;
  try {
    const payload = jwt.verify(authCookie, JWT_SECRET);
    if (payload.lounge === lounge.slug) return payload;
    if (lounge.slug === 'b6' && payload.authenticated === true && !payload.lounge) return payload;
    return null;
  } catch {
    return null;
  }
}

function requireAuth(req, res, next) {
  if (getAuth(req)) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

app.use(attachLounge);

app.get('/density-logo.jpg', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'density-logo.jpg'));
});

// Login page (served for unauthenticated users)
app.get(['/', '/iah-c-north', '/iah-c-north/'], (req, res, next) => {
  if (getAuth(req)) return next();
  res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
});

// Login endpoint
app.post(['/login', '/iah-c-north/login'], async (req, res) => {
  const { password } = req.body;
  const lounge = req.lounge;
  if (password === lounge.password) {
    await trackEvent(req, 'login');
    const token = jwt.sign({ authenticated: true, lounge: lounge.slug }, JWT_SECRET, { expiresIn: '24h' });
    res.setHeader('Set-Cookie', cookie.serialize(lounge.cookieName, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 86400,
      path: lounge.cookiePath
    }));
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

// Logout
app.post(['/logout', '/iah-c-north/logout'], (req, res) => {
  const lounge = req.lounge;
  res.setHeader('Set-Cookie', cookie.serialize(lounge.cookieName, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 0,
    path: lounge.cookiePath
  }));
  res.json({ success: true });
});

// Dashboard page (served for authenticated users)
app.get(['/', '/iah-c-north', '/iah-c-north/'], requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.get(['/api/config', '/iah-c-north/api/config'], requireAuth, (req, res) => {
  res.json({
    slug: req.lounge.slug,
    name: req.lounge.name,
    path: req.lounge.path,
  });
});

// Proxy: get space details from Density (tracks as page_view since it's called on initial load)
app.get(['/api/spaces', '/iah-c-north/api/spaces'], requireAuth, async (req, res) => {
  await trackEvent(req, 'page_view');
  try {
    const spaceIds = getSpaceIds(req.lounge);
    const response = await fetch('https://api.density.io/v3/spaces', {
      headers: { 'Authorization': `Bearer ${DENSITY_API_TOKEN}` }
    });

    if (!response.ok) {
      throw new Error(`Density API returned ${response.status}`);
    }

    const data = await response.json();
    const allSpaces = Array.isArray(data) ? data : (data.results || []);
    const filtered = allSpaces.filter(s => spaceIds.includes(s.id));

    res.json(filtered);
  } catch (err) {
    console.error('Error fetching spaces:', err.message);
    res.status(502).json({ error: 'Failed to fetch space data' });
  }
});

// Proxy: get current occupancy from Density
app.get(['/api/occupancy', '/iah-c-north/api/occupancy'], requireAuth, async (req, res) => {
  try {
    const spaceIds = getSpaceIds(req.lounge);
    const response = await fetch('https://api.density.io/v3/analytics/occupancy/current', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DENSITY_API_TOKEN}`
      },
      body: JSON.stringify({ space_ids: spaceIds })
    });

    if (!response.ok) {
      throw new Error(`Density API returned ${response.status}`);
    }

    const data = await response.json();

    // Apply count offsets from Redis
    if (redis && data.data) {
      for (const spaceId of Object.keys(data.data)) {
        try {
          const offset = await redis.get(redisKey(req.lounge, `offset:${spaceId}`));
          if (offset !== null) {
            data.data[spaceId].count = Math.max(0, data.data[spaceId].count + Number(offset));
          }
        } catch (err) {
          console.error('Error fetching count offset:', err.message);
        }
      }
    }

    res.json(data);
  } catch (err) {
    console.error('Error fetching occupancy:', err.message);
    res.status(502).json({ error: 'Failed to fetch occupancy data' });
  }
});

// Set manual count override for a space
app.post(['/api/override', '/iah-c-north/api/override'], requireAuth, async (req, res) => {
  const { spaceId, newCount } = req.body;
  if (!spaceId || typeof newCount !== 'number') {
    return res.status(400).json({ error: 'spaceId and newCount (number) required' });
  }
  if (!getSpaceIds(req.lounge).includes(spaceId)) {
    return res.status(400).json({ error: 'spaceId is not configured for this lounge' });
  }
  if (!requireRedis(res)) return;

  try {
    const response = await fetch('https://api.density.io/v3/analytics/occupancy/current', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DENSITY_API_TOKEN}`
      },
      body: JSON.stringify({ space_ids: [spaceId] })
    });

    if (!response.ok) {
      throw new Error(`Density API returned ${response.status}`);
    }

    const data = await response.json();
    const currentCount = data.data[spaceId]?.count ?? 0;
    const offset = newCount - currentCount;

    await redis.set(redisKey(req.lounge, `offset:${spaceId}`), offset);
    await trackEvent(req, 'reset');

    // Log the override to history
    const logEntry = {
      timestamp: new Date().toISOString(),
      spaceId,
      previousCount: currentCount,
      newCount,
      action: 'override'
    };
    await redis.lpush(redisKey(req.lounge, 'reset_log'), JSON.stringify(logEntry));
    // Keep last 100 entries
    await redis.ltrim(redisKey(req.lounge, 'reset_log'), 0, 99);

    res.json({ success: true, densityCount: currentCount, newCount, offset });
  } catch (err) {
    console.error('Error setting override:', err.message);
    res.status(502).json({ error: 'Failed to set override' });
  }
});

// Clear override for a space
app.post(['/api/override/clear', '/iah-c-north/api/override/clear'], requireAuth, async (req, res) => {
  if (!requireRedis(res)) return;
  await trackEvent(req, 'clear');
  const { spaceId } = req.body;
  try {
    if (spaceId) {
      if (!getSpaceIds(req.lounge).includes(spaceId)) {
        return res.status(400).json({ error: 'spaceId is not configured for this lounge' });
      }
      await redis.del(redisKey(req.lounge, `offset:${spaceId}`));
      const logEntry = {
        timestamp: new Date().toISOString(),
        spaceId,
        action: 'clear'
      };
      await redis.lpush(redisKey(req.lounge, 'reset_log'), JSON.stringify(logEntry));
      await redis.ltrim(redisKey(req.lounge, 'reset_log'), 0, 99);
    } else {
      const spaceIds = getSpaceIds(req.lounge);
      for (const id of spaceIds) {
        await redis.del(redisKey(req.lounge, `offset:${id}`));
      }
      const logEntry = {
        timestamp: new Date().toISOString(),
        spaceId: 'all',
        action: 'clear'
      };
      await redis.lpush(redisKey(req.lounge, 'reset_log'), JSON.stringify(logEntry));
      await redis.ltrim(redisKey(req.lounge, 'reset_log'), 0, 99);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Error clearing override:', err.message);
    res.status(502).json({ error: 'Failed to clear override' });
  }
});

// Get reset history log
app.get(['/api/log', '/iah-c-north/api/log'], requireAuth, async (req, res) => {
  if (!redis) return res.json([]);
  try {
    const entries = await redis.lrange(redisKey(req.lounge, 'reset_log'), 0, 49);
    const parsed = entries.map(e => typeof e === 'string' ? JSON.parse(e) : e);
    res.json(parsed);
  } catch (err) {
    console.error('Error fetching log:', err.message);
    res.json([]);
  }
});

// Check if a space has an active override
app.get(['/api/override/status', '/iah-c-north/api/override/status'], requireAuth, async (req, res) => {
  try {
    const spaceIds = getSpaceIds(req.lounge);
    const statuses = {};
    if (!redis) {
      spaceIds.forEach(id => { statuses[id] = false; });
      return res.json(statuses);
    }
    for (const id of spaceIds) {
      try {
        const offset = await redis.get(redisKey(req.lounge, `offset:${id}`));
        statuses[id] = offset !== null;
      } catch (err) {
        console.error('Error fetching override status:', err.message);
        statuses[id] = false;
      }
    }
    res.json(statuses);
  } catch (err) {
    console.error('Error fetching override status:', err.message);
    res.status(500).json({ error: 'Failed to fetch override status' });
  }
});

// Usage stats endpoint
app.get(['/api/stats', '/iah-c-north/api/stats'], requireAuth, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const stats = [];

    for (let i = 0; i < days; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const day = d.toISOString().slice(0, 10);
      let counters = {};
      let uniqueUsers = 0;
      if (redis) {
        try {
          counters = await redis.hgetall(redisKey(req.lounge, `stats:${day}`)) || {};
          uniqueUsers = await redis.scard(redisKey(req.lounge, `stats:${day}:users`)) || 0;
        } catch (err) {
          console.error('Error fetching daily stats:', err.message);
        }
      }
      stats.push({
        date: day,
        page_views: Number(counters.page_view || 0),
        logins: Number(counters.login || 0),
        resets: Number(counters.reset || 0),
        clears: Number(counters.clear || 0),
        unique_users: uniqueUsers
      });
    }

    // Recent activity
    let recent = [];
    if (redis) {
      try {
        recent = await redis.lrange(redisKey(req.lounge, 'usage_log'), 0, 49);
      } catch (err) {
        console.error('Error fetching recent activity:', err.message);
      }
    }
    const parsed = recent.map(e => typeof e === 'string' ? JSON.parse(e) : e);

    res.json({ stats, recent_activity: parsed });
  } catch (err) {
    console.error('Error fetching stats:', err.message);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// Serve static files (only for authenticated users)
app.use(requireAuth, express.static(path.join(__dirname, '..', 'public')));

module.exports = app;
