# AWS Deployment Guide — EasyFix_Backend (Node.js/Express API)

> ⚠️ **Canonical bootstrap doc has moved.** Both QA and Production
> now use Docker + SSM (not the PM2/Nginx flow described below).
> Read [`AWS_QA_BOOTSTRAP.md`](./AWS_QA_BOOTSTRAP.md) for the current
> bootstrap + env-file conventions (`.env` vs `backend.env` split,
> required vs auto-touched files per pipeline, etc.).
>
> This file is retained for historical reference + still-valid sections
> on Nginx, DB migrations, and PM2-only nuances (in case a legacy PM2
> host ever needs touching). Skip ahead to the section you need.

This guide originally walked through deploying the **unified backend**
(`EasyFix_Backend`) to AWS using **EC2 + Nginx + PM2**, with
**GitHub Actions** auto-deploying on `QA` and `Production` branch merges.

> **Companion guide:** the frontend (`Easyfix_CRM_UI`) has its own [AWS_DEPLOYMENT_GUIDE.md](../../Easyfix_CRM_UI/docs/AWS_DEPLOYMENT_GUIDE.md). Set them up in parallel — frontend Nginx proxies `/api/*` to this backend.

> **Database note:** the shared MySQL DB lives at `111.93.206.91:3306` (`easyfix_core`) — outside AWS. If you migrate it to RDS later, only the `DB_HOST` env changes; nothing else here.

---

## Architecture

```
                 ┌────────────────────────────────────────────┐
                 │  Route 53  →  qa.api.easyfix.in            │
                 │            →  api.easyfix.in               │
                 └────────────────┬───────────────────────────┘
                                  │
                       ┌──────────▼──────────┐
                       │   EC2 (QA / Prod)   │
                       │   t3.medium / large │   ← bigger than UI
                       │                     │       (handles 5 services
                       │   Nginx :443        │        worth of traffic)
                       │      ▼              │
                       │   PM2 → Express 5100│
                       │      │              │
                       │      ▼              │
                       │   MySQL pool ──► 111.93.206.91:3306 (shared QA DB)
                       └─────────────────────┘
                              │
                              ▼ outbound (notifications + webhooks)
                  SMSCountry · Gallabox · Gmail SMTP · FCM · client webhooks
```

Two EC2 instances total — one for `QA`, one for `Production`. **Same DB host** in both (shared `easyfix_core`), but separate JWT secrets and notification API keys.

---

## Phase 1 — Create the QA EC2 instance (AWS Console)

### 1.1  Launch EC2

1. Open the [AWS Console](https://console.aws.amazon.com/) → top-right region: **Mumbai (`ap-south-1`)**.
2. Search bar → **EC2** → **Instances** → **Launch instances**.

### 1.2  Configure

| Field | Value |
|---|---|
| Name and tags | `easyfix-backend-qa` |
| AMI | **Ubuntu Server 22.04 LTS** (free tier eligible) |
| Architecture | `64-bit (x86)` |
| Instance type | `t3.medium` (2 vCPU, 4 GiB) — bump to `t3.large` for production traffic |
| Key pair | **Create new** → name `easyfix-backend-qa` → RSA, `.pem` → **Create key pair** (save) |
| Network → VPC | Default |
| Network → Auto-assign public IP | **Enable** |
| Network → Firewall | **Create security group** |
| → Name | `easyfix-backend-sg` |
| → Inbound rules | see below |
| Storage | `30 GiB`, `gp3` (logs accumulate) |

**Inbound rules:**

| Type | Protocol | Port | Source | Description |
|---|---|---|---|---|
| SSH | TCP | 22 | My IP | dev access |
| HTTP | TCP | 80 | Anywhere | Let's Encrypt + redirect |
| HTTPS | TCP | 443 | Anywhere | public traffic |
| Custom TCP | TCP | 5100 | `easyfix-crm-ui-sg` | direct frontend → backend (intra-VPC, no public 5100) |

The last rule lets the **frontend EC2 only** reach `:5100` directly — useful for internal calls that bypass the public DNS. If you don't have the frontend SG yet, skip it and add later.

Click **Launch instance**.

### 1.3  Elastic IP

EC2 left sidebar → **Elastic IPs** → **Allocate** → **Associate** with the new instance. Note the EIP.

### 1.4  DNS (Route 53)

- **Hosted zones** → `easyfix.in` → **Create record**
- record name: `qa.api`, type `A`, value: the EIP, TTL `300` → **Create**
- Verify with `dig qa.api.easyfix.in`.

---

## Phase 2 — Configure the EC2 (one-time bootstrap)

SSH in:
```bash
chmod 400 easyfix-backend-qa.pem
ssh -i easyfix-backend-qa.pem ubuntu@<EIP>
```

Bootstrap:
```bash
# Node 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs build-essential nginx git certbot python3-certbot-nginx mysql-client

# PM2
sudo npm install -g pm2
pm2 startup systemd -u ubuntu --hp /home/ubuntu
# Copy/run the printed sudo command

# Clone
git clone https://github.com/<YourOrg>/EasyFix_Backend.git ~/EasyFix_Backend
cd ~/EasyFix_Backend
git checkout QA   # or Production on the other instance

# Env
cp .env.example .env
nano .env   # fill in real values (template below)
chmod 600 .env

# Verify DB connectivity BEFORE starting the API
npm ci
npm run test:db
```

`npm run test:db` should print `OK: easyfix_core reachable, server version 5.7.x`. If it fails, check that the MySQL host `111.93.206.91` allows inbound from the EC2 EIP — the existing DB has IP-allowlist firewall rules.

### Sample `.env` for QA

```env
# ─── Server ────────────────────────────────────────────────────
PORT=5100
NODE_ENV=production
LOG_LEVEL=info

# ─── DB (shared easyfix_core on prem) ──────────────────────────
DB_HOST=111.93.206.91
DB_PORT=3306
DB_NAME=easyfix_core
DB_USER=easyfix_app
DB_PASSWORD=<from-secrets-vault>

# ─── Auth ───────────────────────────────────────────────────────
JWT_SECRET=<generate-32-bytes-random>
JWT_EXPIRY=30d
SUITE_URL=https://suite.1office.in

# ─── CORS ───────────────────────────────────────────────────────
CORS_ALLOWED_ORIGINS=https://qa.crm.easyfix.in,https://qa.client.easyfix.in,http://localhost:5180

# ─── Notification providers (use TEST_* in QA so real customers
#     don't get pinged) ─────────────────────────────────────────
NOTIFICATIONS_DISABLE=false
TEST_EMAILS=ops-test@channelplay.in
TEST_MOBILE=9310992052
SMSCOUNTRY_USER=...
SMSCOUNTRY_PASS=...
GALLABOX_API_KEY=...
GALLABOX_API_SECRET=...
GMAIL_USER=ithelpdesk@easyfix.in
GMAIL_PASS=<app-password>
FCM_API_KEY=...

# ─── Webhooks ──────────────────────────────────────────────────
WEBHOOKS_DISABLE=false

# ─── Auto-assign weights (optional — DB rows take precedence) ──
WEIGHT_WORKLOAD=0.45
WEIGHT_RATING=0.30
WEIGHT_COMPLETION=0.25
MAX_CONCURRENT_JOBS=5
```

Start:
```bash
pm2 start "node server/index.js" --name easyfix-backend --update-env
pm2 save
pm2 logs easyfix-backend   # watch for "listening on :5100"
```

### 2.1  Nginx reverse proxy

Create `/etc/nginx/sites-available/easyfix-backend`:

```nginx
# WebSocket upgrade helper — "upgrade" for a WS handshake, "close" otherwise.
# Must live at http{} context; in a sites-available file (included into http{})
# it belongs ABOVE the server block.
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    server_name qa.api.easyfix.in;

    # Slightly looser body size — Excel uploads + multi-image jobs
    client_max_body_size 25M;

    # AI-calling media stream — Plivo <Stream> opens a WebSocket to the backend
    # at /ai-voice-stream. This location MUST carry the Upgrade/Connection headers
    # (and proxy_http_version 1.1) or the handshake fails and calls drop the moment
    # they're answered. Long read/send timeouts keep the audio socket alive for the
    # whole call (the app also bounds it via AI_CALL_MAX_DURATION_SEC).
    location /ai-voice-stream {
        proxy_pass http://127.0.0.1:5100;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    location / {
        proxy_pass http://127.0.0.1:5100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }

    # Static uploads served directly by Nginx (much faster than Express)
    location /easydoc/ {
        alias /var/www/html/easydoc/;
        expires 7d;
        add_header Cache-Control "public, immutable";
    }
}
```

> **Note on the WebSocket path:** `/ai-voice-stream` is a *raw* server path (not
> under `/api/public`), so it needs its own `location`. The `/api/public/plivo/ai-answer`
> callback is an ordinary HTTPS GET and is served fine by `location /`. If your
> edge also has a VPN allowlist (see the public-routes setup), `/ai-voice-stream`
> must be reachable by Plivo the same way `/api/public/*` is.

Enable + reload:
```bash
sudo ln -s /etc/nginx/sites-available/easyfix-backend /etc/nginx/sites-enabled/
sudo rm /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

Create the uploads dir (matches `UPLOAD_*` paths in `.env`):
```bash
sudo mkdir -p /var/www/html/easydoc/{easyfixer_documents,upload_jobs,client_invoice}
sudo chown -R ubuntu:ubuntu /var/www/html/easydoc
```

### 2.2  HTTPS (Let's Encrypt)

```bash
sudo certbot --nginx -d qa.api.easyfix.in
```

Smoke test:
```bash
curl https://qa.api.easyfix.in/api/health
curl https://qa.api.easyfix.in/api/health/db
curl https://qa.api.easyfix.in/api/integration/_ping   # legacy-shape response
```

All three should return JSON success.

---

## Phase 3 — Repeat for Production

Phase 1 + 2 with these substitutions:

| QA value | Production value |
|---|---|
| Instance name `easyfix-backend-qa` | `easyfix-backend-prod` |
| Instance type `t3.medium` | `t3.large` (4 vCPU, 8 GiB) |
| DNS `qa.api.easyfix.in` | `api.easyfix.in` |
| Branch `QA` | `Production` |
| `.env` `NODE_ENV=production`, `LOG_LEVEL=info` | same |
| `.env` `TEST_EMAILS` / `TEST_MOBILE` | **REMOVE** these — real customers WILL get notifications |
| `.env` `NOTIFICATIONS_DISABLE` | `false` |
| `.env` `WEBHOOKS_DISABLE` | `false` |
| `.env` `JWT_SECRET` | DIFFERENT from QA — never share secrets across environments |
| `.env` `CORS_ALLOWED_ORIGINS` | `https://crm.easyfix.in,https://client.easyfix.in,https://core.easyfix.in` |

> **Decathlon / external-integration cutover**: external clients hit `https://core.easyfix.in/v1/*` on the legacy Dropwizard service. To cut over to this backend, point `core.easyfix.in` Nginx at this instance with the rewrite `/v1/*` → `/api/integration/v1/*`. See `RETIREMENT_RUNBOOK.md` for the full step-by-step.

---

## Phase 4 — GitHub Actions auto-deploy

The included [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) deploys on push to `QA` (→ QA EC2) or `Production` (→ Prod EC2). It SSH-es in, pulls latest, runs `npm ci`, smoke-tests `/api/health` + `/api/health/db`, then PM2-reloads.

### 4.1  Generate a deploy SSH key

Local machine:
```bash
ssh-keygen -t ed25519 -f easyfix-backend-deploy -N "" -C "github-actions-deploy"
```

Add the **public** key to each EC2's `~/.ssh/authorized_keys`:
```bash
# On the EC2:
echo "<paste .pub contents>" >> ~/.ssh/authorized_keys
```

### 4.2  GitHub repo secrets (UI walkthrough)

Repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**:

| Name | Value |
|---|---|
| `QA_HOST` | QA EC2 EIP |
| `QA_USER` | `ubuntu` |
| `QA_SSH_KEY` | private key file contents (`easyfix-backend-deploy`) |
| `PROD_HOST` | Prod EC2 EIP |
| `PROD_USER` | `ubuntu` |
| `PROD_SSH_KEY` | same private key (both EC2s trust it) |
| `SLACK_WEBHOOK_URL` *(optional)* | Slack webhook for deploy notifications |

### 4.3  Branch setup + protection

GitHub UI:
1. Create branches `QA` and `Production` (from the **Branches** dropdown → New).
2. **Settings** → **Branches** → **Add classic branch protection rule** for `Production`:
   - ☑ Require a pull request before merging (1 approval)
   - ☑ Require status checks: `build` from `deploy.yml`
   - ☑ Require branches to be up to date
   - ☑ Restrict who can push (empty = PR-only)

### 4.4  Test the pipeline

1. Trivial change on `main` → push.
2. PR `main` → `QA` → merge → watch **Actions** → `deploy-qa` job (~5 min).
3. `curl https://qa.api.easyfix.in/api/health` → should reflect new commit SHA in response (if you wired one) or just return success.
4. PR `QA` → `Production` → merge → watch `deploy-prod`.

---

## Phase 5 — Day-2 ops

### Logs

EC2 Console → **Connect** → **EC2 Instance Connect**:
```bash
pm2 logs easyfix-backend                       # app logs
pm2 logs easyfix-backend --lines 200           # last 200 lines
sudo tail -f /var/log/nginx/access.log         # traffic
sudo tail -f /var/log/nginx/error.log          # proxy errors
```

### DB-only restart (zero app downtime)

If a DB password rotates:
```bash
nano ~/EasyFix_Backend/.env   # update DB_PASSWORD
pm2 reload easyfix-backend --update-env        # re-reads .env
```

### Migration runs

DB migrations live in `migrations/*.sql` and are applied **manually** (no auto-runner). Process:

```bash
# On EC2 (preferred — uses the same network path):
cd ~/EasyFix_Backend
mysql -h $DB_HOST -P $DB_PORT -u $DB_USER -p$DB_PASSWORD $DB_NAME \
  < migrations/2026-04-18-auto-allocation-settings.sql
```

Or from your laptop with the DB host accessible. Migrations are idempotent (`INSERT … WHERE NOT EXISTS`) — safe to re-run.

### Roll back a deploy

GitHub UI → **Actions** → previous successful run → **Re-run all jobs**. Or via SSH:
```bash
cd ~/EasyFix_Backend
git log --oneline -10                 # find the last-good SHA
git reset --hard <sha>
npm ci
pm2 reload easyfix-backend
```

### Scale up

Same as the UI doc: **Stop** → **Change instance type** → **Start**. EBS + EIP persist.

### Backups

The DB is on-prem, not RDS — backups are owned by the existing DBA team. **Local logs** rotate via PM2 default (`~/.pm2/logs/easyfix-backend-out.log` capped at 50 MB × 5 files); no manual rotation needed.

If you want offsite log shipping: install the **CloudWatch Agent** (one-click from EC2 Console → **Actions → Manage CloudWatch agent**) and stream `/home/ubuntu/.pm2/logs/*` into a CloudWatch log group.

---

## Troubleshooting

| Symptom | First check |
|---|---|
| `npm run test:db` fails | DB host firewall blocks the EC2 EIP — request the DBA team to allowlist it |
| All routes 401 | `JWT_SECRET` mismatch between deploys, or `SUITE_URL` unreachable from EC2 |
| Specific client gets 403 on `/api/integration/*` | HTTP Basic creds don't match the row in `tbl_client_website` for that client |
| Webhook deliveries failing silently | Check `webhook_logs` table; `__delivery.error` field has the upstream response. After 3 attempts `__delivery.dlq=true` is the dead letter |
| Notification "delivered:false, disabled:true" | `NOTIFICATIONS_DISABLE=true` — flip to `false`; in QA prefer setting `TEST_EMAILS`/`TEST_MOBILE` instead of disabling outright |
| 502 Bad Gateway | `pm2 status` shows backend crashed — `pm2 logs easyfix-backend` for stack |
| `npm ci` fails with peer-deps error | Node version drift — verify `node --version` ≥ 20 |
| Excel job upload returns 413 | `client_max_body_size` in Nginx is too low; bump to `50M` and reload Nginx |

---

## Security checklist before going live

- ☑ `.env` permissions: `chmod 600 ~/EasyFix_Backend/.env`
- ☑ `JWT_SECRET` is 32+ random bytes, **different** per environment
- ☑ DB credentials are not the legacy CRM's — separate `easyfix_app` MySQL user with only the privileges the new backend needs (`SELECT, INSERT, UPDATE` on `easyfix_core.*`; no `DROP`/`ALTER`)
- ☑ EC2 SG port 22 source restricted to admin IPs (no `0.0.0.0/0`)
- ☑ HTTPS forced (Certbot redirect rule applied)
- ☑ `CORS_ALLOWED_ORIGINS` is an explicit allowlist — never `*`
- ☑ `WEBHOOKS_DISABLE=true` on initial deploy → flip to `false` only after smoke-testing endpoints
- ☑ Production has NO `TEST_EMAILS` / `TEST_MOBILE` set
- ☑ CloudWatch alarms: CPU > 80% for 10 min → email; status check fail → email; HTTP 5xx rate > 1% → email
- ☑ AWS root MFA on; day-to-day work uses an IAM user with restricted IAM policies
