const { pool } = require('../db');
const logger = require('../logger');

/*
 * ═══════════════════════════════════════════════════════════════════════════
 * PINCODE COVERAGE — the ONE definition of "is this pincode serviceable".
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A pincode is COVERED when at least one active, verified technician either
 *   • lives there            — tbl_easyfixer.efr_pin_no, or
 *   • services it            — tbl_efr_serviceable_pincodes.pincodes (CSV)
 *
 * Two surfaces need this answer and used to compute it differently:
 *   Settings → Manage Pincodes   "Serviceable / Non-Serviceable"
 *   TAT engine                   "Local / Travel" (sets the Visit target)
 *
 * They now share this module, because two definitions of one word is exactly
 * how the old day-based TAT ended up with five.
 *
 * ── Why this is not a SQL predicate ────────────────────────────────────────
 *
 * The obvious implementation is an EXISTS correlated on the pincode:
 *
 *     WHERE EXISTS (SELECT 1 FROM tbl_easyfixer te
 *                    WHERE te.efr_status = 1
 *                      AND (te.efr_pin_no = ?
 *                           OR EXISTS (SELECT 1 FROM tbl_efr_serviceable_pincodes sp
 *                                       WHERE sp.easyfixer_id = te.efr_id
 *                                         AND FIND_IN_SET(?, REPLACE(sp.pincodes,' ','')) > 0)))
 *
 * That re-executes the whole supply-side lookup ONCE PER PINCODE, and
 * `FIND_IN_SET` on a REPLACE()'d column can never use an index. Worse, EXISTS
 * short-circuits on the first covering technician — so COVERED pincodes exit
 * early and UNCOVERED ones pay a full scan. The pathological case is precisely
 * the case these screens report on.
 *
 * So we invert it. `tbl_efr_serviceable_pincodes` has PRIMARY KEY
 * (easyfixer_id) — ONE row per technician, capped at the technician count
 * (~30k) — so reading the whole thing once is milliseconds. Two flat passes
 * then a Set intersection in JS:
 *
 *   cost = 2 queries + ~30k rows, REGARDLESS of how many pincodes are asked
 *          about (5 or 5,000).
 *
 * This is the same technique candidate-ranking.service.js already uses for its
 * batched enrichment. Semantics are byte-identical: `.replace(/ /g, '')` on a
 * CSV token reproduces `FIND_IN_SET(pin, REPLACE(csv, ' ', ''))` exactly.
 *
 * ── The space bug this fixes ───────────────────────────────────────────────
 *
 * Manage Pincodes previously ran `FIND_IN_SET(p.pincode, sp.pincodes)` with NO
 * space stripping. `pincodes` is a hand-maintained CSV, and '560001, 560002' —
 * typed the natural way — makes FIND_IN_SET look for ' 560002' WITH a leading
 * space and find nothing. Every entry after the first was invisible, so a
 * technician contributed coverage for exactly one pincode. Candidate ranking
 * stripped the spaces; Manage Pincodes did not. The screen has been showing
 * pincodes as Non-Serviceable that the allocation engine assigns work in.
 *
 * ── Why verified, not merely active ────────────────────────────────────────
 *
 * `is_technician_verified = 1` is required. "Serviceable" must mean "somebody
 * can actually be dispatched here" — an unverified technician cannot take the
 * job. This preserves Manage Pincodes' existing strictness rather than
 * silently loosening a live screen, and it makes TAT slightly stricter (fewer
 * LOCAL → more TRAVEL → the more forgiving 48h Visit target), which is the
 * safer direction to be wrong in.
 */

// A short TTL is safe here: onboarding a technician is not a per-second event,
// and every consumer is a human-paced screen. It also stops a 5,000-job TAT
// report, a zone list and a pincode page-load from each re-reading the same
// ~30k rows.
const CACHE_TTL_MS = 60_000;
let cache = null;

/*
 * Cache the RAW supply rows, not a derived index.
 *
 * The tempting shape is Map<pincode, Set<efrId>> — but ~30k technicians × ~50
 * serviceable pincodes each is ~1.5M entries, which is real memory in a backend
 * that also serves three frontends. Raw rows are ~30k strings (a few MB), and
 * every question below is a scan over them: milliseconds, and only on a cache
 * miss for the covered-set.
 *
 * Status flags are cached rather than filtered in SQL so the one read can serve
 * both the strict question (Manage Pincodes / TAT: active + verified only) and
 * the permissive one (zone membership with activeOnly=false).
 */
async function loadSupply() {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache;

  const [homeRows, csvRows] = await Promise.all([
    pool.query(
      `SELECT efr_id, efr_pin_no AS pin, efr_status, is_technician_verified
         FROM tbl_easyfixer
        WHERE efr_pin_no IS NOT NULL AND efr_pin_no <> ''`,
    ).then(([r]) => r),
    pool.query(
      `SELECT sp.easyfixer_id AS efr_id, sp.pincodes,
              te.efr_status, te.is_technician_verified
         FROM tbl_efr_serviceable_pincodes sp
         JOIN tbl_easyfixer te ON te.efr_id = sp.easyfixer_id
        WHERE sp.pincodes IS NOT NULL AND sp.pincodes <> ''`,
    ).then(([r]) => r),
  ]);

  // Pre-split ONCE into (efrId, pins[]) — the split is the expensive part and
  // the token arrays are the same strings, not copies.
  const supply = [];
  for (const r of homeRows) {
    const pin = String(r.pin).replace(/ /g, '');
    if (pin) supply.push({ efrId: r.efr_id, pins: [pin], active: isDispatchable(r) });
  }
  for (const r of csvRows) {
    // Mirrors REPLACE(pincodes, ' ', '') exactly — including internal spaces.
    const pins = String(r.pincodes).split(',').map((t) => t.replace(/ /g, '')).filter(Boolean);
    if (pins.length) supply.push({ efrId: r.efr_id, pins, active: isDispatchable(r) });
  }

  // The strict covered-set is precomputed because it is the hottest question
  // and is small (bounded by real pincodes, ~20k), unlike the per-technician
  // index which is not.
  const covered = new Set();
  for (const row of supply) {
    if (!row.active) continue;
    for (const pin of row.pins) covered.add(pin);
  }

  cache = { at: Date.now(), supply, covered };
  logger.info('Pincode coverage refreshed · supplyRows=' + supply.length + ' coveredPincodes=' + covered.size);
  return cache;
}

/* Active AND verified — "somebody can actually be dispatched here". */
function isDispatchable(r) {
  return Number(r.efr_status) === 1 && Number(r.is_technician_verified) === 1;
}

function normalise(pincodes) {
  return [...new Set(
    (pincodes || [])
      .filter((p) => p != null && /^[0-9]{6}$/.test(String(p).trim()))
      .map((p) => String(p).trim()),
  )];
}

/*
 * Which of `pincodes` are covered? Returns a Set of the covered values.
 * Non-6-digit inputs are dropped rather than reported uncovered — a malformed
 * pincode is unknowable, not un-serviced.
 */
async function getCoveredPincodes(pincodes) {
  const wanted = normalise(pincodes);
  if (!wanted.length) return new Set();
  const { covered } = await loadSupply();
  const hit = new Set(wanted.filter((p) => covered.has(p)));
  logger.info('Pincode coverage · ' + hit.size + '/' + wanted.length + ' covered');
  return hit;
}

/* Single-pincode convenience. Same answer, same cache. */
async function isCovered(pincode) {
  return (await getCoveredPincodes([pincode])).size > 0;
}

/*
 * WHICH technicians cover any of these pincodes? Returns a Set of efr_id.
 *
 * This is the question zone.service asks — it needs the technicians, not just
 * a yes/no. `activeOnly: false` includes everyone with a matching pincode
 * regardless of status, which is what the zone membership screen opts into.
 */
async function getTechnicianIdsForPincodes(pincodes, { activeOnly = true } = {}) {
  const wanted = new Set(normalise(pincodes));
  if (!wanted.size) return new Set();
  const { supply } = await loadSupply();
  const ids = new Set();
  for (const row of supply) {
    if (activeOnly && !row.active) continue;
    if (ids.has(row.efrId)) continue;
    for (const pin of row.pins) {
      if (wanted.has(pin)) { ids.add(row.efrId); break; }
    }
  }
  return ids;
}

/*
 * Invalidate after any write that changes coverage — a technician's serviceable
 * list, their home pincode, or their active / verified flags. Cheap to call; a
 * missed call costs at most CACHE_TTL_MS of staleness.
 */
function invalidateCoverage() {
  cache = null;
}

module.exports = {
  getCoveredPincodes,
  getTechnicianIdsForPincodes,
  isCovered,
  invalidateCoverage,
  CACHE_TTL_MS,
};
