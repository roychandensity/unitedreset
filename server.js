require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// Count offsets per space: { spaceId: offset }
const countOffsets = {};

// Auth middleware
function requireAuth(req, res, next) {
  if (req.session.authenticated) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// Login page (served before static files for unauthenticated users)
app.get('/', (req, res, next) => {
  if (req.session.authenticated) return next();
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Login endpoint
app.post('/login', (req, res) => {
  const { password } = req.body;
  if (password === process.env.APP_PASSWORD) {
    req.session.authenticated = true;
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

// Logout
app.post('/logout', (req, res) => {
  req.session.destroy();
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

    // Try both 'results' and top-level array
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

    // Apply count offsets
    if (data.data) {
      for (const [spaceId, info] of Object.entries(data.data)) {
        if (countOffsets[spaceId]) {
          info.count = Math.max(0, info.count + countOffsets[spaceId]);
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
    // Fetch current Density count to calculate offset
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
    countOffsets[spaceId] = newCount - currentCount;

    console.log(`Override: ${spaceId} Density=${currentCount}, newCount=${newCount}, offset=${countOffsets[spaceId]}`);
    res.json({ success: true, densityCount: currentCount, newCount, offset: countOffsets[spaceId] });
  } catch (err) {
    console.error('Error setting override:', err.message);
    res.status(502).json({ error: 'Failed to set override' });
  }
});

// Clear override for a space
app.post('/api/override/clear', requireAuth, (req, res) => {
  const { spaceId } = req.body;
  if (spaceId) {
    delete countOffsets[spaceId];
  } else {
    Object.keys(countOffsets).forEach(k => delete countOffsets[k]);
  }
  res.json({ success: true });
});

// Serve static files (only for authenticated users)
app.use(requireAuth, express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
