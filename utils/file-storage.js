const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

/*
 * File storage helpers for /api/shared/upload and /api/shared/files.
 *
 * Design notes:
 *   - We DO NOT use user-supplied filenames on disk. The client name is kept
 *     only as response metadata. On-disk names are `{ts}_{rand8}{ext}`.
 *   - Every write and every delete resolves the final path and confirms it
 *     starts with the configured category root — path-traversal guard.
 *   - Categories map to env vars. Unknown categories are rejected at the
 *     validator layer before we ever touch the filesystem.
 */

const CATEGORIES = {
  easyfixer_documents: 'UPLOAD_EASYFIXER_DOCS',
  job_files:           'UPLOAD_JOB_FILES',
  invoices:            'UPLOAD_INVOICES',
  general:             'UPLOAD_ROOT_PATH',
};

const ALLOWED_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif',
  '.pdf', '.xlsx', '.xls', '.csv', '.txt',
]);

const ALLOWED_MIME = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'text/csv', 'text/plain',
  'application/octet-stream', // permissive — browsers sometimes send this for .pdf
]);

function categoryRoot(category) {
  const envKey = CATEGORIES[category];
  if (!envKey) {
    const err = new Error(`unknown category "${category}"`);
    err.status = 400;
    throw err;
  }
  const rootRaw = process.env[envKey];
  if (!rootRaw) {
    const err = new Error(`env ${envKey} is not set`);
    err.status = 500;
    throw err;
  }
  return path.resolve(rootRaw);
}

function ensureCategoryDir(category) {
  const root = categoryRoot(category);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function safeExt(originalName) {
  const ext = (path.extname(originalName) || '').toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    const err = new Error(`file extension "${ext}" is not allowed`);
    err.status = 400;
    throw err;
  }
  return ext;
}

function checkMime(mimetype) {
  if (!ALLOWED_MIME.has(mimetype)) {
    const err = new Error(`mimetype "${mimetype}" is not allowed`);
    err.status = 400;
    throw err;
  }
}

function generateFilename(originalName) {
  const ts = Date.now();
  const rand = crypto.randomBytes(4).toString('hex');
  return `${ts}_${rand}${safeExt(originalName)}`;
}

// Verify that the resolved file path is inside the category root.
// Blocks `../` escapes and null-byte tricks.
function resolveWithinCategory(category, filename) {
  if (typeof filename !== 'string' || filename.length === 0) {
    const err = new Error('filename is required'); err.status = 400; throw err;
  }
  if (filename.includes('\0') || filename.includes('/') || filename.includes('\\')) {
    const err = new Error('filename contains disallowed characters'); err.status = 400; throw err;
  }
  const root = categoryRoot(category);
  const full = path.resolve(root, filename);
  if (!full.startsWith(root + path.sep) && full !== root) {
    const err = new Error('resolved path escapes category root'); err.status = 400; throw err;
  }
  return full;
}

function writeBuffer(category, buffer, originalName, mimetype, options = {}) {
  checkMime(mimetype);
  const root = ensureCategoryDir(category);
  const deterministicStem = String(options?.deterministicStem || '').trim();
  if (deterministicStem && !/^[A-Za-z0-9_-]{1,180}$/.test(deterministicStem)) {
    const err = new Error('deterministic filename stem is invalid'); err.status = 400; throw err;
  }
  const filename = deterministicStem
    ? `${deterministicStem}${safeExt(originalName)}`
    : generateFilename(originalName);
  const full = deterministicStem
    ? resolveWithinCategory(category, filename)
    : path.resolve(root, filename);
  fs.writeFileSync(full, buffer);
  return {
    category,
    filename,
    path: full,
    size: buffer.length,
    url: publicUrlFor(category, filename),
    originalName,
    mimetype,
  };
}

function publicUrlFor(category, filename) {
  const base = process.env.FILE_BASE_URL || '/easydoc';
  // Mirror the legacy layout: <FILE_BASE_URL>/<category>/<filename>
  // (Nginx is configured to serve /var/www/html/easydoc/... at FILE_BASE_URL.)
  const sub = {
    easyfixer_documents: 'easyfixer_documents',
    job_files:           'upload_jobs',
    invoices:            'client_invoice',
    general:             '',
  }[category] || category;
  return sub ? `${base}/${sub}/${filename}` : `${base}/${filename}`;
}

function unlinkFile(category, filename) {
  const full = resolveWithinCategory(category, filename);
  if (!fs.existsSync(full)) {
    const err = new Error('file not found'); err.status = 404; throw err;
  }
  const stats = fs.lstatSync(full);
  if (stats.isSymbolicLink()) {
    const err = new Error('refusing to unlink symlink'); err.status = 400; throw err;
  }
  fs.unlinkSync(full);
  return { category, filename, path: full };
}

module.exports = {
  CATEGORIES,
  ALLOWED_EXT,
  ALLOWED_MIME,
  categoryRoot,
  ensureCategoryDir,
  writeBuffer,
  unlinkFile,
  resolveWithinCategory,
  publicUrlFor,
};
