const { pool } = require('../db');
const logger = require('../logger');
// Namespace import, not a destructured one: `getProperty` is read at CALL
// time so a properties reload (and a test) can change the answer without the
// module holding a stale binding.
const properties = require('./properties.service');

/*
 * Rewards — points ledger, shop, claims and referrals.
 *
 * ─── POINTS ARE NOT MONEY ────────────────────────────────────────────────
 *
 * EasyFix has a real wallet elsewhere: advances, withdrawals, payouts. Points
 * are a separate, non-convertible ledger. Nothing in this file may ever move
 * value between the two, and nothing here should grow a "cash out" path.
 *
 * ─── THE BALANCE IS ALWAYS DERIVED ───────────────────────────────────────
 *
 * There is no balance column. `balanceFor` sums the ledger, every time. A
 * stored balance and an append-only ledger disagree the first time a write
 * half-fails, and then the technician is looking at a number nobody can
 * justify. At 2,636 active technicians the sum is an indexed scan of a handful
 * of rows.
 *
 * Corrections are new rows, never edits or deletes — a refunded claim shows up
 * as a credit beside its original debit, so "why did my points change?" always
 * has a complete answer on screen.
 */

function mkErr(status, message, details) {
  const e = new Error(message);
  e.status = status;
  if (details) e.details = details;
  return e;
}

const REASON = Object.freeze({
  RATING: 'RATING',
  SDA: 'SDA',
  REFERRAL: 'REFERRAL',
  CLAIM: 'CLAIM',
  CLAIM_REFUND: 'CLAIM_REFUND',
  MANUAL: 'MANUAL',
});

const CLAIM_STATUSES = Object.freeze(['ORDERED', 'PACKED', 'SENT', 'DELIVERED', 'REJECTED']);
/* The forward pipeline the technician sees. REJECTED is an exit, not a step. */
const CLAIM_PIPELINE = Object.freeze(['ORDERED', 'PACKED', 'SENT', 'DELIVERED']);

const COMPLETED_JOB_STATUSES = [3, 5];

function propNumber(key, fallback) {
  const raw = Number(String(properties.getProperty(key) ?? '').trim());
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

/*
 * THE POINT VALUES — fixed in code, not configurable.
 *
 * These are the programme's published terms. A technician is told "a same-day
 * appointment is worth 30 points" and plans around it; a value that ops can
 * quietly retune mid-month turns a promise into a moving target, and the
 * ledger rows already awarded at the old rate sit alongside new ones with no
 * way to tell them apart.
 *
 * They ARE surfaced to ops read-only (GET /api/admin/rewards/config and the
 * "How Points Are Earned" panel in the CRM) so nobody has to read this file to
 * answer a technician's question. Changing them is a deploy, deliberately.
 */
const POINTS = Object.freeze({
  rating: 10,
  sda: 30,
  referral: 200,
});

/* Each rule stated the way it is explained to a technician, so the CRM panel
 * and the app screen describe the same programme in the same words. */
const EARN_RULES = Object.freeze([
  {
    code: 'RATING',
    points: POINTS.rating,
    label: 'Good Rating',
    detail: 'A customer rates the job 5 stars and the job was not escalated.',
  },
  {
    code: 'SDA',
    points: POINTS.sda,
    label: 'Same-Day Appointment',
    detail: 'You check in on the same day the appointment was booked for.',
  },
  {
    code: 'REFERRAL',
    points: POINTS.referral,
    label: 'Refer A Friend',
    detail: 'Someone joins with your code and completes their first job.',
  },
]);

/*
 * Is the programme paused?
 *
 * `rewards.earn.enabled = false` stops FURTHER EARNING and nothing else. It is
 * emphatically not a kill switch:
 *
 *   - existing balances are untouched — they are a ledger, and pausing does
 *     not delete rows;
 *   - CLAIMING stays open, because those points were already earned and
 *     withholding them would be taking something back;
 *   - the CRM and the app both say "Rewards Programme Is Paused For Now" so a
 *     technician who stops seeing points knows why, instead of assuming the
 *     feature is broken or that his good work went unnoticed.
 *
 * Seeded 'true', so pausing is a deliberate act.
 */
function earningPaused() {
  return String(properties.getProperty('rewards.earn.enabled') ?? 'true').toLowerCase() !== 'true';
}

function pointsConfig() {
  return {
    ...POINTS,
    rules: EARN_RULES,
    earningPaused: earningPaused(),
    // The only tunable left, and it is an operational safety valve rather than
    // an economic lever: how far back each earning pass looks.
    lookbackDays: propNumber('rewards.earn.lookback.days', 3),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Ledger
// ─────────────────────────────────────────────────────────────────────

async function balanceFor(efrId) {
  const [[row]] = await pool.query(
    'SELECT COALESCE(SUM(delta), 0) AS balance FROM reward_points_ledger WHERE easyfixer_id = ?',
    [Number(efrId)],
  );
  return Number(row.balance) || 0;
}

/*
 * Write one ledger row.
 *
 * Duplicates are SWALLOWED, not thrown. uq_reward_award makes a second award
 * for the same (reason, ref) impossible at the database level, which is what
 * lets the earning cron re-run over an overlapping window without paying
 * twice — so hitting that constraint is the mechanism working, not an error.
 * Any other failure still propagates.
 *
 * Accepts an optional connection so a claim can debit inside its transaction.
 */
async function award({ efrId, delta, reasonCode, refType = null, refId = null, note = null, createdBy = null }, executor = pool) {
  try {
    await executor.query(
      `INSERT INTO reward_points_ledger
         (easyfixer_id, delta, reason_code, ref_type, ref_id, note, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [Number(efrId), Math.trunc(delta), reasonCode, refType, refId, note, createdBy, new Date()],
    );
    return { awarded: true };
  } catch (e) {
    if (e && e.code === 'ER_DUP_ENTRY') return { awarded: false, duplicate: true };
    throw e;
  }
}

async function ledgerFor(efrId, { limit = 50, offset = 0 } = {}) {
  const take = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const skip = Math.max(Number(offset) || 0, 0);
  const [rows] = await pool.query(
    `SELECT id, delta, reason_code, ref_type, ref_id, note, created_at
       FROM reward_points_ledger
      WHERE easyfixer_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?`,
    [Number(efrId), take, skip],
  );
  const [[{ total }]] = await pool.query(
    'SELECT COUNT(*) AS total FROM reward_points_ledger WHERE easyfixer_id = ?',
    [Number(efrId)],
  );
  return { rows, total, limit: take, offset: skip };
}

/* Admin-side ledger: every technician, filterable, with names attached. */
async function adminLedger({ easyfixerId, reasonCode, q, limit = 100, offset = 0 } = {}) {
  const take = Math.min(Math.max(Number(limit) || 100, 1), 1000);
  const skip = Math.max(Number(offset) || 0, 0);
  const where = ['1=1'];
  const params = [];
  if (easyfixerId) { where.push('l.easyfixer_id = ?'); params.push(Number(easyfixerId)); }
  if (reasonCode) { where.push('l.reason_code = ?'); params.push(String(reasonCode)); }
  if (q && String(q).trim()) {
    where.push('(e.efr_name LIKE ? OR e.efr_no LIKE ? OR l.note LIKE ?)');
    const like = `%${String(q).trim()}%`;
    params.push(like, like, like);
  }
  const whereSql = where.join(' AND ');
  const base = `
       FROM reward_points_ledger l
       LEFT JOIN tbl_easyfixer e ON e.efr_id = l.easyfixer_id
      WHERE ${whereSql}`;

  const [rows] = await pool.query(
    `SELECT l.id, l.easyfixer_id, l.delta, l.reason_code, l.ref_type, l.ref_id,
            l.note, l.created_by, l.created_at,
            e.efr_name AS technician_name, e.efr_no AS technician_mobile
       ${base}
      ORDER BY l.created_at DESC, l.id DESC
      LIMIT ? OFFSET ?`,
    [...params, take, skip],
  );
  // Same joins as the page query — the WHERE references `e`, so a bare
  // COUNT(*) on the ledger alone would 500 the moment anyone filters by name.
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${base}`, params);
  return { rows, total, limit: take, offset: skip };
}

/*
 * A manual credit or debit by an operator.
 *
 * `note` is required and `createdBy` is recorded because an unexplained
 * balance change is the fastest way to lose a technician's trust — and the
 * first question ops will be asked is "who did this and why".
 */
async function adjustPoints({ easyfixerId, delta, note, createdBy }) {
  const amount = Math.trunc(Number(delta));
  if (!Number.isFinite(amount) || amount === 0) throw mkErr(400, 'enter a non-zero point amount');
  if (!String(note || '').trim()) throw mkErr(400, 'a reason is required for a manual adjustment');

  const [[tech]] = await pool.query('SELECT efr_id FROM tbl_easyfixer WHERE efr_id = ?', [Number(easyfixerId)]);
  if (!tech) throw mkErr(404, 'technician not found');

  // A debit that would push the balance negative is refused. Points are not
  // credit; a negative balance has no meaning the technician could act on.
  if (amount < 0) {
    const balance = await balanceFor(easyfixerId);
    if (balance + amount < 0) {
      throw mkErr(409, `technician has only ${balance} points`, { balance });
    }
  }

  await award({
    efrId: easyfixerId,
    delta: amount,
    reasonCode: REASON.MANUAL,
    note: String(note).trim().slice(0, 255),
    createdBy: createdBy ?? null,
  });
  return { balance: await balanceFor(easyfixerId) };
}

// ─────────────────────────────────────────────────────────────────────
// Shop
// ─────────────────────────────────────────────────────────────────────

function parseSizes(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function listItems({ q, includeRetired = false, limit = 200, offset = 0 } = {}) {
  const take = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  const skip = Math.max(Number(offset) || 0, 0);
  const where = ['1=1'];
  const params = [];
  if (!includeRetired) where.push('i.status = 1');
  if (q && String(q).trim()) {
    where.push('(i.name LIKE ? OR i.description LIKE ?)');
    const like = `%${String(q).trim()}%`;
    params.push(like, like);
  }
  const whereSql = where.join(' AND ');
  const [rows] = await pool.query(
    `SELECT i.id, i.name, i.description, i.image_key, i.points_cost, i.sizes,
            i.stock, i.status, i.created_at, i.updated_at,
            (SELECT COUNT(*) FROM reward_claims c WHERE c.item_id = i.id) AS claim_count
       FROM reward_items i
      WHERE ${whereSql}
      ORDER BY i.status DESC, i.points_cost ASC, i.id ASC
      LIMIT ? OFFSET ?`,
    [...params, take, skip],
  );
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM reward_items i WHERE ${whereSql}`,
    params,
  );
  return {
    rows: rows.map((r) => ({ ...r, sizeOptions: parseSizes(r.sizes) })),
    total,
    limit: take,
    offset: skip,
  };
}

async function getItem(id) {
  const [[row]] = await pool.query('SELECT * FROM reward_items WHERE id = ?', [Number(id)]);
  if (!row) throw mkErr(404, 'reward item not found');
  return { ...row, sizeOptions: parseSizes(row.sizes) };
}

async function createItem({ name, description, points_cost, sizes, stock, image_key }) {
  const now = new Date();
  const [ins] = await pool.query(
    `INSERT INTO reward_items (name, description, image_key, points_cost, sizes, stock, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [
      String(name).trim(),
      description || null,
      image_key || null,
      Math.max(1, Math.trunc(Number(points_cost) || 0)),
      parseSizes(sizes).join(',') || null,
      Math.max(0, Math.trunc(Number(stock) || 0)),
      now,
      now,
    ],
  );
  logger.info('Reward item created · id=' + ins.insertId);
  return { id: ins.insertId };
}

async function updateItem(id, patch = {}) {
  await getItem(id);
  const sets = [];
  const params = [];
  if (patch.name !== undefined) { sets.push('name = ?'); params.push(String(patch.name).trim()); }
  // Plain placeholders, never COALESCE(?, col): COALESCE guards NULL only, so
  // an empty string would pass straight through it and blank the column while
  // looking like a guard. Clearing a description is a legitimate edit.
  if (patch.description !== undefined) { sets.push('description = ?'); params.push(patch.description || null); }
  if (patch.image_key !== undefined) { sets.push('image_key = ?'); params.push(patch.image_key || null); }
  if (patch.points_cost !== undefined) { sets.push('points_cost = ?'); params.push(Math.max(1, Math.trunc(Number(patch.points_cost) || 0))); }
  if (patch.sizes !== undefined) { sets.push('sizes = ?'); params.push(parseSizes(patch.sizes).join(',') || null); }
  if (patch.stock !== undefined) { sets.push('stock = ?'); params.push(Math.max(0, Math.trunc(Number(patch.stock) || 0))); }
  if (patch.status !== undefined) { sets.push('status = ?'); params.push(patch.status ? 1 : 0); }
  if (!sets.length) throw mkErr(400, 'nothing to update');
  sets.push('updated_at = ?');
  params.push(new Date());
  await pool.query(`UPDATE reward_items SET ${sets.join(', ')} WHERE id = ?`, [...params, Number(id)]);
  return getItem(id);
}

/* Retire, never delete — a claim from last month must keep resolving. */
async function retireItem(id) {
  await getItem(id);
  await pool.query('UPDATE reward_items SET status = 0, updated_at = ? WHERE id = ?', [new Date(), Number(id)]);
  return { retired: true };
}

// ─────────────────────────────────────────────────────────────────────
// Claims
// ─────────────────────────────────────────────────────────────────────

/*
 * Claim an item.
 *
 * Points are debited IN THE SAME TRANSACTION that creates the claim, not when
 * ops dispatches it. Debiting later would let a technician with 400 points
 * claim four 400-point items and leave ops to discover it.
 *
 * The row is locked FOR UPDATE and the balance re-read inside the transaction,
 * so two claims submitted at once cannot both pass a balance check made
 * outside it. Stock is decremented conditionally in the same breath — a
 * `WHERE stock > 0` that affects zero rows IS the sold-out signal, rather than
 * a read-then-write that two claims can both win.
 *
 * The delivery address is COPIED onto the claim. Where a parcel was sent must
 * not change when the technician later edits his profile.
 */
async function claimItem(efrId, { itemId, size, address }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[item]] = await conn.query(
      'SELECT id, name, points_cost, sizes, stock, status FROM reward_items WHERE id = ? FOR UPDATE',
      [Number(itemId)],
    );
    if (!item) throw mkErr(404, 'reward item not found');
    if (Number(item.status) !== 1) throw mkErr(409, 'this reward is no longer available');

    const sizeOptions = parseSizes(item.sizes);
    const chosenSize = String(size || '').trim();
    if (sizeOptions.length && !sizeOptions.includes(chosenSize)) {
      throw mkErr(400, 'choose a size', { sizes: sizeOptions });
    }
    if (!sizeOptions.length && chosenSize) {
      throw mkErr(400, 'this reward has no size options');
    }

    const [[bal]] = await conn.query(
      'SELECT COALESCE(SUM(delta), 0) AS balance FROM reward_points_ledger WHERE easyfixer_id = ?',
      [Number(efrId)],
    );
    const balance = Number(bal.balance) || 0;
    const cost = Number(item.points_cost);
    if (balance < cost) {
      throw mkErr(409, `you need ${cost - balance} more points for this reward`, { balance, cost });
    }

    const [stockUpdate] = await conn.query(
      'UPDATE reward_items SET stock = stock - 1 WHERE id = ? AND stock > 0',
      [Number(itemId)],
    );
    if (stockUpdate.affectedRows === 0) throw mkErr(409, 'this reward is out of stock');

    const line = String(address?.line || '').trim();
    if (!line) throw mkErr(400, 'a delivery address is required');

    const now = new Date();
    const [ins] = await conn.query(
      `INSERT INTO reward_claims
         (easyfixer_id, item_id, item_name, size, points_spent,
          address_line, address_city, address_pincode, address_phone,
          status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ORDERED', ?, ?)`,
      [
        Number(efrId), Number(itemId), item.name, chosenSize || null, cost,
        line.slice(0, 500),
        String(address?.city || '').trim().slice(0, 120) || null,
        String(address?.pincode || '').trim().slice(0, 12) || null,
        String(address?.phone || '').trim().slice(0, 20) || null,
        now, now,
      ],
    );

    await conn.query(
      `INSERT INTO reward_points_ledger
         (easyfixer_id, delta, reason_code, ref_type, ref_id, note, created_at)
       VALUES (?, ?, ?, 'claim', ?, ?, ?)`,
      [Number(efrId), -cost, REASON.CLAIM, ins.insertId, item.name, now],
    );

    await conn.commit();
    logger.info('Reward claimed · efrId=' + efrId + ' · item=' + itemId + ' · claim=' + ins.insertId);
    return { claimId: ins.insertId, pointsSpent: cost, balance: balance - cost };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

async function claimsFor(efrId, { limit = 50, offset = 0 } = {}) {
  const take = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const skip = Math.max(Number(offset) || 0, 0);
  const [rows] = await pool.query(
    `SELECT id, item_id, item_name, size, points_spent, status, tracking_ref,
            reject_reason, address_line, address_city, address_pincode,
            created_at, updated_at
       FROM reward_claims
      WHERE easyfixer_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?`,
    [Number(efrId), take, skip],
  );
  return { rows, limit: take, offset: skip };
}

async function listClaims({ status, q, limit = 100, offset = 0 } = {}) {
  const take = Math.min(Math.max(Number(limit) || 100, 1), 1000);
  const skip = Math.max(Number(offset) || 0, 0);
  const where = ['1=1'];
  const params = [];
  if (status) { where.push('c.status = ?'); params.push(String(status)); }
  if (q && String(q).trim()) {
    where.push('(e.efr_name LIKE ? OR e.efr_no LIKE ? OR c.item_name LIKE ? OR c.tracking_ref LIKE ?)');
    const like = `%${String(q).trim()}%`;
    params.push(like, like, like, like);
  }
  const whereSql = where.join(' AND ');
  const base = `
       FROM reward_claims c
       LEFT JOIN tbl_easyfixer e ON e.efr_id = c.easyfixer_id
      WHERE ${whereSql}`;
  const [rows] = await pool.query(
    `SELECT c.*, e.efr_name AS technician_name, e.efr_no AS technician_mobile ${base}
      ORDER BY c.created_at DESC, c.id DESC
      LIMIT ? OFFSET ?`,
    [...params, take, skip],
  );
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${base}`, params);
  return { rows, total, limit: take, offset: skip };
}

/*
 * Move a claim along the pipeline, or reject it.
 *
 * Rejection REFUNDS by writing a new credit row and returns the unit to stock.
 * The original debit is left exactly where it is: deleting it would erase the
 * technician's record of what happened, and the pair of rows is the
 * explanation.
 *
 * The refund carries the claim id as its ref, so uq_reward_award makes a
 * double refund impossible even if the endpoint is called twice.
 */
async function updateClaim(claimId, { status, trackingRef, rejectReason }, actorUserId = null) {
  const next = String(status || '').toUpperCase();
  if (!CLAIM_STATUSES.includes(next)) throw mkErr(400, 'invalid claim status');
  if (next === 'REJECTED' && !String(rejectReason || '').trim()) {
    throw mkErr(400, 'a reason is required to reject a claim');
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[claim]] = await conn.query(
      'SELECT id, easyfixer_id, item_id, item_name, points_spent, status FROM reward_claims WHERE id = ? FOR UPDATE',
      [Number(claimId)],
    );
    if (!claim) throw mkErr(404, 'claim not found');
    if (claim.status === 'REJECTED') throw mkErr(409, 'this claim was already rejected');
    if (claim.status === 'DELIVERED' && next !== 'DELIVERED') {
      throw mkErr(409, 'a delivered claim cannot be moved back');
    }

    /*
     * tracking_ref is only written when the caller SUPPLIED it.
     *
     * Writing it unconditionally looks harmless and is not: advancing
     * SENT → DELIVERED without resending the field would blank a courier
     * reference the technician is actively watching in the app. An omitted
     * key means "leave it alone"; an explicit empty string still clears it,
     * which is how a mistyped reference gets removed.
     */
    const sets = ['status = ?', 'reject_reason = ?', 'updated_at = ?'];
    const params = [
      next,
      next === 'REJECTED' ? String(rejectReason).trim().slice(0, 255) : null,
      new Date(),
    ];
    if (trackingRef !== undefined) {
      sets.splice(1, 0, 'tracking_ref = ?');
      params.splice(1, 0, String(trackingRef || '').trim() || null);
    }
    await conn.query(
      `UPDATE reward_claims SET ${sets.join(', ')} WHERE id = ?`,
      [...params, Number(claimId)],
    );

    if (next === 'REJECTED') {
      await conn.query(
        `INSERT INTO reward_points_ledger
           (easyfixer_id, delta, reason_code, ref_type, ref_id, note, created_by, created_at)
         VALUES (?, ?, ?, 'claim', ?, ?, ?, ?)`,
        [
          claim.easyfixer_id, Number(claim.points_spent), REASON.CLAIM_REFUND,
          claim.id, `Refund · ${claim.item_name}`, actorUserId, new Date(),
        ],
      );
      // The unit never shipped, so it goes back on the shelf.
      await conn.query('UPDATE reward_items SET stock = stock + 1 WHERE id = ?', [claim.item_id]);
    }

    await conn.commit();
    logger.info('Claim updated · id=' + claimId + ' · ' + claim.status + ' → ' + next);
    return { id: Number(claimId), status: next, refunded: next === 'REJECTED' };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

// ─────────────────────────────────────────────────────────────────────
// Referrals
// ─────────────────────────────────────────────────────────────────────

/*
 * Codes are read ALOUD over a phone call, so the alphabet excludes every pair
 * that sounds or looks alike: no O/0, no I/1/L, no S/5. What survives is
 * unambiguous when spoken in a noisy street, which is where these are shared.
 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRTUVWXYZ23456789';

function randomCode(length = 6) {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

/* Get this technician's permanent code, generating it on first use. */
async function referralCodeFor(efrId) {
  const [[existing]] = await pool.query(
    'SELECT code FROM reward_referral_codes WHERE easyfixer_id = ?',
    [Number(efrId)],
  );
  if (existing) return existing.code;

  // Retry on collision rather than pre-checking: the unique index is the
  // authority, and at this alphabet size a clash is rare enough that a loop of
  // five is a generous ceiling.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = `EF${randomCode(6)}`;
    try {
      await pool.query(
        'INSERT INTO reward_referral_codes (easyfixer_id, code, created_at) VALUES (?, ?, ?)',
        [Number(efrId), code, new Date()],
      );
      logger.info('Referral code issued · efrId=' + efrId);
      return code;
    } catch (e) {
      if (e && e.code === 'ER_DUP_ENTRY') {
        // Either the code collided, or a concurrent request just created this
        // technician's row — re-read before trying again.
        const [[row]] = await pool.query(
          'SELECT code FROM reward_referral_codes WHERE easyfixer_id = ?',
          [Number(efrId)],
        );
        if (row) return row.code;
        continue;
      }
      throw e;
    }
  }
  throw mkErr(500, 'could not issue a referral code');
}

/*
 * Attach a referral at registration. Records the link; pays nothing.
 *
 * Self-referral is refused, and uq_referred_once means the FIRST attribution
 * wins permanently — otherwise the code could be swapped after joining to
 * whoever is paying.
 */
async function attachReferral(referredEfrId, code) {
  const clean = String(code || '').trim().toUpperCase();
  if (!clean) throw mkErr(400, 'enter a referral code');

  const [[owner]] = await pool.query(
    'SELECT easyfixer_id FROM reward_referral_codes WHERE code = ?',
    [clean],
  );
  if (!owner) throw mkErr(404, 'that referral code is not valid');
  if (Number(owner.easyfixer_id) === Number(referredEfrId)) {
    throw mkErr(409, 'you cannot use your own referral code');
  }

  try {
    await pool.query(
      `INSERT INTO reward_referrals (referrer_efr_id, referred_efr_id, code, joined_at)
       VALUES (?, ?, ?, ?)`,
      [Number(owner.easyfixer_id), Number(referredEfrId), clean, new Date()],
    );
  } catch (e) {
    if (e && e.code === 'ER_DUP_ENTRY') {
      throw mkErr(409, 'a referral code has already been applied to this account');
    }
    throw e;
  }
  logger.info('Referral attached · referrer=' + owner.easyfixer_id + ' · referred=' + referredEfrId);
  return { referrerEfrId: Number(owner.easyfixer_id), code: clean };
}

/* What a technician sees about their own invitations. */
async function referralSummary(efrId) {
  const [rows] = await pool.query(
    `SELECT r.referred_efr_id, r.joined_at, r.qualified_at, e.efr_name AS referred_name
       FROM reward_referrals r
       LEFT JOIN tbl_easyfixer e ON e.efr_id = r.referred_efr_id
      WHERE r.referrer_efr_id = ?
      ORDER BY r.joined_at DESC
      LIMIT 50`,
    [Number(efrId)],
  );
  return {
    code: await referralCodeFor(efrId),
    joined: rows.length,
    qualified: rows.filter((r) => r.qualified_at).length,
    referrals: rows,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Earning
// ─────────────────────────────────────────────────────────────────────

/*
 * Award points for everything earned in the recent window.
 *
 * BOUNDED LOOKBACK, not "everything since the beginning". Two reasons, and the
 * second is the important one:
 *
 *   - the query stays small regardless of how long the programme has run;
 *   - it makes BACKFILL STRUCTURALLY IMPOSSIBLE. There are 317,777 historical
 *     ratings in this database. A cron that looked at all of them would hand
 *     out millions of points on its first run. The window means the programme
 *     genuinely starts the day it is switched on.
 *
 * Every write is idempotent through uq_reward_award, so an overlapping window
 * (the default is three days, run daily) re-reads rows it has already paid and
 * writes nothing.
 */
async function runEarnCycle() {
  const config = pointsConfig();
  const result = { paused: config.earningPaused, rating: 0, sda: 0, referral: 0, skipped: 0 };

  /*
   * Honoured here as well as at cron registration, so Trigger Now respects a
   * pause too — an operator testing the job should not quietly resume a
   * programme someone deliberately stopped.
   *
   * Pausing stops NEW earning only. Balances stand, claiming stays open, and
   * both the CRM and the app say so.
   */
  if (config.earningPaused) {
    logger.info('Rewards earning paused — rewards.earn.enabled is not true');
    return result;
  }

  const since = new Date(Date.now() - config.lookbackDays * 24 * 60 * 60 * 1000);

  // ── Rating: 5★ only, and only when that job carries no escalation.
  // 88.6% of all ratings in this database are 5★, so without the escalation
  // filter this would pay on nearly every job and mean nothing.
  if (config.rating > 0) {
    const [rows] = await pool.query(
      `SELECT r.easyfixer_id, r.job_id
         FROM tbl_easyfixer_rating_by_customer r
        WHERE r.customer_rating = 5
          AND COALESCE(r.is_escalated, 0) <> 1
          AND r.insert_date_time >= ?
          AND r.easyfixer_id IS NOT NULL
          AND r.job_id IS NOT NULL`,
      [since],
    );
    for (const row of rows) {
      const out = await award({
        efrId: row.easyfixer_id,
        delta: config.rating,
        reasonCode: REASON.RATING,
        refType: 'job',
        refId: row.job_id,
        note: `5-star rating on job #${row.job_id}`,
      });
      if (out.awarded) result.rating += 1; else result.skipped += 1;
    }
  }

  // ── SDA: check-in landed on the appointment's own calendar day.
  // The predicate is copied VERBATIM from mobile-performance.service.js so the
  // points and the SDA % the technician already sees can never disagree.
  if (config.sda > 0) {
    const [rows] = await pool.query(
      `SELECT j.job_id, j.fk_easyfixter_id AS efr_id
         FROM tbl_job j
        WHERE j.job_status IN (?)
          AND j.checkin_date_time IS NOT NULL
          AND j.checkin_date_time >= ?
          AND j.fk_easyfixter_id IS NOT NULL
          AND DATE(j.checkin_date_time) = DATE(COALESCE(j.original_appointment_date_time, j.requested_date_time))`,
      [COMPLETED_JOB_STATUSES, since],
    );
    for (const row of rows) {
      const out = await award({
        efrId: row.efr_id,
        delta: config.sda,
        reasonCode: REASON.SDA,
        refType: 'job',
        refId: row.job_id,
        note: `Same-day appointment on job #${row.job_id}`,
      });
      if (out.awarded) result.sda += 1; else result.skipped += 1;
    }
  }

  // ── Referral: pays when the REFERRED technician completes their first job.
  // Not at signup — that would be an invitation to invent technicians.
  if (config.referral > 0) {
    const [rows] = await pool.query(
      `SELECT r.id, r.referrer_efr_id, r.referred_efr_id, e.efr_name AS referred_name
         FROM reward_referrals r
         JOIN tbl_easyfixer e ON e.efr_id = r.referred_efr_id
         JOIN tbl_easyfixer ref ON ref.efr_id = r.referrer_efr_id
        WHERE r.qualified_at IS NULL
          -- The referrer must still be a real, active technician AT AWARD TIME,
          -- not merely when the code was entered. A blacklisted account should
          -- not be earning on invitations.
          AND ref.efr_status = 1
          AND EXISTS (
                SELECT 1 FROM tbl_job j
                 WHERE j.fk_easyfixter_id = r.referred_efr_id
                   AND j.job_status IN (?)
                   AND j.checkin_date_time IS NOT NULL
              )`,
      [COMPLETED_JOB_STATUSES],
    );
    for (const row of rows) {
      const out = await award({
        efrId: row.referrer_efr_id,
        delta: config.referral,
        reasonCode: REASON.REFERRAL,
        refType: 'referral',
        refId: row.id,
        note: `${row.referred_name || 'A technician'} joined using your code`,
      });
      if (out.awarded) {
        await pool.query('UPDATE reward_referrals SET qualified_at = ? WHERE id = ?', [new Date(), row.id]);
        result.referral += 1;
      } else {
        result.skipped += 1;
      }
    }
  }

  logger.info('Rewards earning · rating=' + result.rating + ' · sda=' + result.sda
    + ' · referral=' + result.referral + ' · alreadyPaid=' + result.skipped);
  return result;
}

module.exports = {
  REASON,
  CLAIM_STATUSES,
  CLAIM_PIPELINE,
  pointsConfig,
  balanceFor,
  award,
  ledgerFor,
  adminLedger,
  adjustPoints,
  listItems,
  getItem,
  createItem,
  updateItem,
  retireItem,
  claimItem,
  claimsFor,
  listClaims,
  updateClaim,
  referralCodeFor,
  attachReferral,
  referralSummary,
  runEarnCycle,
  _internals: { parseSizes, randomCode, CODE_ALPHABET },
};
