# United Reset

Live occupancy display for United Airlines with manual count override/reset and history log. The dashboard polls the Density API every 5 seconds for real-time occupancy data and allows authorized users to manually override or reset the displayed count. Session state is persisted with Upstash Redis for reliable operation on Vercel.

## Building Context

- **Customer:** United Airlines
- **Location:** O'Hare Airport, Terminal B6
- **Scope:** Single space monitoring

## Features

- Real-time occupancy display with circular progress indicator (polls every 5 seconds)
- Manual count reset and override for authorized users
- Reset history log with timestamps (CST)
- Password-protected access via JWT cookies
- Persistent session and state via Upstash Redis

## Tech Stack

| Dependency | Version |
|---|---|
| Node.js | Runtime |
| Express | 5.2.1 |
| jsonwebtoken | 9.0.3 |
| @upstash/redis | 1.37.0 |
| express-session | 1.19.0 |

## Density API Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/v3/spaces` | GET | Fetch space details and capacity |
| `/v3/analytics/occupancy/current` | POST | Fetch current occupancy count (polled every 5 seconds) |

## Deployment

- **Hosting:** Vercel at [unitedreset.vercel.app](https://unitedreset.vercel.app)
- **Session persistence:** Upstash Redis

## Setup

```bash
npm install
npm start
```

The server runs on port 3003 by default.

## Environment Variables

| Variable | Description |
|---|---|
| `DENSITY_API_TOKEN` | Bearer token for the Density API |
| `SPACE_IDS` | Comma-separated Density space IDs to monitor |
| `APP_PASSWORD` | Password for dashboard login |
| `SESSION_SECRET` | Secret used to sign Express sessions |
| `PORT` | Server port (defaults to 3003) |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST URL |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST token |
