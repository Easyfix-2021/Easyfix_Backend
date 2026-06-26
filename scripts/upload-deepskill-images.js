#!/usr/bin/env node
/*
 * upload-deepskill-images.js
 * ──────────────────────────────────────────────────────────────────────────
 * Bulk-publish deep-skill images: match local image files to tbl_deep_skill
 * rows by name, upload the matched copies to S3, and update each row's
 * `deepskill_image` column to point at the uploaded object.
 *
 * It is deliberately a TWO-PHASE tool:
 *
 *   DRY RUN (default — no --run flag)
 *     - Reads the image folder + the deep-skill rows from the DB pointed at
 *       by .env. Matches each image to a deepskill_id by name (fuzzy).
 *     - Writes a review report:  deepskill-renamed/deepskill-image-mapping.csv
 *     - Uploads NOTHING. Touches NO database rows. 100% read-only.
 *
 *   REAL RUN (--run)
 *     - Re-does the match (applying any --map fixups.csv overrides), then for
 *       every MATCHED image:
 *         1. writes a canonical renamed copy under deepskill-renamed/Skills/
 *            (this is what step 5's rsync ships to the legacy server)
 *         2. uploads it to s3://<S3_BUCKET_NAME>/<S3_PREFIX>/<id>_<slug>
 *         3. UPDATE tbl_deep_skill SET deepskill_image = <key> WHERE deepskill_id = <id>
 *
 * ⚠️  The DB + bucket are whatever .env says. Point .env at PROD only when you
 *     mean to update PROD. The banner below prints the live target every run.
 *
 * Usage:
 *   node scripts/upload-deepskill-images.js --dir ./deepskill-images
 *   node scripts/upload-deepskill-images.js --dir ./deepskill-images --map fixups.csv --run
 *
 * Flags:
 *   --dir  <path>   (required) root folder to scan recursively for images
 *   --map  <path>   (optional) fixups CSV with header `filename,deepskill_id`
 *                   — forces a specific match for the named file (basename),
 *                     overriding/resolving fuzzy or ambiguous results
 *   --run           actually upload + update the DB (omit = dry run)
 *   --threshold <n> fuzzy-match acceptance score 0..1 (default 0.86)
 */

require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pool, closePool } = require('../db');

// ─── Config (review before a PROD --run) ────────────────────────────────────
const S3_PREFIX = 'DeepSkills';          // bucket prefix for deepskill images
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const CONTENT_TYPE = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif',
};
const OUT_DIR = path.resolve('deepskill-renamed');
const CSV_PATH = path.join(OUT_DIR, 'deepskill-image-mapping.csv');
const SKILLS_DIR = path.join(OUT_DIR, 'Skills');

// ─── Arg parsing ────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { dir: null, map: null, run: false, threshold: 0.86 };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--dir') a.dir = argv[++i];
    else if (t === '--map') a.map = argv[++i];
    else if (t === '--run') a.run = true;
    else if (t === '--threshold') a.threshold = Number(argv[++i]);
    else throw new Error(`unknown argument: ${t}`);
  }
  if (!a.dir) throw new Error('missing required --dir <path>');
  if (!Number.isFinite(a.threshold) || a.threshold <= 0 || a.threshold > 1) {
    throw new Error('--threshold must be between 0 and 1');
  }
  return a;
}

// ─── Name normalisation + fuzzy match ───────────────────────────────────────
// Lowercase, drop extension/dup markers, &→and, strip punctuation, collapse ws.
function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, '')      // trailing extension if present
    .replace(/\(\d+\)\s*$/, '')        // "name (1)" duplicate markers
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')       // punctuation/underscores → space
    .replace(/\s+/g, ' ')
    .trim();
}

function slugify(s) {
  return normalize(s).replace(/\s+/g, '-');
}

// Trailing "action" words that distinguish images of the SAME skill
// (Installation / Repair / …). We only ever strip these AFTER a full-name
// match has failed, so legit skills that genuinely end in an action word
// (e.g. "Door Installation", "Wardrobe installation") still match on the full
// name first and are never over-stripped.
const ACTION_WORDS = new Set([
  'installation', 'instalation', 'install', 'installing',
  'uninstallation', 'unistallation', 'uninstall', 'uninstall-',
  'repair', 'repairing', 'repairs',
  'servicing', 'service', 'serviced',
  'cleaning', 'clean',
  'replacement', 'replace',
  'demo', 'fitment',
]);

// Drop trailing action tokens (one or more) from a normalized name.
// Never strips the last remaining token, so a name that is ONLY an action
// word survives intact.
function stripActions(name) {
  const toks = normalize(name).split(' ').filter(Boolean);
  while (toks.length > 1 && ACTION_WORDS.has(toks[toks.length - 1])) toks.pop();
  return toks.join(' ');
}

// Classic Levenshtein distance (iterative, O(n*m) — fine at this scale).
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[b.length];
}

// Similarity in [0,1]; 1 = identical normalized strings.
function similarity(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const dist = levenshtein(na, nb);
  return 1 - dist / Math.max(na.length, nb.length);
}

// ─── Filesystem walk ────────────────────────────────────────────────────────
function walkImages(root) {
  const out = [];
  (function recur(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) recur(full);
      else if (ent.isFile() && IMAGE_EXTS.has(path.extname(ent.name).toLowerCase())) {
        out.push(full);
      }
    }
  })(root);
  return out;
}

function loadFixups(mapPath) {
  // Map basename(filename) → deepskill_id. Tolerates a header row and quotes.
  const fixups = new Map();
  if (!mapPath) return fixups;
  const raw = fs.readFileSync(mapPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
    const [file, idStr] = cells;
    if (!file || file.toLowerCase() === 'filename') continue; // header / blank
    const id = Number(idStr);
    if (!Number.isInteger(id) || id <= 0) continue;
    fixups.set(path.basename(file), id);
  }
  return fixups;
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ─── Main ───────────────────────────────────────────────────────────────────
(async () => {
  const args = parseArgs(process.argv);
  const imageRoot = path.resolve(args.dir);
  if (!fs.existsSync(imageRoot)) throw new Error(`--dir not found: ${imageRoot}`);

  const [[{ db }]] = await pool.query('SELECT DATABASE() AS db');
  const bucket = process.env.S3_BUCKET_NAME || '(unset)';
  console.log('═'.repeat(72));
  console.log(`  MODE     : ${args.run ? '🔴 REAL RUN (will upload + update DB)' : '🟢 DRY RUN (read-only)'}`);
  console.log(`  DB       : ${db} @ ${process.env.DB_HOST}`);
  console.log(`  S3 bucket: ${bucket}   prefix: ${S3_PREFIX}/`);
  console.log(`  Images   : ${imageRoot}`);
  console.log(`  Fixups   : ${args.map ? path.resolve(args.map) : '(none)'}`);
  console.log('═'.repeat(72));

  // 1. Load deep-skill rows (the match targets).
  const [skills] = await pool.query(
    `SELECT deepskill_id, deepskill_name, categoryName, deepskill_image
       FROM tbl_deep_skill`,
  );
  console.log(`Loaded ${skills.length} deep-skill rows; scanning images…`);
  if (skills.length === 0) {
    console.warn('⚠️  No deep-skill rows in this DB — every image will be UNMATCHED.');
  }

  // Index by normalized name for fast exact lookup.
  const byNorm = new Map();
  for (const s of skills) {
    const k = normalize(s.deepskill_name);
    if (!byNorm.has(k)) byNorm.set(k, []);
    byNorm.get(k).push(s);
  }

  // Helpers closing over `skills` / `byNorm`.
  function bestExact(name) {
    const arr = byNorm.get(normalize(name));
    if (!arr) return { skill: null, multi: false };
    if (arr.length === 1) return { skill: arr[0], multi: false };
    return { skill: null, multi: true };          // same name on >1 skill
  }
  function bestFuzzy(name) {
    let best = null; let bestScore = 0;
    for (const s of skills) {
      const sc = similarity(name, s.deepskill_name);
      if (sc > bestScore) { bestScore = sc; best = s; }
    }
    return { skill: best, score: bestScore };
  }
  // Staged match: full-name first (exact → fuzzy), then action-stripped stem
  // (exact → fuzzy). Full always wins, so "Wardrobe installation" matches its
  // own row before we'd ever strip "installation".
  function matchName(derived) {
    const ex = bestExact(derived);
    if (ex.skill) return { skill: ex.skill, type: 'exact', score: 1 };
    if (ex.multi) return { skill: null, type: 'ambiguous', score: 1 };

    const fz = bestFuzzy(derived);
    if (fz.skill && fz.score >= args.threshold) return { skill: fz.skill, type: 'fuzzy', score: fz.score };

    const stem = stripActions(derived);
    if (stem && stem !== normalize(derived)) {
      const exs = bestExact(stem);
      if (exs.skill) return { skill: exs.skill, type: 'stem-exact', score: 0.99 };
      if (exs.multi) return { skill: null, type: 'ambiguous', score: 0.99 };
      const fzs = bestFuzzy(stem);
      if (fzs.skill && fzs.score >= args.threshold) return { skill: fzs.skill, type: 'stem-fuzzy', score: fzs.score };
    }
    return { skill: null, type: 'unmatched', score: 0 };
  }

  // 2. Match each image. Sort first so "prefer first" is deterministic
  //    (alphabetical by relative path) when several images hit one skill.
  const images = walkImages(imageRoot).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const fixups = loadFixups(args.map);

  const rows = [];
  for (const file of images) {
    const rel = path.relative(imageRoot, file);
    const parts = rel.split(path.sep);
    const trade = parts.length > 1 ? parts[1] : '';   // parts[0] = "Deepskill image"
    const base = path.basename(file);
    const derived = path.basename(file, path.extname(file));

    let matchType; let score; let skill;
    if (fixups.has(base)) {
      const id = fixups.get(base);
      skill = skills.find((s) => s.deepskill_id === id) || null;
      matchType = skill ? 'fixup' : 'unmatched';
      score = skill ? 1 : 0;
    } else {
      const m = matchName(derived);
      skill = m.skill; matchType = m.type; score = m.score;
    }

    rows.push({
      source: rel,
      filename: base,
      trade,
      derived_name: derived,
      match_type: matchType,
      score: Number(score).toFixed(3),
      deepskill_id: skill ? skill.deepskill_id : '',
      deepskill_name: skill ? skill.deepskill_name : '',
      canonical: skill ? `${skill.deepskill_id}_${slugify(skill.deepskill_name)}${path.extname(file)}` : '',
      _abspath: file,
      _ext: path.extname(file).toLowerCase(),
      _skill: skill,
      _winner: false,
    });
  }

  // 2b. One image per skill — keep the FIRST matched file for each
  //     deepskill_id; demote the rest to "duplicate" (won't upload).
  const claimed = new Set();
  for (const r of rows) {
    if (!r._skill) continue;
    if (claimed.has(r._skill.deepskill_id)) { r.match_type = 'duplicate'; }
    else { claimed.add(r._skill.deepskill_id); r._winner = true; }
  }

  // Tally from final state.
  const tally = { exact: 0, fuzzy: 0, 'stem-exact': 0, 'stem-fuzzy': 0, fixup: 0, ambiguous: 0, duplicate: 0, unmatched: 0 };
  for (const r of rows) tally[r.match_type] = (tally[r.match_type] || 0) + 1;

  // 3. Write the review CSV (always).
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const header = ['source', 'filename', 'trade', 'derived_name', 'match_type', 'score', 'deepskill_id', 'deepskill_name', 'canonical'];
  const csv = [header.join(',')]
    .concat(rows.map((r) => header.map((h) => csvCell(r[h])).join(',')))
    .join('\n');
  fs.writeFileSync(CSV_PATH, csv, 'utf8');

  const willUpload = rows.filter((r) => r._skill && r._winner);
  console.log('\n── Match summary ───────────────────────────');
  console.log(`  exact      : ${tally.exact}`);
  console.log(`  fuzzy      : ${tally.fuzzy}   (review in CSV)`);
  console.log(`  stem-exact : ${tally['stem-exact']}   (action suffix stripped)`);
  console.log(`  stem-fuzzy : ${tally['stem-fuzzy']}   (stripped + fuzzy → review in CSV)`);
  console.log(`  fixup      : ${tally.fixup}`);
  console.log(`  ambiguous  : ${tally.ambiguous}  (same name on >1 skill → add to fixups.csv)`);
  console.log(`  duplicate  : ${tally.duplicate}  (skill already has a chosen image → skipped)`);
  console.log(`  unmatched  : ${tally.unmatched}  (option-level / no row → add to fixups.csv if needed)`);
  console.log(`  ─────────────────────────────────────────`);
  console.log(`  TOTAL      : ${rows.length} images`);
  console.log(`  → will set images on ${willUpload.length} of ${skills.length} deep-skill rows`);
  console.log(`\n📄 Mapping written: ${CSV_PATH}`);

  const matched = willUpload;

  if (!args.run) {
    console.log('\n🟢 DRY RUN complete — nothing uploaded, no DB rows changed.');
    console.log('   Review the CSV, resolve ambiguous/unmatched in fixups.csv');
    console.log('   (columns: filename,deepskill_id), then re-run with --map fixups.csv --run');
    await closePool();
    return;
  }

  // ── REAL RUN ──────────────────────────────────────────────────────────────
  if (matched.length === 0) {
    console.log('\n🔴 REAL RUN: 0 matched images — nothing to do.');
    await closePool();
    return;
  }
  if (bucket === '(unset)') throw new Error('S3_BUCKET_NAME is unset — cannot upload. Set it in .env first.');

  const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
  const s3 = new S3Client({ region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'ap-south-1' });

  fs.mkdirSync(SKILLS_DIR, { recursive: true });
  console.log(`\n🔴 REAL RUN: ${matched.length} images → S3 (new backend) + disk-copy staging + DB…`);

  // "BOTH must work" storage model:
  //   - deepskill_image = the BARE FILENAME  (e.g. 1002_metal-chair.png)
  //       → dashboard API serves <host>/easydoc/easyfixer_documents/<filename>
  //   - the same file is copied to deepskill-renamed/Skills/  (scp → server disk
  //       at /var/www/html/easydoc/easyfixer_documents/)
  //   - and uploaded to S3 at DeepSkills/<filename>  (extension kept so the
  //       new-backend resolver can find it by the stored filename and serve a
  //       presigned URL; falls back to the /easydoc disk URL otherwise)
  let ok = 0; const failures = [];
  for (const r of matched) {
    const filename = r.canonical;                 // <id>_<slug>.<ext>
    const key = `${S3_PREFIX}/${filename}`;        // extension kept on purpose
    try {
      const buffer = fs.readFileSync(r._abspath);
      // 1. canonical renamed copy → scp this folder to the server disk
      fs.copyFileSync(r._abspath, path.join(SKILLS_DIR, filename));
      // 2. upload to S3 for the new backend
      const safeName = path.basename(r._abspath).replace(/[^\x20-\x7E]/g, '_').slice(0, 200);
      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: buffer,
        ContentType: CONTENT_TYPE[r._ext] || 'application/octet-stream',
        Metadata: { 'original-filename': safeName },
      }));
      // 3. store the BARE FILENAME (works for both consumers)
      await pool.query('UPDATE tbl_deep_skill SET deepskill_image = ? WHERE deepskill_id = ?',
        [filename, r._skill.deepskill_id]);
      ok += 1;
    } catch (e) {
      failures.push({ file: r.filename, id: r._skill.deepskill_id, err: e.message });
    }
  }

  console.log(`\n✅ Uploaded to S3 + DB updated (bare filename): ${ok}/${matched.length}`);
  if (failures.length) {
    console.log(`❌ Failures: ${failures.length}`);
    for (const f of failures) console.log(`   - ${f.file} (id ${f.id}): ${f.err}`);
  }
  console.log(`📁 Canonical copies to scp to the server: ${SKILLS_DIR}`);
  console.log('   → copy these into /var/www/html/easydoc/easyfixer_documents/ on the QA host');
  await closePool();
})().catch((e) => {
  console.error('\n💥', e.message);
  closePool().finally(() => process.exit(1));
});
