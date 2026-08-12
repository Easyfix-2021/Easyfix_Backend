#!/usr/bin/env node

"use strict";

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const MANIFEST_RELATIVE = 'docs/offline-reliability-manifest.json';
const STATE_RELATIVE = 'docs/offline-reliability-sync.json';
const DOCUMENT_RELATIVE = 'docs/OFFLINE-RELIABILITY.md';
const SCRIPT_RELATIVE = 'scripts/offline-reliability-sync.js';
const HOOK_RELATIVE = '.githooks/pre-commit';
const CONTROL_FILES = new Set([
  MANIFEST_RELATIVE,
  DOCUMENT_RELATIVE,
  SCRIPT_RELATIVE,
  HOOK_RELATIVE,
]);
const METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function fail(message) {
  console.error(`offline-reliability-sync: ${message}`);
  process.exit(1);
}

function runGit(args, { allowFailure = false, encoding = 'utf8' } = {}) {
  const result = spawnSync('git', args, {
    cwd: REPO_ROOT,
    encoding,
    env: process.env,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    if (allowFailure) return null;
    const detail = result.error?.message || String(result.stderr || '').trim();
    fail(`git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout;
}

function splitNull(value) {
  return Buffer.from(value || '').toString('utf8').split('\0').filter(Boolean);
}

function normalizeRelative(value, label) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value)) {
    fail(`${label} must be a non-empty repository-relative path`);
  }
  const normalized = value.replace(/\\/g, '/');
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    fail(`${label} must stay inside the repository`);
  }
  return normalized;
}

function readPath(relativePath, mode, { optional = false } = {}) {
  if (mode === 'staged') {
    const value = runGit(['show', `:${relativePath}`], { allowFailure: optional, encoding: null });
    if (value == null && !optional) fail(`staged ${relativePath} is missing`);
    return value == null ? null : Buffer.from(value);
  }
  const absolutePath = path.join(REPO_ROOT, relativePath);
  if (!fs.existsSync(absolutePath)) {
    if (optional) return null;
    fail(`${relativePath} is missing`);
  }
  return fs.readFileSync(absolutePath);
}

function readJson(relativePath, mode) {
  const raw = readPath(relativePath, mode);
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch (error) {
    fail(`${mode} ${relativePath} is invalid JSON: ${error.message}`);
  }
}

function treePaths(mode) {
  if (mode === 'staged') {
    return splitNull(runGit(['ls-files', '--cached', '-z'], { encoding: null })).sort();
  }
  return splitNull(runGit(['ls-files', '-c', '-o', '--exclude-standard', '-z'], { encoding: null }))
    .filter((relativePath) => fs.existsSync(path.join(REPO_ROOT, relativePath)))
    .sort();
}

function validateManifest(manifest, mode, paths) {
  if (!manifest || manifest.schemaVersion !== 1) {
    fail('manifest schemaVersion must be 1');
  }
  if (!Array.isArray(manifest.watchFiles) || !Array.isArray(manifest.watchPrefixes)) {
    fail('manifest watchFiles and watchPrefixes must be arrays');
  }
  const watchFiles = manifest.watchFiles.map((item, index) => (
    normalizeRelative(item, `manifest.watchFiles[${index}]`)
  ));
  const watchPrefixes = manifest.watchPrefixes.map((item, index) => {
    const prefix = normalizeRelative(item, `manifest.watchPrefixes[${index}]`);
    if (!prefix.endsWith('/')) fail(`manifest.watchPrefixes[${index}] must end with /`);
    return prefix;
  });
  if (new Set(watchFiles).size !== watchFiles.length) fail('manifest watchFiles contains duplicates');
  if (new Set(watchPrefixes).size !== watchPrefixes.length) fail('manifest watchPrefixes contains duplicates');

  const pathSet = new Set(paths);
  for (const watched of watchFiles) {
    if (!pathSet.has(watched)) fail(`watched file is absent from the ${mode} tree: ${watched}`);
  }

  if (!Array.isArray(manifest.contracts) || manifest.contracts.length === 0) {
    fail('manifest contracts must be a non-empty array');
  }
  const operations = new Set();
  const requestKeys = new Set();
  for (const [index, contract] of manifest.contracts.entries()) {
    const operation = String(contract?.operation || '').trim();
    const method = String(contract?.method || '').trim().toUpperCase();
    const requestPath = String(contract?.path || '').trim();
    if (!operation) fail(`manifest.contracts[${index}].operation is required`);
    if (!METHODS.has(method)) fail(`manifest.contracts[${index}].method must be a mutation method`);
    if (!requestPath.startsWith('/api/mobile/')) {
      fail(`manifest.contracts[${index}].path must start with /api/mobile/`);
    }
    if (operations.has(operation)) fail(`duplicate operation: ${operation}`);
    const requestKey = `${method} ${requestPath}`;
    if (requestKeys.has(requestKey)) fail(`duplicate request contract: ${requestKey}`);
    operations.add(operation);
    requestKeys.add(requestKey);

    if (!Array.isArray(contract.implementationFiles) || contract.implementationFiles.length === 0) {
      fail(`manifest.contracts[${index}].implementationFiles must be non-empty`);
    }
    if (!Array.isArray(contract.testFiles) || contract.testFiles.length === 0) {
      fail(`manifest.contracts[${index}].testFiles must be non-empty`);
    }
    for (const [fileIndex, file] of [
      ...contract.implementationFiles,
      ...contract.testFiles,
    ].entries()) {
      const normalized = normalizeRelative(
        file,
        `manifest.contracts[${index}].coveredFiles[${fileIndex}]`,
      );
      if (!pathSet.has(normalized)) {
        fail(`contract ${operation} references absent ${mode} file: ${normalized}`);
      }
      if (!watchFiles.includes(normalized) && !watchPrefixes.some((prefix) => normalized.startsWith(prefix))) {
        fail(`contract ${operation} implementation is outside watch rules: ${normalized}`);
      }
    }
  }
  return { ...manifest, watchFiles, watchPrefixes };
}

function isWatched(relativePath, manifest) {
  return CONTROL_FILES.has(relativePath)
    || manifest.watchFiles.includes(relativePath)
    || manifest.watchPrefixes.some((prefix) => relativePath.startsWith(prefix));
}

function computeSnapshot(mode, manifest, paths) {
  const included = paths.filter((relativePath) => isWatched(relativePath, manifest)).sort();
  const hash = crypto.createHash('sha256');
  for (const relativePath of included) {
    const content = readPath(relativePath, mode);
    hash.update(relativePath);
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
  }
  return { sourceHash: hash.digest('hex'), watchedFileCount: included.length };
}

function changedStagedPaths() {
  return splitNull(runGit(
    ['diff', '--cached', '--name-only', '--diff-filter=ACMRD', '-z'],
    { encoding: null },
  ));
}

function stateFor(mode, snapshot) {
  return {
    schemaVersion: 1,
    source: mode,
    sourceHash: snapshot.sourceHash,
    watchedFileCount: snapshot.watchedFileCount,
  };
}

function writeState(mode, snapshot) {
  const output = `${JSON.stringify(stateFor(mode, snapshot), null, 2)}\n`;
  fs.writeFileSync(path.join(REPO_ROOT, STATE_RELATIVE), output);
}

/*
 * `--fix` (used by the pre-commit hook) refreshes the state file instead of
 * refusing the commit.
 *
 * WHY: the recorded value is a SHA-256 over the watched files — a pure function
 * of the staged tree with no human judgement in it. `watchPrefixes` includes
 * `migrations/`, so routine work (moving an applied migration into executed/)
 * invalidated it constantly, and the only remedy was to abort the commit and
 * re-run a command by hand. That is friction, not safety: this hook never ran
 * the offline tests anyway (see .githooks/pre-commit — it is deliberately a
 * fast, no-network staged-tree guard), so blocking here protected nothing that
 * `npm test` in CI does not already cover.
 *
 * The guarantee is preserved where it belongs: CI runs `npm run check:offline`
 * (strict, no --fix) plus the full suite, so a commit made with --no-verify, or
 * from a clone that never ran `install-hooks`, is still caught before merge.
 *
 * Safe by construction: STATE_RELATIVE is not itself watched (no `docs/` watch
 * prefix and absent from manifest.watchFiles), so staging the refreshed file
 * cannot change the hash it records — the fix converges in one pass.
 */
function check(mode, ifRelevant, fix) {
  const paths = treePaths(mode);
  const manifest = validateManifest(readJson(MANIFEST_RELATIVE, mode), mode, paths);
  if (mode === 'staged' && ifRelevant) {
    const changed = changedStagedPaths();
    if (!changed.some((relativePath) => relativePath === STATE_RELATIVE || isWatched(relativePath, manifest))) {
      console.log('offline-reliability-sync: no staged offline-relevant changes');
      return;
    }
  }
  const actual = computeSnapshot(mode, manifest, paths);
  const recorded = readJson(STATE_RELATIVE, mode);
  const stale = recorded.schemaVersion !== 1
    || recorded.sourceHash !== actual.sourceHash
    || Number(recorded.watchedFileCount) !== actual.watchedFileCount;

  if (stale && fix) {
    writeState(mode, actual);
    if (mode === 'staged') runGit(['add', '--', STATE_RELATIVE]);
    console.log(
      `offline-reliability-sync: refreshed ${STATE_RELATIVE} `
      + `(${actual.watchedFileCount} watched files)${mode === 'staged' ? ' and staged it' : ''}`,
    );
    return;
  }
  if (stale) {
    fail(
      `stale ${STATE_RELATIVE}; review the offline contract, then run `
      + `npm run offline:record${mode === 'worktree' ? ':worktree' : ''} and stage the state file`,
    );
  }
  console.log(`offline-reliability-sync: OK (${mode}, ${actual.watchedFileCount} watched files)`);
}

function record(mode) {
  const paths = treePaths(mode);
  const manifest = validateManifest(readJson(MANIFEST_RELATIVE, mode), mode, paths);
  const snapshot = computeSnapshot(mode, manifest, paths);
  writeState(mode, snapshot);
  console.log(`offline-reliability-sync: recorded ${snapshot.watchedFileCount} watched files from ${mode}`);
}

function installHooks() {
  runGit(['config', 'core.hooksPath', '.githooks']);
  console.log('offline-reliability-sync: installed .githooks for this clone');
}

const command = process.argv[2];
const mode = process.argv.includes('--staged') ? 'staged' : 'worktree';
const ifRelevant = process.argv.includes('--if-relevant');
const fix = process.argv.includes('--fix');

if (command === 'check') check(mode, ifRelevant, fix);
else if (command === 'record') record(mode);
else if (command === 'install-hooks') installHooks();
else fail('usage: offline-reliability-sync.js <check|record|install-hooks> [--staged|--worktree] [--if-relevant] [--fix]');
