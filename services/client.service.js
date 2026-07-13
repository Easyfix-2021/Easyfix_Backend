/*
 * Client service — canonical SQL for the Manage Clients flow.
 *
 * Scope (Phase 1B Manage Clients migration, 2026-05-25):
 *   - Client master CRUD
 *   - Client contacts (SPOCs) CRUD + email/phone duplicate check
 *   - Client billing CRUD
 *   - Client custom-properties CRUD
 *   - Collected-By preference read (legacy `tbl_client.collected_by`)
 *
 * Out of scope (deferred per the migration plan):
 *   - Services tab (tbl_client_service)
 *   - Rate cards (tbl_client_rate_card) + Excel import
 *   - Technician mapping (tbl_client_easyfixer_mapping)
 *   - Vertical mapping (verticalHead + projectManager)
 *
 * Why a separate service file:
 *   1. Per-route inline SQL was getting long (~270 LOC across CRUD for
 *      4 sub-resources). Splitting keeps the route file declarative.
 *   2. The mobile tier may eventually surface a read-only "my clients"
 *      list to technicians. Per the no-route-duplication rule, that
 *      route would call these same functions through a router factory.
 *   3. Joi-validated inputs land here as a normalised object; the
 *      service does NOT validate again — it trusts the validator and
 *      focuses on SQL shape + audit columns.
 *
 * Conventions:
 *   - Parameterised SQL only. NEVER string-concatenate user input.
 *   - Use `pool.query` (mysql2/promise) — same pool the rest of the
 *     codebase uses.
 *   - Throw `Object.assign(new Error('msg'), { status: 4xx })` on
 *     domain errors; the route handler will surface them via
 *     `modernError`.
 *   - Audit columns: `insert_date / inserted_by` on insert,
 *     `update_date / updated_by` on update. Mirrors the convention in
 *     `routes/admin/notices.js` and `services/job.service.js`.
 */

const { pool } = require('../db');
const logger = require('../logger');

/* ─── Column-presence probe (cached) ──────────────────────────────── */

/*
 * Returns a `Set<string>` of every column name on `tbl_client`. Used
 * by createClient + updateClient to dynamically build INSERT/UPDATE
 * statements that include only columns the DB actually has, so a
 * deployment to an environment missing some legacy columns (e.g.
 * `logo_id`, `coupon_code`, `tan_number`) doesn't 500.
 *
 * Probed once per process via a cached Promise; subsequent calls
 * resolve instantly. No invalidation — schema changes require a
 * restart, which matches how every other column-probe in this
 * codebase works (see job.service.js#hasVerticalCol).
 */
let _columnsPromise = null;
async function getClientColumns() {
  if (!_columnsPromise) {
    _columnsPromise = (async () => {
      try {
        const [rows] = await pool.query(
          `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tbl_client'`,
        );
        const set = new Set(rows.map((r) => r.COLUMN_NAME));
        logger.info({ count: set.size }, '[client.service] tbl_client column probe');
        return set;
      } catch (e) {
        logger.warn({ err: e?.message }, '[client.service] column probe failed — degrading to known-safe column set');
        // Fallback: hardcode the columns from our existing INSERT.
        return new Set([
          'client_id', 'client_name', 'client_email', 'client_address',
          'client_type', 'reference_code', 'booking_cut_off', 'client_status',
          'insert_date', 'update_date', 'inserted_by', 'updated_by',
          'vertical_id', 'collected_by', 'monthly_revenue',
        ]);
      }
    })();
  }
  return _columnsPromise;
}

/* ─── Clients ─────────────────────────────────────────────────────── */

/*
 * List clients (paginated). RBAC scope filters applied upstream by the
 * route handler — this function takes pre-computed clause + params so
 * scope logic stays in one place (lib/scope.js handles the assembly).
 *
 * Returns:
 *   { items: [...row, primary_spoc:{...}, secondary_spoc:{...}, city_name],
 *     total: <COUNT(*) for the filter> }
 *
 * Performance profile — **3 queries total**, regardless of row count:
 *   1. COUNT(*) for the total (used by FE pagination)
 *   2. Main SELECT with LEFT JOIN to tbl_city (single extra column;
 *      no row blow-up because tbl_client.city_id is 1:1)
 *   3. ONE bulk fetch of tbl_vertical_mapping rows for ALL client_ids
 *      in the page, joined to tbl_user. Resolved into Map<client_id,
 *      {primary, secondary}> and merged in JS. Naive impl would N+1
 *      with 2 queries per row.
 *
 * The SPOC bulk-fetch is conditional on `user_type` column presence
 * (cached probe in client-verticals.service.js) — pre-migration DBs
 * silently fall back to empty primary/secondary fields rather than
 * crashing.
 *
 * `extraClauses` / `extraParams` come from the route's RBAC + search
 * filter assembly. Pagination is enforced here (max 500 per page).
 */
async function listClients({ extraClauses = [], extraParams = [], includeInactive, q, limit, offset, cityId, sortBy, sortDir }) {
  logger.info('List clients · q=' + (q || '') + ' cityId=' + (cityId || '') + ' includeInactive=' + !!includeInactive + ' limit=' + (limit || '') + ' offset=' + (offset || ''));
  const clauses = [...extraClauses];
  const params  = [...extraParams];
  if (!includeInactive) clauses.push('cl.client_status = 1');
  if (q) {
    // Match client name / email / reference code / city / client id / SPOC contact name.
    // - City name needs the tbl_city JOIN in both COUNT and SELECT
    //   below (we add it unconditionally — JOIN cost is trivial vs.
    //   the operator confusion of "search Mumbai returns nothing").
    // - EXISTS keeps the row count stable on the contact match (no
    //   JOIN row-explosion when a client has many contacts).
    clauses.push(
      '(cl.client_name LIKE ? OR cl.client_email LIKE ? OR cl.reference_code LIKE ? OR ct.city_name LIKE ? OR CAST(cl.client_id AS CHAR) LIKE ? OR EXISTS (SELECT 1 FROM tbl_client_contacts c WHERE c.client_id = cl.client_id AND c.contact_name LIKE ?))',
    );
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (cityId) {
    // Legacy column name: `client_city_id` on tbl_client; tbl_city's
    // PK is `city_id` (verified against legacy EasyFix_CRM
    // ClientDaoImpl.java#75 — `c.city_id = cl.client_city_id`).
    clauses.push('cl.client_city_id = ?');
    params.push(cityId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  // Server-side ORDER BY over the COMPLETE result set (whitelisted columns
  // only — the map is the SQL-injection guard). Default: client_name ASC.
  // A client_id tiebreaker keeps paging deterministic when the sort col ties.
  const SORT_MAP = {
    client_id:     'cl.client_id',
    client_name:   'cl.client_name',
    client_email:  'cl.client_email',
    city_name:     'ct.city_name',
    client_status: 'cl.client_status',
  };
  let orderBy = 'ORDER BY cl.client_name ASC';
  if (sortBy && SORT_MAP[sortBy]) {
    const scol = SORT_MAP[sortBy];
    const sdir = String(sortDir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    orderBy = scol === 'cl.client_id'
      ? `ORDER BY cl.client_id ${sdir}`
      : `ORDER BY ${scol} ${sdir}, cl.client_id ASC`;
  }

  // Query 1 — COUNT(*) for pagination. Same WHERE + JOIN as the SELECT
  // (the JOIN is needed so the `ct.city_name LIKE ?` clause resolves).
  // LEFT JOIN keeps clients with NULL city in the result set.
  const [[{ total = 0 } = {}]] = await pool.query(
    `SELECT COUNT(*) AS total
       FROM tbl_client cl
       LEFT JOIN tbl_city ct ON ct.city_id = cl.client_city_id
       ${where}`,
    params,
  );

  // Query 2 — main page. LEFT JOIN tbl_city. Pagination params
  // appended AFTER the COUNT query (which doesn't use them).
  const cappedLimit  = Math.min(Math.max(Number(limit) || 50, 1), 500);
  const cappedOffset = Math.max(Number(offset) || 0, 0);
  const pageParams = [...params, cappedLimit, cappedOffset];
  const [rows] = await pool.query(
    // Column-name landmine: tbl_client uses `client_city_id` (not
    // `city_id`) — the FK column on `tbl_client` is `client_city_id`,
    // while `tbl_city`'s PK is `city_id`. Verified against legacy
    // EasyFix_CRM ClientDaoImpl.java#75.
    `SELECT cl.client_id, cl.client_name, cl.client_email, cl.client_status, cl.client_type,
            cl.reference_code, cl.booking_cut_off, cl.vertical_id, cl.collected_by,
            cl.client_city_id AS city_id, ct.city_name,
            cl.monthly_revenue
       FROM tbl_client cl
       LEFT JOIN tbl_city ct ON ct.city_id = cl.client_city_id
       ${where}
       ${orderBy}
       LIMIT ? OFFSET ?`,
    pageParams,
  );
  logger.info('Found ' + rows.length + ' clients (total=' + Number(total) + ')');
  if (rows.length === 0) return { items: [], total: Number(total) };

  // Query 3 — bulk-resolve Primary/Secondary SPOC per client in ONE
  // round-trip. Guarded by the user_type column probe (matches the
  // pattern in client-verticals.service.js).
  const clientIds = rows.map((r) => r.client_id);
  let spocMap = new Map();
  try {
    // Lazy-require to avoid a circular import at module load time —
    // both files depend on the same pool but we only need the probe.
    const verticalsSvc = require('./client-verticals.service');
    const hasUT = await verticalsSvc.hasUserTypeColumn();
    if (hasUT) {
      // tbl_user uses single `user_name` + `official_email` (NOT
      // first_name / last_name / user_email) per legacy UserDaoImpl.
      const [spocRows] = await pool.query(
        `SELECT vm.client_id, vm.user_type, vm.user_id,
                u.user_name, u.official_email
           FROM tbl_vertical_mapping vm
           LEFT JOIN tbl_user u ON u.user_id = vm.user_id
          WHERE vm.client_id IN (?)
            AND vm.user_type IN (1, 2)`,
        [clientIds],
      );
      spocMap = new Map();
      for (const s of spocRows) {
        const bucket = spocMap.get(s.client_id) || {};
        const userBlob = {
          user_id: s.user_id,
          name: s.user_name ?? null,
          user_email: s.official_email ?? null,
        };
        if (s.user_type === 1) bucket.primary = userBlob;
        if (s.user_type === 2) bucket.secondary = userBlob;
        spocMap.set(s.client_id, bucket);
      }
    }
  } catch (e) {
    // Defensive: never let SPOC resolution failure kill the list.
    logger.warn({ err: e?.message }, '[client.service.listClients] SPOC resolve failed');
  }

  const items = rows.map((r) => ({
    ...r,
    primary_spoc:   spocMap.get(r.client_id)?.primary   ?? null,
    secondary_spoc: spocMap.get(r.client_id)?.secondary ?? null,
  }));
  return { items, total: Number(total) };
}

async function getClientById(clientId) {
  logger.info('Get client by id · clientId=' + clientId);
  const [[row]] = await pool.query(
    'SELECT * FROM tbl_client WHERE client_id = ?', [clientId],
  );
  return row || null;
}

/*
 * Create client. `body` is the Joi-validated payload — the FULL legacy
 * Add Client form (matched against `ClientDaoImpl.java#229`).
 *
 * Strategy: build the INSERT dynamically against the column-probe
 * Set. Each column gets included only if the DB has it AND the body
 * carries a non-undefined value. Empty strings, nulls, and 0 are all
 * valid values; only `undefined` skips the field.
 *
 * Returns the new client_id.
 */
const CLIENT_INSERT_MAP = {
  // master
  client_name:        (b) => b.clientName,
  client_email:       (b) => b.clientEmail ?? null,
  client_address:     (b) => b.clientAddress ?? null,
  client_type:        (b) => b.clientType ?? 'b2b',
  reference_code:     (b) => b.referenceCode ?? null,
  client_status:      ()  => 1,
  // address parts
  building:           (b) => b.building ?? null,
  landmark:           (b) => b.landmark ?? null,
  client_city_id:     (b) => b.cityId ?? null,
  client_pincode:     (b) => b.pincode ?? null,
  // commercial config
  paid_by:            (b) => b.paidBy ?? null,
  collected_by:       (b) => b.collectedBy ?? null,
  travel_distance:    (b) => b.travelDistance ?? null,
  booking_cut_off:    (b) => b.bookingCutOff ?? null,
  max_orders:         (b) => b.maxOrders ?? b.minOrders ?? null,  // legacy form label "Min Orders" → max_orders column
  coupon_code:        (b) => b.couponCode ?? null,
  // KYC documents (text + S3 key stored on the master row)
  tan_number:         (b) => b.cinNumber ?? b.tanNumber ?? null,   // form label "CIN NO" → legacy column tan_number
  client_tan_doc:     (b) => b.cinDocKey ?? b.tanDocKey ?? null,
  client_pan_number:  (b) => b.panNumber ?? null,
  client_pan_doc:     (b) => b.panDocKey ?? null,
  client_aadhaar:     (b) => b.mouContact ?? b.aadhaarNumber ?? null,  // form label "MOU Contact" → client_aadhaar
  client_aadhaar_doc: (b) => b.mouDocKey ?? b.aadhaarDocKey ?? null,
  logo_id:            (b) => b.logoKey ?? null,
  // mapping refs
  vertical_id:        (b) => b.verticalId ?? null,
  reporting_contact_ids: (b) => (Array.isArray(b.reportingContactIds)
                                  ? b.reportingContactIds.join(',')
                                  : (b.reportingContactIds ?? null)),
  // commercial metrics
  monthly_revenue:    (b) => b.monthlyRevenue ?? null,
  // audit
  inserted_by:        (_, actorId) => actorId,
  updated_by:         (_, actorId) => actorId,
};

async function createClient(body, actorId) {
  logger.info('Create client · name=' + (body && body.clientName));
  const cols = await getClientColumns();
  const insertCols = [];
  const placeholders = [];
  const values = [];
  // Standard audit timestamps via SQL functions (not parameter).
  const literalCols = [];
  if (cols.has('insert_date')) literalCols.push(['insert_date', 'NOW()']);
  if (cols.has('update_date')) literalCols.push(['update_date', 'NOW()']);

  for (const [col, picker] of Object.entries(CLIENT_INSERT_MAP)) {
    if (!cols.has(col)) continue;
    const val = picker(body, actorId);
    if (val === undefined) continue;
    insertCols.push(col);
    placeholders.push('?');
    values.push(val);
  }
  for (const [col, expr] of literalCols) {
    insertCols.push(col);
    placeholders.push(expr);
  }

  const sql = `INSERT INTO tbl_client (${insertCols.join(', ')}) VALUES (${placeholders.join(', ')})`;
  const [ins] = await pool.query(sql, values);
  logger.info('Client created · id=' + ins.insertId);
  return ins.insertId;
}

/*
 * Edit client. Whitelist-driven — only known DB columns accepted.
 * Returns rows-affected for the caller to translate into 200/404.
 *
 * NB: the FE sends camelCase, but this whitelist is in snake_case
 * so both inline-snake-case POSTs (legacy callers) and camelCase ones
 * (new FE) work. The whitelist is the source of truth.
 */
const UPDATE_ALLOWED = [
  // master
  'client_name', 'client_email', 'client_address', 'client_status',
  'client_type', 'reference_code',
  // address parts
  'building', 'landmark', 'client_city_id', 'client_pincode',
  // commercial config
  'paid_by', 'collected_by', 'travel_distance', 'booking_cut_off',
  'max_orders', 'min_orders', 'coupon_code',
  // KYC
  'tan_number', 'client_tan_doc',
  'client_pan_number', 'client_pan_doc',
  'client_aadhaar', 'client_aadhaar_doc',
  'logo_id',
  // mapping refs
  'vertical_id', 'reporting_contact_ids',
  // commercial metrics
  'monthly_revenue',
];

// Map common camelCase shapes the FE might send onto the snake_case columns.
const CAMEL_TO_SNAKE = {
  // master
  clientName: 'client_name',
  clientEmail: 'client_email',
  clientAddress: 'client_address',
  clientStatus: 'client_status',
  clientType: 'client_type',
  referenceCode: 'reference_code',
  // address parts
  building: 'building',
  landmark: 'landmark',
  cityId: 'client_city_id',
  pincode: 'client_pincode',
  // commercial config
  paidBy: 'paid_by',
  collectedBy: 'collected_by',
  travelDistance: 'travel_distance',
  bookingCutOff: 'booking_cut_off',
  maxOrders: 'max_orders',
  minOrders: 'max_orders', // legacy form label "Min Orders" → same column
  couponCode: 'coupon_code',
  // KYC (form labels: CIN NO, PAN, MOU Contact)
  cinNumber: 'tan_number',
  tanNumber: 'tan_number',
  cinDocKey: 'client_tan_doc',
  tanDocKey: 'client_tan_doc',
  panNumber: 'client_pan_number',
  panDocKey: 'client_pan_doc',
  mouContact: 'client_aadhaar',
  aadhaarNumber: 'client_aadhaar',
  mouDocKey: 'client_aadhaar_doc',
  aadhaarDocKey: 'client_aadhaar_doc',
  logoKey: 'logo_id',
  // mapping refs
  verticalId: 'vertical_id',
  reportingContactIds: 'reporting_contact_ids',
  // commercial metrics
  monthlyRevenue: 'monthly_revenue',
};

async function updateClient(clientId, body, actorId) {
  logger.info('Update client · clientId=' + clientId);
  const cols = await getClientColumns();
  const sets = [];
  const vals = [];
  // Accept both snake_case (legacy) and camelCase (new) keys; map onto
  // the actual column. Then verify the column EXISTS on this DB before
  // emitting it.
  for (const [key, val] of Object.entries(body || {})) {
    const col = UPDATE_ALLOWED.includes(key) ? key : CAMEL_TO_SNAKE[key];
    if (!col || !UPDATE_ALLOWED.includes(col)) continue;
    if (!cols.has(col)) continue; // column missing on this DB — skip silently
    // CSV serialise array values for `reporting_contact_ids`.
    let outVal = val;
    if (col === 'reporting_contact_ids' && Array.isArray(val)) outVal = val.join(',');
    sets.push(`${col} = ?`);
    vals.push(outVal);
  }
  if (sets.length === 0) {
    throw Object.assign(new Error('nothing to update'), { status: 400 });
  }
  if (cols.has('update_date')) sets.push('update_date = NOW()');
  if (cols.has('updated_by'))  { sets.push('updated_by = ?'); vals.push(actorId); }
  vals.push(clientId);
  const [r] = await pool.query(
    `UPDATE tbl_client SET ${sets.join(', ')} WHERE client_id = ?`, vals,
  );
  logger.info('Client updated · clientId=' + clientId + ' affected=' + r.affectedRows);
  return r.affectedRows;
}

/* ─── Client Contacts (SPOCs) ─────────────────────────────────────── */

async function listContacts(clientId) {
  logger.info('List client contacts · clientId=' + clientId);
  const [rows] = await pool.query(
    'SELECT * FROM tbl_client_contacts WHERE client_id = ? ORDER BY id DESC',
    [clientId],
  );
  logger.info('Found ' + rows.length + ' contacts');
  return rows;
}

/*
 * Duplicate-check helper — replicates legacy `getClientContactByEmail()`
 * but takes both email + phone. Returns the conflicting row (if any)
 * so the FE can show "this email already exists" inline.
 *
 * `excludeId` lets the edit form skip the row being edited from the
 * duplicate set.
 *
 * Soft-deleted contacts (status = 0) are excluded so a deleted SPOC's
 * email/phone can be re-added.
 */
async function findDuplicateContact({ clientId, email, phone, excludeId }) {
  const clauses = ['client_id = ?', 'status = 1'];
  const params  = [clientId];
  const orClauses = [];
  if (email) { orClauses.push('contact_email = ?'); params.push(email); }
  if (phone) { orClauses.push('contact_no = ?');    params.push(phone); }
  if (orClauses.length === 0) return null;
  clauses.push(`(${orClauses.join(' OR ')})`);
  if (excludeId) { clauses.push('id != ?'); params.push(excludeId); }
  const [rows] = await pool.query(
    `SELECT id, contact_name, contact_email, contact_no
       FROM tbl_client_contacts
      WHERE ${clauses.join(' AND ')}
      LIMIT 1`,
    params,
  );
  return rows[0] || null;
}

async function createContact(clientId, body) {
  logger.info('Create client contact · clientId=' + clientId);
  // Pre-flight dedupe: surface a 409 with the conflicting row rather
  // than relying on a generic SQL unique-index violation.
  const dup = await findDuplicateContact({
    clientId,
    email: body.contactEmail,
    phone: body.contactNo,
  });
  if (dup) {
    logger.warn('Create contact rejected · duplicate email/phone · clientId=' + clientId + ' conflictId=' + dup.id);
    throw Object.assign(new Error('contact with this email or phone already exists'), {
      status: 409,
      conflict: dup,
    });
  }
  const [ins] = await pool.query(
    `INSERT INTO tbl_client_contacts
       (client_id, contact_name, contact_email, contact_no, contact_alt_no,
        contact_desgn, manager_id, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    [
      clientId,
      body.contactName,
      body.contactEmail,
      body.contactNo,
      body.contactAltNo || null,
      body.contactDesgn || null,
      body.managerId ?? null,
    ],
  );
  logger.info('Contact created · id=' + ins.insertId + ' clientId=' + clientId);
  return ins.insertId;
}

const CONTACT_UPDATE_ALLOWED = [
  'contact_name', 'contact_email', 'contact_no', 'contact_alt_no',
  'contact_desgn', 'manager_id', 'status',
];

const CONTACT_CAMEL_TO_SNAKE = {
  contactName: 'contact_name',
  contactEmail: 'contact_email',
  contactNo: 'contact_no',
  contactAltNo: 'contact_alt_no',
  contactDesgn: 'contact_desgn',
  managerId: 'manager_id',
};

async function updateContact(contactId, body) {
  logger.info('Update client contact · contactId=' + contactId);
  // If email/phone are being changed, dedupe-check against the same
  // client's other contacts.
  if (body.contactEmail || body.contactNo) {
    const [[row]] = await pool.query(
      'SELECT client_id FROM tbl_client_contacts WHERE id = ? LIMIT 1', [contactId],
    );
    if (!row) throw Object.assign(new Error('contact not found'), { status: 404 });
    const dup = await findDuplicateContact({
      clientId: row.client_id,
      email: body.contactEmail,
      phone: body.contactNo,
      excludeId: contactId,
    });
    if (dup) {
      logger.warn('Update contact rejected · duplicate email/phone · contactId=' + contactId + ' conflictId=' + dup.id);
      throw Object.assign(new Error('contact with this email or phone already exists'), {
        status: 409, conflict: dup,
      });
    }
  }
  const sets = [];
  const vals = [];
  for (const [key, val] of Object.entries(body || {})) {
    const col = CONTACT_UPDATE_ALLOWED.includes(key) ? key : CONTACT_CAMEL_TO_SNAKE[key];
    if (!col || !CONTACT_UPDATE_ALLOWED.includes(col)) continue;
    sets.push(`${col} = ?`);
    vals.push(val);
  }
  if (sets.length === 0) {
    throw Object.assign(new Error('nothing to update'), { status: 400 });
  }
  vals.push(contactId);
  const [r] = await pool.query(
    `UPDATE tbl_client_contacts SET ${sets.join(', ')} WHERE id = ?`, vals,
  );
  logger.info('Contact updated · contactId=' + contactId + ' affected=' + r.affectedRows);
  return r.affectedRows;
}

/*
 * Scope helper — resolve the owning client_id for a contact row.
 * Used by the route layer to scope-guard flat /contacts/:id mutations
 * (the mutation SQL itself stays bare-PK by design).
 */
async function getContactClientId(contactId) {
  const [[row]] = await pool.query(
    'SELECT client_id FROM tbl_client_contacts WHERE id = ? LIMIT 1', [contactId],
  );
  return row ? row.client_id : null;
}

// Soft-delete: flip status to 0 rather than DELETE so legacy joins
// against tbl_client_contacts.id don't dangle. Matches the legacy
// `addUpdateClientContact` behaviour when status was set to 0.
async function deleteContact(contactId) {
  logger.info('Soft-delete client contact · contactId=' + contactId);
  const [r] = await pool.query(
    'UPDATE tbl_client_contacts SET status = 0 WHERE id = ?', [contactId],
  );
  logger.info('Contact deleted · contactId=' + contactId + ' affected=' + r.affectedRows);
  return r.affectedRows;
}

/* ─── Client Billing ──────────────────────────────────────────────── */

async function listBilling(clientId) {
  logger.info('List client billing · clientId=' + clientId);
  const [rows] = await pool.query(
    'SELECT * FROM tbl_client_billing WHERE client_id = ? ORDER BY c_bill_id DESC',
    [clientId],
  );
  logger.info('Found ' + rows.length + ' billing rows');
  return rows;
}

async function createBilling(clientId, body) {
  logger.info('Create client billing · clientId=' + clientId);
  const [ins] = await pool.query(
    `INSERT INTO tbl_client_billing
       (client_id, c_bill_name, c_bill_address, c_bill_comm_addr,
        c_bill_city_id, c_bill_pin, c_bill_email,
        c_bill_freq_type, c_bill_payment_cycle)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      clientId,
      body.name,
      body.address,
      body.commAddr || null,
      body.cityId ?? null,
      body.pin || null,
      body.email || null,
      body.frequencyType || null,
      body.paymentCycle ?? null,
    ],
  );
  logger.info('Billing created · id=' + ins.insertId + ' clientId=' + clientId);
  return ins.insertId;
}

const BILLING_UPDATE_ALLOWED = [
  'c_bill_name', 'c_bill_address', 'c_bill_comm_addr', 'c_bill_city_id',
  'c_bill_pin', 'c_bill_email', 'c_bill_freq_type', 'c_bill_payment_cycle',
];

const BILLING_CAMEL_TO_SNAKE = {
  name: 'c_bill_name',
  address: 'c_bill_address',
  commAddr: 'c_bill_comm_addr',
  cityId: 'c_bill_city_id',
  pin: 'c_bill_pin',
  email: 'c_bill_email',
  frequencyType: 'c_bill_freq_type',
  paymentCycle: 'c_bill_payment_cycle',
};

async function updateBilling(billingId, body) {
  logger.info('Update client billing · billingId=' + billingId);
  const sets = [];
  const vals = [];
  for (const [key, val] of Object.entries(body || {})) {
    const col = BILLING_UPDATE_ALLOWED.includes(key) ? key : BILLING_CAMEL_TO_SNAKE[key];
    if (!col || !BILLING_UPDATE_ALLOWED.includes(col)) continue;
    sets.push(`${col} = ?`);
    vals.push(val);
  }
  if (sets.length === 0) {
    throw Object.assign(new Error('nothing to update'), { status: 400 });
  }
  vals.push(billingId);
  const [r] = await pool.query(
    `UPDATE tbl_client_billing SET ${sets.join(', ')} WHERE c_bill_id = ?`, vals,
  );
  logger.info('Billing updated · billingId=' + billingId + ' affected=' + r.affectedRows);
  return r.affectedRows;
}

async function deleteBilling(billingId) {
  logger.info('Delete client billing · billingId=' + billingId);
  // Hard-delete is acceptable here — billing addresses aren't referenced
  // by historical jobs (jobs snapshot their billing into the job row).
  const [r] = await pool.query(
    'DELETE FROM tbl_client_billing WHERE c_bill_id = ?', [billingId],
  );
  logger.info('Billing deleted · billingId=' + billingId + ' affected=' + r.affectedRows);
  return r.affectedRows;
}

/*
 * Scope helper — resolve the owning client_id for a billing row.
 * Used by the route layer to scope-guard flat /billing/:id mutations.
 */
async function getBillingClientId(billingId) {
  const [[row]] = await pool.query(
    'SELECT client_id FROM tbl_client_billing WHERE c_bill_id = ? LIMIT 1', [billingId],
  );
  return row ? row.client_id : null;
}

/* ─── Client Custom Properties ────────────────────────────────────── */

/*
 * Normalised list helper (matches the legacy normalisation used by the
 * existing GET endpoint). Public callers should keep using the route's
 * normalised shape; this raw read is for the CRUD endpoints where the
 * FE needs the exact row to populate an edit form.
 */
async function listCustomProperties(clientId) {
  logger.info('List client custom properties · clientId=' + clientId);
  const [rows] = await pool.query(
    'SELECT * FROM tbl_client_custom_properties WHERE client_id = ?',
    [clientId],
  );
  logger.info('Found ' + rows.length + ' custom properties');
  return rows;
}

/*
 * Column-name maps for the two schema shapes of
 * tbl_client_custom_properties. detectCustomPropsShape() (defined
 * below) picks which set to use at write time. The legacy shape has
 * NO label column unless the optional c_prop_label extension exists
 * (separately probed via _customPropsHasLegacyLabel).
 *
 * Canonical: property_name / property_label / property_value /
 *            is_mandatory + id PK + no status filter on writes.
 * Legacy:    c_prop_name  / c_prop_label (optional) / c_prop_values
 *            (PLURAL) / c_prop_mandatory + c_prop_id PK + status
 *            column that we set to 1 on insert.
 */
const CUSTOM_PROP_COLS_CANONICAL = {
  pk: 'id',
  name: 'property_name',
  label: 'property_label',
  value: 'property_value',
  mandatory: 'is_mandatory',
  isConfig: 'is_config', // only used if _customPropsHasIsConfig
  hasStatus: false,
};
const CUSTOM_PROP_COLS_LEGACY = {
  pk: 'c_prop_id',
  name: 'c_prop_name',
  label: 'c_prop_label', // only used if _customPropsHasLegacyLabel
  value: 'c_prop_values',
  mandatory: 'c_prop_mandatory',
  isConfig: 'is_config', // only used if _customPropsHasIsConfig
  hasStatus: true,
};

async function customPropCols() {
  const legacy = await detectCustomPropsShape();
  const cols = legacy ? { ...CUSTOM_PROP_COLS_LEGACY } : { ...CUSTOM_PROP_COLS_CANONICAL };
  // Legacy schema may or may not have c_prop_label. Drop the column
  // when the probe says absent so INSERT/UPDATE doesn't reference it.
  if (legacy && !_customPropsHasLegacyLabel) cols.label = null;
  // is_config is an optional additive column (migration 2026-07-10). Drop it
  // when the probe says absent so INSERT/UPDATE never reference a missing
  // column on a pre-migration deploy — exactly how c_prop_label is gated.
  if (!_customPropsHasIsConfig) cols.isConfig = null;
  return cols;
}

async function createCustomProperty(clientId, body) {
  logger.info('Create client custom property · clientId=' + clientId + ' name=' + (body && body.name));
  const cols = await customPropCols();
  // Build the column list dynamically based on what actually exists on
  // this deploy. Label column is optional on legacy snapshots without
  // c_prop_label — we omit it from the INSERT entirely in that case
  // (the FE label string still lands in tbl_client_custom_properties
  // via no avenue, so it's degraded but non-crashing).
  const insertCols = ['client_id', cols.name];
  const insertVals = [clientId, body.name];
  if (cols.label) {
    insertCols.push(cols.label);
    insertVals.push(body.label || null);
  }
  insertCols.push(cols.value, cols.mandatory);
  // Legacy `c_prop_values` is NOT NULL — coerce a missing/empty value to '' on
  // that shape (value-less flag rows like `branch_details` carry no client-level
  // default). Canonical `property_value` is nullable, so keep null there.
  // Trim the value so a stray space can never land in c_prop_values — the
  // opt-in checks match it EXACTLY ('true'), so 'true ' silently disables the
  // flag (the Greensoul trap). null → '' on legacy (c_prop_values is NOT NULL).
  const trimmedValue = (body.value == null) ? '' : String(body.value).trim();
  const valueCell = (trimmedValue === '')
    ? (cols.hasStatus ? '' : null)
    : trimmedValue;
  insertVals.push(valueCell, body.mandatory ? 1 : 0);
  // is_config discriminator (optional column — gated by the probe). Coerce a
  // truthy body flag → 1, else 0. Absent column → cols.isConfig is null and
  // this block no-ops (the DB DEFAULT 0 still applies on newer deploys).
  if (cols.isConfig) {
    insertCols.push(cols.isConfig);
    insertVals.push(body.is_config ? 1 : 0);
  }
  if (cols.hasStatus) {
    insertCols.push('status');
    insertVals.push(1);
  }
  const placeholders = insertCols.map(() => '?').join(', ');
  const [ins] = await pool.query(
    `INSERT INTO tbl_client_custom_properties (${insertCols.join(', ')}) VALUES (${placeholders})`,
    insertVals,
  );
  logger.info('Custom property created · id=' + ins.insertId + ' clientId=' + clientId);
  return ins.insertId;
}

/*
 * Body keys the route validator accepts. Each maps to the appropriate
 * column name picked by customPropCols() at runtime. `mandatory` /
 * `isMandatory` both map to the mandatory column for input flexibility.
 */
const CUSTOM_PROP_BODY_KEY_TO_COL_KEY = {
  name: 'name',
  label: 'label',
  value: 'value',
  mandatory: 'mandatory',
  isMandatory: 'mandatory',
  is_config: 'isConfig',
  // Canonical column names are also accepted (legacy callers).
  property_name: 'name',
  property_label: 'label',
  property_value: 'value',
  is_mandatory: 'mandatory',
};

async function updateCustomProperty(propId, body) {
  logger.info('Update client custom property · propId=' + propId);
  const cols = await customPropCols();
  const sets = [];
  const vals = [];
  for (const [bodyKey, val] of Object.entries(body || {})) {
    const colKey = CUSTOM_PROP_BODY_KEY_TO_COL_KEY[bodyKey];
    if (!colKey) continue;
    const dbCol = cols[colKey];
    if (!dbCol) continue; // e.g. label on legacy without c_prop_label
    let v = val;
    if (colKey === 'mandatory') v = val ? 1 : 0;
    else if (colKey === 'isConfig') v = val ? 1 : 0;
    // Trim the value so a stray space can't land in c_prop_values — the opt-in
    // checks match it EXACTLY ('true'), so 'true ' silently disables the flag
    // (the Greensoul trap). null → '' on legacy (c_prop_values is NOT NULL).
    else if (colKey === 'value') v = (v == null) ? (cols.hasStatus ? '' : null) : String(v).trim();
    sets.push(`${dbCol} = ?`);
    vals.push(v);
  }
  if (sets.length === 0) {
    throw Object.assign(new Error('nothing to update'), { status: 400 });
  }
  // Reactivate on edit (2026-07-09): a legacy soft-deleted row (status=0)
  // that gets edited in the CRM should become active again. Otherwise a
  // property that reads c_prop_values='true' but is still status=0 is
  // silently ignored by every status=1 opt-in check (magic-link sweep,
  // auto-process-unconfirmed-order) — the exact Greensoul trap. The new
  // backend never sets status=0 (delete is a hard DELETE), so forcing 1 on
  // update only ever HEALS a legacy soft-delete; it never re-enables a value
  // the operator turned off (that lives in c_prop_values, not status).
  if (cols.hasStatus) {
    sets.push('status = ?');
    vals.push(1);
  }
  vals.push(propId);
  const [r] = await pool.query(
    `UPDATE tbl_client_custom_properties SET ${sets.join(', ')} WHERE ${cols.pk} = ?`,
    vals,
  );
  logger.info('Custom property updated · propId=' + propId + ' affected=' + r.affectedRows);
  return r.affectedRows;
}

async function deleteCustomProperty(propId) {
  logger.info('Delete client custom property · propId=' + propId);
  const cols = await customPropCols();
  const [r] = await pool.query(
    `DELETE FROM tbl_client_custom_properties WHERE ${cols.pk} = ?`,
    [propId],
  );
  logger.info('Custom property deleted · propId=' + propId + ' affected=' + r.affectedRows);
  return r.affectedRows;
}

/*
 * Scope helper — resolve the owning client_id for a custom-property row.
 * Reuses the customPropCols() PK probe (the PK drifts between `id` and
 * `c_prop_id` across deploys) rather than hardcoding the column name.
 */
async function getCustomPropertyClientId(propId) {
  const cols = await customPropCols();
  const [[row]] = await pool.query(
    `SELECT client_id FROM tbl_client_custom_properties WHERE ${cols.pk} = ? LIMIT 1`,
    [propId],
  );
  return row ? row.client_id : null;
}

/*
 * Column-name drift probe for tbl_client_custom_properties.
 *
 * Some EasyFix environments have the legacy schema (c_prop_id /
 * c_prop_name / c_prop_values [PLURAL] / c_prop_mandatory / c_prop_type
 * / status), others have the canonical shape (property_name /
 * property_label / property_value / is_mandatory).
 *
 * Crucially, the legacy schema has **no label column at all** — that's
 * why the first cut crashed with `Unknown column 'c_prop_label'`. We
 * probe `c_prop_name` (which is the legacy marker column) AND
 * separately probe whether a `c_prop_label` column happens to exist
 * (some snapshots add it as an extension). The distinct-keys query
 * SELECTs a label column only when it's actually present.
 *
 * Both probes memoise per process.
 */
let _customPropsColsProbed = false;
let _customPropsLegacyShape = false; // true → c_prop_* columns
let _customPropsHasLegacyLabel = false; // true → c_prop_label exists
let _customPropsHasIsConfig = false; // true → is_config exists (migration 2026-07-10)
async function detectCustomPropsShape() {
  if (_customPropsColsProbed) return _customPropsLegacyShape;
  try {
    await pool.query('SELECT c_prop_name FROM tbl_client_custom_properties LIMIT 1');
    _customPropsLegacyShape = true;
  } catch (_e) {
    _customPropsLegacyShape = false;
  }
  if (_customPropsLegacyShape) {
    try {
      await pool.query('SELECT c_prop_label FROM tbl_client_custom_properties LIMIT 1');
      _customPropsHasLegacyLabel = true;
    } catch (_e) {
      _customPropsHasLegacyLabel = false;
    }
  }
  // Probe the additive is_config column independently of schema shape — the
  // migration adds it to whichever variant this deploy runs. Absent → the
  // write paths null out cols.isConfig and never reference the column.
  try {
    await pool.query('SELECT is_config FROM tbl_client_custom_properties LIMIT 1');
    _customPropsHasIsConfig = true;
  } catch (_e) {
    _customPropsHasIsConfig = false;
  }
  _customPropsColsProbed = true;
  return _customPropsLegacyShape;
}

/*
 * Scope helper — resolve the owning client_id for a client-service row.
 * Used by the route layer to scope-guard flat /services/:id reads/mutations.
 */
async function getServiceClientId(serviceId) {
  const [[row]] = await pool.query(
    'SELECT client_id FROM tbl_client_service WHERE client_service_id = ? LIMIT 1', [serviceId],
  );
  return row ? row.client_id : null;
}

/*
 * Scope helper — resolve the owning client_id for a client-document row.
 * Used by the route layer to scope-guard flat /documents/:id mutations.
 */
async function getDocumentClientId(docId) {
  const [[row]] = await pool.query(
    'SELECT client_id FROM tbl_client_document WHERE document_id = ? LIMIT 1', [docId],
  );
  return row ? row.client_id : null;
}

/*
 * Distinct list of custom-property keys ever used across all clients.
 *
 * Powers the Add Custom Property dropdown in the CRM_UI so operators can
 * pick from previously-used keys instead of trying to remember magic
 * strings. Merged on the FE with a hardcoded registry of "well-known"
 * keys that carry rich descriptions (e.g. max_magic_link_send_count).
 *
 * Shape per row: { key, sample_label, use_count }.
 *
 *   key          — c_prop_name (or property_name on canonical schema)
 *   sample_label — most-recently-set non-null label for that key (best-
 *                  effort hint; FE can override with the registry label)
 *   use_count    — number of DISTINCT clients with at least one row for
 *                  this key (drives display ordering — most-popular first)
 *
 * Filters: only active rows. On the legacy `c_prop_*` schema we filter
 * `status = 1`. The canonical schema has no such flag — we read all rows.
 * 200-row cap is plenty (current QA has < 30 distinct keys cluster-wide).
 */
async function listDistinctCustomPropertyKeys() {
  logger.info('List distinct custom-property keys');
  const legacy = await detectCustomPropsShape();
  // Build the sample_label SELECT fragment based on what columns actually
  // exist. Three cases:
  //   - Canonical schema: property_label exists → MAX(property_label).
  //   - Legacy schema + c_prop_label extension column: MAX(c_prop_label).
  //   - Legacy schema, no label column: select NULL — the FE falls back
  //     to displaying the bare key, no behavioural regression.
  let labelExpr;
  let nameCol;
  let extraFilters = '';
  if (legacy) {
    labelExpr = _customPropsHasLegacyLabel ? 'MAX(c_prop_label)' : 'NULL';
    nameCol   = 'c_prop_name';
    extraFilters = 'AND status = 1';
  } else {
    labelExpr = 'MAX(property_label)';
    nameCol   = 'property_name';
  }
  const sql = `SELECT LOWER(TRIM(${nameCol})) AS \`key\`,
                      ${labelExpr}            AS sample_label,
                      COUNT(DISTINCT client_id) AS use_count
                 FROM tbl_client_custom_properties
                WHERE ${nameCol} IS NOT NULL
                  AND TRIM(${nameCol}) <> ''
                  ${extraFilters}
                GROUP BY LOWER(TRIM(${nameCol}))
                ORDER BY use_count DESC, \`key\` ASC
                LIMIT 200`;
  const [rows] = await pool.query(sql);
  logger.info('Found ' + rows.length + ' distinct custom-property keys');
  return rows.map((r) => ({
    key: String(r.key || '').trim(),
    sample_label: r.sample_label ? String(r.sample_label) : null,
    use_count: Number(r.use_count) || 0,
  })).filter((r) => r.key);
}

module.exports = {
  // clients
  listClients,
  getClientById,
  createClient,
  updateClient,
  getClientColumns,
  // contacts
  listContacts,
  findDuplicateContact,
  createContact,
  updateContact,
  deleteContact,
  getContactClientId,
  // billing
  listBilling,
  createBilling,
  updateBilling,
  deleteBilling,
  getBillingClientId,
  // custom properties
  listCustomProperties,
  createCustomProperty,
  updateCustomProperty,
  deleteCustomProperty,
  getCustomPropertyClientId,
  listDistinctCustomPropertyKeys,
  // scope helpers for flat id-based sub-resource routes
  getServiceClientId,
  getDocumentClientId,
};
