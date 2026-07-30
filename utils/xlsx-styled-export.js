const ExcelJS = require('exceljs');

/*
 * Reusable styled-XLSX builder/streamer.
 *
 * Used by report-style endpoints that need to ship a downloadable
 * Excel of tabular data with a consistent visual identity. First
 * caller: GET /admin/call-info/export.xlsx (2026-05-14). Now also the
 * canonical export path for ALL QuickSight reports (2026-06-15) —
 * colorful KPI cards + in-cell data bars + number formats.
 *
 * Visual recipe (matches the EasyFix CRM Metronic palette):
 *   - Row 1 — brand title band (deep sky #1E6FBE, white bold 18pt).
 *   - Row 2 — meta summary band (light sky #DBEAFE, indigo 11pt).
 *   - Row 3 — 4px spacer.
 *   - (optional) KPI cards band — a label row + a big-number value row,
 *     each card a colored, bordered block. Accent colors cycle through a
 *     palette mirroring the on-screen recharts QS_COLORS so the sheet and
 *     the report page read as one family.
 *   - Column headers (Metronic blue #2E86DE, white bold, centered,
 *     all-bordered, FROZEN below + auto-filter).
 *   - Data rows with alternating white / #F8FAFC banding, hairline borders,
 *     per-column number formats, and optional in-cell DATA BARS (native
 *     Excel conditional formatting — the bar renders behind the value).
 *   - (optional) bold TOTAL footer row.
 *
 * "Charts" note: ExcelJS cannot write native chart objects (bar/pie/line).
 * The in-cell data bars below ARE native Excel visuals (conditional
 * formatting) and need no extra dependency — that is the supported way to
 * get a chart-like view inside the sheet.
 *
 * Usage pattern:
 *
 *   await streamStyledXlsx(res, 'city-performance.xlsx', {
 *     title: 'EasyFix · City Performance',
 *     meta:  'Flag: monthly · 24 cities · Generated 15-Jun-2026',
 *     sheetName: 'City Performance',
 *     kpis: [
 *       { label: 'Tickets Created', value: 12480 },
 *       { label: 'Open Orders',     value: 318, accent: 'FFF59E0B' },
 *       { label: 'Cities ≥ TAT',    value: 19, accent: 'FF10B981' },
 *     ],
 *     columns: [
 *       { header: 'City',     key: 'city',    width: 24, align: 'left' },
 *       { header: 'Tickets',  key: 'tickets', numFmt: '#,##0', dataBar: true },
 *       { header: 'TAT %',    key: 'tat',     numFmt: '0.0%' },
 *     ],
 *     rows: [{ city: 'Delhi', tickets: 1240, tat: 0.86 }, …],
 *     totalRow: { city: 'Total', tickets: 12480 },   // optional
 *     emptyMessage: 'No cities found.',              // optional
 *   });
 */

// Palette — kept as constants so a future "rebrand pass" only edits
// one place. All ARGB to satisfy ExcelJS's color contract.
const BRAND_DEEP    = 'FF1E6FBE';
const BRAND_PRIMARY = 'FF2E86DE';
const BRAND_LIGHT   = 'FFDBEAFE';
const STRIPE        = 'FFF8FAFC';
const BORDER_GREY   = 'FFE2E8F0';
const TEXT_INDIGO   = 'FF1E40AF';
const TEXT_DARK     = 'FF111827';
const TEXT_MUTED    = 'FF6B7280';
const CARD_LABEL_BG = 'FFF1F5F9';
const WHITE         = 'FFFFFFFF';

// KPI card accent palette — mirrors the FE chart kit QS_COLORS so the
// downloaded sheet matches the on-screen Graphical View.
const KPI_ACCENTS = [
  'FF6366F1', // indigo
  'FF10B981', // emerald
  'FFF59E0B', // amber
  'FFEF4444', // red
  'FF0EA5E9', // sky
  'FF8B5CF6', // violet
  'FF14B8A6', // teal
  'FFF97316', // orange
];

/**
 * Build a styled workbook + worksheet. Returns the workbook so the
 * caller can attach more sheets or finalise streaming itself.
 *
 * @param {Object}  o
 * @param {string}  o.title         Brand-band title text.
 * @param {string=} o.meta          Meta-band summary text (optional).
 * @param {string=} o.sheetName     Worksheet name (default = first 31
 *                                  chars of title or "Sheet1").
 * @param {Array<{header:string,key:string,width?:number,align?:'left'|'center'|'right',numFmt?:string,dataBar?:boolean,dataBarColor?:string}>} o.columns
 * @param {Array<Object>} o.rows    Row objects keyed by column.key.
 * @param {Array<{label:string,value:(string|number),accent?:string,numFmt?:string}>=} o.kpis
 *                                  Optional KPI cards rendered above the table.
 * @param {Object=} o.totalRow      Optional footer row, keyed by column.key.
 * @param {string=} o.emptyMessage  Shown when rows is empty (default
 *                                  "No rows.").
 * @param {Object=} o.wb            EXISTING workbook to add this sheet to.
 *                                  Omit (the default) and a fresh workbook is
 *                                  created, exactly as before — every existing
 *                                  caller is unaffected. Pass the workbook
 *                                  returned by a previous call to build a
 *                                  MULTI-SHEET export (see the Offer Acceptance
 *                                  report: Technician / Offerer / Job sheets),
 *                                  then hand it to streamWorkbook().
 */
function buildStyledWorkbook({
  title, meta, sheetName, columns, rows, kpis, totalRow, emptyMessage, wb: existingWb,
}) {
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new Error('buildStyledWorkbook: columns required');
  }
  const safeRows = Array.isArray(rows) ? rows : [];
  const safeKpis = Array.isArray(kpis) ? kpis.filter(Boolean) : [];
  const nCols = columns.length;
  const name = (sheetName || title || 'Sheet1').slice(0, 31);

  // Reuse the caller's workbook when building a multi-sheet export; otherwise
  // create one (the single-sheet path every other report takes).
  const wb = existingWb || new ExcelJS.Workbook();
  if (!existingWb) {
    wb.creator = 'EasyFix CRM';
    wb.created = new Date();
  }

  const ws = wb.addWorksheet(name);

  // ── Row 1 — title band ─────────────────────────────────────────────────
  ws.mergeCells(1, 1, 1, nCols);
  const titleCell = ws.getCell(1, 1);
  titleCell.value = title || '';
  titleCell.font = { name: 'Calibri', size: 18, bold: true, color: { argb: WHITE } };
  titleCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_DEEP } };
  ws.getRow(1).height = 30;

  // ── Row 2 — meta summary band ──────────────────────────────────────────
  ws.mergeCells(2, 1, 2, nCols);
  const metaCell = ws.getCell(2, 1);
  metaCell.value = meta || '';
  metaCell.font = { name: 'Calibri', size: 11, color: { argb: TEXT_INDIGO } };
  metaCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  metaCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_LIGHT } };
  ws.getRow(2).height = 20;

  // ── Row 3 — spacer ─────────────────────────────────────────────────────
  ws.getRow(3).height = 4;

  // ── (optional) KPI cards band ──────────────────────────────────────────
  // Two rows: labels (small/muted) over big colored values, each card a
  // bordered block spanning an equal slice of the table's columns.
  let headerRow = 4;
  if (safeKpis.length > 0) {
    const labelRowIdx = 4;
    const valueRowIdx = 5;
    const k = safeKpis.length;
    const span = Math.max(1, Math.floor(nCols / k));
    safeKpis.forEach((kpi, i) => {
      const startCol = i * span + 1;
      const endCol = i === k - 1 ? nCols : (i + 1) * span;
      const accent = kpi.accent || KPI_ACCENTS[i % KPI_ACCENTS.length];

      // Label cell (card top).
      ws.mergeCells(labelRowIdx, startCol, labelRowIdx, endCol);
      const lc = ws.getCell(labelRowIdx, startCol);
      lc.value = String(kpi.label || '').toUpperCase();
      lc.font = { name: 'Calibri', size: 9, bold: true, color: { argb: TEXT_MUTED } };
      lc.alignment = { vertical: 'middle', horizontal: 'center' };
      lc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CARD_LABEL_BG } };
      lc.border = {
        top:  { style: 'medium', color: { argb: accent } }, // accent rail
        left: { style: 'thin', color: { argb: BORDER_GREY } },
        right:{ style: 'thin', color: { argb: BORDER_GREY } },
      };

      // Value cell (card bottom).
      ws.mergeCells(valueRowIdx, startCol, valueRowIdx, endCol);
      const vc = ws.getCell(valueRowIdx, startCol);
      const isNum = typeof kpi.value === 'number';
      vc.value = kpi.value == null ? '' : kpi.value;
      if (isNum) vc.numFmt = kpi.numFmt || '#,##0';
      vc.font = { name: 'Calibri', size: 18, bold: true, color: { argb: accent } };
      vc.alignment = { vertical: 'middle', horizontal: 'center' };
      vc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: WHITE } };
      vc.border = {
        bottom: { style: 'thin', color: { argb: BORDER_GREY } },
        left:   { style: 'thin', color: { argb: BORDER_GREY } },
        right:  { style: 'thin', color: { argb: BORDER_GREY } },
      };
    });
    ws.getRow(labelRowIdx).height = 16;
    ws.getRow(valueRowIdx).height = 28;
    ws.getRow(6).height = 6; // spacer below cards
    headerRow = 7;
  }

  // ── Column headers ─────────────────────────────────────────────────────
  columns.forEach((col, idx) => {
    const colIdx = idx + 1;
    ws.getColumn(colIdx).width = col.width || Math.max(12, (col.header || '').length + 4);
    const hc = ws.getCell(headerRow, colIdx);
    hc.value = col.header;
    hc.font = { name: 'Calibri', size: 11, bold: true, color: { argb: WHITE } };
    hc.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    hc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_PRIMARY } };
    hc.border = {
      top:    { style: 'thin', color: { argb: BRAND_DEEP } },
      bottom: { style: 'thin', color: { argb: BRAND_DEEP } },
      left:   { style: 'thin', color: { argb: BRAND_DEEP } },
      right:  { style: 'thin', color: { argb: BRAND_DEEP } },
    };
  });
  ws.getRow(headerRow).height = 22;

  // Freeze everything above the first data row; auto-filter the header.
  ws.views = [{ state: 'frozen', ySplit: headerRow }];
  ws.autoFilter = {
    from: { row: headerRow, column: 1 },
    to:   { row: headerRow, column: nCols },
  };

  const firstDataRow = headerRow + 1;

  // ── Data rows ──────────────────────────────────────────────────────────
  if (safeRows.length === 0) {
    ws.mergeCells(firstDataRow, 1, firstDataRow, nCols);
    const c = ws.getCell(firstDataRow, 1);
    c.value = emptyMessage || 'No rows.';
    c.font = { name: 'Calibri', size: 11, italic: true, color: { argb: TEXT_MUTED } };
    c.alignment = { vertical: 'middle', horizontal: 'center' };
    ws.getRow(firstDataRow).height = 28;
  } else {
    safeRows.forEach((row, i) => {
      const rowIdx = firstDataRow + i;
      const banded = i % 2 === 1;
      columns.forEach((col, cIdx) => {
        const cell = ws.getCell(rowIdx, cIdx + 1);
        const v = row[col.key];
        cell.value = v == null ? '' : v;
        if (col.numFmt && typeof v === 'number') cell.numFmt = col.numFmt;
        cell.font = { name: 'Calibri', size: 10, color: { argb: TEXT_DARK } };
        cell.alignment = {
          vertical: 'middle',
          horizontal: col.align || 'center',
          wrapText: false,
        };
        if (banded) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: STRIPE } };
        }
        cell.border = {
          top:    { style: 'hair', color: { argb: BORDER_GREY } },
          bottom: { style: 'hair', color: { argb: BORDER_GREY } },
          left:   { style: 'hair', color: { argb: BORDER_GREY } },
          right:  { style: 'hair', color: { argb: BORDER_GREY } },
        };
      });
      ws.getRow(rowIdx).height = 18;
    });

    // ── In-cell data bars (native conditional formatting) ────────────────
    // Applied per flagged column across the data range. The bar renders
    // behind the value (showValue default true), giving a chart-like view.
    const lastDataRow = headerRow + safeRows.length;
    columns.forEach((col, cIdx) => {
      if (!col.dataBar) return;
      const colLetter = ws.getColumn(cIdx + 1).letter;
      ws.addConditionalFormatting({
        ref: `${colLetter}${firstDataRow}:${colLetter}${lastDataRow}`,
        rules: [{
          type: 'dataBar',
          cfvo: [{ type: 'min' }, { type: 'max' }],
          color: { argb: col.dataBarColor || BRAND_PRIMARY },
        }],
      });
    });

    // ── (optional) bold TOTAL footer row ─────────────────────────────────
    if (totalRow && typeof totalRow === 'object') {
      const rowIdx = headerRow + safeRows.length + 1;
      columns.forEach((col, cIdx) => {
        const cell = ws.getCell(rowIdx, cIdx + 1);
        const v = totalRow[col.key];
        cell.value = v == null ? '' : v;
        if (col.numFmt && typeof v === 'number') cell.numFmt = col.numFmt;
        cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: BRAND_DEEP } };
        cell.alignment = { vertical: 'middle', horizontal: col.align || 'center' };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_LIGHT } };
        cell.border = {
          top:    { style: 'medium', color: { argb: BRAND_PRIMARY } },
          bottom: { style: 'thin', color: { argb: BRAND_DEEP } },
          left:   { style: 'hair', color: { argb: BORDER_GREY } },
          right:  { style: 'hair', color: { argb: BORDER_GREY } },
        };
      });
      ws.getRow(rowIdx).height = 20;
    }
  }

  return wb;
}

/**
 * One-shot helper: build the workbook with the recipe above, set the
 * download response headers, and stream the XLSX to `res`.
 *
 * Call this from a route handler when there's nothing custom to add
 * to the workbook (single-sheet styled export). For multi-sheet or
 * custom-formula workbooks, use `buildStyledWorkbook()` directly and
 * write to the response yourself.
 *
 * @param {import('express').Response} res
 * @param {string} filename  e.g. "city-performance_2026-06-15.xlsx".
 * @param {Object} opts      Same shape as buildStyledWorkbook input.
 */
/*
 * Ship an ALREADY-BUILT workbook. Split out of streamStyledXlsx so a
 * multi-sheet caller can build N sheets (buildStyledWorkbook with `wb`) and
 * then stream the result. streamStyledXlsx below is the single-sheet
 * convenience wrapper and behaves exactly as it always has.
 */
async function streamWorkbook(res, filename, wb) {
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await wb.xlsx.write(res);
  res.end();
}

async function streamStyledXlsx(res, filename, opts) {
  const wb = buildStyledWorkbook(opts);
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  res.setHeader('Cache-Control', 'no-store');
  // RFC 5987 fallback — the simple form is enough for ASCII names, and
  // every caller today uses ASCII. If a future caller has non-ASCII
  // text in the filename, swap in `filename*=UTF-8''…` encoded form.
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await wb.xlsx.write(res);
  res.end();
}

module.exports = {
  buildStyledWorkbook,
  streamWorkbook,
  streamStyledXlsx,
  // Re-export the palette so siblings can stay visually consistent
  // when they need custom styling.
  PALETTE: {
    BRAND_DEEP, BRAND_PRIMARY, BRAND_LIGHT, STRIPE, BORDER_GREY,
    TEXT_INDIGO, TEXT_DARK, TEXT_MUTED, WHITE, KPI_ACCENTS,
  },
};
