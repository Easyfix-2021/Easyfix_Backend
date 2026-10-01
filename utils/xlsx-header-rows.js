'use strict';
const XLSX = require('xlsx');

/*
 * Data rows of a sheet whose header row is FOUND, not assumed.
 *
 * Every import template built with utils/xlsx-styled-export puts a title, a
 * note and a blank row above the header (header on row 4). Reading row 1 as
 * the header — sheet_to_json's default — made every row of our OWN templates
 * fail as "required field missing" (Manage Materials brand + material imports
 * since 2026-09-17; rate-card Services + Materials uploads since 2026-09-21).
 *
 * `requiredHeader` is matched case-, whitespace- and trailing-"*"-insensitively
 * in the first HEADER_SCAN_ROWS rows; when it is not found the first row is
 * the header, exactly as before (plain files and our header-on-row-1 exports).
 * Each row gets `_rowNumber`: the real Excel row, from SheetJS's own
 * __rowNum__, so skipped blank rows never shift what an error message names.
 */
const HEADER_SCAN_ROWS = 10;
const normHeader = (v) => String(v ?? '').trim().toLowerCase().replace(/\*$/, '').trim();

function rowsBelowHeader(sheet, requiredHeader) {
  if (!sheet) return [];
  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false, blankrows: true });
  const want = normHeader(requiredHeader);
  const found = grid.slice(0, HEADER_SCAN_ROWS).findIndex((cells) => cells.some((c) => normHeader(c) === want));
  const firstRow = XLSX.utils.decode_range(sheet['!ref'] || 'A1').s.r;
  return XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false, range: found < 0 ? undefined : firstRow + found })
    .map((r) => Object.assign(r, { _rowNumber: r.__rowNum__ + 1 }));
}

module.exports = { rowsBelowHeader, HEADER_SCAN_ROWS };
