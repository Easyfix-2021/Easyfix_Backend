'use strict';
/*
 * The single combined Download button (2026-09-21 redesign) — replaces the
 * CRM's two per-tab Rate Card Download buttons with ONE workbook (Services +
 * Materials sheets) and a letterhead PDF, both at
 * GET /:clientId/rate-cards/export.{xlsx,pdf}.
 *
 * Covers:
 *   1. Combined xlsx — exactly two sheets, "Services" and "Materials", whose
 *      rows match what the SINGLE-sheet exporters would write for the same
 *      data (services/client-xlsx.service.js#exportRateCards/
 *      exportMaterialRates) — proven by calling both and diffing rows, not by
 *      re-deriving the expected shape by hand.
 *   2. The combined workbook round-trips through BOTH tab uploads (Services
 *      picks the "Services" sheet, Materials picks the "Materials" sheet —
 *      see rate-card-bulk-upload.service.js#namedOrFirstSheet) with every row
 *      'unchanged'.
 *   3. The PDF — application/pdf, starts with %PDF, its own TEXT (inflated +
 *      decoded from the content stream, not just "more than 1KB") contains
 *      the company name, the client name and a service rate, and does NOT
 *      contain the internal split column headers ("Easyfix Direct",
 *      "Overhead") — the owner's explicit margin-structure requirement.
 *   4. Out-of-scope client refused identically on both routes.
 *
 * fake-pool harness throughout (no real DB) — see tests/helpers/fake-pool.js.
 */
const { test, describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const { installFakePool } = require('./helpers/fake-pool');

const CLIENT_ID = 913;
const ZONAL_ROLE = { role_id: 12, role_name: 'Zonal Field Team', role_status: 1, menu_ids: '' };
const allowClients = (...ids) => ({
  clients: { mode: 'allow', ids }, cities: { mode: 'all', ids: [] },
  states: { mode: 'all', ids: [] }, verticals: { mode: 'all', ids: [] },
});

/*
 * Decodes the TEXT a pdfkit-produced PDF actually draws — inflates every
 * FlateDecode content stream and reads its TJ/Tj operators. Deliberately NOT
 * the fuller decoder tests/certificate-render.test.js carries (ToUnicode CMap
 * resolution for an EMBEDDED subset font): this PDF only ever uses the
 * standard, non-embedded Helvetica/Helvetica-Bold faces (see
 * utils/pdf-letterhead.js), which pdfkit writes as plain WinAnsiEncoding byte
 * codes — a latin1 decode of the hex is the whole answer, no CMap needed.
 * Reuses only the built-in `zlib` this repo already depends on — no new
 * dependency, per the "pdfkit output is compressed" note in the brief.
 */
function pdfText(buf) {
  let out = '';
  let i = 0;
  while ((i = buf.indexOf('stream', i)) !== -1) {
    let start = i + 'stream'.length;
    if (buf[start] === 0x0d) start += 1;
    if (buf[start] === 0x0a) start += 1;
    const end = buf.indexOf('endstream', start);
    if (end === -1) break;
    try {
      const text = zlib.inflateSync(buf.subarray(start, end)).toString('latin1');
      if (/\bTJ\b|\bTj\b/.test(text)) {
        for (const m of text.matchAll(/\[((?:\s*(?:<[0-9A-Fa-f]*>|-?[\d.]+))+)\]\s*TJ/g)) {
          for (const hex of m[1].matchAll(/<([0-9A-Fa-f]*)>/g)) out += Buffer.from(hex[1], 'hex').toString('latin1');
          out += ' ';
        }
        for (const m of text.matchAll(/\(((?:[^()\\]|\\.)*)\)\s*Tj/g)) out += `${m[1]} `;
      }
    } catch { /* not a flate-compressed stream (e.g. a raw font program) */ }
    i = end + 'endstream'.length;
  }
  return out;
}

function baseFixtures() {
  return [
    [/FROM tbl_client\b/i, () => [{ client_id: CLIENT_ID, client_name: 'A10 Design', vertical_id: 3 }]],
    [/SELECT vertical_name FROM tbl_vertical/i, () => [{ vertical_name: 'Furniture' }]],
    // rate-card-bulk-upload.service.js#loadServiceTypeRef — needed for the
    // Services-tab upload round-trip test below.
    [/FROM tbl_service_type WHERE service_type_status <> 3/i, () => [
      { service_type_id: 10, service_type_name: 'AC Installation', service_type_status: 1, service_catg_id: 3 },
    ]],
    // rate-card-bulk-upload.service.js#loadExistingClientServiceByType — same
    // costs as the fixture below, so the round-trip preview is 'unchanged'.
    [/COALESCE\(easyfix_direct_fixed,0\)/i, () => [
      { client_service_id: 501, service_type_id: 10, easyfix_direct_fixed: 200, easyfix_direct_variable: 10, overhead_fixed: 10, overhead_variable: 20, client_fixed: 0, client_variable: 0 },
    ]],
    // rateCardsSvc.listForClient — one service with a known total_amount.
    [/COALESCE\(cs\.easyfix_direct_fixed/i, () => [{
      client_service_id: 501, service_type_id: 10, rate_card_id: null, crc_ratecard_name: null,
      easyfix_direct_fixed: 200, easyfix_direct_variable: 10, overhead_fixed: 10, overhead_variable: 20,
      client_fixed: 0, client_variable: 0, total_amount: 400,
      service_type_name: 'AC Installation', service_catg_id: 3,
    }]],
    // rate-card-bulk-upload.service.js#loadMaterialRatesRef — needed for the
    // Materials-tab upload round-trip test below.
    [/SELECT material_id, material_name FROM tbl_material_master WHERE status = 1/i, () => [{ material_id: 700, material_name: 'PVC Pipe' }]],
    [/SELECT brand_id, brand_name, brand_key FROM tbl_brand_master WHERE status = 1/i, () => []],
    [/SELECT state_id, state_name FROM tbl_state\b/i, () => [{ state_id: 21, state_name: 'Maharashtra' }]],
    // materialRatesSvc.list() chain — one No-Brand material, one state override.
    [/FROM tbl_client_material_price_group g\b/i, () => [{ group_id: 9001, material_id: 700, price: 150, master_price_seen: 150, status: 1 }]],
    [/FROM tbl_material_master\b/i, () => [{ material_id: 700, material_name: 'PVC Pipe', pricing_type: 'per_unit' }]],
    [/FROM tbl_client_material_price_group_brand gb/i, () => []],
    [/FROM tbl_client_material_state_price\s+WHERE/i, () => [{ state_price_id: 701, group_id: 9001, price: 275 }]],
    [/FROM tbl_client_material_state_price_state/i, () => [{ state_price_id: 701, state_id: 21 }]],
    [/FROM tbl_material_price_group g\b/i, () => [{ price: 150 }]],
    [/FROM tbl_material_price_group_brand gb/i, () => []],
    [/FROM tbl_state ORDER BY state_name/i, () => [{ state_id: 21, state_name: 'Maharashtra' }]],
  ];
}

describe('GET /:clientId/rate-cards/export.{xlsx,pdf}', () => {
  let fake;
  let server;
  let baseUrl;
  let scope;

  before(async () => {
    fake = installFakePool(baseFixtures());
    const express = require('express');
    const clientsRouter = require('../routes/admin/clients');
    const app = express();
    app.use((req, _res, next) => {
      req.user = { user_id: 1, user_name: 'Tester' };
      req.userRole = { ...ZONAL_ROLE };
      if (scope !== 'absent') req.scope = scope;
      next();
    });
    app.use('/clients', clientsRouter);
    app.use((err, _req, res, _next) => { res.status(500).json({ success: false, error: String(err && err.message) }); });
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    fake.restore();
    if (server) await new Promise((resolve) => server.close(resolve));
  });
  beforeEach(() => { fake.reset(); scope = allowClients(CLIENT_ID); });

  it('xlsx: exactly two sheets, "Services" and "Materials", matching the single-sheet exporters', async () => {
    const res = await fetch(`${baseUrl}/clients/${CLIENT_ID}/rate-cards/export.xlsx`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.match(res.headers.get('content-disposition') || '', /rate-card-.*\.xlsx/);

    const ExcelJS = require('exceljs');
    const buf = Buffer.from(await res.arrayBuffer());
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    assert.deepEqual(wb.worksheets.map((w) => w.name), ['Services', 'Materials']);

    // Cross-check against the single-sheet exporters fed the SAME fixture data.
    const xlsxSvc = require('../services/client-xlsx.service');
    const rateCards = [{
      service_type_id: 10, service_type_name: 'AC Installation',
      easyfix_direct_fixed: 200, easyfix_direct_variable: 10, overhead_fixed: 10, overhead_variable: 20,
      client_fixed: 0, client_variable: 0,
    }];
    // tx_share matches what materialRatesSvc.list() computes from this
    // describe block's fake-pool fixture (neither row carries its own
    // tx_share — 20% default: 150 x 0.2 = 30, 275 x 0.2 = 55).
    const materialItems = [{
      material_id: 700, material_name: 'PVC Pipe',
      groups: [{ price: 150, tx_share: 30, brands: [], states: [{ price: 275, tx_share: 55, state_ids: [21] }] }],
    }];
    const stateNameById = new Map([[21, 'Maharashtra']]);
    const servicesOnlyBuf = await xlsxSvc.exportRateCards('A10 Design', rateCards);
    const materialsOnlyBuf = await xlsxSvc.exportMaterialRates(materialItems, stateNameById);

    const wbServices = new ExcelJS.Workbook();
    await wbServices.xlsx.load(servicesOnlyBuf);
    const wbMaterials = new ExcelJS.Workbook();
    await wbMaterials.xlsx.load(materialsOnlyBuf);

    const rowsOf = (ws) => {
      const out = [];
      for (let r = 1; r <= ws.rowCount; r++) out.push(ws.getRow(r).values.slice(1));
      return out;
    };
    assert.deepEqual(rowsOf(wb.getWorksheet('Services')), rowsOf(wbServices.worksheets[0]));
    assert.deepEqual(rowsOf(wb.getWorksheet('Materials')), rowsOf(wbMaterials.worksheets[0]));
  });

  it('the combined workbook round-trips through BOTH tab uploads with every row unchanged', async () => {
    const res = await fetch(`${baseUrl}/clients/${CLIENT_ID}/rate-cards/export.xlsx`);
    const buf = Buffer.from(await res.arrayBuffer());

    const uploadSvc = require('../services/rate-card-bulk-upload.service');
    const servicesPreview = await uploadSvc.previewServicesUpload(buf, CLIENT_ID);
    assert.equal(servicesPreview.summary.blocked, 0, JSON.stringify(servicesPreview.rows));
    assert.equal(servicesPreview.summary.unchanged, 1);
    assert.ok(servicesPreview.rows.every((r) => r.outcome === 'unchanged'));

    const materialsPreview = await uploadSvc.previewMaterialRatesUpload(buf, CLIENT_ID);
    assert.equal(materialsPreview.summary.blocked, 0, JSON.stringify(materialsPreview.rows));
    assert.ok(materialsPreview.rows.every((r) => r.outcome === 'unchanged'));
  });

  it('pdf: application/pdf, %PDF header, carries company/client name + a service rate, and NEVER the internal split headers', async () => {
    const PDFDocument = require('pdfkit');
    const realText = PDFDocument.prototype.text;
    const drawnText = [];
    PDFDocument.prototype.text = function spyText(str, ...rest) {
      if (str != null) drawnText.push(String(str));
      return realText.call(this, str, ...rest);
    };
    let res;
    try {
      res = await fetch(`${baseUrl}/clients/${CLIENT_ID}/rate-cards/export.pdf`);
      await res.clone().arrayBuffer(); // let the stream finish while the spy is live
    } finally {
      PDFDocument.prototype.text = realText;
    }
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    assert.match(res.headers.get('content-disposition') || '', /rate-card-.*\.pdf/);

    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.subarray(0, 4).toString(), '%PDF');

    // The PDF embeds IBM Plex Sans (Helvetica has no ₹ glyph), and an embedded
    // font stores text as glyph ids — the bytes cannot be searched for words.
    // So assert on what was DRAWN: every string passed to doc.text() while the
    // route rendered, captured by a spy on pdfkit's text().
    const text = drawnText.join('\n');
    assert.match(text, /EASY FIX HANDY SOLUTIONS INDIA PRIVATE LIMITED/);
    assert.match(text, /₹/, 'the rupee sign must be drawn (it needs the embedded font)');
    assert.match(text, /A10 Design/);
    assert.match(text, /AC Installation/);
    assert.match(text, /400\.00/, 'the service rate (tbl_client_service.total_amount) must be on the page');
    assert.doesNotMatch(text, /Easyfix Direct/i);
    assert.doesNotMatch(text, /Overhead/i);

    // Tx Share (2026-09-24): the Materials table shows ONE combined rate —
    // price (150) + tx_share (20% default, 30) = 180.00 for the base row;
    // the Maharashtra override (275 + 55) = 330.00 — never the split, and
    // never the literal column name "Tx Share".
    assert.match(text, /180\.00/, 'base material rate must be price + tx_share combined');
    assert.match(text, /330\.00/, 'the Maharashtra override rate must be price + tx_share combined');
    assert.doesNotMatch(text, /Tx Share/i);
  });

  it('xlsx and pdf both refuse a client outside the caller\'s scope', async () => {
    scope = allowClients(999); // NOT this client
    const [xlsxRes, pdfRes] = await Promise.all([
      fetch(`${baseUrl}/clients/${CLIENT_ID}/rate-cards/export.xlsx`),
      fetch(`${baseUrl}/clients/${CLIENT_ID}/rate-cards/export.pdf`),
    ]);
    assert.equal(xlsxRes.status, 404);
    assert.equal(pdfRes.status, 404);
    const [xlsxBody, pdfBody] = await Promise.all([xlsxRes.json(), pdfRes.json()]);
    assert.equal(xlsxBody.error, 'client not found');
    assert.equal(pdfBody.error, 'client not found');
  });
});

// ═══════════════════════ Static route-gate check ═══════════════════════════

describe('routes: export.xlsx / export.pdf are client-scope-guarded', () => {
  const fs = require('fs');
  const path = require('path');
  const ROUTES = fs.readFileSync(path.join(__dirname, '..', 'routes/admin/clients.js'), 'utf8');

  function routeBlock(anchor) {
    const idx = ROUTES.indexOf(anchor);
    assert.ok(idx >= 0, `route registration for ${anchor} not found`);
    const end = ROUTES.indexOf('\n});', idx);
    assert.ok(end > idx, `route registration for ${anchor} has no closing block`);
    return ROUTES.slice(idx, end);
  }

  for (const anchor of ["'/:clientId/rate-cards/export.xlsx'", "'/:clientId/rate-cards/export.pdf'"]) {
    test(`${anchor} runs loadAndGuardClient`, () => {
      assert.match(routeBlock(anchor), /loadAndGuardClient\(/, `${anchor} must run the client scope-guard`);
    });
  }
});
