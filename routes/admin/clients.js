/*
 * Manage Clients — CRM admin routes.
 *
 * Thin route handlers backed by services/client.service.js. Validation
 * via validators/client.validator.js. RBAC scope filtering via the
 * existing lib/scope helpers.
 *
 * Sub-resources mounted under /:clientId:
 *   /contacts            (SPOCs)
 *   /billing             (billing addresses)
 *   /custom-properties   (free-form key/value)
 *   /collected-by-preference  (legacy collected_by code → label)
 *   /summary             (Client Profile headline figures — read-only)
 *   /stores              (branch directory from tbl_client_store — read-only)
 *   /targets             (contracted performance targets — GET/PUT/DELETE)
 *
 * Permissions:
 *   - READ routes are open to any authenticated admin-group user
 *     (the calling user already passed bearer + RBAC scope checks).
 *   - WRITE routes require either `isClientAddNew` (creation) or
 *     `isClientEdit` (updates / deletes). Matches the legacy
 *     EasyFix_CRM permission keyspace.
 *
 * Note on requireAction pattern: no shared middleware factory exists
 * yet — inline `requireClientWrite()` mirrors the pattern in
 * routes/admin/notices.js#requireNoticeManage. If a generic
 * `requireAction(key)` middleware lands later, these all migrate
 * together.
 */

const router = require('express').Router();
const multer = require('multer');
const validate = require('../../middleware/validate');
const { modernOk, modernError } = require('../../utils/response');
const { buildRequestScope, assertEntityInScope } = require('../../lib/scope');
const svc = require('../../services/client.service');
const verticalsSvc = require('../../services/client-verticals.service');
const docsSvc = require('../../services/client-documents.service');
const clientServicesSvc = require('../../services/client-services.service');
const rateCardsSvc = require('../../services/client-rate-cards.service');
const techMappingSvc = require('../../services/client-tech-mapping.service');
// Same module the client portal's Performance book judges against — see the
// GET /:clientId/targets handler for why this is a passthrough, not a copy.
const targetSvc = require('../../services/client-target.service');
const xlsxSvc = require('../../services/client-xlsx.service');
const { pool } = require('../../db');
const s3 = require('../../utils/s3-storage');
const v = require('../../validators/client.validator');
const logger = require('../../logger');

// Multer in-memory storage for client document uploads.
// 10MB cap — same shape as the notice-image route.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const DOC_MIME = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
  'application/pdf',
]);

/* ─── Permission gates ────────────────────────────────────────────── */
// Migrated 2026-05-30 from inline `req.user.permissions.actionPermissions`
// checks (which never matched — see middleware/require-action.js header
// for the full history) to the shared `requireAction()` factory.

const requireAction = require('../../middleware/require-action');
const requireClientAdd  = requireAction('isClientAddNew');
const requireClientEdit = requireAction('isClientEdit');

/* ─── Helper: scope-guard a client by id ──────────────────────────── */

async function loadAndGuardClient(req, res) {
  const client = await svc.getClientById(req.params.clientId || req.params.id);
  if (!client) {
    modernError(res, 404, 'client not found');
    return null;
  }
  const guard = assertEntityInScope(req, {
    client_id: client.client_id,
    vertical_id: client.vertical_id,
  });
  if (!guard.ok) {
    modernError(res, 404, 'client not found');
    return null;
  }
  return client;
}

/*
 * Scope-guard a flat id-based sub-resource by its owning client_id.
 *
 * The flat /contacts/:id, /billing/:id, /custom-properties/:id,
 * /services/:id and /documents/:id routes are keyed on the sub-resource
 * PK, not on a /:clientId path segment — so they skip
 * loadAndGuardClient(). Without this check a scoped operator could
 * mutate sub-resources of clients OUTSIDE their manage_clients scope by
 * enumerating integer ids. We resolve the owning client_id (via the
 * service read-helpers), re-load the client, and run the SAME scope
 * assertion the nested routes use.
 *
 * Anti-enumeration: every failure path returns the handler's own
 * not-found message + 404, so "out of scope" is indistinguishable from
 * "does not exist".
 *
 * Returns true when the caller is allowed to proceed; false (and has
 * already written the 404 response) otherwise.
 */
async function guardRowByClientId(req, res, clientId, notFoundMsg) {
  if (clientId == null) { modernError(res, 404, notFoundMsg); return false; }
  const client = await svc.getClientById(clientId);
  if (!client) { modernError(res, 404, notFoundMsg); return false; }
  const guard = assertEntityInScope(req, {
    client_id: client.client_id,
    vertical_id: client.vertical_id,
  });
  if (!guard.ok) { modernError(res, 404, notFoundMsg); return false; }
  return true;
}

/* ─── Clients CRUD ────────────────────────────────────────────────── */

router.get('/', validate(v.listClientsQuery, 'query'), async (req, res, next) => {
  try {
    logger.info('List clients · q=' + (req.query.q || '') + ' cityId=' + (req.query.cityId || '') + ' includeInactive=' + (req.query.includeInactive || 'false') + ' limit=' + req.query.limit + ' offset=' + req.query.offset);
    const extraClauses = [];
    const extraParams = [];
    // RBAC: restrict the visible client list to the caller's
    // manage_clients AND manage_verticals scope. `clients` directly
    // filters by client_id; `verticals` filters by tbl_client.vertical_id.
    const scope = buildRequestScope(req);
    if (scope?.clients) {
      const c = scope.clients;
      if (c.mode === 'none') extraClauses.push('1=0');
      else if (c.mode === 'allow' && c.ids.length) {
        extraClauses.push(`client_id IN (${c.ids.map(() => '?').join(',')})`);
        extraParams.push(...c.ids);
      }
    }
    if (scope?.verticals) {
      const vs = scope.verticals;
      if (vs.mode === 'none') extraClauses.push('1=0');
      else if (vs.mode === 'allow' && vs.ids.length) {
        extraClauses.push(`vertical_id IN (${vs.ids.map(() => '?').join(',')})`);
        extraParams.push(...vs.ids);
      }
    }
    const { items, total } = await svc.listClients({
      extraClauses,
      extraParams,
      includeInactive: req.query.includeInactive === 'true',
      q: req.query.q,
      cityId: req.query.cityId ? Number(req.query.cityId) : undefined,
      limit: req.query.limit,
      offset: req.query.offset,
      sortBy: req.query.sortBy,
      sortDir: req.query.sortDir,
    });
    // Modern envelope wraps `{items, total}` as the data payload — the
    // FE reads `data.items` + `data.total`. Backwards-compat note:
    // the previous shape was a bare array; updated FE callers consume
    // the new shape. No other internal services consume this route.
    logger.info('Returning ' + items.length + ' clients · total=' + total);
    modernOk(res, { items, total });
  } catch (e) { next(e); }
});

/* ─── Exports + Reports (must come BEFORE /:id) ───────────────────── */

/*
 * GET /admin/clients/export?q=&includeInactive=
 *
 * Streams the full client list (no LIMIT — operators need every row
 * in the export) as XLSX. RBAC scope is applied identically to the
 * `GET /` list so exports never leak data the operator can't see in
 * the UI.
 *
 * Why one query, no count/round-trip: we just SELECT and pipe.
 * Operators ask for this on at most ~50k clients per tenant; an XLSX
 * with 50k rows is ~5MB and ExcelJS produces it in <2s.
 */
router.get('/export', async (req, res, next) => {
  try {
    logger.info('Export clients XLSX · q=' + (req.query.q || '') + ' includeInactive=' + (req.query.includeInactive || 'false'));
    const extraClauses = [];
    const extraParams = [];
    const scope = buildRequestScope(req);
    if (scope?.clients) {
      const c = scope.clients;
      if (c.mode === 'none') extraClauses.push('1=0');
      else if (c.mode === 'allow' && c.ids.length) {
        extraClauses.push(`client_id IN (${c.ids.map(() => '?').join(',')})`);
        extraParams.push(...c.ids);
      }
    }
    if (scope?.verticals) {
      const vs = scope.verticals;
      if (vs.mode === 'none') extraClauses.push('1=0');
      else if (vs.mode === 'allow' && vs.ids.length) {
        extraClauses.push(`vertical_id IN (${vs.ids.map(() => '?').join(',')})`);
        extraParams.push(...vs.ids);
      }
    }
    const { items } = await svc.listClients({
      extraClauses,
      extraParams,
      includeInactive: req.query.includeInactive === 'true',
      q: req.query.q,
      limit: 100000, // export ceiling — well above current tenant scale
      offset: 0,
    });
    logger.info('Exporting ' + items.length + ' clients to XLSX');
    const buf = await xlsxSvc.exportClientList(items);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="clients-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.send(buf);
  } catch (e) { next(e); }
});

/*
 * GET /admin/clients/reports/spoc-list
 *
 * Cross-client SPOC roster. Single JOIN — returns every active SPOC
 * across every client the caller is scoped to see. Used by Finance/Ops
 * to audit reporting contacts in bulk.
 *
 * Returns JSON by default; pass ?format=xlsx for an XLSX download.
 */
router.get('/reports/spoc-list', async (req, res, next) => {
  try {
    logger.info('SPOC roster report · format=' + (req.query.format || 'json'));
    const extraClauses = ['(cc.status IS NULL OR cc.status = 1)'];
    const extraParams = [];
    const scope = buildRequestScope(req);
    if (scope?.clients) {
      const c = scope.clients;
      if (c.mode === 'none') extraClauses.push('1=0');
      else if (c.mode === 'allow' && c.ids.length) {
        extraClauses.push(`cc.client_id IN (${c.ids.map(() => '?').join(',')})`);
        extraParams.push(...c.ids);
      }
    }
    if (scope?.verticals) {
      const vs = scope.verticals;
      if (vs.mode === 'none') extraClauses.push('1=0');
      else if (vs.mode === 'allow' && vs.ids.length) {
        extraClauses.push(`cl.vertical_id IN (${vs.ids.map(() => '?').join(',')})`);
        extraParams.push(...vs.ids);
      }
    }
    const [rows] = await pool.query(
      `SELECT cc.id AS contact_id, cc.client_id, cl.client_name,
              cc.contact_name, cc.contact_email, cc.contact_no,
              cc.contact_alt_no, cc.contact_desgn, cc.status
         FROM tbl_client_contacts cc
         LEFT JOIN tbl_client cl ON cl.client_id = cc.client_id
        WHERE ${extraClauses.join(' AND ')}
        ORDER BY cl.client_name ASC, cc.contact_name ASC`,
      extraParams,
    );
    logger.info('Found ' + rows.length + ' SPOC contacts');
    if (req.query.format === 'xlsx') {
      const buf = await xlsxSvc.exportSpocList(rows);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="client-spoc-report-${new Date().toISOString().slice(0, 10)}.xlsx"`);
      return res.send(buf);
    }
    modernOk(res, rows);
  } catch (e) { next(e); }
});

/*
 * GET /admin/clients/bulk-spoc-template
 *
 * Xlsx template for the bulk Primary/Secondary SPOC assignment upload.
 * Columns: clientId, clientName (reference), primaryUserId, secondaryUserId.
 */
router.get('/bulk-spoc-template', async (req, res, next) => {
  try {
    logger.info('Download bulk SPOC assignment template');
    const buf = await xlsxSvc.buildBulkSpocAssignmentTemplate();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="client-bulk-spoc-template.xlsx"');
    res.send(buf);
  } catch (e) { next(e); }
});

/*
 * POST /admin/clients/bulk-upload-spocs   multipart: file=<xlsx>
 *
 * Parses an Xlsx of (clientId, primaryUserId, secondaryUserId) rows
 * and upserts each into tbl_vertical_mapping (user_type=1 for Primary,
 * user_type=2 for Secondary). Per-row report shape:
 *   { rowNumber, status: 'updated'|'invalid'|'skipped'|'failed', errors?, reason? }
 *
 * Validation per row:
 *   1. Row shape (clientId + 2 user IDs all positive ints; Primary != Secondary)
 *   2. Both user IDs exist as active internal users (cached lookup)
 *
 * Mirrors the legacy `processClientSpocExcel` semantics but with the
 * additional dignity of running each row in a TX and returning a
 * structured per-row report.
 */
router.post(
  '/bulk-upload-spocs',
  requireClientEdit,
  upload.single('file'),
  async (req, res, next) => {
    try {
      logger.info('Bulk upload SPOC assignments');
      if (!req.file) return modernError(res, 400, 'missing "file" upload');
      const { rows } = await xlsxSvc.parseBulkSpocAssignment(req.file.buffer);
      logger.info('Parsed ' + rows.length + ' SPOC assignment rows');
      const validUsers = await verticalsSvc.activeInternalUserIds();
      const out = { total: rows.length, updated: 0, invalid: 0, skipped: 0, failed: 0 };
      const results = [];
      for (const r of rows) {
        if (r.status === 'invalid') {
          out.invalid++;
          results.push({ rowNumber: r.rowNumber, status: 'invalid', errors: r.errors });
          continue;
        }
        const { clientId, primaryUserId, secondaryUserId } = r.payload;
        // User validity check (legacy parity)
        const userErrors = [];
        if (!validUsers.has(primaryUserId))   userErrors.push(`Primary user ${primaryUserId} not found / inactive`);
        if (!validUsers.has(secondaryUserId)) userErrors.push(`Secondary user ${secondaryUserId} not found / inactive`);
        if (userErrors.length) {
          out.invalid++;
          results.push({ rowNumber: r.rowNumber, status: 'invalid', errors: userErrors });
          continue;
        }
        try {
          const res2 = await verticalsSvc.upsertPrimarySecondarySpoc(clientId, primaryUserId, secondaryUserId);
          out.updated++;
          results.push({ rowNumber: r.rowNumber, status: 'updated', detail: res2 });
        } catch (e) {
          if (e.status === 404) {
            out.skipped++;
            results.push({ rowNumber: r.rowNumber, status: 'skipped', reason: e.message });
          } else {
            out.failed++;
            results.push({ rowNumber: r.rowNumber, status: 'failed', errors: [e.message] });
          }
        }
      }
      logger.info('SPOC bulk upload done · updated=' + out.updated + ' invalid=' + out.invalid + ' skipped=' + out.skipped + ' failed=' + out.failed);
      modernOk(res, { summary: out, results });
    } catch (e) {
      if (e.code === 'LIMIT_FILE_SIZE') logger.warn('SPOC bulk upload failed · ' + e.message);
      if (e.code === 'LIMIT_FILE_SIZE') return modernError(res, 400, 'file exceeds 10MB');
      if (e.status) logger.warn('SPOC bulk upload failed · ' + e.message);
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  },
);

/*
 * GET /admin/clients/spoc-template
 *
 * Empty XLSX template for SPOC bulk upload — column headers + one
 * demo row so operators can copy-edit instead of starting from scratch.
 */
router.get('/spoc-template', async (req, res, next) => {
  try {
    logger.info('Download SPOC upload template');
    const buf = await xlsxSvc.buildSpocTemplate();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="client-spoc-template.xlsx"');
    res.send(buf);
  } catch (e) { next(e); }
});

/*
 * POST /admin/clients/bulk-template
 *
 * Body: { action: 'spoc' | 'monthly_revenue', clientIds: number[] }
 *
 * Downloads a pre-seeded XLSX template. Each selected client becomes
 * one pre-filled row (Client ID + Client Name in reference columns).
 * For 'spoc': adds empty Primary SPOC User ID + Secondary SPOC User ID.
 * For 'monthly_revenue': adds an empty Monthly Revenue (INR) column.
 *
 * Registration: BEFORE /:id catch-all so the literal segment is matched.
 */
router.post(
  '/bulk-template',
  requireClientEdit,
  validate(v.bulkTemplateBody),
  async (req, res, next) => {
    try {
      const { action, clientIds } = req.body;
      logger.info('Build bulk template · action=' + action + ' clientIds=' + (clientIds ? clientIds.length : 0));
      // Scope-filter: only return clients visible to this operator.
      const scope = require('../../lib/scope').buildRequestScope(req);
      const scopeClauses = [];
      const scopeParams = [];
      if (scope?.clients) {
        const c = scope.clients;
        if (c.mode === 'none') {
          return modernError(res, 403, 'no clients in scope');
        } else if (c.mode === 'allow' && c.ids.length) {
          scopeClauses.push(`client_id IN (${c.ids.map(() => '?').join(',')})`);
          scopeParams.push(...c.ids);
        }
      }
      if (scope?.verticals) {
        const vs = scope.verticals;
        if (vs.mode === 'none') {
          return modernError(res, 403, 'no verticals in scope');
        } else if (vs.mode === 'allow' && vs.ids.length) {
          scopeClauses.push(`vertical_id IN (${vs.ids.map(() => '?').join(',')})`);
          scopeParams.push(...vs.ids);
        }
      }
      // Build the final WHERE for the requested clientIds + scope.
      const idPlaceholders = clientIds.map(() => '?').join(',');
      const where = scopeClauses.length
        ? `client_id IN (${idPlaceholders}) AND ${scopeClauses.join(' AND ')}`
        : `client_id IN (${idPlaceholders})`;
      const [clients] = await pool.query(
        `SELECT client_id, client_name FROM tbl_client WHERE ${where} ORDER BY client_name`,
        [...clientIds, ...scopeParams],
      );
      let buf;
      let filename;
      if (action === 'spoc') {
        buf = await xlsxSvc.buildBulkSpocAssignmentTemplate(clients);
        filename = 'bulk-spoc-template.xlsx';
      } else {
        buf = await xlsxSvc.buildBulkMonthlyRevenueTemplate(clients);
        filename = 'bulk-monthly-revenue-template.xlsx';
      }
      logger.info('Built ' + action + ' template for ' + clients.length + ' clients');
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(buf);
    } catch (e) {
      if (e.status) logger.warn('Build bulk template failed · ' + e.message);
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  },
);

/*
 * POST /admin/clients/bulk-upload
 *
 * multipart/form-data:  file=<xlsx>  action=<'spoc'|'monthly_revenue'>
 *                       [dryRun=<'true'|'false'>]
 *
 * Returns: { summary: {...}, results: [{ rowNumber, status, ... }], dryRun: bool }
 *
 * When dryRun=true → parse + validate + build the same {summary, results}
 * WITHOUT any writes. When dryRun=false (default) → commit (current behaviour).
 *
 * For 'spoc':
 *   - Delegates to the same parseBulkSpocAssignment + upsertPrimarySecondarySpoc
 *     path that /bulk-upload-spocs uses. Summary: { total, updated, invalid,
 *     skipped, failed }; per-row status: 'updated'|'invalid'|'skipped'|'failed'.
 *
 * For 'monthly_revenue':
 *   - Parses Client ID + Monthly Revenue from the template.
 *   - Validates: clientId is a positive int that exists AND is in scope.
 *   - Updates tbl_client SET monthly_revenue = ? WHERE client_id = ?.
 *   - Summary: { total, updated, invalid, failed }.
 *   - Per-row status: 'updated'|'invalid'|'failed'.
 *
 * Registration: BEFORE /:id catch-all.
 */
router.post(
  '/bulk-upload',
  requireClientEdit,
  upload.single('file'),
  validate(v.bulkUploadBody),
  async (req, res, next) => {
    try {
      if (!req.file) return modernError(res, 400, 'missing "file" upload');
      const { action } = req.body;
      // dryRun arrives as a FormData text field ("true"/"false") or Joi-coerced bool.
      const dryRun = req.body.dryRun === true || req.body.dryRun === 'true';
      logger.info('Bulk upload · action=' + action + ' dryRun=' + dryRun);

      if (action === 'spoc') {
        // ── Delegate to existing SPOC assignment path ──────────────
        const { rows } = await xlsxSvc.parseBulkSpocAssignment(req.file.buffer);
        logger.info('Parsed ' + rows.length + ' SPOC rows');
        const validUsers = await verticalsSvc.activeInternalUserIds();
        // Resolve client names once (single query) so the per-row report's
        // Client column shows the name — for both the dry-run preview and commit.
        const spocClientIds = [...new Set(rows.map((r) => r.payload?.clientId).filter(Boolean))];
        const spocNameMap = new Map();
        if (spocClientIds.length) {
          const [crows] = await pool.query(
            `SELECT client_id, client_name FROM tbl_client WHERE client_id IN (${spocClientIds.map(() => '?').join(',')})`,
            spocClientIds,
          );
          for (const c of crows) spocNameMap.set(Number(c.client_id), c.client_name);
        }
        const out = { total: rows.length, updated: 0, invalid: 0, skipped: 0, failed: 0 };
        const results = [];
        for (const r of rows) {
          if (r.status === 'invalid') {
            out.invalid++;
            results.push({ rowNumber: r.rowNumber, status: 'invalid', errors: r.errors });
            continue;
          }
          const { clientId, primaryUserId, secondaryUserId } = r.payload;
          const userErrors = [];
          if (!validUsers.has(primaryUserId))   userErrors.push(`Primary user ${primaryUserId} not found / inactive`);
          if (!validUsers.has(secondaryUserId)) userErrors.push(`Secondary user ${secondaryUserId} not found / inactive`);
          if (userErrors.length) {
            out.invalid++;
            results.push({ rowNumber: r.rowNumber, status: 'invalid', clientId, clientName: spocNameMap.get(clientId) ?? null, errors: userErrors });
            continue;
          }
          if (dryRun) {
            // Dry-run: validation passed — mark as would-be-updated without writing.
            out.updated++;
            results.push({ rowNumber: r.rowNumber, status: 'updated', clientId, clientName: spocNameMap.get(clientId) ?? null, primaryUserId, secondaryUserId });
          } else {
            try {
              const detail = await verticalsSvc.upsertPrimarySecondarySpoc(clientId, primaryUserId, secondaryUserId);
              out.updated++;
              results.push({ rowNumber: r.rowNumber, status: 'updated', clientId, clientName: spocNameMap.get(clientId) ?? null, detail });
            } catch (e) {
              if (e.status === 404) {
                out.skipped++;
                results.push({ rowNumber: r.rowNumber, status: 'skipped', reason: e.message });
              } else {
                out.failed++;
                results.push({ rowNumber: r.rowNumber, status: 'failed', errors: [e.message] });
              }
            }
          }
        }
        logger.info('SPOC bulk upload done · updated=' + out.updated + ' invalid=' + out.invalid + ' skipped=' + out.skipped + ' failed=' + out.failed + ' dryRun=' + dryRun);
        return modernOk(res, { summary: out, results, dryRun });
      }

      // ── Monthly Revenue path ─────────────────────────────────────
      const { rows } = await xlsxSvc.parseBulkMonthlyRevenue(req.file.buffer);
      logger.info('Parsed ' + rows.length + ' monthly-revenue rows');
      const scope = require('../../lib/scope').buildRequestScope(req);
      const out = { total: rows.length, updated: 0, invalid: 0, skipped: 0, failed: 0 };
      const results = [];

      for (const r of rows) {
        if (r.status === 'invalid') {
          out.invalid++;
          results.push({ rowNumber: r.rowNumber, status: 'invalid', errors: r.errors });
          continue;
        }
        const { clientId, monthlyRevenue } = r.payload;

        // Validate client exists AND is in caller's scope (anti-enumeration:
        // out-of-scope → same "not found" message as truly missing).
        let client = null;
        try {
          client = await svc.getClientById(clientId);
        } catch (e) {
          // DB error on this row — count as failed
          out.failed++;
          results.push({ rowNumber: r.rowNumber, status: 'failed', errors: [`DB error: ${e.message}`] });
          continue;
        }
        if (!client) {
          out.invalid++;
          results.push({ rowNumber: r.rowNumber, status: 'invalid', errors: [`Client ID ${clientId} not found`] });
          continue;
        }
        const { assertEntityInScope } = require('../../lib/scope');
        const guard = assertEntityInScope(req, {
          client_id: client.client_id,
          vertical_id: client.vertical_id,
        });
        if (!guard.ok) {
          out.invalid++;
          results.push({ rowNumber: r.rowNumber, status: 'invalid', errors: [`Client ID ${clientId} not found`] });
          continue;
        }

        if (dryRun) {
          // Dry-run: validation passed — mark as would-be-updated without writing.
          out.updated++;
          results.push({ rowNumber: r.rowNumber, status: 'updated', clientId, clientName: client.client_name, monthlyRevenue });
        } else {
          try {
            await pool.query(
              'UPDATE tbl_client SET monthly_revenue = ?, update_date = NOW() WHERE client_id = ?',
              [monthlyRevenue, clientId],
            );
            out.updated++;
            results.push({ rowNumber: r.rowNumber, status: 'updated', clientId, clientName: client.client_name, monthlyRevenue });
          } catch (e) {
            logger.error({ err: e?.message, clientId }, '[bulk-upload] monthly_revenue update failed');
            out.failed++;
            results.push({ rowNumber: r.rowNumber, status: 'failed', errors: [e.message] });
          }
        }
      }
      logger.info('Monthly-revenue bulk upload done · updated=' + out.updated + ' invalid=' + out.invalid + ' failed=' + out.failed + ' dryRun=' + dryRun);
      return modernOk(res, { summary: out, results, dryRun });
    } catch (e) {
      if (e.code === 'LIMIT_FILE_SIZE') logger.warn('Bulk upload failed · ' + e.message);
      if (e.code === 'LIMIT_FILE_SIZE') return modernError(res, 400, 'file exceeds 10MB');
      if (e.status) logger.warn('Bulk upload failed · ' + e.message);
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  },
);

/*
 * GET /custom-property-keys
 *
 * Cross-client distinct list of custom-property keys ever used. Powers
 * the Add Custom Property dropdown in CRM_UI so operators don't need to
 * memorise key strings — they can pick from {hardcoded "well-known"
 * registry} ∪ {DB-discovered keys used elsewhere}, with "Other (custom
 * key)…" as the escape hatch for net-new keys.
 *
 * Auth: any authed CRM user — this is just an autocomplete hint, no
 * client-scoped data leaks (only the key names themselves).
 *
 * Mounted BEFORE `/:id` so the literal segment doesn't get captured as
 * a client_id route param.
 */
router.get('/custom-property-keys', async (req, res, next) => {
  try {
    logger.info('List distinct custom-property keys');
    const keys = await svc.listDistinctCustomPropertyKeys();
    logger.info('Found ' + keys.length + ' custom-property keys');
    modernOk(res, keys);
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    logger.info('Get client · id=' + req.params.id);
    const c = await svc.getClientById(req.params.id);
    if (!c) return modernError(res, 404, 'client not found');
    const guard = assertEntityInScope(req, {
      client_id: c.client_id,
      vertical_id: c.vertical_id,
    });
    if (!guard.ok) logger.warn('Client out of scope · id=' + req.params.id);
    if (!guard.ok) return modernError(res, 404, 'client not found');
    modernOk(res, c);
  } catch (e) { next(e); }
});

router.post(
  '/',
  requireClientAdd,
  validate(v.createClientBody),
  async (req, res, next) => {
    try {
      logger.info('Create client · name=' + (req.body.client_name || req.body.clientName || ''));
      const id = await svc.createClient(req.body, req.user.user_id);
      logger.info('Client created · id=' + id);
      res.status(201);
      modernOk(res, { client_id: id });
    } catch (e) {
      if (e.status) logger.warn('Create client failed · ' + e.message);
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  },
);

router.put(
  '/:id',
  requireClientEdit,
  validate(v.updateClientBody),
  async (req, res, next) => {
    try {
      logger.info('Update client · id=' + req.params.id);
      // Scope-check before mutating.
      const existing = await svc.getClientById(req.params.id);
      if (!existing) return modernError(res, 404, 'client not found');
      const guard = assertEntityInScope(req, {
        client_id: existing.client_id,
        vertical_id: existing.vertical_id,
      });
      if (!guard.ok) logger.warn('Client out of scope · id=' + req.params.id);
      if (!guard.ok) return modernError(res, 404, 'client not found');
      await svc.updateClient(req.params.id, req.body, req.user.user_id);
      logger.info('Client updated · id=' + req.params.id);
      modernOk(res, { updated: true });
    } catch (e) {
      if (e.status) logger.warn('Update client failed · ' + e.message);
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  },
);

/* ─── Client Contacts (SPOCs) ─────────────────────────────────────── */

router.get('/:clientId/contacts', async (req, res, next) => {
  try {
    logger.info('List client contacts · clientId=' + req.params.clientId);
    if (!(await loadAndGuardClient(req, res))) return;
    const rows = await svc.listContacts(req.params.clientId);
    logger.info('Found ' + rows.length + ' contacts');
    modernOk(res, rows);
  } catch (e) { next(e); }
});

/*
 * GET /:clientId/contacts/check-duplicate?email=&phone=&excludeId=
 *
 * Lightweight dup-check for the FE's inline validation. Returns
 * `{ duplicate: null | { id, contact_name, contact_email, contact_no } }`.
 * Mirrors legacy `getClientContactByEmail()` but takes BOTH email and
 * phone (legacy only took email).
 */
router.get(
  '/:clientId/contacts/check-duplicate',
  validate(v.contactDuplicateCheckQuery, 'query'),
  async (req, res, next) => {
    try {
      logger.info('Check contact duplicate · clientId=' + req.params.clientId);
      if (!(await loadAndGuardClient(req, res))) return;
      const dup = await svc.findDuplicateContact({
        clientId: Number(req.params.clientId),
        email: req.query.email,
        phone: req.query.phone,
        excludeId: req.query.excludeId ? Number(req.query.excludeId) : undefined,
      });
      logger.info('Duplicate contact ' + (dup ? 'found · id=' + dup.id : 'not found'));
      modernOk(res, { duplicate: dup });
    } catch (e) { next(e); }
  },
);

router.post(
  '/:clientId/contacts',
  requireClientEdit,
  validate(v.createContactBody),
  async (req, res, next) => {
    try {
      logger.info('Create client contact · clientId=' + req.params.clientId);
      if (!(await loadAndGuardClient(req, res))) return;
      const id = await svc.createContact(req.params.clientId, req.body);
      logger.info('Contact created · id=' + id);
      res.status(201);
      modernOk(res, { id });
    } catch (e) {
      if (e.status) {
        // Surface the conflicting row so the FE can highlight the
        // existing contact rather than just showing "409".
        logger.warn('Create contact failed · ' + e.message);
        return modernError(res, e.status, e.message, e.conflict ? { conflict: e.conflict } : undefined);
      }
      next(e);
    }
  },
);

router.put(
  '/contacts/:id',
  requireClientEdit,
  validate(v.updateContactBody),
  async (req, res, next) => {
    try {
      logger.info('Update client contact · id=' + req.params.id);
      if (!(await guardRowByClientId(req, res, await svc.getContactClientId(req.params.id), 'contact not found'))) return;
      await svc.updateContact(req.params.id, req.body);
      logger.info('Contact updated · id=' + req.params.id);
      modernOk(res, { updated: true });
    } catch (e) {
      if (e.status) {
        logger.warn('Update contact failed · ' + e.message);
        return modernError(res, e.status, e.message, e.conflict ? { conflict: e.conflict } : undefined);
      }
      next(e);
    }
  },
);

/*
 * POST /:clientId/contacts/bulk-upload  multipart: file=<xlsx>
 *
 * Parses an XLSX in-memory, validates rows, attempts to insert each
 * valid row via the existing contact-create service (which also
 * dup-checks). Returns a per-row report:
 *   { summary: { total, created, skipped, invalid },
 *     results: [{ rowNumber, status, contactId?, errors?, reason? }] }
 *
 * No partial-success transaction wrapper — each row is its own write.
 * Operators get visibility into which rows succeeded so they can
 * fix the failed ones and re-upload only those.
 */
router.post(
  '/:clientId/contacts/bulk-upload',
  requireClientEdit,
  upload.single('file'),
  async (req, res, next) => {
    try {
      logger.info('Bulk upload client contacts · clientId=' + req.params.clientId);
      if (!(await loadAndGuardClient(req, res))) return;
      if (!req.file) return modernError(res, 400, 'missing "file" upload');
      const { rows } = await xlsxSvc.parseSpocUpload(req.file.buffer);
      logger.info('Parsed ' + rows.length + ' contact rows');
      const out = { total: rows.length, created: 0, skipped: 0, invalid: 0 };
      const results = [];
      for (const r of rows) {
        if (r.status === 'invalid') {
          out.invalid++;
          results.push({ rowNumber: r.rowNumber, status: 'invalid', errors: r.errors });
          continue;
        }
        try {
          const id = await svc.createContact(req.params.clientId, r.payload);
          out.created++;
          results.push({ rowNumber: r.rowNumber, status: 'created', contactId: id });
        } catch (e) {
          // 409 (dup) is "skipped"; everything else is "failed".
          if (e.status === 409) {
            out.skipped++;
            results.push({ rowNumber: r.rowNumber, status: 'skipped', reason: e.message });
          } else {
            out.invalid++;
            results.push({ rowNumber: r.rowNumber, status: 'failed', errors: [e.message] });
          }
        }
      }
      logger.info('Contact bulk upload done · created=' + out.created + ' skipped=' + out.skipped + ' invalid=' + out.invalid);
      modernOk(res, { summary: out, results });
    } catch (e) {
      if (e.code === 'LIMIT_FILE_SIZE') logger.warn('Contact bulk upload failed · ' + e.message);
      if (e.code === 'LIMIT_FILE_SIZE') return modernError(res, 400, 'file exceeds 10MB');
      if (e.status) logger.warn('Contact bulk upload failed · ' + e.message);
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  },
);

/*
 * PUT /api/admin/clients/contacts/:id/access
 *
 * Assign or change a Client SPOC's portal access — the role that decides which
 * tabs they see in the client dashboard, plus per-person override flags.
 *
 * SEPARATE FROM PUT /contacts/:id ON PURPOSE. That route writes
 * tbl_client_contacts (a legacy table five services read). Access lives in
 * easyfix_client_spoc_access, an EasyFix-owned side table. Keeping the two
 * writes on separate routes means an access change never touches a row the
 * legacy services depend on, and a contact edit can never accidentally reset
 * somebody's permissions.
 *
 * OVERRIDES ARE TRI-STATE. null clears the override (inherit the role), true
 * grants, false revokes. Joi must therefore ALLOW null rather than treat it as
 * absent, or an administrator could never undo an override once set.
 *
 * Guarded by isClientEdit, the same action key the rest of the Contacts tab
 * uses — whoever can edit a SPOC can set what that SPOC may see.
 */
router.put(
  '/contacts/:id/access',
  requireClientEdit,
  validate(v.setContactAccessBody),
  async (req, res, next) => {
    try {
      logger.info('Set client SPOC access · contactId=' + req.params.id);
      const clientId = await svc.getContactClientId(req.params.id);
      if (!(await guardRowByClientId(req, res, clientId, 'contact not found'))) return;
      const out = await svc.setContactAccess(
        Number(req.params.id), Number(clientId), req.body, req.user && req.user.userId,
      );
      logger.info('SPOC access saved · contactId=' + req.params.id + ' · role=' + out.spocRole);
      modernOk(res, out, 'access updated');
    } catch (e) {
      // The access table is optional until the 2026-08-20 migration runs;
      // say so plainly instead of surfacing a raw MySQL error to an operator.
      if (e && e.errno === 1146) {
        logger.warn('SPOC access write failed — easyfix_client_spoc_access not migrated');
        return modernError(res, 503, 'Client access is not enabled on this environment yet. Apply migration 2026-08-20-client-spoc-access.sql.');
      }
      next(e);
    }
  },
);

/*
 * PUT /api/admin/clients/:clientId/contacts/access/bulk
 *
 * Apply one role (and optionally one set of overrides) to many SPOCs at once.
 * Mounted under :clientId rather than on bare /contacts so the existing
 * loadAndGuardClient scope check applies — the service ALSO re-checks that
 * every contactId belongs to this client, because a scope check on the client
 * says nothing about a hand-crafted array of contact ids.
 */
router.put(
  '/:clientId/contacts/access/bulk',
  requireClientEdit,
  validate(v.setContactAccessBulkBody),
  async (req, res, next) => {
    try {
      logger.info('Bulk set client SPOC access · clientId=' + req.params.clientId
        + ' · contacts=' + req.body.contactIds.length);
      if (!(await loadAndGuardClient(req, res))) return;
      const out = await svc.setContactAccessBulk(
        Number(req.params.clientId), req.body.contactIds, req.body, req.user && req.user.userId,
      );
      logger.info('Bulk SPOC access saved · updated=' + out.updated + ' skipped=' + (out.skipped || 0));
      modernOk(res, out, `Access updated for ${out.updated} SPOC${out.updated === 1 ? '' : 's'}`);
    } catch (e) {
      if (e && e.errno === 1146) {
        logger.warn('Bulk SPOC access write failed — easyfix_client_spoc_access not migrated');
        return modernError(res, 503, 'Client access is not enabled on this environment yet. Apply migration 2026-08-20-client-spoc-access.sql.');
      }
      next(e);
    }
  },
);

/*
 * GET /api/admin/clients/contacts/access-roles
 *
 * The role catalogue, served from services/client-access.service.js so the
 * CRM dropdown and the portal's own gate read the SAME definition. A
 * hand-copied list in the UI drifts the first time a role gains a surface.
 */
router.get('/contacts/access-roles', (req, res) => {
  const { OVERRIDE_GRANTS, SURFACES, roleCatalogue } = require('../../services/client-access.service');
  return modernOk(res, {
    // AS CONFIGURED, not as coded — a role whose screens were changed from the
    // CRM must read back changed, or the screen would show stale defaults and
    // the next save would silently revert somebody's edit.
    roles: roleCatalogue(),
    // The full surface vocabulary, so the CRM renders a checkbox per screen
    // without hard-coding the list and drifting from the server.
    surfaces: SURFACES,
    overrides: Object.entries(OVERRIDE_GRANTS).map(([flag, surface]) => ({ flag, surface })),
  });
});

/*
 * PUT /api/admin/clients/contacts/access-roles/:roleId
 *
 * Set which screens a ROLE grants by default. This is the tier above the
 * per-SPOC overrides: a role change moves every SPOC holding it who has no
 * override on that surface, which is the point — "Finance should see the
 * performance book" is one edit, not one per person.
 *
 * Guarded by the same isClientEdit key as the rest of the Contacts tab.
 *
 * NOT settable: role 0 ("No Role"). It is the ABSENCE of configuration, and
 * its behaviour is governed by UNASSIGNED_FAILS_OPEN in the service — a
 * deliberate rollout posture, not a per-deployment toggle an operator should
 * be able to flip from a form.
 */
router.put(
  '/contacts/access-roles/:roleId',
  requireClientEdit,
  validate(v.setRoleAccessBody),
  async (req, res, next) => {
    try {
      const svc = require('../../services/client-access.service');
      const out = await svc.setRoleAccess(
        Number(req.params.roleId),
        req.body.surfaces,
        req.body.allStores,
        req.user && req.user.userId
      );
      logger.info('Role access updated · role=' + out.roleId + ' · surfaces=' + out.surfaces.join('|'));
      return modernOk(res, out);
    } catch (e) {
      if (e && e.status === 400) return modernError(res, 400, e.message);
      return next(e);
    }
  }
);

router.delete(
  '/contacts/:id',
  requireClientEdit,
  async (req, res, next) => {
    try {
      logger.info('Delete client contact · id=' + req.params.id);
      if (!(await guardRowByClientId(req, res, await svc.getContactClientId(req.params.id), 'contact not found'))) return;
      const affected = await svc.deleteContact(req.params.id);
      if (!affected) return modernError(res, 404, 'contact not found');
      logger.info('Contact deleted · id=' + req.params.id);
      modernOk(res, { deleted: true });
    } catch (e) { next(e); }
  },
);

/* ─── Client Billing ──────────────────────────────────────────────── */

router.get('/:clientId/billing', async (req, res, next) => {
  try {
    logger.info('List client billing · clientId=' + req.params.clientId);
    if (!(await loadAndGuardClient(req, res))) return;
    const rows = await svc.listBilling(req.params.clientId);
    logger.info('Found ' + rows.length + ' billing rows');
    modernOk(res, rows);
  } catch (e) { next(e); }
});

router.post(
  '/:clientId/billing',
  requireClientEdit,
  validate(v.createBillingBody),
  async (req, res, next) => {
    try {
      logger.info('Create client billing · clientId=' + req.params.clientId);
      if (!(await loadAndGuardClient(req, res))) return;
      const id = await svc.createBilling(req.params.clientId, req.body);
      logger.info('Billing created · id=' + id);
      res.status(201);
      modernOk(res, { c_bill_id: id });
    } catch (e) {
      if (e.status) logger.warn('Create billing failed · ' + e.message);
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  },
);

router.put(
  '/billing/:id',
  requireClientEdit,
  validate(v.updateBillingBody),
  async (req, res, next) => {
    try {
      logger.info('Update client billing · id=' + req.params.id);
      if (!(await guardRowByClientId(req, res, await svc.getBillingClientId(req.params.id), 'billing row not found'))) return;
      const affected = await svc.updateBilling(req.params.id, req.body);
      if (!affected) return modernError(res, 404, 'billing row not found');
      logger.info('Billing updated · id=' + req.params.id);
      modernOk(res, { updated: true });
    } catch (e) {
      if (e.status) logger.warn('Update billing failed · ' + e.message);
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  },
);

router.delete(
  '/billing/:id',
  requireClientEdit,
  async (req, res, next) => {
    try {
      logger.info('Delete client billing · id=' + req.params.id);
      if (!(await guardRowByClientId(req, res, await svc.getBillingClientId(req.params.id), 'billing row not found'))) return;
      const affected = await svc.deleteBilling(req.params.id);
      if (!affected) return modernError(res, 404, 'billing row not found');
      logger.info('Billing deleted · id=' + req.params.id);
      modernOk(res, { deleted: true });
    } catch (e) { next(e); }
  },
);

/* ─── Client Custom Properties ────────────────────────────────────── */

/*
 * GET /:clientId/custom-properties
 *
 * Returns the normalised shape used by Book-New-Call. See the long
 * comment in the previous revision for the rationale — kept identical
 * here so consumers don't break.
 */
router.get('/:clientId/custom-properties', async (req, res, next) => {
  try {
    logger.info('List client custom properties · clientId=' + req.params.clientId);
    if (!(await loadAndGuardClient(req, res))) return;
    const rows = await svc.listCustomProperties(req.params.clientId);
    const truthy = (val) => {
      if (val == null) return false;
      if (typeof val === 'boolean') return val;
      if (typeof val === 'number') return val !== 0;
      const s = String(val).trim().toLowerCase();
      return s === '1' || s === 'true' || s === 'yes' || s === 'y';
    };
    const normalised = rows.map((r) => ({
      // Legacy table has TWO schema variants — canonical
      // (`property_name` / `property_value` / `is_mandatory` + `id` PK)
      // and legacy (`c_prop_name` / `c_prop_values` PLURAL /
      // `c_prop_mandatory` + `c_prop_id` PK). The fallback chain
      // covers both plus a few one-off historical aliases.
      name: String(r.property_name ?? r.c_prop_name ?? r.name ?? r.key ?? r.field_name ?? '').toLowerCase().trim(),
      /*
       * Falls back to the RAW (un-lowercased) property name. `name` above is
       * lowercased for key matching, so without this a generic renderer would
       * label the field "gstin/uin" instead of "GSTIN/UIN" — the operator sees
       * the lookup key rather than the thing they were asked to collect.
       * Mirrors routes/client/index.js, which already ends its chain in `raw`.
       */
      label: r.property_label ?? r.c_prop_label ?? r.label ?? r.display_name
        ?? (String(r.property_name ?? r.c_prop_name ?? r.name ?? '').trim() || null),
      mandatory: truthy(r.is_mandatory ?? r.c_prop_mandatory ?? r.mandatory ?? r.required ?? r.is_required ?? r.is_required_field),
      value: r.property_value ?? r.c_prop_values ?? r.value ?? r.field_value ?? null,
      // is_config discriminator (0/1): 1 = client-level CONFIG/CONTROL row
      // (hidden from booking forms + templates). Absent on pre-migration rows
      // → defaults to 0 so the CRM checkbox renders unchecked.
      is_config: truthy(r.is_config) ? 1 : 0,
      // Surface the row id so the FE edit/delete flows have a target.
      // Legacy PK is c_prop_id; canonical is id. Either way the FE
      // gets a `id` to bind to.
      id: r.id ?? r.c_prop_id ?? null,
      raw: r,
    })).filter((p) => p.name);

    /*
     * ?bookingOnly=1 — OPT-IN, and opt-in on purpose.
     *
     * This endpoint has THREE consumers with genuinely different needs, which
     * is why the filter cannot live in the route unconditionally:
     *   • components/client/CustomPropsTab — the client-properties EDITOR
     *     (GET/POST/PUT/DELETE on this path). It must see is_config rows so an
     *     operator can manage Order Confirmation Mode / Auto Process
     *     Unconfirmed Order at all. Filtering them out here would delete those
     *     controls from the admin UI.
     *   • JobModal Book New Call + the public job-completion form — booking
     *     surfaces, which must NOT offer a backend switch as a data-entry
     *     field, nor a soft-deleted property.
     *
     * Default stays UNFILTERED so the editor is byte-for-byte unchanged; the
     * booking surfaces ask for the narrower set. Mirrors the filter
     * routes/client/index.js:114 already applies for the client portal.
     *
     * Filtered in JS rather than SQL deliberately: `is_config` arrives from a
     * 2026-07-10 migration and is absent on pre-migration deploys, where a
     * WHERE clause naming it would 500 the whole page. An absent column reads
     * as undefined here, which truthy() treats as "not config" — the safe
     * default, matching the normalisation above.
     */
    const bookingOnly = ['1', 'true', 'yes'].includes(
      String(req.query.bookingOnly ?? '').trim().toLowerCase(),
    );
    const out = bookingOnly
      ? normalised.filter((p) => truthy(p.raw?.status ?? 1) && !truthy(p.is_config))
      : normalised;

    logger.info('Returning ' + out.length + ' custom properties'
      + (bookingOnly ? ' (bookingOnly — ' + (normalised.length - out.length) + ' config/inactive hidden)' : ''));
    modernOk(res, out);
  } catch (e) { next(e); }
});

router.post(
  '/:clientId/custom-properties',
  requireClientEdit,
  validate(v.createCustomPropertyBody),
  async (req, res, next) => {
    try {
      logger.info('Create custom property · clientId=' + req.params.clientId + ' name=' + (req.body.name || req.body.property_name || ''));
      if (!(await loadAndGuardClient(req, res))) return;
      const id = await svc.createCustomProperty(req.params.clientId, req.body);
      logger.info('Custom property created · id=' + id);
      res.status(201);
      modernOk(res, { id });
    } catch (e) {
      if (e.status) logger.warn('Create custom property failed · ' + e.message);
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  },
);

router.put(
  '/custom-properties/:id',
  requireClientEdit,
  validate(v.updateCustomPropertyBody),
  async (req, res, next) => {
    try {
      logger.info('Update custom property · id=' + req.params.id);
      if (!(await guardRowByClientId(req, res, await svc.getCustomPropertyClientId(req.params.id), 'custom property not found'))) return;
      const affected = await svc.updateCustomProperty(req.params.id, req.body);
      if (!affected) return modernError(res, 404, 'custom property not found');
      logger.info('Custom property updated · id=' + req.params.id);
      modernOk(res, { updated: true });
    } catch (e) {
      if (e.status) logger.warn('Update custom property failed · ' + e.message);
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  },
);

router.delete(
  '/custom-properties/:id',
  requireClientEdit,
  async (req, res, next) => {
    try {
      logger.info('Delete custom property · id=' + req.params.id);
      if (!(await guardRowByClientId(req, res, await svc.getCustomPropertyClientId(req.params.id), 'custom property not found'))) return;
      const affected = await svc.deleteCustomProperty(req.params.id);
      if (!affected) return modernError(res, 404, 'custom property not found');
      logger.info('Custom property deleted · id=' + req.params.id);
      modernOk(res, { deleted: true });
    } catch (e) { next(e); }
  },
);

/* ─── Collected-By Preference ─────────────────────────────────────── */

/*
 * GET /:clientId/collected-by-preference
 *
 * Preserves the existing endpoint contract — the Book-New-Call flow
 * depends on this exact shape ({ preferred, source }). Code unchanged
 * from the previous revision.
 */
const COLLECTED_BY_MAP = {
  1: 'Easyfixer',
  2: 'Easyfix',
  3: 'Client',
};

router.get('/:clientId/collected-by-preference', async (req, res, next) => {
  try {
    logger.info('Get collected-by preference · clientId=' + req.params.clientId);
    const clientId = Number(req.params.clientId);
    if (!Number.isInteger(clientId) || clientId <= 0) {
      return modernError(res, 400, 'invalid clientId');
    }
    let preferred = null;
    let source = 'default';
    try {
      const row = await svc.getClientById(clientId);
      if (row) {
        const code = Number(row.collected_by);
        if (Number.isFinite(code) && COLLECTED_BY_MAP[code]) {
          preferred = COLLECTED_BY_MAP[code];
          source = 'client';
        } else if (code === 0) {
          preferred = null;
          source = 'client';
        }
      }
    } catch (e) {
      // Defensive: if collected_by column doesn't exist on this DB,
      // fall back to "any" rather than 500.
      logger.warn({ err: e }, 'collected-by-pref: tbl_client.collected_by read failed — falling back to "any"');
    }
    modernOk(res, { preferred, source });
  } catch (e) { next(e); }
});

/* ─── Vertical Mapping (per-client) ───────────────────────────────── */

/*
 * GET /:clientId/verticals
 *
 * Returns the list of (vertical, user, user_type) assignments for the
 * client, joined to tbl_vertical (name) and tbl_user (display name +
 * email). user_type column is tolerated absent — returned as null.
 */
router.get('/:clientId/verticals', async (req, res, next) => {
  try {
    logger.info('List client verticals · clientId=' + req.params.clientId);
    if (!(await loadAndGuardClient(req, res))) return;
    const rows = await verticalsSvc.listForClient(req.params.clientId);
    logger.info('Found ' + rows.length + ' vertical mappings');
    modernOk(res, rows);
  } catch (e) { next(e); }
});

/*
 * PUT /:clientId/verticals
 * Body: { assignments: [{ verticalId, userId, userType? }] }
 *
 * Replace-set semantics — the legacy UI saves the whole assignment
 * grid at once. Transactionally deletes existing rows for the client
 * and re-inserts. Empty assignments array clears all mappings.
 */
/*
 * PUT /:clientId/verticals/upsert-spoc
 *   { primaryUserId, secondaryUserId }
 *
 * Upserts the (Primary, Secondary) SPOC pair for ONE client. Used by
 * the Add Client form and the inline edit on the client detail. Backed
 * by `verticalsSvc.upsertPrimarySecondarySpoc` — single TX, two
 * statements (one per role) with INSERT-or-UPDATE semantics keyed on
 * `(client_id, user_type)`.
 */
router.put(
  '/:clientId/verticals/upsert-spoc',
  requireClientEdit,
  async (req, res, next) => {
    try {
      logger.info('Upsert client SPOC pair · clientId=' + req.params.clientId);
      if (!(await loadAndGuardClient(req, res))) return;
      const primaryUserId   = Number(req.body?.primaryUserId);
      const secondaryUserId = Number(req.body?.secondaryUserId);
      if (!Number.isInteger(primaryUserId) || primaryUserId <= 0) {
        return modernError(res, 400, 'primaryUserId is required');
      }
      if (!Number.isInteger(secondaryUserId) || secondaryUserId <= 0) {
        return modernError(res, 400, 'secondaryUserId is required');
      }
      if (primaryUserId === secondaryUserId) {
        return modernError(res, 400, 'Primary and Secondary SPOC must be different users');
      }
      const result = await verticalsSvc.upsertPrimarySecondarySpoc(
        req.params.clientId, primaryUserId, secondaryUserId,
      );
      logger.info('SPOC pair upserted · clientId=' + req.params.clientId);
      modernOk(res, result);
    } catch (e) {
      if (e.status) logger.warn('Upsert SPOC pair failed · ' + e.message);
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  },
);

router.put(
  '/:clientId/verticals',
  requireClientEdit,
  validate(v.replaceVerticalsBody),
  async (req, res, next) => {
    try {
      logger.info('Replace client verticals · clientId=' + req.params.clientId + ' assignments=' + (req.body.assignments ? req.body.assignments.length : 0));
      if (!(await loadAndGuardClient(req, res))) return;
      const written = await verticalsSvc.replaceForClient(req.params.clientId, req.body.assignments);
      logger.info('Vertical mappings written · count=' + written);
      modernOk(res, { written });
    } catch (e) {
      if (e.status) logger.warn('Replace verticals failed · ' + e.message);
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  },
);

/* ─── Client Services (catalog of category + service types) ───────── */

/*
 * GET /:clientId/services
 *
 * Returns the client's subscribed services with category name AND
 * resolved service-type names attached per row. Designed as exactly
 * 2 SQL queries regardless of row count — see service-layer notes.
 *
 * SHARED CHARGE CASCADE — each row carries a `charges` object computed
 * from the rate-card columns via utils/rate-card-calc.js (the same
 * helper used at tbl_job_services write time). See the docblock there
 * for the formula. Per-unit values shown here; the actual job-line
 * row in tbl_job_services multiplies by the operator's quantity.
 */
const { describe: describeRoute } = require('../../docs/openapi-autogen');
router.get('/:clientId/services',
  describeRoute('Get client rate-card services with charge cascade', {
    description: [
      'Returns the client\'s subscribed services (active only) with:',
      '  • basic catalog (service category, service types, status)',
      '  • the 6 rate-card cost columns (easyfix_direct_fixed, ',
      '    easyfix_direct_variable, overhead_fixed, overhead_variable, ',
      '    client_fixed, client_variable)',
      '  • a per-unit `charges` object computed via the shared cascade',
      '    (see utils/rate-card-calc.js)',
      '',
      '**Charge cascade formula** (variable% then fixed, per layer):',
      '  Start with `total_charge` (unit price = tbl_client_service.total_amount).',
      '  L1 Easyfix Direct: deduct (var% × remaining) + fixed',
      '  L2 Overhead:       deduct (var% × remaining) + fixed',
      '  L3 Client Share:   deduct (var% × remaining) + fixed',
      '  L4 Easyfixer:      everything left',
      '',
      'Variable rates are stored as % (e.g. 10 = 10%) and divided by 100',
      'before applying. `easyfix_charge` BUNDLES L1+L2 since tbl_job_services',
      'has no overhead_charge column (keeps sum-to-total invariant).',
      '',
      '**Example**: total_amount=400, easyfix_direct_fixed=200/var=10, ',
      'overhead_fixed=10/var=20, client=0/0 → easyfix_charge=282, ',
      'client_charge=0, easyfixer_charge=118.',
    ].join('\n'),
    tags: ['Admin — Clients'],
  }),
  async (req, res, next) => {
    try {
      logger.info('List client services · clientId=' + req.params.clientId + ' includeInactive=' + (req.query.includeInactive || 'false'));
      if (!(await loadAndGuardClient(req, res))) return;
      // ?includeInactive=1 surfaces soft-deleted (service_status=0) rows
      // too, matching the legacy Manage Client Services page which shows
      // both Active and Inactive in the same paginated list. Default
      // false preserves the existing dropdown/picker behaviour elsewhere.
      const includeInactive = String(req.query.includeInactive || '') === '1'
        || String(req.query.includeInactive || '') === 'true';
      const rows = await clientServicesSvc.listForClient(
        req.params.clientId,
        { includeInactive },
      );
      logger.info('Found ' + rows.length + ' client services');
      modernOk(res, rows);
    } catch (e) { next(e); }
  },
);

/*
 * GET /services/:id — single-row fetch with cascade `charges` attached.
 *
 * Why this exists in addition to the list endpoint: the legacy Edit
 * Client Services modal needs to prefill 12 fields (category + types +
 * charge_type + total_amount + 6 cost columns + status). Fetching just
 * one row by id is cheaper than re-listing all of a client's services
 * and filtering on the FE, and the response carries the per-unit
 * cascade ready to render in the "Show Formula" expandable helper.
 */
router.get(
  '/services/:id',
  describeRoute('Get a single client rate-card service with charge cascade', {
    description: [
      'Single-row fetch used by the Edit Client Services modal to prefill',
      'every field (category, service types, charge type, total amount,',
      'and the 6 rate-card cost columns) plus the computed per-unit',
      '`charges` breakdown from the shared cascade (utils/rate-card-calc.js).',
      '',
      'Returns 404 when the id does not exist or has been hard-deleted.',
      'Soft-deleted rows (service_status=0) are STILL returned here so',
      'operators can edit and reactivate an inactive subscription.',
    ].join('\n'),
    tags: ['Admin — Clients'],
  }),
  async (req, res, next) => {
    try {
      logger.info('Get client service · id=' + req.params.id);
      if (!(await guardRowByClientId(req, res, await svc.getServiceClientId(req.params.id), 'client service not found'))) return;
      const row = await clientServicesSvc.getOne(req.params.id);
      if (!row) return modernError(res, 404, 'client service not found');
      modernOk(res, row);
    } catch (e) { next(e); }
  },
);

router.post(
  '/:clientId/services',
  requireClientEdit,
  validate(v.createClientServiceBody),
  describeRoute('Create a client rate-card service row (full cascade)', {
    description: [
      'Inserts one tbl_client_service row capturing the whole legacy',
      '"Add Client Service" modal in ONE POST. Accepts:',
      '  • serviceCategoryId, serviceTypeIds (multi-select)',
      '  • chargeType (free string — legacy "Fixed"/"Variable"/etc.)',
      '  • totalCharge (per-unit price; tbl_client_service.total_amount)',
      '  • 6 cost columns (Easyfix Direct/Overhead/Client Share × Fixed/Variable)',
      '  • serviceStatus (defaults to 1 = Active when omitted)',
      '',
      'Variable rates are stored as % (e.g. 10 = 10%) — the cascade in',
      'utils/rate-card-calc.js divides by 100 before applying. Both Fixed',
      'AND Variable can be non-zero on the same layer (legacy form behaviour).',
      '',
      '**Cascade formula** (variable% then fixed, per layer):',
      '  remaining ← totalCharge',
      '  L1 Easyfix Direct: cut = (remaining × var%) + fixed',
      '  L2 Overhead:       cut = (remaining × var%) + fixed',
      '  L3 Client Share:   cut = (remaining × var%) + fixed',
      '  L4 Easyfixer:      everything left after L1+L2+L3',
      '',
      '`easyfix_charge` (on tbl_job_services) BUNDLES L1+L2 since there',
      'is no overhead_charge column — preserves the invariant',
      '`easyfix_charge + client_charge + easyfixer_charge = total_cost`.',
    ].join('\n'),
    tags: ['Admin — Clients'],
  }),
  async (req, res, next) => {
    try {
      logger.info('Create client service · clientId=' + req.params.clientId + ' serviceCategoryId=' + (req.body.serviceCategoryId || ''));
      if (!(await loadAndGuardClient(req, res))) return;
      const id = await clientServicesSvc.create(req.params.clientId, req.body);
      logger.info('Client service created · id=' + id);
      res.status(201);
      modernOk(res, { client_service_id: id });
    } catch (e) {
      if (e.status) logger.warn('Create client service failed · ' + e.message);
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  },
);

router.put(
  '/services/:id',
  requireClientEdit,
  validate(v.updateClientServiceBody),
  describeRoute('Partial-update a client rate-card service row', {
    description: [
      'Partial update — any subset of these fields:',
      '  serviceCategoryId, serviceTypeIds, chargeType, totalCharge,',
      '  easyfixDirectFixed, easyfixDirectVariable,',
      '  overheadFixed, overheadVariable,',
      '  clientFixed, clientVariable,',
      '  serviceStatus',
      '',
      'Fields not present in the body are LEFT UNTOUCHED. Sending null',
      'explicitly clears a cost column (the cascade then treats it as 0).',
      '',
      'See POST /:clientId/services for the full cascade formula docs.',
    ].join('\n'),
    tags: ['Admin — Clients'],
  }),
  async (req, res, next) => {
    try {
      logger.info('Update client service · id=' + req.params.id);
      if (!(await guardRowByClientId(req, res, await svc.getServiceClientId(req.params.id), 'client service not found'))) return;
      const affected = await clientServicesSvc.update(req.params.id, req.body);
      if (!affected) return modernError(res, 404, 'client service not found');
      logger.info('Client service updated · id=' + req.params.id);
      modernOk(res, { updated: true });
    } catch (e) {
      if (e.status) logger.warn('Update client service failed · ' + e.message);
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  },
);

router.delete(
  '/services/:id',
  requireClientEdit,
  async (req, res, next) => {
    try {
      logger.info('Delete client service · id=' + req.params.id);
      if (!(await guardRowByClientId(req, res, await svc.getServiceClientId(req.params.id), 'client service not found'))) return;
      const affected = await clientServicesSvc.softDelete(req.params.id);
      if (!affected) return modernError(res, 404, 'client service not found');
      logger.info('Client service deleted · id=' + req.params.id);
      modernOk(res, { deleted: true });
    } catch (e) { next(e); }
  },
);

/* ─── Client Rate Cards ───────────────────────────────────────────── */

/*
 * GET /:clientId/rate-cards → 1-query list.
 * PUT /:clientId/rate-cards → bulk-upsert. Body: { rows: [...] }.
 * DELETE /rate-cards/:id    → remove a single row.
 *
 * The bulk-upsert is one INSERT … ON DUPLICATE KEY UPDATE — saving the
 * entire rate-card grid (potentially 50+ service types) costs ONE DB
 * round-trip. See services/client-rate-cards.service.js for why we
 * probe the composite-unique-key presence + how degradation works.
 */
router.get('/:clientId/rate-cards', async (req, res, next) => {
  try {
    logger.info('List client rate cards · clientId=' + req.params.clientId);
    if (!(await loadAndGuardClient(req, res))) return;
    const rows = await rateCardsSvc.listForClient(req.params.clientId);
    logger.info('Found ' + rows.length + ' rate-card rows');
    modernOk(res, rows);
  } catch (e) { next(e); }
});

router.put(
  '/:clientId/rate-cards',
  requireClientEdit,
  validate(v.bulkUpsertRateCardsBody),
  async (req, res, next) => {
    try {
      logger.info('Bulk-upsert client rate cards · clientId=' + req.params.clientId + ' rows=' + (req.body.rows ? req.body.rows.length : 0));
      if (!(await loadAndGuardClient(req, res))) return;
      const affected = await rateCardsSvc.bulkUpsert(req.params.clientId, req.body.rows);
      logger.info('Rate cards upserted · affected=' + affected);
      modernOk(res, { affected });
    } catch (e) {
      if (e.status) logger.warn('Bulk-upsert rate cards failed · ' + e.message);
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  },
);

/*
 * GET /:clientId/rate-cards/download
 * Streams the client's rate card grid as XLSX with type names joined.
 */
router.get('/:clientId/rate-cards/download', async (req, res, next) => {
  try {
    logger.info('Download client rate cards XLSX · clientId=' + req.params.clientId);
    const client = await loadAndGuardClient(req, res);
    if (!client) return;
    const rows = await rateCardsSvc.listForClient(req.params.clientId);
    logger.info('Exporting ' + rows.length + ' rate-card rows to XLSX');
    const buf = await xlsxSvc.exportRateCards(client.client_name, rows);
    const safeName = String(client.client_name || `client-${client.client_id}`).replace(/[^a-z0-9_-]+/gi, '_');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="rate-cards-${safeName}.xlsx"`);
    res.send(buf);
  } catch (e) { next(e); }
});

router.delete(
  '/rate-cards/:id',
  requireClientEdit,
  async (req, res, next) => {
    try {
      logger.info('Delete client rate card · id=' + req.params.id);
      const affected = await rateCardsSvc.deleteOne(req.params.id);
      if (!affected) return modernError(res, 404, 'rate card not found');
      logger.info('Rate card deleted · id=' + req.params.id);
      modernOk(res, { deleted: true });
    } catch (e) { next(e); }
  },
);

/* ─── Technician Mapping (client × service_type × technician) ─────── */

/*
 * GET    /:clientId/tech-mapping/summary
 *   → Lightweight per-service-type roll-up (counts + top-6 cities). The
 *     tab mounts with this; full chip lists are lazy-loaded on expand.
 *     Replaces the legacy 4.3s mount cost on big clients.
 *
 * GET    /:clientId/tech-mapping/eligible?serviceTypeId=&cityName=…
 *   → 1-query eligibility picker (active + verified techs by default).
 *
 * GET    /:clientId/tech-mapping/by-service-type/:serviceTypeId
 *   → Full chip list for ONE (client, service_type) — fired by the FE
 *     when the user expands a service-type row.
 *
 * GET    /:clientId/tech-mapping
 *   → 2-query full list of all mappings. **Legacy** — kept for back-
 *     compat; the tab no longer calls this on mount.
 *
 * PUT    /:clientId/tech-mapping
 *   → Replace-set TX for one (client, service_type) cell.
 *     Body: { serviceTypeId, efrIds: [...] }
 *
 * Route-order note: literal `/summary`, `/eligible`, `/by-service-type`
 * are declared before the bare `/tech-mapping` so Express matches the
 * specific paths first (same pattern as auto-assign's `/bulk` route).
 */
router.get('/:clientId/tech-mapping/summary', async (req, res, next) => {
  try {
    logger.info('Tech-mapping summary · clientId=' + req.params.clientId);
    if (!(await loadAndGuardClient(req, res))) return;
    const rows = await techMappingSvc.summaryForClient(req.params.clientId);
    logger.info('Found ' + rows.length + ' service-type roll-ups');
    modernOk(res, rows);
  } catch (e) { next(e); }
});

router.get(
  '/:clientId/tech-mapping/eligible',
  validate(v.eligibleTechsQuery, 'query'),
  async (req, res, next) => {
    try {
      logger.info('List eligible techs · clientId=' + req.params.clientId + ' serviceTypeId=' + (req.query.serviceTypeId || '') + ' cityId=' + (req.query.cityId || ''));
      if (!(await loadAndGuardClient(req, res))) return;
      const techs = await techMappingSvc.eligibleTechsFor(
        Number(req.query.serviceTypeId),
        {
          cityId: req.query.cityId ? Number(req.query.cityId) : undefined,
          cityName: req.query.cityName,
          query: req.query.query,
          includeUnverified: req.query.includeUnverified === 'true',
        },
      );
      logger.info('Found ' + techs.length + ' eligible techs');
      modernOk(res, techs);
    } catch (e) { next(e); }
  },
);

router.get('/:clientId/tech-mapping/by-service-type/:serviceTypeId', async (req, res, next) => {
  try {
    logger.info('Tech-mapping by service type · clientId=' + req.params.clientId + ' serviceTypeId=' + req.params.serviceTypeId);
    if (!(await loadAndGuardClient(req, res))) return;
    const stId = Number(req.params.serviceTypeId);
    if (!Number.isInteger(stId) || stId <= 0) {
      return modernError(res, 400, 'serviceTypeId must be a positive integer');
    }
    const rows = await techMappingSvc.listForClientServiceType(req.params.clientId, stId);
    logger.info('Found ' + rows.length + ' mapped techs');
    modernOk(res, rows);
  } catch (e) { next(e); }
});

router.get('/:clientId/tech-mapping', async (req, res, next) => {
  try {
    logger.info('List tech mappings · clientId=' + req.params.clientId);
    if (!(await loadAndGuardClient(req, res))) return;
    const rows = await techMappingSvc.listForClient(req.params.clientId);
    logger.info('Found ' + rows.length + ' tech mappings');
    modernOk(res, rows);
  } catch (e) { next(e); }
});

router.put(
  '/:clientId/tech-mapping',
  requireClientEdit,
  validate(v.replaceTechMappingBody),
  async (req, res, next) => {
    try {
      logger.info('Replace tech mapping · clientId=' + req.params.clientId + ' serviceTypeId=' + req.body.serviceTypeId + ' efrIds=' + (req.body.efrIds ? req.body.efrIds.length : 0));
      if (!(await loadAndGuardClient(req, res))) return;
      const n = await techMappingSvc.replaceForServiceType(
        req.params.clientId,
        req.body.serviceTypeId,
        req.body.efrIds,
      );
      logger.info('Tech mapping replaced · assigned=' + n);
      modernOk(res, { assigned: n });
    } catch (e) {
      if (e.status) logger.warn('Replace tech mapping failed · ' + e.message);
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  },
);

/* ─── Client Documents (PAN / TAN / GSTIN / Aadhaar / other) ──────── */

/*
 * GET /:clientId/documents
 *
 * Lists active documents with presigned URLs ready for <img>/<a href>.
 * Returns 503 with a clear message if tbl_client_document hasn't been
 * provisioned yet (run migrations/2026-05-25-create-client-documents.sql).
 */
router.get('/:clientId/documents', async (req, res, next) => {
  try {
    logger.info('List client documents · clientId=' + req.params.clientId);
    if (!(await loadAndGuardClient(req, res))) return;
    const rows = await docsSvc.listForClient(req.params.clientId);
    logger.info('Found ' + rows.length + ' documents');
    modernOk(res, rows);
  } catch (e) {
    if (e.status) logger.warn('List documents failed · ' + e.message);
    if (e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

/*
 * POST /:clientId/documents/upload
 *   multipart/form-data:
 *     file      = <binary; required, PNG/JPEG/WEBP/GIF/PDF>
 *     docType   = 'pan' | 'tan' | 'gstin' | 'aadhaar' | 'other'   (required)
 *     docLabel  = free-form label (optional)
 *
 * Two-step flow:
 *   1. Upload bytes to S3 (ClientDocs/<ts>_<rand>)
 *   2. Record metadata in tbl_client_document
 *
 * Returns the inserted row's id + key + presigned URL.
 *
 * S3 must be configured (S3_BUCKET_NAME). Unlike notices, there's no
 * local-disk fallback here because we expect production-only usage
 * for sensitive docs like PAN/Aadhaar.
 */
router.post(
  '/:clientId/documents/upload',
  requireClientEdit,
  upload.single('file'),
  async (req, res, next) => {
    try {
      logger.info('Upload client document · clientId=' + req.params.clientId + ' docType=' + String(req.body.docType || '').toLowerCase());
      if (!(await loadAndGuardClient(req, res))) return;
      if (!req.file) return modernError(res, 400, 'missing "file" upload');
      if (!DOC_MIME.has(req.file.mimetype)) {
        return modernError(res, 400, `mimetype "${req.file.mimetype}" is not allowed; use PNG/JPEG/WEBP/GIF/PDF`);
      }
      const docType = String(req.body.docType || '').toLowerCase();
      if (!['pan', 'tan', 'gstin', 'aadhaar', 'other'].includes(docType)) {
        return modernError(res, 400, 'docType must be pan|tan|gstin|aadhaar|other');
      }
      if (!s3.isEnabled()) {
        return modernError(res, 503, 'S3 storage not configured for client documents');
      }
      const s3Key = await s3.putClientDocument({
        buffer: req.file.buffer,
        contentType: req.file.mimetype,
        originalName: req.file.originalname,
      });
      const documentId = await docsSvc.recordUpload(req.params.clientId, {
        docType,
        docLabel: req.body.docLabel || null,
        s3Key,
        originalFilename: req.file.originalname,
        contentType: req.file.mimetype,
        uploadedBy: req.user.user_id,
      });
      const url = await s3.resolveClientDocumentUrl(s3Key).catch(() => null);
      logger.info('Client document uploaded · id=' + documentId);
      res.status(201);
      modernOk(res, { document_id: documentId, s3_key: s3Key, url });
    } catch (e) {
      if (e.code === 'LIMIT_FILE_SIZE') logger.warn('Document upload failed · ' + e.message);
      if (e.code === 'LIMIT_FILE_SIZE') return modernError(res, 400, 'file exceeds 10MB');
      if (e.status) logger.warn('Document upload failed · ' + e.message);
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  },
);

router.delete(
  '/documents/:id',
  requireClientEdit,
  async (req, res, next) => {
    try {
      logger.info('Delete client document · id=' + req.params.id);
      if (!(await guardRowByClientId(req, res, await svc.getDocumentClientId(req.params.id), 'document not found'))) return;
      const affected = await docsSvc.softDelete(req.params.id);
      if (!affected) return modernError(res, 404, 'document not found');
      logger.info('Client document deleted · id=' + req.params.id);
      modernOk(res, { deleted: true });
    } catch (e) {
      if (e.status) logger.warn('Delete document failed · ' + e.message);
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  },
);


/* ─── Client Profile aggregates ───────────────────────────────────── */

/*
 * GET /:clientId/summary
 *
 * The headline figures on the Client Profile page. Three numbers, three
 * cheap COUNT-shaped queries, one round trip.
 *
 *   outstanding      un-collected rupees across raised invoices
 *   openOrders       jobs still in flight (statuses 0/1/2/20)
 *   pendingClientQc  jobs blocked on THIS CLIENT approving a billing line
 *
 * WHY THE SLA FIGURE IS NOT HERE. The fourth tile on that strip is "SLA
 * breaches (30d)", and it is deliberately fetched separately by the page from
 * GET /api/admin/tat/client/:clientId?days=30. Two reasons: the TAT engine is
 * the ONE definition of a breach and re-deriving it here would fork it, and it
 * scans every completed job in the window — folding it in would make three
 * instant numbers wait on the slow one. It also carries its own action gate
 * (isTatCalculatorView), which this endpoint must not silently bypass.
 *
 * PENDING QC USES THE CLIENT PORTAL'S OWN DEFINITION — the exact predicate
 * behind GET /api/client/action-queue: at least one approval-pending billing
 * line (tbl_job_services.job_service_status = 1) with neither an approval nor
 * a rejection stamped on the job. That is the condition PATCH
 * /jobs/:id/estimate/approve clears, so what an operator reads here and what
 * the client sees in their own queue cannot drift apart. No reporting-contact
 * scoping: an operator looking at the client master wants the whole client,
 * not one SPOC's subtree.
 */
router.get('/:clientId/summary', async (req, res, next) => {
  try {
    logger.info('Client profile summary · clientId=' + req.params.clientId);
    if (!(await loadAndGuardClient(req, res))) return;
    const clientId = Number(req.params.clientId);

    /*
     * tbl_client_invoice is a legacy table and is not present on every
     * environment. A missing table means "we cannot say", which is NOT the
     * same as zero outstanding — so it resolves to null and the tile renders
     * a dash rather than a confident ₹0.
     */
    const invoiceTotals = (async () => {
      try {
        const [[row]] = await pool.query(
          `SELECT COALESCE(SUM(total_invoice_amount), 0)                                  AS billed,
                  COALESCE(SUM(COALESCE(total_paid_amount, 0)), 0)                        AS collected,
                  COALESCE(SUM(total_invoice_amount - COALESCE(total_paid_amount, 0)), 0) AS outstanding,
                  COUNT(*)                                                                AS invoices
             FROM tbl_client_invoice
            WHERE fk_client_id = ? AND is_raised = 1`,
          [clientId],
        );
        return {
          billed: Number(row.billed) || 0,
          collected: Number(row.collected) || 0,
          outstanding: Number(row.outstanding) || 0,
          invoices: Number(row.invoices) || 0,
        };
      } catch (e) {
        if (e && e.errno === 1146) {
          logger.warn('tbl_client_invoice missing — outstanding reported as unavailable');
          return null;
        }
        throw e;
      }
    })();

    const orderCounts = pool.query(
      `SELECT SUM(CASE WHEN job_status IN (0, 1, 2, 20) THEN 1 ELSE 0 END) AS openOrders,
              SUM(CASE WHEN job_status IN (3, 5)        THEN 1 ELSE 0 END) AS completedOrders,
              COUNT(*)                                                     AS totalOrders
         FROM tbl_job
        WHERE fk_client_id = ?`,
      [clientId],
    );

    // COUNT(DISTINCT) — a job with three approval-pending lines is ONE item
    // of client work, not three. Same reason the action queue GROUP BYs.
    const pendingQc = pool.query(
      `SELECT COUNT(DISTINCT J.job_id) AS pendingClientQc
         FROM tbl_job J
         JOIN tbl_job_services js ON js.job_id = J.job_id AND js.job_service_status = 1
        WHERE J.fk_client_id = ?
          AND J.approved_on_date_time IS NULL
          AND J.approval_reject_date_time IS NULL
          AND J.job_status NOT IN (3, 5, 6)`,
      [clientId],
    );

    const [invoices, [[orders]], [[qc]]] = await Promise.all([invoiceTotals, orderCounts, pendingQc]);

    modernOk(res, {
      clientId,
      invoices,                                        // null when the table is absent
      outstanding: invoices ? invoices.outstanding : null,
      openOrders: Number(orders.openOrders) || 0,
      completedOrders: Number(orders.completedOrders) || 0,
      totalOrders: Number(orders.totalOrders) || 0,
      pendingClientQc: Number(qc.pendingClientQc) || 0,
    });
  } catch (e) {
    if (e.status) logger.warn('Client summary failed · ' + e.message);
    if (e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

/*
 * GET /:clientId/stores — the client's branch / store directory.
 *
 * Read-only on purpose. tbl_client_store is populated by the client's own
 * onboarding data load, and the client portal already reads it (GET
 * /api/client/stores) to drive the store-code picker on New Order. This
 * exposes the same rows to an operator so "which branch is STR-142?" is
 * answerable from the client master instead of a DB console.
 *
 * Unlike the portal query this does NOT filter to status = 1 — an operator
 * chasing a job booked against a since-retired branch needs to see it. The
 * flag rides along so the UI can mark it.
 */
router.get('/:clientId/stores', async (req, res, next) => {
  try {
    logger.info('List client stores · clientId=' + req.params.clientId);
    if (!(await loadAndGuardClient(req, res))) return;
    let rows;
    try {
      [rows] = await pool.query(
        `SELECT id, store_code, store_name, contact_name, contact_no,
                address, city_id, city_name, pin_code, status
           FROM tbl_client_store
          WHERE fk_client_id = ?
          ORDER BY status DESC, store_code`,
        [Number(req.params.clientId)],
      );
    } catch (e) {
      if (e && e.errno === 1146) {
        logger.warn('tbl_client_store missing — returning an empty branch directory');
        return modernOk(res, { items: [], provisioned: false });
      }
      throw e;
    }
    logger.info('Found ' + rows.length + ' stores');
    modernOk(res, { items: rows, provisioned: true });
  } catch (e) {
    if (e.status) logger.warn('List client stores failed · ' + e.message);
    if (e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

/*
 * PUT /:clientId/targets — set this client's contracted targets.
 *
 * Upsert; client_id is the table's PRIMARY KEY. Gated on isClientEdit, the
 * same key that gates every other mutation on this router.
 *
 * The whole set is required on every write — see the validator note. A missing
 * table 503s rather than reporting success, because the read path's fail-soft
 * behaviour (serve platform defaults) is exactly wrong for a write.
 */
router.put(
  '/:clientId/targets',
  requireClientEdit,
  validate(v.clientTargetsBody),
  async (req, res, next) => {
    try {
      logger.info('Set client targets · clientId=' + req.params.clientId);
      if (!(await loadAndGuardClient(req, res))) return;
      const saved = await targetSvc.setTargets(
        Number(req.params.clientId), req.body, req.user && req.user.user_id,
      );
      modernOk(res, { ...saved, directions: targetSvc.TARGET_DIRECTION });
    } catch (e) {
      if (e.status) logger.warn('Set client targets failed · ' + e.message);
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  },
);

/*
 * DELETE /:clientId/targets — return this client to the platform defaults.
 *
 * NOT the same as writing the default VALUES: the row would still exist and
 * getTargets() would keep reporting `source: 'contracted'`. Only removing the
 * row puts a client back on 'platform-default', which is the distinction the
 * whole SLA section is built around. Without this, the first accidental save
 * would mark a client as contracted forever.
 *
 * Idempotent — deleting when no row exists is a 200 with removed:false, not a
 * 404. "There is no contracted row" is the state the caller asked for.
 */
router.delete(
  '/:clientId/targets',
  requireClientEdit,
  async (req, res, next) => {
    try {
      logger.info('Clear client targets · clientId=' + req.params.clientId);
      if (!(await loadAndGuardClient(req, res))) return;
      const removed = await targetSvc.clearTargets(Number(req.params.clientId));
      const targets = await targetSvc.getTargets(Number(req.params.clientId));
      modernOk(res, { removed, ...targets, directions: targetSvc.TARGET_DIRECTION });
    } catch (e) {
      if (e.status) logger.warn('Clear client targets failed · ' + e.message);
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  },
);

/*
 * GET /:clientId/targets — the client's contracted performance targets.
 *
 * Straight passthrough of services/client-target.service.js, which is the same
 * module the client portal's Performance book judges against. Reusing it means
 * an operator and a client read one set of numbers.
 *
 * `source` is part of the contract, not decoration: 'contracted' means a row
 * exists in easyfix_client_target, 'platform-default' means nobody has
 * configured this client and the platform figures are standing in. The UI must
 * say which, or a default reads as a commitment.
 *
 * Its PUT and DELETE siblings are directly above. DELETE is the only way back
 * to `source: 'platform-default'` — writing the default values would leave the
 * row in place and keep reporting 'contracted'.
 */
router.get('/:clientId/targets', async (req, res, next) => {
  try {
    logger.info('Client targets · clientId=' + req.params.clientId);
    if (!(await loadAndGuardClient(req, res))) return;
    const targets = await targetSvc.getTargets(Number(req.params.clientId));
    modernOk(res, { ...targets, directions: targetSvc.TARGET_DIRECTION });
  } catch (e) {
    if (e.status) logger.warn('Client targets failed · ' + e.message);
    if (e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

module.exports = router;
