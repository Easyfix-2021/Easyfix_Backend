'use strict';
/*
 * No workflow run: script may approach GitHub's 21,000-character expression cap.
 *
 * ─── THE INCIDENT (2026-09-11) ─────────────────────────────────────────────
 *
 * A run: that contains ${{ }} is evaluated as ONE expression template, and
 * GitHub rejects the WHOLE workflow once that string passes 21,000 characters.
 * The failure is total and quiet: "This run likely failed because of a
 * workflow file issue", no jobs, no logs — and because GitHub can no longer
 * read the branch filter, a failed run appears on every push to ANY branch.
 * Comments added inside deploy.yml's "SSM compose pull + up" script took it
 * from 18,807 to 21,128 characters and stopped every backend deploy. js-yaml
 * parsed the file happily; only this length check would have caught it.
 *
 * The cap here is 20,000, not 21,000, so the next edit gets a red test in CI
 * rather than a dead pipeline on the push that ships it. Long explanations
 * belong in YAML comments above the step, which do not count.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const GITHUB_CAP = 21000;
const LIMIT = 20000;
const DIR = path.join(__dirname, '..', '.github', 'workflows');

function runScripts() {
  const out = [];
  for (const f of fs.readdirSync(DIR).filter((n) => /\.ya?ml$/.test(n))) {
    const doc = yaml.load(fs.readFileSync(path.join(DIR, f), 'utf8'));
    for (const [jobName, job] of Object.entries(doc.jobs || {})) {
      for (const step of job.steps || []) {
        if (typeof step.run === 'string' && step.run.includes('${{')) {
          out.push({ where: `${f} › ${jobName} › ${step.name || step.id || '(unnamed)'}`, length: step.run.length });
        }
      }
    }
  }
  return out;
}

test(`every expression-bearing run: stays under ${LIMIT} characters (GitHub rejects the workflow at ${GITHUB_CAP})`, () => {
  const scripts = runScripts();
  // Silence is the passing signal below, so prove the scan found its subject.
  assert.ok(scripts.some((s) => /deploy\.yml › .* › SSM compose pull \+ up/.test(s.where)),
    `expected to find deploy.yml's SSM script among ${scripts.length} expression-bearing run: blocks`);
  const over = scripts.filter((s) => s.length > LIMIT);
  assert.deepEqual(over, [], over.map((s) => `${s.where}: ${s.length} chars`).join('\n')
    + '\nMove long comments out of the run: block into YAML comments above the step.');
});
