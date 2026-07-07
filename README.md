# United Reset

Live occupancy display for United Airlines with manual count override/reset and history log. The dashboard polls the Density API every 5 seconds for real-time occupancy data and allows authorized users to manually override or reset the displayed count. Session state is persisted with Upstash Redis for reliable operation on Vercel.

## Building Context

- **Customer:** United Airlines
- **Primary location:** O'Hare Airport, Terminal B6
- **Additional location:** United IAH C-North
- **Scope:** Multi-lounge monitoring with isolated auth, reset state, history, and usage stats per lounge

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
- **B6 URL:** `/`
- **IAH C-North URL:** `/iah-c-north`
- **Session persistence:** Upstash Redis

## Setup

```bash
npm install
npm start
```

The server runs on port 3000 by default.

## Environment Variables

| Variable | Description |
|---|---|
| `DENSITY_API_KEY` | Bearer token for the Density API. `DENSITY_API_TOKEN` is also supported. |
| `SPACE_IDS` | Legacy B6 comma-separated Density space IDs. `B6_SPACE_IDS` can also be used. |
| `APP_PASSWORD` | Legacy B6 dashboard password. `B6_APP_PASSWORD` can also be used. |
| `IAH_CNORTH_SPACE_IDS` | IAH C-North comma-separated Density space IDs. Use `spc_1560021226523460540`. |
| `IAH_CNORTH_APP_PASSWORD` | IAH C-North dashboard password. Defaults to `unitediah` if unset. |
| `SESSION_SECRET` | Secret used to sign Express sessions |
| `PORT` | Server port (defaults to 3000) |
| `KV_REST_API_URL` | Upstash Redis REST URL. `UPSTASH_REDIS_REST_URL` is also supported. |
| `KV_REST_API_TOKEN` | Upstash Redis REST token. `UPSTASH_REDIS_REST_TOKEN` is also supported. |

## Lounge Isolation

B6 keeps the original `/` route and legacy Redis keys so existing reset state, history, and usage stats remain available. IAH C-North uses `/iah-c-north`, its own auth cookie, and Redis keys prefixed with `lounge:iah-c-north:` so its reset history and usage stats are separate.
