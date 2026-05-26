# Sanchayam Backend

Self-hosted multi-asset portfolio tracker. Tracks equity, mutual funds, real estate, crypto, and bank balances under one portfolio with cost basis, P&L, XIRR, and net worth across currencies.

**Frontend repo:** [github.com/sagarnayak/sanchayamFrontend-public](https://github.com/sagarnayak/sanchayamFrontend-public)

---

## Stack

- Node.js + TypeScript + Fastify
- PostgreSQL (via postgres.js)
- Twelve Data (market price feeds)
- DeepSeek (corporate action extraction from NSE announcements - optional)
- nodemailer (OTP and invite emails)

---

## Prerequisites

- Node.js 18+
- PostgreSQL
- Twelve Data API key (free tier available at twelvedata.com)

---

## Setup

```bash
git clone https://github.com/sagarnayak/sanchayamBackend-public.git
cd sanchayamBackend-public
npm install
```

Copy the example env file and fill in your values:

```bash
cp .env.example .env
```

Generate a fresh encryption key for API keys stored in the database:

```bash
openssl rand -hex 32
```

Run database migrations:

```bash
npm run migrate
```

Build and start:

```bash
npm run build
node dist/index.js
```

---

## Environment Variables

See `.env.example` for all variables with descriptions.

---

## Running as a systemd Service

Create `/etc/systemd/system/sanchayam.service`:

```ini
[Unit]
Description=Sanchayam Backend
After=network.target

[Service]
User=youruser
WorkingDirectory=/path/to/sanchayamBackend-public
EnvironmentFile=/path/to/sanchayamBackend-public/.env
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable sanchayam
sudo systemctl start sanchayam
```

---

## License

MIT
