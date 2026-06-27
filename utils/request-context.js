/*
 * Per-request context via AsyncLocalStorage.
 *
 * One middleware (server.js, mounted first) wraps each request in `run(req,
 * next)`, making the live `req` reachable from anywhere in the async call chain
 * — route handlers AND deep service functions — WITHOUT threading it through
 * every signature. The logger reads it (`current()`) to stamp every line with
 * the request's surface (Mobile/CRM/Client/…) + identity (mobile no. / email).
 *
 * Outside a request (server startup, cron jobs) `current()` returns null and the
 * logger falls back to its plain `<time> <icon> <msg>` format.
 */
const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

// Run the rest of the request within this req's context. Express's `next` (and
// every await chained from it — handlers, services, db calls) can then reach
// the req via current(). AsyncLocalStorage propagates across the await chain.
function run(req, next) {
  als.run(req, next);
}

// The req for the in-flight request, or null when not inside one.
function current() {
  return als.getStore() || null;
}

module.exports = { run, current };
