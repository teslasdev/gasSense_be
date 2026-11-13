# GasSense hosting guide

GasSense runs as one Node.js service that serves the admin dashboard at `/`, the API at `/api/v1/...`, and `/health`. The alert worker runs as a separate process against the same MySQL database.

## Requirements

- Node.js 20+
- MySQL 8+
- HTTPS domain
- Process manager such as PM2, systemd, Docker, or a managed Node host

## Environment

Create `.env` on the server and never commit it:

```env
NODE_ENV=production
MYSQL_HOST=your-digitalocean-mysql-host
MYSQL_PORT=3306
MYSQL_USER=madsounds_user
MYSQL_PASSWORD=your-password
MYSQL_DATABASE=gassense
API_PORT=4000
WEB_ORIGIN=https://admin.example.com
API_URL=https://admin.example.com
EMAIL_PROVIDER=log
```

Set `WEB_ORIGIN` to the exact frontend origin, including protocol and port. Multiple origins may be comma-separated:

```env
WEB_ORIGIN=https://admin.example.com,https://www.example.com
```

Use a dedicated MySQL user. Do not use MySQL root in production.

## Install, migrate, and build

```bash
npm ci
npm run db:generate
npm run db:migrate
npm run build
```

## Start the services

```bash
node apps/api/dist/src/server.js
node apps/api/dist/src/worker.js
```

Run them under a process manager so they restart after crashes and reboots.

### PM2

```bash
npm install --global pm2
pm2 start apps/api/dist/src/server.js --name gassense-api
pm2 start apps/api/dist/src/worker.js --name gassense-worker
pm2 save
pm2 startup
```

View status and logs:

```bash
pm2 status
pm2 logs gassense-api
pm2 logs gassense-worker
```

## Reverse proxy

Proxy your HTTPS domain to `127.0.0.1:4000` using Nginx, Caddy, or your hosting provider. Example Nginx location:

```nginx
location / {
    proxy_pass http://127.0.0.1:4000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Redirect HTTP to HTTPS.

## Verify

```bash
curl https://admin.example.com/health
```

Expected:

```json
{ "ok": true }
```

Dashboard URL:

```text
https://admin.example.com/
```

## Prototype sensor API

The hardware-free prototype uses sensor IDs and no login:

```http
GET    /api/v1/prototype/sensors
POST   /api/v1/prototype/sensors/:sensorId/pair
GET    /api/v1/prototype/sensors/:sensorId/overview
GET    /api/v1/prototype/sensors/:sensorId/analytics?period=weekly
POST   /api/v1/prototype/sensors/:sensorId/gas-control
GET    /api/v1/prototype/sensors/:sensorId/device
POST   /api/v1/prototype/sensors/:sensorId/recalibrate
DELETE /api/v1/prototype/sensors/:sensorId/pair
```

The prototype sensor store is in memory and resets when the API restarts. Use the database-backed production routes for real monitoring.

## Real sensor ingestion

```http
POST /api/v1/device/readings
Authorization: Bearer <device-credential>
```

Weight rule:

```text
gross weight = empty cylinder weight + gas remaining weight
```

For a 6 kg empty cylinder containing 6 kg of gas:

```json
{
  "grossWeightGrams": 12000,
  "stable": true
}
```

## Security checklist

- Use HTTPS only.
- Never expose database credentials to browser code.
- Add admin authentication before exposing admin routes publicly.
- Keep MySQL private and back it up regularly.
- Treat gas ON/OFF commands as safety-critical.
- Require sensor acknowledgement before confirming physical valve state.

## Updating

```bash
git pull
npm ci
npm run db:generate
npm run db:migrate
npm run build
pm2 restart gassense-api gassense-worker
```
