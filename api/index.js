const express = require('express');
const jwt = require('jsonwebtoken');
const cookie = require('cookie');
const { Redis } = require('@upstash/redis');
const path = require('path');

const app = express();

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const JWT_SECRET = process.env.SESSION_SECRET;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Parse auth from JWT cookie
function getAuth(req) {
  const cookies = cookie.parse(req.headers.cookie || '');
  if (!cookies.auth) return null;
  try {
    return jwt.verify(cookies.auth, JWT_SECRET);
  } catch {
    return null;
  }
}

function requireAuth(req, res, next) {
  if (getAuth(req)) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// Login page (served for unauthenticated users)
app.get('/', (req, res, next) => {
  if (getAuth(req)) return next();
  res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
});

// Login endpoint
app.post('/login', (req, res) => {
  const { password } = req.body;
  if (password === process.env.APP_PASSWORD) {
    const token = jwt.sign({ authenticated: true }, JWT_SECRET, { expiresIn: '24h' });
    res.setHeader('Set-Cookie', cookie.serialize('auth', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 86400,
      path: '/'
    }));
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

// Logout
app.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', cookie.serialize('auth', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 0,
    path: '/'
  }));
  res.json({ success: true });
});

// Proxy: get space details from Density
app.get('/api/spaces', requireAuth, async (req, res) => {
  try {
    const spaceIds = process.env.SPACE_IDS.split(',').map(s => s.trim());
    const response = await fetch('https://api.density.io/v3/spaces', {
      headers: { 'Authorization': `Bearer ${process.env.DENSITY_API_KEY}` }
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
app.get('/api/occupancy', requireAuth, async (req, res) => {
  try {
    const spaceIds = process.env.SPACE_IDS.split(',').map(s => s.trim());
    const response = await fetch('https://api.density.io/v3/analytics/occupancy/current', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DENSITY_API_KEY}`
      },
      body: JSON.stringify({ space_ids: spaceIds })
    });

    if (!response.ok) {
      throw new Error(`Density API returned ${response.status}`);
    }

    const data = await response.json();

    // Apply count offsets from Redis
    if (data.data) {
      for (const spaceId of Object.keys(data.data)) {
        const offset = await redis.get(`offset:${spaceId}`);
        if (offset !== null) {
          data.data[spaceId].count = Math.max(0, data.data[spaceId].count + Number(offset));
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
app.post('/api/override', requireAuth, async (req, res) => {
  const { spaceId, newCount } = req.body;
  if (!spaceId || typeof newCount !== 'number') {
    return res.status(400).json({ error: 'spaceId and newCount (number) required' });
  }

  try {
    const response = await fetch('https://api.density.io/v3/analytics/occupancy/current', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DENSITY_API_KEY}`
      },
      body: JSON.stringify({ space_ids: [spaceId] })
    });

    if (!response.ok) {
      throw new Error(`Density API returned ${response.status}`);
    }

    const data = await response.json();
    const currentCount = data.data[spaceId]?.count ?? 0;
    const offset = newCount - currentCount;

    await redis.set(`offset:${spaceId}`, offset);

    // Log the override to history
    const logEntry = {
      timestamp: new Date().toISOString(),
      spaceId,
      previousCount: currentCount,
      newCount,
      action: 'override'
    };
    await redis.lpush('reset_log', JSON.stringify(logEntry));
    // Keep last 100 entries
    await redis.ltrim('reset_log', 0, 99);

    res.json({ success: true, densityCount: currentCount, newCount, offset });
  } catch (err) {
    console.error('Error setting override:', err.message);
    res.status(502).json({ error: 'Failed to set override' });
  }
});

// Clear override for a space
app.post('/api/override/clear', requireAuth, async (req, res) => {
  const { spaceId } = req.body;
  if (spaceId) {
    await redis.del(`offset:${spaceId}`);
    const logEntry = {
      timestamp: new Date().toISOString(),
      spaceId,
      action: 'clear'
    };
    await redis.lpush('reset_log', JSON.stringify(logEntry));
    await redis.ltrim('reset_log', 0, 99);
  } else {
    const spaceIds = process.env.SPACE_IDS.split(',').map(s => s.trim());
    for (const id of spaceIds) {
      await redis.del(`offset:${id}`);
    }
    const logEntry = {
      timestamp: new Date().toISOString(),
      spaceId: 'all',
      action: 'clear'
    };
    await redis.lpush('reset_log', JSON.stringify(logEntry));
    await redis.ltrim('reset_log', 0, 99);
  }
  res.json({ success: true });
});

// Get reset history log
app.get('/api/log', requireAuth, async (req, res) => {
  try {
    const entries = await redis.lrange('reset_log', 0, 49);
    const parsed = entries.map(e => typeof e === 'string' ? JSON.parse(e) : e);
    res.json(parsed);
  } catch (err) {
    console.error('Error fetching log:', err.message);
    res.status(500).json({ error: 'Failed to fetch log' });
  }
});

// Check if a space has an active override
app.get('/api/override/status', requireAuth, async (req, res) => {
  const spaceIds = process.env.SPACE_IDS.split(',').map(s => s.trim());
  const statuses = {};
  for (const id of spaceIds) {
    const offset = await redis.get(`offset:${id}`);
    statuses[id] = offset !== null;
  }
  res.json(statuses);
});

// Serve static files (only for authenticated users)
app.use(requireAuth, express.static(path.join(__dirname, '..', 'public')));

module.exports = app;
