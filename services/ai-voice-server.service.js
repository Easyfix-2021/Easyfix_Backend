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
const teleprompter = require('./teleprompter.service');
const teleprompterRelay = require('./teleprompter-relay.service');

const AI_PATH = '/ai-voice-stream';
const TP_PATH = '/teleprompter-stream';

// Per-path config so both media legs share the SAME upgrade discipline (feature
// flag → token verify → hard concurrency cap → hand to relay). Each has its OWN
// flag + cap + relay, so the two features fail independently.
const ROUTES = {
  [AI_PATH]: {
    label: 'AI voice',
    enabled: () => aiSession.enabled(),
    verify: (t) => aiSession.verifyToken(t),
    tryAcquire: () => aiSession.tryAcquire(),
    release: () => aiSession.release(),
    activeCount: () => aiSession.activeCount(),
    max: () => aiSession.MAX_CONCURRENT,
    handle: (ws, claims) => relay.handleConnection(ws, { sessionId: claims.sid, voice: claims.voice }),
  },
  [TP_PATH]: {
    label: 'Teleprompter',
    enabled: () => teleprompter.enabled(),
    verify: (t) => teleprompter.verifyToken(t),
    tryAcquire: () => teleprompter.tryAcquire(),
    release: () => teleprompter.release(),
    activeCount: () => teleprompter.activeCount(),
    max: () => teleprompter.MAX_CONCURRENT,
    handle: (ws, claims) => teleprompterRelay.handleConnection(ws, { sessionId: claims.sid }),
  },
};

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
    const route = ROUTES[url.pathname];
    if (!route) return reject(socket, '404 Not Found'); // we're the only upgrade consumer

    // Feature flag on? Togglable at runtime, so checked per-connection.
    if (!route.enabled()) return reject(socket, '403 Forbidden');

    const claims = route.verify(url.searchParams.get('t') || '');
    if (!claims || !claims.sid) return reject(socket, '401 Unauthorized');

    // Authoritative hard cap. Acquire BEFORE completing the handshake.
    if (!route.tryAcquire()) {
      logger.warn(route.label + ': capacity reached (' + route.activeCount() + '/' + route.max()
        + ') — rejecting stream for ' + claims.sid);
      return reject(socket, '503 Service Unavailable');
    }

    // Leak guard: if handleUpgrade never hands us a live ws (malformed upgrade
    // after we acquired), release the slot when the raw socket closes. Once the
    // relay owns the ws (`handed`), the relay's cleanup() is the sole releaser.
    let handed = false;
    socket.on('close', () => { if (!handed) route.release(); });

    wss.handleUpgrade(req, socket, head, (ws) => {
      handed = true;
      // From here the relay is the SOLE releaser of the acquired slot (its
      // cleanup() releases exactly once on every teardown path). Both relays are
      // fully self-contained (whole body try/caught → cleanup) and never reject,
      // so we deliberately do NOT release here.
      Promise.resolve()
        .then(() => route.handle(ws, claims))
        .catch((e) => {
          logger.error(route.label + ': relay start failed · ' + (e && e.message));
          try { ws.close(); } catch { /* noop */ }
        });
    });
  });

  logger.info('Voice/teleprompter ws server attached on ' + AI_PATH + ' + ' + TP_PATH
    + ' (max concurrent ai=' + aiSession.MAX_CONCURRENT + ' tp=' + teleprompter.MAX_CONCURRENT + ')');
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
