#!/usr/bin/env node
/**
 * Detects drift between `.env.example` (the committed contract) and
 * `.env` (the local / deployed copy). Read-only.
 *
 * Why this exists: env keys added to .env.example over time stop
 * propagating to existing .env files unless someone manually copies
 * them. Months later a feature silently no-ops in dev because
 * `process.env.X` is undefined. Surfacing this drift at `npm run
 * verify:env` time (and as part of `verify:all` pre-deploy) catches
 * the gap before it becomes a "works on my machine" bug.
 *
 * Three categories of finding:
 *   1. MISSING  — in .env.example uncommented, not in .env at all.
 *                 Action required: add to .env. Exits non-zero.
 *   2. DISABLED — in .env.example uncommented, in .env COMMENTED.
 *                 Informational: someone deliberately opted out
 *                 locally (e.g. auto-assignment weights, prod URLs).
 *                 Not a failure.
 *   3. EXTRA    — in .env, not in .env.example at all.
 *                 Informational: legacy or hand-added local key.
 *                 Not a failure.
 *
 * Comments and blank lines are ignored. Key parsing uses a strict
 * `^[A-Z_][A-Z0-9_]*=` regex to match dotenv conventions; lowercase
 * or quoted-key formats won't be picked up (and shouldn't be in
 * either file per CLAUDE.md naming rules).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ENV_PATH         = path.join(ROOT, '.env');
const ENV_EXAMPLE_PATH = path.join(ROOT, '.env.example');

const KEY_LINE     = /^([A-Z_][A-Z0-9_]*)\s*=/;
const COMMENTED_KEY = /^#\s*([A-Z_][A-Z0-9_]*)\s*=/;

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`✗ File not found: ${filePath}`);
    process.exit(2);
  }
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  const uncommented = new Set();
  const commented   = new Set();
  for (const line of lines) {
    let m;
    if ((m = line.match(KEY_LINE))) {
      uncommented.add(m[1]);
    } else if ((m = line.match(COMMENTED_KEY))) {
      commented.add(m[1]);
    }
  }
  return { uncommented, commented };
}

const example = parseEnvFile(ENV_EXAMPLE_PATH);
const local   = parseEnvFile(ENV_PATH);

// Diff:
const missing  = [...example.uncommented].filter((k) => !local.uncommented.has(k) && !local.commented.has(k));
const disabled = [...example.uncommented].filter((k) => !local.uncommented.has(k) &&  local.commented.has(k));
const extra    = [...local.uncommented].filter((k) => !example.uncommented.has(k) && !example.commented.has(k));

missing.sort();
disabled.sort();
extra.sort();

console.log(`Env drift report — .env.example vs .env`);
console.log(`  .env.example uncommented keys : ${example.uncommented.size}`);
console.log(`  .env         uncommented keys : ${local.uncommented.size}`);
console.log(`  .env         commented keys   : ${local.commented.size}`);
console.log('');

if (missing.length === 0) {
  console.log(`✓ No truly-missing keys.`);
} else {
  console.log(`✗ ${missing.length} key(s) in .env.example but ABSENT from .env (action required):`);
  for (const k of missing) console.log(`    - ${k}`);
}
console.log('');

if (disabled.length > 0) {
  console.log(`ℹ ${disabled.length} key(s) in .env.example but COMMENTED OUT in .env (intentional local override — informational):`);
  for (const k of disabled) console.log(`    - ${k}`);
  console.log('');
}

if (extra.length > 0) {
  console.log(`ℹ ${extra.length} key(s) in .env but NOT in .env.example (legacy / hand-added — informational):`);
  for (const k of extra) console.log(`    - ${k}`);
  console.log('');
}

if (missing.length > 0) {
  console.log(`Fix: copy the relevant defaults from .env.example into .env, then re-run \`npm run verify:env\`.`);
  process.exit(1);
}

process.exit(0);
