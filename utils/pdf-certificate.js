const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const fontkit = require('fontkit');
const sharp = require('sharp');
const logger = require('../logger');
const { todayIst } = require('./ist-calendar');

/*
 * A certificate renderer that knows NOTHING about EasyFix's domain.
 *
 *   renderCertificatePdf({ recipientName, title, eyebrow, heading, dateText,
 *                          certificateId, signatoryName, signatoryTitle, stream })
 *   await renderCertificateImage({ ...the same nine strings, format: 'png'|'jpg' })
 *
 * Required: recipientName, title, and (for the PDF) stream. Everything else has
 * a default or is omitted when absent.
 *
 * ─── ONE LAYOUT DECISION, TWO OUTPUTS ──────────────────────────────────────
 * planCertificate() is the ONLY thing that decides where a run goes and what
 * point size it survives at. Both renderers consume its output and neither may
 * measure, shrink or position anything itself. That is not tidiness: PDF and
 * image are the same document in two containers, and a second copy of the
 * fitting rule would disagree with the first the moment either was tweaked —
 * silently, because each output would still look correct on its own.
 *
 * The plan is computed at the TARGET canvas size, and every length in the
 * fitter (the point ceiling, the MIN_PT floor, the half-point step, the
 * tracking) scales with it. Fitting is linear in size, so a plan at 3508px
 * makes byte-for-byte the same decisions as one at 841.89pt, 4.17x larger.
 *
 * ─── WHY GENERIC ───────────────────────────────────────────────────────────
 * It used to take { technician, course, completedOn, score } and reach into
 * LMS-shaped objects. That made the ONE piece of artwork the company owns
 * usable by exactly one feature: a long-service award, a partner accreditation
 * or an operator-typed one-off each needed either a fake `course` object or a
 * second renderer that would immediately drift from this one's layout. Nine
 * strings in, one PDF out — the callers do the domain mapping (LMS's lives in
 * services/lms.service.js::certificatePayload).
 *
 * ─── WHY IT TAKES A STREAM ─────────────────────────────────────────────────
 * Unchanged, and the same contract as utils/pdf-invoice.js. routes/admin/
 * finance.js proves three delivery paths against that shape: pipe to `res` for
 * a download, to a buffer for an email attachment, into archiver for a ZIP. A
 * function returning a Buffer serves exactly one of those.
 *
 * ─── THE ARTWORK, AND WHY MISSING ART IS NOT AN ERROR ──────────────────────
 * The look comes from a Brand Kit background plus a sibling JSON naming where
 * each text run goes, both under assets/certificate/. pdfkit cannot read SVG,
 * so the PDF takes the 3508px raster; the image path prefers the vector frame
 * and falls back to that same raster, which is what keeps a PDF and a PNG
 * downloaded on the same day identical even when only one of the two frame
 * files has landed.
 *
 * If the background or the layout is missing or unreadable the renderer logs a
 * warning and draws the plain navy/gold border it always drew, using the same
 * region names from DEFAULT_LAYOUT. That is deliberate: the art and the code
 * ship on different clocks, and a download that 500s because a file has not
 * landed yet is worse than one that looks plain. There is exactly ONE placement
 * code path either way — the fallback is a different set of rectangles and a
 * few extra shapes in the plan, not a different renderer.
 *
 * ─── WHY EVERY RUN AUTO-SHRINKS ────────────────────────────────────────────
 * pdfkit flows text: a long name at a fixed size wraps and pushes everything
 * below it down a page that has no "below". Each run is measured against its
 * own rectangle and the point size steps down until it fits, with `ellipsis` as
 * the last backstop. So a 60-character name degrades predictably instead of
 * colliding with the line under it, and the layout is identical for everyone.
 *
 * ─── THE TYPE IS BUNDLED, AND THE SVG CARRIES NO TEXT ──────────────────────
 * Every face is a .ttf under assets/fonts/, embedded into the PDF with
 * registerFont and converted to <path> outlines for the SVG. Neither output
 * names a font, so neither can be resolved differently by the machine it runs
 * on.
 *
 * That is not a refinement, it is the fix for a production defect: the SVG used
 * to name "Helvetica, Liberation Sans, Nimbus Sans, Arial, sans-serif" and the
 * container is node:20-alpine, which ships no fonts at all. librsvg resolved
 * none of them, so every downloaded PNG and JPG had .notdef boxes where the
 * text should be while the frame artwork was perfect. It looked correct on a
 * developer's Mac only because macOS substitutes a fallback; there is nothing
 * in the image to substitute from. A name-referenced font makes the output a
 * property of the host, and there is no font package you can add to the image
 * that makes that untrue for the NEXT base image.
 *
 * fontkit rather than a second text-shaping library, because fontkit is the one
 * pdfkit already lays text out with: doc.widthOfString on an embedded face IS
 * font.layout(...).advanceWidth scaled, to the float. So the outlines drawn in
 * the SVG advance by the exact numbers planCertificate measured with, and the
 * shared fitting rule is shared in fact and not merely in intent.
 *
 * ─── NOTHING IS PERSISTED ──────────────────────────────────────────────────
 * No certificate table, no stored file, no issued_on, no revoke. The document
 * is a pure projection of facts that already exist, so rendering it twice
 * produces the same certificate and there is no issuance event to duplicate.
 * `certificateId` is passed IN by the caller (LMS derives it from the already
 * unique easyfixer_courses.id) — this file never mints one.
 */

const ARTWORK_DIR = path.join(__dirname, '..', 'assets', 'certificate');
const ARTWORK_PNG = path.join(ARTWORK_DIR, 'easyfix-certificate-frame-3508.png');
const ARTWORK_SVG = path.join(ARTWORK_DIR, 'easyfix-certificate-frame.svg');
const ARTWORK_LAYOUT = path.join(ARTWORK_DIR, 'certificate-layout.json');

/* A4 landscape in points — the PDF page, and the unit every STYLE size is in. */
const PT_W = 841.89;
const PT_H = 595.28;

/* The raster canvas: A4 landscape at 300dpi, the artwork's native size. */
const PX_W = 3508;
const PX_H = 2480;

/*
 * ─── THE FACES ─────────────────────────────────────────────────────────────
 *
 * Four .ttf files under assets/fonts/, all SIL OFL and licensed to embed —
 * provenance and licence texts in that directory's README. Bundled rather than
 * read out of EasyFix-Brand-Kit, so a container image needs nothing but this
 * repo to render a certificate correctly.
 *
 * The keys are what STYLE names and what gets registered on a pdfkit document,
 * so the PDF and the SVG cannot pick different files for one run.
 */
const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');
const FACES = Object.freeze({
  sans: 'IBMPlexSans-Regular.ttf',
  sansBold: 'IBMPlexSans-Bold.ttf',
  serifBold: 'PlayfairDisplay-Bold.ttf',
  script: 'GreatVibes-Regular.ttf',
});
const facePath = (key) => path.join(FONT_DIR, FACES[key]);

/*
 * Register every face on a document, whichever document it is — the measuring
 * one and the rendering one must resolve a face key to the same bytes or the
 * plan measures something the page does not draw. pdfkit only EMBEDS a
 * registered font once font() actually selects it, so registering all four
 * costs nothing on a certificate that uses three.
 */
function registerFaces(doc) {
  for (const key of Object.keys(FACES)) doc.registerFont(key, facePath(key));
  return doc;
}

/* fontkit instances for the SVG outlines. Same files, opened once per process. */
const faceCache = new Map();
function face(key) {
  if (!faceCache.has(key)) faceCache.set(key, fontkit.openSync(facePath(key)));
  return faceCache.get(key);
}

const NAVY = '#12305B';
const GOLD = '#B8912F';
const INK = '#111111';
const MUTED = '#5A5A5A';
/* The brand red the frame's own bands are printed in. */
const BRAND_RED = '#C42430';
/* One step darker, so the title reads as subordinate to the heading. */
const DEEP_RED = '#8E1B24';

const MIN_PT = 6;

const DEFAULT_HEADING = 'CERTIFICATE OF COMPLETION';
const DEFAULT_EYEBROW = 'FOR SUCCESSFULLY COMPLETING THE TRAINING';
const PRESENTED_TO = 'THIS CERTIFICATE IS PROUDLY PRESENTED TO';
const DATE_LABEL = 'DATE';
const SITE = 'www.easyfix.in';

/*
 * Fallback rectangles, normalised 0..1 exactly like the shipped layout file, so
 * the placement loop below cannot tell the two apart. Region names are the
 * contract with the Brand Kit artefact.
 */
const DEFAULT_LAYOUT = Object.freeze({
  heading:            { x: 0.10, y: 0.135, w: 0.80, h: 0.070 },
  eyebrowPresentedTo: { x: 0.20, y: 0.255, w: 0.60, h: 0.038 },
  recipientName:      { x: 0.08, y: 0.310, w: 0.84, h: 0.110 },
  eyebrowFor:         { x: 0.15, y: 0.450, w: 0.70, h: 0.040 },
  title:              { x: 0.10, y: 0.505, w: 0.80, h: 0.080 },
  dateValue:          { x: 0.12, y: 0.740, w: 0.26, h: 0.050 },
  dateLabel:          { x: 0.12, y: 0.810, w: 0.26, h: 0.032 },
  signatoryName:      { x: 0.62, y: 0.740, w: 0.26, h: 0.050 },
  signatoryTitle:     { x: 0.62, y: 0.810, w: 0.26, h: 0.032 },
  /*
   * 0.885, not 0.92. Measured: at 0.92 the id baseline lands ON the inner gold
   * rule the fallback draws at H-36, so a rendered certificate had the number
   * struck through by its own border. The rectangle has to clear that rule, not
   * merely sit inside the page.
   */
  certificateIdLine:  { x: 0.30, y: 0.885, w: 0.40, h: 0.028 },
});

/*
 * Per-region typography. Sizes are a CEILING in POINTS — fitting shrinks, never
 * grows, and a rectangle shorter than the ceiling caps it first.
 *
 * The heading is the design: large, brand red, serif, and tracked wide enough
 * to span most of its rectangle (measured, at the vendored layout: 651pt of a
 * 697pt box). It used to be 15pt grey sans, which is why the output read as a
 * form rather than as a certificate.
 */
const STYLE = Object.freeze({
  heading:            { font: 'serifBold', size: 30, color: BRAND_RED, tracking: 8 },
  eyebrowPresentedTo: { font: 'sans',      size: 9,  color: MUTED, tracking: 3 },
  recipientName:      { font: 'sansBold',  size: 31, color: INK, upper: true },
  eyebrowFor:         { font: 'sans',      size: 9,  color: MUTED, tracking: 3 },
  title:              { font: 'sansBold',  size: 25, color: DEEP_RED },
  dateValue:          { font: 'sans',      size: 12, color: INK },
  dateLabel:          { font: 'sans',      size: 8,  color: MUTED, tracking: 2 },
  signatoryName:      { font: 'script',    size: 20, color: INK },
  signatoryTitle:     { font: 'sans',      size: 8,  color: MUTED, tracking: 2, upper: true },
  certificateIdLine:  { font: 'sans',      size: 8,  color: MUTED, tracking: 0.5 },
});

/*
 * The wordmark the plain-border fallback prints where the frame's logo would
 * be. Deliberately NOT in DEFAULT_LAYOUT: that object is the contract with the
 * design pipeline (every key in it may be overridden by the layout file), and
 * this run exists only when there is no pipeline output to override it.
 */
const FALLBACK_MARK_RECT = Object.freeze({ x: 0.05, y: 0.085, w: 0.90, h: 0.055 });
const FALLBACK_MARK_STYLE = Object.freeze({ font: 'sansBold', size: 26, color: NAVY });

/*
 * One rectangle, tolerantly. The layout file is authored by a design pipeline
 * rather than by this repo, so {x,y,w,h}, {x,y,width,height} and [x,y,w,h] are
 * all accepted; anything else is treated as absent and that ONE region falls
 * back rather than taking the whole document down.
 */
function toRect(v) {
  if (!v) return null;
  const a = Array.isArray(v)
    ? v
    : [v.x, v.y, v.w !== undefined ? v.w : v.width, v.h !== undefined ? v.h : v.height];
  const [x, y, w, h] = a.map(Number);
  if (![x, y, w, h].every(Number.isFinite)) return null;
  if (w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

/*
 * Read the layout file into 0..1 rectangles.
 *
 * The `canvas` block is what makes pixel rectangles survivable: the contract
 * says normalised, but a generator that emits pixels produces numbers far
 * outside 0..1, and drawing those would put every line off the page with no
 * error anywhere. Dividing by the declared canvas is a strictly better failure
 * than a blank certificate, so it is done rather than detected.
 */
function readLayout(raw) {
  const src = raw.regions || raw.rects || raw;
  const canvas = raw.canvas || raw.size || {};
  const cw = Number(canvas.width) || Number(raw.width) || 0;
  const ch = Number(canvas.height) || Number(raw.height) || 0;

  const out = {};
  for (const name of Object.keys(DEFAULT_LAYOUT)) {
    const rect = toRect(src[name]);
    if (!rect) continue;
    const pixels = [rect.x, rect.y, rect.w, rect.h].some((n) => n > 1.5);
    if (pixels) {
      if (!(cw > 0 && ch > 0)) continue;
      out[name] = { x: rect.x / cw, y: rect.y / ch, w: rect.w / cw, h: rect.h / ch };
    } else {
      out[name] = rect;
    }
  }
  return { regions: out, canvasWidth: cw, canvasHeight: ch };
}

/*
 * Both artwork files or neither. `recipientName` and `title` are the two runs
 * whose position cannot be guessed from the rest, so a layout missing either is
 * treated as unusable and the whole render falls back — a half-placed document
 * on company letterhead is worse than a plain one.
 *
 * Read per render rather than cached: a certificate is a per-download event,
 * the JSON is a couple of KB, and a cache here would mean a redeployed frame
 * needs a container restart to appear.
 */
function loadArtwork(framePath) {
  const hasFrame = fs.existsSync(framePath);
  const hasLayout = fs.existsSync(ARTWORK_LAYOUT);
  if (!hasFrame || !hasLayout) {
    logger.warn('Certificate artwork missing · frame=' + hasFrame + ' · layout=' + hasLayout
      + ' · rendering the plain-border fallback (expected under ' + ARTWORK_DIR + ')');
    return null;
  }
  try {
    const parsed = readLayout(JSON.parse(fs.readFileSync(ARTWORK_LAYOUT, 'utf8')));
    if (!parsed.regions.recipientName || !parsed.regions.title) {
      logger.warn('Certificate layout has no recipientName/title rectangle · plain-border fallback');
      return null;
    }
    return { ...parsed, framePath };
  } catch (e) {
    logger.warn('Certificate layout unreadable · ' + e.message + ' · plain-border fallback');
    return null;
  }
}

/*
 * THE measuring device, for both outputs.
 *
 * The embedded faces' own metrics decide every shrink step, and the image path
 * draws outlines from the SAME fontkit layout pdfkit measured with — so the two
 * cannot fit text differently, on any host, for any reason. A throwaway
 * document per render would be pure allocation: nothing is ever drawn on this
 * one, planCertificate is synchronous, and Node is single threaded, so no two
 * plans can interleave on its font state.
 */
let measurer = null;
function measured(font, size) {
  if (!measurer) {
    measurer = registerFaces(new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0 }));
  }
  measurer.font(font).fontSize(size);
  return measurer;
}

/*
 * Place one run inside its rectangle, centred, shrinking to fit.
 *
 * Height first: a point size taller than the box can never fit, so it is capped
 * before a single width measurement. Then width, in half-point steps, down to
 * MIN_PT. What MIN_PT still cannot hold — an unbroken 200-character string — is
 * TRUNCATED here rather than left to pdfkit's `ellipsis`, because SVG has no
 * equivalent and a rule the two renderers cannot both obey is not a shared
 * rule. So the worst case is a truncated line, never a line that runs over the
 * one below it, in either format.
 *
 * Every length scales with the canvas, so this returns the same decision at
 * 841.89pt and at 3508px.
 */
function fitRun(name, raw, rect, style, scale) {
  const minPt = MIN_PT * scale;
  const step = 0.5 * scale;
  const tracking = (style.tracking || 0) * scale;
  const opts = { characterSpacing: tracking };
  const widthAt = (s, str) => measured(style.font, s).widthOfString(str, opts);

  /*
   * Case is typography, so it belongs to STYLE and is applied BEFORE the
   * fitter measures — uppercasing a name after fitting it would measure a
   * string nobody draws, and caps are ~12% wider.
   */
  const text = style.upper ? raw.toUpperCase() : raw;

  let size = Math.min(style.size * scale, rect.h / 1.25);
  while (size > minPt && widthAt(size, text) > rect.w) size = Math.max(minPt, size - step);

  /*
   * Only what MIN_PT still could not hold. The guard is not decoration: the
   * loop measures `out + '…'`, which is WIDER than `out`, so without it a run
   * that fits perfectly well gets a character shaved off and an ellipsis added
   * — measured, on a 66-character name that the shrink step had already made
   * fit. Both outputs truncated it identically, which is exactly why sharing
   * the rule is not the same as the rule being right.
   */
  let out = text;
  if (widthAt(size, out) > rect.w) {
    while (out.length > 1 && widthAt(size, out + '…') > rect.w) out = out.slice(0, -1);
    out += '…';
  }

  const doc = measured(style.font, size);
  const lineHeight = doc.currentLineHeight();
  const ascender = (doc._font && doc._font.ascender) || 718;
  const top = rect.y + Math.max(0, (rect.h - lineHeight) / 2);
  /*
   * Centring is a PLACEMENT decision, so it is made here once and both
   * renderers are handed the answer. It used to be made twice — pdfkit's
   * align:'center' on one side, text-anchor="middle" on the other — and the
   * two disagreed, because SVG counts a trailing tracking unit that pdfkit's
   * width does not; the old code carried a hand-measured half-tracking fudge
   * to paper over it. One x, computed from the width the fitter already
   * measured, removes the disagreement instead of correcting for it.
   */
  const width = widthAt(size, out);
  return {
    name,
    text: out,
    rect,
    size,
    tracking,
    font: style.font,
    color: style.color,
    top,
    width,
    x: rect.x + Math.max(0, (rect.w - width) / 2),
    baseline: top + (ascender / 1000) * size,
  };
}

const isBlank = (v) => v === null || v === undefined || String(v).trim() === '';

/*
 * THE layout decision. Everything either renderer needs, and nothing either
 * renderer may decide for itself.
 *
 * `frames` is the ordered list of background files this output can actually
 * display — the PDF passes only the raster because pdfkit cannot read SVG, the
 * image path passes the vector first. The first one on disk wins; if none is,
 * the whole render falls back, which is why `framePath` comes back out on the
 * plan rather than being recomputed by the caller.
 */
function planCertificate(values, W, H, frames) {
  const scale = W / PT_W;
  const art = loadArtwork(frames.find((f) => fs.existsSync(f)) || frames[frames.length - 1]);
  const layout = art ? art.regions : {};
  const rect = (r) => ({ x: r.x * W, y: r.y * H, w: r.w * W, h: r.h * H });
  const regionRect = (name) => rect(layout[name] || DEFAULT_LAYOUT[name]);

  /*
   * `dateText` defaults to today in IST — deliberately IST and not the server's
   * clock, because the containers run UTC and a certificate issued at 09:00 IST
   * would otherwise be dated the previous day for four and a half hours every
   * night. Passing null or '' omits the date PAIR: never a "DATE" label with
   * nothing under it.
   */
  const date = values.dateText === undefined ? formatDate(todayIst()) : values.dateText;

  const wanted = [
    ['heading', values.heading || DEFAULT_HEADING],
    ['eyebrowPresentedTo', PRESENTED_TO],
    ['recipientName', values.recipientName],
    ['eyebrowFor', values.eyebrow || DEFAULT_EYEBROW],
    ['title', values.title],
    ['dateValue', date],
    ['dateLabel', date ? DATE_LABEL : ''],
    ['signatoryName', values.signatoryName],
    ['signatoryTitle', values.signatoryName ? values.signatoryTitle : ''],
    /*
     * One footer line, composed here rather than by each caller: the id and the
     * site are a single centred caption in the reference, and a caller that
     * built the string itself would be free to build a different one.
     */
    ['certificateIdLine', isBlank(values.certificateId)
      ? '' : `Certificate ID: ${String(values.certificateId).trim()} · ${SITE}`],
  ];

  const runs = [];
  if (!art) {
    runs.push(fitRun('brandMark', 'EasyFix', rect(FALLBACK_MARK_RECT), FALLBACK_MARK_STYLE, scale));
  }
  /*
   * The omission rule, in one place: an empty value draws nothing at all. That
   * is what keeps a certificate with no signatory from printing a bare rule
   * with "Training Head" floating under it, and a manual render with no id from
   * printing an empty caption.
   */
  for (const [name, value] of wanted) {
    if (isBlank(value)) continue;
    runs.push(fitRun(name, String(value).trim(), regionRect(name), STYLE[name], scale));
  }

  /*
   * The rules are part of the artwork when there IS artwork. Planned here only
   * for the fallback, and the underlines only under a block that actually has
   * content — a rule with nothing above it reads as a field somebody forgot.
   */
  const shapes = [];
  if (!art) {
    const under = (r) => ({
      kind: 'line', x1: r.x, y1: r.y + r.h + 4 * scale, x2: r.x + r.w, y2: r.y + r.h + 4 * scale,
      stroke: GOLD, lineWidth: 0.5 * scale,
    });
    shapes.push(
      { kind: 'rect', x: 24 * scale, y: 24 * scale, w: W - 48 * scale, h: H - 48 * scale, stroke: NAVY, lineWidth: 3 * scale },
      { kind: 'rect', x: 36 * scale, y: 36 * scale, w: W - 72 * scale, h: H - 72 * scale, stroke: GOLD, lineWidth: 1.5 * scale },
      { kind: 'line', x1: W / 2 - 60 * scale, y1: 0.225 * H, x2: W / 2 + 60 * scale, y2: 0.225 * H, stroke: GOLD, lineWidth: 1 * scale },
    );
    if (date) shapes.push(under(regionRect('dateValue')));
    if (values.signatoryName) shapes.push(under(regionRect('signatoryName')));
  }

  if (art && art.canvasWidth > 0 && art.canvasHeight > 0) {
    const drift = Math.abs((art.canvasWidth / art.canvasHeight) - (W / H));
    if (drift > 0.02) {
      logger.warn('Certificate frame aspect differs from the page by ' + drift.toFixed(3)
        + ' · the background will be stretched to fill it');
    }
  }

  return { art, runs, shapes, scale, width: W, height: H };
}

/*
 * ─── OUTPUT 1: the PDF ─────────────────────────────────────────────────────
 *
 * Takes a stream, same contract as utils/pdf-invoice.js: routes/admin/
 * finance.js proves three delivery paths against that shape — pipe to `res`,
 * to a buffer for an email attachment, into archiver for a ZIP. A function
 * returning a Buffer serves exactly one of those.
 */
function renderCertificatePdf({ stream, ...values }) {
  /* Landscape: a certificate is read as a wall document, not a report page. */
  const doc = registerFaces(new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0 }));
  doc.pipe(stream);

  const W = doc.page.width;
  const H = doc.page.height;
  /* Raster only: pdfkit cannot read SVG, so the vector frame is not offered. */
  const plan = planCertificate(values, W, H, [ARTWORK_PNG]);

  if (plan.art) doc.image(plan.art.framePath, 0, 0, { width: W, height: H });

  for (const s of plan.shapes) {
    doc.lineWidth(s.lineWidth).strokeColor(s.stroke);
    if (s.kind === 'rect') doc.rect(s.x, s.y, s.w, s.h).stroke();
    else doc.moveTo(s.x1, s.y1).lineTo(s.x2, s.y2).stroke();
  }

  /*
   * Drawn at the plan's own x, not with align:'center'. pdfkit would otherwise
   * re-centre from a width it measures itself, which is a second placement
   * decision — and the SVG has no way to ask pdfkit what it decided.
   * `lineBreak: false` because fitRun has already guaranteed the run fits, and
   * its explicit truncation is the backstop that pdfkit's `ellipsis` cannot be
   * (SVG has no equivalent, so a rule only one output can obey is not shared).
   */
  for (const r of plan.runs) {
    doc.font(r.font).fillColor(r.color).fontSize(r.size)
      .text(r.text, r.x, r.top, { lineBreak: false, characterSpacing: r.tracking });
  }

  doc.end();
}

/*
 * One run as OUTLINE PATH DATA — the whole point of this file's font handling.
 *
 * fontkit.layout() is the same call pdfkit makes to lay the run out in the PDF,
 * so the glyphs, their order, their kerning and their advances are not merely
 * similar to the PDF's: they are the same numbers. The pen walks those
 * advances plus the plan's tracking (between glyphs, which is exactly what
 * widthOfString counted), starting at the plan's x.
 *
 * The transform flips y — font units run upward from a baseline at 0, SVG's
 * run downward from the top — and scales by size/unitsPerEm. transform()
 * returns a new Path, so the font's cached glyph outlines are never mutated.
 */
function outlineRun(r) {
  const f = face(r.font);
  const s = r.size / f.unitsPerEm;
  const laid = f.layout(r.text);
  const parts = [];
  let pen = r.x;
  for (let i = 0; i < laid.glyphs.length; i++) {
    const p = laid.positions[i];
    const d = laid.glyphs[i].path
      .transform(s, 0, 0, -s, pen + p.xOffset * s, r.baseline - p.yOffset * s)
      .toSVG();
    /*
     * Not decoration. A non-finite pen position makes a path emitter write the
     * literal string "NaN" into the data, and an invalid path is DROPPED by the
     * rasteriser with no error — which is the same silent blank the font stack
     * used to produce. Fail loudly and name the run instead.
     */
    if (/NaN|Infinity/.test(d)) {
      throw new Error(`non-finite outline for ${r.name} glyph ${i} of ${JSON.stringify(r.text)}`);
    }
    if (d) parts.push(d);
    pen += p.xAdvance * s + r.tracking;
  }
  return parts.join('');
}

/*
 * The plan as SVG. Text only when there is a frame — the frame is composited
 * underneath by sharp, because nesting one SVG document inside another is a
 * feature rasterisers disagree about and a stretched <image> is not.
 *
 * NO <text> AND NO font-family, deliberately and permanently. Naming a font
 * hands the rendering to whatever fontconfig happens to resolve, which on the
 * node:20-alpine image this deploys to is nothing at all: the shipped
 * certificates had a row of .notdef boxes for every line. Outlines are
 * geometry, so the raster is now identical on Alpine, on a Mac, and on a
 * machine with no fonts installed whatsoever — which is what the empty
 * fontconfig test in tests/certificate-render.test.js proves rather than
 * assumes.
 */
function certificateSvg(plan) {
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${plan.width}" height="${plan.height}" `
    + `viewBox="0 0 ${plan.width} ${plan.height}">`,
  ];
  for (const s of plan.shapes) {
    parts.push(s.kind === 'rect'
      ? `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" fill="none" `
        + `stroke="${s.stroke}" stroke-width="${s.lineWidth}"/>`
      : `<line x1="${s.x1}" y1="${s.y1}" x2="${s.x2}" y2="${s.y2}" `
        + `stroke="${s.stroke}" stroke-width="${s.lineWidth}"/>`);
  }
  for (const r of plan.runs) {
    parts.push(`<path data-run="${r.name}" fill="${r.color}" d="${outlineRun(r)}"/>`);
  }
  parts.push('</svg>');
  return parts.join('\n');
}

/*
 * ─── OUTPUT 2: the raster ──────────────────────────────────────────────────
 *
 * Returns a Buffer rather than taking a stream: sharp is async and produces one
 * buffer at the end anyway, so a stream here would only be a Buffer wearing a
 * costume, and buffering is what lets a failure still become a JSON error
 * instead of a truncated image behind a 200.
 *
 * The vector frame is preferred and the 3508px raster is the fallback, so a
 * PNG and a PDF pulled on a day when only the raster has landed are still the
 * same document. `fit: 'fill'` matches what pdfkit does with an off-aspect
 * background — stretch, do not letterbox — so neither output crops the other's
 * margins away.
 */
async function renderCertificateImage({ format = 'png', ...values }) {
  const plan = planCertificate(values, PX_W, PX_H, [ARTWORK_SVG, ARTWORK_PNG]);
  const overlay = Buffer.from(certificateSvg(plan));

  /*
   * flatten() is on the BACKGROUND, and it is load-bearing rather than tidy:
   * sharp applies it before the composite whatever order it is called in, and
   * measured, a frame with a transparent ground encodes to BLACK in JPEG
   * without it — not white, and not an error. Whitening the ground first is
   * also what leaves the composited result opaque in PNG.
   */
  const base = (plan.art
    ? sharp(plan.art.framePath, { density: 300 }).resize(PX_W, PX_H, { fit: 'fill' })
    : sharp({ create: { width: PX_W, height: PX_H, channels: 3, background: '#FFFFFF' } })
  ).flatten({ background: '#FFFFFF' });

  const composed = base.composite([{ input: overlay, top: 0, left: 0 }]);
  return format === 'jpg'
    ? composed.jpeg({ quality: 95 }).toBuffer()
    : composed.png().toBuffer();
}

/*
 * 'YYYY-MM-DD…' → '30 August 2026'.
 *
 * The pool runs with dateStrings, so a DATETIME arrives as 'YYYY-MM-DD HH:mm:ss'
 * ALREADY in IST. Parsing that into a Date and formatting it locally is the
 * naive-parse shift that has bitten this codebase repeatedly, so the digits are
 * sliced out of the string and reformatted directly. Only a real Date takes the
 * other branch, and it is read in UTC because todayIst() produces a UTC-shifted
 * calendar date.
 */
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

function formatDate(v) {
  if (!v) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
  if (m) {
    const month = MONTHS[Number(m[2]) - 1];
    return month ? `${m[3]} ${month} ${m[1]}` : '—';
  }
  const d = v instanceof Date ? v : new Date(String(v));
  if (Number.isNaN(d.getTime())) return '—';
  return `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/* The content types and filename extensions the two outputs are served under. */
const OUTPUT_FORMATS = Object.freeze({
  pdf: { contentType: 'application/pdf', ext: 'pdf' },
  png: { contentType: 'image/png', ext: 'png' },
  jpg: { contentType: 'image/jpeg', ext: 'jpg' },
});

module.exports = {
  renderCertificatePdf,
  renderCertificateImage,
  planCertificate,
  certificateSvg,
  formatDate,
  OUTPUT_FORMATS,
  // The brand red every other letterhead/PDF artifact should match — see
  // utils/pdf-letterhead.js, which imports this rather than re-declaring the
  // hex so the two files cannot drift apart.
  BRAND_RED,
  ARTWORK_DIR,
  ARTWORK_PNG,
  ARTWORK_SVG,
  ARTWORK_LAYOUT,
  DEFAULT_LAYOUT,
  FONT_DIR,
  FACES,
  STYLE,
  PX_W,
  PX_H,
};
