const ExcelJS = require('exceljs');
const { pool } = require('../db');
const logger   = require('../logger');
const s3Storage = require('../utils/s3-storage');

/*
 * Deep-skill catalogue management.
 *
 * Schema (existing, legacy):
 *   tbl_deep_skill          — the leaf rows ("Window AC", "Office Chair")
 *   tbl_deepskill_options   — options per skill ("Installation", "Repair", …)
 *
 * One weirdness to preserve: `tbl_deep_skill.skill_options` is a denormalised
 * JSON string that mirrors the normalised rows in tbl_deepskill_options. Legacy
 * code reads from both depending on the caller. We keep them in sync on every
 * option write via syncSkillOptionsJson().
 *
 * Other deep-skill tables we DO NOT touch here:
 *   tbl_efr_deepskill_mapping — tech assignments, managed via the profile flow
 *   efr_dskill_status         — verification state per (tech, category)
 *   tx_category_skill_status  — empty bigint-keyed shadow (newer schema, not in use)
 *   tbl_skill_master          — legacy L1/L2 skill tiers, unrelated
 *
 * ─── tbl_efr_deepskill_mapping COLUMN-NAME INVERSION (2026-06-10) ───
 *
 * CRITICAL — read before touching any query that references this table.
 *
 * The legacy schema has a long-standing naming drift where the two id
 * columns store the OPPOSITE of what their names suggest:
 *
 *   physical column      ACTUALLY holds                  semantic name
 *   ─────────────────    ─────────────────────────────   ─────────────────
 *   m.parent_skill_id    tbl_deep_skill.deep_skill_id    deep_skill_id
 *   m.deep_skill_id      tbl_deepskill_options.id        option_id
 *
 * In other words: the column NAMED `deep_skill_id` actually carries
 * the OPTION id, and the column NAMED `parent_skill_id` carries the
 * actual deep_skill_id. This was verified against the legacy Java
 * `@Entity` for tbl_efr_deepskill_mapping in API_AngularClientDashboard.
 *
 * Implication: each row in this table represents ONE (easyfixer × option)
 * mapping. An easyfixer with 3 options under "Electrical" has 3 rows,
 * all sharing the same parent_skill_id (Electrical) but with distinct
 * deep_skill_id values (one per option).
 *
 * Schema can't be renamed (legacy CRM Java + 5 other services read these
 * columns by their physical names). Convention going forward:
 *
 *   - EVERY new query that touches tbl_efr_deepskill_mapping projects
 *     the columns through SELECT aliases with the semantically-correct
 *     names: `m.parent_skill_id AS deep_skill_id, m.deep_skill_id AS
 *     option_id`. Downstream code reads the readable names.
 *   - WHERE / JOIN clauses still use the physical names (m.parent_skill_id,
 *     m.deep_skill_id) because aliases aren't allowed there in MySQL.
 *   - Comments next to non-aliased usage explicitly mark "the field
 *     named deep_skill_id actually holds option_id" to defuse the trap.
 */

// ─── Case-insensitive resolvers (2026-06-10) ────────────────────────
/*
 * Lookup category/type/option by name (case- and whitespace-insensitive)
 * before falling through to an INSERT. Prevents duplicate-by-casing
 * rows like "Plumbing" / "plumbing" / "PLUMBING" that the previous
 * always-create path produced.
 *
 * Returns `{ id, name, isNew }`. `isNew === false` means we reused an
 * existing row; logged at info-level so ops can audit cleanup work.
 * `runner` is either `pool` or a transaction connection — keeps these
 * helpers reusable from both single-Add and bulk-upload paths.
 */
async function resolveCategoryByName(runner, name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw Object.assign(new Error('category name required'), { status: 400 });
  const [[row]] = await runner.query(
    `SELECT service_catg_id, service_catg_name
       FROM tbl_service_catg
      WHERE LOWER(TRIM(service_catg_name)) = LOWER(TRIM(?))
        AND service_catg_status <> 3
      LIMIT 1`,
    [trimmed],
  );
  if (row) {
    logger.info(
      `deep-skill: matched existing service_catg_id=${row.service_catg_id} for name="${trimmed}" (case-insensitive)`,
    );
    return { id: row.service_catg_id, name: row.service_catg_name, isNew: false };
  }
  const [ins] = await runner.query(
    `INSERT INTO tbl_service_catg (service_catg_name, service_catg_status) VALUES (?, 1)`,
    [trimmed],
  );
  return { id: ins.insertId, name: trimmed, isNew: true };
}

/*
 * Existing-only category lookup (2026-06-15). Like resolveCategoryByName
 * but NEVER inserts — returns `{ id, name }` on a case/whitespace-
 * insensitive match (status <> 3), or `null` when no canonical row
 * exists. Used by the single-add create() path, which rejects unknown
 * categories with a 400 instead of silently creating one.
 */
async function resolveExistingCategoryByName(runner, name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw Object.assign(new Error('category name required'), { status: 400 });
  const [[row]] = await runner.query(
    `SELECT service_catg_id, service_catg_name
       FROM tbl_service_catg
      WHERE LOWER(TRIM(service_catg_name)) = LOWER(TRIM(?))
        AND service_catg_status <> 3
      LIMIT 1`,
    [trimmed],
  );
  if (!row) return null;
  return { id: row.service_catg_id, name: row.service_catg_name };
}

async function resolveServiceTypeByName(runner, categoryId, name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw Object.assign(new Error('service type name required'), { status: 400 });
  const [[row]] = await runner.query(
    `SELECT service_type_id, service_type_name
       FROM tbl_service_type
      WHERE LOWER(TRIM(service_type_name)) = LOWER(TRIM(?))
        AND service_catg_id = ?
        AND service_type_status <> 3
      LIMIT 1`,
    [trimmed, categoryId],
  );
  if (row) {
    logger.info(
      `deep-skill: matched existing service_type_id=${row.service_type_id} for name="${trimmed}" (case-insensitive, catg=${categoryId})`,
    );
    return { id: row.service_type_id, name: row.service_type_name, isNew: false };
  }
  // New service type auto-created for a deep skill → display = 2 (deep-skill
  // type) so future single-add deep skills surface in the Manage Deep Skills
  // "display = 2" Service Type dropdown.
  const [ins] = await runner.query(
    `INSERT INTO tbl_service_type
       (service_type_name, service_catg_id, display, service_type_status)
     VALUES (?, ?, 2, 1)`,
    [trimmed, categoryId],
  );
  return { id: ins.insertId, name: trimmed, isNew: true };
}

async function resolveSkillOptionByName(runner, deepskillId, name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw Object.assign(new Error('skill option name required'), { status: 400 });
  const [[row]] = await runner.query(
    `SELECT id, skill_option, status
       FROM tbl_deepskill_options
      WHERE deepskill_id = ?
        AND LOWER(TRIM(skill_option)) = LOWER(TRIM(?))
      LIMIT 1`,
    [deepskillId, trimmed],
  );
  if (row) {
    logger.info(
      `deep-skill: matched existing skill_option id=${row.id} for name="${trimmed}" (case-insensitive, skill=${deepskillId})`,
    );
    // Reactivate if it was soft-deleted.
    if (Number(row.status) === 0) {
      await runner.query(
        'UPDATE tbl_deepskill_options SET status = 1 WHERE id = ?',
        [row.id],
      );
    }
    return { id: row.id, name: row.skill_option, isNew: false };
  }
  const [ins] = await runner.query(
    'INSERT INTO tbl_deepskill_options (deepskill_id, skill_option, status) VALUES (?, ?, 1)',
    [deepskillId, trimmed],
  );
  return { id: ins.insertId, name: trimmed, isNew: true };
}

// ─── Deep-skill CRUD ────────────────────────────────────────────────
async function list({ categoryId, serviceTypeId, includeInactive = false } = {}) {
  const clauses = [];
  const params = [];
  if (!includeInactive) clauses.push('ds.status = 1');
  if (categoryId    != null) { clauses.push('ds.category_id = ?');     params.push(categoryId); }
  if (serviceTypeId != null) { clauses.push('ds.service_type_id = ?'); params.push(serviceTypeId); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const [rows] = await pool.query(`
    SELECT ds.deepskill_id, ds.category_id, ds.service_type_id,
           ds.deepskill_name, ds.deepskill_description, ds.deepskill_tag_words, ds.status,
           ds.deepskill_image, ds.inserted_on, ds.inserted_by,
           ds.image_gen_status, ds.image_gen_attempted_at,
           sc.service_catg_name AS category_name,
           st.service_type_name,
           (SELECT COUNT(*) FROM tbl_deepskill_options o
             WHERE o.deepskill_id = ds.deepskill_id AND o.status = 1) AS option_count,
           (SELECT GROUP_CONCAT(o.skill_option ORDER BY o.id SEPARATOR '||')
              FROM tbl_deepskill_options o
             WHERE o.deepskill_id = ds.deepskill_id AND o.status = 1) AS option_labels
      FROM tbl_deep_skill ds
      LEFT JOIN tbl_service_catg sc ON sc.service_catg_id = ds.category_id
      LEFT JOIN tbl_service_type st ON st.service_type_id = ds.service_type_id
      ${where}
      ORDER BY ds.deepskill_name ASC
  `, params);
  // Fan out presigner calls for non-empty image keys. Promise.all keeps
  // latency O(1) for the typical batch size (<=500 skills per category).
  const urls = await Promise.all(
    rows.map((r) => resolveImageUrlFromKey(r.deepskill_image)),
  );
  return rows.map((r, i) => ({ ...r, deep_skill_image_url: urls[i] }));
}

async function getById(deepskillId) {
  /*
   * Explicit projection (2026-06-12). Previously `SELECT ds.*` — that
   * was convenient when new columns were added (they flowed through to
   * the response automatically) but it's a small API-stability foot-
   * gun: any future schema addition silently leaks to consumers. The
   * list of columns below mirrors the `list()` query above PLUS
   * `deepskill_tag_words` (2026-06-06 addition) and `skill_options`
   * (legacy denormalised JSON column). Keep this in sync with list().
   */
  const [[row]] = await pool.query(`
    SELECT ds.deepskill_id, ds.category_id, ds.service_type_id,
           ds.deepskill_name, ds.deepskill_description, ds.deepskill_tag_words,
           ds.status, ds.deepskill_image, ds.skill_options,
           ds.inserted_on, ds.inserted_by,
           ds.image_gen_status, ds.image_gen_attempted_at,
           sc.service_catg_name AS category_name,
           st.service_type_name
      FROM tbl_deep_skill ds
      LEFT JOIN tbl_service_catg sc ON sc.service_catg_id = ds.category_id
      LEFT JOIN tbl_service_type st ON st.service_type_id = ds.service_type_id
     WHERE ds.deepskill_id = ? LIMIT 1
  `, [deepskillId]);
  if (!row) return null;
  const [options] = await pool.query(
    'SELECT id, skill_option, status FROM tbl_deepskill_options WHERE deepskill_id = ? ORDER BY id',
    [deepskillId]
  );
  return { ...row, options };
}

async function create(input, actor) {
  /*
   * Category must already EXIST (2026-06-15). Single-add no longer
   * auto-creates a category. The modal sends `category_id` straight from
   * the lookup dropdown (existing categories only), so the common path
   * just validates that the id resolves to a live (status <> 3) row. The
   * legacy name-based create-category fallback is intentionally REMOVED
   * here — passing a `category_name` that doesn't match an existing row is
   * a 400, not a silent create. (Bulk upload skips such rows; see
   * deep-skill-bulk.service.js.)
   *
   * Service type may still be resolved-or-created by name under the
   * existing category — that auto-create behaviour is unchanged.
   */
  let categoryId    = input.category_id;
  let serviceTypeId = input.service_type_id;
  if (!categoryId && input.category_name) {
    const cat = await resolveExistingCategoryByName(pool, input.category_name);
    if (!cat) {
      const e = new Error('Service category does not exist');
      e.status = 400;
      throw e;
    }
    categoryId = cat.id;
  }
  if (categoryId) {
    const [[catRow]] = await pool.query(
      `SELECT service_catg_id FROM tbl_service_catg
        WHERE service_catg_id = ? AND service_catg_status <> 3 LIMIT 1`,
      [categoryId],
    );
    if (!catRow) {
      const e = new Error('Service category does not exist');
      e.status = 400;
      throw e;
    }
  }
  if (!serviceTypeId && input.service_type_name && categoryId) {
    const typ = await resolveServiceTypeByName(pool, categoryId, input.service_type_name);
    serviceTypeId = typ.id;
  }

  /*
   * Duplicate-name UPSERT (2026-06-15). If a deep skill with the SAME
   * name already exists under the SAME natural key (category_id +
   * service_type_id + LOWER(TRIM(name))), this is treated as an edit:
   * route to update() instead of inserting a second row. update()
   * already handles description / tag_words / status / image plus the
   * auto-gen pipeline; options are synced below via the same per-option
   * resolver the add-after-create flow uses (case-insensitive reuse,
   * reactivates soft-deleted matches). Logged at info level so the
   * implicit update is auditable.
   */
  if (categoryId && serviceTypeId && input.deepskill_name) {
    const [[dupe]] = await pool.query(
      `SELECT deepskill_id FROM tbl_deep_skill
        WHERE category_id = ?
          AND service_type_id = ?
          AND LOWER(TRIM(deepskill_name)) = LOWER(TRIM(?))
        LIMIT 1`,
      [categoryId, serviceTypeId, input.deepskill_name],
    );
    if (dupe) {
      logger.info(
        { deepskillId: dupe.deepskill_id, categoryId, serviceTypeId },
        `deep-skill: duplicate name "${String(input.deepskill_name).trim()}" under same category+type — updating existing skill id=${dupe.deepskill_id} instead of inserting`,
      );
      return updateExistingDuplicate(dupe.deepskill_id, input);
    }
  }

  /*
   * Mandatory options (2026-06-11). Joi guarantees the array exists +
   * has at least one item, but we still de-duplicate by case-insensitive
   * trimmed name here so the operator can paste ["Foo", "foo", " Foo "]
   * and get one row, matching the legacy resolveSkillOptionByName
   * semantics used by the add-after-create flow.
   */
  const rawOptions = Array.isArray(input.options) ? input.options : [];
  const seen = new Set();
  const optionNames = [];
  for (const o of rawOptions) {
    const trimmed = String(o?.skill_option || '').trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    optionNames.push(trimmed);
  }
  if (optionNames.length === 0) {
    // Should never reach here (Joi enforces min(1)) but defend in depth.
    const e = new Error('At least one Deep Skill option is required');
    e.status = 400;
    throw e;
  }

  /*
   * Transactional create (CLAUDE.md §2.5: multi-step writes use
   * beginTransaction). If any option fails to insert we roll back the
   * deep-skill row too, so the catalog never has a half-built entry.
   * skill_options JSON denormalisation runs AFTER commit because the
   * sync helper uses the pool directly — keeping it out of the
   * transaction avoids hold-lock-during-second-pool-call deadlocks.
   */
  const conn = await pool.getConnection();
  let deepSkillId;
  try {
    await conn.beginTransaction();
    const [ins] = await conn.query(`
      INSERT INTO tbl_deep_skill
        (category_id, service_type_id, deepskill_name, deepskill_description,
         deepskill_tag_words,
         status, inserted_by, inserted_on, deepskill_image, skill_options)
      VALUES (?, ?, ?, ?, ?, 1, ?, NOW(), ?, '[]')
    `, [
      categoryId, serviceTypeId,
      input.deepskill_name, input.deepskill_description || null,
      // deepskill_tag_words (2026-06-06): per-skill technician-visit
      // tag(s), max ~2 short phrases per ops file Col B. Separate
      // semantic from the keyword search string in deepskill_description.
      input.deepskill_tag_words || null,
      actor?.user_id || null,
      input.deepskill_image || '',
    ]);
    deepSkillId = ins.insertId;

    // Bulk-insert the options on the same connection. One round-trip.
    const placeholders = optionNames.map(() => '(?, ?, 1)').join(', ');
    const params = [];
    for (const name of optionNames) {
      params.push(deepSkillId, name);
    }
    await conn.query(
      `INSERT INTO tbl_deepskill_options (deepskill_id, skill_option, status)
       VALUES ${placeholders}`,
      params,
    );

    await conn.commit();
  } catch (e) {
    try { await conn.rollback(); } catch (_) { /* swallow rollback failure */ }
    throw e;
  } finally {
    conn.release();
  }

  // Sync the legacy denormalised JSON blob on tbl_deep_skill.skill_options
  // (post-commit so a sync failure doesn't leave the row uncreated).
  await syncSkillOptionsJson(deepSkillId).catch((err) => {
    logger.warn({ err, deepSkillId }, 'deep-skill: syncSkillOptionsJson failed post-create (non-fatal)');
  });

  // ── Auto-generate image (2026-06-12) ────────────────────────────────
  // Fire-and-forget DALL-E pipeline when the operator skipped the image
  // upload. require() is late-bound here to avoid any circular-import
  // surprises (the gen service requires us back for cache invalidation).
  // Failures are tracked on the row via image_gen_status='failed' — they
  // do NOT bubble up to the caller; create() still returns the row.
  try {
    const dsImageGen = require('./deep-skill-image-gen.service');
    if (!input.deepskill_image && await dsImageGen.isAutoGenEnabled()) {
      // Stamp image_gen_attempted_at = NOW() so the 5-min orphan-reset
      // cron can detect rows whose dispatch was killed by a server
      // restart (status='pending' + age > 10 min ⇒ flip to 'failed').
      await pool.query(
        'UPDATE tbl_deep_skill SET image_gen_status = ?, image_gen_attempted_at = NOW() WHERE deepskill_id = ?',
        ['pending', deepSkillId],
      );
      // A fresh AUTO_INCREMENT id can't already be in the single-flight
      // Set, so a false return here would be surprising — log it but DON'T
      // revert (no prior state worth restoring on a just-created row).
      const queued = dsImageGen.dispatch(deepSkillId);
      if (!queued) {
        logger.warn({ deepSkillId }, 'deep-skill: auto-gen dispatch unexpectedly skipped on fresh create');
      }
    }
  } catch (err) {
    logger.warn({ err, deepSkillId }, 'deep-skill: auto-gen dispatch failed post-create (non-fatal)');
  }

  return getById(deepSkillId);
}

async function update(deepskillId, patch) {
  /*
   * Case-insensitive resolution mirrors create(): if the patch supplies
   * a `category_name` / `service_type_name` (no id), resolve to an
   * existing row first. Numeric ids in the patch still win.
   */
  const next = { ...patch };
  if (next.category_id === undefined && next.category_name) {
    const cat = await resolveCategoryByName(pool, next.category_name);
    next.category_id = cat.id;
  }
  if (next.service_type_id === undefined && next.service_type_name) {
    // Need a category to scope the type lookup — fall back to the
    // current category on the row if the patch didn't change it.
    let catId = next.category_id;
    if (catId === undefined) {
      const [[curr]] = await pool.query(
        'SELECT category_id FROM tbl_deep_skill WHERE deepskill_id = ? LIMIT 1',
        [deepskillId],
      );
      catId = curr?.category_id;
    }
    if (catId) {
      const typ = await resolveServiceTypeByName(pool, catId, next.service_type_name);
      next.service_type_id = typ.id;
    }
  }
  const MUTABLE = ['category_id', 'service_type_id', 'deepskill_name',
    'deepskill_description', 'deepskill_tag_words', 'deepskill_image', 'status'];
  const sets = []; const values = [];
  for (const col of MUTABLE) {
    if (next[col] !== undefined) { sets.push(`${col} = ?`); values.push(next[col]); }
  }
  if (sets.length === 0) return getById(deepskillId);
  values.push(deepskillId);
  await pool.query(`UPDATE tbl_deep_skill SET ${sets.join(', ')} WHERE deepskill_id = ?`, values);

  // If this patch deactivates/deletes the skill (status → 0), hard-delete its
  // option definitions (product rule: an inactive/deleted deep skill drops its
  // mapped options) and re-sync the denormalised skill_options JSON.
  if (Number(next.status) === 0) {
    await pool.query('DELETE FROM tbl_deepskill_options WHERE deepskill_id = ?', [deepskillId]);
    await syncSkillOptionsJson(deepskillId).catch((err) => {
      logger.warn({ err, deepskillId }, 'deep-skill: syncSkillOptionsJson failed after deactivate option-purge (non-fatal)');
    });
  }

  // ── Auto-generate image on update (2026-06-12) ──────────────────────
  // Re-read the post-patch state so the trigger reflects what's
  // actually on the row (not what the patch CLAIMED to set). Guards:
  //   - skip if image is now non-empty (operator EXPLICITLY set one,
  //     either via this patch or it was already there).
  //   - skip if the skill is soft-deleted (status !== 1).
  //   - skip if feature flag or OPENAI_API_KEY is off.
  // Patch path doesn't include the manual image-upload route — that
  // goes through replaceImage() — so we're safe to trigger from any
  // update() call that leaves deepskill_image empty.
  try {
    const dsImageGen = require('./deep-skill-image-gen.service');
    if (await dsImageGen.isAutoGenEnabled()) {
      const [[curr]] = await pool.query(
        `SELECT deepskill_image, status, image_gen_status, image_gen_attempted_at
           FROM tbl_deep_skill WHERE deepskill_id = ? LIMIT 1`,
        [deepskillId],
      );
      const imgEmpty = !curr?.deepskill_image || !String(curr.deepskill_image).trim();
      const isActive = Number(curr?.status) === 1;
      const notInflight = curr?.image_gen_status !== 'pending';
      if (curr && imgEmpty && isActive && notInflight) {
        // Stamp image_gen_attempted_at so orphan-reset cron can find
        // restart-stuck rows. See matching comment in create() above.
        await pool.query(
          'UPDATE tbl_deep_skill SET image_gen_status = ?, image_gen_attempted_at = NOW() WHERE deepskill_id = ?',
          ['pending', deepskillId],
        );
        const queued = dsImageGen.dispatch(deepskillId);
        if (!queued) {
          // Single-flight rejected the dispatch (already in-flight). Revert
          // BOTH stamped columns to their prior values so the row isn't
          // left orphaned in 'pending' with no worker behind it.
          await pool.query(
            'UPDATE tbl_deep_skill SET image_gen_status = ?, image_gen_attempted_at = ? WHERE deepskill_id = ?',
            [curr.image_gen_status, curr.image_gen_attempted_at, deepskillId],
          );
          logger.info(
            { deepskillId },
            'deep-skill: auto-gen dispatch skipped (already in-flight) — reverted pending stamp',
          );
        }
      }
    }
  } catch (err) {
    logger.warn({ err, deepskillId }, 'deep-skill: auto-gen dispatch failed post-update (non-fatal)');
  }

  return getById(deepskillId);
}

/*
 * Duplicate-name UPSERT tail (2026-06-15). Called from create() when a
 * skill with the same name already exists under the same category+type.
 * Reuses update() for the scalar columns (description / tag_words /
 * image / status) — which also drives the auto-gen pipeline — then syncs
 * the option set via the same case-insensitive resolver the add-after-
 * create flow uses (reactivates soft-deleted matches; never inserts a
 * duplicate chip). Returns the refreshed record exactly like create().
 *
 * Only patches columns the caller actually supplied: an upsert that omits
 * `deepskill_description` must NOT blank an existing one, so we forward a
 * field only when it's present on the input. status is forced to 1 — a
 * re-add of an existing (possibly soft-deleted) skill reactivates it,
 * mirroring the option reactivation below and the status=1 default a
 * fresh insert would get.
 */
async function updateExistingDuplicate(deepskillId, input) {
  const patch = { status: 1 };
  if (input.deepskill_description !== undefined) {
    patch.deepskill_description = input.deepskill_description || null;
  }
  if (input.deepskill_tag_words !== undefined) {
    patch.deepskill_tag_words = input.deepskill_tag_words || null;
  }
  // Only forward a canonical image key; the modal sends '' / a placeholder
  // when nothing was picked, and we must not wipe an existing image then.
  if (input.deepskill_image) {
    patch.deepskill_image = input.deepskill_image;
  }
  await update(deepskillId, patch);

  // Sync options — case-insensitive reuse, reactivates soft-deleted chips.
  const rawOptions = Array.isArray(input.options) ? input.options : [];
  const seen = new Set();
  for (const o of rawOptions) {
    const trimmed = String(o?.skill_option || '').trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    await resolveSkillOptionByName(pool, deepskillId, trimmed);
  }
  if (seen.size > 0) {
    await syncSkillOptionsJson(deepskillId).catch((err) => {
      logger.warn({ err, deepskillId }, 'deep-skill: syncSkillOptionsJson failed on duplicate-name update (non-fatal)');
    });
  }

  return getById(deepskillId);
}

async function setStatus(deepskillId, active) {
  // Transactional: when a deep skill is deactivated/deleted (active=false), the
  // status flip and the hard-delete of its option definitions must be atomic
  // (product rule: an inactive/deleted deep skill drops its mapped options).
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('UPDATE tbl_deep_skill SET status = ? WHERE deepskill_id = ?',
      [active ? 1 : 0, deepskillId]);
    if (!active) {
      await conn.query('DELETE FROM tbl_deepskill_options WHERE deepskill_id = ?', [deepskillId]);
    }
    await conn.commit();
  } catch (e) {
    try { await conn.rollback(); } catch (_) { /* ignore rollback failure */ }
    throw e;
  } finally {
    conn.release();
  }
  // Re-sync the denormalised skill_options JSON so it reflects the now-empty
  // option set (legacy consumers read that blob). Non-fatal if it fails.
  if (!active) {
    await syncSkillOptionsJson(deepskillId).catch((err) => {
      logger.warn({ err, deepskillId }, 'deep-skill: syncSkillOptionsJson failed after deactivate option-purge (non-fatal)');
    });
  }
  return getById(deepskillId);
}

// ─── Options CRUD (under a deep skill) ──────────────────────────────
/*
 * Every write to tbl_deepskill_options also refreshes the denormalised JSON
 * blob on tbl_deep_skill.skill_options. Legacy consumers (Angular dashboard,
 * technician mobile flow) read one or the other; keeping them in sync is the
 * price we pay for not refactoring the schema.
 */
async function syncSkillOptionsJson(deepskillId) {
  const [rows] = await pool.query(
    'SELECT skill_option FROM tbl_deepskill_options WHERE deepskill_id = ? AND status = 1 ORDER BY id',
    [deepskillId]
  );
  const json = JSON.stringify(rows.map((r) => r.skill_option));
  await pool.query('UPDATE tbl_deep_skill SET skill_options = ? WHERE deepskill_id = ?',
    [json, deepskillId]);
}

async function addOption(deepskillId, { skill_option }) {
  /*
   * Case-insensitive reuse (2026-06-10) — if an option with the same
   * name (case + whitespace insensitive) already exists for this skill,
   * return its id instead of inserting a duplicate. Soft-deleted
   * matches get reactivated so the chip reappears in the UI.
   */
  const resolved = await resolveSkillOptionByName(pool, deepskillId, skill_option);
  await syncSkillOptionsJson(deepskillId);
  return { id: resolved.id };
}

async function updateOption(deepskillId, optionId, patch) {
  const sets = []; const values = [];
  if (patch.skill_option !== undefined) { sets.push('skill_option = ?'); values.push(patch.skill_option); }
  if (patch.status       !== undefined) { sets.push('status = ?');       values.push(patch.status ? 1 : 0); }
  if (sets.length === 0) return { ok: true };
  values.push(optionId, deepskillId);
  await pool.query(
    `UPDATE tbl_deepskill_options SET ${sets.join(', ')} WHERE id = ? AND deepskill_id = ?`,
    values
  );
  await syncSkillOptionsJson(deepskillId);
  return { ok: true };
}

async function deleteOption(deepskillId, optionId) {
  // Soft delete — set status=0 and refresh the JSON blob. Hard delete would
  // break historical tbl_efr_deepskill_mapping rows that reference the option.
  await pool.query(
    'UPDATE tbl_deepskill_options SET status = 0 WHERE id = ? AND deepskill_id = ?',
    [optionId, deepskillId]
  );
  await syncSkillOptionsJson(deepskillId);
  return { ok: true };
}

// ─── Sub-resource: Mapped Easyfixers ────────────────────────────────
/*
 * Feeds the "View Mapped Easyfixers" modal on the Manage Deep Skills page.
 *
 * Schema reality (legacy column naming inversion — preserved, do NOT
 * "correct" these names; see services/candidate-ranking.service.js:120-141):
 *
 *   tbl_efr_deepskill_mapping
 *     easyfixer_id      → FK to tbl_easyfixer.efr_id
 *     parent_skill_id   → legacy: actually holds deep_skill_id (3rd-level)
 *     deep_skill_id     → legacy: actually holds option_id (tbl_deepskill_options.id)
 *     is_repairing      → active flag (1 active / 0 inactive)
 *     insert_date       → audit timestamp (column attested in
 *                         easyfixer.service.js:591 — `m.insert_date AS mapped_at`)
 *
 * A single easyfixer can map to MULTIPLE options under the same deep skill,
 * so we GROUP BY easyfixer_id and GROUP_CONCAT the option labels.
 */
async function listMappedEasyfixers(deepSkillId, { limit = 10, offset = 0 } = {}) {
  const [[{ total }]] = await pool.query(`
    SELECT COUNT(DISTINCT m.easyfixer_id) AS total
      FROM tbl_efr_deepskill_mapping m
     WHERE m.parent_skill_id = ?
       AND m.is_repairing = 1
  `, [deepSkillId]);

  const [rows] = await pool.query(`
    SELECT e.efr_id,
           e.efr_name,
           e.efr_no,
           e.efr_email,
           c.city_name,
           COUNT(DISTINCT o.id) AS option_count,
           GROUP_CONCAT(DISTINCT o.skill_option ORDER BY o.skill_option SEPARATOR ', ') AS mapped_options,
           e.efr_status,
           e.is_technician_verified,
           MAX(m.insert_date) AS last_mapped_at
      FROM tbl_efr_deepskill_mapping m
      JOIN tbl_easyfixer e              ON e.efr_id = m.easyfixer_id
      LEFT JOIN tbl_city c              ON c.city_id = e.efr_cityId
      LEFT JOIN tbl_deepskill_options o ON o.id = m.deep_skill_id
     WHERE m.parent_skill_id = ?
       AND m.is_repairing = 1
     GROUP BY e.efr_id, e.efr_name, e.efr_no, e.efr_email, c.city_name, e.efr_status, e.is_technician_verified
     ORDER BY e.efr_name ASC
     LIMIT ? OFFSET ?
  `, [deepSkillId, Number(limit), Number(offset)]);

  return { rows, total };
}

/*
 * Bulk mapped-easyfixer counts (2026-06-08). Drives the new "Mapped
 * Easyfixers" aggregate column on the Manage Deep Skills list page —
 * one count per skill_id passed in, returned as a flat array of
 * { deepskill_id, count } pairs.
 *
 * Same JOIN/filter logic as listMappedEasyfixers above, but rolled up
 * by parent_skill_id instead of paginating one skill's easyfixers.
 * Single round-trip for the whole page (typically 10-50 skill ids per
 * call); GROUP BY uses the legacy-named `parent_skill_id` (which
 * actually holds the deep_skill_id per the column-inversion docblock
 * at the top of this file).
 *
 * Hard cap of 500 ids per call — mirrors the aggregates endpoint cap
 * on /admin/easyfixers and is well above any realistic page size.
 * Empty / non-positive ids are silently dropped.
 */
async function mappedEasyfixerCounts(deepSkillIds) {
  if (!Array.isArray(deepSkillIds) || deepSkillIds.length === 0) {
    return { rows: [] };
  }
  const ids = deepSkillIds
    .slice(0, 500)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) return { rows: [] };

  const placeholders = ids.map(() => '?').join(',');
  const [rows] = await pool.query(`
    SELECT m.parent_skill_id              AS deepskill_id,
           COUNT(DISTINCT m.easyfixer_id) AS count
      FROM tbl_efr_deepskill_mapping m
     WHERE m.parent_skill_id IN (${placeholders})
       AND m.is_repairing = 1
     GROUP BY m.parent_skill_id
  `, ids);

  return { rows };
}

// ─── XLSX Download (2026-06-10) ─────────────────────────────────────
/*
 * Build a populated workbook of every deep skill in the catalogue.
 * Columns: Deep Skill ID, Name, Description, Tag Words, Service
 * Category, Service Type, Skill Options (comma-joined active options),
 * Image Filename (raw S3 key), Status, Created Date (IST).
 *
 * Returns a Buffer ready to stream as
 * `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`.
 */
async function downloadXlsx() {
  // One round-trip — GROUP_CONCAT keeps the option list inline so we
  // don't N+1 the options table per skill. COALESCE ensures the field
  // is at least an empty string for skills with no active options.
  const [rows] = await pool.query(`
    SELECT ds.deepskill_id,
           ds.deepskill_name,
           ds.deepskill_description,
           ds.deepskill_tag_words,
           ds.deepskill_image,
           ds.status,
           ds.inserted_on,
           ds.category_id,
           ds.service_type_id,
           sc.service_catg_name AS category_name,
           st.service_type_name,
           COALESCE(
             (SELECT GROUP_CONCAT(o.skill_option ORDER BY o.id SEPARATOR ', ')
                FROM tbl_deepskill_options o
               WHERE o.deepskill_id = ds.deepskill_id
                 AND o.status = 1),
             ''
           ) AS skill_options_csv
      FROM tbl_deep_skill ds
      LEFT JOIN tbl_service_catg sc ON sc.service_catg_id = ds.category_id
      LEFT JOIN tbl_service_type st ON st.service_type_id = ds.service_type_id
      ORDER BY ds.deepskill_id ASC
  `);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'EasyFix CRM';
  wb.created = new Date();
  const ws = wb.addWorksheet('Deep Skills');

  /*
   * Column order (2026-06-10): Service Category and Service Type each
   * get their FK Id right next to the name so operators can map raw
   * IDs back to display names without a lookup. Mirrors the format
   * the Bulk Upload page now uses for "New Categories: Name (Id: X)".
   */
  ws.columns = [
    { header: 'Deep Skill ID',         key: 'id',          width: 14 },
    { header: 'Deep Skill Name',       key: 'name',        width: 36 },
    { header: 'Description',           key: 'description', width: 50 },
    { header: 'Tag Words',             key: 'tagWords',    width: 30 },
    { header: 'Service Category Id',   key: 'categoryId',  width: 18 },
    { header: 'Service Category',      key: 'category',    width: 24 },
    { header: 'Service Type Id',       key: 'typeId',      width: 18 },
    { header: 'Service Type',          key: 'type',        width: 24 },
    { header: 'Skill Options',         key: 'options',     width: 40 },
    { header: 'Image Filename',        key: 'image',       width: 40 },
    { header: 'Status',                key: 'status',      width: 12 },
    { header: 'Created Date',          key: 'created',     width: 22 },
  ];
  ws.getRow(1).font = { bold: true };

  for (const r of rows) {
    ws.addRow({
      id:          r.deepskill_id,
      name:        r.deepskill_name || '',
      description: r.deepskill_description || '',
      tagWords:    r.deepskill_tag_words || '',
      categoryId:  r.category_id || '',
      category:    r.category_name || '',
      typeId:      r.service_type_id || '',
      type:        r.service_type_name || '',
      options:     r.skill_options_csv || '',
      image:       r.deepskill_image || '',
      status:      Number(r.status) ? 'Active' : 'Inactive',
      // Format as IST `dd MMM yyyy HH:mm`. The DB stores DATETIME in
      // server-local; toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
      // gives us a stable IST rendering regardless of host TZ.
      created:     r.inserted_on ? formatInsertedOnIST(r.inserted_on) : '',
    });
  }

  return await wb.xlsx.writeBuffer();
}

function formatInsertedOnIST(value) {
  try {
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    // dd MMM yyyy HH:mm — short month name to keep the column scannable.
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      day:    '2-digit',
      month:  'short',
      year:   'numeric',
      hour:   '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(d);
    const get = (t) => parts.find((p) => p.type === t)?.value || '';
    return `${get('day')} ${get('month')} ${get('year')} ${get('hour')}:${get('minute')}`;
  } catch {
    return '';
  }
}

// ─── Image replace + S3 cleanup (2026-06-10) ─────────────────────────
/*
 * Upload a new image to S3 at `Skills/Skill_<id>_<seq>`, persist the
 * key on `tbl_deep_skill.deepskill_image`, and best-effort delete the
 * previous S3 object. Returns `{ image, url }` where `url` is a
 * short-TTL presigned URL the FE can render immediately.
 */
async function replaceImage(skillId, { buffer, contentType, originalName }) {
  if (!s3Storage.isEnabled()) {
    const err = new Error('S3 is not configured (set S3_BUCKET_NAME in backend.env)');
    err.status = 503;
    throw err;
  }
  const [[row]] = await pool.query(
    'SELECT deepskill_image FROM tbl_deep_skill WHERE deepskill_id = ?',
    [skillId],
  );
  if (!row) {
    const err = new Error('deep skill not found');
    err.status = 404;
    throw err;
  }
  const prev = String(row.deepskill_image || '');
  // Seq increments off the previous canonical key when present so old
  // versions stay distinct in S3 (audit + accidental-delete recovery).
  const match = prev.match(/^Skills\/Skill_\d+_(\d+)$/);
  const seq = match ? Number(match[1]) + 1 : 1;

  const Key = await s3Storage.putSkillImage({
    skillId, seq, buffer, contentType, originalName,
  });
  await pool.query(
    'UPDATE tbl_deep_skill SET deepskill_image = ? WHERE deepskill_id = ?',
    [Key, skillId],
  );

  // Fire-and-forget cleanup of the prior object. Best-effort — a stale
  // image in S3 is a cost annoyance, not a correctness issue, so we
  // log and move on rather than failing the upload.
  if (prev && prev !== Key && prev.startsWith('Skills/')) {
    try {
      const result = await s3Storage.deleteObject(prev);
      if (!result.deleted) {
        logger.warn(`deep-skill: previous image cleanup non-fatal: ${result.reason}`, { prev, reason: result.reason });
      }
    } catch (e) {
      logger.warn({ err: e, prev }, 'deep-skill: previous image cleanup threw (non-fatal)');
    }
  }

  let url = null;
  try { url = await s3Storage.getPresignedUrl(Key); } catch { /* presign optional */ }
  // invalidate the 24h getAllDeepSkillImages cache — image just changed
  invalidateAllDeepSkillImagesCache();
  return { image: Key, url };
}

/*
 * Clear the image: delete the S3 object (best-effort) and null out
 * the DB column. No-op if the column is already empty.
 */
async function clearImage(skillId) {
  const [[row]] = await pool.query(
    'SELECT deepskill_image FROM tbl_deep_skill WHERE deepskill_id = ?',
    [skillId],
  );
  if (!row) {
    const err = new Error('deep skill not found');
    err.status = 404;
    throw err;
  }
  const prev = String(row.deepskill_image || '');
  if (prev) {
    await pool.query(
      'UPDATE tbl_deep_skill SET deepskill_image = ? WHERE deepskill_id = ?',
      ['', skillId],
    );
    if (s3Storage.isEnabled() && prev.startsWith('Skills/')) {
      try { await s3Storage.deleteObject(prev); }
      catch (e) { logger.warn({ err: e, prev }, 'deep-skill: clearImage S3 delete non-fatal'); }
    }
    // invalidate the 24h getAllDeepSkillImages cache — image just changed
    invalidateAllDeepSkillImagesCache();
  }
  return { image: '' };
}

/*
 * Resolve an in-memory S3 key (as stored in tbl_deep_skill.deepskill_image)
 * to a short-TTL presigned GET URL. Returns null for empty / non-canonical
 * keys or when S3 isn't enabled — callers should render a fallback in
 * that case. Mirrors the guards used by getImageUrl() so all catalog
 * paths agree on what counts as a resolvable key.
 *
 * Use this whenever you already hold the key (catalog/list/options
 * builders) — avoids the extra round-trip getImageUrl() does to refetch
 * the row by deepskill_id.
 */
async function resolveImageUrlFromKey(key) {
  const trimmed = String(key || '').trim();
  if (!trimmed) return null;
  if (!s3Storage.isEnabled() || !trimmed.startsWith('Skills/')) return null;
  try {
    return await s3Storage.getPresignedUrl(trimmed);
  } catch (e) {
    logger.warn({ err: e, key: trimmed }, 'deep-skill: resolveImageUrlFromKey presign failed');
    return null;
  }
}

/*
 * Resolve a stored deep-skill image key to a short-TTL presigned GET
 * URL. Returns null when the column is empty or S3 isn't enabled.
 *
 * 2026-06-11 refactor: the per-key null-/prefix-/S3-disabled-/presign-
 * error guards are now centralised in `resolveImageUrlFromKey()` above.
 * This function keeps its existing wrapper responsibilities:
 *   1. Look up the skill row by id (404 if missing).
 *   2. Surface BOTH the raw `image` key AND the resolved `url` so the
 *      FE editor's "current image" preview + "Replace…"/"Clear" actions
 *      can reference the key directly.
 * Single source of truth for presign logic; no more divergent copies.
 */
async function getImageUrl(skillId) {
  const [[row]] = await pool.query(
    'SELECT deepskill_image FROM tbl_deep_skill WHERE deepskill_id = ?',
    [skillId],
  );
  if (!row) {
    const err = new Error('deep skill not found');
    err.status = 404;
    throw err;
  }
  const key = String(row.deepskill_image || '').trim();
  const url = await resolveImageUrlFromKey(key);
  return { image: key, url };
}

/*
 * Bulk catalog image resolver (2026-06-11).
 *
 * Resolves EVERY non-empty deepskill_image key on `tbl_deep_skill` (active
 * AND inactive — the catalog endpoint exposes only what the public
 * consumers actually need: { deep_skill_id, image_url }, and stale rows
 * with images are still legitimate to render in legacy CRM/Mobile UIs
 * that pin to an older deep-skill id).
 *
 * Why a dedicated bulk path instead of looping `getImageUrl` on the
 * caller side:
 *   1. ~hundreds of skills × per-call SQL lookup = wasteful when the
 *      caller only needs a flat list.
 *   2. Long-lived presigned URLs (25h, see below) blow up the default
 *      module-level PRESIGN_TTL_SEC, so we bypass `getPresignedUrl`
 *      and re-mint each URL with an explicit `expiresIn` here.
 *
 * Presigned-URL TTL: 25 hours (90_000 seconds).
 *   The response is wrapped in a 24h in-memory cache (see
 *   `getAllDeepSkillImages` below). At the cache-window's tail end a
 *   served URL must STILL be valid for the receiving browser, so the
 *   per-URL TTL has to outlive the cache TTL by a safe margin. 25h
 *   gives a 1h headroom over the 24h cache TTL — comfortably bigger
 *   than any clock skew or rendering delay we'd see in practice.
 *   AWS SigV4 caps presign TTL at 7 days, so 25h is well within spec.
 *
 * Returns Promise<{deep_skill_id:number, image_url:string|null}[]>.
 * Skills whose key is empty / non-`Skills/` / unpresignable are
 * filtered OUT of the response (caller spec: only include rows with
 * a non-null/non-empty image).
 */
const BULK_IMAGE_PRESIGN_TTL_SEC = 25 * 60 * 60; // 25h — must outlive 24h cache TTL.

async function buildAllDeepSkillImages() {
  const [rows] = await pool.query(
    `SELECT deepskill_id AS deep_skill_id,
            deepskill_image AS image_key
       FROM tbl_deep_skill
      WHERE deepskill_image IS NOT NULL
        AND deepskill_image <> ''`,
  );
  if (!s3Storage.isEnabled() || rows.length === 0) return [];

  // Inline presign with explicit 25h expiry — `s3Storage.getPresignedUrl`
  // bakes in the 5-min module default and we deliberately don't widen its
  // signature for a single bulk-cache use case.
  const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  const bucket = s3Storage.bucketName();
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'ap-south-1';
  const s3 = new S3Client({ region });

  const presigned = await Promise.all(rows.map(async (r) => {
    const key = String(r.image_key || '').trim();
    if (!key || !key.startsWith('Skills/')) return null;
    try {
      const url = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: bucket, Key: key }),
        { expiresIn: BULK_IMAGE_PRESIGN_TTL_SEC },
      );
      return { deep_skill_id: Number(r.deep_skill_id), image_url: url };
    } catch (e) {
      logger.warn(
        { err: e && e.message, key, deep_skill_id: r.deep_skill_id },
        'deep-skill: bulk image presign failed — skipping row',
      );
      return null;
    }
  }));
  return presigned.filter(Boolean);
}

/*
 * Module-scope 24h cache for getAllDeepSkillImages (2026-06-11).
 *
 * Mirrors the `deepSkillCatalogCache` / single-flight pattern in
 * services/easyfixer-profile-update-link.service.js: a `{ data,
 * expires, inflight }` record updated atomically. Single-flight is
 * enforced by storing the in-flight Promise on the cache record —
 * concurrent cache-miss callers await the SAME promise instead of
 * racing N parallel builds.
 *
 * Pure in-memory, single process. A multi-instance deploy gets one
 * cache per instance; acceptable because the underlying data is
 * read-only catalog material and the worst-case extra work is a few
 * SELECTs + presigns per instance per day.
 *
 * 24h chosen because:
 *   - Deep-skill image edits are rare (a few per month).
 *   - Presigned-URL TTL is 25h, so a URL served from the very tail
 *     of the cache window is still valid for ~1h on the client.
 *   - Process restarts (CI deploys) drop the cache cleanly.
 */
const ALL_DEEP_SKILL_IMAGES_TTL_MS = 24 * 60 * 60 * 1000; // 24h
let allDeepSkillImagesCache = { data: null, expires: 0, inflight: null };

async function getAllDeepSkillImages() {
  const now = Date.now();
  if (allDeepSkillImagesCache.data && now < allDeepSkillImagesCache.expires) {
    return allDeepSkillImagesCache.data;
  }
  if (allDeepSkillImagesCache.inflight) {
    return allDeepSkillImagesCache.inflight;
  }
  const promise = buildAllDeepSkillImages();
  allDeepSkillImagesCache = { data: null, expires: 0, inflight: promise };
  try {
    const payload = await promise;
    allDeepSkillImagesCache = {
      data: payload,
      expires: Date.now() + ALL_DEEP_SKILL_IMAGES_TTL_MS,
      inflight: null,
    };
    return payload;
  } catch (e) {
    // Don't poison the cache on failure — next call retries fresh.
    allDeepSkillImagesCache = { data: null, expires: 0, inflight: null };
    throw e;
  }
}

/*
 * Stub invalidator. Wire this into any future admin surface that
 * mutates `tbl_deep_skill.deepskill_image` (replaceImage / clearImage
 * / bulk upload) so the public bulk endpoint reflects the change
 * within the same request. No callers wired yet — kept exported so
 * the wire-up is a one-line require + call.
 */
function invalidateAllDeepSkillImagesCache() {
  allDeepSkillImagesCache = { data: null, expires: 0, inflight: null };
}

module.exports = {
  list, getById, create, update, setStatus,
  addOption, updateOption, deleteOption,
  listMappedEasyfixers,
  mappedEasyfixerCounts,
  // 2026-06-10:
  downloadXlsx,
  replaceImage,
  clearImage,
  getImageUrl,
  resolveImageUrlFromKey,
  resolveCategoryByName,
  resolveExistingCategoryByName,
  resolveServiceTypeByName,
  resolveSkillOptionByName,
  // 2026-06-11:
  getAllDeepSkillImages,
  invalidateAllDeepSkillImagesCache,
};
