/*
 * tbl_address — shared probe + write helpers.
 *
 * Lives in services/ rather than utils/ because everything here issues SQL and
 * memoises DB probe results; utils/ is stateless and DB-free by convention.
 *
 * tbl_address is POLYMORPHIC and drift-prone, which is the whole reason this
 * module exists:
 *   - customer/job rows are keyed by `customer_id`
 *   - technician-personal rows are keyed by `user_id` (~21.6k rows, address_type
 *     NULL) and use a DISJOINT column set (house_no, district, state, city1/city,
 *     is_address_details_filled)
 *   - the column set itself differs per deploy (`address_instruction` is the
 *     usual offender), so every writer probes before it writes.
 *
 * Every function takes an explicit `executor` (a pool OR a caller-owned
 * transaction connection) instead of importing the db singleton: the writers run
 * inside transactions owned by their callers, and it keeps this module free of a
 * circular require with job.service.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO: unify the writers. They disagree on
 * purpose and the disagreements are load-bearing, so each one is a named option
 * here rather than an averaged-out "smart" write:
 *   - overwrite (`col = ?`) vs COALESCE (`col = COALESCE(?, col)`)
 *   - which columns a given writer owns (locality/mobile_number are insert-only)
 *   - whether a probe failure degrades the write or aborts the transaction
 * Callers that don't fit are left alone on purpose — see the notes on each
 * export.
 */

/*
 * is_instruction_added — legacy "does this address carry notes?" flag.
 *
 * 2026-06-03 (per ops): this column must stay 0 even when address_instruction
 * is non-empty. Keeping it in sync with the text (1 when filled, 0 when blank)
 * collided with downstream legacy logic that uses the flag as a gate (rule TBD).
 * Persisting 0 unconditionally is the agreed invariant; the text in
 * address_instruction remains the canonical source for reads.
 *
 * Writers still TOUCH the column rather than omitting it, so a row flipped to 1
 * by older code resets to 0 — leaving stale 1s behind would defeat the invariant.
 */
const logger = require('../logger');

const IS_INSTRUCTION_ADDED = 0;

// ─── Column probes ───────────────────────────────────────────────────

let _hasInstructionColumn = null;

/*
 * Does this deploy carry tbl_address.address_instruction?
 *
 * The options exist because the callers genuinely need different semantics —
 * they are NOT tuning knobs, and collapsing them to one default silently
 * changes a call site:
 *
 *   cache        true  → read/populate the process-wide memo (read paths).
 *                false → probe fresh, leave the memo untouched. The write paths
 *                        have always re-probed per call on their own txn conn;
 *                        a cached answer would go stale against a deploy that
 *                        adds the column under a live process.
 *   onProbeError 'assume-absent' → degrade, i.e. write without the column.
 *                'throw'        → propagate, aborting the caller's transaction.
 *                        job.service update() has always thrown here: a probe
 *                        failure mid-edit means the DB is unhealthy, and the
 *                        surrounding edit should roll back rather than silently
 *                        drop the operator's instruction text.
 *
 * NB: intentionally NOT built on top of addressColumnSet(). That helper caches
 * only on success and lets failures propagate; folding a swallowed error into a
 * shared column-set memo would cache an EMPTY set, and its caller reads an empty
 * set as "no writable columns" and skips the write entirely — silent data loss.
 *
 * NB: the magic-link services deliberately do NOT use this probe — see
 * job-magic-link.service.js addressHasInstruction() for why.
 */
async function hasAddressInstructionColumn(executor, { cache = true, onProbeError = 'assume-absent' } = {}) {
  if (cache && _hasInstructionColumn !== null) return _hasInstructionColumn;
  let present;
  try {
    const [rows] = await executor.query(
      `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'tbl_address'
          AND COLUMN_NAME  = 'address_instruction'
        LIMIT 1`,
    );
    present = rows.length > 0;
  } catch (e) {
    if (onProbeError === 'throw') throw e;
    /*
     * A failure is NOT cached. The success answer is frozen for the process because a column that exists does not vanish; a failure frozen the same way turns a two-second information_schema blip into a degraded mode that lasts until the container restarts, with nothing in the logs saying so.
     * Returning early is what keeps it out of the memo below.
     */
    logger.warn('address: address_instruction probe failed · ' + e.message
      + ' — treating as absent for this call only');
    return false;
  }
  if (cache) _hasInstructionColumn = present;
  return present;
}

let _columnSet = null;

/*
 * The live column set of tbl_address.
 *
 * The technician-address writer needs the WHOLE set rather than one column: the
 * table is shared/polymorphic and its columns drift across deploys, so that
 * writer only ever writes columns that actually exist and resolves the
 * `city` vs `city1` ambiguity from this. Caches on success only — a failure
 * propagates, because an empty or partial set would silently narrow the write.
 */
async function addressColumnSet(executor) {
  if (_columnSet) return _columnSet;
  const [rows] = await executor.query(
    `SELECT COLUMN_NAME FROM information_schema.columns
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tbl_address'`);
  _columnSet = new Set(rows.map((r) => r.COLUMN_NAME));
  return _columnSet;
}

// ─── Writes ──────────────────────────────────────────────────────────

/*
 * Columns the customer-supplied UPDATE owns. Frozen module constant, never
 * caller input — it is interpolated into SQL, values stay parameterised.
 */
const COALESCE_COLUMNS = Object.freeze([
  'address', 'building', 'landmark', 'city_id', 'pin_code', 'gps_location',
]);

/*
 * Build the customer-supplied address UPDATE used by both magic-link submit
 * paths (form + chat).
 *
 * COALESCE, not overwrite: a field the customer didn't supply arrives as NULL
 * and the existing column value survives. That is what bounds the blast radius —
 * job.service create() REUSES a caller-supplied address_id, so sibling jobs can
 * share an fk_address_id and this UPDATE reaches all of them.
 *
 * `fields` values must ALREADY be normalised by the caller; NULL means "keep
 * existing". This helper deliberately does not normalise, because the two
 * callers disagree on `address` (the chat flow collapses '' to NULL, the form
 * flow passes '' through) and absorbing that here would silently change one of
 * them. The gate deciding whether to write at all also stays at the call site,
 * for the same reason — the two gates differ.
 *
 *   hasInstructionColumn  include the address_instruction SET at all
 *                         (schema-drift gate — see the probe helpers above).
 *   resetInstructionFlag  additionally pin is_instruction_added back to 0 when
 *                         the caller supplied instruction text. The form flow
 *                         does this; the chat flow never has.
 *
 * Returns { sql, params } — the caller executes it on its own conn.
 */
function buildCoalesceAddressUpdate(addressId, fields, { hasInstructionColumn = false, resetInstructionFlag = false } = {}) {
  const setClauses = COALESCE_COLUMNS.map((c) => `${c} = COALESCE(?, ${c})`);
  const params = COALESCE_COLUMNS.map((c) => fields[c] ?? null);

  if (hasInstructionColumn) {
    setClauses.push('address_instruction = COALESCE(?, address_instruction)');
    params.push(fields.address_instruction ?? null);
    // Bare assignment, NOT COALESCE-guarded — the point is to clear a stale 1.
    if (resetInstructionFlag && (fields.address_instruction ?? null) != null) {
      setClauses.push('is_instruction_added = ?');
      params.push(IS_INSTRUCTION_ADDED);
    }
  }
  params.push(addressId);

  return {
    sql: `UPDATE tbl_address SET ${setClauses.join(', ')} WHERE address_id = ?`,
    params,
  };
}

/*
 * INSERT a customer-owned address row (keyed by customer_id) — the create-job /
 * Book-New-Call path. Runs on the caller's transaction conn.
 *
 * Writes `locality` and `mobile_number`, which job.service update() does NOT —
 * that path cannot edit them, and this asymmetry is intentional, not an
 * oversight to be "fixed" by aligning the two column sets.
 *
 * The column list is built from the probe, so a deploy without
 * address_instruction still gets a valid INSERT; on that deploy the instruction
 * text is silently dropped (degraded — the read path can't surface it there
 * either).
 */
async function insertCustomerAddress(conn, customerId, addr, actor) {
  // Uncached, on the caller's txn conn: preserves the per-create probe this path
  // has always done, and degrades rather than aborting the create.
  const hasInstruction = await hasAddressInstructionColumn(conn, {
    cache: false,
    onProbeError: 'assume-absent',
  });

  const cols = ['customer_id', 'address', 'building', 'landmark', 'locality',
    'city_id', 'pin_code', 'gps_location', 'mobile_number'];
  const vals = [customerId, addr.address, addr.building || null, addr.landmark || null,
    addr.locality || null, addr.city_id, addr.pin_code, addr.gps_location || null,
    addr.mobile_number || null];

  if (hasInstruction) {
    cols.push('address_instruction', 'is_instruction_added');
    vals.push(addr.address_instruction || null, IS_INSTRUCTION_ADDED);
  }
  cols.push('created_by', 'insert_date', 'update_date');
  vals.push(actor?.user_id || null, new Date(), new Date());

  const [ins] = await conn.query(
    `INSERT INTO tbl_address (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    vals,
  );
  return ins.insertId;
}

module.exports = {
  IS_INSTRUCTION_ADDED,
  hasAddressInstructionColumn,
  addressColumnSet,
  buildCoalesceAddressUpdate,
  insertCustomerAddress,
};
