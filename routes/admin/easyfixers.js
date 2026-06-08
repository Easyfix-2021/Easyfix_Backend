const router = require('express').Router();
const ExcelJS = require('exceljs');

const validate = require('../../middleware/validate');
const easyfixer = require('../../services/easyfixer.service');
const { modernOk, modernError } = require('../../utils/response');
const { listQuery, createBody, updateBody, statusBody, idParam, listSubresourceQuery, efrIdsBody } =
  require('../../validators/easyfixer.validator');
const { buildRequestScope, assertEntityInScope } = require('../../lib/scope');

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
  { header: 'Avg Rating',             key: 'avg_rating',                   width: 12 },
  { header: 'Profile Activated On',   key: 'profile_activation_date_time', width: 22 },
  { header: 'Status',                 key: 'efr_status',                   width: 10 },
];

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
      });
    }

    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const buffer = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="easyfixers-${today}.xlsx"`);
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

module.exports = router;
