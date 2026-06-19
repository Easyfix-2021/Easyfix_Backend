#!/usr/bin/env node
/*
 * upload-deepskill-images.js — one-time (re-runnable) bulk loader for deep-skill
 * images from a local folder (downloaded from the SharePoint "Deepskill image"
 * folder) → S3 + the legacy AWS server, with DB rename.
 * ---------------------------------------------------------------------------
 * WHAT IT DOES, per image file in --dir:
 *   1. MATCH it to a tbl_deep_skill row by normalised name (filename minus
 *      extension, lowercased, non-alphanumerics stripped) — i.e. identifies the
 *      deep skill from the (prod) DB the .env points at.
 *   2. RENAME → the canonical key s3Storage.keyForSkill(id, seq) =
 *      `Skills/Skill_<deepskill_id>_<seq>` (seq = next after any existing key,
 *      else 1). The original filename is preserved in S3 object metadata.
 *   3. UPLOAD the bytes to S3 (bucket S3_BUCKET_NAME) via the SAME helper the
 *      app's image-gen uses (s3Storage.putSkillImage).
 *   4. WRITE a canonically-named copy into --out/Skills/ so you can rsync/scp it
 *      to the legacy AWS server (Legacy CRM reads tbl_deep_skill.deepskill_image
 *      off the shared DB; the file must exist on its disk too).
 *   5. UPDATE tbl_deep_skill.deepskill_image = the key (the DB rename).
 *
 * SAFETY: dry-run is the DEFAULT — it matches + prints the plan + writes a
 * mapping CSV, but makes NO S3 writes, NO DB writes, NO file copies. Re-run with
 * --run to execute. Rows that already have a deepskill_image are SKIPPED unless
 * --overwrite (which bumps the seq so the key changes and presigned reads bust).
 *
 * Targets the DB in .env — point it at PROD to identify+update prod deep skills.
 *
 * USAGE:
 *   node scripts/upload-deepskill-images.js --dir ./deepskill-images           # DRY RUN
 *   node scripts/upload-deepskill-images.js --dir ./deepskill-images --run     # execute
 *   node scripts/upload-deepskill-images.js --dir ./img --run --overwrite      # replace existing
 *   node scripts/upload-deepskill-images.js --dir ./img --map fixups.csv --run # manual overrides
 *
 * FLAGS:
 *   --dir D        folder of source images (required)
 *   --out D        where to write canonically-renamed copies for the legacy
 *                  server (default ./deepskill-renamed). Files land in D/Skills/.
 *   --run          actually upload to S3 + update the DB + write renamed copies
 *   --overwrite    re-upload for rows that already have an image (bumps seq)
 *   --pick-first   resolve ambiguous name matches by lowest deepskill_id
 *   --keep-ext     name the legacy-copy files WITH their extension
 *                  (default: no extension, matching the S3 key exactly)
 *   --map F.csv    manual overrides: lines `filename,deepskill_id` (header ok)
 *
 * Uses Pino `logger`, never console.log.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const { pool, closePool } = require('../db');
const logger = require('../logger');
const s3Storage = require('../utils/s3-storage');

const EXT_CT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.bmp': 'image/bmp',
};

function parseArgs(argv) {
  const o = { dir: null, out: './deepskill-renamed', run: false, overwrite: false, pickFirst: false, keepExt: false, map: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run') o.run = true;
    else if (a === '--overwrite') o.overwrite = true;
    else if (a === '--pick-first') o.pickFirst = true;
    else if (a === '--keep-ext') o.keepExt = true;
    else if (a === '--dir') o.dir = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--map') o.map = argv[++i];
    else if (a.startsWith('--dir=')) o.dir = a.slice(6);
    else if (a.startsWith('--out=')) o.out = a.slice(6);
    else if (a.startsWith('--map=')) o.map = a.slice(6);
  }
  return o;
}

// filename/skill-name → comparable key: drop extension, lowercase, strip every
// non-alphanumeric (spaces, _, -, &, parens …). Mirrors the curation normaliser
// used for the city/pincode reconciliations.
function norm(s) {
  return String(s || '').toLowerCase().replace(/\.[a-z0-9]+$/i, '').replace(/[^a-z0-9]+/g, '');
}

function nextSeq(existingKey) {
  const m = String(existingKey || '').match(/_(\d+)$/);
  return m ? Number(m[1]) + 1 : 1;
}

function loadManualMap(file) {
  const m = new Map(); // normalised filename → deepskill_id
  if (!file) return m;
  const txt = fs.readFileSync(file, 'utf8');
  for (const line of txt.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const [fn, id] = t.split(',').map((x) => x && x.trim());
    if (!fn || !id || !/^\d+$/.test(id)) continue; // skips header / blanks
    m.set(norm(fn), Number(id));
  }
  return m;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.dir) { logger.error('Missing --dir <folder of images>. See header for usage.'); process.exitCode = 1; return; }
  if (!fs.existsSync(opts.dir)) { logger.error(`--dir not found: ${opts.dir}`); process.exitCode = 1; return; }
  if (opts.run && !s3Storage.isEnabled()) { logger.error('S3 not configured (S3_BUCKET_NAME unset) — cannot --run.'); process.exitCode = 1; return; }

  // ── Source images ───────────────────────────────────────────────────────
  const files = fs.readdirSync(opts.dir)
    .filter((f) => EXT_CT[path.extname(f).toLowerCase()])
    .sort();
  if (files.length === 0) { logger.error(`No image files in ${opts.dir}`); process.exitCode = 1; return; }

  // ── Deep skills from the DB the .env points at ──────────────────────────
  const [skills] = await pool.query(
    'SELECT deepskill_id, deepskill_name, deepskill_image, status FROM tbl_deep_skill',
  );
  const byName = new Map(); // normName → [rows]
  for (const r of skills) {
    const k = norm(r.deepskill_name);
    if (!k) continue;
    (byName.get(k) || byName.set(k, []).get(k)).push(r);
  }
  const byId = new Map(skills.map((r) => [Number(r.deepskill_id), r]));
  const manual = loadManualMap(opts.map);

  logger.info(
    { images: files.length, deepSkills: skills.length, db: process.env.DB_NAME, host: process.env.DB_HOST, mode: opts.run ? 'RUN' : 'DRY-RUN' },
    `deep-skill image upload — ${files.length} file(s) vs ${skills.length} deep skill(s)`,
  );

  const matched = []; // { file, skill, key, seq, contentType }
  const ambiguous = [];
  const unmatched = [];
  const skipped = [];

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    const nf = norm(file);

    // resolve target skill: manual override wins, else unique normalised-name match
    let skill = null;
    if (manual.has(nf)) {
      skill = byId.get(manual.get(nf)) || null;
      if (!skill) { unmatched.push({ file, reason: `--map id ${manual.get(nf)} not in tbl_deep_skill` }); continue; }
    } else {
      const rows = byName.get(nf) || [];
      if (rows.length === 0) { unmatched.push({ file, reason: 'no deep skill with this name' }); continue; }
      if (rows.length > 1) {
        if (!opts.pickFirst) { ambiguous.push({ file, ids: rows.map((r) => r.deepskill_id) }); continue; }
        rows.sort((a, b) => a.deepskill_id - b.deepskill_id);
        skill = rows[0];
      } else {
        skill = rows[0];
      }
    }

    if (skill.deepskill_image && String(skill.deepskill_image).trim() && !opts.overwrite) {
      skipped.push({ file, id: skill.deepskill_id, existing: skill.deepskill_image });
      continue;
    }
    const seq = opts.overwrite ? nextSeq(skill.deepskill_image) : 1;
    matched.push({ file, skill, seq, key: s3Storage.keyForSkill(skill.deepskill_id, seq), contentType: EXT_CT[ext] });
  }

  // ── Report (always) ──────────────────────────────────────────────────────
  fs.mkdirSync(opts.out, { recursive: true });
  const csvLines = ['file,deepskill_id,deepskill_name,key,action'];
  for (const m of matched) csvLines.push(`"${m.file}",${m.skill.deepskill_id},"${String(m.skill.deepskill_name).replace(/"/g, '""')}",${m.key},upload`);
  for (const a of ambiguous) csvLines.push(`"${a.file}",,,"AMBIGUOUS ids=${a.ids.join('|')}",skip`);
  for (const u of unmatched) csvLines.push(`"${u.file}",,,"${u.reason}",skip`);
  for (const s of skipped) csvLines.push(`"${s.file}",${s.id},,${s.existing},already-has-image`);
  const reportPath = path.join(opts.out, 'deepskill-image-mapping.csv');
  fs.writeFileSync(reportPath, csvLines.join('\n'));

  logger.info(
    { matched: matched.length, ambiguous: ambiguous.length, unmatched: unmatched.length, skipped: skipped.length, report: reportPath },
    `mapping: ${matched.length} to upload · ${ambiguous.length} ambiguous · ${unmatched.length} unmatched · ${skipped.length} already-have-image`,
  );

  if (!opts.run) {
    logger.info('DRY RUN — no S3/DB writes. Review the mapping CSV, then re-run with --run. '
      + 'Resolve ambiguous/unmatched via a --map filename,deepskill_id CSV.');
    return;
  }

  // ── Execute ──────────────────────────────────────────────────────────────
  const legacyDir = path.join(opts.out, 'Skills');
  fs.mkdirSync(legacyDir, { recursive: true });
  let ok = 0; let fail = 0;
  for (const m of matched) {
    try {
      const buffer = fs.readFileSync(path.join(opts.dir, m.file));
      // 1. S3
      await s3Storage.putSkillImage({
        skillId: m.skill.deepskill_id, seq: m.seq, buffer,
        contentType: m.contentType, originalName: m.file,
      });
      // 2. Legacy-server copy (canonical name; rsync this folder to the legacy box)
      const base = `Skill_${m.skill.deepskill_id}_${m.seq}`;
      fs.writeFileSync(path.join(legacyDir, opts.keepExt ? base + path.extname(m.file).toLowerCase() : base), buffer);
      // 3. DB rename
      await pool.query('UPDATE tbl_deep_skill SET deepskill_image = ? WHERE deepskill_id = ?', [m.key, m.skill.deepskill_id]);
      ok++;
    } catch (e) {
      fail++;
      logger.warn({ file: m.file, id: m.skill.deepskill_id, err: e.message }, 'deep-skill image upload failed for this file');
    }
  }
  logger.info({ uploaded: ok, failed: fail, legacyDir }, `done — ${ok} uploaded+updated, ${fail} failed. rsync ${legacyDir}/ to the legacy server's deep-skill image root.`);
}

main()
  .then(async () => { await closePool(); process.exit(process.exitCode || 0); })
  .catch(async (err) => {
    logger.error({ code: err.code, msg: err.message }, 'deep-skill image upload failed');
    try { await closePool(); } catch (_) { /* already closing */ }
    process.exit(1);
  });
