/*
 * Client Rate Card — letterhead PDF (services first, then materials).
 *
 * Shared with someone OUTSIDE EasyFix (owner's framing: "for sharing with
 * someone in a non-editable manner"), so the Services table deliberately
 * shows ONLY the service and the rate the client is charged — never the
 * internal split (Easyfix Direct / Overhead / Client Fixed+Variable), which
 * is EasyFix's margin structure. That split is exactly what the combined
 * XLSX export DOES carry (it's an internal artifact); this PDF is the one
 * surface that must not.
 *
 * "The charged rate" is tbl_client_service.total_amount — the same column
 * job.service.js falls back to when pricing a job service
 * (`COALESCE(NULLIF(js.total_charge,0), CS.total_amount)`, services/
 * job.service.js ~L4076): total_amount IS the rate-card price, total_charge
 * is only a per-job override. A rate card has no job, so total_amount is the
 * only number that applies.
 */
const PDFDocument = require('pdfkit');
const { formatDate } = require('./pdf-certificate');
const { todayIst } = require('./ist-calendar');
const { drawLetterhead, drawSectionHeading, drawTable, MUTED, registerLetterheadFonts, FONT_REGULAR, FONT_BOLD } = require('./pdf-letterhead');

function money(n) {
  const v = Number(n);
  return `₹${(Number.isFinite(v) ? v : 0).toFixed(2)}`;
}

/*
 * Same grammar the pre-redesign exportMaterialRates wrote to the "State
 * Overrides" XLSX column ("Maharashtra, Gujarat: ₹275.00; Delhi: ₹260.00") —
 * kept here purely as a human-readable PDF cell, not as anything re-parsed.
 */
function formatStateOverrides(states, stateNameById) {
  return (states || [])
    .map((s) => `${(s.state_ids || []).map((id) => stateNameById.get(id) || `#${id}`).join(', ')}: ${money(s.price)}`)
    .join('; ');
}

/*
 * client       — { client_name }
 * brandLine    — e.g. "A10 Design · Furniture" (client name · vertical), or
 *                falsy to omit the line entirely.
 * services     — rows from client-rate-cards.service.js#listForClient(),
 *                needs service_type_name + total_amount.
 * materialItems — rows from client-material-rates.service.js#list().
 * stateNameById — Map(state_id -> state_name), from lookup.service.js#states().
 * stream       — writable; doc is piped here (same contract as
 *                utils/pdf-invoice.js / utils/pdf-certificate.js).
 */
function renderRateCardPdf({ client, brandLine, services = [], materialItems = [], stateNameById = new Map(), stream }) {
  const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
  registerLetterheadFonts(doc);
  doc.pipe(stream);

  drawLetterhead(doc, {
    title: 'RATE CARD',
    titleAccent: client.client_name || '',
    lines: [brandLine, `Generated on ${formatDate(todayIst())}`],
  });

  const left = doc.page.margins.left;
  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  drawSectionHeading(doc, 'Services');
  if (!services.length) {
    doc.font(FONT_REGULAR).fontSize(10).fillColor(MUTED).text('No services on this rate card.', left);
  } else {
    drawTable(doc, {
      columns: [
        { key: 'service', label: 'Service', width: contentWidth - 120 },
        { key: 'rate', label: 'Rate (₹)', width: 120, align: 'right' },
      ],
      rows: services.map((s) => ({
        service: s.service_type_name || `Service #${s.service_type_id}`,
        rate: money(s.total_amount),
      })),
    });
  }
  doc.moveDown(1);

  drawSectionHeading(doc, 'Materials');
  // One row per client price GROUP — same unit exportMaterialRates used to
  // write per row before the Material/Brand/Price/State redesign; here it's
  // display-only, so the compact "one group, one line" view still reads best.
  const materialRows = [];
  for (const item of materialItems) {
    for (const g of item.groups || []) {
      materialRows.push({
        material: item.material_name || `Material #${item.material_id}`,
        brands: (g.brands || []).length === 0 ? 'No Brand' : g.brands.map((b) => b.brand_name).join(', '),
        price: money(g.price),
        statePrices: formatStateOverrides(g.states, stateNameById),
      });
    }
  }
  if (!materialRows.length) {
    doc.font(FONT_REGULAR).fontSize(10).fillColor(MUTED).text('No materials on this rate card.', left);
  } else {
    const w1 = Math.round(contentWidth * 0.28);
    const w2 = Math.round(contentWidth * 0.24);
    const w3 = Math.round(contentWidth * 0.16);
    drawTable(doc, {
      columns: [
        { key: 'material', label: 'Material', width: w1 },
        { key: 'brands', label: 'Brands', width: w2 },
        { key: 'price', label: 'Price (₹)', width: w3, align: 'right' },
        { key: 'statePrices', label: 'State Prices', width: contentWidth - w1 - w2 - w3 },
      ],
      rows: materialRows,
    });
  }

  // Page numbers — added after all content, so the total is known. Requires
  // `bufferPages: true` above (pdfkit keeps every page in memory until end()).
  //
  // The footer is drawn INSIDE the bottom margin, below doc.page.maxY() —
  // pdfkit's .text() checks the y position against the margin box even when
  // given explicit coordinates, and silently starts a BLANK page 2 the
  // moment it sees a y past that boundary (reproduced and confirmed: writing
  // one line at `height - margins.bottom + 12` on an otherwise one-page
  // document turns it into two). Zeroing margins.bottom for just this one
  // write is the standard pdfkit workaround — it never affects the content
  // that was already drawn above the (unchanged) real margin.
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const bottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font(FONT_REGULAR).fontSize(8).fillColor(MUTED).text(
      `Page ${i - range.start + 1} of ${range.count}`,
      left, doc.page.height - bottomMargin + 12,
      { width: contentWidth, align: 'center' },
    );
    doc.page.margins.bottom = bottomMargin;
  }

  doc.end();
}

module.exports = { renderRateCardPdf, money, formatStateOverrides };
