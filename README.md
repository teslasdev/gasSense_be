# GasSense

GasSense is a household LPG monitoring service with an Express API, a small web dashboard, Prisma/MySQL persistence, and an alert worker. The dashboard is served by the API at `/` and includes prototype gas valve ON/OFF controls.

## Local setup

Requirements: Node.js 20+, npm 10+, and Docker Desktop.

For local development, the API connects as MySQL `root` using the Compose development password. Use a dedicated least-privilege database user in production.

```bash
cp .env.example .env
docker compose up -d mysql
npm install
npm run db:generate
npm run db:migrate
npm run dev
```

The API is available at `http://localhost:4000`; the worker runs as a separate process via the root `dev` command. Seed credentials are `demo@gassense.local` / `demo-password`.

## API and deployment notes

The complete endpoint reference, including the hardware-free onboarding prototype flow, is in [docs/API.md](docs/API.md).
The screen-by-screen frontend implementation handoff is in [docs/FRONTEND_HANDOFF.md](docs/FRONTEND_HANDOFF.md).
The production hosting and deployment guide is in [docs/HOSTING.md](docs/HOSTING.md).

The API uses direct MySQL access through `mysql2` and reads `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, and `MYSQL_DATABASE` from `.env`. The prototype sensor flow is sensor-ID based and does not require user login or household setup.

The API uses direct MySQL tables for sensors and readings. For production, run the Express API and worker as separate persistent services against managed MySQL. Set `WEB_ORIGIN` to the origin of the frontend that consumes this API. Never expose MySQL credentials to browser code.

Historical usage/forecast endpoints and cylinder-history editing can be added without changing the ingestion contract; the database preserves configuration effective dates and raw readings for that work.
# gasSense_be
