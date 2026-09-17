/*
 * The ONE name normaliser for Manage Materials (brands + materials).
 *
 * Used by services/brand.service.js, services/material.service.js AND the
 * import services — every path that writes a `*_key` column or checks a
 * duplicate must go through this function so "Philips", " philips ", and
 * "PHILIPS" all collide on the same key.
 *
 * Deliberately NOT locale-aware / NOT stripping punctuation — matches the
 * contract's stated formula exactly:
 *   nameKey(s) = String(s).trim().replace(/\s+/g, ' ').toLowerCase()
 */
function nameKey(s) {
  return String(s == null ? '' : s).trim().replace(/\s+/g, ' ').toLowerCase();
}

module.exports = { nameKey };
