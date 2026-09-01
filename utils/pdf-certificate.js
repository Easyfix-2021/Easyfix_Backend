const PDFDocument = require('pdfkit');

/*
 * EasyFix course-completion certificate.
 *
 * Inputs:
 *   technician  — { efr_name, efr_no }
 *   course      — { name }
 *   completedOn — Date | string, easyfixer_courses.completion_date
 *   score       — number | null, easyfixer_courses.score (percent); omitted
 *                 from the certificate when null, because a course with no
 *                 assessment has no score and a printed "0%" would read as a
 *                 failure rather than an absence
 *   stream      — writable; the doc is piped here. For HTTP this is `res`.
 *
 * ─── WHY THIS TAKES A STREAM ────────────────────────────────────────────────
 * Same contract as utils/pdf-invoice.js on purpose. That one shape already
 * gives three delivery paths for free, because routes/admin/finance.js proves
 * all three against it: pipe to `res` for a download, pipe to a buffer for an
 * email attachment, pipe into archiver for a ZIP. A function that returned a
 * Buffer would work for exactly one of those.
 *
 * ─── WHY HELVETICA AND NO LOGO ──────────────────────────────────────────────
 * pdfkit cannot read the CRM's woff2 faces or its SVG marks, so "use the brand
 * font" is not a package away — it is vendoring a TTF and a PNG into the
 * repo. The live client invoice already renders "EasyFix" as plain Helvetica
 * text, so this is consistent with the artifact a client already receives.
 * When someone actually objects to the look, the change is
 * doc.registerFont(...) plus doc.image(...) and nothing else moves.
 *
 * ─── NOTHING IS PERSISTED ───────────────────────────────────────────────────
 * There is no certificate table, no serial number and no issued_on. This
 * document is a pure projection of facts that already exist, so rendering it
 * twice produces the same certificate and there is no issuance event that
 * could be duplicated. Minting a serial would create an idempotency problem
 * that does not otherwise exist; if one is ever demanded, easyfixer_courses.id
 * is already unique per technician per course and is what the points award
 * keys on.
 */
function renderCertificatePdf({ technician, course, completedOn, score, stream }) {
  /* Landscape: a certificate is read as a wall document, not a report page. */
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0 });
  doc.pipe(stream);

  /*
   * Y positions are literal, not flowed. pdfkit's cursor-based flow makes a
   * long course title push everything below it down the page — on a fixed
   * one-page artifact that silently collides the meta line with the footer.
   * Absolute positions plus per-block `height` + `ellipsis` mean a long value
   * truncates instead of reflowing, so the layout is identical for every
   * technician regardless of how long their name is.
   */
  const W = doc.page.width;
  const H = doc.page.height;
  const NAVY = '#12305B';
  const GOLD = '#B8912F';
  const INK = '#1A1A1A';
  const MUTED = '#5A5A5A';

  /* Double rule border, drawn rather than imaged so there is no asset to ship. */
  doc.lineWidth(3).strokeColor(NAVY).rect(24, 24, W - 48, H - 48).stroke();
  doc.lineWidth(1.5).strokeColor(GOLD).rect(36, 36, W - 72, H - 72).stroke();

  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(26)
    .text('EasyFix', 0, 96, { align: 'center', width: W });

  doc.fillColor(MUTED).font('Helvetica').fontSize(11)
    .text('CERTIFICATE OF COMPLETION', 0, 134, { align: 'center', width: W, characterSpacing: 3 });

  doc.moveTo(W / 2 - 60, 162).lineTo(W / 2 + 60, 162).lineWidth(1).strokeColor(GOLD).stroke();

  doc.fillColor(MUTED).font('Helvetica').fontSize(12)
    .text('This is to certify that', 0, 196, { align: 'center', width: W });

  /*
   * The name is the one field that can genuinely overflow — a long name at
   * 30pt would wrap into the course title below it. pdfkit's `height` +
   * `ellipsis` keeps it on one line and truncates rather than reflowing the
   * page, which is the failure a reader would actually notice.
   */
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(30)
    .text(String(technician?.efr_name || '—'), 60, 222, {
      align: 'center', width: W - 120, height: 40, ellipsis: true, lineBreak: false,
    });

  doc.fillColor(MUTED).font('Helvetica').fontSize(12)
    .text('has successfully completed the course', 0, 276, { align: 'center', width: W });

  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(20)
    .text(String(course?.name || '—'), 60, 302, {
      align: 'center', width: W - 120, height: 30, ellipsis: true, lineBreak: false,
    });

  const parts = [`Completed on ${formatDate(completedOn)}`];
  if (score !== null && score !== undefined && Number.isFinite(Number(score))) {
    parts.push(`Score ${Math.round(Number(score))}%`);
  }
  doc.fillColor(MUTED).font('Helvetica').fontSize(11)
    .text(parts.join('   ·   '), 0, 348, { align: 'center', width: W });

  /* Footer: identity on the left, issuer on the right. */
  const footY = H - 92;
  doc.fillColor(MUTED).font('Helvetica').fontSize(9);
  if (technician?.efr_no) {
    doc.text(`Technician ID: ${technician.efr_no}`, 60, footY, { align: 'left', width: 260 });
  }
  doc.text('EasyFix Learning', W - 320, footY, { align: 'right', width: 260 });
  doc.moveTo(W - 320, footY + 16).lineTo(W - 60, footY + 16).lineWidth(0.5).strokeColor(GOLD).stroke();

  doc.end();
}

/*
 * The pool runs with dateStrings, so completion_date arrives as
 * 'YYYY-MM-DD HH:mm:ss' already in IST. Parsing that into a Date and
 * re-formatting it locally would shift it — the naive-parse trap. Slice the
 * date part off the string and reformat the digits directly; only a real Date
 * (which nothing on this path produces today) takes the other branch.
 */
function formatDate(v) {
  if (!v) return '—';
  const s = String(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  const d = v instanceof Date ? v : new Date(s);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
}

module.exports = { renderCertificatePdf, formatDate };
