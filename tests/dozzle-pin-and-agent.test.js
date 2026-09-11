/**
 * Dozzle: :latest + refresh-on-deploy, and the prod agent wiring
 * (docs/dozzle-agent.md). The file name predates the move off an exact pin.
 *
 * WHY THE REFRESH: `amir20/dozzle:latest` alone never upgraded anything. The
 * deploy's `docker compose up -d dozzle` pulls only an image that is MISSING,
 * so each host kept whatever :latest meant on its first pull — on 2026-09-11 QA
 * was on v10.5.0 and Prod on v10.6.4 while v11.0.0 was out. Every backend
 * deploy now pulls Dozzle explicitly and re-ups it. That refresh talks to
 * Docker Hub, so it must be NON-FATAL and run only after the backend swap is
 * proven: a rate limit or outage there must never fail an app deploy. A dropped
 * `|| echo` would do exactly that and still read fine, so the refresh lines are
 * EXECUTED here with every docker call failing.
 *
 * WHY THE WIRING CHECKS: the prod Dozzle lists the UI host through
 * DOZZLE_REMOTE_AGENT, written into /opt/easyfix/.env by deploy.yml from the
 * PROD_DOZZLE_REMOTE_AGENT repo secret. Ways that breaks production:
 *   - `${DOZZLE_REMOTE_AGENT:?…}` (required) would fail EVERY compose command
 *     on the box while the secret is unset — backend deploys included.
 *   - Splicing the secret into a `run:` script as an Actions expression puts
 *     its raw text into bash before any validation runs (a value containing a
 *     quote executed a command when this was first written). It must arrive
 *     through the step's env:.
 *   - Every other regression is silent: the value never written, written on
 *     QA, written unvalidated into the root script, or Dozzle never re-upped
 *     (so neither a new image nor a new address reaches the host). The deploy
 *     stays green in all four, so these tests render the remote script the way
 *     the runner builds it and read what it would do.
 *
 * The UI host's agent service lives in the CRM/Client UI repos and is checked
 * there (Easyfix_CRM_UI tests/dozzle-agent-compose.test.js). Not cross-read
 * here on purpose: CI clones the CRM's default branch, so a cross-repo
 * assertion would turn every backend deploy red until the CRM change landed.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..');
const load = (rel) => yaml.load(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const COMPOSES = ['deploy/docker-compose.yml', 'deploy/docker-compose.prod-backend.yml'];

test('every Dozzle image is amir20/dozzle:latest, on QA and Prod', () => {
  for (const rel of COMPOSES) {
    const found = Object.entries(load(rel).services).filter(([, s]) => /^amir20\/dozzle\b/.test(s.image));
    // Locator first: a renamed image or a moved service must not read as a pass.
    assert.ok(found.length > 0, `${rel}: no amir20/dozzle service found — the check located nothing`);
    for (const [name, s] of found) assert.equal(s.image, 'amir20/dozzle:latest', `${rel} → ${name}`);
  }
});

test('prod Dozzle takes the agent address with an EMPTY default, never a required one', () => {
  const env = load('deploy/docker-compose.prod-backend.yml').services.dozzle.environment;
  assert.equal(env.DOZZLE_REMOTE_AGENT, '${DOZZLE_REMOTE_AGENT:-}');
});

const deploySteps = () => load('.github/workflows/deploy.yml').jobs.deploy.steps;

test('PROD_DOZZLE_REMOTE_AGENT is a secret that reaches bash through env:, never as an expression in run:', () => {
  const steps = deploySteps();
  const spliced = steps.filter((s) => /(vars|secrets)\.PROD_DOZZLE_REMOTE_AGENT/.test(s.run || ''));
  assert.deepEqual(spliced.map((s) => s.name), [], 'spliced into a run: script — pass it via the step env instead');
  // A secret, not a variable: the repo is public and a variable's value is
  // printed unmasked in the step's env header of every deploy log.
  const carrier = steps.find((s) => s.env && s.env.PROD_DOZZLE_REMOTE_AGENT === '${{ secrets.PROD_DOZZLE_REMOTE_AGENT }}');
  assert.ok(carrier, 'no deploy step carries secrets.PROD_DOZZLE_REMOTE_AGENT in its env');
  assert.match(carrier.run, /DOZZLE_REMOTE_AGENT="\$\{PROD_DOZZLE_REMOTE_AGENT:-\}"/, `${carrier.name} never reads the env value`);
});

// Builds the SSM step's REMOTE_SCRIPT exactly as the runner does — Actions
// expressions substituted, the secret arriving through env — and stops at the
// AWS transport. The heredoc escapes every $( and backtick meant for the host,
// so bash only expands variables here, as it does on the runner.
function renderRemote(envName, secret) {
  const step = deploySteps().find((s) => s.env && 'PROD_DOZZLE_REMOTE_AGENT' in s.env);
  const run = step.run
    .replace(/\$\{\{\s*needs\.build-and-push\.outputs\.env_name\s*\}\}/g, envName)
    .replace(/\$\{\{[^}]*\}\}/g, 'STUB');
  const cut = run.indexOf('SCRIPT_B64=$(printf');
  assert.ok(cut > 0, 'the SSM transport line was not found — the render located nothing');
  const out = execFileSync('bash', ['-c', `${run.slice(0, cut)}\nprintf '\\n@@REMOTE@@\\n%s' "$REMOTE_SCRIPT"`], {
    encoding: 'utf8', env: { PATH: process.env.PATH, PROD_DOZZLE_REMOTE_AGENT: secret },
  });
  const [log, remote] = out.split('\n@@REMOTE@@\n');
  assert.ok(remote && remote.includes('cd /opt/easyfix'), 'the render produced no remote script');
  return { log, remote };
}

const REUP = /docker compose up -d --no-deps dozzle\b/;

test('the address lands in /opt/easyfix/.env on Production only, validated, before Dozzle is re-upped', () => {
  const DEL = "sed -i '/^DOZZLE_REMOTE_AGENT=/d' /opt/easyfix/.env";
  const ADD = 'echo "DOZZLE_REMOTE_AGENT=10.30.2.99:7007" >> /opt/easyfix/.env';
  const ANY_ADD = /echo "DOZZLE_REMOTE_AGENT=[^"]/; // unset renders as `echo "DOZZLE_REMOTE_AGENT="`, behind `[[ -n "" ]]`

  const { remote } = renderRemote('production', '10.30.2.99:7007');
  assert.ok(remote.includes(ADD), 'Production: the address is never written to .env');
  assert.ok(remote.includes(DEL) && remote.indexOf(DEL) < remote.indexOf(ADD), 'Production: the stale line must be deleted BEFORE the append');
  assert.match(remote, REUP, 'Dozzle is no longer re-upped — a new image or address never reaches the host');
  assert.ok(remote.indexOf(ADD) < remote.search(REUP), '.env must be written before Dozzle is re-upped');

  for (const [label, envName, secret] of [['Production, secret unset', 'production', ''], ['QA, secret set', 'qa', '10.30.2.99:7007']]) {
    const r = renderRemote(envName, secret);
    assert.ok(r.remote.includes(DEL), `${label}: a stale DOZZLE_REMOTE_AGENT line is never removed`);
    assert.doesNotMatch(r.remote, ANY_ADD, `${label}: an agent address is written`);
  }

  // Harmless payload: even if the guard broke, it would only print.
  const bad = renderRemote('production', 'x";echo INJECTED;"');
  assert.match(bad.log, /::warning::PROD_DOZZLE_REMOTE_AGENT/, 'an invalid value is ignored silently');
  assert.doesNotMatch(bad.remote, /INJECTED/, 'an invalid value reached the root script on the host');
});

test('every deploy refreshes Dozzle AFTER the backend swap is proven, and a Docker Hub failure cannot fail it', () => {
  for (const envName of ['qa', 'production']) {
    const lines = renderRemote(envName, '').remote.split('\n');
    const at = (re, what) => {
      const i = lines.findIndex((l) => !/^\s*#/.test(l) && re.test(l));
      assert.ok(i >= 0, `${envName}: ${what} not found in the remote script — the check located nothing`);
      return i;
    };
    const proof = at(/Verified running image/, 'the running-image proof');
    const pull = at(/docker compose pull\b.*\bdozzle\b/, 'the Dozzle pull');
    const up = at(REUP, 'the Dozzle up');
    const ver = at(/org\.opencontainers\.image\.version/, 'the running-version log line');
    const done = at(/EASYFIX-DEPLOY-COMPLETE/, 'the sentinel');
    assert.ok(proof < pull && pull < up && up < ver && ver < done,
      `${envName}: expected swap proof → pull → up → version log → sentinel, got lines ${[proof, pull, up, ver, done]}`);

    // Run exactly those lines under the remote script's own shell options, with
    // every docker call failing (a Docker Hub outage, a rate limit). Functions
    // shadow docker/timeout, so nothing real runs.
    const block = lines.slice(pull, ver + 1).filter((l) => !/^\s*#/.test(l)).join('\n');
    const r = spawnSync('bash', ['-c', [
      'set -euo pipefail',
      'docker() { echo "CALL docker $*"; return 1; }',
      'timeout() { echo "CALL timeout $1"; shift; "$@"; }',
      block,
      'echo SURVIVED',
    ].join('\n')], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
    assert.equal(r.status, 0, `${envName}: a failing docker aborted the remote script:\n${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /SURVIVED/);
    // Bounded: a stalled pull must not outlast the runner's SSM poll.
    assert.match(r.stdout, /CALL timeout \d+\nCALL docker compose pull\b[^\n]*\bdozzle\b/, `${envName}: the pull is not wrapped in timeout`);
    assert.match(r.stdout, /CALL timeout \d+\nCALL docker compose up -d --no-deps dozzle\b/, `${envName}: the up is not wrapped in timeout`);
  }
});
