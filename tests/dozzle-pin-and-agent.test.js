/**
 * Dozzle: exact image pin + the prod agent wiring (docs/dozzle-agent.md).
 *
 * WHY THE PIN: `amir20/dozzle:latest` never upgraded anything. The deploy's
 * `docker compose up -d dozzle` pulls only an image that is MISSING, so each
 * host kept whatever :latest meant on its first pull — on 2026-09-11 QA was on
 * v10.5.0 and Prod on v10.6.4, both "latest". An exact tag is the only way a
 * version bump reaches a host, and QA must run the tag Prod is about to get.
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
 *     (so neither a new tag nor a new address reaches the host). The deploy
 *     stays green in all four, so the last test renders the remote script the
 *     way the runner builds it and reads what it would do.
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
const { execFileSync } = require('child_process');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..');
const load = (rel) => yaml.load(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const COMPOSES = ['deploy/docker-compose.yml', 'deploy/docker-compose.prod-backend.yml'];

test('every Dozzle image is one exact version tag, identical on QA and Prod', () => {
  const tags = new Set();
  for (const rel of COMPOSES) {
    const found = Object.entries(load(rel).services).filter(([, s]) => /^amir20\/dozzle\b/.test(s.image));
    // Locator first: a renamed image or a moved service must not read as a pass.
    assert.ok(found.length > 0, `${rel}: no amir20/dozzle service found — the check located nothing`);
    for (const [name, s] of found) {
      assert.match(s.image, /^amir20\/dozzle:v\d+\.\d+\.\d+$/, `${rel} → ${name}: "${s.image}" is not an exact vX.Y.Z tag`);
      tags.add(s.image);
    }
  }
  assert.equal(tags.size, 1, `QA and Prod must run the same Dozzle: ${[...tags].join(' vs ')}`);
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

test('the address lands in /opt/easyfix/.env on Production only, validated, before Dozzle is re-upped', () => {
  const DEL = "sed -i '/^DOZZLE_REMOTE_AGENT=/d' /opt/easyfix/.env";
  const ADD = 'echo "DOZZLE_REMOTE_AGENT=10.30.2.99:7007" >> /opt/easyfix/.env';
  const ANY_ADD = /echo "DOZZLE_REMOTE_AGENT=[^"]/; // unset renders as `echo "DOZZLE_REMOTE_AGENT="`, behind `[[ -n "" ]]`
  const REUP = /for aux in dozzle; do[\s\S]*?docker compose up -d --no-deps "\$aux"/;

  const { remote } = renderRemote('production', '10.30.2.99:7007');
  assert.ok(remote.includes(ADD), 'Production: the address is never written to .env');
  assert.ok(remote.includes(DEL) && remote.indexOf(DEL) < remote.indexOf(ADD), 'Production: the stale line must be deleted BEFORE the append');
  assert.match(remote, REUP, 'Dozzle is no longer re-upped — a new tag or address never reaches the host');
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
