#!/usr/bin/env node
/*
 * backfill-pincode-latlng.js — one-off (re-runnable) lat/lng backfill for tbl_pincode.
 * ---------------------------------------------------------------------------------
 * WHY THIS EXISTS
 *   The bulk pincode load (migrations / EasyFix_Master_Pincode_List) inserted rows with
 *   lat/lng = NULL on purpose: the source sheet's coordinates were proven garbage
 *   (within-city spreads crossing state lines, major cities with no coords, wrong-state
 *   coords on metro pincodes). Rather than persist bad data we left the columns NULL and
 *   geocode them authoritatively from Google here.
 *
 * WHAT IT DOES
 *   Selects tbl_pincode rows WHERE lat IS NULL OR lng IS NULL, in id-ordered batches,
 *   and runs each PIN through the EXISTING geocoder — services/pincode-geocode.service.js
 *   `getCentroid(pin)`. That helper does ONE India-pinned Google Geocoding call
 *   (`postal_code:<pin>|country:IN`), is fail-soft (a bad PIN logs a warn and yields null
 *   without blanking anything), and on success PERSISTS the centroid back onto tbl_pincode
 *   via persistCentroid (`UPDATE tbl_pincode SET lat=?, lng=? WHERE pincode=?`). So this
 *   script writes nothing itself — it is purely a controlled driver over that path.
 *
 * RESUMABILITY (by construction, no checkpoint file)
 *   A successful geocode flips the row OUT of the `lat IS NULL` set, so the selection
 *   predicate is itself the progress cursor. Re-running picks up exactly what's still
 *   missing. Within a single run we advance a `pincode_id` cursor past each batch so PINs
 *   that fail to geocode (genuinely unrecognised) don't cause an infinite re-select loop;
 *   they simply remain NULL and are retried on the NEXT run.
 *
 * COST
 *   Google Geocoding API is ~USD $5 per 1,000 requests. A full ~21k backfill ≈ $106.
 *   Dry-run (the default) makes ZERO Google calls — it only counts + estimates.
 *
 * USAGE
 *   node scripts/backfill-pincode-latlng.js                 # DRY RUN: count + cost, no calls, no writes
 *   node scripts/backfill-pincode-latlng.js --run           # execute the backfill (spends money)
 *   node scripts/backfill-pincode-latlng.js --run --limit 50   # geocode only 50 (smoke test)
 *   node scripts/backfill-pincode-latlng.js --run --concurrency 6 --batch 500 --delay 0
 *
 * FLAGS
 *   --run               actually geocode + persist (without it, dry-run only)
 *   --limit N           stop after processing N pincodes this run (default: all NULL rows)
 *   --concurrency C     parallel Google calls (default 8; Google allows ~50 QPS)
 *   --batch B           DB rows fetched per batch (default 500)
 *   --delay MS          pause between batches in ms (default 0; raise to throttle if rate-limited)
 *
 * Honours the same server-side key the live geocoder uses: process.env.GOOGLE_MAPS_API_KEY
 * (must NOT be referer-restricted — App Restrictions=None or IP-restricted; see the
 * "Google API key referer trap" note). Uses Pino `logger`, never console.log.
 */

require('dotenv').config();

const { pool, closePool } = require('../db');
const logger = require('../logger');
const { getCentroid } = require('../services/pincode-geocode.service');

// ── tiny flag parser (no deps; scripts/ has no existing argv convention) ──────────
function parseArgs(argv) {
  const out = { run: false, limit: null, concurrency: 8, batch: 500, delay: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run') out.run = true;
    else if (a === '--limit') out.limit = toPosInt(argv[++i], null);
    else if (a === '--concurrency') out.concurrency = toPosInt(argv[++i], out.concurrency);
    else if (a === '--batch') out.batch = toPosInt(argv[++i], out.batch);
    else if (a === '--delay') out.delay = toPosInt(argv[++i], out.delay);
    else if (a.startsWith('--limit=')) out.limit = toPosInt(a.slice(8), null);
    else if (a.startsWith('--concurrency=')) out.concurrency = toPosInt(a.slice(14), out.concurrency);
    else if (a.startsWith('--batch=')) out.batch = toPosInt(a.slice(8), out.batch);
    else if (a.startsWith('--delay=')) out.delay = toPosInt(a.slice(8), out.delay);
  }
  return out;
}
function toPosInt(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtUsd = (n) => `$${n.toFixed(2)}`;

// Bounded-concurrency map: process `items` with at most `concurrency` in flight.
// `worker(item)` should resolve truthy on success, falsy on failure. Never rejects.
async function runPool(items, concurrency, worker) {
  let idx = 0;
  let ok = 0;
  let fail = 0;
  async function lane() {
    while (idx < items.length) {
      const item = items[idx++];
      try {
        if (await worker(item)) ok++;
        else fail++;
      } catch (e) {
        fail++;
        logger.warn({ err: e.message }, 'backfill: worker threw (counted as fail)');
      }
    }
  }
  const lanes = Array.from({ length: Math.min(concurrency, items.length) }, () => lane());
  await Promise.all(lanes);
  return { ok, fail };
}

async function countMissing() {
  const [[row]] = await pool.query(
    'SELECT COUNT(*) AS n FROM tbl_pincode WHERE lat IS NULL OR lng IS NULL',
  );
  return row.n;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const total = await countMissing();
  const target = opts.limit != null ? Math.min(opts.limit, total) : total;
  const estCost = (target / 1000) * 5; // Google: ~$5 / 1000 geocodes

  logger.info(
    { missing: total, willProcess: target, estimatedCostUsd: fmtUsd(estCost), mode: opts.run ? 'RUN' : 'DRY-RUN' },
    `pincode lat/lng backfill — ${total} row(s) missing coordinates`,
  );

  if (total === 0) {
    logger.info('Nothing to backfill — every tbl_pincode row already has lat/lng. Done.');
    return;
  }

  // ── DRY RUN (default): no Google calls, no writes — just scope + a sample. ───────
  if (!opts.run) {
    const [sample] = await pool.query(
      `SELECT pincode_id, pincode, city_id FROM tbl_pincode
        WHERE lat IS NULL OR lng IS NULL
        ORDER BY pincode_id ASC LIMIT 10`,
    );
    logger.info(
      { sample: sample.map((r) => r.pincode) },
      `DRY RUN — would geocode ${target} pincode(s) ≈ ${fmtUsd(estCost)} of Google Geocoding. ` +
        'Re-run with --run to execute (optionally --limit N for a smoke test first).',
    );
    return;
  }

  // ── REAL RUN: hard-require the server key, else we'd burn the whole loop on no-ops.
  if (!process.env.GOOGLE_MAPS_API_KEY) {
    logger.error(
      'GOOGLE_MAPS_API_KEY is unset — the geocoder cannot run and would yield NULL for every PIN. ' +
        'Set the server-side (App-Restrictions=None or IP-restricted) key and retry.',
    );
    process.exitCode = 1;
    return;
  }

  logger.warn(
    { willProcess: target, estimatedCostUsd: fmtUsd(estCost), concurrency: opts.concurrency, batch: opts.batch },
    `STARTING REAL geocode backfill — this spends ~${fmtUsd(estCost)} on Google. Ctrl-C to abort.`,
  );

  const startedMs = Date.now();
  let cursor = 0;           // last pincode_id processed (monotonic; failures don't block progress)
  let processed = 0;
  let okTotal = 0;
  let failTotal = 0;

  while (true) {
    if (opts.limit != null && processed >= opts.limit) break;

    let take = opts.batch;
    if (opts.limit != null) take = Math.min(take, opts.limit - processed);
    if (take <= 0) break;

    const [rows] = await pool.query(
      `SELECT pincode_id, pincode FROM tbl_pincode
        WHERE (lat IS NULL OR lng IS NULL) AND pincode_id > ?
        ORDER BY pincode_id ASC
        LIMIT ?`,
      [cursor, take],
    );
    if (rows.length === 0) break;

    cursor = rows[rows.length - 1].pincode_id;

    // getCentroid() geocodes (India-pinned, fail-soft) AND persists lat/lng on success.
    const { ok, fail } = await runPool(rows, opts.concurrency, async (r) => {
      const c = await getCentroid(r.pincode);
      return c && c.lat != null && c.lng != null;
    });

    processed += rows.length;
    okTotal += ok;
    failTotal += fail;

    const elapsedS = (Date.now() - startedMs) / 1000;
    const rate = processed / Math.max(elapsedS, 0.001); // pins/sec
    const remaining = target - processed;
    const etaS = rate > 0 ? Math.round(remaining / rate) : null;
    logger.info(
      { processed, target, ok: okTotal, fail: failTotal, ratePerSec: rate.toFixed(1), etaSeconds: etaS, cursor },
      `backfill progress ${processed}/${target}`,
    );

    if (opts.delay) await sleep(opts.delay);
  }

  const elapsedS = ((Date.now() - startedMs) / 1000).toFixed(1);
  logger.info(
    { processed, geocoded: okTotal, failed: failTotal, elapsedSeconds: elapsedS },
    `backfill complete — ${okTotal} geocoded, ${failTotal} failed (still NULL; re-run to retry).`,
  );
  if (failTotal > 0) {
    logger.warn(
      `${failTotal} pincode(s) did not geocode (Google returned no result / non-OK). They remain NULL. ` +
        'Re-running this script will retry only those rows.',
    );
  }
}

main()
  .then(async () => {
    await closePool();
    process.exit(0); // pool keepAlive would otherwise hold the event loop open
  })
  .catch(async (err) => {
    logger.error({ code: err.code, msg: err.message }, 'pincode lat/lng backfill failed');
    try { await closePool(); } catch (_) { /* already closing */ }
    process.exit(1);
  });
