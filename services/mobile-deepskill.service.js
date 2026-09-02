const { pool } = require('../db');
const deepSkillService = require('./deep-skill.service');
const logger = require('../logger');

/*
 * Mobile Deep-Skill flow — technician-facing read + write of the
 * 4-level skill catalogue (Service Category → Service Type → Deep Skill
 * → Deep-Skill Option), with the calling technician's current selections
 * marked per option.
 *
 * The technician is ALWAYS implicit: `efrId === req.tech.efr_id`. No
 * `technicianId` ever travels in the body/query (unlike the legacy
 * Angular contract which passed `?technicianId=` / `technicianId` in the
 * payload — the mobile token already identifies the tech).
 *
 * ─── tbl_efr_deepskill_mapping COLUMN-NAME INVERSION (preserve) ──────
 *
 * The two id columns on tbl_efr_deepskill_mapping store the OPPOSITE of
 * what their names suggest (long-standing legacy drift — see the full
 * docblock in services/deep-skill.service.js / services/
 * easyfixer-verification.service.js):
 *
 *   physical column      ACTUALLY holds                  semantic name
 *   ─────────────────    ─────────────────────────────   ─────────────────
 *   m.parent_skill_id    tbl_deep_skill.deepskill_id     deep_skill_id
 *   m.deep_skill_id      tbl_deepskill_options.id        option_id
 *   m.is_repairing       active flag (1 active / 0 soft) —
 *
 * Each row = ONE (easyfixer × option) mapping. WHERE/JOIN/INSERT clauses
 * use the physical names (MySQL aliases aren't allowed there); SELECTs
 * alias through to the semantic names. Inline comments mark every
 * non-aliased usage.
 *
 * ─── Deep-skill service-type discriminator ──────────────────────────
 *
 * `tbl_service_type.display = 2` marks DEEP-SKILL service types
 * (confirmed 2026-06-15). `service_type_status`: 1=active, 0=inactive,
 * 3=deleted. The hierarchy read restricts to display=2 + status=1 so
 * only deep-skill types surface, matching the CRM deep-skill picker.
 */

// ─── GET hierarchy ──────────────────────────────────────────────────
/*
 * Build the full deep-skill tree for `categoryId`, with `isSelected`
 * stamped on every option for THIS technician. Roll-up counts at each
 * level so the app can render "3 of 5 selected" badges:
 *   - serviceType: dsTotalCount / dsSelectCount  (deep skills under it,
 *                  and how many have ≥1 option selected)
 *   - deepSkill:   dsOptionTotalCount / dsOptionSelectCount
 *
 * Shape (camelCase, matches the RN app / blueprint §4.2):
 *   { categoryId, categoryName, serviceTypes:[ {
 *       serviceTypeId, serviceTypeName, dsTotalCount, dsSelectCount,
 *       deepSkills:[ {
 *         deepSkillId, deepSkillName, deepSkillImage,
 *         dsOptionTotalCount, dsOptionSelectCount,
 *         options:[ { id, skillOption, deepskillId, status, isSelected } ]
 *       } ]
 *   } ] }
 */
async function getHierarchy(efrId, categoryId) {
  logger.info('Get deep-skill hierarchy · categoryId=' + categoryId);
  // 1) Category name (404 if the category doesn't exist / is deleted).
  const [[cat]] = await pool.query(
    `SELECT service_catg_id, service_catg_name
       FROM tbl_service_catg
      WHERE service_catg_id = ? AND service_catg_status <> 3
      LIMIT 1`,
    [categoryId],
  );
  if (!cat) {
    logger.warn('Get deep-skill hierarchy failed · service category not found · categoryId=' + categoryId);
    const err = new Error('service category not found');
    err.status = 404;
    throw err;
  }

  // 2) Service types under the category — deep-skill types only
  //    (display = 2) and active (service_type_status = 1).
  const [serviceTypes] = await pool.query(
    `SELECT service_type_id, service_type_name
       FROM tbl_service_type
      WHERE service_catg_id = ?
        AND display = 2
        AND service_type_status = 1
      ORDER BY service_type_name ASC`,
    [categoryId],
  );

  // 3) Active deep skills under the category.
  const [deepSkills] = await pool.query(
    `SELECT deepskill_id, service_type_id, deepskill_name, deepskill_image
       FROM tbl_deep_skill
      WHERE category_id = ? AND status = 1
      ORDER BY deepskill_name ASC`,
    [categoryId],
  );
  logger.info('Found ' + serviceTypes.length + ' service types and ' + deepSkills.length + ' deep skills');

  // 4) Active options for those deep skills (single round-trip).
  let options = [];
  if (deepSkills.length) {
    const placeholders = deepSkills.map(() => '?').join(',');
    const [rows] = await pool.query(
      `SELECT id, deepskill_id, skill_option, status
         FROM tbl_deepskill_options
        WHERE deepskill_id IN (${placeholders}) AND status = 1
        ORDER BY id ASC`,
      deepSkills.map((d) => d.deepskill_id),
    );
    options = rows;
  }

  // 5) This technician's selected option ids under THIS category.
  //    `m.deep_skill_id` (physical) holds the option id (inversion).
  const [selRows] = await pool.query(
    `SELECT m.deep_skill_id AS option_id -- physical column deep_skill_id holds the option id (inversion)
       FROM tbl_efr_deepskill_mapping m
      WHERE m.easyfixer_id = ?
        AND m.category_id = ?
        AND m.is_repairing = 1`,
    [efrId, categoryId],
  );
  const selectedOptionIds = new Set(selRows.map((r) => Number(r.option_id)));

  // 6) Resolve deep-skill image keys → short-TTL presigned URLs (only
  //    for skills that actually carry an image). Reuses the catalogue's
  //    single source of presign truth.
  const urlByImageKey = new Map();
  await Promise.all(
    Array.from(new Set(
      deepSkills.map((d) => String(d.deepskill_image || '').trim()).filter(Boolean),
    )).map(async (key) => {
      urlByImageKey.set(key, await deepSkillService.resolveImageUrlFromKey(key));
    }),
  );

  // 7) Index options by deepskill_id.
  const optsByDeepSkill = new Map();
  for (const o of options) {
    const arr = optsByDeepSkill.get(o.deepskill_id) || [];
    arr.push({
      id:          o.id,
      skillOption: o.skill_option,
      deepskillId: o.deepskill_id,
      status:      Number(o.status),
      isSelected:  selectedOptionIds.has(Number(o.id)),
    });
    optsByDeepSkill.set(o.deepskill_id, arr);
  }

  // 8) Index deep skills by service_type_id, computing per-skill counts.
  const skillsByType = new Map();
  for (const d of deepSkills) {
    const opts = optsByDeepSkill.get(d.deepskill_id) || [];
    const optionSelectCount = opts.filter((o) => o.isSelected).length;
    const imageKey = String(d.deepskill_image || '').trim();
    const node = {
      deepSkillId:        d.deepskill_id,
      deepSkillName:      d.deepskill_name,
      // Raw key (relative path) AND a resolved URL — the app can render
      // either. Matches the legacy `deepSkillImage` field.
      deepSkillImage:     d.deepskill_image || null,
      deepSkillImageUrl:  imageKey ? (urlByImageKey.get(imageKey) || null) : null,
      dsOptionTotalCount:  opts.length,
      dsOptionSelectCount: optionSelectCount,
      isDeepSkillSelected: optionSelectCount > 0,
      options:             opts,
    };
    const arr = skillsByType.get(d.service_type_id) || [];
    arr.push(node);
    skillsByType.set(d.service_type_id, arr);
  }

  // 9) Assemble service-type nodes with roll-up counts.
  const serviceTypeNodes = serviceTypes.map((st) => {
    const skills = skillsByType.get(st.service_type_id) || [];
    const selectedSkillCount = skills.filter((s) => s.isDeepSkillSelected).length;
    return {
      serviceTypeId:        st.service_type_id,
      serviceTypeName:      st.service_type_name,
      dsTotalCount:         skills.length,
      dsSelectCount:        selectedSkillCount,
      isServiceTypeSelected: selectedSkillCount > 0,
      deepSkills:           skills,
    };
  });

  logger.info('Returning hierarchy · ' + serviceTypeNodes.length + ' service types · ' + selectedOptionIds.size + ' selected options');
  return {
    categoryId:   cat.service_catg_id,
    categoryName: cat.service_catg_name,
    serviceTypes: serviceTypeNodes,
  };
}

// ─── POST skills (diff-apply) ───────────────────────────────────────
/*
 * Replace-with-diff semantics over the technician's selections for ONE
 * category. The incoming payload is the FINAL desired state for the
 * (technician × category) scope:
 *
 *   { categoryId,
 *     serviceTypes:[ { serviceTypeId,
 *       deepSkills:[ { deepSkillId, selectedOptions:[optionId,...] } ] } ] }
 *
 * Rules:
 *   - An empty `selectedOptions` for a deep skill = delete (soft) all of
 *     that skill's mappings for this technician under this category.
 *   - We compute the desired (deepSkillId, optionId) pair set, diff it
 *     against existing ACTIVE rows for (technician × category), then:
 *       • INSERT brand-new pairs (or reactivate a soft-deleted match),
 *       • soft-delete (is_repairing = 0) any active pair no longer wanted.
 *   - Everything runs in a single transaction on a pinned connection.
 *
 * Returns { totalNewMappingsAdded, totalMappingsDeleted,
 *           totalExistingMappings, success:true }.
 *
 * `totalExistingMappings` = the count of desired pairs that were already
 * active and untouched (legacy returned null here; we surface the real
 * count so the app can show "Unchanged: N").
 */
/**
 * May the APP write skills into this category?
 *
 * The whole one-category rule in one place, so it can be checked without a
 * database standing behind it:
 *   inThis  mappings the technician already has in the target category
 *   inAny   mappings the technician has anywhere
 *
 * Editing a category they already hold is always fine; their FIRST category is
 * the onboarding choice; a second one has to come from Ops.
 */
function categoryAllowedForApp({ inThis, inAny }) {
  if (inThis > 0) return true;    // already theirs — editing skills
  return inAny === 0;             // nothing yet — this is the one choice
}

async function applySkills(efrId, payload) {
  const categoryId = Number(payload.categoryId);
  logger.info('Apply deep skills · categoryId=' + categoryId + ' · serviceTypes=' + ((payload.serviceTypes || []).length));
  if (!Number.isInteger(categoryId) || categoryId <= 0) {
    logger.warn('Apply deep skills rejected · categoryId is required');
    const err = new Error('categoryId is required');
    err.status = 400;
    throw err;
  }

  // Validate the category exists / isn't deleted (parity with read path).
  const [[cat]] = await pool.query(
    `SELECT service_catg_id FROM tbl_service_catg
      WHERE service_catg_id = ? AND service_catg_status <> 3 LIMIT 1`,
    [categoryId],
  );
  if (!cat) {
    logger.warn('Apply deep skills failed · service category not found · categoryId=' + categoryId);
    const err = new Error('service category not found');
    err.status = 404;
    throw err;
  }

  /*
   * ONE CATEGORY FROM THE APP. EVER.
   *
   * The rule as stated by the business: a technician onboarding chooses ONE
   * category. After that the app never adds another — Ops adds categories from
   * the CRM, and the technician may then edit skills inside them. So both
   * halves are the same question, asked of the categories the technician
   * ALREADY has mappings in:
   *
   *   already mapped here          → allowed (editing skills, at any stage)
   *   no mappings anywhere yet     → allowed (this is the onboarding choice)
   *   mapped elsewhere, not here   → REJECTED (a second category from the app)
   *
   * Enforced here rather than only in the UI because the UI is a suggestion:
   * this endpoint is reachable with any category id, and a rule that lives only
   * in a screen is not a rule. Deleting is always allowed — a payload that adds
   * nothing cannot create a category — so a technician can still clear skills
   * in a category Ops later removes.
   */
  const adds = (payload.serviceTypes || []).some((st) =>
    (st.deepSkills || []).some((ds) => (ds.selectedOptions || []).length > 0));
  if (adds) {
    const [[existing]] = await pool.query(
      `SELECT
         SUM(st.service_catg_id = ?) AS in_this_category,
         COUNT(*)                    AS in_any_category
         FROM tbl_efr_deepskill_mapping m
         JOIN tbl_service_type st ON st.service_type_id = m.service_type_id
        WHERE m.easyfixer_id = ?`,
      [categoryId, Number(efrId)],
    );
    const inThis = Number(existing?.in_this_category || 0);
    const inAny = Number(existing?.in_any_category || 0);
    if (!categoryAllowedForApp({ inThis, inAny })) {
      logger.warn('Apply deep skills rejected · second category from the app · efrId='
        + efrId + ' · categoryId=' + categoryId);
      const err = new Error(
        'Your categories are set by the EasyFix team. You can add skills inside the '
        + 'categories you already have; ask your manager to add a new category.',
      );
      err.status = 409;
      throw err;
    }
  }

  // Flatten the payload into the desired pair set:
  //   key = `${serviceTypeId}:${deepSkillId}:${optionId}`
  //   val = { serviceTypeId, deepSkillId, optionId }
  // An empty selectedOptions array contributes NO pairs for that skill,
  // which naturally drives the delete of any existing mappings for it.
  const desired = new Map();
  for (const st of (payload.serviceTypes || [])) {
    const serviceTypeId = Number(st.serviceTypeId);
    if (!Number.isInteger(serviceTypeId) || serviceTypeId <= 0) continue;
    for (const ds of (st.deepSkills || [])) {
      const deepSkillId = Number(ds.deepSkillId);
      if (!Number.isInteger(deepSkillId) || deepSkillId <= 0) continue;
      for (const optId of (ds.selectedOptions || [])) {
        const optionId = Number(optId);
        if (!Number.isInteger(optionId) || optionId <= 0) continue;
        desired.set(`${serviceTypeId}:${deepSkillId}:${optionId}`, {
          serviceTypeId, deepSkillId, optionId,
        });
      }
    }
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Existing ACTIVE pairs for (technician × category). Project through
    // the inverted physical columns to their semantic names.
    const [existingRows] = await conn.query(
      `SELECT m.service_type_id        AS service_type_id,
              m.parent_skill_id        AS deep_skill_id, -- physical parent_skill_id holds the deep_skill_id (inversion)
              m.deep_skill_id          AS option_id      -- physical deep_skill_id holds the option id (inversion)
         FROM tbl_efr_deepskill_mapping m
        WHERE m.easyfixer_id = ?
          AND m.category_id = ?
          AND m.is_repairing = 1
        FOR UPDATE`,
      [efrId, categoryId],
    );
    const existing = new Map();
    for (const r of existingRows) {
      existing.set(
        `${Number(r.service_type_id)}:${Number(r.deep_skill_id)}:${Number(r.option_id)}`,
        r,
      );
    }

    // Diff: toAdd = desired - existing ; toDelete = existing - desired.
    let totalNewMappingsAdded = 0;
    let totalMappingsDeleted = 0;
    let totalExistingMappings = 0;

    for (const [key, pair] of desired) {
      if (existing.has(key)) {
        totalExistingMappings += 1;
        continue;
      }
      // Try to reactivate a soft-deleted identical row first; INSERT if none.
      // parent_skill_id ← deepSkillId, deep_skill_id ← optionId (inversion).
      const [upd] = await conn.query(
        `UPDATE tbl_efr_deepskill_mapping
            SET is_repairing = 1
          WHERE easyfixer_id    = ?
            AND category_id     = ?
            AND service_type_id = ?
            AND parent_skill_id = ?  -- holds deep_skill_id (inversion)
            AND deep_skill_id   = ?  -- holds option_id (inversion)
            AND is_repairing    = 0`,
        [efrId, categoryId, pair.serviceTypeId, pair.deepSkillId, pair.optionId],
      );
      if (upd.affectedRows === 0) {
        await conn.query(
          `INSERT INTO tbl_efr_deepskill_mapping
             (easyfixer_id, category_id, service_type_id,
              parent_skill_id, -- physical name; holds deep_skill_id (inversion)
              deep_skill_id,   -- physical name; holds option_id (inversion)
              is_repairing)
           VALUES (?, ?, ?, ?, ?, 1)`,
          [efrId, categoryId, pair.serviceTypeId, pair.deepSkillId, pair.optionId],
        );
      }
      totalNewMappingsAdded += 1;
    }

    // Soft-delete any active pair not in the desired set.
    for (const [key, row] of existing) {
      if (desired.has(key)) continue;
      await conn.query(
        `UPDATE tbl_efr_deepskill_mapping
            SET is_repairing = 0
          WHERE easyfixer_id    = ?
            AND category_id     = ?
            AND service_type_id = ?
            AND parent_skill_id = ?  -- holds deep_skill_id (inversion)
            AND deep_skill_id   = ?  -- holds option_id (inversion)
            AND is_repairing    = 1`,
        [efrId, categoryId, Number(row.service_type_id),
          Number(row.deep_skill_id), Number(row.option_id)],
      );
      totalMappingsDeleted += 1;
    }

    await conn.commit();
    logger.info('Deep skills applied · categoryId=' + categoryId + ' · added=' + totalNewMappingsAdded + ' · deleted=' + totalMappingsDeleted + ' · unchanged=' + totalExistingMappings);
    return {
      totalNewMappingsAdded,
      totalMappingsDeleted,
      totalExistingMappings,
      success: true,
    };
  } catch (e) {
    logger.error('Apply deep skills failed, rolled back · categoryId=' + categoryId + ' · ' + e.message);
    try { await conn.rollback(); } catch (_) { /* swallow rollback failure */ }
    throw e;
  } finally {
    conn.release();
  }
}

module.exports = {
  _internals: { categoryAllowedForApp }, getHierarchy, applySkills };
