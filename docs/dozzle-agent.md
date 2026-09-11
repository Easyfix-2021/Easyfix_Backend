# Dozzle — one Prod view for the BE and UI hosts

Prod Dozzle (`http://10.30.2.40:8888`, on the prod BE EC2) also lists the prod
UI EC2's containers (`easyfix-crm-ui`, `easyfix-client-ui`) through a **Dozzle
agent** running on the UI host. Every Dozzle image is pinned to
`amir20/dozzle:v11.0.0`. `:latest` never upgraded anything: `compose up` only
pulls a missing image, so QA was stuck on v10.5.0 and Prod on v10.6.4. QA runs
on a single host, so it needs no agent — its Dozzle already sees `crm-ui`.

| Where | What |
|---|---|
| `EasyFix_Backend/deploy/docker-compose.yml` | QA Dozzle, pinned |
| `EasyFix_Backend/deploy/docker-compose.prod-backend.yml` | Prod Dozzle, pinned, `DOZZLE_REMOTE_AGENT: ${DOZZLE_REMOTE_AGENT:-}` |
| `EasyFix_Backend/.github/workflows/deploy.yml` | Prod only: syncs `DOZZLE_REMOTE_AGENT=` in `/opt/easyfix/.env` from the `PROD_DOZZLE_REMOTE_AGENT` repo **secret** (unset ⇒ line removed ⇒ backend host only) |
| `Easyfix_CRM_UI` + `Easyfix_client_UI` `deploy/docker-compose.prod-frontend.yml` | `dozzle-agent` service, TCP 7007 |
| `Easyfix_CRM_UI/.github/workflows/deploy.yml` | Prod only: `docker compose up -d --no-deps dozzle-agent` (non-fatal) |

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

0. **Before the CRM change reaches `Production`, audit the security groups.**
   AWS Console → EC2 → the instance whose ID is the `PROD_FRONTEND_INSTANCE_ID`
   secret → *Security* tab. For **every** attached group, read every inbound
   rule. None may admit TCP 7007: check *All traffic*, *All TCP*, any port
   range covering 7007, and sources such as the VPC/VPN CIDR, `0.0.0.0/0`, or a
   group other instances share (including a self-reference). Narrow any match
   first. Note the *Private IPv4 address* on the *Details* tab.
1. **Mirror the compose into `Easyfix_client_UI`.** Copy
   `deploy/docker-compose.prod-frontend.yml` byte for byte. Both UI repos ship
   it and the last deploy wins. Unmirrored, a client-UI deploy writes the old
   file back: the agent keeps running, but the host file drifts.
2. **Deploy `Easyfix_CRM_UI` → Production.** This starts `easyfix-dozzle-agent`.
   Then, **from a VPN laptop**, run `nc -zv -w5 <ui-ip> 7007`. It must time
   out. That only counts if the laptop reaches the host at all, so check a
   port it should reach first, such as `nc -zv -w5 <ui-ip> 5180` (crm-ui). If
   that also times out, the 7007 result proves nothing. If 7007 connects, a
   rule step 0 missed is exposing the agent: run
   `sudo docker rm -f easyfix-dozzle-agent` on the UI host and go back to
   step 0.
3. **Add the security-group rule.** On the UI host's group, add Custom TCP
   **7007** with source **`10.30.2.40/32`** (the BE host). Use the BE host's
   security group as the source only if no other instance uses it.
4. **Pre-flight from the BE host.** Run
   `sudo docker run --rm amir20/dozzle:v11.0.0 agent-test <ui-ip>:7007`. It
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
   `up -d dozzle` recreates Dozzle because the definition changed (the new tag,
   the new `.env` line).

## Verify

```bash
curl -s http://10.30.2.40:8888/api/version            # <pre>v11.0.0</pre>  (QA: 10.30.2.30)
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

## Rollback

- **Agent only**: delete the secret and redeploy the backend. The line is
  removed and Dozzle comes back single-host. Faster, on the BE host (delete
  the secret anyway, or the next deploy writes the line back):
  `sudo sed -i '/^DOZZLE_REMOTE_AGENT=/d' /opt/easyfix/.env && cd /opt/easyfix && sudo docker compose up -d --no-deps dozzle`.
  Then `sudo docker rm -f easyfix-dozzle-agent` on the UI host, drop the 7007
  rule, and revert the compose and workflow lines.
- **Version**: put the old tag back in the compose files and redeploy. Dozzle
  keeps no state here (no volume), so downgrading is safe.

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
