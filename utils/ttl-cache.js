/*
 * utils/ttl-cache.js
 *
 * Tiny in-process short-TTL cache for NON-personalized reads.
 *
 * ⚠️  In-process ONLY. Each ACA replica keeps its own Map — there is no
 *     cross-replica coordination, so a value can live up to `ttlMs` longer
 *     than a write on a different replica. That is acceptable ONLY for data
 *     that is identical across every user AND tolerant of a few minutes of
 *     staleness (static master lists). NEVER use this for per-user /
 *     per-tech / role-scoped / req.scope-filtered data — a value cached for
 *     user A would be served to user B.
 *
 *     CONTRACT: the cache KEY must be derivable purely from non-user inputs
 *     (the lookup name + its query args). If the result varies by caller,
 *     the data is personalized and MUST NOT be cached here.
 *
 * Concurrency: the in-flight promise is stored so a stampede of concurrent
 * callers for the same cold key share a single asyncFn() execution. If that
 * promise rejects, the key is evicted so the next caller retries (we never
 * cache a rejection).
 */

// key -> { value, expires } for resolved entries, OR { promise } while a
// fetch is in flight. The two shapes are disjoint and checked in order.
const store = new Map();

/**
 * Return a cached value for `key`, or compute + store it via `asyncFn`.
 *
 * @param {string}   key     Stable key derived ONLY from non-user inputs.
 * @param {number}   ttlMs   Time-to-live in milliseconds.
 * @param {Function} asyncFn Zero-arg async producer; called on miss/expiry.
 * @returns {Promise<*>} the cached or freshly computed value.
 */
async function cached(key, ttlMs, asyncFn) {
  const hit = store.get(key);

  // In-flight: a concurrent caller is already fetching this key — join it.
  if (hit && hit.promise) return hit.promise;

  // Fresh resolved entry.
  if (hit && hit.expires > Date.now()) return hit.value;

  // Miss or expired — fetch once, share the promise to avoid a stampede.
  const promise = (async () => {
    const value = await asyncFn();
    store.set(key, { value, expires: Date.now() + ttlMs });
    return value;
  })();
  store.set(key, { promise });

  try {
    return await promise;
  } catch (err) {
    // Never cache a rejection. Only evict the in-flight marker — if a
    // concurrent fetch already replaced it with a resolved value, leave that.
    const current = store.get(key);
    if (current && current.promise === promise) store.delete(key);
    throw err;
  }
}

/**
 * Drop a single key, or the entire cache when called with no argument.
 * @param {string} [key] Key to evict; omit to clear everything.
 */
function clear(key) {
  if (key === undefined) store.clear();
  else store.delete(key);
}

module.exports = { cached, clear };
