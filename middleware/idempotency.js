/*
 * Server-side idempotency layer (Phase 14 — EasyFixer offline outbox).
 *
 * The mobile app queues writes while offline and replays them on reconnect,
 * frequently retrying the SAME request (flaky cell network, app restart
 * mid-flush). Each queued write carries a client-generated `Idempotency-Key`
 * header. This middleware records the first execution per (actor, key) in
 * `tbl_idempotency_key` and replays the stored response on any retry instead
 * of re-running the side-effect (double check-in, duplicate image upload, …).
 *
 * Factory style — mirrors middleware/rate-limit.js + middleware/validate.js:
 *   router.use(idempotency());
 *   router.use(idempotency({ resolveActor: (req) => ({ type, id }) }));
 *
 * No header → pass-through (next()). No resolvable actor → pass-through, since
 * an unidentified caller can't own a per-actor key slot.
 *
 * Fingerprint = sha256(method + "\n" + originalUrl-with-query + "\n" +
 * stableStringify(body)). The querystring is part of BOTH the stored path and
 * the fingerprint so e.g. POST /jobs/:id/images?category=Booking and
 * ?category=Completion don't wrongly replay each other.
 */

const crypto = require('crypto');
const { pool } = require('../db');
const { modernError } = require('../utils/response');

// Stable JSON stringify — sorts object keys recursively so two logically-equal
// bodies produce the same fingerprint regardless of key order. Arrays keep
// their order (semantically significant). Non-objects pass through JSON.stringify.
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function defaultResolveActor(req) {
  if (req.tech) return { type: 'efr', id: String(req.tech.efr_id) };
  if (req.user) return { type: 'user', id: String(req.user.user_id) };
  return null;
}

function idempotency({ resolveActor = defaultResolveActor } = {}) {
  return async (req, res, next) => {
    const key = req.headers['idempotency-key'];
    if (!key) return next();
    if (key.length > 128) return modernError(res, 400, 'Idempotency-Key too long (max 128 chars)');

    const actor = resolveActor(req);
    if (!actor) return next();

    const path = req.originalUrl;
    const fingerprint = crypto
      .createHash('sha256')
      .update(`${req.method}\n${path}\n${stableStringify(req.body)}`)
      .digest('hex');

    // Atomic RESERVE — INSERT the in_flight slot. affectedRows === 1 means we
    // won the race and own this execution. ER_DUP_ENTRY means another request
    // (a retry, or a concurrent duplicate) already holds the slot.
    try {
      const [ins] = await pool.query(
        `INSERT INTO tbl_idempotency_key
           (actor_type, actor_id, idempotency_key, method, path, request_fingerprint, state)
         VALUES (?, ?, ?, ?, ?, ?, 'in_flight')`,
        [actor.type, actor.id, key, req.method, path.slice(0, 512), fingerprint],
      );
      if (ins.affectedRows !== 1) return next(); // defensive — shouldn't happen
    } catch (e) {
      if (e && e.code === 'ER_DUP_ENTRY') {
        try {
          const [[existing]] = await pool.query(
            `SELECT request_fingerprint, state, response_status, response_json
               FROM tbl_idempotency_key
              WHERE actor_type = ? AND actor_id = ? AND idempotency_key = ? LIMIT 1`,
            [actor.type, actor.id, key],
          );
          if (!existing) return next(); // row vanished (TTL sweep) — let it through
          if (existing.request_fingerprint !== fingerprint) {
            return modernError(res, 409, 'Idempotency-Key reused with a different request');
          }
          if (existing.state === 'done' && existing.response_json != null) {
            res.setHeader('Idempotent-Replay', 'true');
            return res
              .status(existing.response_status || 200)
              .type('application/json')
              .send(existing.response_json);
          }
          // Still in_flight — the original request hasn't finished yet.
          return modernError(res, 409, 'request with this Idempotency-Key is still being processed');
        } catch (loadErr) {
          return next(loadErr);
        }
      }
      return next(e);
    }

    // We own the slot. Persist the response when the handler answers via
    // res.json (best-effort — a persistence failure must not break the
    // response the client already received).
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      const responseJson = JSON.stringify(body);
      pool
        .query(
          `UPDATE tbl_idempotency_key
              SET response_status = ?, response_json = ?, state = 'done', completed_at = NOW()
            WHERE actor_type = ? AND actor_id = ? AND idempotency_key = ?`,
          [res.statusCode, responseJson, actor.type, actor.id, key],
        )
        .catch(() => {});
      return originalJson(body);
    };

    // On a 5xx, delete the in_flight row so a transient server error doesn't
    // poison the key — the client's retry should be allowed to run fresh.
    res.on('finish', () => {
      if (res.statusCode >= 500) {
        pool
          .query(
            `DELETE FROM tbl_idempotency_key
              WHERE actor_type = ? AND actor_id = ? AND idempotency_key = ? AND state = 'in_flight'`,
            [actor.type, actor.id, key],
          )
          .catch(() => {});
      }
    });

    return next();
  };
}

module.exports = idempotency;
