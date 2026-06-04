# AWS QA + Prod EC2 — Empty-Box Bootstrap (CI build → ECR → SSM pull)

> **This doc covers BOTH QA and Production** — both environments use
> the same Docker + SSM pipeline and the same `.env` / `backend.env`
> file convention. Environment-specific values (hostnames, secret IDs)
> are called out inline where they differ; everything else is shared.

**Target hosts:**
- QA: `10.30.2.30` — AWS EC2 (Easyfix-qa-appsrv-2, ARM64 Graviton) — shared by BE + UI
- Prod: separate hosts for BE + UI (`PROD_BACKEND_INSTANCE_ID` / `PROD_FRONTEND_INSTANCE_ID` secrets in each repo)

**Hosts:** EasyFix_Backend (port 5100) + Easyfix_CRM_UI (port 5180), both as Docker containers
**Connectivity from CI:** AWS Systems Manager (SSM) Run-Command
**Image registry:** AWS ECR — `902810393464.dkr.ecr.ap-south-1.amazonaws.com`

---

## Architecture

```
GitHub-hosted runner (public)             AWS                          EC2 (10.30.2.30)
─────────────────────────────             ───                          ────────────────
git push origin QA
       │
       ▼
typecheck / lint (fail-fast on GH-hosted runner)
       │
       ▼
docker buildx build (with GHA registry cache)
       │  --build-arg NEXT_PUBLIC_API_URL=$QA_API_URL   (CRM-UI only)
       ▼
docker push ────────────────────────►  ┌──────────────┐
                                       │     ECR      │
                                       │  easyfix/    │
                                       │   backend    │
                                       │   crm-ui     │
                                       └──────┬───────┘
                                              │
aws ssm send-command ─────────────────► SSM API ────► SSM Agent (long-poll)
                                                          │
                                                          ▼
                                                    sed BACKEND_IMAGE in /opt/easyfix/.env
                                                    docker compose pull <svc>
                                                    docker compose up -d --no-deps <svc>
                                                          │
                                                          ▼
                                                    ECR pull (auth via instance profile
                                                              + amazon-ecr-credential-helper)
```

**Key properties:**
- **No source code on the EC2** — only the compose file + env files. Source lives in git, image lives in ECR.
- **No git auth on the EC2** — workflow doesn't clone there. PATs / deploy keys not required.
- **No inbound SSH** to 10.30.2.30. CI auth is AWS IAM only.
- Each repo's workflow rebuilds + restarts ONLY its own service. Sibling untouched.

---

## Where every env var lives — read this first

| Variable kind | Where | When read | Examples |
|---|---|---|---|
| Backend runtime secrets | `/opt/easyfix/backend.env` (chmod 600) on EC2 | At container startup, mounted via `env_file:` | `DB_PASSWORD`, `JWT_SECRET`, `MS_GRAPH_*`, `SUITE_URL`, `NOTIFICATIONS_DISABLE` |
| CRM-UI runtime config + image-tag pointers | `/opt/easyfix/.env` (chmod 644) on EC2 | At `docker compose pull/up` time — interpolated by compose AND mounted into the CRM-UI container via `env_file:` | `BACKEND_IMAGE`, `CRM_UI_IMAGE` (workflow-managed), plus any UI runtime overrides |
| CI build-args (CRM-UI bundle) | **GitHub Environment "Organisation Level Secrets"** | At CI build time, passed as `--build-arg` | `QA_API_URL` → baked into static JS chunks |
| CI auth + targets | **GitHub Environment "Organisation Level Secrets"** | At CI runtime | `AWS_*`, `QA_INSTANCE_ID`, `ECR_REGISTRY`, `ECR_REPOSITORY_*`, `MAIL_*` |

App secrets (DB, JWT, etc.) NEVER go into GitHub. CI auth secrets (AWS keys, etc.) NEVER go onto the EC2. Each surface owns one concern.

### The two env files on the EC2 host — explicit split

Both QA and Prod follow the **same** convention. The deploy pipelines enforce it via preflight checks:

```
/opt/easyfix/
├── docker-compose.yml         (rewritten by every deploy from the YAML in the repo)
│
├── .env                        ← CRM-UI runtime config + docker-compose image-tag
│                                  interpolation. Contains:
│                                    BACKEND_IMAGE=…  CRM_UI_IMAGE=…
│                                    (+ any UI runtime overrides bootstrapped here)
│                                  Permission: chmod 644.
│                                  Bootstrapped once per host (the seed step below).
│
└── backend.env                 ← Backend service runtime secrets. Contains:
                                   DB_HOST / DB_USER / DB_PASSWORD / JWT_SECRET /
                                   MS_GRAPH_* / SUITE_URL / NOTIFICATIONS_DISABLE /
                                   KALEYRA_* / ZEPTOMAIL_API_TOKEN / etc.
                                 Permission: chmod 600.
                                 Bootstrapped once per host via bootstrap-env.sh.
```

**Which deploy requires which file** (the preflight checks at the top of each workflow's SSM step):

| Pipeline | Requires `backend.env` to pre-exist? | Requires `.env` to pre-exist? | Behaviour if `.env` missing |
|---|:---:|:---:|---|
| `EasyFix_Backend` deploy.yml | ✅ Yes — `set -e` aborts the deploy with `Error: /opt/easyfix/backend.env missing` | ❌ No — auto-touched | Empty `.env` is created, then `BACKEND_IMAGE=<new tag>` is appended. Subsequent UI deploys are responsible for seeding the rest of `.env`. |
| `Easyfix_CRM_UI` deploy.yml | ✅ Yes | ✅ Yes — aborts with `Error: /opt/easyfix/.env missing` | UI runtime config lives in `.env` and the deploy does NOT auto-seed it. Operator must bootstrap `.env` before the first UI deploy. |

Rationale for the asymmetry: the BE deploy only writes one line to `.env` (the `BACKEND_IMAGE` tag pointer) and never reads it for runtime config — touching the file if absent costs nothing. The UI deploy treats `.env` as its primary runtime config source, so silently creating an empty one would mask a real bootstrap mistake.

### Prod topology — two EC2s, one compose file per role

| EC2 | Services hosted | docker-compose.yml source |
|---|---|---|
| **QA shared box** | backend + crm-ui + client-ui + dozzle | `EasyFix_Backend/deploy/docker-compose.yml` |
| **Prod BE EC2** (`PROD_BACKEND_INSTANCE_ID`) | backend + dozzle ONLY | `EasyFix_Backend/deploy/docker-compose.prod-backend.yml` |
| **Prod UI EC2** (`PROD_FRONTEND_INSTANCE_ID`) | crm-ui + client-ui + dozzle | Shipped by the UI repos' deploy workflows |

Each repo's deploy workflow picks the right compose file based on the
`env_name` it just built for (`qa` vs `production`) and SSM-encodes it
to the right host. No compose file ever ships to a host that wouldn't
run the services it lists.

### ECR auth on the prod BE EC2

A freshly-launched EC2 has no Docker → ECR auth wiring out of the box.
If your deploy fails with `pull access denied… no basic auth
credentials`, the box is missing one of: the IAM ECR-read policy,
`amazon-ecr-credential-helper`, or the `~/.docker/config.json`
credHelpers entry. Full diagnosis + one-time fix recipe lives in
[`ECR_AUTH_BOOTSTRAP.md`](./ECR_AUTH_BOOTSTRAP.md).

---

## Prerequisites — already done by DevOps (recap)

✅ ECR repos created:
- `902810393464.dkr.ecr.ap-south-1.amazonaws.com/easyfix/backend`
- `902810393464.dkr.ecr.ap-south-1.amazonaws.com/easyfix/crm-ui`

✅ EC2 instance profile policies attached:
- `AmazonSSMManagedInstanceCore`
- `AmazonEC2ContainerRegistryReadOnly`

✅ IAM user `github-actions-deploy` policy includes:
- `ssm:SendCommand`, `ssm:GetCommandInvocation` on the QA instance ARN
- `ecr:GetAuthorizationToken` (resource: *)
- `ecr:BatchCheckLayerAvailability`, `ecr:GetDownloadUrlForLayer`, `ecr:BatchGetImage`, `ecr:InitiateLayerUpload`, `ecr:UploadLayerPart`, `ecr:CompleteLayerUpload`, `ecr:PutImage` on the two repo ARNs

---

## GitHub Environment "Organisation Level Secrets" — add secrets

The current setup uses a **single org-level environment named
"Organisation Level Secrets"** that both repos pull from. That works
for now since only QA exists; when Production lands you can either
(a) add a separate environment ("Production Level Secrets" or similar)
or (b) keep one environment and prefix the secret names with `PROD_*`
to disambiguate. Either model is compatible with the workflows below.

Configure under: **Repo → Settings → Environments → Organisation Level
Secrets → Add secret**.

| Secret | Status | Value |
|---|---|---|
| `AWS_ACCESS_KEY_ID` | ✓ | from `github-actions-deploy` IAM user |
| `AWS_SECRET_ACCESS_KEY` | ✓ | pair to above |
| `AWS_REGION` | ✓ | `ap-south-1` |
| `QA_INSTANCE_ID` | ✓ | `i-032aa9d2942305364` |
| `ECR_REGISTRY` | **add** | `902810393464.dkr.ecr.ap-south-1.amazonaws.com` |
| `ECR_REPOSITORY_BACKEND` | **add (backend repo only)** | `easyfix/backend` |
| `ECR_REPOSITORY_CRM_UI` | **add (CRM-UI repo only)** | `easyfix/crm-ui` |
| `QA_API_URL` | ✓ already there — keep it | `http://10.30.2.30:5100/api` (baked into the CRM-UI bundle at CI build time) |
| `MAIL_USERNAME` | optional | Gmail address for failure-alert emails |
| `MAIL_PASSWORD` | optional | Gmail app password |

`PROD_*` equivalents come later when prod EC2 is provisioned.

---

## One-time server bootstrap

Connect via **AWS Console → EC2 → Instances → select instance → Connect → Session Manager → Connect**. Browser-based root shell, no SSH key needed.

### A. Confirm SSM agent and Docker

```bash
sudo -i
systemctl status snap.amazon-ssm-agent.amazon-ssm-agent.service | head -5
docker --version
docker compose version
```

All three should show "active" / version output. (If Docker isn't installed yet, see legacy install instructions in git history of this doc — should be done already.)

### B. Install the ECR credential helper

This lets `docker pull` from ECR using the EC2 instance profile credentials — no `docker login` required:

```bash
apt-get install -y amazon-ecr-credential-helper

mkdir -p /root/.docker
cat > /root/.docker/config.json <<'EOF'
{
  "credHelpers": {
    "902810393464.dkr.ecr.ap-south-1.amazonaws.com": "ecr-login"
  }
}
EOF

# Verify auth works (pulls a test image — should NOT prompt for credentials):
docker pull 902810393464.dkr.ecr.ap-south-1.amazonaws.com/easyfix/backend:nonexistent 2>&1 | head -3
# Expected: "manifest unknown" or "not found" — that means AUTH succeeded
# but the tag doesn't exist yet (because no workflow has pushed). If you
# get "no basic auth credentials" or "denied: ... no identity" instead,
# the credential helper isn't wired up correctly.
```

### C. Create the deploy directory + bootstrap files

```bash
mkdir -p /opt/easyfix
cd /opt/easyfix
```

**Drop in the compose file** (one-time fetch from the repo):

```bash
curl -fsSL \
  https://raw.githubusercontent.com/Easyfix2021/EasyFix_Backend/QA/deploy/docker-compose.yml \
  -o /opt/easyfix/docker-compose.yml
chown root:root /opt/easyfix/docker-compose.yml
chmod 644 /opt/easyfix/docker-compose.yml
```

(If the repo is private, prepend `-H "Authorization: Bearer <github-pat>"` to the curl. The PAT is only used for THIS one-time fetch — never again.)

**Create the bootstrap `.env`** with placeholder image tags so compose can parse the file before the first deploy populates real ones:

```bash
cat > /opt/easyfix/.env <<'EOF'
# Auto-managed by GitHub Actions — do not edit manually.
# First deploy from each repo overwrites the corresponding line with
# the real qa-<sha> tag.
BACKEND_IMAGE=902810393464.dkr.ecr.ap-south-1.amazonaws.com/easyfix/backend:qa-latest
CRM_UI_IMAGE=902810393464.dkr.ecr.ap-south-1.amazonaws.com/easyfix/crm-ui:qa-latest
EOF
chmod 644 /opt/easyfix/.env
```

These point at `:qa-latest` initially. The first workflow push from each repo replaces them with `:qa-<sha>` for deterministic deploys.

### D. Bootstrap backend runtime secrets

Fetch the env-bootstrap script and run it interactively to populate `/opt/easyfix/backend.env`:

```bash
curl -fsSL \
  https://raw.githubusercontent.com/Easyfix2021/EasyFix_Backend/QA/deploy/bootstrap-env.sh \
  -o /tmp/bootstrap-env.sh

sudo bash /tmp/bootstrap-env.sh
```

The script prompts for one var at a time. Reference list (matches `deploy/bootstrap-env.example`):

| KEY | Value example |
|---|---|
| `DB_HOST` | `111.93.206.91` |
| `DB_PORT` | `3306` |
| `DB_USER` | `easyfix_qa` |
| `DB_PASSWORD` | (the real password — input is masked) |
| `DB_NAME` | `easyfix_core` |
| `JWT_SECRET` | run `openssl rand -hex 32` to generate |
| `JWT_EXPIRY` | `30d` |
| `SUITE_URL` | `https://suite.1office.in` |
| `MS_GRAPH_TENANT_ID` | (from Azure app reg) |
| `MS_GRAPH_CLIENT_ID` | (from Azure app reg) |
| `MS_GRAPH_CLIENT_SECRET` | (from Azure app reg) |
| `MS_GRAPH_SENDER_EMAIL` | `ithelpdesk@easyfix.in` |
| `NOTIFICATIONS_DISABLE` | `true` (KEEP for QA) |
| `WEBHOOKS_DISABLE` | `true` (KEEP for QA) |
| `TEST_EMAILS` | `harshit@channelplay.in` |

Each one goes into `backend.env` (option 2 when prompted).

When the script asks "Apply refreshes now?" — **answer `n`**. The
containers don't exist yet; the first GH Actions deploy creates them
and they'll pick up `backend.env` at first start.

### E. Push to GitHub — trigger first deploy

On your laptop (do BACKEND first so the workflow doesn't try to update an image tag for a missing line):

```bash
# Backend
cd EasyFix_Backend
git checkout QA && git push -u origin QA

# Wait for that workflow to finish, then:

# CRM-UI
cd ../Easyfix_CRM_UI
git checkout QA && git push -u origin QA
```

Watch each at **GitHub → Actions**.

What happens for backend (~3 min cold, ~30 sec warm):
1. GH-hosted runner: lints + node-checks (~30 sec).
2. `docker buildx build` → tags `qa-<sha>` and `qa-latest` → pushes both to ECR.
3. SSM-sends a script to `i-032aa9d2942305364`:
   - Sets `BACKEND_IMAGE` in `/opt/easyfix/.env` to the new SHA tag.
   - `docker compose pull backend` (auth via instance profile + cred helper).
   - `docker compose up -d --no-deps --force-recreate backend`.
   - Polls HEALTHCHECK until "healthy".
4. Smoke test via second SSM call: `curl 127.0.0.1:5100/api/health`.

CRM-UI flow is identical, ~5 min cold (the Next.js build dominates), but builds happen in CI now so the EC2 just pulls.

---

## Day-to-day operations

| Task | How |
|---|---|
| Deploy a change | `git push origin QA` |
| Manually redeploy without a commit | GitHub → Actions → Run workflow → pick QA |
| Rollback to a specific image | Session Manager → `vi /opt/easyfix/.env` → set `BACKEND_IMAGE=...:qa-<old-sha>` → `docker compose up -d --force-recreate backend` |
| Tail backend logs | Session Manager → `docker logs -f easyfix-backend` |
| Tail CRM-UI logs | `docker logs -f easyfix-crm-ui` |
| Rotate a backend secret | Run the env script: `sudo bash /tmp/bootstrap-env.sh` (or fetch fresh — see below). Pick KEY → enter new value → confirm → it auto-restarts the backend container |
| Change `NEXT_PUBLIC_API_URL` (the only build-time UI var) | GitHub → Environment "Organisation Level Secrets" → edit `QA_API_URL` → re-run CRM-UI workflow. Editing `/opt/easyfix/.env` does NOTHING — value is already baked into the bundle |
| List images in ECR | AWS Console → ECR → easyfix/backend (or crm-ui) → see all qa-* tags + their push dates |
| Refetch the env-bootstrap script | `curl -fsSL https://raw.githubusercontent.com/Easyfix2021/EasyFix_Backend/QA/deploy/bootstrap-env.sh -o /tmp/bootstrap-env.sh && sudo bash /tmp/bootstrap-env.sh` |
| See SSM history | AWS Console → Systems Manager → Run Command → Command history (filter by instance) |
| Full audit log | CloudTrail — every `ssm:SendCommand`, every ECR push/pull |

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Workflow fails at "configure-aws-credentials" with `Input required and not supplied: aws-region` | The job is missing `environment: QA` (org-level secrets aren't reachable without it) | Already added in current workflow. Confirm the env name in GitHub is exactly `QA` (case-sensitive). |
| Workflow fails at "Build & push to ECR" with `RepositoryNotFoundException` | ECR repo doesn't exist OR `ECR_REPOSITORY_*` secret has a typo | Verify repo names match exactly: `easyfix/backend`, `easyfix/crm-ui` |
| `docker pull` on EC2 returns "no basic auth credentials" | Credential helper not installed or `~/.docker/config.json` wrong | See §B. Test with `docker pull <ecr-uri>:nonexistent`; should say "manifest unknown" not "no basic auth" |
| `compose up` says "image not found" but ECR has the tag | Instance profile missing `AmazonEC2ContainerRegistryReadOnly` | AWS Console → EC2 → IAM role → Add policy |
| CRM-UI loads but every API call goes to localhost | `QA_API_URL` empty when image was built — workflow's "Validate API URL" step should catch this; if it slipped through, image was built with placeholder | Set `QA_API_URL` correctly in GH → re-run CRM-UI workflow |
| Smoke test fails: connection refused on 5100 | Container crashed on startup — usually a missing env var in `backend.env` | `docker logs easyfix-backend` |
| Disk filling up | Old ECR-pulled images | Workflow auto-prunes (`docker image prune --filter "until=72h"`). Manual: `docker image prune -af` |

---

## Why this architecture

| Concern | Resolved by |
|---|---|
| Source code on EC2 | None — image-only deploy |
| Build tools on EC2 | None — `docker pull` only, no node, no npm, no git |
| Build cache | Lives in GH Actions registry cache; persists across runs |
| Multi-host scaling later | Trivial — second EC2 just `docker compose pull`s the same image |
| Audit | Git log + ECR image manifest history + CloudTrail SSM logs |
| Rollback | Update `BACKEND_IMAGE` in `/opt/easyfix/.env` to an older `qa-<sha>` tag, run `compose up -d` — instant |
| Image promotion to prod (future) | Re-tag the same QA image as `prod-<sha>` in ECR; prod EC2 pulls. No rebuild. |
