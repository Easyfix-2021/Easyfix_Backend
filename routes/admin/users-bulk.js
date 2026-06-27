const router = require('express').Router();
const multer = require('multer');
const ExcelJS = require('exceljs');
const Joi = require('joi');

const validate = require('../../middleware/validate');
const { roleByName } = require('../../middleware/role');
const { pool } = require('../../db');
const userService = require('../../services/user.service');
const roleService = require('../../services/role.service');
const { modernOk, modernError } = require('../../utils/response');
const logger = require('../../logger');

/*
 * Bulk-update sub-router for Manage Users. Three endpoints:
 *
 *   GET  /api/admin/users/bulk-lookups
 *     Returns the master lists (verticals, clients-with-vertical-FK,
 *     states, cities) the FE needs to populate the multi-select pickers
 *     in the "Select Users & Apply" tab. Active-only filters.
 *
 *   GET  /api/admin/users/bulk-upload-template[?userIds=121,122]
 *     Returns an xlsx template with 8 columns matching the spec
 *     spreadsheet (User Details Bulk Upload format(UserDetails).csv).
 *     Locked dropdowns sourced from hidden vocab sheets so operators
 *     can only enter active values; multi-value comma-separated entries
 *     are allowed (errorStyle='information') for the four manage_*
 *     columns. If userIds is supplied, pre-populates rows with each
 *     user's current name + manage_* CSV strings.
 *
 *   POST /api/admin/users/bulk-upload
 *     multipart/form-data: file=<xlsx|csv>
 *     Per-row update — resolves names → IDs, joins with the user's
 *     current row, sends a PATCH to updateUser. Per-row error report.
 *
 * Mounted under /api/admin/users via routes/admin/users.js. Inherits
 * the admin-group + Admin-name role guards already in place there.
 */

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter(_req, file, cb) {
    if (!/\.(xlsx?|csv)$/i.test(file.originalname)) {
      return cb(Object.assign(new Error('only .xlsx / .xls / .csv files accepted'), { status: 400 }));
    }
    cb(null, true);
  },
});

// ──────────────────────────────────────────────────────────────────────
// GET /api/admin/users/bulk-lookups
// ──────────────────────────────────────────────────────────────────────
/*
 * Verticals join to clients via `tbl_vertical_mapping` (which carries
 * one row per (client_id, user_id, vertical_id) — we GROUP_CONCAT the
 * vertical_ids per client). Cities are filtered by active status; the
 * states list is the full master (no status column on tbl_state).
 *
 * Internal users for the Reporting Manager picker are sourced through
 * the existing userService — only active CRM users (user_type_id=5).
 */
router.get('/bulk-lookups', async (req, res, next) => {
  try {
    logger.info('Fetch bulk-update lookups');
    const [verticals, clients, states, cities, users, roles] = await Promise.all([
      pool.query(
        `SELECT vertical_id AS id, vertical_name AS name
           FROM tbl_vertical WHERE status = 1 ORDER BY vertical_name ASC`,
      ).then(([r]) => r),
      pool.query(
        `SELECT c.client_id AS id, c.client_name AS name,
                COALESCE(GROUP_CONCAT(DISTINCT vm.vertical_id ORDER BY vm.vertical_id), '') AS vertical_ids
           FROM tbl_client c
           LEFT JOIN tbl_vertical_mapping vm ON vm.client_id = c.client_id
          WHERE c.client_status = 1
          GROUP BY c.client_id, c.client_name
          ORDER BY c.client_name ASC`,
      ).then(([r]) => r.map((x) => ({
        id: x.id,
        name: x.name,
        verticalIds: String(x.vertical_ids || '')
          .split(',').filter(Boolean).map(Number),
      }))),
      pool.query(
        `SELECT state_id AS id, state_name AS name
           FROM tbl_state ORDER BY state_name ASC`,
      ).then(([r]) => r),
      pool.query(
        `SELECT city_id AS id, city_name AS name, state_id
           FROM tbl_city WHERE city_status = 1 ORDER BY city_name ASC`,
      ).then(([r]) => r.map((x) => ({ id: x.id, name: x.name, stateId: x.state_id }))),
      // Internal users — used by BOTH the Reporting Manager dropdown
      // AND the Select-Users & Apply tab's checkbox list. Returns email
      // + role_name so the FE can show "Name · Role" labels and the
      // operator can find the right row at a glance.
      //
      // History (2026-05-21 — reversed):
      //   We briefly hit tbl_user with only `user_status = 1` to expose
      //   active rows that fell outside `user_type_id = 5` (e.g.
      //   sundeep@easyfix.in, user_id=2 / Default User). Operator asked
      //   us to revert: the Bulk Update Users list must only show
      //   CRM-staff rows (`user_type_id = 5`). Legacy active accounts
      //   like sundeep that don't carry user_type_id=5 are intentionally
      //   hidden from this list now — bulk-applying CRM-shaped fields
      //   (manage_clients, manage_states, etc.) to them was never
      //   meaningful anyway.
      //
      //   The hardcoded `5` mirrors `INTERNAL_USER_TYPE_ID` in
      //   services/user.service.js (kept inline rather than importing
      //   to avoid a one-symbol cross-service require).
      //
      //   role_id = 19 (Technician) exclusion stays — those rows are
      //   documented ghost accounts (~4,700) whose real records live
      //   in tbl_easyfixer (see backend CLAUDE.md "Role model"). With
      //   the user_type_id=5 filter on, this is largely redundant
      //   (technician ghosts typically aren't user_type_id=5), but
      //   it's a cheap safety belt.
      pool.query(
        `SELECT u.user_id AS id, u.user_name AS name,
                u.official_email, r.role_name
           FROM tbl_user u
           LEFT JOIN tbl_role r ON r.role_id = u.user_role
          WHERE u.user_status = 1
            AND u.user_type_id = 5
            AND (u.user_role IS NULL OR u.user_role <> 19)
          ORDER BY u.user_name ASC`,
      ).then(([r]) => r),
      // Admin-group roles only — these are the ones a CRM user can be
      // assigned to via updateUser() (the service rejects non-admin
      // groups with a 400 anyway). Mirrors createUser/updateUser's
      // own admin-group enforcement so the FE picker never offers a
      // value the backend would then reject.
      pool.query(
        `SELECT role_id AS id, role_name AS name
           FROM tbl_role WHERE role_status = 1 ORDER BY role_name ASC`,
      ).then(([r]) => r.filter(
        (row) => roleService.ROLE_ID_TO_GROUP[row.id] === 'admin'
      )),
    ]);
    logger.info('Returning bulk-update lookups · verticals=' + verticals.length + ' clients=' + clients.length + ' states=' + states.length + ' cities=' + cities.length + ' users=' + users.length + ' roles=' + roles.length);
    modernOk(res, { verticals, clients, states, cities, users, roles });
  } catch (e) { next(e); }
});

// ──────────────────────────────────────────────────────────────────────
// GET /api/admin/users/bulk-upload-template?userIds=121,122
// ──────────────────────────────────────────────────────────────────────
/*
 * Columns (matches the legacy CSV format the user provided):
 *   A user ID                B user name             C Role
 *   D Reporting Manager      E Manage Vertical(s)    F Manage Client(s)
 *   G Manage State(s)        H Manage Cities         I Home City
 *
 * Cell validations (rows 2..1000):
 *   - Multi-select columns (E/F/G/H): list source from a hidden sheet,
 *     errorStyle='information' so operators can type comma-separated
 *     values OR "All". (Excel's strict list rejects anything else;
 *     downgrading to information lets typed CSVs through.)
 *   - Reporting Manager (D) + Home City (I): list source, error-style
 *     'error' (single-pick), no "All" — operators must pick a real
 *     value.
 *
 * `userIds` query param: when supplied, pre-fills rows with each
 * user's current scope CSVs so operators don't start from scratch.
 */
router.get('/bulk-upload-template', async (req, res, next) => {
  try {
    logger.info('Build bulk-upload template · userIds=' + (req.query.userIds || ''));
    const wb = new ExcelJS.Workbook();
    wb.creator = 'EasyFix';
    wb.created = new Date();

    const ws = wb.addWorksheet('Users');
    const headers = [
      'user ID', 'user name', 'Role', 'Reporting Manager',
      'Manage Vertical(s)', 'Manage Client(s)', 'Manage State(s)',
      'Manage Cities', 'Home City',
    ];
    ws.addRow(headers);
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = {
      type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF2F7' },
    };
    ws.columns = headers.map((h) => ({ width: Math.max(14, Math.min(40, h.length + 4)) }));

    // Optional pre-population — `?userIds=121,122,123`. Reads the
    // current user rows + joined role/manager/city names so the
    // operator's template arrives populated, ready to edit.
    const userIds = String(req.query.userIds || '')
      .split(',').map((s) => s.trim()).filter(Boolean).map(Number)
      .filter((n) => Number.isInteger(n) && n > 0);
    if (userIds.length > 0) {
      const placeholders = userIds.map(() => '?').join(',');
      const [rows] = await pool.query(
        `SELECT u.user_id, u.user_name, r.role_name,
                mgr.user_name AS reporting_manager_name,
                u.manage_verticals, u.manage_clients,
                u.manage_states, u.manage_cities,
                city.city_name AS home_city_name
           FROM tbl_user u
           LEFT JOIN tbl_role r       ON r.role_id     = u.user_role
           LEFT JOIN tbl_user mgr     ON mgr.user_id   = u.reporting_manager
           LEFT JOIN tbl_city city    ON city.city_id  = u.city_id
          WHERE u.user_id IN (${placeholders})
          ORDER BY u.user_id ASC`,
        userIds,
      );
      logger.info('Found ' + rows.length + ' users to pre-populate template');

      // Decode scope CSVs from id-CSV → name-CSV for display. Loads
      // master maps once; "0" stays as the "All" sentinel.
      const [
        [verticals], [clients], [states], [cities],
      ] = await Promise.all([
        pool.query('SELECT vertical_id AS id, vertical_name AS name FROM tbl_vertical'),
        pool.query('SELECT client_id   AS id, client_name   AS name FROM tbl_client'),
        pool.query('SELECT state_id    AS id, state_name    AS name FROM tbl_state'),
        pool.query('SELECT city_id     AS id, city_name     AS name FROM tbl_city'),
      ]);
      const vMap = new Map(verticals.map((x) => [String(x.id), x.name]));
      const cMap = new Map(clients.map((x) => [String(x.id), x.name]));
      const sMap = new Map(states.map((x) => [String(x.id), x.name]));
      const ctMap = new Map(cities.map((x) => [String(x.id), x.name]));
      const decode = (csv, map) => {
        const s = String(csv || '').trim();
        if (!s) return '';
        if (s === '0') return 'All';
        return s.split(',').map((id) => map.get(id.trim()) || '').filter(Boolean).join(', ');
      };
      for (const r of rows) {
        ws.addRow([
          r.user_id, r.user_name, r.role_name || '',
          r.reporting_manager_name || '',
          decode(r.manage_verticals, vMap),
          decode(r.manage_clients,   cMap),
          decode(r.manage_states,    sMap),
          decode(r.manage_cities,    ctMap),
          r.home_city_name || '',
        ]);
      }
    }

    // ─── Instructions sheet ──────────────────────────────────────
    // VBA snippet operators can install for true Ctrl/Cmd+Click
    // multi-select toggle behavior on the four scope columns.
    //
    // Why this isn't baked in: exceljs has no API for writing
    // vbaProject.bin (the binary macro container .xlsm needs).
    // Shipping VBA pre-installed requires either a different library
    // (xlsx-populate, which can extend a pre-built blank vbaProject)
    // OR hand-crafting the OOXML zip with a known-good vbaProject.bin
    // committed to the repo. Both are heavy.
    //
    // The path of least friction: emit the VBA on an Instructions
    // sheet inside this very template. Operators who want toggle
    // behavior do the one-time install (Alt+F11 → paste → save as
    // .xlsm). Operators who don't bother still get the typed-CSV
    // + dropdown experience the parser already supports.
    const instr = wb.addWorksheet('Instructions');
    instr.columns = [{ width: 100 }];
    const lines = [
      ['Bulk User Update — instructions'],
      [''],
      ['Quick path (works in any .xlsx):'],
      ['  · Pick from the dropdown for a single value.'],
      ['  · For multiple values, TYPE them comma-separated (e.g. "Retail, Furniture").'],
      ['  · Type "All" (case-insensitive) in Verticals / Clients / States / Cities to apply to every active record.'],
      ['  · Reporting Manager and Home City accept a single value only.'],
      [''],
      ['Cascading dropdowns:'],
      ['  · Manage Client(s) is filtered by the Vertical you picked in the same row.'],
      ['  · Manage Cities is filtered by the State you picked in the same row.'],
      ['  · The filter only applies when the parent column has a single value (single-pick).'],
      ['  · When the parent is blank or a comma-separated list, Excel shows a soft warning — typed values still go through.'],
      [''],
      ['Reference sheets ("Clients" and "Cities"):'],
      ['  · Locked, read-only listings of every active Client (with its mapped Vertical) and every active City (with its State).'],
      ['  · Use these to look up the exact spelling before typing comma-separated values.'],
      [''],
      ['Optional — enable Ctrl/Cmd+Click toggle multi-select via VBA:'],
      ['  1. Save this file as ".xlsm" (Excel Macro-Enabled Workbook).'],
      ['  2. Press Alt+F11 to open the VBA editor.'],
      ['  3. Double-click "Users" under Microsoft Excel Objects.'],
      ['  4. Paste the VBA code block below.'],
      ['  5. Press Ctrl+S to save. Allow macros when re-opening the file.'],
      [''],
      ['---- BEGIN VBA ----'],
      ['Private Sub Worksheet_Change(ByVal Target As Range)'],
      ['  ' + "' Multi-select toggle for columns E (Verticals), F (Clients), G (States), H (Cities)."],
      ['  ' + "' Each pick appends to the existing CSV; picking an existing value removes it."],
      ['  Dim oldVal As String, newVal As String, parts() As String, i As Integer'],
      ['  Dim found As Boolean, out As String'],
      ['  On Error GoTo finish'],
      ['  If Target.CountLarge > 1 Then Exit Sub'],
      ['  If Target.Row < 2 Then Exit Sub'],
      ['  If Target.Column < 5 Or Target.Column > 8 Then Exit Sub'],
      ['  Application.EnableEvents = False'],
      ['  newVal = Trim(CStr(Target.Value))'],
      ['  oldVal = Trim(CStr(Target.Cells(1, 1).Comment.Text)) ' + "' previous via comment"],
      ['  If LCase(newVal) = "all" Then'],
      ['    Target.Value = "All"'],
      ['    GoTo writeBack'],
      ['  End If'],
      ['  If oldVal = "" Then'],
      ['    Target.Value = newVal'],
      ['    GoTo writeBack'],
      ['  End If'],
      ['  parts = Split(oldVal, ",")'],
      ['  found = False'],
      ['  out = ""'],
      ['  For i = LBound(parts) To UBound(parts)'],
      ['    If LCase(Trim(parts(i))) = LCase(newVal) Then'],
      ['      found = True'],
      ['    Else'],
      ['      If out = "" Then out = Trim(parts(i)) Else out = out & ", " & Trim(parts(i))'],
      ['    End If'],
      ['  Next i'],
      ['  If Not found Then'],
      ['    If out = "" Then out = newVal Else out = out & ", " & newVal'],
      ['  End If'],
      ['  Target.Value = out'],
      ['writeBack:'],
      ['  ' + "' Stash the cell's new value in a hidden comment so the next change sees it as the old value."],
      ['  Target.ClearComments'],
      ['  Target.AddComment Text:=CStr(Target.Value)'],
      ['  Target.Comment.Visible = False'],
      ['finish:'],
      ['  Application.EnableEvents = True'],
      ['End Sub'],
      ['---- END VBA ----'],
      [''],
      ['Notes:'],
      ['  · Single-pick columns (Reporting Manager, Home City) are unaffected — they use Excel\'s strict list validator.'],
      ['  · "All" can be typed at any time and overrides any existing CSV.'],
      ['  · Removing a value: pick it again from the dropdown — the macro detects the duplicate and removes it.'],
    ];
    lines.forEach((row) => instr.addRow(row));
    instr.getRow(1).font = { bold: true, size: 14 };
    instr.getRow(10).font = { bold: true };
    instr.getRow(17).font = { italic: true };
    instr.getRow(56).font = { italic: true };

    // ─── Vocab + cascading-validation data sources ───────────────
    //
    // We need two flavours of vocab in the workbook:
    //
    //   (a) Flat lists of every active record per dimension (verticals,
    //       clients, states, cities, users). These drive the
    //       multi-select dropdowns on col E (Vertical) and col G (State),
    //       and the unconditional fallback on col F/H when no parent
    //       was picked. They live on `veryHidden` vocab sheets the
    //       operator never sees.
    //
    //   (b) Per-parent slices: one hidden sheet per Vertical (listing
    //       its mapped Clients) and one per State (listing its Cities).
    //       Each slice gets a stable Excel defined-name keyed by the
    //       parent ID (e.g. `vCli_42` → that vertical's client list).
    //       A hidden name→id mapping sheet plus a VLOOKUP turns the
    //       picked parent NAME on the row into the matching defined
    //       name, fed into INDIRECT() so the dependent dropdown
    //       contracts to that parent's children.
    //
    //   (c) Two VISIBLE protected reference sheets — `Clients`
    //       (Vertical → Client pairs) and `Cities` (State → City pairs)
    //       — so the operator can browse what's available without
    //       leaving the workbook. Locked via worksheet protection so
    //       accidental edits don't corrupt the vocab.
    //
    // INDIRECT-on-VLOOKUP fails (returns #N/A) the moment col E or G
    // carries a comma-separated list — Excel can't resolve a single
    // name from "Retail, Furniture". That's deliberate: when the
    // strict match misses, `errorStyle: 'information'` makes the
    // validation a soft warning the operator can dismiss, so typed
    // CSVs still write through. The cascading slice is therefore a
    // helpful single-pick affordance, not a hard gate.
    const [
      [vRows], [cRows], [sRows], [ctRows], [uRows], [vmRows], [scRows], [roleRowsAll],
    ] = await Promise.all([
      pool.query('SELECT vertical_id AS id, vertical_name AS name FROM tbl_vertical WHERE status = 1 ORDER BY vertical_name ASC'),
      pool.query('SELECT client_id   AS id, client_name   AS name FROM tbl_client   WHERE client_status = 1 ORDER BY client_name ASC'),
      pool.query('SELECT state_id    AS id, state_name    AS name FROM tbl_state                                            ORDER BY state_name ASC'),
      pool.query('SELECT city_id     AS id, city_name     AS name, state_id FROM tbl_city WHERE city_status = 1            ORDER BY city_name ASC'),
      pool.query("SELECT user_name AS name FROM tbl_user WHERE user_status = 1 AND (user_role IS NULL OR user_role <> 19) ORDER BY user_name ASC"),
      // Vertical → Client mapping (many-to-many via tbl_vertical_mapping).
      pool.query(
        `SELECT DISTINCT v.vertical_id, v.vertical_name, c.client_id, c.client_name
           FROM tbl_vertical v
           JOIN tbl_vertical_mapping vm ON vm.vertical_id = v.vertical_id
           JOIN tbl_client c            ON c.client_id    = vm.client_id
          WHERE v.status = 1 AND c.client_status = 1
          ORDER BY v.vertical_name, c.client_name`
      ),
      // State → City mapping (one-to-many via tbl_city.state_id).
      pool.query(
        `SELECT s.state_id, s.state_name, c.city_id, c.city_name
           FROM tbl_state s
           JOIN tbl_city  c ON c.state_id = s.state_id
          WHERE c.city_status = 1
          ORDER BY s.state_name, c.city_name`
      ),
      // Admin-group role master — filter happens client-side because
      // ROLE_ID_TO_GROUP lives in JS (matches the bulk-lookups path).
      pool.query('SELECT role_id AS id, role_name AS name FROM tbl_role WHERE role_status = 1 ORDER BY role_name ASC'),
    ]);
    // Filter to admin-group only — same gate the FE picker honours +
    // the bulk-update parser enforces. Keeps the template from
    // offering Default User / Technician / Client roles operators
    // shouldn't be assigning here.
    const rRows = roleRowsAll.filter(
      (row) => roleService.ROLE_ID_TO_GROUP[row.id] === 'admin'
    );

    // Flat veryHidden vocab sheets (legacy refs kept for the bulk-pick
    // unconditional fallback and for the Reporting Manager / Home City
    // single-pick columns).
    const addVocab = (sheetName, names) => {
      const v = wb.addWorksheet(sheetName, { state: 'veryHidden' });
      names.forEach((n) => v.addRow([n]));
      return Math.max(names.length, 1);
    };
    const vCount  = addVocab('voc_verticals', vRows.map((x) => x.name));
    const cCount  = addVocab('voc_clients',   cRows.map((x) => x.name));
    const sCount  = addVocab('voc_states',    sRows.map((x) => x.name));
    const ctCount = addVocab('voc_cities',    ctRows.map((x) => x.name));
    const uCount  = addVocab('voc_users',     uRows.map((x) => x.name));
    const rCount  = addVocab('voc_roles',     rRows.map((x) => x.name));

    // Name → id maps (two columns) so per-row INDIRECT can do
    //   VLOOKUP(E2, voc_v_id_map!A:B, 2, FALSE) → vertical_id → "vCli_<id>"
    // Excel's INDIRECT then resolves the defined name to the slice range.
    const addIdMap = (sheetName, rows) => {
      const v = wb.addWorksheet(sheetName, { state: 'veryHidden' });
      rows.forEach((r) => v.addRow([r.name, r.id]));
      return Math.max(rows.length, 1);
    };
    addIdMap('voc_v_id_map', vRows);
    addIdMap('voc_s_id_map', sRows);

    // Per-parent slices: bucket children by parent_id, write one sheet
    // per parent, and register a workbook-scoped defined name pointing
    // at column A of that sheet. Keys use the numeric id so the Excel
    // name is always alphanumeric-safe (no escaping headaches for
    // weird vertical / state names).
    const bucket = (rows, parentIdKey, childNameKey) => {
      const m = new Map();
      for (const r of rows) {
        const pid = r[parentIdKey];
        if (pid == null) continue;
        if (!m.has(pid)) m.set(pid, []);
        m.get(pid).push(r[childNameKey]);
      }
      return m;
    };
    const verticalToClients = bucket(vmRows, 'vertical_id', 'client_name');
    const stateToCities     = bucket(scRows, 'state_id',    'city_name');

    const writeSliceSheets = (prefix, defNamePrefix, idMap) => {
      // Sheet names: prefix + index (≤31 chars). Defined names: defNamePrefix
      // + parent_id. Dedupe child names inside a slice — vm sometimes
      // carries multiple (vertical, client, user) rows per pair.
      let idx = 0;
      for (const [parentId, children] of idMap.entries()) {
        idx += 1;
        const sheetName = `${prefix}_${idx}`;
        const sh = wb.addWorksheet(sheetName, { state: 'veryHidden' });
        const uniq = Array.from(new Set(children));
        uniq.forEach((n) => sh.addRow([n]));
        const n = Math.max(uniq.length, 1);
        wb.definedNames.add(
          `${sheetName}!$A$1:$A$${n}`,
          `${defNamePrefix}_${parentId}`,
        );
      }
    };
    writeSliceSheets('voc_v_slice', 'vCli', verticalToClients);
    writeSliceSheets('voc_s_slice', 'sCty', stateToCities);

    // ─── Visible protected reference sheets ───────────────────────
    // Operators get a human-readable "what clients belong to which
    // vertical" view inside the workbook itself. Locked via worksheet
    // protection so accidental edits don't corrupt the vocab — but the
    // FE-side validation doesn't read these; they're for the operator's
    // eyes only.
    const buildRefSheet = (sheetName, headers, rows) => {
      const sh = wb.addWorksheet(sheetName);
      sh.addRow(headers);
      sh.getRow(1).font = { bold: true };
      sh.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF2F7' } };
      sh.columns = headers.map(() => ({ width: 30 }));
      rows.forEach((r) => sh.addRow(r));
      // Worksheet protection lets us pin the data while keeping it
      // visible. Empty password — protection isn't a security boundary
      // here, it's an accidental-edit guard, the same posture xlsx uses
      // by default for "read-only sheet".
      sh.protect('', {
        selectLockedCells: true,
        selectUnlockedCells: true,
        formatCells: false,
        formatColumns: false,
        formatRows: false,
        insertRows: false,
        insertColumns: false,
        deleteRows: false,
        deleteColumns: false,
        sort: true,
        autoFilter: true,
      });
    };
    buildRefSheet(
      'Clients',
      ['Vertical', 'Client'],
      vmRows.map((r) => [r.vertical_name, r.client_name]),
    );
    buildRefSheet(
      'Cities',
      ['State', 'City'],
      scRows.map((r) => [r.state_name, r.city_name]),
    );

    // ─── Per-row data validations (rows 2..1000) ─────────────────
    // Verticals/States stay flat (multi-select via CSV typing).
    // Clients/Cities cascade off the parent column when single-picked;
    // soft-fail (information) when the parent is blank or a CSV.
    const vIdMapRange = `voc_v_id_map!$A:$B`;
    const sIdMapRange = `voc_s_id_map!$A:$B`;
    for (let r = 2; r <= 1000; r++) {
      // Role (col C) — single-pick from active admin-group roles.
      ws.getCell(`C${r}`).dataValidation = {
        type: 'list', allowBlank: true,
        formulae: [`=voc_roles!$A$1:$A$${rCount}`],
        showErrorMessage: true, errorStyle: 'error',
        errorTitle: 'Invalid value',
        error: 'Pick an admin-group role from the list.',
      };
      // Reporting Manager (col D) — single-pick from active users.
      ws.getCell(`D${r}`).dataValidation = {
        type: 'list', allowBlank: true,
        formulae: [`=voc_users!$A$1:$A$${uCount}`],
        showErrorMessage: true, errorStyle: 'error',
        errorTitle: 'Invalid value',
        error: 'Pick an active user from the list.',
      };
      // Manage Vertical(s) (col E) — multi-select via CSV typing OR
      // dropdown single-pick. "All" sentinel allowed.
      ws.getCell(`E${r}`).dataValidation = {
        type: 'list', allowBlank: true,
        formulae: [`=voc_verticals!$A$1:$A$${vCount}`],
        showErrorMessage: true, errorStyle: 'information',
        errorTitle: 'Multi-select allowed',
        error: 'Pick one, type multiple values comma-separated, or type "All".',
      };
      // Manage Client(s) (col F) — cascades off col E. INDIRECT looks
      // up the vertical_id from the name map, then resolves the
      // matching `vCli_<id>` defined name. When E is empty or a CSV,
      // the inner VLOOKUP fails → INDIRECT returns #REF! → soft
      // information-level validation lets the user proceed anyway,
      // falling back to the master client list semantically.
      ws.getCell(`F${r}`).dataValidation = {
        type: 'list', allowBlank: true,
        formulae: [`=INDIRECT("vCli_" & VLOOKUP(E${r}, ${vIdMapRange}, 2, FALSE))`],
        showErrorMessage: true, errorStyle: 'information',
        errorTitle: 'Cascades from Vertical',
        error: 'Pick a vertical first to filter clients, or type multiple values comma-separated.',
      };
      // Manage State(s) (col G).
      ws.getCell(`G${r}`).dataValidation = {
        type: 'list', allowBlank: true,
        formulae: [`=voc_states!$A$1:$A$${sCount}`],
        showErrorMessage: true, errorStyle: 'information',
        errorTitle: 'Multi-select allowed',
        error: 'Pick one, type multiple values comma-separated, or type "All".',
      };
      // Manage Cities (col H) — cascades off col G.
      ws.getCell(`H${r}`).dataValidation = {
        type: 'list', allowBlank: true,
        formulae: [`=INDIRECT("sCty_" & VLOOKUP(G${r}, ${sIdMapRange}, 2, FALSE))`],
        showErrorMessage: true, errorStyle: 'information',
        errorTitle: 'Cascades from State',
        error: 'Pick a state first to filter cities, or type multiple values comma-separated.',
      };
      // Home City (col I) — single-pick, no "All".
      ws.getCell(`I${r}`).dataValidation = {
        type: 'list', allowBlank: true,
        formulae: [`=voc_cities!$A$1:$A$${ctCount}`],
        showErrorMessage: true, errorStyle: 'error',
        errorTitle: 'Invalid value',
        error: 'Pick a single active city.',
      };
    }

    const buf = await wb.xlsx.writeBuffer();
    logger.info('Returning bulk-upload template xlsx · bytes=' + buf.byteLength);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="easyfix-users-bulk-update-template.xlsx"');
    res.setHeader('Cache-Control', 'no-store');
    res.send(Buffer.from(buf));
  } catch (err) { next(err); }
});

// ──────────────────────────────────────────────────────────────────────
// POST /api/admin/users/bulk-upload
// ──────────────────────────────────────────────────────────────────────
/*
 * Resolves names → IDs for each multi-select column via
 * lowercase-trimmed Map lookup. "All" / "all" → the sentinel '0'. Empty
 * cells leave the field untouched (PATCH with that key undefined).
 *
 * Per-row failures are surfaced individually — we never roll back
 * already-updated rows.
 */
const bulkUploadBodyMeta = Joi.object({
  dryRun: Joi.boolean().default(false),
});
router.post('/bulk-upload',
  roleByName(['Admin']),
  upload.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file) return modernError(res, 400, 'missing "file" upload');
      const dryRun = String(req.query.dryRun || '').toLowerCase() === 'true';
      logger.info('Bulk-upload users · file=' + req.file.originalname + ' dryRun=' + dryRun);

      const wb = new ExcelJS.Workbook();
      // .csv and .xlsx are read via different methods on exceljs.
      const isCsv = /\.csv$/i.test(req.file.originalname);
      const stream = require('stream');
      const buf = req.file.buffer;
      try {
        if (isCsv) {
          // exceljs csv reader needs a Readable; quick wrap.
          const r = new stream.PassThrough(); r.end(buf);
          await wb.csv.read(r);
        } else {
          await wb.xlsx.load(buf);
        }
      } catch (parseErr) {
        logger.warn('Bulk-upload parse failed · ' + parseErr.message);
        return modernError(res, 400, `could not parse upload: ${parseErr.message}`);
      }
      const ws = wb.worksheets[0];
      if (!ws) return modernError(res, 400, 'upload has no readable sheets');

      // Build name → id maps from active master tables. Lowercased keys
      // for case-insensitive matching.
      const lc = (s) => String(s || '').trim().toLowerCase();
      const [
        [verticals], [clients], [states], [cities], [users], [roleRows],
      ] = await Promise.all([
        pool.query('SELECT vertical_id AS id, LOWER(vertical_name) AS name FROM tbl_vertical WHERE status = 1'),
        pool.query('SELECT client_id   AS id, LOWER(client_name)   AS name FROM tbl_client   WHERE client_status = 1'),
        pool.query('SELECT state_id    AS id, LOWER(state_name)    AS name FROM tbl_state'),
        pool.query('SELECT city_id     AS id, LOWER(city_name)     AS name FROM tbl_city     WHERE city_status = 1'),
        pool.query("SELECT user_id AS id, LOWER(user_name) AS name FROM tbl_user WHERE user_status = 1 AND user_type_id = 5"),
        // Admin-group roles only — match the bulk-lookups filter so the
        // upload can't smuggle in a Default-User or Technician role
        // that the FE picker would never offer.
        pool.query('SELECT role_id AS id, LOWER(role_name) AS name FROM tbl_role WHERE role_status = 1'),
      ]);
      const adminRoles = roleRows.filter(
        (row) => roleService.ROLE_ID_TO_GROUP[row.id] === 'admin'
      );
      const maps = {
        v:  new Map(verticals.map((x) => [x.name, x.id])),
        c:  new Map(clients.map((x)   => [x.name, x.id])),
        s:  new Map(states.map((x)    => [x.name, x.id])),
        ct: new Map(cities.map((x)    => [x.name, x.id])),
        u:  new Map(users.map((x)     => [x.name, x.id])),
        r:  new Map(adminRoles.map((x) => [x.name, x.id])),
      };

      // Multi-CSV → id-CSV. Returns:
      //   '' for empty input (caller skips the field on PATCH)
      //   '0' for "All" (case-insensitive)
      //   '<id1>,<id2>' for resolved names
      //   { error: '...' } when a token can't be resolved
      const resolveMulti = (cell, map, label) => {
        const raw = String(cell || '').trim();
        if (!raw) return { value: '', empty: true };
        if (raw.toLowerCase() === 'all') return { value: '0' };
        const tokens = raw.split(',').map((t) => t.trim()).filter(Boolean);
        const ids = [];
        for (const t of tokens) {
          const id = map.get(t.toLowerCase());
          if (!id) return { error: `Unknown ${label} "${t}"` };
          ids.push(id);
        }
        return { value: Array.from(new Set(ids)).join(',') };
      };
      const resolveSingle = (cell, map, label, allowEmpty = true) => {
        const raw = String(cell || '').trim();
        if (!raw) return { value: null, empty: true };
        if (!allowEmpty && raw.toLowerCase() === 'all') {
          return { error: `"All" is not allowed for ${label}` };
        }
        const id = map.get(raw.toLowerCase());
        if (!id) return { error: `Unknown ${label} "${raw}"` };
        return { value: id };
      };

      const results = [];
      let updated = 0; let failed = 0; let skipCount = 0; let unchanged = 0;

      // Row 1 is header — iterate from row 2.
      const lastRow = ws.actualRowCount || ws.rowCount;
      logger.info('Processing bulk-upload rows · dataRows=' + Math.max(0, lastRow - 1));
      for (let rIdx = 2; rIdx <= lastRow; rIdx++) {
        const row = ws.getRow(rIdx);
        // Cell values come back as the raw type — number for user_id,
        // string for names. Convert defensively.
        const cells = (n) => {
          const v = row.getCell(n).value;
          if (v == null) return '';
          if (typeof v === 'object' && 'text' in v) return v.text; // rich text
          if (typeof v === 'object' && 'result' in v) return v.result;
          return v;
        };
        const userIdRaw = cells(1);
        if (userIdRaw === '' || userIdRaw == null) continue; // blank row
        const userId = Number(userIdRaw);
        if (!Number.isInteger(userId) || userId <= 0) {
          skipCount++;
          results.push({ rowNumber: rIdx, status: 'skipped', reason: `invalid user ID "${userIdRaw}"` });
          continue;
        }

        // Col C is Role — single-pick, admin-group only. Empty cell
        // means "don't touch the existing role" (consistent with every
        // other column). "All" is explicitly NOT a valid value for
        // role (every user has exactly one).
        const role = resolveSingle(cells(3), maps.r,  'Role', false);
        const rm   = resolveSingle(cells(4), maps.u,  'Reporting Manager');
        const v    = resolveMulti(cells(5), maps.v, 'Vertical');
        const c    = resolveMulti(cells(6), maps.c, 'Client');
        const st   = resolveMulti(cells(7), maps.s, 'State');
        const cty  = resolveMulti(cells(8), maps.ct, 'City');
        const home = resolveSingle(cells(9), maps.ct, 'Home City', false);

        const errs = [role, rm, v, c, st, cty, home].filter((x) => x.error).map((x) => x.error);
        if (errs.length) {
          failed++;
          results.push({ rowNumber: rIdx, userId, status: 'failed', errors: errs });
          continue;
        }

        // Build the PATCH payload — only include keys the operator
        // actually filled in. `empty: true` means "don't touch".
        const fields = {};
        if (!role.empty) fields.user_role         = role.value;
        if (!v.empty)    fields.manage_verticals  = v.value;
        if (!c.empty)    fields.manage_clients    = c.value;
        if (!st.empty)   fields.manage_states     = st.value;
        if (!cty.empty)  fields.manage_cities     = cty.value;
        if (!rm.empty)   fields.reporting_manager = rm.value;
        if (!home.empty) fields.city_id           = home.value;

        // Vertical-without-client guard (same as bulk-update body).
        if (fields.manage_verticals !== undefined && fields.manage_clients === undefined) {
          failed++;
          results.push({
            rowNumber: rIdx, userId, status: 'failed',
            errors: ['Manage Vertical(s) changed but Manage Client(s) is empty — supply clients (or "All").'],
          });
          continue;
        }

        if (!Object.keys(fields).length) {
          skipCount++;
          results.push({ rowNumber: rIdx, userId, status: 'skipped', reason: 'no fields filled' });
          continue;
        }

        // Both dry-run and live paths call updateUser; the `dryRun`
        // option short-circuits the actual write while still computing
        // the diff, so the per-row status is meaningful in both modes:
        //   - __unchanged → every supplied field already matched the
        //                   persisted value (no UPDATE issued)
        //   - __wouldUpdate → dry-run, real changes detected
        //   - (otherwise) → live UPDATE succeeded
        try {
          const result = await userService.updateUser(
            userId, fields, req.user?.user_id, { dryRun },
          );
          if (result && result.__unchanged) {
            unchanged++;
            results.push({ rowNumber: rIdx, userId, status: 'unchanged' });
          } else if (dryRun) {
            results.push({ rowNumber: rIdx, userId, status: 'valid' });
          } else {
            updated++;
            results.push({ rowNumber: rIdx, userId, status: 'updated' });
          }
        } catch (e) {
          failed++;
          results.push({ rowNumber: rIdx, userId, status: 'failed', errors: [e.message] });
        }
      }

      logger.info('Bulk-upload complete · dryRun=' + dryRun + ' updated=' + updated + ' unchanged=' + unchanged + ' failed=' + failed + ' skipped=' + skipCount);
      modernOk(res, {
        summary: { updated, unchanged, failed, skipCount, dryRun },
        results,
      }, dryRun ? 'validation complete (no rows updated)' : 'bulk upload complete');
    } catch (e) {
      if (e.code === 'LIMIT_FILE_SIZE') return modernError(res, 400, 'file exceeds 10MB');
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  }
);

// `bulkUploadBodyMeta` reserved for future query-param validation.
void bulkUploadBodyMeta;

module.exports = router;
