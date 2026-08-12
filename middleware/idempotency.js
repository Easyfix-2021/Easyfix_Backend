/*
 * Server-side idempotency layer (EasyFixer offline outbox).
 *
 * One shared ledger protects every authenticated mobile mutation carrying an
 * `Idempotency-Key`. A short lease lets a retry reclaim work abandoned by a
 * crashed process, while a longer expiry bounds retained responses. Both are
 * explicit columns added by migrations/2026-08-11-01-idempotency-leases.sql.
 *
 * Successful and client-error JSON responses are persisted BEFORE they are
 * sent. A 5xx response is never retained as `done`; the owned reservation is
 * released first so the same logical operation can be retried safely.
 */

const crypto = require('crypto');
const { pool } = require('../db');
const { modernError } = require('../utils/response');

const LEASE_MINUTES = 5;
const LEASE_RENEWAL_MS = 60_000;
const LEGACY_LEASE_GRACE_MINUTES = 10;
const RETENTION_DAYS = 14;
const MAX_KEY_LENGTH = 128;
const CONTENT_DIGEST_PATTERN = /^[a-f0-9]{32}$/i;
const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const IN_PROGRESS_MESSAGE = 'request with this Idempotency-Key is still being processed';

// Stable JSON stringify — sorts object keys recursively so logically-equal
// bodies fingerprint identically. Arrays retain their semantic order.
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function defaultResolveActor(req) {
  if (req.tech) return { type: 'efr', id: String(req.tech.efr_id) };
  if (req.user) return { type: 'user', id: String(req.user.user_id) };
  return null;
}

function requestFingerprint(req, contentDigest) {
  const base = `${req.method}\n${req.originalUrl}\n${stableStringify(req.body)}`;
  // Keep the historical fingerprint unchanged when no digest is present so
  // requests reserved before this deployment can still replay. Multipart
  // parsers run after this middleware, so upload clients supply a stable digest
  // header to bind file content without storing or logging the digest itself.
  const material = contentDigest ? `${base}\ncontent-digest:${contentDigest}` : base;
  return crypto.createHash('sha256').update(material).digest('hex');
}

function inProgress(res, retryAfterSeconds) {
  const retryAfter = Math.max(1, Math.min(Number(retryAfterSeconds) || 1, LEASE_MINUTES * 60));
  res.setHeader('Retry-After', String(retryAfter));
  return modernError(res, 409, IN_PROGRESS_MESSAGE, {
    code: 'IDEMPOTENCY_IN_PROGRESS',
    retryAfterSeconds: retryAfter,
  });
}

async function releaseReservation(database, owner) {
  await database.query(
    `DELETE FROM tbl_idempotency_key
      WHERE actor_type = ? AND actor_id = ? AND idempotency_key = ?
        AND state = 'in_flight' AND lease_token = ?`,
    [owner.actorType, owner.actorId, owner.key, owner.leaseToken],
  );
}

async function renewReservationLease(database, owner) {
  const [updated] = await database.query(
    `UPDATE tbl_idempotency_key
        SET lease_expires_at = DATE_ADD(NOW(), INTERVAL ${LEASE_MINUTES} MINUTE),
            expires_at = DATE_ADD(NOW(), INTERVAL ${RETENTION_DAYS} DAY)
      WHERE actor_type = ? AND actor_id = ? AND idempotency_key = ?
        AND state = 'in_flight' AND lease_token = ?`,
    [owner.actorType, owner.actorId, owner.key, owner.leaseToken],
  );
  return Number(updated.affectedRows) === 1;
}

function startLeaseRenewal(database, owner, res) {
  let stopped = false;
  let renewalInFlight = false;
  const timer = setInterval(async () => {
    if (stopped || renewalInFlight) return;
    renewalInFlight = true;
    try {
      const renewed = await renewReservationLease(database, owner);
      if (!renewed) {
        stopped = true;
        clearInterval(timer);
      }
    } catch (_) {
      // A transient database failure gets another attempt in one minute. The
      // five-minute lease supplies four retry opportunities; the owner-token
      // CAS on completion still prevents a stale owner from recording success.
    } finally {
      renewalInFlight = false;
    }
  }, LEASE_RENEWAL_MS);
  timer.unref?.();

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
  res.once?.('finish', stop);
  res.once?.('close', stop);
  return stop;
}

/*
 * Delay JSON delivery until the ledger has durably captured the result. This
 * closes the crash window where a client could receive 2xx while the row still
 * said `in_flight`. The wrapper intentionally returns `res` immediately to
 * preserve Express' res.json chaining contract; persistence continues on the
 * promise chain and owns the eventual send/error hand-off.
 */
function captureJsonResponse({ database, res, next, owner, stopLeaseRenewal }) {
  const originalJson = res.json.bind(res);
  let responseStarted = false;

  res.json = (body) => {
    if (responseStarted) return originalJson(body);
    responseStarted = true;
    const status = Number(res.statusCode) || 200;

    const persistThenSend = async () => {
      if (status >= 500) {
        // Cleanup is best-effort for an already-failing request, but the row is
        // never marked done. A failed DELETE remains reclaimable after 5 min.
        try { await releaseReservation(database, owner); } catch (_) { /* lease expiry is the backstop */ }
        stopLeaseRenewal();
        return originalJson(body);
      }

      const responseJson = JSON.stringify(body);
      if (typeof responseJson !== 'string') {
        const error = new Error('idempotent JSON response could not be serialized');
        error.status = 500;
        throw error;
      }

      const [updated] = await database.query(
        `UPDATE tbl_idempotency_key
            SET response_status = ?, response_json = ?, state = 'done',
                completed_at = NOW(), lease_token = NULL,
                lease_expires_at = NULL,
                expires_at = DATE_ADD(NOW(), INTERVAL ${RETENTION_DAYS} DAY)
          WHERE actor_type = ? AND actor_id = ? AND idempotency_key = ?
            AND state = 'in_flight' AND lease_token = ?`,
        [status, responseJson, owner.actorType, owner.actorId, owner.key, owner.leaseToken],
      );
      if (Number(updated.affectedRows) !== 1) {
        const error = new Error('idempotency lease was lost before the response could be persisted');
        error.status = 503;
        throw error;
      }
      stopLeaseRenewal();
      return originalJson(body);
    };

    persistThenSend().catch(async (error) => {
      // The success/client-error body has NOT been sent. Restore Express' JSON
      // method before handing off so the terminal error handler can emit 5xx
      // without re-entering this persistence wrapper.
      res.json = originalJson;
      stopLeaseRenewal();
      try { await releaseReservation(database, owner); } catch (_) { /* lease expiry is the backstop */ }
      if (!res.headersSent) next(error);
    });
    return res;
  };
}

function idempotency({ resolveActor = defaultResolveActor, database = pool } = {}) {
  return async (req, res, next) => {
    const rawKey = req.headers['idempotency-key'];
    if (!rawKey) return next();
    if (!MUTATION_METHODS.has(String(req.method || '').toUpperCase())) {
      return modernError(res, 400, 'Idempotency-Key is only supported for mutation requests', {
        code: 'IDEMPOTENCY_METHOD_NOT_SUPPORTED',
      });
    }
    const key = String(rawKey);
    if (key.length > MAX_KEY_LENGTH) {
      return modernError(res, 400, `Idempotency-Key too long (max ${MAX_KEY_LENGTH} chars)`);
    }

    const actor = resolveActor(req);
    if (!actor) return next();

    const rawDigest = req.headers['idempotency-content-digest'];
    const contentDigest = rawDigest == null ? '' : String(rawDigest).trim().toLowerCase();
    if (contentDigest && !CONTENT_DIGEST_PATTERN.test(contentDigest)) {
      return modernError(
        res,
        400,
        'Idempotency-Content-Digest must be a 32-character hexadecimal MD5 digest',
        { code: 'IDEMPOTENCY_CONTENT_DIGEST_INVALID' },
      );
    }
    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    if (contentType.startsWith('multipart/form-data') && !contentDigest) {
      return modernError(
        res,
        400,
        'Idempotency-Content-Digest is required for keyed multipart requests',
        { code: 'IDEMPOTENCY_CONTENT_DIGEST_REQUIRED' },
      );
    }

    // DO NOT apply redactUrl() here (or to the fingerprint at the top of this
    // file). This value participates in idempotency identity: masking it would
    // make two requests that differ ONLY by an identity value in the URL hash
    // identically, so one caller's stored response could be replayed to another.
    // Correctness outranks the log-hygiene concern, and keyed requests are
    // mutations that carry their payload in the body, not the path.
    const path = req.originalUrl;
    const fingerprint = requestFingerprint(req, contentDigest);
    const owner = {
      actorType: actor.type,
      actorId: actor.id,
      key,
      leaseToken: crypto.randomUUID(),
    };

    const insertReservation = () => database.query(
      `INSERT INTO tbl_idempotency_key
         (actor_type, actor_id, idempotency_key, method, path,
          request_fingerprint, state, lease_token, lease_expires_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 'in_flight', ?,
               DATE_ADD(NOW(), INTERVAL ${LEASE_MINUTES} MINUTE),
               DATE_ADD(NOW(), INTERVAL ${RETENTION_DAYS} DAY))`,
      [
        owner.actorType,
        owner.actorId,
        owner.key,
        req.method,
        path.slice(0, 512),
        fingerprint,
        owner.leaseToken,
      ],
    );

    let ownsReservation = false;
    try {
      const [inserted] = await insertReservation();
      ownsReservation = Number(inserted.affectedRows) === 1;
    } catch (error) {
      if (error?.code !== 'ER_DUP_ENTRY') return next(error);

      try {
        const [[existing]] = await database.query(
          `SELECT request_fingerprint, state, response_status, response_json,
                  GREATEST(
                    0,
                    TIMESTAMPDIFF(
                      SECOND,
                      NOW(),
                      COALESCE(
                        lease_expires_at,
                        DATE_ADD(created_at, INTERVAL ${LEGACY_LEASE_GRACE_MINUTES} MINUTE)
                      )
                    )
                  ) AS retry_after_seconds
             FROM tbl_idempotency_key
            WHERE actor_type = ? AND actor_id = ? AND idempotency_key = ?
            LIMIT 1`,
          [owner.actorType, owner.actorId, owner.key],
        );

        if (!existing) {
          // A bounded cleanup may have removed the row between duplicate
          // detection and lookup. Retry INSERT exactly once; never loop.
          try {
            const [inserted] = await insertReservation();
            ownsReservation = Number(inserted.affectedRows) === 1;
          } catch (retryError) {
            if (retryError?.code === 'ER_DUP_ENTRY') return inProgress(res, 1);
            return next(retryError);
          }
        } else if (existing.request_fingerprint !== fingerprint) {
          return modernError(res, 409, 'Idempotency-Key reused with a different request', {
            code: 'IDEMPOTENCY_KEY_REUSED',
          });
        } else if (existing.state === 'done' && existing.response_json != null) {
          res.setHeader('Idempotent-Replay', 'true');
          return res
            .status(existing.response_status || 200)
            .type('application/json')
            .send(existing.response_json);
        } else if (Number(existing.retry_after_seconds) > 0) {
          return inProgress(res, existing.retry_after_seconds);
        } else {
          // Same logical request, but its owner crashed or exceeded the lease.
          // The unique actor/key predicate makes this a constant-time CAS; only
          // one concurrent retry can replace the expired owner token.
          const [reclaimed] = await database.query(
            `UPDATE tbl_idempotency_key
                SET method = ?, path = ?, request_fingerprint = ?,
                    response_status = NULL, response_json = NULL,
                    state = 'in_flight', completed_at = NULL,
                    lease_token = ?,
                    lease_expires_at = DATE_ADD(NOW(), INTERVAL ${LEASE_MINUTES} MINUTE),
                    expires_at = DATE_ADD(NOW(), INTERVAL ${RETENTION_DAYS} DAY)
              WHERE actor_type = ? AND actor_id = ? AND idempotency_key = ?
                AND state = 'in_flight'
                AND COALESCE(
                      lease_expires_at,
                      DATE_ADD(created_at, INTERVAL ${LEGACY_LEASE_GRACE_MINUTES} MINUTE)
                    ) <= NOW()`,
            [
              req.method,
              path.slice(0, 512),
              fingerprint,
              owner.leaseToken,
              owner.actorType,
              owner.actorId,
              owner.key,
            ],
          );
          ownsReservation = Number(reclaimed.affectedRows) === 1;
          if (!ownsReservation) return inProgress(res, 1);
        }
      } catch (loadError) {
        return next(loadError);
      }
    }

    if (!ownsReservation) {
      // A keyed mutation must never fail open. Normal MySQL INSERT semantics
      // report one affected row, but an unexpected driver/proxy response should
      // withhold the domain mutation so the client can retry safely.
      const reservationError = new Error('idempotency reservation could not be confirmed');
      reservationError.status = 503;
      return next(reservationError);
    }
    const stopLeaseRenewal = startLeaseRenewal(database, owner, res);
    captureJsonResponse({ database, res, next, owner, stopLeaseRenewal });
    return next();
  };
}

idempotency._internals = {
  IN_PROGRESS_MESSAGE,
  LEASE_MINUTES,
  LEASE_RENEWAL_MS,
  LEGACY_LEASE_GRACE_MINUTES,
  RETENTION_DAYS,
  renewReservationLease,
  requestFingerprint,
  stableStringify,
};

module.exports = idempotency;
