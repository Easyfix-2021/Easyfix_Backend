#!/usr/bin/env node
/*
 * upload-deepskill-images.js — ONE-TIME, self-contained bulk loader for the
 * deep-skill images in the SharePoint "Deepskill image" tree → S3 + the legacy
 * AWS server, with a DB rename of tbl_deep_skill.deepskill_image.
 * ===========================================================================
 * SHAREPOINT TREE (download it locally first → CONFIG.IMAGES_DIR):
 *     Deepskill image/<Category>/<Type>/<DeepSkill>/<skill> <action>.png
 *   e.g. Carpenter/Chair & Hydrolic System/Motorised Recliners/Motorised Recliners instalation.png
 *        Carpenter/Chair & Hydrolic System/Motorised Recliners/Motorised Recliners repair.png
 *   Some images sit directly under a <Type> folder (e.g. "metal chair instalation .png").
 *
 * WHAT IT DOES (per deep skill):
 *   1. Walks the tree; the deep skill is the image's LEAF FOLDER name, falling
 *      back to the filename with action words (instalation/repair/…) stripped.
 *   2. MATCHES it to a tbl_deep_skill row by normalised name (DB the CONFIG.DB
 *      points at — point it at PROD to identify+update prod deep skills).
 *   3. Picks a PRIMARY image per skill (prefers the "instal…" one) → becomes
 *      deepskill_image; any extras (repair, …) are uploaded too (seq 2,3…) so
 *      nothing is lost, but only the primary is written to the DB.
 *   4. RENAMES → canonical S3 key  Skills/Skill_<deepskill_id>_<seq>  (no
 *      extension; the original filename is kept in S3 object metadata).
 *   5. UPLOADS to S3, writes a canonically-named copy under CONFIG.OUT_DIR/Skills/,
 *      optionally rsyncs that to the LEGACY server, and UPDATEs deepskill_image.
 *
 * SAFETY: DRY RUN is the default — it matches + prints the plan + writes a
 * mapping CSV (matched / extra / ambiguous / unmatched / already-have-image) with
 * ZERO S3/DB/legacy writes. Review the CSV, fix stragglers with a --map file,
 * then re-run with --run. Rows that already have an image are skipped unless
 * --overwrite (which bumps the seq so presigned reads bust).
 *
 * FILL THE CONFIG BLOCK BELOW (AWS + LEGACY + DB creds) — placeholders marked <…>.
 * Each can also come from the matching env var (so `dotenv` / your shell works too).
 *
 * USAGE:
 *   node scripts/upload-deepskill-images.js                 # DRY RUN
 *   node scripts/upload-deepskill-images.js --run           # execute (S3 + DB [+ legacy if enabled])
 *   node scripts/upload-deepskill-images.js --run --overwrite
 *   node scripts/upload-deepskill-images.js --map fixups.csv --run
 *
 * FLAGS (override CONFIG): --run  --overwrite  --pick-first  --keep-ext
 *   --dir D  --out D  --map F.csv
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const logger = require('../logger');

// ═══════════════════════════════════════════════════════════════════════════
//  CONFIG — fill the <…> placeholders (or set the env vars). Don't commit creds.
// ═══════════════════════════════════════════════════════════════════════════
const CONFIG = {
  IMAGES_DIR: process.env.DSI_DIR || './deepskill-images',   // local copy of the SharePoint tree
  OUT_DIR:    process.env.DSI_OUT || './deepskill-renamed',  // canonical copies (for legacy rsync)

  // Deep skills are READ here and deepskill_image UPDATED here. Point at PROD.
  DB: {
    host:     process.env.DB_HOST     || '<DB_HOST>',
    port:     Number(process.env.DB_PORT || 3306),
    user:     process.env.DB_USER     || '<DB_USER>',
    password: process.env.DB_PASSWORD || '<DB_PASSWORD>',
    database: process.env.DB_NAME     || '<DB_NAME>',
  },

  // S3 — deep-skill images live at key  Skills/Skill_<id>_<seq>. Use the PROD bucket.
  AWS: {
    bucket:          process.env.S3_BUCKET_NAME       || '<PROD_S3_BUCKET>',
    region:          process.env.AWS_REGION           || 'ap-south-1',
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID    || '<AWS_ACCESS_KEY_ID>',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '<AWS_SECRET_ACCESS_KEY>',
    keyPrefix:       'Skills',
  },

  // Legacy AWS server (Legacy CRM serves the same images off disk). When enabled,
  // the canonical copies are rsync'd over SSH. Leave disabled until creds are set.
  LEGACY: {
    enabled:    false,
    host:       '<LEGACY_HOST>',                 // e.g. ec2-xx.ap-south-1.compute.amazonaws.com
    user:       '<LEGACY_SSH_USER>',             // e.g. ubuntu
    sshKeyPath: '<PATH_TO_SSH_PEM>',             // e.g. ~/.ssh/easyfix-legacy.pem
    remoteDir:  '<LEGACY_DEEPSKILL_IMAGE_ROOT>', // a Skills/ subfolder is created under it
  },

  DRY_RUN: true, OVERWRITE: false, PICK_FIRST: false, KEEP_EXT: false,
};
// ═══════════════════════════════════════════════════════════════════════════

const EXT_CT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
};
const ACTION_RX = /\b(instal+ation|installation|install|repair|service|fitting|fix|works?)\b/gi;

function applyFlags() {
  const a = process.argv.slice(2);
  if (a.includes('--run')) CONFIG.DRY_RUN = false;
  if (a.includes('--overwrite')) CONFIG.OVERWRITE = true;
  if (a.includes('--pick-first')) CONFIG.PICK_FIRST = true;
  if (a.includes('--keep-ext')) CONFIG.KEEP_EXT = true;
  const val = (flag) => { const i = a.indexOf(flag); return i >= 0 ? a[i + 1] : null; };
  CONFIG.IMAGES_DIR = val('--dir') || CONFIG.IMAGES_DIR;
  CONFIG.OUT_DIR = val('--out') || CONFIG.OUT_DIR;
  CONFIG.MAP = val('--map') || null;
}

const norm = (s) => String(s || '').toLowerCase().replace(/\.[a-z0-9]+$/i, '').replace(/[^a-z0-9]+/g, '');
const stripActions = (s) => String(s || '').replace(/\.[a-z0-9]+$/i, '').replace(ACTION_RX, '').replace(/\s+/g, ' ').trim();
const nextSeq = (k) => { const m = String(k || '').match(/_(\d+)$/); return m ? Number(m[1]) + 1 : 1; };

function walkImages(root) {
  const out = [];
  (function rec(dir, rel) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) rec(full, r);
      else if (EXT_CT[path.extname(e.name).toLowerCase()]) out.push({ full, rel: r, parent: path.basename(dir), file: e.name });
    }
  })(root, '');
  return out;
}

function loadMap(file) {
  const m = new Map(); // norm(filename or relpath) → deepskill_id
  if (!file) return m;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const [k, id] = line.split(',').map((x) => x && x.trim());
    if (k && id && /^\d+$/.test(id)) m.set(norm(k), Number(id));
  }
  return m;
}

function s3Client() {
  const { S3Client } = require('@aws-sdk/client-s3');
  return new S3Client({
    region: CONFIG.AWS.region,
    credentials: { accessKeyId: CONFIG.AWS.accessKeyId, secretAccessKey: CONFIG.AWS.secretAccessKey },
  });
}

async function main() {
  applyFlags();
  if (!fs.existsSync(CONFIG.IMAGES_DIR)) { logger.error(`IMAGES_DIR not found: ${CONFIG.IMAGES_DIR}`); process.exitCode = 1; return; }

  const images = walkImages(CONFIG.IMAGES_DIR);
  if (!images.length) { logger.error(`No images under ${CONFIG.IMAGES_DIR}`); process.exitCode = 1; return; }

  // DB — own connection from CONFIG (self-contained; doesn't touch the app pool).
  const mysql = require('mysql2/promise');
  const conn = await mysql.createConnection({
    host: CONFIG.DB.host, port: CONFIG.DB.port, user: CONFIG.DB.user,
    password: CONFIG.DB.password, database: CONFIG.DB.database,
  });
  const [skills] = await conn.query('SELECT deepskill_id, deepskill_name, deepskill_image, status FROM tbl_deep_skill');
  const byName = new Map();   // normName → [rows]
  for (const r of skills) { const k = norm(r.deepskill_name); if (k) (byName.get(k) || byName.set(k, []).get(k)).push(r); }
  const byId = new Map(skills.map((r) => [Number(r.deepskill_id), r]));
  const manual = loadMap(CONFIG.MAP);

  logger.info({ images: images.length, deepSkills: skills.length, db: CONFIG.DB.database, host: CONFIG.DB.host, mode: CONFIG.DRY_RUN ? 'DRY-RUN' : 'RUN' },
    `deep-skill image upload — ${images.length} image(s) vs ${skills.length} deep skill(s)`);

  // ── Match each image to a deep skill ──────────────────────────────────────
  const unmatched = []; const ambiguous = [];
  const bySkill = new Map(); // deepskill_id → { row, images:[{file, full}] }
  for (const img of images) {
    let row = null;
    if (manual.has(norm(img.rel)) || manual.has(norm(img.file))) {
      row = byId.get(manual.get(norm(img.rel)) ?? manual.get(norm(img.file))) || null;
      if (!row) { unmatched.push({ img, reason: 'map id not in tbl_deep_skill' }); continue; }
    } else {
      // try leaf-folder name, then filename minus action words, then raw stem
      const cands = [img.parent, stripActions(img.file), img.file];
      let rows = [];
      for (const c of cands) { rows = byName.get(norm(c)) || []; if (rows.length) break; }
      if (!rows.length) { unmatched.push({ img, reason: 'no deep skill name match' }); continue; }
      if (rows.length > 1) {
        if (!CONFIG.PICK_FIRST) { ambiguous.push({ img, ids: rows.map((r) => r.deepskill_id) }); continue; }
        rows = [...rows].sort((a, b) => a.deepskill_id - b.deepskill_id);
      }
      row = rows[0];
    }
    const id = Number(row.deepskill_id);
    (bySkill.get(id) || bySkill.set(id, { row, images: [] }).get(id)).images.push(img);
  }

  // ── Build the upload plan: primary (prefers "instal…") = seq 1 → DB; extras seq 2.. → S3 only ──
  const plan = []; const skipped = [];
  for (const { row, images: imgs } of bySkill.values()) {
    if (row.deepskill_image && String(row.deepskill_image).trim() && !CONFIG.OVERWRITE) {
      skipped.push({ id: row.deepskill_id, existing: row.deepskill_image, count: imgs.length });
      continue;
    }
    const ordered = [...imgs].sort((a, b) => (/(instal)/i.test(b.file) ? 1 : 0) - (/(instal)/i.test(a.file) ? 1 : 0));
    let seq = CONFIG.OVERWRITE ? nextSeq(row.deepskill_image) : 1;
    ordered.forEach((img, i) => {
      plan.push({ row, img, seq: seq + i, key: `${CONFIG.AWS.keyPrefix}/Skill_${row.deepskill_id}_${seq + i}`, primary: i === 0 });
    });
  }

  // ── Report (always) ───────────────────────────────────────────────────────
  fs.mkdirSync(CONFIG.OUT_DIR, { recursive: true });
  const csv = ['relpath,deepskill_id,deepskill_name,key,role'];
  for (const p of plan) csv.push(`"${p.img.rel}",${p.row.deepskill_id},"${String(p.row.deepskill_name).replace(/"/g, '""')}",${p.key},${p.primary ? 'PRIMARY(deepskill_image)' : 'extra(S3 only)'}`);
  for (const a of ambiguous) csv.push(`"${a.img.rel}",,,"AMBIGUOUS ids=${a.ids.join('|')}",skip`);
  for (const u of unmatched) csv.push(`"${u.img.rel}",,,"${u.reason}",skip`);
  for (const s of skipped) csv.push(`,${s.id},,${s.existing},already-has-image(${s.count} files)`);
  const reportPath = path.join(CONFIG.OUT_DIR, 'deepskill-image-mapping.csv');
  fs.writeFileSync(reportPath, csv.join('\n'));
  logger.info({ skillsMatched: bySkill.size, toUpload: plan.length, primaries: plan.filter((p) => p.primary).length, ambiguous: ambiguous.length, unmatched: unmatched.length, alreadyHave: skipped.length, report: reportPath },
    `plan: ${plan.length} file(s) across ${bySkill.size} skill(s) · ${ambiguous.length} ambiguous · ${unmatched.length} unmatched`);

  if (CONFIG.DRY_RUN) {
    logger.info('DRY RUN — no S3/DB/legacy writes. Review the CSV; resolve ambiguous/unmatched via --map "relpath_or_filename,deepskill_id", then --run.');
    await conn.end(); return;
  }

  // ── Execute ────────────────────────────────────────────────────────────────
  if (CONFIG.AWS.bucket.startsWith('<')) { logger.error('CONFIG.AWS.bucket is a placeholder — fill it (or set S3_BUCKET_NAME).'); await conn.end(); process.exitCode = 1; return; }
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const s3 = s3Client();
  const legacyDir = path.join(CONFIG.OUT_DIR, 'Skills');
  fs.mkdirSync(legacyDir, { recursive: true });

  let ok = 0; let fail = 0;
  for (const p of plan) {
    try {
      const buffer = fs.readFileSync(p.img.full);
      const ct = EXT_CT[path.extname(p.img.file).toLowerCase()] || 'application/octet-stream';
      await s3.send(new PutObjectCommand({
        Bucket: CONFIG.AWS.bucket, Key: p.key, Body: buffer, ContentType: ct,
        Metadata: { 'original-filename': p.img.file.replace(/[^\x20-\x7E]/g, '_').slice(0, 200) },
      }));
      const base = path.basename(p.key);                       // Skill_<id>_<seq>
      fs.writeFileSync(path.join(legacyDir, CONFIG.KEEP_EXT ? base + path.extname(p.img.file).toLowerCase() : base), buffer);
      if (p.primary) await conn.query('UPDATE tbl_deep_skill SET deepskill_image = ? WHERE deepskill_id = ?', [p.key, p.row.deepskill_id]);
      ok++;
    } catch (e) {
      fail++;
      logger.warn({ rel: p.img.rel, id: p.row.deepskill_id, err: e.message }, 'upload failed for this image');
    }
  }
  await conn.end();

  // ── Push to the legacy AWS server (optional) ───────────────────────────────
  if (CONFIG.LEGACY.enabled) {
    if (CONFIG.LEGACY.host.startsWith('<')) {
      logger.warn('LEGACY.enabled but creds are placeholders — skipping rsync. Fill CONFIG.LEGACY.');
    } else {
      const dest = `${CONFIG.LEGACY.user}@${CONFIG.LEGACY.host}:${CONFIG.LEGACY.remoteDir.replace(/\/+$/, '')}/Skills/`;
      logger.info(`rsync ${legacyDir}/ → ${dest}`);
      execFileSync('rsync', ['-avz', '-e', `ssh -i ${CONFIG.LEGACY.sshKeyPath} -o StrictHostKeyChecking=accept-new`, `${legacyDir}/`, dest], { stdio: 'inherit' });
    }
  } else {
    logger.info(`LEGACY disabled — canonical copies are in ${legacyDir}/. rsync them to the legacy server, or set CONFIG.LEGACY.enabled=true.`);
  }

  logger.info({ uploaded: ok, failed: fail }, `done — ${ok} uploaded, ${fail} failed.`);
}

main()
  .then(() => process.exit(process.exitCode || 0))
  .catch((err) => { logger.error({ code: err.code, msg: err.message }, 'deep-skill image upload failed'); process.exit(1); });
