const ExcelJS = require('exceljs');

/*
 * Stream an array of row objects to the response as an .xlsx download.
 *
 * columns: [{ key: 'job_id', header: 'Job ID', width?: 14 }, ...]
 * rows:    [{ job_id: 1, ... }, ...]
 *
 * Header order follows the columns array. Values are pulled by `key`;
 * nulls render as empty cells. Date instances are written as Excel
 * date cells.
 *
 * Visual recipe (kept intentionally subtle — SPOC-facing reports):
 *   - Header row 1: bold slate-800 text on slate-200 fill, centred,
 *     taller row so multi-word headers wrap without clipping.
 *   - Every cell in the data range gets a thin slate-300 border so
 *     the sheet looks like a proper grid out of the box.
 *   - Data rows: slate-700 10pt with vertical centring + wrap so long
 *     addresses / descriptions stay legible.
 *
 * Migrated from the SheetJS `xlsx` library to `exceljs` because the
 * SheetJS community build can't reliably emit cell styling — bold,
 * fills, and borders silently drop.
 */
async function sendXlsx(res, { filename, sheetName = 'Sheet1', columns, rows }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'EasyFix';
  wb.created = new Date();
  const ws = wb.addWorksheet(sheetName.slice(0, 31));

  // ── Headers ─────────────────────────────────────────────────────
  const headers = columns.map((c) => c.header);
  ws.addRow(headers);
  ws.columns = columns.map((c) => ({
    width: c.width || Math.max(12, c.header.length + 4),
  }));

  const headerRow = ws.getRow(1);
  headerRow.height = 32;
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FF1E293B' }, size: 11 }; // slate-800
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE2E8F0' }, // slate-200
    };
    cell.alignment = {
      horizontal: 'center',
      vertical: 'middle',
      wrapText: true,
    };
  });

  // ── Data rows ───────────────────────────────────────────────────
  for (const r of rows) {
    ws.addRow(columns.map((c) => normalize(r[c.key])));
  }

  // ── Borders on every cell in the actual used range ─────────────
  // Thin slate-300 around the full grid; medium slate-400 under the
  // header to visually anchor it. Looping over `rowCount × columns`
  // means borders match the data — empty exports get just a styled
  // header, no orphan border block below.
  const lightBorder       = { style: 'thin',   color: { argb: 'FFCBD5E1' } }; // slate-300
  const headerBottomBorder = { style: 'medium', color: { argb: 'FF94A3B8' } }; // slate-400
  const totalRows = Math.max(1, rows.length + 1); // +1 for header
  for (let r = 1; r <= totalRows; r++) {
    for (let c = 1; c <= columns.length; c++) {
      const cell = ws.getCell(r, c);
      cell.border = {
        top:    lightBorder,
        left:   lightBorder,
        right:  lightBorder,
        bottom: r === 1 ? headerBottomBorder : lightBorder,
      };
      if (r > 1) {
        cell.alignment = { vertical: 'middle', wrapText: true };
        cell.font = { size: 10, color: { argb: 'FF334155' } }; // slate-700
      }
    }
  }

  const buf = Buffer.from(await wb.xlsx.writeBuffer());

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(buf);
}

function normalize(v) {
  if (v == null) return '';
  if (v instanceof Date) return v;
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

module.exports = { sendXlsx };
