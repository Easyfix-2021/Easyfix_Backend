/*
 * In-process pub/sub bridging the media-ws RELAY (which owns STT) to the SSE
 * endpoint (which feeds the Ops browser). Both usually run on the same replica, so
 * this is the fast path; the SSE route ALSO short-polls the DB as a cross-replica
 * fallback, so correctness never depends on relay + SSE landing together.
 *
 * Events per session: 'partial' (interim transcript), 'final' (turn transcript),
 * 'next' (AI-suggested NEXT question id — never the current one), 'status'.
 * Bounded listener count guards against leaks; unref semantics not needed (no timers).
 */

const { EventEmitter } = require('events');

const emitter = new EventEmitter();
emitter.setMaxListeners(0); // many concurrent SSE subscribers; we manage removal explicitly

function channel(sessionId) { return 'tp:' + sessionId; }

function publish(sessionId, event) {
  if (!sessionId || !event) return;
  try { emitter.emit(channel(sessionId), event); } catch { /* never throw into a caller */ }
}

// subscribe returns an unsubscribe fn. `handler(event)` must not throw.
function subscribe(sessionId, handler) {
  const ch = channel(sessionId);
  const wrapped = (ev) => { try { handler(ev); } catch { /* isolate one subscriber */ } };
  emitter.on(ch, wrapped);
  return () => { try { emitter.off(ch, wrapped); } catch { /* noop */ } };
}

module.exports = { publish, subscribe };
