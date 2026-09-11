# Dozzle — one Prod view for the BE and UI hosts

Prod Dozzle (`http://10.30.2.40:8888`, on the prod BE EC2) also lists the prod
UI EC2's containers (`easyfix-crm-ui`, `easyfix-client-ui`) through a **Dozzle
agent** on the UI host, once the rollout below is done. QA runs on a single
host, so it needs no agent — its Dozzle already sees `crm-ui`.

| Where | What |
|---|---|
| `EasyFix_Backend/deploy/docker-compose.yml` | QA Dozzle |
| `EasyFix_Backend/deploy/docker-compose.prod-backend.yml` | Prod Dozzle, `DOZZLE_REMOTE_AGENT: ${DOZZLE_REMOTE_AGENT:-}` |
| `EasyFix_Backend/.github/workflows/deploy.yml` | QA + Prod: refreshes Dozzle. Prod only: syncs `DOZZLE_REMOTE_AGENT=` in `/opt/easyfix/.env` from the `PROD_DOZZLE_REMOTE_AGENT` repo **secret** (unset ⇒ line removed ⇒ backend host only) |
| `Easyfix_CRM_UI` + `Easyfix_client_UI` `deploy/docker-compose.prod-frontend.yml` | `dozzle-agent` service, TCP 7007. Byte-identical in both repos (a CRM test fails otherwise) |
| `Easyfix_CRM_UI/.github/workflows/deploy.yml` | Prod only, while the repo **variable** `PROD_DOZZLE_AGENT_ENABLED` is `true`: refreshes `dozzle-agent` |

## Tag policy: `:latest`, refreshed on deploy

Every Dozzle image is `amir20/dozzle:latest`. The tag alone upgrades nothing:
`compose up` pulls only a missing image, which is how QA sat on v10.5.0 and
Prod on v10.6.4 while v11.0.0 was out. So the deploys pull it:

- **Every backend deploy** (QA and Prod) runs `docker compose pull dozzle`,
  then `up -d --no-deps dozzle`, which recreates only if the image changed. It
  runs after the backend swap is verified and logs
  `Dozzle running: <version> <image id>`.
- **The CRM Production deploy** does the same for `dozzle-agent`, but only
  while `PROD_DOZZLE_AGENT_ENABLED` is `true`.
- Both are **non-fatal** and time-boxed. A Docker Hub outage or rate limit
  prints a `⚠` line, and the deploy carries on with the image the host has.
- Nothing refreshes the UI host's own `dozzle` server (EasyFix Prod-UI, :8888).

**Trade-off.** The server (BE host) and the agent (UI host) refresh on
different deploys, and Dozzle promises no compatibility between different
versions of the two. After a new **major** release, the UI host can drop out
of Prod Dozzle until the CRM deploys again. The alternative is
`amir20/dozzle:v11` in place of `:latest` (Docker Hub moves `v11` through
every v11.x release, never to v12). That's a one-word change per image line,
plus the two tests.

## Rollout — in this order

The order matters for two reasons.

- **The agent is a control surface, not just a log feed.** It accepts any stock
  Dozzle (its TLS certificate ships inside every public image, and all three
  repos are public), and it will stop, remove or exec into the UI containers
  for any caller. Security-group rules only add up, so an existing broad rule
  exposes 7007 the moment the agent starts.
- **An address that doesn't answer is slow, not harmless.** Security groups
  drop packets rather than refuse them, so a missing rule, or a UI host that
  is stopped or replaced, leaves every dial hanging. Prod Dozzle re-dials the
  address on every page load and every `/api/events/stream`, and waits up to
  `DOZZLE_TIMEOUT` (10s) before listing any container. Log views can queue
  behind it too. So the secret goes in last. (A stopped agent on a running
  host is refused at once, and the UI host just drops out of the list.)

0. **Before enabling the agent (step 2), audit the security groups.**
   AWS Console → EC2 → the instance whose ID is the `PROD_FRONTEND_INSTANCE_ID`
   secret → *Security* tab. For **every** attached group, read every inbound
   rule. None may admit TCP 7007: check *All traffic*, *All TCP*, any port
   range covering 7007, and sources such as the VPC/VPN CIDR, `0.0.0.0/0`, or a
   group other instances share (including a self-reference). Narrow any match
   first. Note the *Private IPv4 address* on the *Details* tab.
1. **Push `Easyfix_client_UI` before `Easyfix_CRM_UI`, to QA and to
   Production.** Both ship `deploy/docker-compose.prod-frontend.yml` and the
   last deploy wins. The CRM's tests (deploy precheck and PR CI) clone
   client-UI's target branch and fail on any byte of difference. A client-UI deploy writes
   the compose but never starts or removes the agent.
2. **Enable the agent.** GitHub → `Easyfix_CRM_UI` → Settings → Secrets and
   variables → Actions → *Variables* → New repository variable
   `PROD_DOZZLE_AGENT_ENABLED` = `true`. Then deploy `Easyfix_CRM_UI` →
   Production, or re-run its last Production deploy. Until the variable is
   set, Production deploys never start the agent. The deploy log shows
   `dozzle-agent running: <version> <image id>`.
   Then, **from a VPN laptop**, run `nc -zv -w5 <ui-ip> 7007`. It must time
   out. That only counts if the laptop reaches the host at all, so check a
   port it should reach first, such as `nc -zv -w5 <ui-ip> 5180` (crm-ui). If
   that also times out, the 7007 result proves nothing. If 7007 connects, a
   rule step 0 missed is exposing the agent. Delete the variable, run
   `sudo docker rm -f easyfix-dozzle-agent` on the UI host, and go back to
   step 0.
3. **Add the security-group rule.** On the UI host's group, add Custom TCP
   **7007** with source **`10.30.2.40/32`** (the BE host). Use the BE host's
   security group as the source only if no other instance uses it.
4. **Pre-flight from the BE host.** Run
   `sudo docker run --rm amir20/dozzle:latest agent-test <ui-ip>:7007`. It
   must log `Successfully connected to agent` with an `id`, and that id must
   **differ** from `sudo docker info --format '{{.ID}}'` on the BE host. The
   same id means both EC2s were cloned with one Docker engine ID. Dozzle would
   silently drop the UI host, so fix that first (see Troubleshooting).
5. **Only now, add the secret.** GitHub → `EasyFix_Backend` → Settings →
   Secrets and variables → Actions → *Secrets* → New repository secret
   `PROD_DOZZLE_REMOTE_AGENT` = `<ui-ip>:7007`. Use a secret, not a variable:
   a variable's value is printed unmasked in the public deploy log. Allowed
   characters are `[A-Za-z0-9.:|,_-]`; anything else is ignored with a
   warning.
6. **Deploy `EasyFix_Backend` → QA, then → Production.** QA can go any time;
   it has no agent. The Production deploy applies the secret. Its
   `up -d dozzle` recreates Dozzle because the definition changed (the new
   `.env` line).

## Verify

```bash
curl -s http://10.30.2.40:8888/api/version            # newest release, e.g. <pre>v11.0.0</pre>  (QA: 10.30.2.30)
curl -sN -m 20 http://10.30.2.40:8888/api/events/stream > /tmp/ev.txt   # exit 28 at -m is expected
grep -ao '"host":"[^"]*"' /tmp/ev.txt | sort | uniq -c  # TWO host ids
grep -aco '"name":"easyfix-crm-ui"' /tmp/ev.txt         # >= 1
```

The UI sidebar should show **EasyFix Prod-BE** and **EasyFix Prod-UI**, with
containers listed within a second or two of opening the page. Our log-API
recipe (`/api/hosts/<HOST>/containers/<ID>/logs?stdout=1&stderr=1&everything=true`)
is unchanged, but Prod now has two host UUIDs: use the one that owns the
container.

## Troubleshooting

If Dozzle takes about 10s to list anything, or the UI host is missing, read
the `easyfix-dozzle` logs:

- `error fetching host info for agent`: the address is set but the agent
  doesn't answer. Check the IP, the rule, and whether the agent is running (on
  the UI host: `sudo docker ps --filter name=dozzle-agent`). If pages are slow
  too, packets are being dropped (the rule, or the UI host is down). Until
  that's fixed or rolled back (below), every page load pays the 10s wait.
- `An agent with an existing ID was found`: both EC2s were cloned with the
  same Docker engine ID. On the UI host, run
  `sudo rm /var/lib/docker/engine-id && sudo systemctl restart docker`. This
  restarts crm-ui and client-ui, so do it off-peak.
- UI host gone right after a backend deploy, and the two `running:` log lines
  show different versions: the server moved ahead of the agent (see
  Trade-off). Re-run the CRM Production deploy.

## Rollback

- **Agent only**: delete the secret and redeploy the backend. The line is
  removed and Dozzle comes back single-host. Faster, on the BE host (delete
  the secret anyway, or the next deploy writes the line back):
  `sudo sed -i '/^DOZZLE_REMOTE_AGENT=/d' /opt/easyfix/.env && cd /opt/easyfix && sudo docker compose up -d --no-deps dozzle`.
  Then delete the `PROD_DOZZLE_AGENT_ENABLED` variable, run
  `sudo docker rm -f easyfix-dozzle-agent` on the UI host, and drop the 7007
  rule. Deleting the variable only stops the refresh. It does not remove a
  running agent, and while it's `true` every CRM Production deploy starts the
  agent again.
- **Version**: replace `:latest` with an exact tag, such as `:v11.0.0`, in
  every compose file (both UI repos, kept byte-identical) and the two tests,
  then redeploy. The refresh pulls that tag instead. Dozzle keeps no state
  here (no volume), so downgrading is safe.

## v10.5.0 / v10.6.4 → v11.0.0: what touches us

- **Our API routes are unchanged**: `/api/events/stream`,
  `/api/hosts/{host}/containers/{id}/logs` (`stdout`/`stderr`/`everything`),
  and `/api/version`. The stream adds `server-version` and `ping` events and
  sends smaller stat payloads.
- **Stopped containers still list**, including the `easyfix-*-logs-*` archives.
- **Env var names are unchanged**: `DOZZLE_HOSTNAME`, `DOZZLE_REMOTE_AGENT`,
  and the agent's `DOZZLE_AGENT_ADDR` (default `:7007`).
- **Agent TLS**: mutual TLS using the certificate built into the image, so
  there's nothing to configure. Optional hardening is your own
  `DOZZLE_CERT`/`DOZZLE_KEY` on **both** sides.
- **Image-update checks (new since v10.9.0)** run automatically. They're
  display-only because actions are off. Set `DOZZLE_IMAGE_CHECK_MODE=off` if
  the registry lookups are noisy.
- **Breaking changes don't apply to us**: the only ones in this range are
  auth-only (v10.7.5 roles, the v11 one-time sign-out, GitHub/OIDC login), and
  we run no auth provider.
