const { pool } = require('../db');
const logger = require('../logger');
const s3 = require('../utils/s3-storage');
const { getProperty, setProperty, flushCache } = require('./properties.service');

/*
 * Theme & Branding — shared by routes/admin/branding.js (CRM) and
 * routes/public/branding.js (the unauthenticated login-page read).
 *
 * It lives in one service ON PURPOSE: the "which variant is live right now?"
 * rule (enabled + today inside the window + the festival kill switch) is the
 * only thing the admin preview and the public login page must agree on. Two
 * copies of that query would drift, and the drift would only ever show up on
 * the login screen of a festival morning.
 *
 * Two storage backends, deliberately:
 *   - SETTINGS  (banner copy, tagline) → easyfix_properties. Text an operator
 *     flips at 2am during an incident; no schema, no deploy, cached in-process.
 *   - VARIANTS  (festival windows)     → easyfix_theme_variant. Rows with dates
 *     and geometry, which a CSV property could never express.
 */

// ─── Settings ────────────────────────────────────────────────────────
/*
 * API field → easyfix_properties key. Adding a setting means adding ONE entry
 * here; the GET reader, the PUT writer and the Joi schema all key off it.
 * `type` drives coercion in both directions — properties are TEXT, so a boolean
 * round-trips as the literal strings 'true' / 'false'.
 */
const SETTING_KEYS = {
  envBannerText:            { key: 'branding.env.banner.text',            type: 'text', dflt: '' },
  envBannerEnabled:         { key: 'branding.env.banner.enabled',         type: 'bool', dflt: false },
  maintenanceBannerText:    { key: 'branding.maintenance.banner.text',    type: 'text', dflt: '' },
  maintenanceBannerEnabled: { key: 'branding.maintenance.banner.enabled', type: 'bool', dflt: false },
  loginTagline:             { key: 'branding.login.tagline',              type: 'text', dflt: '' },
};

// Kill switch seeded by 2026-08-18-settings-branding.sql. Read-only from the
// API; ops flips it directly in easyfix_properties when a live ornament has to
// disappear from the login page without anyone editing a row.
const FESTIVAL_ENABLED_KEY = 'branding.festival.enabled';

/*
 * Property missing / blank → `dflt`, never a coerced empty string. A property
 * that was never seeded and a property an operator deliberately cleared must
 * both read as "off", and only an explicit 'true' turns a flag on.
 */
function readSetting({ key, type, dflt }) {
  const raw = getProperty(key);
  if (raw == null || String(raw).trim() === '') return dflt;
  if (type === 'bool') return String(raw).trim().toLowerCase() === 'true';
  return String(raw);
}

function festivalEnabled() {
  const raw = getProperty(FESTIVAL_ENABLED_KEY);
  // Absent → ON. The switch exists to turn the feature OFF in a hurry; a cold
  // property cache must not silently blank the login page's branding.
  if (raw == null || String(raw).trim() === '') return true;
  return String(raw).trim().toLowerCase() === 'true';
}

function getSettings() {
  const out = {};
  for (const [field, spec] of Object.entries(SETTING_KEYS)) out[field] = readSetting(spec);
  out.festivalEnabled = festivalEnabled();
  return out;
}

/*
 * Write only the fields the caller actually sent, then flushCache() so the new
 * value is live in THIS process immediately instead of waiting out the property
 * TTL — the otp-channel pattern. The return value is a fresh read through
 * getSettings(), not an echo of the input, so the response reports what readers
 * will actually resolve.
 *
 * Note `''` is written, not skipped: clearing a banner is the whole point of
 * the field, and an empty string is how an operator does it.
 */
async function saveSettings(patch) {
  const written = [];
  for (const [field, spec] of Object.entries(SETTING_KEYS)) {
    if (!Object.prototype.hasOwnProperty.call(patch, field)) continue;
    const v = spec.type === 'bool' ? (patch[field] ? 'true' : 'false') : String(patch[field] ?? '');
    await setProperty(spec.key, v);
    written.push(spec.key);
  }
  if (written.length) await flushCache();
  logger.info('Branding settings saved · keys=[' + written.join(', ') + ']');
  return { settings: getSettings(), written };
}

// ─── Render mode ─────────────────────────────────────────────────────
/*
 * How a variant's uploaded asset relates to the official EasyFix lockup.
 * Column added by migrations/2026-08-18-branding-render-mode.sql.
 *
 *   'overlay'  ornament composited OVER the lockup. The DEFAULT, and what
 *              every row did before the column existed — which is why the
 *              column defaults to it in the DB, in Joi, and here.
 *   'replace'  the uploaded asset IS the brand mark for that window; no lockup
 *              is drawn beneath it. For a designer-supplied complete festive
 *              lockup that would collide with the real one.
 */
const RENDER_MODE_OVERLAY = 'overlay';
const RENDER_MODE_REPLACE = 'replace';
const RENDER_MODES = [RENDER_MODE_OVERLAY, RENDER_MODE_REPLACE];

/*
 * FAIL SAFE, ALWAYS TOWARDS 'overlay'. Anything that is not exactly 'replace'
 * — NULL, '', 'REPLACE ', a typo, a value a DBA or a future import wrote
 * straight into the column, or `undefined` because the migration has not been
 * applied on this host yet — resolves to 'overlay'.
 *
 * The asymmetry is deliberate. 'overlay' is the mode that still shows the
 * official lockup, so an unrecognised value costs the page an ornament at
 * worst. Defaulting the other way would let one bad string strip EasyFix's
 * branding off an unauthenticated login page.
 */
function normalizeRenderMode(value) {
  return String(value ?? '').trim().toLowerCase() === RENDER_MODE_REPLACE
    ? RENDER_MODE_REPLACE
    : RENDER_MODE_OVERLAY;
}

// ─── Variants ────────────────────────────────────────────────────────
const VARIANT_COLUMNS = `id, name, starts_on, ends_on, ornament_key,
       anchor_x, anchor_y, scale, animated, render_mode, enabled, created_by, created_at`;

/*
 * DECIMAL comes back from mysql2 as a STRING (no decimalNumbers option on the
 * pool), so '50.00' would reach the FE and any arithmetic on it would silently
 * concatenate. Coerce the three geometry columns to real numbers here — the one
 * place every reader passes through. TINYINT(1) is already boolean-cast by the
 * pool's typeCast, and DATE is already 'YYYY-MM-DD' thanks to dateStrings.
 *
 * render_mode is normalised here for the same reason: this is the single
 * chokepoint every read — admin list, admin get, public active — flows
 * through, so no caller can be handed a mode it does not know how to render.
 */
function mapVariant(row) {
  if (!row) return null;
  return {
    ...row,
    anchor_x: row.anchor_x == null ? null : Number(row.anchor_x),
    anchor_y: row.anchor_y == null ? null : Number(row.anchor_y),
    scale:    row.scale    == null ? null : Number(row.scale),
    render_mode: normalizeRenderMode(row.render_mode),
  };
}

async function listVariants({ includeDisabled = true, limit = 100, offset = 0 } = {}) {
  const where = includeDisabled ? '' : 'WHERE enabled = 1';
  const [rows] = await pool.query(
    `SELECT ${VARIANT_COLUMNS}
       FROM easyfix_theme_variant
       ${where}
      ORDER BY starts_on DESC, id DESC
      LIMIT ?, ?`,
    [Number(offset), Number(limit)],
  );
  return rows.map(mapVariant);
}

async function getVariantById(id) {
  const [rows] = await pool.query(
    `SELECT ${VARIANT_COLUMNS} FROM easyfix_theme_variant WHERE id = ? LIMIT 1`,
    [Number(id)],
  );
  return mapVariant(rows[0]);
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

async function createVariant(body, userId) {
  if (body.ends_on < body.starts_on) throw badRequest('ends_on must not be before starts_on');
  const [r] = await pool.query(
    `INSERT INTO easyfix_theme_variant
       (name, starts_on, ends_on, ornament_key, anchor_x, anchor_y, scale, animated, render_mode, enabled, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      body.name,
      body.starts_on,
      body.ends_on,
      body.ornament_key || null,
      body.anchor_x,
      body.anchor_y,
      body.scale,
      body.animated ? 1 : 0,
      // Joi already defaults this to 'overlay'; normalising again costs nothing
      // and keeps createVariant correct for any non-HTTP caller.
      normalizeRenderMode(body.render_mode),
      body.enabled ? 1 : 0,
      userId || null,
      // Pool timezone is '+05:30', so a JS Date lands in the DATETIME column as
      // the IST wall-clock time verbatim. Do NOT "fix" this to NOW() — that
      // would read the SERVER's clock instead.
      new Date(),
    ],
  );
  logger.info('Theme variant created · id=' + r.insertId + ' name=' + body.name);
  return getVariantById(r.insertId);
}

const UPDATABLE = ['name', 'starts_on', 'ends_on', 'ornament_key', 'anchor_x', 'anchor_y', 'scale', 'animated', 'render_mode', 'enabled'];

/*
 * PATCH semantics. The window check runs against the MERGED row, not the patch:
 * sending only `ends_on` must still be rejected when it falls before the
 * starts_on already in the table — the validator cannot see that half.
 *
 * PATCH IS PARTIAL, INCLUDING FOR render_mode. The hasOwnProperty test below is
 * what guarantees it: a body that never mentions render_mode leaves the stored
 * mode alone rather than resetting it to the 'overlay' default. Joi enforces the
 * same contract by giving render_mode no `.default()` on the update schema —
 * a default there would materialise the key on every PATCH and quietly undo a
 * 'replace' every time an operator nudged anchor_x.
 */
async function updateVariant(id, patch) {
  const current = await getVariantById(id);
  if (!current) return null;

  const startsOn = patch.starts_on ?? current.starts_on;
  const endsOn   = patch.ends_on   ?? current.ends_on;
  if (endsOn < startsOn) throw badRequest('ends_on must not be before starts_on');

  const sets = [];
  const args = [];
  for (const col of UPDATABLE) {
    if (!Object.prototype.hasOwnProperty.call(patch, col)) continue;
    sets.push(`${col} = ?`);
    if (col === 'animated' || col === 'enabled') args.push(patch[col] ? 1 : 0);
    else if (col === 'ornament_key') args.push(patch[col] || null);
    else if (col === 'render_mode') args.push(normalizeRenderMode(patch[col]));
    else args.push(patch[col]);
  }
  if (!sets.length) return current;

  args.push(Number(id));
  await pool.query(`UPDATE easyfix_theme_variant SET ${sets.join(', ')} WHERE id = ?`, args);
  logger.info('Theme variant updated · id=' + id + ' fields=[' + sets.length + ']');
  return getVariantById(id);
}

/*
 * DELETE is a soft disable, never a DELETE statement. A festival window is
 * reference data an operator re-enables next year, and a live login page
 * reading a row that vanished mid-request is a worse failure than a stale one.
 */
async function disableVariant(id) {
  const [r] = await pool.query(
    'UPDATE easyfix_theme_variant SET enabled = 0 WHERE id = ?',
    [Number(id)],
  );
  if (!r.affectedRows) return null;
  logger.info('Theme variant disabled · id=' + id);
  return getVariantById(id);
}

async function setOrnament(id, key) {
  const [r] = await pool.query(
    'UPDATE easyfix_theme_variant SET ornament_key = ? WHERE id = ?',
    [key, Number(id)],
  );
  if (!r.affectedRows) return null;
  logger.info('Theme variant ornament set · id=' + id + ' key=' + key);
  return getVariantById(id);
}

// ─── Ornament URL resolution ─────────────────────────────────────────
/*
 * SECURITY BOUNDARY. This function is reachable from an UNAUTHENTICATED route,
 * so it presigns ONLY keys under `Branding/`. Anything else is returned as-is
 * when it looks like a local /easydoc URL (dev fallback) and dropped otherwise.
 *
 * The Joi schema already pins ornament_key to the same prefix; this is the
 * second lock, because a row written by a DBA or an old import never passed
 * through Joi. Without it, storing `easyfixer_documents/<aadhaar>` in the column
 * would turn the public login endpoint into a presigned-URL oracle for the
 * whole bucket.
 *
 * THE ADMIN PREVIEW SHARES THIS FUNCTION, IT DOES NOT COPY IT.
 * GET /api/admin/branding/variants/:id/ornament-url routes through
 * getVariantOrnamentUrl() below, which calls straight into here. Being
 * authenticated does not earn a weaker check: an admin session that could
 * presign an arbitrary key is still a bucket-wide read oracle, just one that
 * needs a stolen token first. One guard, one place to fix it.
 */
const ORNAMENT_PREFIX = 'Branding/';

/*
 * `expiresIn` is a passthrough to s3.getPresignedUrl and is UNDEFINED for the
 * public login read — that keeps its short PRESIGN_TTL_SEC (300s) untouched,
 * which is what the 60s Cache-Control on /public/branding/active is sized
 * against. Only the admin preview opts into a longer window; see
 * ORNAMENT_PREVIEW_TTL_SEC.
 */
async function resolveOrnamentUrl(stored, expiresIn) {
  const v = String(stored ?? '').trim();
  if (!v) return null;
  if (v.startsWith(ORNAMENT_PREFIX)) {
    if (!s3.isEnabled()) return null;
    try {
      return await s3.getPresignedUrl(v, expiresIn);
    } catch (e) {
      // A missing/unreachable object must not 500 the login page — the FE
      // simply renders without an ornament.
      logger.warn('Ornament presign failed · key=' + v + ' · ' + e.message);
      return null;
    }
  }
  // Local dev fallback: writeBuffer() hands back a relative /easydoc URL, which
  // is already directly loadable and needs no signing.
  if (v.startsWith('/')) return v;
  logger.warn('Ignoring ornament_key outside the Branding/ prefix · value=' + v.slice(0, 60));
  return null;
}

/*
 * ADMIN PREVIEW TTL — the 1-hour notice TTL, not the 5-minute default.
 *
 * WHY THE DEFAULT IS TOO SHORT HERE, SPECIFICALLY. Every ordinary presign is
 * minted for something the user is about to click, so 300s is generous. This
 * one is minted for an <img> inside an EDITING SESSION: the operator opens the
 * Edit modal, nudges anchor_x, nudges scale, re-reads the preview, saves,
 * reopens. Fifteen minutes on one festival window is an ordinary afternoon,
 * and a URL that expires mid-edit shows up as an image that silently turns
 * into a broken box — the exact failure already measured on notice images
 * (see NOTICE_PRESIGN_TTL_SEC in utils/s3-storage.js, 2026-08-14).
 *
 * WHY IT IS PROPORTIONATE. Notice images earned an hour because they are
 * broadcast announcement graphics, not PII — the short posture on client
 * documents and payout files exists to age out a leaked URL before it is
 * abusable. A festival ornament is chrome that is ALREADY served, unsigned in
 * effect, to the unauthenticated login page for the whole of its window. An
 * hour here leaks nothing the login screen does not hand out anyway.
 *
 * Reads the same env var as the notice TTL because it is the same posture
 * decision; s3-storage does not export the constant, so the default is
 * mirrored rather than imported.
 */
const ORNAMENT_PREVIEW_TTL_SEC = Number(process.env.S3_NOTICE_PRESIGN_TTL_SEC) || 3600; // 1 hour

/*
 * Admin preview resolver for ONE variant, by id.
 *
 * Three distinct outcomes, and the caller must be able to tell them apart:
 *   null                          → no such variant. The route 404s.
 *   { url: null, expiresIn: null } → the variant exists and has no ornament, or
 *                                   its stored key failed the prefix guard, or
 *                                   S3 is off. All of these are legitimate
 *                                   display states ("No Change" is the default
 *                                   on every new window), never errors.
 *   { url, expiresIn }            → a presigned GET the browser can hit
 *                                   directly. `expiresIn` is null for the local
 *                                   /easydoc dev URL, which never expires.
 */
async function getVariantOrnamentUrl(id) {
  const variant = await getVariantById(id);
  if (!variant) return null;

  const key = String(variant.ornament_key ?? '').trim();
  if (!key) return { url: null, expiresIn: null };

  const url = await resolveOrnamentUrl(key, ORNAMENT_PREVIEW_TTL_SEC);
  // Only a genuinely presigned S3 URL carries a lifetime; the dev fallback is a
  // plain relative path, so reporting a TTL for it would be a lie.
  const signed = url != null && key.startsWith(ORNAMENT_PREFIX);
  return { url, expiresIn: signed ? ORNAMENT_PREVIEW_TTL_SEC : null };
}

// ─── Public active-variant lookup ────────────────────────────────────
/*
 * The single query the login page depends on. `most recent first` breaks ties
 * between overlapping windows in favour of the one that started later — the
 * later-scheduled variant is the more specific intent (a Diwali week nested
 * inside a month-long festive season should win).
 *
 * Returns { variant: null } shape material; the route wraps it.
 *
 * ─── DECISION: 'replace' WITHOUT A USABLE ASSET FALLS BACK TO THE LOCKUP ────
 *
 * THE CALL: yes. If a variant says render_mode='replace' but its ornament does
 * not resolve to a URL, this function downgrades the mode it reports to
 * 'overlay'. The login page then renders the normal EasyFix lockup with no
 * ornament on top — which is precisely the page it renders on any ordinary day.
 *
 * WHY. In 'replace' mode the asset is not decoration, it is the ONLY brand mark
 * on an UNAUTHENTICATED page. So the two failure modes are not comparable:
 *   - honouring 'replace' with no asset  → a blank header on the login screen.
 *     To a logged-out user that is indistinguishable from a broken or spoofed
 *     site, on the one page where recognising the brand is how they decide it
 *     is safe to type a credential into it.
 *   - falling back to 'overlay'          → the correct, if unfestive, logo.
 * Failing to a correct logo beats failing to a blank header. The fallback also
 * costs nothing when things are working, and the states it catches are all
 * genuinely reachable: ornament_key NULL because the operator saved the window
 * before uploading the art, the key failing the `Branding/` prefix guard, S3
 * disabled on the environment, or a presign that threw because the object was
 * deleted out from under the row.
 *
 * WHY THE DOWNGRADE LIVES HERE AND NOT IN THE FE. This endpoint is consumed by
 * the CRM login page today and by anything else that wants the live theme
 * tomorrow. Making `render_mode` on THIS response mean "the mode you can
 * actually render right now" gives every client the safe behaviour for free and
 * leaves exactly one implementation of the rule. A client that re-derived it
 * would be one refactor away from shipping the blank header.
 *
 * WHY THE ADMIN READS ARE NOT TOUCHED. listVariants / getVariantById keep
 * reporting the STORED mode, unchanged. The operator is editing intent — they
 * need to see that they selected 'replace' and that the upload is still
 * missing, which is the whole cue to go and fix it. Only the render path
 * substitutes.
 */
async function getActiveVariant() {
  if (!festivalEnabled()) {
    logger.info('Active theme variant suppressed · branding.festival.enabled=false');
    return null;
  }
  const [rows] = await pool.query(
    `SELECT id, name, starts_on, ends_on, ornament_key, anchor_x, anchor_y, scale, animated, render_mode
       FROM easyfix_theme_variant
      WHERE enabled = 1
        AND CURDATE() BETWEEN starts_on AND ends_on
      ORDER BY starts_on DESC, id DESC
      LIMIT 1`,
  );
  const variant = mapVariant(rows[0]);
  if (!variant) return null;
  variant.ornament_url = await resolveOrnamentUrl(variant.ornament_key);

  if (variant.render_mode === RENDER_MODE_REPLACE && !variant.ornament_url) {
    // Warn, not error: the page is fine, but a variant scheduled to replace the
    // lockup and silently not doing so is something an operator must be able to
    // find in the logs without a user reporting it first.
    logger.warn(
      'Theme variant wants render_mode=replace but has no resolvable ornament · id=' +
      variant.id + ' · falling back to the EasyFix lockup (overlay)',
    );
    variant.render_mode = RENDER_MODE_OVERLAY;
  }
  return variant;
}

module.exports = {
  SETTING_KEYS,
  FESTIVAL_ENABLED_KEY,
  ORNAMENT_PREFIX,
  ORNAMENT_PREVIEW_TTL_SEC,
  RENDER_MODE_OVERLAY,
  RENDER_MODE_REPLACE,
  RENDER_MODES,
  normalizeRenderMode,
  festivalEnabled,
  getSettings,
  saveSettings,
  listVariants,
  getVariantById,
  createVariant,
  updateVariant,
  disableVariant,
  setOrnament,
  resolveOrnamentUrl,
  getVariantOrnamentUrl,
  getActiveVariant,
};
