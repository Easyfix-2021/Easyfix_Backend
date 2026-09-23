/*
 * Shared EasyFix letterhead + simple table renderer for pdfkit documents.
 *
 * Split out of utils/pdf-rate-card.js so any future letterhead PDF (the
 * rate-card export is the first) draws the SAME company block instead of
 * re-typing the CIN/address/rule every time. utils/pdf-invoice.js currently
 * hand-rolls its own header — a good candidate to switch to this helper
 * later, but that file is unrelated to this change and is left alone.
 *
 * Brand red is imported from utils/pdf-certificate.js (BRAND_RED) rather
 * than re-declared, so the two artifacts cannot drift onto different reds.
 */
const path = require('path');
const { BRAND_RED } = require('./pdf-certificate');

/*
 * Embedded fonts. pdfkit's built-in Helvetica has NO ₹ glyph: the first render
 * printed "¹400.00" and "Rate ( ¹)", and because a missing glyph is measured
 * wrongly, right-aligned amounts also landed in the wrong place. IBM Plex Sans
 * (already shipped in assets/fonts for the certificates) carries U+20B9 in both
 * weights. Call registerLetterheadFonts(doc) once, right after creating it.
 */
const FONT_REGULAR = 'LetterheadRegular';
const FONT_BOLD = 'LetterheadBold';
function registerLetterheadFonts(doc) {
  const dir = path.join(__dirname, '..', 'assets', 'fonts');
  doc.registerFont(FONT_REGULAR, path.join(dir, 'IBMPlexSans-Regular.ttf'));
  doc.registerFont(FONT_BOLD, path.join(dir, 'IBMPlexSans-Bold.ttf'));
}

const INK = '#1A1A1A';
const MUTED = '#6B6B6B';
const RULE = '#D9D9D9';

const COMPANY_NAME = 'EASY FIX HANDY SOLUTIONS INDIA PRIVATE LIMITED';
const COMPANY_CIN = 'CIN: U93000DL2013PTC257571';
const COMPANY_ADDRESS = '6th Floor, Plot No. 10, Sector-44, Gurgaon, Haryana – 122003';

/*
 * Draws the company identity band + an optional document title block at the
 * CURRENT position (page 1 only — this is not repeated on later pages; a
 * table's own header row is what repeats, via drawTable below).
 *
 *   title       — e.g. 'RATE CARD', drawn bold in near-black.
 *   titleAccent — e.g. the client name, drawn in brand red on the same line.
 *   lines       — extra meta lines under the title (brand/project line,
 *                 "Generated on …"), drawn small and muted, one per line.
 */
function drawLetterhead(doc, { title, titleAccent, lines = [] } = {}) {
  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  doc.font(FONT_BOLD).fontSize(15).fillColor(BRAND_RED)
    .text(COMPANY_NAME, left, doc.y, { width, align: 'center' });
  doc.font(FONT_REGULAR).fontSize(8).fillColor(MUTED);
  doc.text(COMPANY_CIN, left, doc.y, { width, align: 'center' });
  doc.text(COMPANY_ADDRESS, left, doc.y, { width, align: 'center' });
  doc.moveDown(0.5);

  const ruleY = doc.y;
  doc.moveTo(left, ruleY).lineTo(left + width, ruleY).lineWidth(0.75).strokeColor(RULE).stroke();
  doc.moveDown(0.7);

  if (title) {
    doc.font(FONT_BOLD).fontSize(18).fillColor(INK);
    if (titleAccent) {
      doc.text(title + '  ', left, doc.y, { continued: true });
      doc.fillColor(BRAND_RED).text(titleAccent);
    } else {
      doc.text(title, left, doc.y);
    }
  }
  for (const line of lines) {
    if (!line) continue;
    doc.font(FONT_REGULAR).fontSize(9.5).fillColor(MUTED).text(String(line), left);
  }
  doc.moveDown(0.8);
  return doc.y;
}

/* A small section heading ("Services" / "Materials") above a table. */
function drawSectionHeading(doc, text) {
  const left = doc.page.margins.left;
  doc.font(FONT_BOLD).fontSize(12).fillColor(INK).text(text, left, doc.y);
  doc.moveDown(0.3);
}

const HEADER_HEIGHT = 20;
const ROW_MIN_HEIGHT = 14;
const CELL_PAD_X = 4;
const CELL_PAD_Y = 3;

/*
 * A plain bordered table that:
 *   - repeats its header row after every page break (drawTable is called
 *     once per section; the header is redrawn internally, not by the caller)
 *   - never splits a single row across a page break — height is measured
 *     BEFORE drawing, and a row that would overflow triggers a fresh page
 *     (with a fresh header) first.
 *
 * `columns`: [{ key, label, width, align? }] — widths in points, caller's
 * job to sum to the available content width.
 * `rows`: plain objects keyed by column.key; values are stringified.
 */
function drawTable(doc, { columns, rows }) {
  const left = doc.page.margins.left;
  const totalWidth = columns.reduce((s, c) => s + c.width, 0);
  const pageBottom = doc.page.height - doc.page.margins.bottom;

  function header() {
    const y = doc.y;
    doc.rect(left, y, totalWidth, HEADER_HEIGHT).fillAndStroke('#F2F2F2', RULE);
    doc.fillColor(INK).font(FONT_BOLD).fontSize(9.5);
    let x = left;
    for (const c of columns) {
      doc.text(c.label, x + CELL_PAD_X, y + 5, { width: c.width - CELL_PAD_X * 2, align: c.align || 'left' });
      x += c.width;
    }
    doc.y = y + HEADER_HEIGHT;
  }

  header();

  for (const row of rows) {
    doc.font(FONT_REGULAR).fontSize(9.5).fillColor(INK);
    const cellHeights = columns.map((c) => (
      doc.heightOfString(String(row[c.key] ?? ''), { width: c.width - CELL_PAD_X * 2 })
    ));
    const rowHeight = Math.max(ROW_MIN_HEIGHT, ...cellHeights) + CELL_PAD_Y * 2;

    if (doc.y + rowHeight > pageBottom) {
      doc.addPage();
      header();
      doc.font(FONT_REGULAR).fontSize(9.5).fillColor(INK);
    }

    const y = doc.y;
    let x = left;
    for (const c of columns) {
      doc.text(String(row[c.key] ?? ''), x + CELL_PAD_X, y + CELL_PAD_Y, { width: c.width - CELL_PAD_X * 2, align: c.align || 'left' });
      x += c.width;
    }
    doc.moveTo(left, y + rowHeight).lineTo(left + totalWidth, y + rowHeight).lineWidth(0.5).strokeColor(RULE).stroke();
    doc.y = y + rowHeight;
  }
}

module.exports = {
  drawLetterhead,
  drawSectionHeading,
  drawTable,
  INK,
  MUTED,
  RULE,
  BRAND_RED, registerLetterheadFonts, FONT_REGULAR, FONT_BOLD };
