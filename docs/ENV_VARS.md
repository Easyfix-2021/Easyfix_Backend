# Adding / updating environment variables

This is the operations runbook for env-var changes on the deployed stack.
For the full server bootstrap see [`AWS_QA_BOOTSTRAP.md`](./AWS_QA_BOOTSTRAP.md).

## Where each var lives

| Variable kind | Where | When read | Examples |
|---|---|---|---|
| Backend runtime secrets | `/opt/easyfix/backend.env` (chmod 600) on EC2 | Read by Node via `dotenv` when the backend container starts | `DB_PASSWORD`, `JWT_SECRET`, `MS_GRAPH_*`, `SUITE_URL`, `NOTIFICATIONS_DISABLE`, `WEBHOOK_OUTBOUND_ENABLED`, `TEST_EMAILS` |
| Image-tag pointers (workflow-managed) | `/opt/easyfix/.env` (chmod 644) on EC2 | At `docker compose pull/up` time | `BACKEND_IMAGE`, `CRM_UI_IMAGE` — auto-updated by GitHub Actions on every deploy. **Never edit these manually.** |
| CI build-args (CRM-UI bundle) | **GitHub Environment "Organisation Level Secrets"** | At CI Docker build time, passed via `--build-arg` | `QA_API_URL` → baked into static JS chunks |
| CI auth + targets | **GitHub Environment "Organisation Level Secrets"** | At CI runtime | `AWS_*`, `QA_INSTANCE_ID`, `ECR_*`, `MAIL_*` |

**App secrets never go into GitHub Secrets.** They live on the EC2 only,
edited via the script below. The principle is "anything an attacker
breaching the GitHub repo could exfiltrate goes one layer down."

## Adding or updating a var (interactive — recommended)

The repo ships a script that prompts for one var at a time and queues
container restarts so a multi-edit session only bounces each service
once. Run it on the EC2 (Session Manager from the AWS Console works
without any SSH key):

```bash
sudo bash /opt/easyfix/repos/EasyFix_Backend/deploy/bootstrap-env.sh
```

Walk-through of a typical session (rotating two secrets in one go):

```
$ sudo bash /opt/easyfix/repos/EasyFix_Backend/deploy/bootstrap-env.sh

EasyFix env-var manager (batch mode)

  ● compose / build-args (.env)         /opt/easyfix/.env  (1 keys)
  ● backend runtime secrets (backend.env)  /opt/easyfix/backend.env  (12 keys)

Add or update one var per round. Press Enter on a blank KEY to finish.
Restarts are deferred until the end so multiple edits → one restart per service.

Env var KEY (or blank to finish): DB_PASSWORD
'DB_PASSWORD' currently exists in:
  • /opt/easyfix/backend.env       value: *** (24 chars, masked)

What do you want to do?
  1) Update value in backend.env
  9) Cancel this round
Choice [1]: 1

New value for DB_PASSWORD (input hidden):
Confirm value:

About to update:
  Key:   DB_PASSWORD
  File:  /opt/easyfix/backend.env
Proceed? [y/N] y
✓ Wrote DB_PASSWORD to /opt/easyfix/backend.env

Add/update another var? [y/N] y

Env var KEY (or blank to finish): JWT_SECRET
… (same flow)
✓ Wrote JWT_SECRET to /opt/easyfix/backend.env

Add/update another var? [y/N] n

✓ Made 2 change(s).

Pending refreshes:
  • backend → recreate container

Apply refreshes now? [y/N] y
▶ Recreating backend container
[+] Running 1/1
 ✔ Container easyfix-backend  Started
✓ All affected containers refreshed
```

Both writes happened, but the backend container restarted **once** — not
twice. That dedup is what makes the batch model worth it.

## What restarts when

The script picks the right action automatically:

| You changed | Auto-action at end of session |
|---|---|
| Any var in `backend.env` | `docker compose up -d --force-recreate backend` |
| `NEXT_PUBLIC_*` in `.env` | `docker compose build crm-ui` + `up -d --force-recreate crm-ui` (build-time bake) |
| Other var in `.env` | Asks once which service(s) — answer applies to the rest of the session |
| Same var across multiple rounds | Last value wins; restart still happens once |

## Adding a brand-new var

Same script. When you enter a key it doesn't recognise, it asks which
file to put it in:

```
'NEW_FEATURE_FLAG' is not present in any env file.
Which file?
  1) .env          (build-args / compose interpolation)
  2) backend.env   (backend runtime secrets)
  9) Cancel this round
Choice [2]:
```

Pick `backend.env` if it's a runtime config or secret. Pick `.env` only
if it's a build-time variable (almost always `NEXT_PUBLIC_*` for the UI).

## How does the backend code read these?

The compose file mounts `backend.env` via `env_file:` — Docker injects
each line as a process env var. Inside the Node app, `dotenv` (loaded
in `server.js`) makes them available as `process.env.DB_PASSWORD` etc.
You can also reference them in any service module without touching the
loader:

```js
// inside any service file
const dbHost = process.env.DB_HOST;
```

A new code reference works as soon as the backend container restarts —
no separate registration step.

## Manual override (skip the script)

If you really want to edit by hand:

```bash
sudo vi /opt/easyfix/backend.env
sudo cd /opt/easyfix && docker compose up -d --force-recreate backend
```

Risks:
- No automatic deduplication of restarts
- No masked-input safety (your secret may end up in shell history)
- Easy to forget the restart

The script handles all three. Use it.

## Reference list of currently-known vars

See [`/deploy/bootstrap-env.example`](../deploy/bootstrap-env.example).
That file is documentation only — the script does NOT read it. It exists
so you have a checklist when bootstrapping a brand-new EC2.

## Where the bootstrap-env.sh script itself lives

- **In the repo:** `EasyFix_Backend/deploy/bootstrap-env.sh`
- **On the EC2 (after first deploy):** `/opt/easyfix/repos/EasyFix_Backend/deploy/bootstrap-env.sh`
- **On the EC2 (before first deploy):** fetch it once via:
  ```bash
  curl -fsSL \
    https://raw.githubusercontent.com/Easyfix2021/EasyFix_Backend/QA/deploy/bootstrap-env.sh \
    -o /tmp/bootstrap-env.sh
  sudo bash /tmp/bootstrap-env.sh
  ```

If the script ever gets deleted from the EC2, refetch with the same curl
command. It's stateless — it only reads/writes `/opt/easyfix/{.env,backend.env}`.
