const router = require('express').Router();
const ExcelJS = require('exceljs');
const Joi = require('joi');

const validate = require('../../middleware/validate');
const easyfixer = require('../../services/easyfixer.service');
const verification = require('../../services/easyfixer-verification.service');
const profileUpdateLink = require('../../services/easyfixer-profile-update-link.service');
const { signEasyfixerProfileToken } = require('../../utils/jwt');
const requireAction = require('../../middleware/require-action');
const { pool } = require('../../db');
const { modernOk, modernError } = require('../../utils/response');
const {
  listQuery, registeredListQuery, createBody, updateBody, statusBody, idParam, listSubresourceQuery, efrIdsBody,
  commentBody, leadVerificationBody, professionalBody, personalFamilyBody,
  bankingVerificationBody, identityVerificationBody, activationBody, mapClientsBody, bgvReportBody,
  optionMappingsBody, serviceablePincodesBody,
} = require('../../validators/easyfixer.validator');
const { buildRequestScope, assertEntityInScope } = require('../../lib/scope');

// Local Joi schema for the profile-update-link send action. Mirrors
// the `sendBody` shape used by routes/admin/job-magic-link.js so the
// FE can reuse the same client-side helper across both flows.
//
// `override_mobile` (2026-06-10): non-prod-only operator override of the
// WhatsApp destination, used by the CRM "Send To" confirmation dialog
// so QA / staging testers can ping their own number without hitting the
// real technician. The custom `production-block` rule rejects the field
// outright in production (NODE_ENV === 'production') so a tampered FE
// payload can never bypass the masked-mobile UX. In non-prod it just
// enforces the digit-format pattern.
const profileUpdateSendBody = Joi.object({
  action: Joi.string().valid('first', 'reminder', 'resend').default('first'),
  override_mobile: Joi.string()
    .pattern(/^\d{10,15}$/)
    .optional()
    .custom((value, helpers) => {
      // Block override_mobile in TRUE production, but honor the explicit
      // ENABLE_DEV_PROFILE_URL opt-in (the same flag that exposes the dev-url)
      // so a staging/parity backend running NODE_ENV=production can still test
      // sends to an operator's own number.
      const isProd = process.env.NODE_ENV === 'production';
      const devOptIn = String(process.env.ENABLE_DEV_PROFILE_URL || '').toLowerCase() === 'true';
      if (isProd && !devOptIn) {
        return helpers.error('any.invalid');
      }
      return value;
    }, 'production-block')
    .messages({
      'any.invalid': 'override_mobile is not allowed in production',
      'string.pattern.base': 'override_mobile must be 10-15 digits',
    }),
});

router.get('/', validate(listQuery, 'query'), async (req, res, next) => {
  try {
    const scope = buildRequestScope(req);
    const { rows, total } = await easyfixer.list({ ...req.query, scope });
    modernOk(res, { items: rows, total, limit: req.query.limit, offset: req.query.offset });
  } catch (e) { next(e); }
});

// ─── Lazy-fill sub-resources (Manage Easyfixers perf split, 2026-06-08) ───
// Base GET / now returns the minimal row projection. The FE calls these two
// endpoints per-page with the visible efr_ids to backfill the expensive
// columns (aggregations + today's attendance). Each takes a JSON body
// `{ efrIds: [...] }` (Joi-validated, max 1000) and applies the same
// RBAC city scope as the base list — ids belonging to easyfixers outside
// the caller's scope are silently filtered.
router.post('/aggregates', validate(efrIdsBody, 'body'), async (req, res, next) => {
  try {
    const scope = buildRequestScope(req);
    const { rows } = await easyfixer.aggregates(req.body.efrIds, { scope });
    modernOk(res, { items: rows });
  } catch (e) { next(e); }
});

router.post('/attendance', validate(efrIdsBody, 'body'), async (req, res, next) => {
  try {
    const scope = buildRequestScope(req);
    const { rows } = await easyfixer.attendance(req.body.efrIds, { scope });
    modernOk(res, { items: rows });
  } catch (e) { next(e); }
});

/*
 * Status counts strip (2026-06-08). Powers the page subtitle's
 * "X Active · Y Inactive · Z Idle · …" line. One round-trip returning
 * counts for all 6 status buckets + total. Each count matches what the
 * operator sees after clicking the corresponding dropdown filter (buckets
 * overlap, sum > total — mirrors legacy CRM behaviour). RBAC scope is
 * applied per `list()`'s convention so city-scoped users see only their
 * allowed cities.
 *
 * Registered BEFORE /:id so the literal `/status-counts` path wins
 * routing — `/:id` is a catch-all that would otherwise capture this.
 */
router.get('/status-counts', async (req, res, next) => {
  try {
    const scope = buildRequestScope(req);
    const counts = await easyfixer.statusCounts({ scope });
    modernOk(res, counts);
  } catch (e) { next(e); }
});

// ─── Download (XLSX export) ─────────────────────────────────────────
// Accepts the SAME query params as GET /. Hard-caps at 10 000 rows so a
// "Status = All" download can't OOM the pod. Pagination params from the
// query are intentionally ignored — the file is a single-shot snapshot.
const EXPORT_HARD_CAP = 10000;
const EXPORT_COLUMNS = [
  { header: 'Easyfixer ID',           key: 'efr_id',                       width: 14 },
  { header: 'Name',                   key: 'efr_name',                     width: 28 },
  { header: 'Mobile',                 key: 'efr_no',                       width: 16 },
  { header: 'Email',                  key: 'efr_email',                    width: 30 },
  { header: 'City',                   key: 'city_name',                    width: 20 },
  { header: 'State',                  key: 'state_name',                   width: 18 },
  { header: 'User Mapped To City',    key: 'user_mapped_to_city',          width: 22 },
  { header: 'EF Account',             key: 'ef_account',                   width: 14 },
  { header: 'Service Category',       key: 'efr_service_category',         width: 22 },
  { header: 'Service Type',           key: 'efr_service_type',             width: 22 },
  { header: 'Profile %',              key: 'efr_profile_perc',             width: 11 },
  { header: 'Verified',               key: 'is_technician_verified',       width: 10 },
  { header: 'A/C Balance',            key: 'current_balance',              width: 14 },
  { header: 'Clients Mapped',         key: 'clients_mapped',               width: 15 },
  { header: 'Total Earnings',         key: 'total_earnings',               width: 16 },
  { header: 'Job Count',              key: 'job_count',                    width: 12 },
  { header: 'DeepSkills Mapped',      key: 'options_mapped_count',         width: 15 },
  { header: 'Serviceable Pincodes',   key: 'serviceable_pincodes_csv',     width: 40 },
  { header: 'Avg Rating',             key: 'avg_rating',                   width: 12 },
  { header: 'Last Link Sent',         key: 'profile_update_sent_at',       width: 22 },
  { header: 'Profile Link Send Count',key: 'profile_update_send_count',    width: 18 },
  { header: 'Profile Activated On',   key: 'profile_activation_date_time', width: 22 },
  { header: 'Status',                 key: 'efr_status',                   width: 10 },
];

/*
 * Format a DATETIME / Date value for XLSX export. Aggregates() returns
 * `profile_update_sent_at` as a Date object (mysql2 default) or raw string;
 * either way we render an ISO-like "YYYY-MM-DD HH:mm" so operators can sort
 * lexicographically inside the sheet. Null → "—".
 */
function formatDateTimeForXlsx(v) {
  if (v == null) return '—';
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

router.get('/download', validate(listQuery, 'query'), async (req, res, next) => {
  try {
    const scope = buildRequestScope(req);
    const { rows } = await easyfixer.list({
      ...req.query, scope,
      limit: EXPORT_HARD_CAP, offset: 0,
    });

    /*
     * Merge in the aggregation + attendance columns server-side for the
     * download path (2026-06-08). The list query was split into a fast
     * base + two side endpoints to fix the 20+s page-load perf — but the
     * XLSX export still wants the full picture (Earnings / Job Count /
     * Clients Mapped / Rating + today's attendance). Fire both side
     * endpoints in parallel with the just-fetched efr_ids, then merge by
     * efr_id into each row before adding to the sheet.
     *
     * For a 10k-row download (the EXPORT_HARD_CAP) the aggregates query
     * still runs in ~1-2s thanks to the new covering indexes; the
     * attendance query is even cheaper. Total download time stays
     * dominated by the base list, not the merge.
     */
    const efrIds = rows.map((r) => r.efr_id);
    const [aggResp, attResp] = await Promise.all([
      efrIds.length ? easyfixer.aggregates(efrIds, { scope }) : Promise.resolve({ rows: [] }),
      efrIds.length ? easyfixer.attendance(efrIds, { scope }) : Promise.resolve({ rows: [] }),
    ]);
    const aggByEfr = new Map((aggResp.rows || []).map((r) => [r.efr_id, r]));
    const attByEfr = new Map((attResp.rows || []).map((r) => [r.efr_id, r]));

    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Easyfixers');
    sheet.columns = EXPORT_COLUMNS;
    sheet.getRow(1).font = { bold: true };
    for (const r of rows) {
      const agg = aggByEfr.get(r.efr_id) || {};
      const att = attByEfr.get(r.efr_id) || {};
      sheet.addRow({
        ...r,
        ...agg,
        ...att,
        is_technician_verified: r.is_technician_verified ? 'Yes' : 'No',
        efr_status: r.efr_status === 1 ? 'Active' : 'Inactive',
        // Format the magic-link timestamp inline — agg.profile_update_sent_at
        // is a Date | string | null per mysql2's DATETIME handling.
        profile_update_sent_at: formatDateTimeForXlsx(agg.profile_update_sent_at),
        profile_update_send_count: agg.profile_update_send_count ?? 0,
      });
    }

    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const buffer = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="easyfixers-${today}.xlsx"`);
    res.send(Buffer.from(buffer));
  } catch (e) { next(e); }
});

// ─── Registered Easyfixers (onboarding / approval queue) ────────────
// Parity port of legacy efer-registration / getAllRegisteredEasyfixer.
// REGISTERED BEFORE `/:id` so the literal `/registered` path wins routing —
// `/:id` is a catch-all that would otherwise capture `/registered`.
router.get('/registered', validate(registeredListQuery, 'query'), async (req, res, next) => {
  try {
    const scope = buildRequestScope(req);
    const { rows, total } = await easyfixer.listRegistered(req.query, scope);
    modernOk(res, { items: rows, total, limit: req.query.limit, offset: req.query.offset });
  } catch (e) { next(e); }
});

// Registration-status count strip (clickable triage header for the queue).
// Scope-filtered; buckets overlap (sum may exceed total) — legacy parity.
router.get('/registered/status-counts', async (req, res, next) => {
  try {
    const scope = buildRequestScope(req);
    const counts = await easyfixer.registeredStatusCounts(scope);
    modernOk(res, counts);
  } catch (e) { next(e); }
});

const REGISTERED_EXPORT_COLUMNS = [
  { header: 'Easyfixer ID',         key: 'efr_id',                       width: 14 },
  { header: 'Name',                 key: 'name',                         width: 28 },
  { header: 'Mobile',               key: 'mobile',                       width: 16 },
  { header: 'City',                 key: 'city',                         width: 20 },
  { header: 'Pincode',              key: 'pincode',                      width: 12 },
  { header: 'State',                key: 'state_name',                   width: 18 },
  { header: 'State User',           key: 'state_user_name',              width: 22 },
  { header: 'Applied On',           key: 'registered_date',              width: 20 },
  { header: 'Registration Status',  key: 'registration_status_label',    width: 26 },
  { header: 'Profile %',            key: 'profile_perc',                 width: 11 },
  { header: 'Service Category',     key: 'efr_service_category',         width: 22 },
  { header: 'Is New/Existing',      key: 'new_or_existing',              width: 16 },
  { header: 'Profile Activated On', key: 'profile_activation_date_time', width: 22 },
];

// Export respects the SAME filters as the list (legacy exported the full
// unfiltered set — improved here, matching the main /download behaviour).
router.get('/registered/download', validate(registeredListQuery, 'query'), async (req, res, next) => {
  try {
    const scope = buildRequestScope(req);
    const rows = await easyfixer.listRegisteredForExport(req.query, scope, EXPORT_HARD_CAP);

    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Registered Easyfixers');
    sheet.columns = REGISTERED_EXPORT_COLUMNS;
    sheet.getRow(1).font = { bold: true };
    for (const r of rows) {
      sheet.addRow({
        ...r,
        registered_date: formatDateTimeForXlsx(r.registered_date),
        profile_activation_date_time: formatDateTimeForXlsx(r.profile_activation_date_time),
        new_or_existing: r.is_existing_easyfixer ? 'Existing' : (r.new_easy_fixer ? 'New' : '—'),
      });
    }

    const today = new Date().toISOString().slice(0, 10);
    const buffer = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="registered-easyfixers-${today}.xlsx"`);
    res.send(Buffer.from(buffer));
  } catch (e) { next(e); }
});

router.get('/:id', validate(idParam, 'params'), async (req, res, next) => {
  try {
    const row = await easyfixer.getById(req.params.id);
    if (!row) return modernError(res, 404, 'easyfixer not found');
    // Row-level guard — return 404 (not 403) to avoid leaking existence
    // of out-of-scope efr_ids.
    const guard = assertEntityInScope(req, { city_id: row.efr_cityId });
    if (!guard.ok) return modernError(res, 404, 'easyfixer not found');
    modernOk(res, row);
  } catch (e) { next(e); }
});

router.post('/', validate(createBody), async (req, res, next) => {
  try {
    // On create, the new row's city must be within the caller's scope.
    const guard = assertEntityInScope(req, { city_id: req.body.efr_cityId });
    if (!guard.ok) return modernError(res, 403, 'cannot create easyfixer in a city outside your scope');
    const created = await easyfixer.create(req.body, req.user);
    res.status(201);
    modernOk(res, created, 'easyfixer created');
  } catch (e) { next(e); }
});

router.put('/:id', validate(idParam, 'params'), validate(updateBody), async (req, res, next) => {
  try {
    const existing = await easyfixer.getById(req.params.id);
    if (!existing) return modernError(res, 404, 'easyfixer not found');
    const guard = assertEntityInScope(req, { city_id: existing.efr_cityId });
    if (!guard.ok) return modernError(res, 404, 'easyfixer not found');
    const updated = await easyfixer.update(req.params.id, req.body, req.user);
    modernOk(res, updated, 'easyfixer updated');
  } catch (e) { next(e); }
});

// ─── Transaction List (sub-resource) ────────────────────────────────
// Feeds the "Transaction List" modal on the Easyfixer detail page.
// RBAC: easyfixer row must be in caller's city scope (404 otherwise — see
// /:id rationale above for why we return 404 not 403).
router.get('/:id/transactions',
  validate(idParam, 'params'),
  validate(listSubresourceQuery, 'query'),
  async (req, res, next) => {
    try {
      const row = await easyfixer.getById(req.params.id);
      if (!row) return modernError(res, 404, 'easyfixer not found');
      const guard = assertEntityInScope(req, { city_id: row.efr_cityId });
      if (!guard.ok) return modernError(res, 404, 'easyfixer not found');
      const { rows, total } = await easyfixer.listTransactions(req.params.id, req.query);
      modernOk(res, { items: rows, total, limit: req.query.limit, offset: req.query.offset });
    } catch (e) { next(e); }
  });

// ─── Mapped Clients (sub-resource) ──────────────────────────────────
router.get('/:id/mapped-clients',
  validate(idParam, 'params'),
  validate(listSubresourceQuery, 'query'),
  async (req, res, next) => {
    try {
      const row = await easyfixer.getById(req.params.id);
      if (!row) return modernError(res, 404, 'easyfixer not found');
      const guard = assertEntityInScope(req, { city_id: row.efr_cityId });
      if (!guard.ok) return modernError(res, 404, 'easyfixer not found');
      const { rows, total } = await easyfixer.listMappedClients(req.params.id, req.query);
      modernOk(res, { items: rows, total, limit: req.query.limit, offset: req.query.offset });
    } catch (e) { next(e); }
  });

router.patch('/:id/status', validate(idParam, 'params'), validate(statusBody), async (req, res, next) => {
  try {
    const existing = await easyfixer.getById(req.params.id);
    if (!existing) return modernError(res, 404, 'easyfixer not found');
    const guard = assertEntityInScope(req, { city_id: existing.efr_cityId });
    if (!guard.ok) return modernError(res, 404, 'easyfixer not found');
    const updated = await easyfixer.setStatus(req.params.id, req.body, req.user);
    modernOk(res, updated, `easyfixer ${req.body.active ? 'activated' : 'deactivated'}`);
  } catch (e) { next(e); }
});

// ─── Verification page (eferVerification.vm parity) ─────────────────
// All routes below scope-check on the easyfixer row's city. Returns 404
// (not 403) on miss to avoid leaking existence of out-of-scope rows.
async function loadAndAuthorize(req, res) {
  const row = await easyfixer.getById(req.params.id);
  if (!row) { modernError(res, 404, 'easyfixer not found'); return null; }
  const guard = assertEntityInScope(req, { city_id: row.efr_cityId });
  if (!guard.ok) { modernError(res, 404, 'easyfixer not found'); return null; }
  return row;
}

router.get('/:id/verification',
  validate(idParam, 'params'),
  async (req, res, next) => {
    try {
      if (!(await loadAndAuthorize(req, res))) return;
      const payload = await verification.getVerificationPage(req.params.id);
      if (!payload) return modernError(res, 404, 'easyfixer not found');
      modernOk(res, payload);
    } catch (e) { next(e); }
  });

router.post('/:id/verification/comments',
  validate(idParam, 'params'), validate(commentBody, 'body'),
  async (req, res, next) => {
    try {
      if (!(await loadAndAuthorize(req, res))) return;
      const comments = await verification.addComment(req.params.id, req.body, req.user);
      modernOk(res, { section: req.body.section, comments }, 'comment added');
    } catch (e) { next(e); }
  });

router.put('/:id/verification/lead',
  validate(idParam, 'params'), validate(leadVerificationBody, 'body'),
  async (req, res, next) => {
    try {
      if (!(await loadAndAuthorize(req, res))) return;
      const data = await verification.setLeadVerification(req.params.id, req.body, req.user);
      modernOk(res, data, 'lead status updated');
    } catch (e) { next(e); }
  });

router.put('/:id/verification/professional',
  validate(idParam, 'params'), validate(professionalBody, 'body'),
  async (req, res, next) => {
    try {
      if (!(await loadAndAuthorize(req, res))) return;
      const data = await verification.saveProfessional(req.params.id, req.body, req.user);
      modernOk(res, data, 'professional details saved');
    } catch (e) { next(e); }
  });

router.put('/:id/verification/personal-family',
  validate(idParam, 'params'), validate(personalFamilyBody, 'body'),
  async (req, res, next) => {
    try {
      if (!(await loadAndAuthorize(req, res))) return;
      const data = await verification.savePersonalFamily(req.params.id, req.body, req.user);
      modernOk(res, data, 'personal & family details saved');
    } catch (e) { next(e); }
  });

router.put('/:id/verification/banking',
  validate(idParam, 'params'), validate(bankingVerificationBody, 'body'),
  async (req, res, next) => {
    try {
      if (!(await loadAndAuthorize(req, res))) return;
      const data = await verification.saveBanking(req.params.id, req.body, req.user);
      modernOk(res, data, 'banking details saved');
    } catch (e) { next(e); }
  });

router.put('/:id/verification/identity',
  validate(idParam, 'params'), validate(identityVerificationBody, 'body'),
  async (req, res, next) => {
    try {
      if (!(await loadAndAuthorize(req, res))) return;
      const data = await verification.saveIdentity(req.params.id, req.body, req.user);
      modernOk(res, data, 'identity details saved');
    } catch (e) { next(e); }
  });

router.post('/:id/verification/proceed-to-activation',
  validate(idParam, 'params'),
  async (req, res, next) => {
    try {
      if (!(await loadAndAuthorize(req, res))) return;
      const data = await verification.proceedToActivation(req.params.id);
      modernOk(res, data, 'proceed allowed');
    } catch (e) {
      if (e.status === 409) return modernError(res, 409, e.message, e.details);
      next(e);
    }
  });

router.put('/:id/verification/activation',
  validate(idParam, 'params'), validate(activationBody, 'body'),
  async (req, res, next) => {
    try {
      if (!(await loadAndAuthorize(req, res))) return;
      const data = await verification.saveActivation(req.params.id, req.body, req.user);
      modernOk(res, data, 'activation saved');
    } catch (e) { next(e); }
  });

router.put('/:id/verification/map-clients',
  validate(idParam, 'params'), validate(mapClientsBody, 'body'),
  async (req, res, next) => {
    try {
      if (!(await loadAndAuthorize(req, res))) return;
      const data = await verification.mapClients(req.params.id, req.body.client_ids, req.user);
      modernOk(res, data, 'clients mapped');
    } catch (e) { next(e); }
  });

// ─── Deep Skill Option Mappings (tbl_efr_deepskill_mapping) ─────────
// GET returns ALL active option mappings for the easyfixer with the full
// 4-level hierarchy joined for display. PUT replaces the active set
// atomically (soft-delete-then-insert in one txn). Same scope guard +
// 404-on-miss convention as the other verification endpoints.
router.get('/:id/option-mappings',
  validate(idParam, 'params'),
  async (req, res, next) => {
    try {
      if (!(await loadAndAuthorize(req, res))) return;
      const items = await verification.listOptionMappings(req.params.id);
      modernOk(res, { items });
    } catch (e) { next(e); }
  });

router.put('/:id/option-mappings',
  validate(idParam, 'params'), validate(optionMappingsBody, 'body'),
  async (req, res, next) => {
    try {
      if (!(await loadAndAuthorize(req, res))) return;
      const result = await verification.replaceOptionMappings(req.params.id, req.body.items, req.user);
      modernOk(res, result, 'option mappings updated');
    } catch (e) { next(e); }
  });

// Unmap a single deep-skill option mapping (X action on the Manage Easyfixers
// "Mapped Deep Skill" detail modal). Soft-deletes the row (is_repairing=0).
router.delete('/:id/option-mappings/:rowId',
  validate(Joi.object({
    id:    Joi.number().integer().positive().required(),
    rowId: Joi.number().integer().positive().required(),
  }), 'params'),
  async (req, res, next) => {
    try {
      if (!(await loadAndAuthorize(req, res))) return;
      const result = await verification.unmapDeepSkill(Number(req.params.id), Number(req.params.rowId));
      modernOk(res, result, 'deep skill mapping removed');
    } catch (e) {
      if (e && typeof e.status === 'number') return modernError(res, e.status, e.message);
      next(e);
    }
  });

// ─── Serviceable Pincodes (tbl_efr_serviceable_pincodes) ────────────
// Per-easyfixer set of pincodes the technician will accept jobs in.
// GET returns active pincodes with display labels joined from tbl_pincode/
// tbl_city/tbl_state; PUT replaces the active set atomically. Same scope
// guard + 404-on-miss convention as the other verification endpoints.
router.get('/:id/serviceable-pincodes',
  validate(idParam, 'params'),
  async (req, res, next) => {
    try {
      if (!(await loadAndAuthorize(req, res))) return;
      const data = await verification.listServiceablePincodes(req.params.id);
      modernOk(res, data);
    } catch (e) { next(e); }
  });

router.put('/:id/serviceable-pincodes',
  validate(idParam, 'params'), validate(serviceablePincodesBody, 'body'),
  async (req, res, next) => {
    try {
      if (!(await loadAndAuthorize(req, res))) return;
      const result = await verification.replaceServiceablePincodes(
        req.params.id, req.body.pincodeIds, req.user
      );
      modernOk(res, result, 'serviceable pincodes updated');
    } catch (e) { next(e); }
  });

router.post('/:id/verification/bgv-report',
  validate(idParam, 'params'), validate(bgvReportBody, 'body'),
  async (req, res, next) => {
    try {
      if (!(await loadAndAuthorize(req, res))) return;
      const data = await verification.saveBgvReport(req.params.id, req.body, req.user);
      modernOk(res, data, 'BGV report saved');
    } catch (e) { next(e); }
  });

// ─── Profile Update Magic-Link send ─────────────────────────────────
// Operator-triggered WhatsApp send of the public profile-update self-serve
// link. Gated by:
//   • the standard scope guard (easyfixer row must be in the caller's city
//     scope — 404 on miss to avoid leaking out-of-scope existence)
//   • the `isProfileUpdateLinkSend` action permission (seeded by
//     migrations/2026-06-11-easyfixer-profile-update-magic-link.sql; granted
//     to Admin (2), Executive Supply (3), Call Flow + Quality (11))
// The send + audit logic lives in
// services/easyfixer-profile-update-link.service.js to keep this route
// thin — same split pattern as the customer magic-link admin route at
// routes/admin/job-magic-link.js.
router.post('/:id/profile-update-link/send',
  validate(idParam, 'params'),
  validate(profileUpdateSendBody, 'body'),
  requireAction('isProfileUpdateLinkSend'),
  async (req, res, next) => {
    try {
      if (!(await loadAndAuthorize(req, res))) return;
      const result = await profileUpdateLink.sendForEasyfixer(
        Number(req.params.id),
        req.body,
        req.user,
        pool,
      );
      modernOk(res, result, 'Profile update link sent on WhatsApp');
    } catch (e) {
      if (e && typeof e.status === 'number') {
        return modernError(res, e.status, e.message || 'request failed');
      }
      next(e);
    }
  });

/*
 * Dev-only sibling of /profile-update-link/send (2026-06-11). Mints the
 * SAME JWT + URL the WhatsApp path would generate but returns it in the
 * response instead of dispatching a message. Lets engineers copy-paste
 * the link straight from a curl response (or DevTools Network panel)
 * during local development — no WhatsApp template approval, no number-
 * provisioning, no log-scraping for shortUrls.
 *
 * Hard-gated behind `NODE_ENV !== 'production'`. In prod the route
 * returns 404 to avoid leaking the existence of the endpoint, matching
 * the "production should look like the endpoint doesn't exist at all"
 * convention used elsewhere in this codebase. The 404 fires BEFORE Joi
 * validation + scope guard + permission check, so the prod surface
 * really is identical to "no such route" — same status code, same
 * response shape.
 *
 * In non-prod, the standard ladder still applies:
 *   • idParam Joi validation (`:id` must be a positive integer)
 *   • entity-scope guard (out-of-scope efr → 404, consistent with send)
 *   • isProfileUpdateLinkSend permission (the same gate as send, so a
 *     dev tester who can't trigger sends can't bypass that via this
 *     shortcut)
 *
 * Returns the URL deterministically — no shortener call (skipped to
 * keep the route synchronous + cheap for dev iteration; the long URL
 * works identically in a browser).
 */
router.get('/:id/profile-update-link/dev-url',
  /*
   * Dev gate (2026-06-11). The route is open when EITHER:
   *   • NODE_ENV is not 'production' (the default dev/test path), OR
   *   • ENABLE_DEV_PROFILE_URL=true is set (explicit opt-in for ops
   *     who need the affordance on a prod-flagged BE — e.g. a staging
   *     deployment that runs with NODE_ENV=production for parity
   *     testing, or a locally-run BE where NODE_ENV gets accidentally
   *     inlined as 'production' by npm start).
   *
   * Default-closed in true production: leaving both signals at their
   * defaults (NODE_ENV=production, no ENABLE_DEV_PROFILE_URL or it
   * set to 'false') preserves the "endpoint doesn't exist" surface.
   * Operators have to explicitly opt-in to expose the dev URL.
   *
   * 2026-06-11 rename: ENABLE_DEV_URL → ENABLE_DEV_PROFILE_URL for a
   * more specific name; old check accepted '1', new check accepts the
   * literal string 'true' so the env file reads as a clear boolean.
   */
  (req, res, next) => {
    const isProd = process.env.NODE_ENV === 'production';
    const explicitlyEnabled = String(process.env.ENABLE_DEV_PROFILE_URL || '').toLowerCase() === 'true';
    if (isProd && !explicitlyEnabled) {
      return modernError(res, 404, 'Not Found');
    }
    next();
  },
  validate(idParam, 'params'),
  requireAction('isProfileUpdateLinkSend'),
  async (req, res, next) => {
    try {
      if (!(await loadAndAuthorize(req, res))) return;
      const efrId = Number(req.params.id);
      const token = signEasyfixerProfileToken(efrId);
      const base = (process.env.CRM_PUBLIC_BASE_URL || process.env.MAGIC_LINK_BASE_URL || 'http://localhost:5180').replace(/\/$/, '');
      const url = `${base}/profile-update/${token}`;
      modernOk(res, { efrId, token, url }, 'Dev profile-update link minted (no WhatsApp send)');
    } catch (e) {
      if (e && typeof e.status === 'number') {
        return modernError(res, e.status, e.message || 'request failed');
      }
      next(e);
    }
  });

module.exports = router;
