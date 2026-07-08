/*
 * WebSocket server for the Plivo <Stream> media leg of the AI-calling flow.
 * Attached to the SHARED HTTP server's `upgrade` event (noServer mode) so it
 * adds no second listener/port. It handles ONLY path `/ai-voice-stream`.
 *
 * Isolation guarantees for the unified backend:
 *  - The existing Web Call is browser↔Plivo WebRTC and never reaches this
 *    backend, so this cannot affect it. Click-to-call uses <Dial> answer XML
 *    (routes/public/plivo/answer) — also untouched.
 *  - Gate order at upgrade time (cheapest → most authoritative): feature flag →
 *    token verify → HARD concurrency cap (tryAcquire). Only on all-pass do we
 *    complete the WebSocket handshake and hand the socket to the relay, which
 *    then OWNS releasing the acquired slot.
 *  - Any non-matching / rejected upgrade is answered with a short HTTP error and
 *    the socket destroyed, so nothing leaks. (We are the only upgrade consumer.)
 */

const { WebSocketServer } = require('ws');
const logger = require('../logger');
const aiSession = require('./ai-call-session.service');
const relay = require('./ai-voice-relay.service');

const WS_PATH = '/ai-voice-stream';
let wss = null;

function reject(socket, statusLine) {
  try { socket.write('HTTP/1.1 ' + statusLine + '\r\nConnection: close\r\n\r\n'); } catch { /* noop */ }
  try { socket.destroy(); } catch { /* noop */ }
}

function attach(server) {
  if (wss) return; // idempotent
  wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });

  server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return reject(socket, '400 Bad Request'); }
    if (url.pathname !== WS_PATH) return reject(socket, '404 Not Found');

    // Feature flag on? (`ai.calling.enabled`.) The per-ENGINE key check happens at
    // POST /ai-calling/start, so any session that got this far is already vetted.
    // Togglable at runtime, so we check per-connection rather than gating the attach.
    if (!aiSession.enabled()) return reject(socket, '403 Forbidden');

    const claims = aiSession.verifyToken(url.searchParams.get('t') || '');
    if (!claims || !claims.sid) return reject(socket, '401 Unauthorized');

    // Rule 2 — authoritative hard cap. Acquire BEFORE completing the handshake.
    if (!aiSession.tryAcquire()) {
      logger.warn('AI voice: capacity reached (' + aiSession.activeCount() + '/' + aiSession.MAX_CONCURRENT
        + ') — rejecting stream for ' + claims.sid);
      return reject(socket, '503 Service Unavailable');
    }

    // Leak guard: if handleUpgrade never hands us a live ws (malformed upgrade
    // after we acquired), release the slot when the raw socket closes. Once the
    // relay owns the ws (`handed`), the relay's cleanup() is the sole releaser.
    let handed = false;
    socket.on('close', () => { if (!handed) aiSession.release(); });

    wss.handleUpgrade(req, socket, head, (ws) => {
      handed = true;
      // From here the relay is the SOLE releaser of the acquired slot (its
      // cleanup() releases exactly once on every teardown path). We deliberately
      // do NOT release here: relay.handleConnection is fully self-contained
      // (its whole body is try/caught → cleanup) and never rejects, so a
      // release() here would only ever be reachable as a double-release if a
      // future edit broke that invariant. On the impossible-today reject path we
      // just log + close; leaking one slot fails safe (reduces capacity), a
      // double-release does not (corrupts the cap that protects the event loop).
      Promise.resolve()
        .then(() => relay.handleConnection(ws, { sessionId: claims.sid }))
        .catch((e) => {
          logger.error('AI voice: relay start failed · ' + (e && e.message));
          try { ws.close(); } catch { /* noop */ }
        });
    });
  });

  logger.info('AI voice ws server attached on ' + WS_PATH + ' (max concurrent ' + aiSession.MAX_CONCURRENT + ')');
}

// Graceful shutdown: server.close() does NOT reap upgraded ws connections, so on
// SIGTERM we close live AI sockets ourselves. Each close triggers the relay's
// teardown (persist transcript + saveResult) while the DB pool is still open.
// Best-effort + fully guarded — never throws into the shutdown path.
function shutdown() {
  if (!wss) return;
  let n = 0;
  try {
    for (const ws of wss.clients) {
      n += 1;
      try { ws.close(1001, 'server shutting down'); } catch { /* noop */ }
    }
  } catch { /* noop */ }
  if (n) logger.info('AI voice ws server: closing ' + n + ' live call socket(s) for shutdown');
}

module.exports = { attach, shutdown };
