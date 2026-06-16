/**
 * services/easyfixer-profile-update-link.service.js
 *
 * Easyfixer Profile-Update Magic-Link.
 *
 * Operator-triggered, self-serve "update your details" flow for an
 * easyfixer (technician). The CRM Manage Easyfixers row gets a "Send
 * Profile Update Link" action; the easyfixer receives a WhatsApp message
 * containing a shortened JWT URL; tapping it lands them on a public
 * Next.js page (/profile-update/:token) that prefills their existing
 * profile fields and lets them save updates without authenticating.
 *
 * Mirrors the customer Magic-Link flow in
 * services/job-magic-link.service.js — same three exports, same pool
 * injection convention, same parameterised-SQL + transactional-write
 * disciplines. Three exports power the feature:
 *   1. fetchPrefill(efrId, pool)                      — public GET payload builder
 *   2. sendForEasyfixer(efrId, {action}, actor, pool) — admin-triggered send + audit
 *   3. acceptSubmission(efrId, payload, pool)         — public PUT commit (transactional)
 *
 * Schema additions (migrations/2026-06-11-easyfixer-profile-update-magic-link.sql):
 *   tbl_easyfixer.profile_update_sent_at      DATETIME
 *   tbl_easyfixer.profile_update_send_count   INT  DEFAULT 0
 *   tbl_easyfixer.profile_update_last_action  VARCHAR(20)
 *
 * Style: CommonJS, parameterised SQL, mysql2/promise. `pool` is injected
 * (consistent with services/job-magic-link.service.js + the rest of
 * services/*) so this module stays unit-testable and free of a direct
 * db.js import.
 */

const { signEasyfixerProfileToken } = require('../utils/jwt');
// WhatsApp wrapper — Gallabox.
// Same provider the customer magic-link uses (services/job-magic-link.service.js
// docblock has the full rationale for staying on Gallabox vs Meta Cloud).
// Both NOTIFICATIONS_DISABLE and TEST_MOBILE are honoured by the wrapper.
const whatsappService = require('./gallabox.whatsapp.service');
const urlShortener    = require('./url-shortener.service');
const verification    = require('./easyfixer-verification.service');
const deepSkillService = require('./deep-skill.service');
const s3Storage        = require('../utils/s3-storage');
const logger          = require('../logger');

/**
 * Resolve an `efr_profile_img` S3 key to a short-TTL presigned GET URL.
 *
 * Profile-image keys don't share a single canonical prefix across the
 * legacy upload paths (`tbl_easyfixer.efr_profile_img` predates the
 * S3 prefix discipline used by Skills/, JobSupportings/, etc.), so this
 * helper is deliberately prefix-agnostic — unlike
 * `deepSkillService.resolveImageUrlFromKey` which is `Skills/`-only.
 *
 * Returns null for empty / unconfigured / non-presignable values so the
 * caller can fall back to an initials avatar without crashing the request.
 */
/**
 * Resolve a CSV of `tbl_easyfixer.efr_service_category` values to an array
 * of human-readable category names (2026-06-11).
 *
 * Legacy column behavior is messy: the value may be a single category ID
 * (`"5"`), a CSV of IDs (`"5,8,12"`), or a CSV of raw names
 * (`"Plumbing,Electrical"`). We split on comma, then for each item: if it
 * looks numeric, resolve via tbl_service_catg; otherwise keep the literal
 * string. Input order is preserved. Empty/null input returns `[]`.
 *
 * Returns `string[]` — the FE renders inline if length === 1, as a
 * bullet list if length > 1, hides the section if length === 0.
 */
/*
 * Module-scope cache for resolveServiceCategories (2026-06-11).
 * Keyed by the raw CSV string; 60-second TTL. Sessions where the same
 * operator pings several technicians with identical category setups
 * (common — e.g. five Plumbing techs in a row) skip redundant IN-clause
 * queries against tbl_service_catg. Short TTL keeps the latency to
 * pick up a category rename below a minute.
 */
const SERVICE_CATEGORIES_CACHE_TTL_MS = 60 * 1000;
const serviceCategoriesCache = new Map();

async function resolveServiceCategories(rawCsv, pool) {
  const trimmed = String(rawCsv || '').trim();
  if (!trimmed) return [];

  const cached = serviceCategoriesCache.get(trimmed);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.categories;
  }

  const parts = trimmed.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return [];
  const ids = [];
  const literal = [];
  for (const p of parts) {
    if (/^\d+$/.test(p)) ids.push(Number(p));
    else literal.push(p);
  }
  let resolved = [];
  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',');
    const [rows] = await pool.query(
      `SELECT service_catg_id, service_catg_name
         FROM tbl_service_catg
        WHERE service_catg_id IN (${placeholders})`,
      ids,
    );
    const byId = new Map(rows.map((r) => [r.service_catg_id, r.service_catg_name]));
    // Preserve input order; drop any IDs that didn't resolve.
    resolved = ids.map((id) => byId.get(id)).filter(Boolean);
  }
  const categories = [...resolved, ...literal];
  serviceCategoriesCache.set(trimmed, {
    categories,
    expiresAt: Date.now() + SERVICE_CATEGORIES_CACHE_TTL_MS,
  });
  return categories;
}

async function presignProfileImage(key) {
  const trimmed = String(key || '').trim();
  if (!trimmed) return null;
  if (!s3Storage.isEnabled()) return null;
  /*
   * Candidate-key fallback (2026-06-11). Profile images uploaded via the
   * legacy `easyfixer_documents` path store a BARE filename in
   * `tbl_easyfixer.efr_profile_img` (e.g. `EFRDoc20260423133411.jpg`)
   * but the S3 object lives under the `easyfixer_documents/` prefix
   * (mirrors the local Nginx layout — see utils/file-storage.js). A naïve
   * presign of the bare filename produces a valid signature but the object
   * URL 404s. Try the candidates in order; first object that EXISTS wins.
   */
  const candidates = [trimmed];
  // If the stored value already contains a path separator, it's already
  // prefixed (or some other shape) — don't double-prefix. Otherwise add
  // the canonical `easyfixer_documents/` legacy prefix.
  if (!trimmed.includes('/')) {
    candidates.push(`easyfixer_documents/${trimmed}`);
  }
  for (const candidate of candidates) {
    try {
      if (await s3Storage.exists(candidate)) {
        return await s3Storage.getPresignedUrl(candidate);
      }
    } catch (e) {
      logger.warn(
        { err: e && e.message, candidate },
        'profile-update: profile-image candidate check failed',
      );
      // Keep trying other candidates — don't fail the whole prefill.
    }
  }
  return null;
}

/**
 * Editable profile fields surfaced to the easyfixer. INTENTIONALLY EXCLUDES
 * sensitive / verification-gated columns:
 *   - bank details (account number / IFSC / holder name / cancelled cheque)
 *   - identity numbers (adhaar_card_number, pan_card_number)
 *   - verification flags (is_*_verified_by_crm, is_technician_verified)
 *   - skill / tool ratings (operator-only on the verification page)
 *   - efr_no (the mobile is the business identifier — changing it would
 *     break the WhatsApp send target AND the duplicate-detection on create)
 *   - efr_status / audit columns
 *
 * Anything NOT in this list is silently dropped by acceptSubmission's
 * UPDATE-builder loop (column-allowlist approach — even if the FE sends
 * a tampered payload, no sensitive column gets written).
 *
 * Frozen so a future refactor can't accidentally enlarge the surface
 * without an explicit code change reaching this file.
 */
const EDITABLE_BASIC_COLUMNS = Object.freeze([
  'efr_first_name',
  'efr_last_name',
  'efr_email',
  'efr_alt_no',         // legacy column name preserved (typo not corrected)
  'date_of_birth',
  'efr_marital_status',
  'efr_children',
  'about_yourself',
  'about_yourself2',    // "Hobbies" in the verification page
]);

/**
 * Resolve the customer-visible base URL for the profile-update link.
 *
 * CRM_PUBLIC_BASE_URL is set per-environment; falls back to the prod CRM
 * origin so a missing env var still produces a working link in prod (it
 * would only mis-target if accidentally unset in QA — a TEST_MOBILE
 * intercept in the WhatsApp layer mitigates the customer-facing risk).
 */
function profileUpdateUrl(token) {
  const base = process.env.CRM_PUBLIC_BASE_URL || 'https://crm.easyfix.in';
  return `${base.replace(/\/$/, '')}/profile-update/${token}`;
}

// ─── 1. fetchPrefill ────────────────────────────────────────────────
/**
 * Public GET payload for the profile-update landing page.
 *
 * Caller contract: routes/public/easyfixer-profile-update.js has already
 * verified the JWT via verifyEasyfixerProfileToken. This function is free
 * to assume the efrId came from a trusted token; the 404 throw below is a
 * defensive guard for the edge case where the easyfixer row was deleted
 * between the auth check and this read.
 *
 * Reuses the deep-skill + serviceable-pincode SELECT shapes already
 * implemented in services/easyfixer-verification.service.js to keep one
 * source of truth for the join chain (verification page + profile-update
 * page render the same data).
 */
async function fetchPrefill(efrId, pool) {
  // Header + basic editable fields. Join tbl_user so the FE can render the
  // canonical full name + display email/pincode the technician sees in the
  // mobile app, even if the per-easyfixer fields drift.
  const [[row]] = await pool.query(
    `SELECT e.efr_id,
            e.efr_no,
            e.efr_email,
            e.efr_first_name,
            e.efr_last_name,
            e.efr_name,
            e.efr_alt_no,
            e.efr_pin_no           AS pincode,
            e.date_of_birth,
            e.efr_marital_status,
            e.efr_children,
            e.about_yourself,
            e.about_yourself2,
            e.insert_date          AS joining_date,
            e.efr_service_category AS service_category_raw,
            e.efr_profile_img      AS profile_image_key,
            c.city_name            AS current_city,
            COALESCE(u.user_name, e.efr_name) AS full_name
       FROM tbl_easyfixer e
       LEFT JOIN tbl_user u ON u.user_id = e.user_id
       LEFT JOIN tbl_city c ON c.city_id = e.efr_cityId
      WHERE e.efr_id = ?
      LIMIT 1`,
    [efrId],
  );
  if (!row) {
    const err = new Error('easyfixer not found');
    err.status = 404;
    throw err;
  }

  // Concurrency: deep-skill mappings + serviceable pincodes + the deep-skill
  // catalog tree are mutually independent — fire them in parallel. The
  // profile-image presign is bundled into the same Promise.all so the
  // header strip's photo URL doesn't add a serial round-trip.
  // `deep_skill_catalog` powers the editable picker on the public form;
  // typical node count is 100–500, so it's safe to bundle inline.
  const [deepSkillMappings, serviceablePincodes, fullDeepSkillCatalog, profileImageUrl, serviceCategories, mappedCategoryIds] = await Promise.all([
    verification.listOptionMappings(efrId),
    verification.listServiceablePincodes(efrId),
    fetchDeepSkillCatalog(pool),
    presignProfileImage(row.profile_image_key),
    resolveServiceCategories(row.service_category_raw, pool),
    fetchEasyfixerMappedCategoryIds(efrId, pool),
  ]);

  /*
   * Per-easyfixer category filter (2026-06-11). The deep-skill picker's
   * Service Category list must only surface categories this technician is
   * mapped to via `easyfixer_service_type` (legacy table, NO `tbl_` prefix
   * — verified against EasyFix_CRM/EasyfixerServiceType.java). The cached
   * `fullDeepSkillCatalog` covers every active category in the system, so
   * we filter it in JS against a tiny per-efr_id ID set.
   *
   * Cache decision: option (c) — keep the shared global catalog cache
   * (5-min TTL, 1 query batch shared across all easyfixers) and intersect
   * with a per-call ~1ms query of `easyfixer_service_type`. Avoids cache
   * fragmentation per efr_id (~30k easyfixers) AND avoids bypassing the
   * cache entirely on the public hot path.
   *
   * Empty-list semantics: if the easyfixer has zero mapped categories
   * (brand-new, admin missed the setup step), the picker shows nothing —
   * that's the correct UX signal per spec.
   */
  const deepSkillCatalog = mappedCategoryIds.size === 0
    ? []
    : fullDeepSkillCatalog.filter((c) => mappedCategoryIds.has(c.category_id));

  return {
    header: {
      efr_id:    row.efr_id,
      full_name: row.full_name || '',
      efr_no:    row.efr_no || '',
      efr_email: row.efr_email || '',
      // View-only context fields surfaced in the public form's header
      // strip so the technician can confirm they opened the right link.
      // All nullable — the FE hides any missing field gracefully.
      joining_date:       row.joining_date || null,
      // 2026-06-11: header strip now renders categories as bullet list
      // when length > 1; inline string when length === 1; hidden when
      // length === 0. Source column is a CSV of IDs / names; the
      // `resolveServiceCategories` helper normalises both shapes.
      service_categories: serviceCategories,
      current_city:       row.current_city || null,
      pincode:            row.pincode || null,
      profile_image_url:  profileImageUrl,
    },
    basic: {
      first_name:     row.efr_first_name || '',
      last_name:      row.efr_last_name || '',
      email:          row.efr_email || '',
      alt_no:         row.efr_alt_no || '',
      date_of_birth:  row.date_of_birth,
      marital_status: row.efr_marital_status || '',
      children_count: row.efr_children == null ? null : Number(row.efr_children),
      // about_yourself = legacy "about" free-text; about_yourself2 = hobbies
      // (see services/easyfixer-verification.service.js where the same
      // column doubles as the hobbies surface).
      about_yourself: row.about_yourself || '',
      hobbies:        row.about_yourself2 || '',
    },
    deep_skill_mappings: deepSkillMappings,
    /*
     * Unwrap `.items` (2026-06-11). `verification.listServiceablePincodes`
     * returns the legacy `{ items: [...] }` envelope used by the CRM
     * verification page; the public FE expects a plain array per its
     * `PincodeMapping[]` type. Without unwrapping, `for (const p of
     * pincodes)` throws "object is not iterable" on every load.
     */
    serviceable_pincodes: Array.isArray(serviceablePincodes)
      ? serviceablePincodes
      : (serviceablePincodes?.items ?? []),
    deep_skill_catalog: deepSkillCatalog,
  };
}

/**
 * Build the full active deep-skill catalog tree:
 *
 *   [
 *     {
 *       category_id, category_name,
 *       service_types: [
 *         {
 *           service_type_id, service_type_name,
 *           deep_skills: [
 *             {
 *               deep_skill_id, deep_skill_name,
 *               options: [ { option_id, option_name } ]
 *             }
 *           ]
 *         }
 *       ]
 *     }
 *   ]
 *
 * Field names match the FE's CatalogCategory/CatalogServiceType/CatalogDeepSkill/
 * CatalogSkillOption types (see profile-update/[token]/page.tsx).
 *
 * Only ACTIVE rows are surfaced:
 *   - tbl_service_catg.service_catg_status   = 1
 *   - tbl_service_type.service_type_status   = 1
 *   - tbl_deep_skill.status                  = 1
 *   - tbl_deepskill_options.status           = 1
 *
 * Note: tbl_deep_skill itself uses its own normal column names
 * (`category_id`, `service_type_id`) — the inversion documented in
 * services/deep-skill.service.js applies only to tbl_efr_deepskill_mapping,
 * which is read elsewhere (verification.listOptionMappings).
 *
 * One query per level + JS nesting — keeps SQL simple, total result set is
 * small (typically a few hundred option rows), and shape mirrors how the
 * verification page assembles it. Empty branches (a service-type with no
 * active deep skills, etc.) are pruned so the FE picker doesn't render dead
 * twigs.
 */
/*
 * In-memory TTL cache (2026-06-11). The deep-skill catalog is a tree of
 * ~100–500 nodes that ops mutates a few times a month at most. Every
 * prefill load fires 4 SELECTs to assemble it, which is wasted work on
 * the public hot path of the magic-link flow.
 *
 * 5-minute TTL keeps it cheap while bounding staleness — if an operator
 * adds a new deep-skill option, technicians opening their form within
 * 5 minutes may not see it, but the next-load reflects it.
 *
 * Module-scoped, single-process. Safe because:
 *   1. The cache is read-only data (no per-user filtering).
 *   2. Single-flight is enforced via an in-flight promise field, so
 *      concurrent first requests share one query batch instead of
 *      racing 4 queries each.
 *   3. Process restart drops the cache cleanly — operator never sees
 *      stale data after a deploy.
 *
 * Tests / CLI that want a fresh build can call `invalidateCatalogCaches()`
 * (exported) — also handy for the planned mutation hook to clear on edits.
 */
const DEEP_SKILL_CATALOG_TTL_MS = 5 * 60 * 1000; // 5 minutes
let deepSkillCatalogCache = { data: null, expires: 0, inflight: null };

/*
 * Standalone invalidator for the service-categories resolution cache
 * (2026-06-11). Available as an export for surgical use — but the
 * common path is the bundled `invalidateCatalogCaches()` below
 * which calls this internally. See its docblock for rationale.
 */
function invalidateServiceCategoriesCache() {
  serviceCategoriesCache.clear();
}

/*
 * Invalidate ALL catalog-derived caches (2026-06-11).
 *
 * Single global hook called from every deep-skill catalog mutation
 * path (routes/admin/deep-skills.js, routes/admin/service-categories.js,
 * routes/admin/service-types.js — 13 callsites total). Clears both
 * `deepSkillCatalogCache` and `serviceCategoriesCache` so any cache
 * derived from `tbl_deep_skill` / `tbl_service_catg` / `tbl_service_type`
 * stays coherent without forcing each route to import multiple
 * invalidators.
 *
 * Design contract: callers signal "the catalog tree changed"; this
 * module owns the decision of which caches to flush. Both caches
 * live in THIS file, so co-located invalidation stays correct as we
 * add more cached views without leaking cache details to the route
 * layer.
 *
 * For surgical control (clear ONLY the service-categories cache and
 * leave the deep-skill tree warm — useful when a tbl_service_catg
 * rename happens without a deep-skill change), use
 * `invalidateServiceCategoriesCache()` directly.
 *
 * 2026-06-11 rename: previously named `invalidateDeepSkillCatalog`.
 * Renamed to match its actual behaviour (clears more than the deep-
 * skill tree). All 13 callsites updated in lockstep.
 */
function invalidateCatalogCaches() {
  deepSkillCatalogCache = { data: null, expires: 0, inflight: null };
  invalidateServiceCategoriesCache();
}

/**
 * Return the set of category-id values this easyfixer is mapped to,
 * unioning THREE source tables to mirror the legacy CRM Java query
 * (shared by the user 2026-06-11).
 *
 * Why three tables: a single easyfixer can be associated with a service
 * category through any of these legacy surfaces, and the deep-skill
 * picker on the public profile-update form must surface a category if
 * ANY of them claims it. Limiting to `easyfixer_service_type` (as the
 * prior version did) missed technicians whose category mapping lives
 * exclusively on the verification-state surface.
 *
 *   easyfixer_service_type       — legacy CRM "service type" mapping; the
 *                                  category id lives in `service_category_id`,
 *                                  has a soft-delete flag `is_deleted`.
 *                                  Verified: EasyFix_CRM EasyfixerDaoImpl.java
 *                                  (e.g. INSERT INTO easyfixer_service_type
 *                                  ... service_category_id ...) and
 *                                  EasyfixerServiceType.java entity.
 *   tbl_efr_deepskill_mapping    — option-level deep-skill assignments; one
 *                                  row per (efr × option). Category id is
 *                                  the column literally named `category_id`
 *                                  (NOT the inverted parent_skill_id /
 *                                  deep_skill_id columns — those carry
 *                                  deep_skill / option ids respectively;
 *                                  see top-of-file docblock in
 *                                  deep-skill.service.js). Verified:
 *                                  EasyFix_CRM DeepSkillDaoImpl.java
 *                                  (INSERT INTO tbl_efr_deepskill_mapping
 *                                  ... category_id ...). No `is_deleted`
 *                                  on this table — rows are hard-deleted
 *                                  on unassignment.
 *   efr_dskill_status            — verification-state per (tech × category);
 *                                  category column is `category_id`, owner
 *                                  is `easyfixer_id` (per the user's legacy
 *                                  Java query shared 2026-06-11). Not
 *                                  referenced elsewhere in this backend, so
 *                                  schema is taken on faith from the legacy
 *                                  query; defensive `category_id IS NOT NULL`
 *                                  filter keeps the union safe.
 *
 * Soft-delete filter is applied ONLY on `easyfixer_service_type`. The other
 * two tables don't carry an `is_deleted` column (verified by greps against
 * EasyFix_CRM DAOs), so adding the predicate would fail at runtime.
 *
 * Used to filter the (globally cached) deep-skill catalog tree to only the
 * categories this easyfixer is mapped to.
 */
async function fetchEasyfixerMappedCategoryIds(efrId, pool) {
  const [rows] = await pool.query(
    `SELECT DISTINCT category_id FROM (
       SELECT service_category_id AS category_id
         FROM easyfixer_service_type
        WHERE easyfixer_id = ?
          AND (is_deleted IS NULL OR is_deleted = 0)
          AND service_category_id IS NOT NULL
       UNION
       SELECT category_id
         FROM tbl_efr_deepskill_mapping
        WHERE easyfixer_id = ?
          AND category_id IS NOT NULL
       UNION
       SELECT category_id
         FROM efr_dskill_status
        WHERE easyfixer_id = ?
          AND category_id IS NOT NULL
     ) AS unioned`,
    [efrId, efrId, efrId],
  );
  return new Set(rows.map((r) => Number(r.category_id)).filter((n) => Number.isFinite(n)));
}

async function fetchDeepSkillCatalog(pool) {
  const now = Date.now();
  if (deepSkillCatalogCache.data && now < deepSkillCatalogCache.expires) {
    return deepSkillCatalogCache.data;
  }
  // Single-flight: concurrent first requests share one in-flight build.
  if (deepSkillCatalogCache.inflight) {
    return deepSkillCatalogCache.inflight;
  }
  const promise = buildDeepSkillCatalog(pool);
  deepSkillCatalogCache = { data: null, expires: 0, inflight: promise };
  try {
    const tree = await promise;
    // Commit only if this build is still current — invalidateCatalogCaches()
    // (or a competing build) may have replaced the cache object while we
    // were in flight; a pre-mutation tree must not overwrite that.
    if (deepSkillCatalogCache.inflight === promise) {
      deepSkillCatalogCache = {
        data: tree,
        expires: Date.now() + DEEP_SKILL_CATALOG_TTL_MS,
        inflight: null,
      };
    }
    return tree;
  } catch (e) {
    // Don't poison the cache on failure — next call retries fresh.
    // Same guard: don't clobber a newer build's inflight handle.
    if (deepSkillCatalogCache.inflight === promise) {
      deepSkillCatalogCache = { data: null, expires: 0, inflight: null };
    }
    throw e;
  }
}

async function buildDeepSkillCatalog(pool) {
  const [categories] = await pool.query(
    `SELECT service_catg_id   AS category_id,
            service_catg_name AS category_name
       FROM tbl_service_catg
      WHERE service_catg_status = 1
      ORDER BY service_catg_name ASC`,
  );
  const [serviceTypes] = await pool.query(
    `SELECT service_type_id,
            service_catg_id   AS category_id,
            service_type_name
       FROM tbl_service_type
      WHERE service_type_status = 1
      ORDER BY service_type_name ASC`,
  );
  const [deepSkills] = await pool.query(
    `SELECT deepskill_id      AS deep_skill_id,
            category_id,
            service_type_id,
            deepskill_name    AS deep_skill_name,
            deepskill_image   AS deep_skill_image
       FROM tbl_deep_skill
      WHERE status = 1
      ORDER BY deepskill_name ASC`,
  );
  // Resolve every non-empty S3 key to a presigned URL in parallel. The
  // 5-min catalog cache means this fan-out only fires once per cache
  // refresh — well within the 1-hour presigned-URL TTL.
  const deepSkillImageUrls = await Promise.all(
    deepSkills.map((s) => deepSkillService.resolveImageUrlFromKey(s.deep_skill_image)),
  );
  const imageUrlBySkillId = new Map();
  for (let i = 0; i < deepSkills.length; i += 1) {
    imageUrlBySkillId.set(deepSkills[i].deep_skill_id, deepSkillImageUrls[i]);
  }
  const [options] = await pool.query(
    `SELECT id                AS option_id,
            deepskill_id      AS deep_skill_id,
            skill_option      AS option_name
       FROM tbl_deepskill_options
      WHERE status = 1
      ORDER BY skill_option ASC`,
  );

  // Index options by deep_skill_id.
  const optionsBySkill = new Map();
  for (const o of options) {
    const arr = optionsBySkill.get(o.deep_skill_id) || [];
    arr.push({ option_id: o.option_id, option_name: o.option_name });
    optionsBySkill.set(o.deep_skill_id, arr);
  }
  // Group deep skills by (category_id, service_type_id), keep only those
  // that actually have options.
  const skillsByType = new Map();
  for (const s of deepSkills) {
    const opts = optionsBySkill.get(s.deep_skill_id) || [];
    if (opts.length === 0) continue;
    const key = `${s.category_id}|${s.service_type_id}`;
    const arr = skillsByType.get(key) || [];
    arr.push({
      deep_skill_id: s.deep_skill_id,
      deep_skill_name: s.deep_skill_name,
      deep_skill_image_url: imageUrlBySkillId.get(s.deep_skill_id) || null,
      options: opts,
    });
    skillsByType.set(key, arr);
  }
  // Group service types by category_id, keep only types that have skills.
  const typesByCategory = new Map();
  for (const t of serviceTypes) {
    const skills = skillsByType.get(`${t.category_id}|${t.service_type_id}`) || [];
    if (skills.length === 0) continue;
    const arr = typesByCategory.get(t.category_id) || [];
    arr.push({
      service_type_id: t.service_type_id,
      service_type_name: t.service_type_name,
      deep_skills: skills,
    });
    typesByCategory.set(t.category_id, arr);
  }
  // Final nest — only categories that contribute at least one service type.
  const tree = [];
  for (const c of categories) {
    const types = typesByCategory.get(c.category_id) || [];
    if (types.length === 0) continue;
    tree.push({
      category_id: c.category_id,
      category_name: c.category_name,
      service_types: types,
    });
  }
  return tree;
}

/**
 * Search the active pincode catalog. Used by the public profile-update form
 * to lazily lookup pincodes without bundling the full ~155k-row table.
 *
 * Search modes:
 *   - empty `q`      → top `limit` recent pincodes (pincode_id DESC)
 *   - numeric `q`    → prefix match on pincode (`pincode LIKE 'q%'`)
 *   - non-numeric q  → fuzzy match on pincode / location / city_name
 *
 * Only `pincode_status = 1` rows are returned. Parameterised throughout.
 * Result shape matches CatalogPincode in the FE.
 */
async function searchPincodes(q, limit, pool) {
  const cap = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const term = (q == null ? '' : String(q)).trim();
  const SELECT = `
    SELECT p.pincode_id,
           p.pincode,
           p.location,
           c.city_name,
           s.state_name
      FROM tbl_pincode p
      LEFT JOIN tbl_city  c ON c.city_id  = p.city_id
      LEFT JOIN tbl_state s ON s.state_id = c.state_id
  `;
  let rows;
  if (!term) {
    [rows] = await pool.query(
      `${SELECT}
       WHERE p.pincode_status = 1
       ORDER BY p.pincode_id DESC
       LIMIT ?`,
      [cap],
    );
  } else if (/^\d{1,6}$/.test(term)) {
    [rows] = await pool.query(
      `${SELECT}
       WHERE p.pincode_status = 1
         AND p.pincode LIKE ?
       ORDER BY p.pincode ASC
       LIMIT ?`,
      [`${term}%`, cap],
    );
  } else {
    /*
     * Prefix match instead of mid-string fuzzy (2026-06-11). Per the
     * user's UX/perf review: "%foo%" is unusable against BTREE indexes
     * (leading wildcard kills index seek), forcing a full scan of
     * ~155k rows on every keystroke. "foo%" lets MySQL hit the new
     * `idx_pincode_location` + `idx_city_name` indexes, and matches
     * the typical typing pattern (operators start with the first
     * letter of the city / location name).
     *
     * The pincode column also uses prefix — but the numeric-prefix
     * branch above already handles that path, so this fallback is for
     * pure text queries. We still OR across three text columns so a
     * partial city ("Mum") or location ("Andh") both work.
     */
    const prefix = `${term}%`;
    [rows] = await pool.query(
      `${SELECT}
       WHERE p.pincode_status = 1
         AND (p.location LIKE ? OR c.city_name LIKE ?)
       ORDER BY p.pincode ASC
       LIMIT ?`,
      [prefix, prefix, cap],
    );
  }
  return rows.map((r) => ({
    pincode_id: Number(r.pincode_id),
    pincode: String(r.pincode),
    location: r.location || null,
    city_name: r.city_name || null,
    state_name: r.state_name || null,
  }));
}

// ─── 2. sendForEasyfixer ────────────────────────────────────────────
/**
 * Fire the WhatsApp profile-update link + audit the attempt on tbl_easyfixer.
 *
 * Unlike the customer job-magic-link flow, this surface has NO per-row
 * send cap and NO per-client opt-in gate — operators are explicitly
 * trusted (the `isProfileUpdateLinkSend` action permission is the gate)
 * and the message is non-destructive (just a self-serve update link).
 *
 * Action coercion: if the caller passes 'first' but a link was already
 * sent (profile_update_sent_at IS NOT NULL), we coerce to 'resend' so
 * audit telemetry stays self-consistent — same pattern as
 * services/job-magic-link.service.js::sendForJob.
 *
 * Returns the shape the spec mandates:
 *   { jobId, action, shortUrl, sentAt, sendCount }
 * Note `jobId` is named for spec parity — it carries the efr_id value.
 */
async function sendForEasyfixer(efrId, { action = 'first', override_mobile } = {}, actor, pool) {
  const [[row]] = await pool.query(
    `SELECT efr_id, efr_no, efr_name, efr_first_name, efr_last_name,
            profile_update_sent_at, profile_update_send_count
       FROM tbl_easyfixer
      WHERE efr_id = ?
      LIMIT 1`,
    [efrId],
  );
  if (!row) {
    const err = new Error('easyfixer not found');
    err.status = 404;
    throw err;
  }
  if (!row.efr_no) {
    const err = new Error('easyfixer has no mobile on file — cannot send WhatsApp link');
    err.status = 422;
    throw err;
  }

  /*
   * Destination resolution (2026-06-10): in non-prod we honour an
   * operator-supplied `override_mobile` so QA / staging testers can ping
   * their own number without touching the real technician. The route-layer
   * Joi schema already enforced that:
   *   1. `override_mobile` is null/absent in production (custom
   *      `production-block` rule), and
   *   2. when present, it matches the 10-15 digit pattern.
   * This service stays defensive: in production we ignore the field
   * regardless, so a misconfigured upstream can never bypass the gate.
   * The audit / WhatsApp send + tbl_easyfixer increment all run against
   * the destination actually messaged.
   */
  const isProd = process.env.NODE_ENV === 'production';
  const destinationMobile =
    !isProd && override_mobile ? String(override_mobile) : row.efr_no;
  if (!isProd && override_mobile) {
    logger.info(
      { efrId, override: destinationMobile },
      'profile-update-link: sent with override mobile (non-prod)',
    );
  }

  // Build a friendly recipient name. Prefer first + last; fall back to
  // efr_name (legacy single-name column) so a sparse row still gets a
  // sensible WhatsApp recipient label.
  const fullName = [row.efr_first_name, row.efr_last_name]
    .filter(Boolean).join(' ').trim() || row.efr_name || 'there';

  let effectiveAction = action || 'first';
  if (effectiveAction === 'first' && row.profile_update_sent_at != null) {
    effectiveAction = 'resend';
  }

  // Mint a token + long URL. JWT TTL is 30d (see signEasyfixerProfileToken).
  const token   = signEasyfixerProfileToken(efrId);
  const longUrl = profileUpdateUrl(token);

  // Shorten the long URL for WhatsApp — same `purpose` tagging convention
  // as the job-magic-link shortener (so audit queries can bucket links by
  // flow). Soft fallback: if shortening fails we keep the long URL and
  // proceed; the easyfixer MUST receive a working link.
  let shortUrl = longUrl;
  try {
    // 30-day expiry to match the JWT lifetime — an expired short URL
    // returns the friendly /book/<code> 410 page rather than dumping the
    // technician into a JWT-expired landing page.
    const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000);
    const { short_url } = await urlShortener.shortenUrl(
      longUrl,
      {
        purpose:   'easyfixer_profile_update',
        expiresAt,
        createdBy: actor?.user_id || null,
      },
      pool,
    );
    shortUrl = short_url;
  } catch (err) {
    logger.warn(
      { efrId, err: err && err.message },
      'easyfixer-profile-update: URL shortening failed — falling back to long JWT URL',
    );
  }

  // Send via Gallabox. Try the pre-approved template first; on any error
  // OR on a non-delivered response, fall back to a free-form session text
  // so QA / a deploy with the template unprovisioned still gets the link
  // in front of the easyfixer.
  let response;
  try {
    response = await whatsappService.sendTemplate({
      to: destinationMobile,
      recipientName: fullName,
      templateName: 'tx_complete_profile',
      // Gallabox `tx_complete_profile` uses NAMED body variables
      // ({{Name}}, {{efr_id}}, {{profile_link}}) — positional keys (1/2/3)
      // don't bind and arrive empty. Keys must match the template var names.
      bodyValues: {
        Name:         fullName,
        efr_id:       String(efrId),
        profile_link: shortUrl,
      },
    });
  } catch (err) {
    logger.warn(
      { efrId, err: err && err.message },
      'easyfixer-profile-update: template send threw — falling back to free-form text',
    );
    response = { delivered: false, error: err && err.message };
  }

  // Fallback path. The free-form sendText only delivers inside a 24h
  // customer-service window (see services/gallabox.whatsapp.service.js
  // sendWhatsappMessage docblock) so in a cold-start case this may also
  // fail — but it's the best we can do without a provisioned template.
  // We still audit the send attempt so ops can see it tried.
  if (!response.delivered && !response.disabled) {
    try {
      const fallback = await whatsappService.sendText({
        to: destinationMobile,
        recipientName: fullName,
        body:
          `Hi ${fullName}, please update your EasyFix profile using this link: ${shortUrl} `
          + `(valid for 30 days). – Team EasyFix`,
      });
      if (fallback.delivered) {
        response = fallback;
        logger.info({ efrId }, 'easyfixer-profile-update: fell back to free-form sendText');
      }
    } catch (err) {
      logger.warn(
        { efrId, err: err && err.message },
        'easyfixer-profile-update: free-form fallback send also failed',
      );
    }
  }

  // Audit the attempt on tbl_easyfixer regardless of delivery — operators
  // need to see the send INTENT in the row's history. Mirrors the
  // job-magic-link audit semantics (the cap there is enforced atomically
  // around the increment; we have no cap so the simpler order is fine).
  const sentAt = new Date();
  await pool.query(
    `UPDATE tbl_easyfixer
        SET profile_update_sent_at      = ?,
            profile_update_send_count   = profile_update_send_count + 1,
            profile_update_last_action  = ?
      WHERE efr_id = ?`,
    [sentAt, effectiveAction, efrId],
  );

  logger.info(
    {
      efrId,
      action: effectiveAction,
      delivered: !!response.delivered,
      disabled: !!response.disabled,
      sendCount: (Number(row.profile_update_send_count) || 0) + 1,
    },
    'easyfixer-profile-update: send attempted',
  );

  return {
    // `jobId` field name kept for cross-flow parity with job-magic-link's
    // send response shape (and called out in the spec). It carries the
    // efr_id value here.
    jobId:     efrId,
    action:    effectiveAction,
    shortUrl,
    sentAt:    sentAt.toISOString(),
    sendCount: (Number(row.profile_update_send_count) || 0) + 1,
    delivered: !!response.delivered,
    disabled:  !!response.disabled,
    // `to` — the mobile we actually messaged. In prod this always equals
    // the technician's `efr_no`; in non-prod it can be the operator's
    // override. Returned so the FE can render an unambiguous
    // "Sent to <number>" toast.
    to:        destinationMobile,
  };
}

// ─── 3. acceptSubmission ────────────────────────────────────────────
/**
 * Commit the easyfixer's submitted profile updates.
 *
 * Transactional because the write touches up to three tables /
 * sub-resources:
 *   tbl_easyfixer                  — basic editable columns
 *   tbl_efr_deepskill_mapping      — deep-skill option set (via
 *                                    verification.replaceOptionMappings)
 *   tbl_efr_serviceable_pincodes   — pincode set (via
 *                                    verification.replaceServiceablePincodes)
 *
 * If any step fails, ALL must roll back; a half-applied profile update
 * would leave the easyfixer's data in an inconsistent state.
 *
 * Reuse strategy: the deep-skill + pincode replace helpers in
 * services/easyfixer-verification.service.js already implement the exact
 * soft-delete-then-insert pattern we need. They now accept an optional
 * injected connection, so we run the easyfixer-row UPDATE and both
 * sub-resource replacements on ONE connection inside a single
 * transaction — all three writes commit or roll back together, closing
 * the previous partial-apply window where a failed sub-resource step
 * left a durable basic-field update behind.
 *
 * Payload shape (Joi-validated by routes/public/easyfixer-profile-update.js):
 *   {
 *     basic?: { first_name, last_name, email, alt_no, date_of_birth,
 *               marital_status, children_count, hobbies, about_yourself, ... },
 *     deep_skill_items?: Array<{ category_id, service_type_id,
 *                                deep_skill_id, option_id }>,
 *     serviceable_pincode_ids?: number[],
 *   }
 *
 * Returns the prefill payload reflecting the saved state so the FE can
 * paint a "Saved at X" confirmation without a second round-trip.
 */
async function acceptSubmission(efrId, payload, pool) {
  // Map payload field names → tbl_easyfixer column names. Only columns in
  // EDITABLE_BASIC_COLUMNS are written — anything else is silently dropped
  // (column-allowlist defence; see EDITABLE_BASIC_COLUMNS docblock).
  const PAYLOAD_TO_COLUMN = Object.freeze({
    first_name:     'efr_first_name',
    last_name:      'efr_last_name',
    email:          'efr_email',
    alt_no:         'efr_alt_no',
    date_of_birth:  'date_of_birth',
    marital_status: 'efr_marital_status',
    children_count: 'efr_children',
    about_yourself: 'about_yourself',
    hobbies:        'about_yourself2',
  });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // 1. Verify the easyfixer exists inside the transaction so we can
    //    surface a clean 404 before any write happens.
    const [[exists]] = await conn.query(
      'SELECT efr_id FROM tbl_easyfixer WHERE efr_id = ? LIMIT 1',
      [efrId],
    );
    if (!exists) {
      throw Object.assign(new Error('easyfixer not found'), { status: 404 });
    }

    // 2. Basic field UPDATE — build SET clause from the payload's `basic`
    //    sub-object, allowlisted via PAYLOAD_TO_COLUMN.
    const basic = (payload && payload.basic) || {};
    const sets = [];
    const params = [];
    for (const [payloadKey, column] of Object.entries(PAYLOAD_TO_COLUMN)) {
      if (basic[payloadKey] === undefined) continue;
      if (!EDITABLE_BASIC_COLUMNS.includes(column)) continue; // defence in depth
      sets.push(`${column} = ?`);
      params.push(basic[payloadKey] === '' ? null : basic[payloadKey]);
    }
    if (sets.length) {
      sets.push('update_date = NOW()');
      params.push(efrId);
      await conn.query(
        `UPDATE tbl_easyfixer SET ${sets.join(', ')} WHERE efr_id = ?`,
        params,
      );
    }

    // 3. Sub-resource replacements — run on the SAME connection inside this
    //    transaction so all three writes are atomic. The verification helpers
    //    enroll in our txn when handed a connection (no own begin/commit).
    if (Array.isArray(payload?.deep_skill_items)) {
      await verification.replaceOptionMappings(efrId, payload.deep_skill_items, null, conn);
    }
    if (Array.isArray(payload?.serviceable_pincode_ids)) {
      await verification.replaceServiceablePincodes(efrId, payload.serviceable_pincode_ids, null, conn);
    }

    await conn.commit();
  } catch (e) {
    try { await conn.rollback(); } catch (_e) { /* swallow */ }
    throw e;
  } finally {
    conn.release();
  }

  // 4. Return the current state so the FE can render "Saved at X" without
  //    another round-trip. fetchPrefill is the natural reflector here.
  const snapshot = await fetchPrefill(efrId, pool);
  return {
    saved_at: new Date().toISOString(),
    ...snapshot,
  };
}

module.exports = {
  fetchPrefill,
  sendForEasyfixer,
  acceptSubmission,
  searchPincodes,
  invalidateCatalogCaches,
  invalidateServiceCategoriesCache,
};
