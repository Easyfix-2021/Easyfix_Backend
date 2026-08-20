const { pool } = require('../db');
const logger = require('../logger');
const s3Storage = require('../utils/s3-storage');
// Namespace import, not a destructured one: `getProperty` is read at CALL
// time so a properties reload (and a test) can change the answer without the
// module holding a stale binding.
const properties = require('./properties.service');
const profileCompletion = require('./profile-completion.service');
const { withMysqlNamedLock } = require('./mysql-named-lock.service');

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
const REWARD_IMAGE_RESOLUTION_CONCURRENCY = 5;
const MOBILE_REWARD_SHOP_LIMIT = 50;

const COMPLETED_JOB_STATUSES = [3, 5];
const REFERRAL_RECONCILE_LIMIT = 100;
const REFERRAL_RECONCILE_PAGE_SIZE = 25;
const REFERRAL_ATTACH_MAX_ATTEMPTS = 3;
const REFERRAL_RECONCILE_TASK = 'profile_qualification';
const REFERRAL_RECONCILE_LOCK = 'easyfix:rewards:referral-qualification';

/*
 * A MISSING property must fall back — it must not read as zero.
 *
 * The previous body pushed an absent key through String(undefined ?? '') to
 * '', and Number('') is 0, NOT NaN. The `raw >= 0` guard then accepted that
 * zero as a legitimate configured value, so the fallback was unreachable for
 * precisely the case it existed to cover.
 *
 * That is not theoretical: 'rewards.earn.lookback.days' was never seeded, so
 * lookbackDays resolved to 0, the earning window collapsed to zero width, and
 * the nightly pass awarded nothing from go-live on 2026-08-13 until
 * 2026-08-18 while logging counts indistinguishable from a quiet night.
 *
 * Absent and blank are therefore settled BEFORE any numeric coercion. A
 * present-but-unparseable value ('abc') still falls back via the isFinite
 * guard, and an explicit '0' is still honoured — a deliberately configured
 * zero is an operator's decision, unlike a key that was never created.
 */
function propNumber(key, fallback) {
  const value = properties.getProperty(key);
  if (value == null || String(value).trim() === '') return fallback;
  const raw = Number(String(value).trim());
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

async function waitForReferralRetry(attempt) {
  // A fresh transaction is required after deadlock/timeout. A tiny bounded
  // backoff also gives the concurrent winner time to commit the immutable row
  // that the next attempt will re-read. Maximum wait is under 40ms.
  const waitMs = Math.min(10 * Math.max(Number(attempt) || 1, 1), 30)
    + Math.floor(Math.random() * 6);
  await new Promise((resolve) => { setTimeout(resolve, waitMs); });
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

/*
 * Each rule stated the way it is explained to a technician, so the CRM panel
 * and the app screen describe the same programme in the same words.
 *
 * Ordered by VALUE, highest first. Both surfaces render this array in order,
 * and "what earns the most?" is the question anyone reads this list to answer
 * — so the answer sits at the top rather than needing three numbers compared.
 * The CRM sorts defensively as well, but shipping the array already ordered
 * means the app gets it without repeating that logic.
 */
const EARN_RULES = Object.freeze([
  {
    code: 'REFERRAL',
    points: POINTS.referral,
    label: 'Refer A Friend',
    detail: 'Someone joins with your code and completes their profile.',
  },
  {
    code: 'SDA',
    points: POINTS.sda,
    label: 'Same-Day Appointment',
    detail: 'You check in on the same day the appointment was booked for.',
  },
  {
    code: 'RATING',
    points: POINTS.rating,
    label: 'Good Rating',
    detail: 'A customer rates the job 5 stars and the job was not escalated.',
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
async function adminLedger({ easyfixerId, reasonCode, q, from, to, limit = 100, offset = 0 } = {}) {
  const take = Math.min(Math.max(Number(limit) || 100, 1), 1000);
  const skip = Math.max(Number(offset) || 0, 0);
  const where = ['1=1'];
  const params = [];
  if (easyfixerId) { where.push('l.easyfixer_id = ?'); params.push(Number(easyfixerId)); }
  if (reasonCode) { where.push('l.reason_code = ?'); params.push(String(reasonCode)); }
  /*
   * ── THE DATE WINDOW ────────────────────────────────────────────────────────
   * This ledger grows ~441 rows a day and is append-only, so an unbounded read
   * gets slower every single day and never recovers. The CRM page now asks for
   * the current month on first load and lets an operator widen it.
   *
   * ⚠ THE DEFAULT LIVES IN THE CALLER, NOT HERE, AND THAT IS DELIBERATE.
   * It would be easy to make this function assume "current month" when given no
   * dates. That is the exact shape of the bug that took Manage Jobs Export down
   * on 2026-08-20: a no-filter default that quietly substituted a DIFFERENT
   * answer, so an operator asking for everything silently got a subset and had
   * no way to tell. Every other consumer of adminLedger (and any future export
   * or reconciliation job) still gets the whole ledger unless it asks otherwise.
   * The page is explicit about the window it requests; the service only ever
   * applies what it was given.
   *
   * DATE() is applied to the PARAMETER, never the column, so an index on
   * created_at stays usable — and the upper bound is EXCLUSIVE next-day, so a
   * row stamped 14:30 on the `to` date is included. A half-open window is
   * honoured: either end may be sent on its own.
   */
  if (from != null && String(from).trim() !== '') {
    where.push('l.created_at >= DATE(?)');
    params.push(String(from).trim());
  }
  if (to != null && String(to).trim() !== '') {
    where.push('l.created_at < DATE(?) + INTERVAL 1 DAY');
    params.push(String(to).trim());
  }
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

/*
 * The mobile Shop first paint needs only the active product cards. Keep this
 * projection separate from `listItems`: the admin catalogue also needs retired
 * rows, claim counts, pagination totals and audit timestamps, while calculating
 * those on every technician summary request is unused work.
 *
 * There is deliberately no OFFSET or total-count query here. The current app
 * renders one bounded catalogue and the server enforces the 50-card ceiling
 * even if a future caller supplies a larger value.
 */
async function listMobileShopItems({ limit = MOBILE_REWARD_SHOP_LIMIT } = {}) {
  const take = Math.min(
    Math.max(Number(limit) || MOBILE_REWARD_SHOP_LIMIT, 1),
    MOBILE_REWARD_SHOP_LIMIT,
  );
  const [rows] = await pool.query(
    `SELECT i.id, i.name, i.description, i.image_key, i.points_cost, i.sizes, i.stock
       FROM reward_items i
      WHERE i.status = 1
      ORDER BY i.points_cost ASC, i.id ASC
      LIMIT ?`,
    [take],
  );
  return itemsForMobile(rows.map(({ sizes, ...row }) => ({
    ...row,
    sizeOptions: parseSizes(sizes),
  })));
}

/**
 * Mobile DTO for a bounded shop page. Raw object-store keys stay server-side;
 * one failed signature degrades only that product image, not the whole shop.
 */
async function resolveRewardImageUrl(storedValue) {
  const stored = String(storedValue || '').trim();
  if (!stored) return null;
  if (/^(https?:\/\/|data:image\/)/i.test(stored) || stored.startsWith('/')) return stored;

  /*
   * `reward_items.image_key` stores an object key, not a job-image filename.
   * Canonical keys can therefore be signed directly: probing every product
   * with HeadObject first doubles S3 traffic and lets one 50-item shop paint
   * fan out into 100+ AWS requests. Bare legacy values still use the shared
   * resolver, whose HEAD-based migration fallback is bounded by the worker
   * pool in `itemsForMobile` below.
   */
  if (s3Storage.isEnabled() && stored.includes('/')) {
    return s3Storage.getPresignedUrl(stored);
  }
  return s3Storage.resolveImageUrl(stored);
}

async function itemsForMobile(rows = []) {
  const source = Array.isArray(rows) ? rows : [];
  const result = new Array(source.length);
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < source.length) {
      const index = nextIndex;
      nextIndex += 1;
      const row = source[index];
      const { image_key: imageKey, ...item } = row;
      let imageUrl = null;
      if (imageKey) {
        try {
          imageUrl = await resolveRewardImageUrl(imageKey);
        } catch (error) {
          logger.warn(
            { err: error.message, rewardItemId: Number(row.id) },
            'Reward item image URL resolution failed',
          );
        }
      }
      result[index] = { ...item, imageUrl };
    }
  };

  const workerCount = Math.min(REWARD_IMAGE_RESOLUTION_CONCURRENCY, source.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return result;
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
async function claimItem(efrId, {
  itemId,
  size,
  address,
  idempotencyKey,
}) {
  const claimKey = String(idempotencyKey || '').trim();
  if (!claimKey) throw mkErr(400, 'Idempotency-Key is required for reward claims');
  if (claimKey.length > 128) throw mkErr(400, 'Idempotency-Key too long (max 128 chars)');

  const chosenSize = String(size || '').trim();
  const delivery = {
    line: String(address?.line || '').trim(),
    city: String(address?.city || '').trim(),
    pincode: String(address?.pincode || '').trim(),
    phone: String(address?.phone || '').replace(/\D/g, ''),
  };
  if (delivery.line.length < 5 || delivery.line.length > 500) {
    throw mkErr(400, 'a complete delivery address is required');
  }
  if (delivery.city.length < 2 || delivery.city.length > 120) {
    throw mkErr(400, 'a delivery city is required');
  }
  if (!/^[1-9]\d{5}$/.test(delivery.pincode)) {
    throw mkErr(400, 'enter a valid 6-digit delivery pincode');
  }
  if (!/^[6-9]\d{9}$/.test(delivery.phone)) {
    throw mkErr(400, 'enter a valid 10-digit delivery phone number');
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Lock one row shared by EVERY claim for this technician before reading
    // the derived points balance. Product locks alone only serialize claims
    // for the same item; two different products could otherwise both spend
    // the same points concurrently.
    await conn.query(
      'SELECT efr_id FROM tbl_easyfixer WHERE efr_id = ? FOR UPDATE',
      [Number(efrId)],
    );

    /*
     * The shared HTTP idempotency ledger normally replays the response before
     * this service runs. This claim-owned key closes the remaining crash
     * window: the claim transaction may commit and the generic response ledger
     * may then fail to persist. A retry reaches this transaction, locks the
     * same technician row, and finds the committed claim before touching
     * product stock or writing a second points debit.
     */
    const [[existingClaim]] = await conn.query(
      `SELECT id, item_id, size, points_spent,
              address_line, address_city, address_pincode, address_phone
         FROM reward_claims
        WHERE easyfixer_id = ? AND idempotency_key = ?
        LIMIT 1
        FOR UPDATE`,
      [Number(efrId), claimKey],
    );
    if (existingClaim) {
      const samePayload = Number(existingClaim.item_id) === Number(itemId)
        && String(existingClaim.size || '') === chosenSize
        && String(existingClaim.address_line || '') === delivery.line
        && String(existingClaim.address_city || '') === delivery.city
        && String(existingClaim.address_pincode || '') === delivery.pincode
        && String(existingClaim.address_phone || '') === delivery.phone;
      if (!samePayload) {
        throw mkErr(409, 'Idempotency-Key reused with a different reward claim', {
          code: 'IDEMPOTENCY_KEY_REUSED',
        });
      }

      const [[currentBalance]] = await conn.query(
        'SELECT COALESCE(SUM(delta), 0) AS balance FROM reward_points_ledger WHERE easyfixer_id = ?',
        [Number(efrId)],
      );
      await conn.commit();
      return {
        claimId: Number(existingClaim.id),
        pointsSpent: Number(existingClaim.points_spent),
        balance: Number(currentBalance.balance) || 0,
      };
    }

    const [[item]] = await conn.query(
      'SELECT id, name, points_cost, sizes, stock, status FROM reward_items WHERE id = ? FOR UPDATE',
      [Number(itemId)],
    );
    if (!item) throw mkErr(404, 'reward item not found');
    if (Number(item.status) !== 1) throw mkErr(409, 'this reward is no longer available');

    const sizeOptions = parseSizes(item.sizes);
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

    const now = new Date();
    const [ins] = await conn.query(
      `INSERT INTO reward_claims
         (easyfixer_id, item_id, item_name, size, points_spent, idempotency_key,
          address_line, address_city, address_pincode, address_phone,
          status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ORDERED', ?, ?)`,
      [
        Number(efrId), Number(itemId), item.name, chosenSize || null, cost,
        claimKey,
        delivery.line,
        delivery.city,
        delivery.pincode,
        delivery.phone,
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
            reject_reason, address_line, address_city, address_pincode, address_phone,
            created_at, updated_at
       FROM reward_claims
      WHERE easyfixer_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?`,
    [Number(efrId), take, skip],
  );
  const [[{ total }]] = await pool.query(
    'SELECT COUNT(*) AS total FROM reward_claims WHERE easyfixer_id = ?',
    [Number(efrId)],
  );
  return { rows, total: Number(total) || 0, limit: take, offset: skip };
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

function normalizeReferralCode(code) {
  return String(code || '').trim().toUpperCase();
}

async function matchingReferralLedger(conn, referral, expectedPoints) {
  const [[row]] = await conn.query(
    `SELECT id, easyfixer_id, delta
       FROM reward_points_ledger
      WHERE reason_code = ?
        AND ref_type = 'referral'
        AND ref_id = ?
      LIMIT 1`,
    [REASON.REFERRAL, Number(referral.id)],
  );
  return Boolean(
    row
    && Number(row.easyfixer_id) === Number(referral.referrer_efr_id)
    && Number(row.delta) === Number(expectedPoints),
  );
}

/*
 * Qualify one referral from persisted Complete Profile state.
 *
 * The preliminary unique-key probe is intentionally outside a transaction:
 * almost every profile save belongs to a technician who was not referred, so
 * that common path costs one indexed point-read and does not occupy a pooled
 * connection. If an attribution is attached concurrently after this probe,
 * attachReferral performs the same qualification after its own commit.
 *
 * Once a row exists, the referral row is locked. The points insert and
 * qualified_at update then commit together. uq_reward_award is still the
 * authoritative exactly-once guard; a legacy half-state with an existing
 * ledger row is repaired only after the row is verified to have the expected
 * technician and points value.
 */
async function qualifyReferralIfEligible(
  referredEfrId,
  { database = pool, knownReferralId = null, config = pointsConfig() } = {},
) {
  if (config.earningPaused || Number(config.referral) <= 0) {
    return { qualified: false, paused: true };
  }

  let referralId = knownReferralId == null ? null : Number(knownReferralId);
  if (!referralId) {
    const [[probe]] = await database.query(
      'SELECT id FROM reward_referrals WHERE referred_efr_id = ? LIMIT 1',
      [Number(referredEfrId)],
    );
    if (!probe) return { qualified: false, referred: false };
    referralId = Number(probe.id);
  }

  const conn = await database.getConnection();
  let transactionStarted = false;
  try {
    await conn.beginTransaction();
    transactionStarted = true;
    const [[referral]] = await conn.query(
      `SELECT id, referrer_efr_id, referred_efr_id, qualified_at
         FROM reward_referrals
        WHERE id = ? AND referred_efr_id = ?
        FOR UPDATE`,
      [referralId, Number(referredEfrId)],
    );
    if (!referral) {
      await conn.commit();
      transactionStarted = false;
      return { qualified: false, referred: false };
    }
    if (referral.qualified_at) {
      await conn.commit();
      transactionStarted = false;
      return {
        qualified: true,
        alreadyQualified: true,
        qualifiedAt: referral.qualified_at,
      };
    }

    const completion = await profileCompletion.read(referredEfrId, { database: conn });
    if (!completion || !completion.profileComplete) {
      await conn.commit();
      transactionStarted = false;
      return { qualified: false, referred: true, completion };
    }

    const [[referrer]] = await conn.query(
      `SELECT efr_status
         FROM tbl_easyfixer
        WHERE efr_id = ?
        LIMIT 1
        FOR UPDATE`,
      [Number(referral.referrer_efr_id)],
    );
    // Preserve the existing policy: only an active technician may earn referral
    // points at award time. A paused programme or inactive referrer remains
    // pending for bounded reconciliation after the condition changes.
    if (!referrer || Number(referrer.efr_status) !== 1) {
      await conn.commit();
      transactionStarted = false;
      return {
        qualified: false,
        referred: true,
        completion,
        reason: 'referrer_inactive',
      };
    }

    const out = await award({
      efrId: referral.referrer_efr_id,
      delta: config.referral,
      reasonCode: REASON.REFERRAL,
      refType: 'referral',
      refId: referral.id,
      note: `${completion.name || 'A technician'} completed their profile using your code`,
    }, conn);

    let repaired = false;
    if (out.duplicate) {
      if (!(await matchingReferralLedger(conn, referral, config.referral))) {
        throw mkErr(500, 'referral reward ledger is inconsistent');
      }
      repaired = true;
    }

    const qualifiedAt = new Date();
    await conn.query(
      'UPDATE reward_referrals SET qualified_at = ? WHERE id = ? AND qualified_at IS NULL',
      [qualifiedAt, Number(referral.id)],
    );
    await conn.commit();
    transactionStarted = false;
    logger.info(
      'Referral qualified · referral=' + referral.id
      + ' · referrer=' + referral.referrer_efr_id
      + ' · repaired=' + repaired,
    );
    return {
      qualified: true,
      awarded: out.awarded === true,
      repaired,
      qualifiedAt,
      completion,
    };
  } catch (error) {
    if (transactionStarted) {
      try { await conn.rollback(); } catch (_) { /* retain original failure */ }
    }
    throw error;
  } finally {
    conn.release();
  }
}

/*
 * Profile mutations have already committed when they call this. A rewards
 * outage must not turn an applied offline/idempotent registration write into a
 * false failure; the capped nightly reconciliation is the durable fallback.
 */
async function qualifyReferralAfterProfileMutation(
  referredEfrId,
  { knownReferralId = null, source = 'profile-mutation' } = {},
) {
  try {
    return await qualifyReferralIfEligible(referredEfrId, { knownReferralId });
  } catch (error) {
    logger.warn({
      efrId: Number(referredEfrId),
      source,
      code: error?.code || 'REFERRAL_QUALIFICATION_DEFERRED',
    }, 'Post-profile referral qualification deferred');
    return {
      qualified: false,
      pending: true,
      errorCode: 'REFERRAL_QUALIFICATION_DEFERRED',
    };
  }
}

/*
 * Attach a referral during profile completion. The first attribution remains
 * immutable, but retrying the SAME code is a successful idempotent replay.
 * A different code still conflicts, so a referral can never be swapped.
 */
async function attachReferral(referredEfrId, code) {
  const clean = normalizeReferralCode(code);
  if (!clean) throw mkErr(400, 'enter a referral code');

  const [[owner]] = await pool.query(
    'SELECT easyfixer_id FROM reward_referral_codes WHERE code = ?',
    [clean],
  );
  if (!owner) throw mkErr(404, 'that referral code is not valid');
  if (Number(owner.easyfixer_id) === Number(referredEfrId)) {
    throw mkErr(409, 'you cannot use your own referral code');
  }

  let referralId;
  let idempotent = false;
  let attached = false;
  for (let attempt = 1; attempt <= REFERRAL_ATTACH_MAX_ATTEMPTS; attempt += 1) {
    const conn = await pool.getConnection();
    let transactionStarted = false;
    try {
      await conn.beginTransaction();
      transactionStarted = true;
      const [[existing]] = await conn.query(
        `SELECT id, referrer_efr_id, code
           FROM reward_referrals
          WHERE referred_efr_id = ?
          FOR UPDATE`,
        [Number(referredEfrId)],
      );
      if (existing) {
        if (normalizeReferralCode(existing.code) !== clean
            || Number(existing.referrer_efr_id) !== Number(owner.easyfixer_id)) {
          throw mkErr(409, 'a different referral code has already been applied to this account');
        }
        referralId = Number(existing.id);
        idempotent = true;
      } else {
        const [insert] = await conn.query(
          `INSERT INTO reward_referrals (referrer_efr_id, referred_efr_id, code, joined_at)
           VALUES (?, ?, ?, ?)`,
          [Number(owner.easyfixer_id), Number(referredEfrId), clean, new Date()],
        );
        referralId = Number(insert.insertId);
      }
      await conn.commit();
      transactionStarted = false;
      attached = true;
      break;
    } catch (error) {
      if (transactionStarted) {
        try { await conn.rollback(); } catch (_) { /* retain original failure */ }
      }
      const concurrentRetry = error?.code === 'ER_DUP_ENTRY'
        || error?.code === 'ER_LOCK_DEADLOCK'
        || error?.code === 'ER_LOCK_WAIT_TIMEOUT';
      if (!concurrentRetry) throw error;
      if (attempt === REFERRAL_ATTACH_MAX_ATTEMPTS) {
        const unavailable = mkErr(503, 'referral code could not be applied right now; please retry');
        unavailable.code = 'REFERRAL_ATTACH_RETRY_EXHAUSTED';
        throw unavailable;
      }
      await waitForReferralRetry(attempt);
    } finally {
      conn.release();
    }
  }
  if (!attached) throw mkErr(503, 'referral code could not be applied right now; please retry');

  const qualification = await qualifyReferralAfterProfileMutation(referredEfrId, {
    knownReferralId: referralId,
    source: 'referral-attach',
  });
  logger.info(
    'Referral attached · referrer=' + owner.easyfixer_id
    + ' · referred=' + referredEfrId
    + ' · idempotent=' + idempotent,
  );
  return {
    referrerEfrId: Number(owner.easyfixer_id),
    code: clean,
    idempotent,
    qualification,
  };
}

/* Lightweight registration read: no code generation and no outgoing list. */
async function referralAttribution(efrId) {
  const [[row]] = await pool.query(
    `SELECT e.efr_id, e.efr_name, e.efr_no,
            ${profileCompletion.projectionSql()},
            r.code AS referral_code,
            r.joined_at,
            r.qualified_at,
            ref.efr_name AS referrer_name
       FROM tbl_easyfixer e
       LEFT JOIN tbl_user u ON u.user_id = e.user_id
       LEFT JOIN reward_referrals r ON r.referred_efr_id = e.efr_id
       LEFT JOIN tbl_easyfixer ref ON ref.efr_id = r.referrer_efr_id
      WHERE e.efr_id = ?
      LIMIT 1`,
    [Number(efrId)],
  );
  if (!row) throw mkErr(404, 'technician not found');
  const completion = profileCompletion.fromRow(row);
  return {
    referredBy: row.referral_code
      ? {
        code: row.referral_code,
        referrerName: row.referrer_name || null,
        joinedAt: row.joined_at || null,
        qualifiedAt: row.qualified_at || null,
      }
      : null,
    qualification: {
      skillsComplete: completion.skillsComplete,
      identityComplete: completion.identityComplete,
      workAreaComplete: completion.personalDetailsComplete,
      profileComplete: completion.profileComplete,
      qualified: Boolean(row.qualified_at),
    },
  };
}

/* What a technician sees about their own invitations. */
async function referralSummary(efrId) {
  const [listResult, countResult, referredByResult, code] = await Promise.all([
    pool.query(
      `SELECT r.referred_efr_id, r.joined_at, r.qualified_at, e.efr_name AS referred_name
         FROM reward_referrals r
         LEFT JOIN tbl_easyfixer e ON e.efr_id = r.referred_efr_id
        WHERE r.referrer_efr_id = ?
        ORDER BY r.joined_at DESC, r.id DESC
        LIMIT 50`,
      [Number(efrId)],
    ),
    pool.query(
      `SELECT COUNT(*) AS joined,
              COALESCE(SUM(qualified_at IS NOT NULL), 0) AS qualified
         FROM reward_referrals
        WHERE referrer_efr_id = ?`,
      [Number(efrId)],
    ),
    pool.query(
      `SELECT r.code, r.joined_at, r.qualified_at, e.efr_name AS referrer_name
         FROM reward_referrals r
         LEFT JOIN tbl_easyfixer e ON e.efr_id = r.referrer_efr_id
        WHERE r.referred_efr_id = ?
        LIMIT 1`,
      [Number(efrId)],
    ),
    referralCodeFor(efrId),
  ]);
  const rows = listResult[0];
  const counts = countResult[0][0] || {};
  const referredBy = referredByResult[0][0] || null;
  return {
    code,
    joined: Number(counts.joined) || 0,
    qualified: Number(counts.qualified) || 0,
    referrals: rows,
    referredBy: referredBy
      ? {
        code: referredBy.code,
        referrerName: referredBy.referrer_name || null,
        qualifiedAt: referredBy.qualified_at || null,
      }
      : null,
  };
}

/*
 * Bounded, keyset-paginated CRM read. The endpoint fetches one extra row to
 * produce hasMore/nextCursor without a separate COUNT over searched names.
 */
async function listReferrals({ status, code, search, q, cursor, limit = 50 } = {}) {
  const take = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const where = ['1=1'];
  const params = [];
  if (status === 'qualified') where.push('r.qualified_at IS NOT NULL');
  if (status === 'pending') where.push('r.qualified_at IS NULL');
  if (code && String(code).trim()) {
    where.push('r.code = ?');
    params.push(normalizeReferralCode(code));
  }
  if (cursor) {
    where.push('r.id < ?');
    params.push(Number(cursor));
  }
  const searchText = String(search ?? q ?? '').trim();
  if (searchText) {
    // Prefix search keeps code/mobile/name predicates eligible for their
    // indexes. A leading-wildcard contains search would eventually scan the
    // full referral/technician population for every debounced keystroke.
    const like = `${searchText}%`;
    const numeric = /^\d+$/.test(searchText) ? Number(searchText) : null;
    if (numeric != null && Number.isSafeInteger(numeric)) {
      where.push(`(r.id = ? OR r.referrer_efr_id = ? OR r.referred_efr_id = ?
        OR r.code LIKE ? OR ref.efr_no LIKE ? OR referred.efr_no LIKE ?
        OR ref.efr_name LIKE ? OR referred.efr_name LIKE ?)`);
      params.push(numeric, numeric, numeric, like, like, like, like, like);
    } else {
      where.push('(r.code LIKE ? OR ref.efr_name LIKE ? OR referred.efr_name LIKE ?)');
      params.push(like, like, like);
    }
  }

  const [rows] = await pool.query(
    `SELECT r.id, r.code, r.joined_at, r.qualified_at,
            r.referrer_efr_id, ref.efr_name AS referrer_name, ref.efr_no AS referrer_mobile,
            r.referred_efr_id, referred.efr_name AS referred_name, referred.efr_no AS referred_mobile,
            ${profileCompletion.projectionSql({ technicianAlias: 'referred', userAlias: 'referred_user' })}
       FROM reward_referrals r
       JOIN tbl_easyfixer ref ON ref.efr_id = r.referrer_efr_id
       JOIN tbl_easyfixer referred ON referred.efr_id = r.referred_efr_id
       LEFT JOIN tbl_user referred_user ON referred_user.user_id = referred.user_id
      WHERE ${where.join(' AND ')}
      ORDER BY r.id DESC
      LIMIT ?`,
    [...params, take + 1],
  );
  const hasMore = rows.length > take;
  const page = rows.slice(0, take).map((row) => {
    const completion = profileCompletion.fromRow(row);
    return {
      id: Number(row.id),
      code: row.code,
      status: row.qualified_at ? 'qualified' : 'pending',
      joinedAt: row.joined_at,
      qualifiedAt: row.qualified_at || null,
      referrer: {
        efrId: Number(row.referrer_efr_id),
        name: row.referrer_name || null,
        mobileMasked: row.referrer_mobile || null,
      },
      referred: {
        efrId: Number(row.referred_efr_id),
        name: row.referred_name || null,
        mobileMasked: row.referred_mobile || null,
      },
      profile: {
        skillsComplete: completion.skillsComplete,
        identityComplete: completion.identityComplete,
        workAreaComplete: completion.personalDetailsComplete,
        complete: completion.profileComplete,
      },
    };
  });
  return {
    items: page,
    limit: take,
    hasMore,
    nextCursor: hasMore && page.length ? String(page[page.length - 1].id) : null,
  };
}

/*
 * Claim a bounded, rotating set of pending attribution IDs. The cursor row is
 * locked only while IDs are selected and advanced; profile reads and rewards
 * happen after commit. The caller holds a database-wide named lock for the
 * complete pass, so another replica cannot wrap and re-claim these IDs while
 * they are in flight. Advancing before processing means a corrupt row cannot
 * poison every later referral. It is retried after the cursor wraps.
 */
async function claimReferralReconciliationCandidates({
  database = pool,
  cap,
  pageSize,
  taskName = REFERRAL_RECONCILE_TASK,
}) {
  const conn = await database.getConnection();
  let transactionStarted = false;
  try {
    await conn.beginTransaction();
    transactionStarted = true;
    let [[state]] = await conn.query(
      `SELECT last_referral_id
         FROM reward_reconciliation_state
        WHERE task_name = ?
        FOR UPDATE`,
      [taskName],
    );
    if (!state) {
      await conn.query(
        `INSERT INTO reward_reconciliation_state
           (task_name, last_referral_id, updated_at)
         VALUES (?, 0, ?)`,
        [taskName, new Date()],
      );
      state = { last_referral_id: 0 };
    }

    const startCursor = Math.max(Number(state.last_referral_id) || 0, 0);
    let cursor = startCursor;
    let wrapped = false;
    const candidates = [];

    while (candidates.length < cap) {
      const take = Math.min(pageSize, cap - candidates.length);
      const [rows] = wrapped
        ? await conn.query(
          `SELECT id, referred_efr_id
             FROM reward_referrals
            WHERE qualified_at IS NULL
              AND id > ?
              AND id <= ?
            ORDER BY id ASC
            LIMIT ?`,
          [cursor, startCursor, take],
        )
        : await conn.query(
          `SELECT id, referred_efr_id
             FROM reward_referrals
            WHERE qualified_at IS NULL
              AND id > ?
            ORDER BY id ASC
            LIMIT ?`,
          [cursor, take],
        );

      if (rows.length) {
        candidates.push(...rows.map((row) => ({
          id: Number(row.id),
          referred_efr_id: Number(row.referred_efr_id),
        })));
        cursor = Number(rows[rows.length - 1].id);
      }

      if (rows.length < take) {
        if (!wrapped && startCursor > 0) {
          wrapped = true;
          cursor = 0;
          continue;
        }
        break;
      }
    }

    const nextCursor = candidates.length ? cursor : 0;
    await conn.query(
      `UPDATE reward_reconciliation_state
          SET last_referral_id = ?, updated_at = ?
        WHERE task_name = ?`,
      [nextCursor, new Date(), taskName],
    );
    await conn.commit();
    transactionStarted = false;
    return { candidates, cursor: nextCursor, wrapped };
  } catch (error) {
    if (transactionStarted) {
      try { await conn.rollback(); } catch (_) { /* retain original failure */ }
    }
    throw error;
  } finally {
    conn.release();
  }
}

/*
 * Durable fallback for post-commit profile triggers. Candidate selection uses
 * only reward_referrals' indexed pending/id columns and stops at a hard cap;
 * eligibility is checked per candidate inside the same locked award path used
 * by online profile completion.
 */
async function reconcileReferralQualifications({
  limit = REFERRAL_RECONCILE_LIMIT,
  pageSize = REFERRAL_RECONCILE_PAGE_SIZE,
  config = pointsConfig(),
  database = pool,
  qualify = qualifyReferralIfEligible,
  lockRunner = withMysqlNamedLock,
} = {}) {
  const cap = Math.min(Math.max(Number(limit) || REFERRAL_RECONCILE_LIMIT, 1), 200);
  const page = Math.min(Math.max(Number(pageSize) || REFERRAL_RECONCILE_PAGE_SIZE, 1), 50);
  const result = {
    awarded: 0,
    repaired: 0,
    skipped: 0,
    errors: 0,
    scanned: 0,
    cap,
    cursor: 0,
    wrapped: false,
    lockSkipped: false,
  };
  if (config.earningPaused || Number(config.referral) <= 0) return result;

  const ownership = await lockRunner(
    REFERRAL_RECONCILE_LOCK,
    async () => {
      const claimed = await claimReferralReconciliationCandidates({
        database,
        cap,
        pageSize: page,
      });
      result.cursor = claimed.cursor;
      result.wrapped = claimed.wrapped;
      for (const row of claimed.candidates) {
        result.scanned += 1;
        try {
          const out = await qualify(row.referred_efr_id, {
            knownReferralId: row.id,
            config,
            database,
          });
          if (out.awarded) result.awarded += 1;
          else if (out.repaired) result.repaired += 1;
          else result.skipped += 1;
        } catch (error) {
          result.errors += 1;
          logger.warn({
            referralId: Number(row.id),
            code: error?.code || 'REFERRAL_RECONCILE_FAILED',
          }, 'Referral reconciliation candidate deferred');
        }
      }
      return result;
    },
    database,
    { timeoutSeconds: 0 },
  );
  if (!ownership.acquired) {
    result.lockSkipped = true;
    logger.info('Referral reconciliation skipped — another backend replica owns the pass');
    return result;
  }
  return ownership.result;
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
  const result = {
    paused: config.earningPaused,
    windowDays: config.lookbackDays,
    windowFrom: null,
    rating: 0,
    ratingRows: 0,
    sda: 0,
    sdaRows: 0,
    referral: 0,
    skipped: 0,
  };

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

  /*
   * Report the window as the exact IST wall-clock string mysql2 will bind
   * (the pool runs timezone '+05:30'), so the log answers "what did this run
   * actually ask the database for?" without anyone re-deriving it.
   *
   * The zero-width guard is not hypothetical. When
   * 'rewards.earn.lookback.days' was absent, propNumber coerced the missing
   * value to 0, `since` became this instant, and both queries below asked for
   * rows in the future. They returned nothing, raised nothing, and logged
   * "rating=0 · sda=0" — indistinguishable from a quiet night. Only the award
   * counts were ever printed, so a window of zero width stayed invisible for
   * five days while eligible rows piled up.
   */
  result.windowFrom = new Date(since.getTime() + 5.5 * 60 * 60 * 1000)
    .toISOString().slice(0, 19).replace('T', ' ');
  if (!(config.lookbackDays > 0)) {
    logger.warn('Rewards earning · lookback is ' + config.lookbackDays
      + ' days — the window has zero width, so nothing can ever be awarded. '
      + "Set 'rewards.earn.lookback.days' in easyfix_properties (3 is the intended default).");
  }

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
    result.ratingRows = rows.length;
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
    result.sdaRows = rows.length;
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

  // ── Referral: pays when the REFERRED technician completes all three profile
  // cards. The mobile writes trigger this immediately; this capped pass repairs
  // transient post-commit misses without ever scanning an unbounded backlog.
  if (config.referral > 0) {
    const reconciliation = await reconcileReferralQualifications({ config });
    result.referral += reconciliation.awarded;
    result.skipped += reconciliation.skipped + reconciliation.repaired;
    result.referralReconciliation = reconciliation;
  }

  /*
   * rating=awarded/scanned, not just awarded. The pair separates "no rows
   * matched" (0/0 — a window, predicate or data problem) from "all of them
   * were already paid" (0/862 — a healthy overlapping re-run). Those two look
   * identical when only the award count is printed, and telling them apart is
   * the whole diagnostic.
   */
  logger.info('Rewards earning · window=' + result.windowDays + 'd from ' + result.windowFrom
    + ' · rating=' + result.rating + '/' + result.ratingRows
    + ' · sda=' + result.sda + '/' + result.sdaRows
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
  listMobileShopItems,
  getItem,
  createItem,
  updateItem,
  retireItem,
  claimItem,
  claimsFor,
  itemsForMobile,
  listClaims,
  updateClaim,
  referralCodeFor,
  attachReferral,
  qualifyReferralIfEligible,
  qualifyReferralAfterProfileMutation,
  referralAttribution,
  referralSummary,
  listReferrals,
  reconcileReferralQualifications,
  runEarnCycle,
  _internals: {
    parseSizes,
    randomCode,
    CODE_ALPHABET,
    normalizeReferralCode,
    matchingReferralLedger,
    claimReferralReconciliationCandidates,
    REFERRAL_RECONCILE_LIMIT,
    REFERRAL_RECONCILE_PAGE_SIZE,
    REFERRAL_ATTACH_MAX_ATTEMPTS,
    REFERRAL_RECONCILE_TASK,
    REFERRAL_RECONCILE_LOCK,
  },
};
