const ExcelJS = require('exceljs');
const { pool } = require('../db');
const logger   = require('../logger');
const deepSkillService = require('./deep-skill.service');

/*
 * Manage Deep Skills — bulk upload from ops .xlsx (2026-06-05).
 *
 * Sample files live in `~/Downloads/` (4 categories: Carpentry, Electrician,
 * Plumbing, Sports & Fitness Equipments). All follow the same shape:
 *
 *   Row 1: decorative section headers ("Screenshot 1", "SCREEN SHOT 3", …)  — SKIP
 *   Row 2: real column headers
 *            Col A: "Key words …"     → deepskill_description (long search keywords)
 *            Col B: "Tag Words …"     → deepskill_tag_words (per-skill tech tags)
 *            Col C: "Service Category"
 *            Col D: "Service Type"
 *            Col E: "Services"        → deepskill_name
 *            Col F..N: option chips  (any non-empty cell = one tbl_deepskill_options row)
 *   Row 3+: data rows.
 *
 * Operating modes
 *   - PREVIEW (default): parse + validate + dry-run resolve. No writes. Returns
 *     per-row report + summary of what *would* be created.
 *   - COMMIT (?commit=true): same parse + validate, then inside a single
 *     transaction insert any missing categories / types / skills / options.
 *
 * Idempotency rules
 *   - Category lookup is case/whitespace-insensitive (LOWER(TRIM(...))).
 *     Categories are NEVER auto-created from a bulk row (2026-06-15): a
 *     row whose category does not already exist is SKIPPED with a clear
 *     reason — we do not create the category, its service type, or the
 *     deep skill. Ops must create categories explicitly via the catalogue
 *     UI before bulk-uploading skills under them.
 *   - Type lookup is case/whitespace-insensitive (LOWER(TRIM(...))). New
 *     types ARE auto-created (only under an already-existing category).
 *   - Skill match key = (category_id, service_type_id, LOWER(TRIM(name))).
 *     A row that already exists → status = "skip" (no duplicate insert).
 *   - Option chips: inserted only if not already present for the skill (case-
 *     insensitive); soft-deleted (status=0) matches are reactivated. After all
 *     chip inserts for a skill, the denormalised `tbl_deep_skill.skill_options`
 *     JSON is refreshed via the existing syncSkillOptionsJson() helper in
 *     deep-skill.service.js. Preview reports the would-merge option count for
 *     existing skills without writing anything.
 *
 * Data-quality quirks observed in the 4 ops sample files
 *   - Electrician Col C is "Electrician Services'" (trailing apostrophe).
 *     We strip trailing punctuation [!@#$%^&*'"`]+$ before the upsert.
 *   - Plumbing row 3 is a literal template-noise row with cells equal to
 *     the schema column names ("service_catg_name" etc.). Detected and
 *     silently skipped.
 *   - Empty E (skill name) cells → silently skipped.
 *   - Missing C or D when E is present → row reports a validation error.
 */

const HEADER_ROW_INDEX = 2;         // 1-based — exceljs row numbers
const FIRST_DATA_ROW   = 3;
const FIRST_OPTION_COL = 6;         // Col F
const SCHEMA_LITERALS  = new Set([
  'service_catg_name', 'service_type_name', 'deepskill_name',
]);

// Loose check — exact header text in the sample files has odd whitespace and
// trailing words; we just verify the keyword anchors are present so a future
// "+1" col rename or whitespace tweak doesn't break the import.
//
// Col B accepts two observed variants (2026-06-06):
//   - "Tag Words to tell technicians when attending the service…"
//     (Electrician, Plumbing, Sports & Fitness — newer ops files)
//   - "Keywords to tell technicians when attending the service"
//     (Carpentry — older file, semantically identical)
// Distinctive shared phrase is "to tell" — absent from every other column
// header, so the alternation can't false-match Col A's "Key words
// Attached to theTechnician who selects the skill" (no "to tell" there).
const HEADER_ANCHORS = [
  /key\s*words?/i,                                // Col A
  /(tag\s*words?|keywords?\s+to\s+tell)/i,        // Col B (two known variants)
  /service\s*categor/i,                           // Col C
  /service\s*type/i,                              // Col D
  /service/i,                                     // Col E ("Services")
];

function normaliseCell(value) {
  if (value === null || value === undefined) return '';
  // exceljs sometimes returns rich-text objects (`{ richText: [{text}…] }`) or
  // formula objects (`{ result, formula }`). Coerce to a plain string.
  let s;
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) {
      s = value.richText.map((rt) => rt.text || '').join('');
    } else if (value.result !== undefined) {
      s = String(value.result);
    } else if (value.text !== undefined) {
      s = String(value.text);
    } else {
      s = String(value);
    }
  } else {
    s = String(value);
  }
  // Strip non-breaking space + regular whitespace from both ends.
  return s.replace(/[ \s]+/g, ' ').trim();
}

function stripTrailingPunctuation(s) {
  return s.replace(/[!@#$%^&*'"`]+$/g, '').trim();
}

function looksLikeSchemaLiteral(s) {
  return SCHEMA_LITERALS.has(s.toLowerCase());
}

function validateHeaderRow(sheet) {
  const headerRow = sheet.getRow(HEADER_ROW_INDEX);
  for (let i = 0; i < HEADER_ANCHORS.length; i++) {
    const cell = normaliseCell(headerRow.getCell(i + 1).value).toLowerCase();
    if (!HEADER_ANCHORS[i].test(cell)) {
      throw Object.assign(
        new Error(
          `Sheet "${sheet.name}" header row ${HEADER_ROW_INDEX} column ${i + 1}: ` +
          `expected text matching ${HEADER_ANCHORS[i]}, got "${cell}"`
        ),
        { status: 400 },
      );
    }
  }
}

/*
 * Read every sheet → flat array of parsed rows.
 * Each parsed row keeps the original 1-based sheet+rowNumber for reporting.
 */
function parseWorkbook(workbook) {
  const parsed = [];
  workbook.eachSheet((sheet) => {
    if (sheet.rowCount < FIRST_DATA_ROW) return; // empty sheet
    validateHeaderRow(sheet);

    for (let r = FIRST_DATA_ROW; r <= sheet.rowCount; r++) {
      const row = sheet.getRow(r);
      const keyWords = normaliseCell(row.getCell(1).value);
      const tagWords = normaliseCell(row.getCell(2).value);
      const category = stripTrailingPunctuation(normaliseCell(row.getCell(3).value));
      const type     = stripTrailingPunctuation(normaliseCell(row.getCell(4).value));
      const skill    = normaliseCell(row.getCell(5).value);

      // Collect options from Col F onward — columnCount is the last used
      // column number, so chips past empty gap columns are still scanned.
      // Dedupe case-insensitively (keep first occurrence's casing) so a row
      // with repeated chips can't double-insert.
      const options  = [];
      const seenOpts = new Set();
      for (let c = FIRST_OPTION_COL; c <= Math.max(sheet.columnCount, FIRST_OPTION_COL); c++) {
        const v = normaliseCell(row.getCell(c).value);
        if (v && !seenOpts.has(v.toLowerCase())) {
          seenOpts.add(v.toLowerCase());
          options.push(v);
        }
      }

      // Blank separator/padding rows (now reachable via the rowCount bound)
      // carry no data — skip without counting them in summary.totalRows.
      if (!keyWords && !tagWords && !category && !type && !skill && options.length === 0) continue;

      parsed.push({
        sheet:     sheet.name,
        rowNumber: r,
        keyWords, tagWords, category, type, skill, options,
      });
    }
  });
  return parsed;
}

/*
 * In-memory caches so a workbook with N rows in the same category does only
 * one DB lookup per distinct name. Keyed by LOWER(TRIM(...)).
 */
function makeResolver() {
  const cats  = new Map();  // catNameLC      → { id, name, isNew }
  const types = new Map();  // `${catId}::typeNameLC` → { id, name, catId, isNew }
  return { cats, types };
}

/*
 * Bulk category resolver (2026-06-15): EXISTING-ONLY.
 *
 * Unlike the single-add resolveCategoryByName() in deep-skill.service.js,
 * the bulk path NEVER creates a category. A row referencing a category that
 * doesn't already exist (case/whitespace-insensitive, not soft-deleted) is
 * skipped by the caller with a clear reason — see the category-existence
 * gate in the main loop. Returns `{ id, name }` on a hit, or `null` when no
 * canonical match exists. Cached by LOWER(TRIM(name)); a miss caches `null`
 * so repeat rows for the same bad name don't re-query.
 */
async function resolveExistingCategory(conn, cache, name) {
  const lc = name.toLowerCase();
  if (cache.cats.has(lc)) return cache.cats.get(lc);

  const [[row]] = await conn.query(
    `SELECT service_catg_id, service_catg_name
       FROM tbl_service_catg
      WHERE LOWER(TRIM(service_catg_name)) = LOWER(TRIM(?))
        AND service_catg_status <> 3
      LIMIT 1`,
    [name],
  );
  if (row) {
    // 2026-06-10: audit log so ops can spot reuse patterns post-bulk-upload.
    logger.info(
      `deep-skill: matched existing service_catg_id=${row.service_catg_id} for name="${name}" (case-insensitive)`,
    );
    const out = { id: row.service_catg_id, name: row.service_catg_name };
    cache.cats.set(lc, out);
    return out;
  }

  // No match — cache the miss so the same bad name short-circuits.
  cache.cats.set(lc, null);
  return null;
}

async function resolveType(conn, cache, catId, name, { create }) {
  // catId can be null in preview mode (when the category itself is new) —
  // use a sentinel so we don't collide with real categories.
  const catKey = catId == null ? `NEW:${name.toLowerCase()}` : String(catId);
  const lc = `${catKey}::${name.toLowerCase()}`;
  if (cache.types.has(lc)) return cache.types.get(lc);

  if (catId != null) {
    const [[row]] = await conn.query(
      `SELECT service_type_id, service_type_name
         FROM tbl_service_type
        WHERE LOWER(TRIM(service_type_name)) = LOWER(TRIM(?))
          AND service_catg_id = ?
          AND service_type_status <> 3
        LIMIT 1`,
      [name, catId],
    );
    if (row) {
      // 2026-06-10: audit log so ops can spot reuse vs. fresh-create.
      logger.info(
        `deep-skill: matched existing service_type_id=${row.service_type_id} for name="${name}" (case-insensitive, catg=${catId})`,
      );
      const out = { id: row.service_type_id, name: row.service_type_name, catId, isNew: false };
      cache.types.set(lc, out);
      return out;
    }
  }

  if (!create || catId == null) {
    const out = { id: null, name, catId, isNew: true };
    cache.types.set(lc, out);
    return out;
  }

  const [ins] = await conn.query(
    `INSERT INTO tbl_service_type
       (service_type_name, service_catg_id, display, service_type_status)
     VALUES (?, ?, 1, 1)`,
    [name, catId],
  );
  const out = { id: ins.insertId, name, catId, isNew: true };
  cache.types.set(lc, out);
  return out;
}

async function findExistingSkill(conn, catId, typeId, skillName) {
  if (catId == null || typeId == null) return null;
  const [[row]] = await conn.query(
    `SELECT deepskill_id
       FROM tbl_deep_skill
      WHERE category_id = ?
        AND service_type_id = ?
        AND LOWER(TRIM(deepskill_name)) = LOWER(TRIM(?))
      LIMIT 1`,
    [catId, typeId, skillName],
  );
  return row ? row.deepskill_id : null;
}

async function listExistingOptions(conn, deepskillId) {
  // Map keyed by lowercase name → { id, status } so the merge loop can
  // reactivate soft-deleted (status=0) matches instead of skipping them.
  const [rows] = await conn.query(
    `SELECT id, skill_option, status FROM tbl_deepskill_options
      WHERE deepskill_id = ?`,
    [deepskillId],
  );
  return new Map(rows.map((r) => [r.skill_option.toLowerCase(), { id: r.id, status: Number(r.status) }]));
}

async function syncSkillOptionsJsonInTxn(conn, deepskillId) {
  // Mirror of services/deep-skill.service.js::syncSkillOptionsJson — re-implemented
  // here so we run inside the same transaction connection rather than the pool.
  const [rows] = await conn.query(
    `SELECT skill_option FROM tbl_deepskill_options
      WHERE deepskill_id = ? AND status = 1 ORDER BY id`,
    [deepskillId],
  );
  const json = JSON.stringify(rows.map((r) => r.skill_option));
  await conn.query(
    `UPDATE tbl_deep_skill SET skill_options = ? WHERE deepskill_id = ?`,
    [json, deepskillId],
  );
}

/*
 * Main entry — buffer comes straight from multer (memoryStorage). The endpoint
 * is responsible for HTTP plumbing; this returns a plain JSON-shaped object.
 *
 * `commit` flag controls whether we actually write. Single transaction wraps
 * the whole batch so a failure halfway leaves the catalogue untouched.
 */
async function processBuffer(buffer, { commit = false, actor = null } = {}) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch (e) {
    const err = new Error(`Failed to parse .xlsx: ${e.message}`);
    err.status = 400;
    throw err;
  }

  const rows = parseWorkbook(workbook);

  const conn = await pool.getConnection();
  let inTxn = false;
  try {
    if (commit) {
      await conn.beginTransaction();
      inTxn = true;
    }

    const cache = makeResolver();
    const report = [];
    const created = {
      categoriesNew: new Set(),
      typesNew:      new Set(),
      skillsCreated: 0,
      optionsCreated: 0,
      committedCategories: [], // [{id,name}]
      committedTypes:      [], // [{id,name,catId}]
    };

    for (const r of rows) {
      const base = {
        sheet:     r.sheet,
        rowNumber: r.rowNumber,
        category:  r.category,
        type:      r.type,
        skill:     r.skill,
        options:   r.options,
        tagWords:  r.tagWords,
      };

      // A row with no skill name (column E "Services" empty) cannot create a
      // deep skill — but REPORT it as a skip-with-reason rather than dropping
      // it silently, so the per-row report reconciles to the full sheet. (E.g.
      // a Service Type row like "Welding Work" with no Services/skill name:
      // the operator must see why it produced no skill.)
      if (!r.skill) {
        report.push({
          ...base,
          status: 'skip',
          errors: ['No Skill Name (Column E "Services" is empty)'],
        });
        continue;
      }
      // ── silent skips ──
      if (looksLikeSchemaLiteral(r.category) ||
          looksLikeSchemaLiteral(r.type) ||
          looksLikeSchemaLiteral(r.skill)) {
        report.push({ ...base, status: 'skip', errors: ['template placeholder row'] });
        continue;
      }

      const errs = [];
      if (!r.category) errs.push('category not provided');
      if (!r.type)     errs.push('service type not provided');
      if (errs.length) {
        report.push({ ...base, status: 'error', errors: errs });
        continue;
      }

      // Category-existence gate (2026-06-15). Bulk upload NEVER creates a
      // category. A row whose category doesn't already exist is SKIPPED —
      // we don't create the category, its service type, or the deep skill.
      const cat = await resolveExistingCategory(conn, cache, r.category);
      if (!cat) {
        report.push({
          ...base,
          status: 'error',
          errors: [`Category does not exist: "${r.category}"`],
        });
        continue;
      }

      // Resolve / create service type (only under the existing category).
      const typ = await resolveType(conn, cache, cat.id, r.type, { create: commit });
      if (typ.isNew) {
        const tKey = `${cat.name.toLowerCase()}::${typ.name.toLowerCase()}`;
        if (!created.typesNew.has(tKey)) {
          created.typesNew.add(tKey);
          if (commit) created.committedTypes.push({ id: typ.id, name: typ.name, catId: cat.id });
        }
      }

      // Skill existence check — only meaningful when both parents resolved.
      const existingSkillId = await findExistingSkill(conn, cat.id, typ.id, r.skill);
      if (existingSkillId) {
        // Even an existing skill may be missing some option chips — merge.
        // The would-merge count is computed in BOTH modes so the preview
        // report matches what a commit would do; writes are commit-only.
        let optionsInsertedHere = 0;
        if (r.options.length) {
          const have = await listExistingOptions(conn, existingSkillId); // read-only SELECT, safe in preview
          for (const opt of r.options) {
            const hit = have.get(opt.toLowerCase());
            if (hit && hit.status === 1) {
              if (commit) {
                // 2026-06-10: audit log so ops can spot option reuse.
                logger.info(
                  `deep-skill: matched existing skill_option name="${opt}" (case-insensitive, skill=${existingSkillId})`,
                );
              }
              continue;
            }
            if (hit && hit.status === 0) {
              // Soft-deleted match — reactivate instead of skipping, mirroring
              // resolveSkillOptionByName() in deep-skill.service.js.
              if (commit) {
                await conn.query(
                  `UPDATE tbl_deepskill_options SET status = 1 WHERE id = ?`,
                  [hit.id],
                );
                logger.info(
                  `deep-skill: reactivated soft-deleted skill_option name="${opt}" (skill=${existingSkillId})`,
                );
              }
              hit.status = 1;
              optionsInsertedHere++;
              created.optionsCreated++;
              continue;
            }
            if (commit) {
              await conn.query(
                `INSERT INTO tbl_deepskill_options (deepskill_id, skill_option, status)
                 VALUES (?, ?, 1)`,
                [existingSkillId, opt],
              );
            }
            have.set(opt.toLowerCase(), { id: null, status: 1 });
            optionsInsertedHere++;
            created.optionsCreated++;
          }
          if (commit && optionsInsertedHere > 0) await syncSkillOptionsJsonInTxn(conn, existingSkillId);
        }
        report.push({
          ...base,
          status: 'skip',
          errors: optionsInsertedHere
            ? [commit
                ? `skill already exists — merged ${optionsInsertedHere} new option(s)`
                : `skill already exists — would merge ${optionsInsertedHere} new option(s)`]
            : ['skill already exists'],
        });
        continue;
      }

      // New skill path.
      if (commit) {
        const [ins] = await conn.query(
          `INSERT INTO tbl_deep_skill
             (category_id, service_type_id, deepskill_name, deepskill_description,
              deepskill_tag_words, status, inserted_by, inserted_on,
              deepskill_image, skill_options)
           VALUES (?, ?, ?, ?, ?, 1, ?, NOW(), '', '[]')`,
          [
            cat.id, typ.id, r.skill,
            r.keyWords || null,
            r.tagWords || null,
            actor?.user_id || null,
          ],
        );
        const newSkillId = ins.insertId;
        created.skillsCreated++;

        for (const opt of r.options) {
          await conn.query(
            `INSERT INTO tbl_deepskill_options (deepskill_id, skill_option, status)
             VALUES (?, ?, 1)`,
            [newSkillId, opt],
          );
          created.optionsCreated++;
        }
        if (r.options.length) await syncSkillOptionsJsonInTxn(conn, newSkillId);
      } else {
        // Preview — still count what would be created.
        created.skillsCreated++;
        created.optionsCreated += r.options.length;
      }

      report.push({ ...base, status: 'ok', errors: [] });
    }

    if (inTxn) {
      await conn.commit();
      inTxn = false;
      // invalidate the 24h getAllDeepSkillImages cache — image just changed
      // (called ONCE at end of bulk commit; partial-success still invalidates
      //  since over-invalidation is safer than serving stale entries)
      deepSkillService.invalidateAllDeepSkillImagesCache();
    }

    const summary = {
      totalRows:     rows.length,
      willCreate:    report.filter((x) => x.status === 'ok').length,
      willSkip:      report.filter((x) => x.status === 'skip').length,
      errors:        report.filter((x) => x.status === 'error').length,
      categoriesNew: created.categoriesNew.size,
      typesNew:      created.typesNew.size,
      skillsNew:     created.skillsCreated,
      optionsNew:    created.optionsCreated,
    };

    const result = {
      mode: commit ? 'commit' : 'preview',
      summary,
      rows: report,
    };
    if (commit) {
      result.committed = {
        categoriesCreated: created.committedCategories,
        typesCreated:      created.committedTypes,
        skillsCreated:     created.skillsCreated,
        optionsCreated:    created.optionsCreated,
      };
    }
    return result;
  } catch (e) {
    if (inTxn) {
      try { await conn.rollback(); } catch (rbErr) {
        logger.error({ err: rbErr }, 'deep-skill bulk: rollback failed');
      }
    }
    throw e;
  } finally {
    conn.release();
  }
}

module.exports = { processBuffer };
