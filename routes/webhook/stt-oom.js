const router = require('express').Router();
const logger = require('../../logger');
const { modernOk, modernError } = require('../../utils/response');
const properties = require('../../services/properties.service');
const email = require('../../services/email.service');

/*
 * STT sidecar OOM alert (internal → us). Mounted at /api/webhook/stt-oom.
 *
 * SOURCE: the `stt-oom-watch` compose sidecar (read-only Docker socket) watches
 * the `easyfix-stt` container for an `oom` event (or a `die` with
 * State.OOMKilled=true) and POSTs { container, exitCode, oomKilled } here. We
 * turn that into an email to the ops recipients configured in
 * easyfix_properties('teleprompter.stt.alert.emails').
 *
 * AUTH: a shared key in the `x-webhook-key` header, compared to
 * STT_OOM_WEBHOOK_KEY (injected into both this backend and the watcher from the
 * host's /opt/easyfix/.env via compose). If that env is UNSET the feature is
 * OFF and we 200 no-op (never an error) — nothing new runs until an operator
 * opts in, and the watcher never retry-storms. Empty recipient list → also a
 * silent no-op. This keeps the whole thing additive + flag-off-safe.
 *
 * RATE-LIMIT: per-container cooldown so a crash/restart loop can't flood inboxes.
 */

const COOLDOWN_MS = Number(process.env.STT_OOM_ALERT_COOLDOWN_MS || 10 * 60 * 1000);
const _lastAlertAt = new Map(); // container -> ms epoch of last email

function istNow() {
  try {
    return new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true });
  } catch {
    return new Date().toISOString();
  }
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

router.post('/', async (req, res) => {
  const expected = process.env.STT_OOM_WEBHOOK_KEY;
  // Feature disabled (no shared key configured) → accept + ignore so the watcher
  // stays quiet. NOT an error: alerting is opt-in.
  if (!expected) return modernOk(res, { received: false, reason: 'alerting-disabled' });

  const provided = req.get('x-webhook-key') || '';
  if (provided !== expected) return modernError(res, 401, 'invalid webhook key');

  const container = String(req.body?.container || 'easyfix-stt').slice(0, 64);
  const exitCode = String(req.body?.exitCode ?? '').slice(0, 16);
  const oomKilled = req.body?.oomKilled === true || String(req.body?.oomKilled) === 'true';

  // Only alert on genuine OOM kills — a normal stop/deploy reports oomKilled=false.
  if (!oomKilled) return modernOk(res, { received: true, alerted: false, reason: 'not-oom' });

  // Per-container cooldown: a restart loop fires many events; one email is enough.
  const now = Date.now();
  if (now - (_lastAlertAt.get(container) || 0) < COOLDOWN_MS) {
    logger.warn(`STT OOM alert suppressed (cooldown) · container=${container}`);
    return modernOk(res, { received: true, alerted: false, reason: 'cooldown' });
  }

  // Fresh read (await ensures the property cache is warm even right after boot).
  await properties.getAllProperties();
  const recipients = [...properties.parseEmailAllowlist('teleprompter.stt.alert.emails')];
  if (!recipients.length) {
    logger.warn(`STT OOM detected but no recipients set (teleprompter.stt.alert.emails) · container=${container}`);
    return modernOk(res, { received: true, alerted: false, reason: 'no-recipients' });
  }

  _lastAlertAt.set(container, now);
  const envLabel = process.env.DEPLOY_ENV || process.env.NODE_ENV || 'unknown';
  const when = istNow();
  const cap = process.env.STT_MEM_LIMIT || 'see STT_MEM_* deploy vars';
  logger.error(`STT container OOM-killed · container=${container} · env=${envLabel} · exit=${exitCode} — alerting ${recipients.length} recipient(s)`);

  const subject = `⚠ EasyFix STT sidecar OOM-killed (${envLabel})`;
  const html = `
    <p><strong>The AI-Teleprompter STT sidecar was OOM-killed.</strong></p>
    <table cellpadding="4" style="border-collapse:collapse;font-family:sans-serif;font-size:13px">
      <tr><td><b>Container</b></td><td>${esc(container)}</td></tr>
      <tr><td><b>Environment</b></td><td>${esc(envLabel)}</td></tr>
      <tr><td><b>When (IST)</b></td><td>${esc(when)}</td></tr>
      <tr><td><b>Exit code</b></td><td>${esc(exitCode) || 'n/a'}</td></tr>
      <tr><td><b>Memory cap</b></td><td>${esc(cap)}</td></tr>
    </table>
    <p>The container auto-restarts (<code>restart: unless-stopped</code>), so STT should recover within
       seconds. Guided calls started during the outage fail closed (mandatory-STT gate) and can be retried.</p>
    <p>If this recurs, raise the STT memory ceiling (GitHub Variable <code>STT_MEM_MAX_MB</code>, or
       <code>STT_MEM_PERCENT</code>) or move to a larger instance, then push to <code>stt-service/**</code>
       to redeploy.</p>
  `;

  try {
    const r = await email.send({ to: recipients, subject, html, category: 'transactional' });
    return modernOk(res, { received: true, alerted: r.delivered === true, delivery: r });
  } catch (err) {
    logger.error(`STT OOM alert email failed · ${err.message}`);
    return modernOk(res, { received: true, alerted: false, error: err.message });
  }
});

module.exports = router;
