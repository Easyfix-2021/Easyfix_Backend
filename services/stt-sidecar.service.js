/*
 * STT sidecar supervisor — OPTIONAL auto-start of the self-hosted speech-to-text
 * service (stt-service/) as a managed child process of the Node server.
 *
 * Why auto-start-with-server (not per-call): the STT model is loaded ONCE at the
 * Python process's boot (seconds+). Spawning it per call would cold-load the model
 * every time — slow for a live call. So we run it once alongside the server; each
 * call then only opens a cheap WebSocket session (the relay already does that).
 *
 * Auto-provisioning (LOCAL/dev): the manager keeps a virtualenv at stt-service/.venv
 * and pip-installs requirements.txt into it if a dependency is missing — so a fresh
 * checkout "just works" with STT_AUTOSTART=true, no manual pip step. A venv (not the
 * system python) avoids PEP-668 "externally-managed-environment" blocks and isolates
 * the deps. STT_PYTHON is the BASE interpreter used to build the venv (default python3).
 *
 * Gated by STT_AUTOSTART=true (default off) AND teleprompter.enabled — so prod (where
 * the sidecar runs as its OWN container with STT_AUTOSTART=false) and disabled envs
 * are unaffected. When ON, this module OWNS STT_SERVICE_URL: it clears it at boot and
 * sets it to the local sidecar URL ONLY after the model reports ready — so
 * POST /admin/teleprompter/start correctly refuses (STT not ready) during warm-up.
 *
 * Fully best-effort: a missing Python / failed install / spawn error logs a clear
 * hint and leaves the feature OFF — it never crashes or blocks the shared backend.
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const logger = require('../logger');

const MAX_RESTARTS = 5;
const RESTART_DELAY_MS = 3000;

let child = null;
let shuttingDown = false;
let restarts = 0;
let readyUrl = null;
let venvPython = null; // resolved once by ensureDeps(); reused across restarts

function enabled() {
  return String(process.env.STT_AUTOSTART || '').trim().toLowerCase() === 'true';
}
function sttDir() { return path.join(__dirname, '..', 'stt-service'); }
function sidecarUrl() {
  const port = String(process.env.STT_SIDECAR_PORT || '8300').trim();
  return `ws://127.0.0.1:${port}/stt`;
}

// Run a child to completion; resolve on exit 0, reject otherwise. `label` (optional)
// streams the child's output to the logger (used for the pip install progress).
function run(cmd, args, cwd, label) {
  return new Promise((resolve, reject) => {
    let p;
    try { p = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { reject(e); return; }
    if (label) {
      const onData = (b) => {
        const t = String(b).trim();
        if (t) for (const l of t.split('\n')) logger.info('[' + label + '] ' + l.trim());
      };
      p.stdout.on('data', onData);
      p.stderr.on('data', onData);
    }
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(cmd + ' exited ' + code))));
  });
}

// Ensure the managed venv exists with the deps installed; returns its python path.
// Idempotent: creates the venv only if missing, installs only if a dep probe fails.
async function ensureDeps() {
  const dir = sttDir();
  const reqs = path.join(dir, 'requirements.txt');
  const basePy = (process.env.STT_PYTHON || 'python3').trim();
  const venvDir = path.join(dir, '.venv');
  const venvPy = path.join(venvDir, 'bin', 'python');

  if (!fs.existsSync(venvPy)) {
    logger.info('STT sidecar: creating Python venv at ' + venvDir + ' (base=' + basePy + ')…');
    await run(basePy, ['-m', 'venv', venvDir], dir);
  }
  const hasDeps = await run(venvPy, ['-c', 'import faster_whisper, numpy, websockets'], dir)
    .then(() => true).catch(() => false);
  if (!hasDeps) {
    logger.info('STT sidecar: installing Python deps (first run — this can take a few minutes)…');
    // --only-binary=:all: → use prebuilt wheels ONLY. Fails FAST (clear "no matching
    // distribution") on a Python with no wheels (e.g. a brand-new 3.14) instead of a
    // slow, usually-failing source build of ctranslate2. Set STT_PYTHON to a supported
    // interpreter (3.9–3.12) if that happens.
    await run(venvPy, ['-m', 'pip', 'install', '--disable-pip-version-check', '--only-binary=:all:', '-r', reqs], dir, 'stt-setup');
    logger.info('STT sidecar: deps installed.');
  }
  return venvPy;
}

function spawnOnce(py) {
  const dir = sttDir();
  const port = String(process.env.STT_SIDECAR_PORT || '8300').trim();
  const env = {
    ...process.env,
    STT_HOST: '127.0.0.1',
    STT_PORT: port,
    STT_MODEL: process.env.STT_MODEL || 'small',
  };

  let proc;
  try {
    proc = spawn(py, ['server.py'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    logger.warn('STT sidecar: could not spawn (' + (e && e.message) + ').');
    return null;
  }
  proc.on('error', (e) => logger.warn('STT sidecar process error · ' + (e && e.message)));

  // Watch stdout for the "listening" marker → only THEN advertise the URL.
  const onLine = (buf, isErr) => {
    const text = String(buf).trim();
    if (!text) return;
    for (const line of text.split('\n')) {
      const l = line.trim();
      if (!l) continue;
      logger[isErr ? 'warn' : 'info']('[stt-sidecar] ' + l);
      if (!isErr && /listening/i.test(l) && !readyUrl) {
        readyUrl = sidecarUrl();
        process.env.STT_SERVICE_URL = readyUrl;
        restarts = 0; // healthy start → reset the restart budget
        logger.info('STT sidecar READY · STT_SERVICE_URL=' + readyUrl);
      }
    }
  };
  proc.stdout.on('data', (b) => onLine(b, false));
  proc.stderr.on('data', (b) => onLine(b, true));

  proc.on('exit', (code, signal) => {
    child = null;
    readyUrl = null;
    if (process.env.STT_SERVICE_URL === sidecarUrl()) delete process.env.STT_SERVICE_URL;
    if (shuttingDown) return;
    logger.warn('STT sidecar exited · code=' + code + ' · signal=' + (signal || 'none'));
    if (restarts >= MAX_RESTARTS) {
      logger.warn('STT sidecar: reached ' + MAX_RESTARTS + ' restarts — giving up. Guided calls disabled until fixed + server restart.');
      return;
    }
    restarts += 1;
    const t = setTimeout(() => { if (!shuttingDown && venvPython) child = spawnOnce(venvPython); }, RESTART_DELAY_MS);
    if (t && t.unref) t.unref();
  });

  return proc;
}

// Called once after the HTTP server is up. No-op unless STT_AUTOSTART=true AND the
// teleprompter feature is enabled (no point loading a heavy STT model otherwise).
function maybeStart() {
  if (!enabled()) return;
  let featureOn = false;
  try { featureOn = require('./teleprompter.service').enabled(); } catch { featureOn = false; }
  if (!featureOn) {
    logger.info('STT autostart: teleprompter.enabled is off — sidecar not started (flip the flag + restart to enable).');
    return;
  }
  // We own STT_SERVICE_URL when autostarting — clear any stale/pre-set value so the
  // feature reads as "not ready" until the model actually loads.
  if (process.env.STT_SERVICE_URL) {
    logger.info('STT autostart on — overriding STT_SERVICE_URL with the managed sidecar once ready.');
  }
  delete process.env.STT_SERVICE_URL;
  logger.info('STT sidecar: autostart enabled — preparing environment (auto-installs deps if missing)…');
  ensureDeps()
    .then((py) => { venvPython = py; child = spawnOnce(py); })
    .catch((e) => {
      logger.warn('STT sidecar: environment setup failed — ' + (e && e.message)
        + '. Likely no prebuilt wheels for this Python (' + (process.env.STT_PYTHON || 'python3')
        + ') — point STT_PYTHON at a supported interpreter (3.9–3.12), e.g. STT_PYTHON=python3.12, then restart. '
        + 'Guided calls stay disabled until this succeeds.');
    });
}

function shutdown() {
  shuttingDown = true;
  if (child) { try { child.kill('SIGTERM'); } catch { /* noop */ } }
}

module.exports = { maybeStart, shutdown, enabled };
