# World Cup 2026 Predictions App

A full-stack web application for running a World Cup 2026 score prediction league among your team/friends.

---

## Live URLs

| Service | URL |
|---------|-----|
| **Frontend** | https://world-cup-predictions-frontend.vercel.app |
| **Backend API** | https://world-cup-predictions-backend-z3un.onrender.com |
| **Health check** | https://world-cup-predictions-backend-z3un.onrender.com/health |

> **Note:** The backend runs on Render's free tier and **spins down after 15 minutes of inactivity**. The first request after idle may take ~30–50 seconds to wake up.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18 + TypeScript, Vite 5, Tailwind CSS 3, TanStack Query v5, React Router v6 |
| Backend | Node.js 22 + Express + TypeScript |
| Database | PostgreSQL (Neon hosted) |
| ORM | Knex.js |
| Auth | JWT (7-day tokens) + bcryptjs |
| Hosting | Vercel (frontend) + Render (backend) + Neon (DB) |

---

## Repositories

| Repo | URL |
|------|-----|
| Backend | https://github.com/MuhammadRazeesCK/world-cup-predictions-backend |
| Frontend | https://github.com/MuhammadRazeesCK/world-cup-predictions-frontend |

Auto-deploy is enabled on both — every push to `main` triggers a production deploy.

---

## Local Development Setup

### Prerequisites

- Node.js 22 (via asdf — `.tool-versions` files are in each folder)
- PostgreSQL 18 (local)
- `asdf` version manager

### 1. Clone both repos

```bash
git clone https://github.com/MuhammadRazeesCK/world-cup-predictions-backend.git
git clone https://github.com/MuhammadRazeesCK/world-cup-predictions-frontend.git
```

### 2. Set up the backend

```bash
cd world-cup-predictions-backend
cp .env.example .env
# Edit .env — set DATABASE_URL to your local postgres, set JWT_SECRET
npm install
npm run migrate          # creates all tables
ADMIN_PASSWORD=yourpassword npm run seed:admin   # creates the admin user
npm run dev              # starts on http://localhost:3000
```

### 3. Set up the frontend

```bash
cd world-cup-predictions-frontend
npm install
npm run dev              # starts on http://localhost:5173
```

The frontend proxies all `/api` calls to `localhost:3000` via Vite's dev proxy — no `VITE_API_URL` needed locally.

---

## Environment Variables

### Backend (`backend/.env`)

| Variable | Description |
|----------|-------------|
| `NODE_ENV` | `development` or `production` |
| `PORT` | Server port (Render sets this to `10000` automatically) |
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Secret for signing JWT tokens — keep this long and random |
| `ALLOWED_ORIGINS` | Comma-separated list of allowed frontend URLs (CORS) |
| `ADMIN_EMAIL` | Email used when seeding the admin account |

### Frontend (Vercel Environment Variables)

| Variable | Description |
|----------|-------------|
| `VITE_API_URL` | Backend base URL (e.g. `https://world-cup-predictions-backend-z3un.onrender.com`) |

> Locally, `VITE_API_URL` is intentionally **not set** — requests go through Vite proxy instead.

---

## Database

**Production:** Hosted on [Neon](https://neon.tech) (free tier, 0.5 GB)

**Schema tables:**

| Table | Purpose |
|-------|---------|
| `users` | Registered users (roles: `user`, `admin`) |
| `sessions` | Active JWT sessions (token hash stored, not raw token) |
| `fixtures` | Match schedule with kickoff times and scores |
| `predictions` | User predictions per fixture |
| `admin_logs` | Audit trail for all admin actions |

**Run migrations against production (when schema changes):**

```bash
cd backend
DATABASE_URL="<neon-connection-string>" NODE_ENV=production npm run migrate:prod
```

**Rollback:**

```bash
DATABASE_URL="<neon-connection-string>" NODE_ENV=production npm run migrate:rollback
```

---

## API Routes

All routes are prefixed with `/api`.

### Auth — `/api/auth`
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/register` | No | Register a new user |
| POST | `/login` | No | Login, returns JWT |
| POST | `/logout` | Yes | Revoke current session |
| GET | `/me` | Yes | Get current user info |

### Fixtures — `/api/fixtures`
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/available` | Yes | Get fixtures open for prediction |
| GET | `/` | Yes | Get all fixtures |

### Predictions — `/api/predictions`
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/` | Yes | Submit / update a prediction |
| GET | `/history` | Yes | Get user's prediction history |

### Leaderboard — `/api/leaderboard`
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | Yes | Full leaderboard (users only, no admins) |
| GET | `/me` | Yes | Current user's rank and stats |

### Admin — `/api/admin` (admin role required)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/fixtures` | Add a single fixture |
| POST | `/fixtures/csv` | Bulk upload fixtures via CSV |
| PATCH | `/fixtures/:id/score` | Update match score |
| GET | `/fixtures` | List all fixtures |
| DELETE | `/fixtures/:id` | Delete a fixture |
| GET | `/users` | List all users |
| POST | `/users` | Create a new user |
| POST | `/users/:id/reset-password` | Reset a user's password (revokes their sessions) |
| GET | `/logs` | View admin action logs |

---

## Scoring System

| Result | Points |
|--------|--------|
| Exact score match | **8 pts** |
| Correct winner / draw (wrong score) | **3 pts** |
| Wrong result | **0 pts** |

Scores are calculated automatically by a background job that polls every 30 seconds once a fixture is marked as `completed`.

---

## Admin Features

- **Upload CSV** — bulk import fixtures. Expected columns: `match_number, home_team, away_team, kickoff_time, stage`
- **Add Fixture** — add individual fixtures with a datetime picker (timezone-aware, defaults to IST)
- **Manage Fixtures** — update scores, delete fixtures
- **Users** — view all users, create new users, reset passwords
- **Logs** — audit trail of all admin actions

Admin users are **excluded from the leaderboard** and cannot submit predictions.

---

## CSV Fixture Format

```csv
match_number,home_team,away_team,kickoff_time,stage
1,Morocco,Portugal,2026-06-11T16:00:00.000Z,group
2,USA,Mexico,2026-06-12T19:00:00.000Z,group
```

`stage` must be one of: `group`, `round16`, `qf`, `sf`, `final`

---

## Deployment

### Backend (Render)
- Trigger: push to `main` in the backend repo
- Build: `npm install && npm run build` (compiles TypeScript)
- Start: `node dist/index.js`
- Migrations run automatically on deploy via `preDeployCommand` in `render.yaml`

### Frontend (Vercel)
- Trigger: push to `main` in the frontend repo
- Build: `tsc && vite build`
- SPA routing handled by `vercel.json` (all paths → `index.html`)

### After deploying a schema change
1. Run `npm run migrate:prod` locally with the Neon `DATABASE_URL`
2. OR let Render's `preDeployCommand` handle it automatically on next deploy

---

## Known Limitations (Free Tier)

- Render free instance **sleeps after 15 min idle** — first wake-up takes ~30–50s
- Neon free tier: **0.5 GB** storage limit
- Vercel free tier: 100 GB bandwidth/month

To remove the sleep issue, upgrade Render to the **Starter plan ($7/month)**.
