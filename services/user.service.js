const { pool } = require('../db');
const logger = require('../logger');
const roleService = require('./role.service');
const { parseAllowedRows, parseAllowedInput, NO_ACCESS_KEY } = require('../lib/job-stages');
/*
 * Employee code (tbl_user.user_code) — the format lives in ONE place. Never
 * re-type the prefix-plus-six-digits pattern, and never hand-pad the count,
 * here or in the route: import EMP_CODE_RE and formatEmpCode instead. See the
 * header of lib/emp-code.js for why that matters more than usual: tbl_user has
 * no UNIQUE index on user_code and we may not add one, so a drifted second copy
 * of the regex would silently hand out a code that already exists.
 * tests/emp-code.test.js fails the build if either signature reappears.
 */
const { EMP_CODE_RE, EMP_CODE_LOCK, EMP_CODE_FORMAT_HINT, parseEmpCode, nextEmpCode } = require('../lib/emp-code');
/* PAN is stored as an AES-256-GCM envelope, same as the two bank columns —
   see migrations/2026-09-02-add-uan-pan-user-personal-details.sql. */
const fieldCrypto = require('../lib/field-crypto');
// Microsoft 365 mailbox provisioning. Fail-soft + fail-closed by design — see
// the call site in createUser() for the rules it must obey.
const entraProvisioning = require('./entra-provisioning.service');
// "Your EasyFix account is ready" credential mail. Only ever called from the
// create path, and only when the provisioning outcome says the mailbox is real.
const welcomeMail = require('./user-welcome-mail.service');
const s3 = require('../utils/s3-storage');

/*
 * Avatar presign lifetime for the Manage Users LIST. Lives here rather than in
 * utils/s3-storage.js because getPresignedUrl already takes `expiresIn` for
 * exactly this — a caller with a documented reason opts out of the shared
 * 5-minute default without the other 23 call sites having to care. The reason
 * is written out at the call site in listUsers().
 */
const USER_PHOTO_PRESIGN_TTL_SEC = Number(process.env.S3_USER_PHOTO_PRESIGN_TTL_SEC) || 3600; // 1 hour

/*
 * Manage Users — internal-staff CRUD on tbl_user.
 *
 * Mirrors the cities service in shape (list/get/create/update/deactivate +
 * sortable-column whitelist + mkErr helper). The big behavioural rule:
 *
 *   Internal-user gate (user_type_id = 5)
 *   ─────────────────────────────────────
 *   The CRM only manages user_type_id = 5 — internal staff. The legacy DB
 *   carries other user_type_ids (clients, technicians ghosts, etc.) and the
 *   auth flow in services/auth.service.js already enforces this gate at OTP
 *   issuance. We mirror it here so an Admin can never accidentally create or
 *   list a row that wouldn't actually be loginable.
 *
 * Soft-delete only — tbl_user is referenced by tbl_job.fk_created_by,
 * tbl_job.fk_scheduled_by, audit columns across the schema, and historical
 * tbl_easyfixer assignments. Hard-delete would break joins on five legacy
 * services. Deactivating sets user_status = 0; reactivation flips it back.
 *
 * NO PASSWORD COLUMN — confirmed in CLAUDE.md and the auth service. Auth is
 * OTP-only (email or mobile → 4-digit OTP). This service therefore takes
 * no password input on create/update; that surface doesn't exist.
 */

const INTERNAL_USER_TYPE_ID = 5;
const STATUS_ACTIVE = 1;

/*
 * How long POST /api/admin/users is willing to WAIT for mailbox provisioning
 * before letting it finish in the background.
 *
 * The worst provisioning path is 5 sequential Graph calls (lookup + alias probe
 * + POST /users + GET /subscribedSkus + POST assignLicense), each bounded only
 * by MS_GRAPH_TIMEOUT_MS (default 15000) — ~75 s, comfortably past a 60 s nginx
 * / Azure Container Apps idle timeout. That 504 would tell the operator "Add
 * User failed" for a user that WAS created, and their retry would then hit the
 * duplicate-active-email guard and return 409 — two contradictory answers to one
 * successful create.
 *
 * So the wait is capped well under any proxy timeout. On expiry the provisioning
 * promise is NOT cancelled: it keeps running detached and still records its
 * outcome in tbl_user_entra_provisioning, which is the surface an operator reads
 * (GET /api/admin/users/:userId/provisioning). With the feature flag off — the
 * default — provisionUserMailbox performs zero network calls and this never fires.
 */
const PROVISION_INLINE_DEADLINE_MS = Math.max(
  1000,
  Number(process.env.ENTRA_PROVISION_INLINE_TIMEOUT_MS) || 20000,
);

/*
 * Race a provisioning promise against that deadline and say which won.
 *
 *   → { timedOut: false, value }  it settled in time; `value` is its result
 *   → { timedOut: true }          still running — and STILL RUNNING is the point.
 *                                 The promise is not cancelled: it keeps its temp
 *                                 password in its own closure and still sends the
 *                                 welcome mail when it finishes. That is what
 *                                 lets the licence read-back in
 *                                 services/entra-provisioning.service.js wait
 *                                 ~90s for an eventually-consistent Graph write
 *                                 while the operator's request still returns in
 *                                 ~20s.
 *
 * Shared with POST /api/admin/users/:userId/provision-mailbox so there is ONE
 * copy of the deadline and of this race — the repair path is the one that
 * rescues a mailbox-less user, so it must not be the one that gets a shorter,
 * differently-written wait.
 *
 * `promise` must not reject: every caller attaches its own .catch first, because
 * once the deadline wins this promise is unawaited and an unhandled rejection
 * takes the process down on Node 18+.
 */
async function withProvisionInlineDeadline(promise) {
  // A unique sentinel, so a (hypothetical) null/undefined outcome from the
  // orchestrator can never be mistaken for "the deadline expired".
  const TIMED_OUT = Symbol('provision-inline-deadline');
  let timer = null;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), PROVISION_INLINE_DEADLINE_MS);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  const settled = await Promise.race([
    promise.finally(() => { if (timer) clearTimeout(timer); }),
    deadline,
  ]);
  return settled === TIMED_OUT ? { timedOut: true } : { timedOut: false, value: settled };
}

function mkErr(status, message) { const e = new Error(message); e.status = status; return e; }

// ─── Personal contact (tbl_user_personal_details) ────────────────────
/*
 * PERSONAL EMAIL — the address we can actually reach a new joiner on.
 *
 * WHERE IT LIVES: tbl_user_personal_details, an EasyFix-owned SIDE TABLE keyed
 * by user_id (migrations/2026-08-03-create-tbl-user-personal-details.sql). NOT
 * a column on tbl_user — that table is legacy and shared by five services, and
 * CLAUDE.md forbids altering it. Same pattern as tbl_user_allowed_stages and
 * tbl_user_entra_provisioning.
 *
 * WHY IT EXISTS: the credential mail for a brand-new Microsoft 365 mailbox
 * cannot be sent to that same mailbox — the user cannot read it yet. It goes to
 * a personal address instead.
 *
 * REQUIREDNESS MATRIX (owner's decision — mirrored by the Joi schemas in
 * routes/admin/users.js and by the asterisk on the Add/Edit User form):
 *
 *   Add User                                   → REQUIRED
 *   Edit an ACTIVE user                        → REQUIRED
 *   Edit an INACTIVE user                      → not required
 *   The edit that DEACTIVATES a user           → not required
 *
 * The two exemptions are what keep the change shippable: ~7.5k active users
 * have no personal address today, and offboarding someone who has already left
 * must never require chasing them for one.
 */
const PERSONAL_EMAIL_RE = /^\S+@\S+\.\S+$/;

/*
 * The personal_email COLUMN WIDTH (VARCHAR(255) — see
 * migrations/2026-08-03-create-tbl-user-personal-details.sql), named rather
 * than written twice.
 *
 * It was a bare 255 in both the check and its message until the message-literals
 * audit flagged the message: the number is also the RETIRED value of
 * MAX_CIPHERTEXT_CHARS in lib/field-crypto.js (255 -> 2048), and this file
 * started importing that module in 2026-09-02. The two 255s are unrelated —
 * one is an email column, the other was a ciphertext ceiling — but "unrelated"
 * is not something a text scan can see, and a bare literal that collides with a
 * retired constant will keep costing someone the same investigation. Naming it
 * ends that, and means the check and the sentence can never disagree.
 */
const PERSONAL_EMAIL_MAX_CHARS = 255;

/*
 * THE single definition of the update-side rule, exported so the route layer
 * enforces exactly the same thing rather than a lookalike. Joi alone cannot
 * express it: whether the field is mandatory depends on the TARGET ROW's
 * current status, which is a DB fact, not a payload fact.
 *
 * @param {number|boolean} currentUserStatus  tbl_user.user_status as loaded
 * @param {boolean|undefined} isActiveInPayload  fields.is_active, if supplied
 */
function isPersonalEmailRequiredOnUpdate(currentUserStatus, isActiveInPayload) {
  const deactivating = isActiveInPayload !== undefined && !isActiveInPayload;
  return Number(currentUserStatus) === STATUS_ACTIVE && !deactivating;
}

/*
 * Normalise + validate one personal_email value.
 *   → { ok: true, value: 'a@b.com' | null }
 *   → { ok: false, message }
 * Lowercased for the same reason official_email is: it is a delivery address,
 * every provider treats it case-insensitively, and two casings of one address
 * must not read as two different people.
 */
function normalisePersonalEmail(raw, { required }) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) {
    if (required) return { ok: false, message: 'personal_email is required' };
    return { ok: true, value: null };
  }
  if (value.length > PERSONAL_EMAIL_MAX_CHARS) {
    return { ok: false, message: `personal_email must be ${PERSONAL_EMAIL_MAX_CHARS} characters or fewer` };
  }
  if (!PERSONAL_EMAIL_RE.test(value)) return { ok: false, message: `personal_email "${raw}" is not a valid email address` };
  /*
   * ── It must NOT be one of OUR OWN Microsoft 365 domains. ──────────────
   * The whole point of this address is that it is reachable BEFORE the
   * corporate mailbox is. Two concrete failures the shape check alone lets
   * through, and the Add User form makes easy because the two fields sit side
   * by side:
   *
   *   personal_email == official_email → the credential mail is delivered into
   *     the very mailbox it unlocks, which the joiner cannot open without the
   *     password inside it. Undeliverable by construction.
   *   personal_email == a COLLEAGUE's @easyfix.in address → a working credential
   *     for someone else's brand-new mailbox lands with an uninvolved employee.
   *
   * `entra.managed.domains` is the same list the provisioning service refuses to
   * create accounts outside of, so the two can never disagree about what "ours"
   * means. Personal providers (gmail.com, …) are unaffected.
   */
  if (entraProvisioning.isManagedDomain(value)) {
    return {
      ok: false,
      message: 'personal_email must be a personal (non-company) address — '
        + 'the sign-in details cannot be delivered to an EasyFix mailbox the user cannot open yet',
    };
  }
  return { ok: true, value };
}

/*
 * ── THE HR MASTER-DATA IDENTIFIERS ──────────────────────────────────
 * date_of_joining, uan, pan, aadhaar and address all live on
 * tbl_user_personal_details (2026-09-02 migration) and all five are OPTIONAL
 * everywhere, unlike personal_email: HR fills them in from the master
 * spreadsheet as it is reconciled, so a user row must be creatable and
 * editable without them.
 *
 * BLANK MEANS CLEAR, NOT REJECT. Every normaliser below returns
 * { ok: true, value: null } for an empty input, because the form has to be
 * able to remove a value that was entered by mistake. It is
 * upsertPersonalIdentifiers() that distinguishes "cleared" (null) from
 * "untouched" (key absent) — this layer never sees that difference.
 *
 * pan and aadhaar are ENCRYPTED at rest and the other three are not, for the
 * reasons in the migration header. Nothing here depends on that; the envelope
 * is applied in one place, at the write.
 */

/* A UAN is exactly 12 digits — an EPFO account number, never a range. */
const UAN_RE = /^[0-9]{12}$/;

/*
 * PAN: five letters, four digits, one letter. The regex is the WHOLE
 * validation deliberately — the fourth character encodes the holder type and
 * the last is a checksum letter, but rejecting on those would fail real cards
 * (the checksum algorithm is not published) and teach HR to work around the
 * form.
 */
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

/* Aadhaar: 12 digits that never start with 0 or 1 — a UIDAI allocation rule,
 * and the one cheap check that catches a mistyped or truncated number. */
const AADHAAR_RE = /^[2-9][0-9]{11}$/;

function normaliseUan(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return { ok: true, value: null };
  if (!UAN_RE.test(value)) {
    return { ok: false, message: `uan "${raw}" must be exactly 12 digits` };
  }
  return { ok: true, value };
}

/*
 * Uppercased before validating, not after: a PAN is case-insensitive on every
 * document it appears on, and storing two casings of one number would read as
 * two different people to any future lookup.
 */
function normalisePan(raw) {
  const value = String(raw ?? '').trim().toUpperCase();
  if (!value) return { ok: true, value: null };
  if (!PAN_RE.test(value)) {
    return { ok: false, message: `pan "${raw}" must be 10 characters — five letters, four digits, then a letter (e.g. ABCDE1234F)` };
  }
  return { ok: true, value };
}

/*
 * Separators are STRIPPED, not rejected. Aadhaar is printed in 4-4-4 groups
 * and the HR sheet holds it that way ("7307-8151-9521"), so a form that
 * refused a hyphen would be refusing the exact string the operator is copying
 * from. Twelve digits is the stored form.
 */
function normaliseAadhaar(raw) {
  const value = String(raw ?? '').replace(/[\s-]/g, '').trim();
  if (!value) return { ok: true, value: null };
  if (!AADHAAR_RE.test(value)) {
    return { ok: false, message: `aadhaar "${raw}" must be 12 digits and cannot start with 0 or 1` };
  }
  return { ok: true, value };
}

/*
 * A joining date may legitimately be in the FUTURE — an offer accepted with a
 * start date next month is exactly when HR creates the login — so unlike
 * date_of_birth there is no upper bound beyond a typo guard. The lower bound
 * catches the other common typo, a year typed as 0202 or 1900.
 */
function normaliseDateOfJoining(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return { ok: true, value: null };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return { ok: false, message: 'date_of_joining must be a date in YYYY-MM-DD format' };
  }
  /* Round-trip through Date to reject 2026-02-31, which the regex accepts. */
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
    return { ok: false, message: `date_of_joining "${raw}" is not a real calendar date` };
  }
  const year = Number(value.slice(0, 4));
  if (year < 1950) {
    return { ok: false, message: 'date_of_joining cannot be before 1950' };
  }
  return { ok: true, value };
}

/*
 * The employee's PERSONAL address — deliberately free text, and deliberately
 * NOT tbl_user's pin_code/city/state/district, which describe where they are
 * POSTED and drive scoping. Newlines are collapsed so a pasted three-line
 * address stores as one value the CRM can render in a table cell.
 */
/*
 * DATE OF BIRTH — the admin-side wrapper around the EXISTING rule.
 *
 * The real validation (YYYY-MM-DD, a real calendar date, not in the future, at
 * least MIN_AGE and at most MAX_AGE years ago, all against IST "today") lives
 * in profile-self.service.js and is reused here rather than restated. Two
 * copies of an age range is how the employee-facing form and the HR form start
 * disagreeing about whose birthday is valid.
 *
 * The only adaptation is the SHAPE: validateDateOfBirth throws a 400-carrying
 * error, and everything in this collector returns { ok, value | message }.
 *
 * ── WHY HR CAN OVERWRITE A "LOCKED" DOB ──────────────────────────────
 * On the employee's own profile a date of birth can be set exactly ONCE and is
 * then locked, because a birth date that changes is either a typo or a fraud.
 * That lock is not bypassed here — it is RESOLVED here. The lock's escape hatch
 * has always been "a correction needs HR approval", and this form IS HR. An
 * admin write is the approval, arriving through a different door.
 *
 * The lazy require keeps the two modules acyclic even if profile-self ever
 * grows a dependency on this one.
 */
function normaliseDateOfBirth(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return { ok: true, value: null };
  try {
    // eslint-disable-next-line global-require
    const { validateDateOfBirth } = require('./profile-self.service');
    return { ok: true, value: validateDateOfBirth(value) };
  } catch (e) {
    return { ok: false, message: (e && e.message) || 'date_of_birth is not valid' };
  }
}

function normaliseAddress(raw) {
  const value = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!value) return { ok: true, value: null };
  if (value.length > 512) {
    return { ok: false, message: 'address must be 512 characters or fewer' };
  }
  return { ok: true, value };
}

/*
 * The ONE place the five normalisers are applied, shared by createUser and
 * updateUser so the two paths cannot drift into different validation.
 *
 * `undefined` means UNTOUCHED and is skipped entirely — that is what makes the
 * omit/clear distinction reach upsertPersonalIdentifiers intact. An empty
 * string is NOT undefined: it normalises to null and clears the column, which
 * is how the form removes a value entered by mistake.
 *
 *   → { ok: true,  values: { …only the supplied keys… } }
 *   → { ok: false, message }
 */
const HR_IDENTIFIER_NORMALISERS = Object.freeze({
  date_of_birth:   normaliseDateOfBirth,
  date_of_joining: normaliseDateOfJoining,
  uan:             normaliseUan,
  pan:             normalisePan,
  aadhaar:         normaliseAadhaar,
  address:         normaliseAddress,
});

/*
 * Operator-facing names for the six, so a 400 says "PAN is required" rather
 * than "pan is required" — the form's label is what the reader is looking at.
 */
const HR_IDENTIFIER_LABELS = Object.freeze({
  date_of_birth:   'Date Of Birth',
  date_of_joining: 'Date Of Joining',
  uan:             'UAN',
  pan:             'PAN',
  aadhaar:         'Aadhaar',
  address:         'Address',
});

/*
 * Which of the six would be EMPTY once this payload is applied — the check
 * behind "personal details are mandatory".
 *
 * ── IT IS A MERGE, NOT A PAYLOAD CHECK, AND THAT IS THE WHOLE POINT ──
 * pan and aadhaar are never sent back to the browser except masked, so the Edit
 * form CANNOT prefill them. If "required" meant "the payload must carry a
 * value", every edit of a user who already has a PAN would force the operator
 * to re-type it off a paper form — and the most likely outcome of that is a
 * typo overwriting a correct number. So a field is satisfied when a value
 * EXISTS AFTER the save: supplied now, or already stored.
 *
 * `stored` is what loadPersonalIdentifiers returns (pan/aadhaar are represented
 * by their *_last4, which is present exactly when a value is stored). Pass {}
 * on create, where nothing is stored yet and all six must be supplied.
 *
 * An explicitly CLEARED field (null, from the form's Remove control) counts as
 * missing — clearing a mandatory field is the same as never setting it.
 */
function missingHrIdentifiers(supplied, stored = {}) {
  const storedHas = {
    date_of_birth:   Boolean(stored.date_of_birth),
    date_of_joining: Boolean(stored.date_of_joining),
    uan:             Boolean(stored.uan),
    address:         Boolean(stored.address),
    pan:             Boolean(stored.pan_last4),
    aadhaar:         Boolean(stored.aadhaar_last4),
  };
  return Object.keys(HR_IDENTIFIER_LABELS).filter((key) => {
    const suppliedValue = supplied[key];
    if (suppliedValue === undefined) return !storedHas[key];  // untouched
    return !suppliedValue;                                    // '' or null = cleared
  });
}

function collectHrIdentifiers(payload) {
  const values = {};
  for (const [key, normalise] of Object.entries(HR_IDENTIFIER_NORMALISERS)) {
    if (!payload || payload[key] === undefined) continue;
    const parsed = normalise(payload[key]);
    if (!parsed.ok) return { ok: false, message: parsed.message };
    values[key] = parsed.value;
  }
  return { ok: true, values };
}

/*
 * MySQL "table does not exist" — tbl_user_personal_details ships as a PENDING
 * migration, so there is a real window in which this code is live and the table
 * is not. See loadPersonalEmail() / upsertPersonalEmail() for the two different
 * answers we give on the read and the write side.
 */
function isMissingContactTable(err) {
  return Boolean(err) && (err.code === 'ER_NO_SUCH_TABLE' || err.errno === 1146);
}

/*
 * TWO migrations sit behind this table, and a blank column can mean either.
 * 2026-08-03 creates it (absent table ⇒ ER_NO_SUCH_TABLE / 1146); 2026-09-01
 * adds profile_image_key by a separate, deliberately NON-idempotent ALTER, so a
 * host can have the table and not the column (ER_BAD_FIELD_ERROR / 1054). The
 * catch below swallows both — this hint names both so the next person debugging
 * an empty avatar column is not sent to the wrong file.
 */
const MIGRATION_HINT = 'have migrations/2026-08-03-create-tbl-user-personal-details.sql '
  + 'and migrations/2026-09-01-hrms-05-profile-photo.sql been applied?';

/*
 * READ side — FAIL-SOFT, exactly like entra-provisioning's getProvisioning().
 *
 * A host that has not yet applied the migration must lose ONE COLUMN, not the
 * whole Manage Users surface: getUserById feeds the list, the detail view, every
 * PATCH, the provision-mailbox repair endpoint and both bulk paths, so letting
 * ER_NO_SUCH_TABLE escape from here would 500 all of them at once.
 *
 * Batched (one `IN (…)` for the page), not a per-row lookup — the reason the
 * original LEFT JOIN existed. It is a separate statement rather than a join so
 * the failure is containable: a join that throws takes the users query with it.
 *
 * Returns Map<user_id, { personal_email, profile_image_key }>. The avatar rides
 * along on the SAME statement because it lives on the SAME row — adding it cost
 * one column in the projection and zero extra queries. The name stays
 * loadPersonalEmails because it is an exported symbol pinned by
 * tests/user-personal-email.test.js; renaming it is churn, not clarity.
 */
async function loadPersonalEmails(userIds) {
  const ids = [...new Set((userIds || []).map(Number).filter(Boolean))];
  const out = new Map();
  if (!ids.length) return out;
  try {
    const [rows] = await pool.query(
      `SELECT user_id, personal_email, profile_image_key FROM tbl_user_personal_details
        WHERE user_id IN (${ids.map(() => '?').join(',')})`,
      ids
    );
    for (const r of rows) {
      out.set(Number(r.user_id), {
        personal_email:    r.personal_email || null,
        // NULL is the ONLY spelling of "no photo" (see the 2026-09-01 migration).
        profile_image_key: r.profile_image_key || null,
      });
    }
  } catch (e) {
    logger.warn('Could not read personal contacts · userIds=' + ids.length + ' · ' + (e.code || e.message)
      + (isMissingContactTable(e) ? ' — ' + MIGRATION_HINT : ''));
  }
  return out;
}

/** Single-user variant, same fail-soft contract → null when unreadable. */
async function loadPersonalEmail(userId) {
  try {
    const [[row]] = await pool.query(
      'SELECT personal_email FROM tbl_user_personal_details WHERE user_id = ? LIMIT 1',
      [Number(userId)]
    );
    return (row && row.personal_email) || null;
  } catch (e) {
    logger.warn('Could not read personal contact · userId=' + userId + ' · ' + (e.code || e.message)
      + (isMissingContactTable(e) ? ' — ' + MIGRATION_HINT : ''));
    return null;
  }
}

/*
 * WRITE side — idempotent upsert of the one row per CRM user. DATETIME columns
 * are bound as `new Date()` so the pool's +05:30 session timezone stores the IST
 * wall clock verbatim — never SQL NOW(), which would be the server's UTC clock.
 *
 * Takes a `runner` (pool OR a transaction connection) so createUser can write
 * it inside the SAME transaction as the tbl_user INSERT: personal_email is
 * MANDATORY on create, so a user row that exists without one would be a row
 * that violates the rule the moment it is committed.
 *
 * NOT fail-soft, unlike the read side above, and the asymmetry is deliberate:
 * personal_email is a MANDATORY value the operator just typed. Swallowing the
 * write would accept it, report success and silently discard it — the worst of
 * the three outcomes. Instead a missing table is re-thrown as a 503 that names
 * the migration, so the operator gets an actionable message rather than an
 * opaque 500 and no data is lost.
 */
async function upsertPersonalEmail(userId, personalEmail, runner = pool) {
  const now = new Date();
  try {
    await runner.query(
      `INSERT INTO tbl_user_personal_details (user_id, personal_email, created_on, updated_on)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         personal_email = VALUES(personal_email),
         updated_on     = VALUES(updated_on)`,
      [Number(userId), personalEmail || null, now, now]
    );
  } catch (e) {
    if (!isMissingContactTable(e)) throw e;
    logger.warn('Personal contact write failed · userId=' + userId + ' · ' + e.code + ' — ' + MIGRATION_HINT);
    throw mkErr(503, 'Personal email storage is unavailable on this host — apply '
      + 'migrations/2026-08-03-create-tbl-user-personal-details.sql, then retry');
  }
}

/*
 * WRITE side for the five HR identifiers — a SEPARATE upsert from
 * upsertPersonalEmail, and the separation is deliberate twice over.
 *
 * 1. ONLY THE SUPPLIED KEYS ARE WRITTEN. personal_email is always present on
 *    the paths that write it, so its upsert can name the column
 *    unconditionally. These are not: an Edit User submit that never touched
 *    the PAN field must leave the stored PAN alone, and a
 *    `pan = VALUES(pan)` with an absent value would blank it. So the column
 *    list is built from the keys actually present in `fields` — pass
 *    { pan: null } to CLEAR it, omit `pan` to LEAVE it.
 *
 *    COALESCE(?, pan) would NOT do this job. It guards NULL only, so the
 *    empty string an operator types to clear a field still overwrites — the
 *    opposite of the intended protection on the one input that needs it.
 *
 * 2. pan and aadhaar are ENCRYPTED here and their last4 derived here, from
 *    the plaintext, in one place. Deriving last4 later would mean decrypting
 *    on every list render; deriving it at a second call site would mean two
 *    definitions of what "last4" means.
 *
 * Returns without touching the database when `fields` names none of the
 * columns — the common case on an Edit submit, and one round trip saved.
 */
const ENCRYPTED_IDENTIFIERS = Object.freeze({ pan: 'pan_last4', aadhaar: 'aadhaar_last4' });
const CLEAR_IDENTIFIERS = Object.freeze(['date_of_birth', 'date_of_joining', 'uan', 'address']);

async function upsertPersonalIdentifiers(userId, fields, runner = pool) {
  const cols = [];
  const vals = [];

  for (const key of CLEAR_IDENTIFIERS) {
    if (key in fields) {
      cols.push(key);
      vals.push(fields[key] || null);
    }
  }
  for (const [key, last4Col] of Object.entries(ENCRYPTED_IDENTIFIERS)) {
    if (key in fields) {
      const plain = fields[key] || null;
      cols.push(key, last4Col);
      vals.push(plain ? fieldCrypto.encryptField(plain) : null,
                plain ? String(plain).slice(-4) : null);
    }
  }
  if (!cols.length) return;

  const now = new Date();
  const assignments = cols.map((c) => `${c} = VALUES(${c})`).join(',\n         ');
  try {
    await runner.query(
      `INSERT INTO tbl_user_personal_details (user_id, ${cols.join(', ')}, created_on, updated_on)
       VALUES (?, ${cols.map(() => '?').join(', ')}, ?, ?)
       ON DUPLICATE KEY UPDATE
         ${assignments},
         updated_on = VALUES(updated_on)`,
      [Number(userId), ...vals, now, now]
    );
  } catch (e) {
    if (!isMissingContactTable(e) && !isMissingIdentifierColumn(e)) throw e;
    logger.warn('Personal identifier write failed · userId=' + userId + ' · ' + e.code + ' — ' + IDENTIFIER_MIGRATION_HINT);
    // Through the constant, not a second copy of the path — the log line right
    // above already proved how easily the two drift.
    throw mkErr(503, 'HR identifier storage is unavailable on this host — '
      + IDENTIFIER_MIGRATION_HINT + ', then retry');
  }
}

/*
 * MySQL "unknown column". The identifier columns ship as a PENDING migration,
 * exactly like the table itself did, so there is a real window in which this
 * code is live and the columns are not — and on that host the error is 1054,
 * not the 1146 isMissingContactTable() catches.
 */
function isMissingIdentifierColumn(err) {
  return Boolean(err) && (err.code === 'ER_BAD_FIELD_ERROR' || err.errno === 1054);
}

/* No directory in the hint on purpose: an applied migration moves from
   migrations/ to migrations/executed/, and this one already has — an operator
   told to look in migrations/ finds nothing and reads the hint as stale. */
const IDENTIFIER_MIGRATION_HINT =
  'apply the 2026-09-02-add-hr-identifiers-user-personal-details.sql migration';

/*
 * READ side — FAIL-SOFT, matching loadPersonalEmail() rather than the write
 * path above. A missing table, a missing column or an unreadable row must cost
 * the Edit User form five optional fields, never the whole user record.
 *
 * Returns the two protected identifiers MASKED, from their clear last4
 * columns — never the ciphertext and never the plaintext. This feeds an admin
 * form, and a full PAN or Aadhaar that ships on every user load is one sitting
 * in the browser cache, the devtools network tab and any error reporter that
 * captures responses. HR types a replacement to change one; there is no read
 * path back to the plaintext short of the audited break-glass tooling.
 */
async function loadPersonalIdentifiers(userId, runner = pool) {
  const empty = {
    date_of_birth: null, date_of_joining: null, uan: null, address: null,
    pan_last4: null, pan_masked: null, aadhaar_last4: null, aadhaar_masked: null,
  };
  try {
    const [[row]] = await runner.query(
      `SELECT date_of_birth, date_of_joining, uan, address, pan_last4, aadhaar_last4
         FROM tbl_user_personal_details WHERE user_id = ? LIMIT 1`,
      [Number(userId)]
    );
    if (!row) return empty;
    return {
      /* DATE columns → 'YYYY-MM-DD'. Sliced from the string rather than passed
         through Date, which would shift the day across a timezone. */
      date_of_birth:   row.date_of_birth ? String(row.date_of_birth).slice(0, 10) : null,
      date_of_joining: row.date_of_joining ? String(row.date_of_joining).slice(0, 10) : null,
      uan:             row.uan || null,
      address:         row.address || null,
      pan_last4:       row.pan_last4 || null,
      pan_masked:      row.pan_last4 ? `XXXXXX${row.pan_last4}` : null,
      aadhaar_last4:   row.aadhaar_last4 || null,
      aadhaar_masked:  row.aadhaar_last4 ? `XXXX XXXX ${row.aadhaar_last4}` : null,
    };
  } catch (e) {
    if (!isMissingContactTable(e) && !isMissingIdentifierColumn(e)) throw e;
    logger.warn('Personal identifier read skipped · userId=' + userId + ' · ' + e.code + ' — ' + IDENTIFIER_MIGRATION_HINT);
    return empty;
  }
}

/*
 * Sortable-column whitelist. Same SQL-injection guardrail as cities — only
 * keys in this map can land in ORDER BY. Computed/joined columns (role_name,
 * city_name) work because MySQL resolves SELECT aliases inside ORDER BY.
 */
const SORTABLE_COLUMNS = Object.freeze({
  user_id:        'u.user_id',
  /*
   * Employee code. Already on the list projection; sortable since the CRM's
   * Manage Users table started rendering it as a column, because a column
   * people scan down is a column they will try to sort.
   *
   * routes/admin/users.js:113 derives its Joi whitelist from these keys
   * (`Joi.string().valid(...Object.keys(userService.SORTABLE_COLUMNS))`), so
   * this one edit reaches the validator too — the two lists cannot drift.
   *
   * Sorts as TEXT, which is what the format wants: codes are E-prefixed and
   * zero-padded (see lib/emp-code.js), so lexical order IS numeric order.
   * NULL is a real state here — users created before the code existed have
   * none — and MySQL sorts NULLs first ascending, which puts "no code yet" at
   * the top of an ascending sort. That is the useful end to find them.
   */
  user_code:      'u.user_code',
  user_name:      'u.user_name',
  official_email: 'u.official_email',
  mobile_no:      'u.mobile_no',
  role_name:      'r.role_name',
  city_name:      'c.city_name',
  user_status:    'u.user_status',
  insert_date:    'u.insert_date',
});

const MUTABLE_COLUMNS = Object.freeze([
  // user_name / official_email NOT included — legacy CRM treats them as
  // read-only post-create (addEditUser.vm has them as RO fields). They feed
  // OTP delivery; changing them mid-flight can lock a user out of their
  // own account. If renaming becomes a real ops need, add a dedicated
  // "transfer ownership" flow rather than a plain UPDATE.
  'mobile_no', 'alternate_no', 'user_role', 'city_id',
  /*
   * Employee code — operator-supplied and EDITABLE, unlike user_name and
   * official_email above. The Add/Edit User form prefills it from
   * GET /api/admin/users/next-emp-code and lets the operator change the count,
   * so a typo has to be correctable after the fact. Uniqueness is probed in the
   * loop below (see the user_code branch) because tbl_user has no UNIQUE index
   * on it and adding one is forbidden.
   */
  'user_code',
  // Scope CSVs — drive row-level RBAC. Each accepts the legacy
  // wildcard "0" meaning "all". See lib/scope.js for the parser.
  'manage_clients', 'manage_cities', 'manage_states', 'manage_verticals',
  // Reporting manager — single user_id. Drives hierarchy DFS for
  // scope-union (see findDescendantUserIds + buildHierarchyTree).
  'reporting_manager',
]);

// ─── Job Stage Access (tbl_user_allowed_stages) ──────────────────────
/*
 * loadAllowedStages(userId) → { mode, stages }
 * Reads the user's stage grants and folds them into the permission object
 * (see lib/job-stages.js). NO rows → { mode:'all', stages:[] } (unrestricted);
 * the lone NO_ACCESS_KEY sentinel row → { mode:'list', stages:[] } (no access).
 */
async function loadAllowedStages(userId) {
  const [rows] = await pool.query(
    'SELECT stage_key FROM tbl_user_allowed_stages WHERE user_id = ?',
    [userId]
  );
  return parseAllowedRows(rows);
}

/*
 * loadAllowedStagesForUsers(userIds) → Map<user_id, { mode, stages }>
 * BATCHED counterpart of loadAllowedStages — ONE query for a whole page of
 * users instead of N point-lookups. Used by listUsers so the Manage Users table
 * can show each user's stage grant. Every requested id is present in the map
 * (users with no rows resolve to { mode:'all' }), so callers never branch on
 * "missing vs unrestricted".
 */
async function loadAllowedStagesForUsers(userIds) {
  const ids = [...new Set((userIds || []).map(Number).filter(Number.isInteger))];
  const out = new Map();
  if (ids.length === 0) return out;
  const [rows] = await pool.query(
    `SELECT user_id, stage_key FROM tbl_user_allowed_stages
      WHERE user_id IN (${ids.map(() => '?').join(',')})`,
    ids
  );
  const byUser = new Map();
  for (const r of rows) {
    const uid = Number(r.user_id);
    if (!byUser.has(uid)) byUser.set(uid, []);
    byUser.get(uid).push(r.stage_key);
  }
  for (const id of ids) out.set(id, parseAllowedRows(byUser.get(id) || []));
  return out;
}

/*
 * reconcileAllowedStages(userId, stages, actorId)
 * Replaces the user's stage grants with the `stages` payload value.
 * DELETE-then-bulk-INSERT in ONE transaction so the swap is atomic.
 *
 *   null (or absent value) → zero rows                → UNRESTRICTED
 *   []                     → ONE NO_ACCESS_KEY row    → NO ACCESS
 *   ['unconfirmed', …]     → one row per stage_key    → restricted
 *
 * The sentinel row is what makes "grant nothing" survive a round-trip: without
 * it an empty pick would write zero rows and read back as unrestricted (the
 * zero-rows default that keeps never-configured users out of a lockout).
 * Unknown/duplicate keys are dropped by parseAllowedInput before the write.
 */
async function reconcileAllowedStages(userId, stages, actorId) {
  const parsed = parseAllowedInput(stages);
  // mode 'all' → nothing to store. mode 'list' with no stages → the sentinel.
  const clean = parsed.mode === 'all'
    ? []
    : (parsed.stages.length ? parsed.stages : [NO_ACCESS_KEY]);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM tbl_user_allowed_stages WHERE user_id = ?', [userId]);
    if (clean.length) {
      const placeholders = clean.map(() => '(?, ?, ?)').join(', ');
      const params = [];
      for (const k of clean) params.push(userId, k, actorId || null);
      await conn.query(
        `INSERT INTO tbl_user_allowed_stages (user_id, stage_key, created_by) VALUES ${placeholders}`,
        params
      );
    }
    await conn.commit();
    const shape = parsed.mode === 'all'
      ? '(unrestricted)'
      : (parsed.stages.length ? parsed.stages.join(',') : '(no access)');
    logger.info('Reconciled allowed stages · userId=' + userId + ' · stages=' + shape);
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

// ─── List ────────────────────────────────────────────────────────────
async function listUsers({
  q, roleId, cityId, includeInactive = false,
  limit = 200, offset = 0,
  sortBy = 'user_name', sortDir = 'asc',
  /*
   * Attach personal_email to each row? OFF BY DEFAULT, and the route turns it on
   * only for the canonical Admin role.
   *
   * /api/admin/* is guarded by role(['admin']), which is a GROUP of ten role_ids
   * (Executive Supply, Business Development, Finance, Zonal Field Team, Project
   * Manager, …). Only roleByName(['Admin']) may create or edit a user, so only
   * Admin can act on a missing personal address — but every one of the ten could
   * previously call GET /api/admin/users?limit=1000&includeInactive=true and page
   * out the HOME email address of all ~7.5k staff. maskMobile does not touch
   * email keys, so the rows shipped verbatim.
   *
   * The edit form still gets the value from getUserById, so nothing in the
   * feature depends on the list projection; this only removes the bulk-harvest
   * surface. A caller without the flag sees the field absent — the FE renders
   * its "—" placeholder, which is exactly what it already does for a user who
   * has no address on record.
   */
  includePersonalEmail = false,
} = {}) {
  limit  = Math.min(Math.max(Number(limit)  || 200, 1), 1000);
  offset = Math.max(Number(offset) || 0, 0);

  logger.info('List users · q=' + (q || '') + ' · roleId=' + (roleId || '') + ' · cityId=' + (cityId || '') + ' · includeInactive=' + includeInactive + ' · limit=' + limit + ' · offset=' + offset);

  const sortExpr = SORTABLE_COLUMNS[sortBy] || SORTABLE_COLUMNS.user_name;
  const dir      = String(sortDir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  // Stable secondary sort on user_id — guarantees deterministic pagination
  // when the primary key has duplicates (very common on role_name).
  const orderBy  = `${sortExpr} ${dir}, u.user_id ASC`;

  const where  = [`u.user_type_id = ${INTERNAL_USER_TYPE_ID}`];
  const params = [];
  if (!includeInactive) where.push('u.user_status = 1');
  else where.push('NOT (u.user_status <=> 3)'); // never surface admin-deleted (tombstoned) users — NULL-safe
  if (q) {
    where.push('(u.user_name LIKE ? OR u.official_email LIKE ? OR u.mobile_no LIKE ? OR u.user_code LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (roleId) { where.push('u.user_role = ?'); params.push(Number(roleId)); }
  if (cityId) { where.push('u.city_id = ?');   params.push(Number(cityId)); }

  /*
   * personal_email is NOT joined here. It is fetched separately, batched, and
   * only when the caller asked for it (see includePersonalEmail above) — the
   * side table ships as a PENDING migration, and a LEFT JOIN onto a table that
   * does not exist yet rejects the WHOLE query, taking Manage Users down rather
   * than blanking one column.
   */
  const [rows] = await pool.query(
    `SELECT
        u.user_id, u.user_code, u.user_name, u.official_email, u.mobile_no,
        u.alternate_no, u.user_role, r.role_name,
        u.city_id, c.city_name,
        u.manage_clients, u.manage_cities, u.manage_states, u.manage_verticals,
        u.reporting_manager,
        u.user_status, u.insert_date, u.update_date
       FROM tbl_user  u
       LEFT JOIN tbl_role r ON r.role_id = u.user_role
       LEFT JOIN tbl_city c ON c.city_id = u.city_id
      WHERE ${where.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM tbl_user u WHERE ${where.join(' AND ')}`,
    params
  );

  /*
   * Job Stage Access for the list column. ONE batched query for the page (not
   * a per-row lookup). Same tri-state as getUserById: null = unrestricted,
   * [] = explicit no access, non-empty = restricted — the distinction matters
   * on screen, since "no access" now genuinely blanks every job page for that
   * user and an admin needs to spot it without opening each row.
   */
  const stagePerms = await loadAllowedStagesForUsers(rows.map((r) => r.user_id));
  for (const r of rows) {
    const p = stagePerms.get(Number(r.user_id));
    r.allowed_stages = (!p || p.mode === 'all') ? null : p.stages;
  }

  /*
   * Personal-details side table — ONE batched read for the page, same shape as
   * the stage permissions above, and fail-soft on a pre-migration host: the
   * columns read blank, the screen still loads.
   *
   * It runs UNCONDITIONALLY now, not only for includePersonalEmail. The avatar
   * is not PII the way a home email address is — it is the same face the ten
   * admin-group roles already see on every job row — so it ships to all of
   * them, and only the email field stays behind the flag. The price is one
   * PK-batched statement per page for the nine non-Admin roles that previously
   * skipped it.
   *
   * photo_url, not profile_image_key: nothing on the FE can do anything with a
   * raw key, and the key is deliberately unguessable-per-upload. The field name
   * matches /auth/me and the profile-details payload so the CRM has ONE avatar
   * contract, in which null means "render the initials monogram" — never a
   * placeholder image URL, so that a broken <img> and "no photo set" stay
   * distinguishable.
   *
   * TTL — the URL is signed for USER_PHOTO_PRESIGN_TTL_SEC (1 hour by default),
   * NOT the shared 5-minute S3_PRESIGN_TTL_SEC. Manage Users holds its rows in
   * React state and only refetches on a filter/sort/page change or a mutation,
   * so a URL minted at load is still on screen minutes later; at 5 minutes an
   * operator reading the grid for six gets a wall of 403 "Request has expired"
   * avatars. That exact failure was measured on notice images in production on
   * 2026-08-14, which is why S3_NOTICE_PRESIGN_TTL_SEC exists — this is the
   * same payload shape and gets the same treatment. The shared default is NOT
   * raised: it is read by call sites carrying client documents and job
   * supporting files, where the short window is a deliberate posture. A
   * presigned URL is unauthenticated and shareable for its whole lifetime, so
   * the longer window is only justified because an avatar is at the
   * low-sensitivity end of that scale.
   *
   * RESIDUAL, accepted: a tab left open past the hour with no refetch still
   * expires. Fixing it properly means re-minting at render time instead of
   * embedding URLs in a list payload, and the degraded state here is a monogram
   * rather than an error — not worth it for an avatar column.
   */
  const details = await loadPersonalEmails(rows.map((r) => r.user_id));
  for (const r of rows) {
    const d = details.get(Number(r.user_id));
    if (includePersonalEmail) r.personal_email = (d && d.personal_email) || null;
    /*
     * Fail-soft twice over. isEnabled() first: getPresignedUrl THROWS on a host
     * with no S3_BUCKET_NAME, which is a supported local-dev configuration, and
     * an unthrown throw here would 500 an operator's core screen over a missing
     * avatar. Then .catch(() => null) for a transient signer failure. Most rows
     * have no key at all and cost nothing — no presign, no S3 call.
     */
    r.photo_url = (d && d.profile_image_key && s3.isEnabled())
      ? await s3.getPresignedUrl(d.profile_image_key, USER_PHOTO_PRESIGN_TTL_SEC).catch(() => null)
      : null;
  }

  logger.info('Found ' + rows.length + ' users (total=' + total + ')');
  return { items: rows, total };
}

async function getUserById(userId, { includeIdentifiers = false } = {}) {
  logger.info('Get user by id · userId=' + userId);
  const [[row]] = await pool.query(
    `SELECT u.user_id, u.user_code, u.user_name, u.official_email, u.mobile_no,
            u.alternate_no, u.user_role, r.role_name,
            u.city_id, c.city_name,
            u.manage_clients, u.manage_cities, u.manage_states, u.manage_verticals,
        u.reporting_manager,
            u.user_status, u.insert_date, u.update_date, u.updated_by
       FROM tbl_user  u
       LEFT JOIN tbl_role r ON r.role_id = u.user_role
       LEFT JOIN tbl_city c ON c.city_id = u.city_id
      WHERE u.user_id = ? AND u.user_type_id = ?
      LIMIT 1`,
    [userId, INTERNAL_USER_TYPE_ID]
  );
  if (!row) return null;
  /*
   * personal_email — a separate FAIL-SOFT read rather than a LEFT JOIN. Every
   * write path routes through here (PATCH, the provision-mailbox repair
   * endpoint, both bulk paths), so a join onto the still-pending side table
   * would 500 all of them on a host that has not applied the migration. Absent
   * table ⇒ null, and the edit form shows an empty field.
   */
  row.personal_email = await loadPersonalEmail(userId);
  /*
   * The five HR identifiers, same fail-soft contract, and OFF BY DEFAULT.
   *
   * This route is open to the whole `admin` GROUP, but only the Admin ROLE can
   * edit a user (roleByName(['Admin']) on PATCH) — so only the Admin role has
   * any use for them. The list endpoint already draws that exact line for
   * personal_email via includePersonalEmail: isAdminRole(req); this follows it
   * rather than inventing a second, looser rule for five fields that are
   * strictly more sensitive than an email address.
   *
   * pan and aadhaar arrive MASKED (see loadPersonalIdentifiers) even here.
   */
  if (includeIdentifiers) Object.assign(row, await loadPersonalIdentifiers(userId));
  /*
   * Job Stage Access. NULL = unrestricted; [] = explicit NO ACCESS; a non-empty
   * array = restricted to those stage_keys. The null-vs-[] distinction is
   * load-bearing — the FE edit form seeds its "All stages" toggle from it, and
   * flattening both to [] is what made a saved empty pick read back as All.
   */
  const stagePerm = await loadAllowedStages(userId);
  row.allowed_stages = stagePerm.mode === 'all' ? null : stagePerm.stages;
  return row;
}

/*
 * GET /api/admin/users/next-emp-code — the value the Add User form prefills.
 *
 * A SUGGESTION, NOT A RESERVATION, and the distinction is the whole reason the
 * create path still locks and still probes. Nothing is held here: two admins
 * who open the form at the same moment both get the same count, and whoever
 * saves second is told the code is taken and picks another. Reserving instead
 * would mean allocating a code to a form that is very often abandoned, leaving
 * permanent holes in a sequence people read as a headcount.
 *
 * Reads on the POOL, not a pinned connection — correct precisely because it
 * guarantees nothing about the future.
 */
async function suggestNextEmpCode() {
  const code = await nextEmpCode(pool);
  // parseEmpCode, not a second slice/parseInt — the parse has ONE home.
  return { count: parseEmpCode(code), code };
}

// ─── Create ──────────────────────────────────────────────────────────
/*
 * Uniqueness rules — enforced in app code, not in DB. tbl_user has no
 * unique key on email or mobile (legacy has duplicates), so we do a
 * "no active duplicate" pre-check before INSERT. Inactive duplicates are
 * tolerated — they represent ex-staff whose row we soft-deleted but kept
 * for audit FKs. If a new joiner has the same email/mobile as an inactive
 * row, the operator should reactivate that row instead.
 */
async function createUser({
  user_name, official_email, mobile_no, user_role,
  city_id, alternate_no,
  /*
   * MANDATORY, and OPERATOR-SUPPLIED — not generated here. The form prefills it
   * from GET /api/admin/users/next-emp-code (a suggestion, which reserves
   * nothing) and the operator may edit the count before saving, so two admins
   * who open Add User at the same moment are genuinely handed the same value.
   * The duplicate check inside the transaction below is the only thing between
   * that and two users sharing a code.
   */
  user_code,
  manage_clients, manage_cities, manage_states, manage_verticals,
  reporting_manager,
  allowed_stages,
  /*
   * MANDATORY on this path (see the requiredness matrix above). It is where the
   * "your EasyFix account is ready" credential mail goes — the new corporate
   * mailbox cannot be its own delivery address.
   */
  personal_email,
  /*
   * The HR master-data identifiers — ALL OPTIONAL on this path. Omitting one
   * leaves the column unset; passing '' explicitly stores nothing. They are
   * validated by collectHrIdentifiers below, the same call updateUser makes.
   */
  date_of_birth, date_of_joining, uan, pan, aadhaar, address,
  /*
   * OPT-IN, defaulting to FALSE. The single-user Add User route passes true;
   * every other caller (bulk update, bulk upload, any future importer) keeps
   * the old behaviour. Defaulting to true would turn "set a role for 200 users"
   * into "supply six identifiers for 200 users" and break those flows the day
   * this shipped — the mandate is a rule about the FORM, not about the table.
   */
  enforceHrIdentifiers = false,
  createdBy,
  /*
   * Is the ACTING operator allowed to trigger a Microsoft 365 directory write?
   * Resolved by the route from the same `access.entraprovision.emails` allowlist
   * that guards POST /api/admin/users/:userId/provision-mailbox. Defaults FALSE:
   * a future caller that forgets to pass it gets no directory write rather than a
   * silent, ungated licence-seat spend.
   */
}) {
  logger.info('Create user · role=' + (user_role || '') + ' · cityId=' + (city_id || ''));
  const name  = String(user_name || '').trim();
  const email = String(official_email || '').trim().toLowerCase();
  const mob   = String(mobile_no || '').trim();
  if (!name)  throw mkErr(400, 'user_name is required');
  if (!email) throw mkErr(400, 'official_email is required');
  /*
   * NO mobile_no guard — it became OPTIONAL on 2026-08-03 (tbl_user.mobile_no is
   * nullable and active users already exist without one).
   *
   * This service-level check is why loosening the route's Joi schema alone did
   * NOT work: the request passed validation and then died here with the same
   * wording, so the API still answered "mobile_no is required" while the form
   * showed the field as optional. A field's requiredness lives in BOTH places —
   * change one and the other silently wins.
   */
  if (!user_role) throw mkErr(400, 'user_role is required');

  /*
   * Employee code FORMAT — enforced here as well as in the route's Joi, for the
   * same reason personal_email is: requiredness and shape live in two layers in
   * this codebase and the DEEPER one silently wins. Case-SENSITIVE on purpose;
   * nothing normalises 'e000123' up to 'E000123', because a stored lowercase
   * code would be invisible to parseEmpCode() and to every list filter that
   * uses it. Reject it and let the operator retype.
   */
  const empCode = String(user_code || '').trim();
  if (!empCode) throw mkErr(400, 'user_code is required');
  if (!EMP_CODE_RE.test(empCode)) {
    throw mkErr(400, `user_code ${EMP_CODE_FORMAT_HINT} — got "${empCode}"`);
  }

  /*
   * personal_email — REQUIRED here, and requiring it in the route's Joi schema
   * is NOT enough on its own: this service is the deeper layer and, per the
   * mobile_no lesson quoted just above, whichever layer is stricter is the one
   * that actually decides. Both enforce it, both are tested.
   */
  const personalEmail = normalisePersonalEmail(personal_email, { required: true });
  if (!personalEmail.ok) throw mkErr(400, personalEmail.message);

  const identifiers = collectHrIdentifiers({ date_of_birth, date_of_joining, uan, pan, aadhaar, address });
  if (!identifiers.ok) throw mkErr(400, identifiers.message);
  const hrIdentifiers = identifiers.values;

  if (enforceHrIdentifiers) {
    /* Nothing is stored yet, so every one of the six must arrive in the payload. */
    const missing = missingHrIdentifiers(hrIdentifiers, {});
    if (missing.length) {
      const names = missing.map((k) => HR_IDENTIFIER_LABELS[k]).join(', ');
      logger.warn('Create user rejected · missing personal details · ' + missing.join(','));
      throw mkErr(400, `${names} ${missing.length === 1 ? 'is' : 'are'} required`);
    }
  }

  // Validate role exists + is admin-group (we don't manage technicians or
  // client-dashboard users here — those have their own lifecycles).
  const role = await roleService.getRoleById(user_role);
  if (!role)           throw mkErr(400, `Unknown role_id ${user_role}`);
  if (role.group !== 'admin')
    throw mkErr(400, `Role "${role.role_name}" is not an admin role and can't be assigned to a CRM user`);

  const [[dupEmail]] = await pool.query(
    `SELECT user_id FROM tbl_user
      WHERE LOWER(official_email) = ? AND user_status = 1 AND user_type_id = ?
      LIMIT 1`,
    [email, INTERNAL_USER_TYPE_ID]
  );
  if (dupEmail) {
    logger.warn('Create user rejected · duplicate active email');
    throw mkErr(409, `An active user with email "${email}" already exists`);
  }

  /*
   * Uniqueness only means something for a mobile that was actually supplied.
   * Skipping the probe on a blank one is REQUIRED now that mobile is optional:
   * otherwise the second blank-mobile user would match the first on
   * `mobile_no = ''` and be rejected as a duplicate of it. (Today's 7
   * mobile-less users store NULL, which never matches — so this would have
   * stayed dormant until the first '' row was written, then broken every
   * blank-mobile create after it.)
   */
  const [[dupMob]] = mob ? await pool.query(
    `SELECT user_id FROM tbl_user
      WHERE mobile_no = ? AND user_status = 1 AND user_type_id = ?
      LIMIT 1`,
    [mob, INTERNAL_USER_TYPE_ID]
  ) : [[null]];
  if (dupMob) {
    logger.warn('Create user rejected · duplicate active mobile');
    throw mkErr(409, `An active user with mobile "${mob}" already exists`);
  }

  /*
   * TRANSACTIONAL — the tbl_user row and its MANDATORY personal_email land
   * together or not at all. Without the transaction a failure on the second
   * statement (a host that has not yet applied
   * migrations/2026-08-03-create-tbl-user-personal-details.sql being the
   * realistic one) would leave a committed user violating the very rule we just
   * validated, and nothing downstream could tell that from a legacy row. That
   * case surfaces as the actionable 503 from upsertPersonalEmail rather than an
   * opaque ER_NO_SUCH_TABLE 500 — see the note on the READ/WRITE asymmetry there.
   */
  const conn = await pool.getConnection();
  let r;
  /*
   * Tracks whether GET_LOCK actually SUCCEEDED, so the finally below releases
   * exactly what we hold and nothing else. Releasing a lock we never acquired
   * is not harmless bookkeeping: RELEASE_LOCK would return NULL here (we do not
   * own it), but on a session that had legitimately taken the lock for another
   * reason it would hand it away mid-write.
   */
  let empLockHeld = false;
  try {
    await conn.beginTransaction();

    /*
     * ── Employee-code collision guard ─────────────────────────────────────
     *
     * The lock is on THIS connection — the same one running the transaction —
     * because MySQL named locks are CONNECTION-SCOPED. Taking it from the pool
     * would pin an unrelated session and guard nothing at all.
     *
     * ⚠ THE RETURN VALUE MUST BE CHECKED. GET_LOCK returns 1 on success, 0 on
     * TIMEOUT (all 5 seconds elapsed and someone else still holds it) and NULL
     * on error. Only 1 means we hold it. Treating a 0 or a NULL as success is
     * the entire bug this guard exists to prevent: the create would sail past a
     * duplicate check that is racing another create, and both would INSERT the
     * same user_code with no UNIQUE index to stop them.
     *
     * Number(null) === 0 and Number(undefined) is NaN, so `!== 1` rejects both
     * the timeout and the error case without a second branch.
     */
    const [[lock]] = await conn.query('SELECT GET_LOCK(?, 5) AS got', [EMP_CODE_LOCK]);
    if (Number(lock && lock.got) !== 1) {
      logger.warn('Create user rejected · could not acquire ' + EMP_CODE_LOCK + ' within 5s · got=' + JSON.stringify(lock && lock.got));
      throw mkErr(503, 'Could not reserve an employee code just now — another user is being created. Please retry.');
    }
    empLockHeld = true;

    /*
     * Deliberately NOT filtered by user_status or user_type_id, unlike the
     * email/mobile probes above. An employee code identifies a PERSON for the
     * life of the record: a deactivated ex-employee still owns theirs, and
     * reissuing it would silently re-attribute their history in every report
     * that joins on it. A recycled mobile number is fine; a recycled employee
     * code is data corruption. This also keeps the probe consistent with
     * nextEmpCode()'s MAX(), which scans the same unfiltered population — if
     * the two disagreed, the suggestion would point straight at a code the
     * check then rejects.
     */
    const [[dupCode]] = await conn.query(
      'SELECT user_id FROM tbl_user WHERE user_code = ? LIMIT 1',
      [empCode]
    );
    if (dupCode) {
      logger.warn('Create user rejected · duplicate user_code · code=' + empCode + ' · heldBy=' + dupCode.user_id);
      /*
       * A DISTINCT machine-readable code, because this one call can 409 on the
       * email, the mobile OR the employee code and the operator has to be told
       * WHICH field to fix. Surfaced by the route as details.{code,field} — see
       * the precedent in routes/admin/withdrawals.js.
       */
      const err = mkErr(409, `Employee code "${empCode}" is already in use — pick another`);
      err.code  = 'USER_CODE_TAKEN';
      err.field = 'user_code';
      throw err;
    }

    [r] = await conn.query(
      `INSERT INTO tbl_user
         (user_code, user_name, official_email, mobile_no, alternate_no,
          user_role, user_type_id, city_id,
          manage_clients, manage_cities, manage_states, manage_verticals,
          reporting_manager,
          user_status, insert_date, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?)`,
      [
        empCode,
        // `mob || null` — store NULL, never '', for a mobile-less user. Matches
        // how the 7 existing mobile-less rows are stored, and keeps the
        // uniqueness probe above meaningful (NULL never equals NULL in SQL, so
        // blank rows can't collide with each other).
        name, email, mob || null, alternate_no || null,
        Number(user_role), INTERNAL_USER_TYPE_ID, city_id ? Number(city_id) : null,
        manage_clients || null, manage_cities || null, manage_states || null, manage_verticals || null,
        reporting_manager ? Number(reporting_manager) : null,
        STATUS_ACTIVE, createdBy || null,
      ]
    );
    await upsertPersonalEmail(r.insertId, personalEmail.value, conn);
    /*
     * The HR identifiers, in the SAME transaction. Only the keys the operator
     * actually supplied are passed on, so Add User with the optional section
     * left untouched issues no second write at all.
     */
    await upsertPersonalIdentifiers(r.insertId, hrIdentifiers, conn);
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    /*
     * Released on EVERY path — commit, rollback, a throw from any statement
     * above, and the 503 when the lock itself could not be taken (empLockHeld
     * is false there, so this correctly does nothing).
     *
     * AFTER commit/rollback and BEFORE conn.release(), both load-bearing:
     * releasing early would open the window between the duplicate check and the
     * durable write that the lock exists to close, and releasing the CONNECTION
     * first would return a lock-holding session to the pool. A named lock is
     * dropped when its session ends, but a pooled connection does not end — it
     * gets handed to the next request, which would then be holding a lock it
     * knows nothing about until the process restarts.
     *
     * The release is itself wrapped: a failure to release must not mask the
     * real error being thrown out of catch, and it must not turn a COMMITTED
     * user into a reported failure.
     */
    if (empLockHeld) {
      try {
        await conn.query('SELECT RELEASE_LOCK(?) AS released', [EMP_CODE_LOCK]);
      } catch (releaseErr) {
        logger.warn('Employee-code lock release failed · ' + EMP_CODE_LOCK + ' · ' + releaseErr.message);
      }
    }
    conn.release();
  }
  // New active user could be a manager's direct report — invalidate so
  // the next hierarchy resolution picks up the new edge instead of
  // serving the pre-insert adjacency map for up to 60s.
  invalidateHierarchyCache();
  // Job Stage Access — only when the operator supplied the field. null =
  // unrestricted → no rows (a fresh user has none anyway); [] = explicit no
  // access → one sentinel row. See reconcileAllowedStages.
  if (allowed_stages !== undefined) {
    await reconcileAllowedStages(r.insertId, allowed_stages, createdBy);
  }
  logger.info('User created · id=' + r.insertId + ' · role=' + Number(user_role));

  const row = await getUserById(r.insertId);

  /*
   * ── Microsoft 365 mailbox provisioning ────────────────────────────────
   * The CRM row above is the source of truth and is ALREADY COMMITTED. This
   * step only ADDS visibility; it must never change that outcome:
   *
   *   - NOT in a transaction with the INSERT. A Graph outage, an expired
   *     client secret or a licence shortage cannot roll back a created user.
   *   - Fail-soft: provisionUserMailbox() never throws. The try/catch is a
   *     second belt in case a future edit breaks that promise.
   *   - Fail-closed: with easyfix_properties['entra.provisioning.enabled']
   *     absent or 'false' (the seeded default) this performs ZERO network
   *     calls and simply records "skipped: feature disabled".
   *   - It ALWAYS records an outcome row, including the skip. That record is
   *     the actual root-cause fix for the reported bug: a user whose mailbox
   *     was never created stops being invisible.
   *   - TIME-BOUNDED: we never hold the operator's request open longer than
   *     PROVISION_INLINE_DEADLINE_MS. Past that it runs detached and records its
   *     own outcome (see the constant's comment for the 504-vs-409 trap).
   *
   * The outcome rides back on the returned row so POST /api/admin/users can
   * surface it, WITHOUT altering the success/failure semantics of user
   * creation itself.
   *
   * ── The credential mail is CHAINED to it, not raced ───────────────────
   * The "your EasyFix account is ready" mail is attached to the SAME promise as
   * provisioning, so a run that outlives the inline deadline still mails the
   * user once it finishes. Only the REPORTING of it is time-bounded.
   *
   * That is load-bearing, not incidental: the licence read-back now waits out an
   * eventually-consistent Graph write for up to licenceVerifyBudgetMs() (~90s,
   * see services/entra-provisioning.service.js), which is deliberately LONGER
   * than the deadline below. The PENDING answer this returns at 20s promises the
   * mail will follow — and it does, from this chain, with `tempPassword` still
   * held in its closure.
   *
   * ── THE TEMP PASSWORD ─────────────────────────────────────────────────
   * `tempPassword` below is the ONLY place the generated password exists
   * outside the Graph request body. It is written by the sink callback,
   * consumed by the mail sender, and nulled immediately after. It is never
   * logged, never bound into a SQL statement, and never attached to `row`,
   * `provisioning` or the mail outcome — all three are serialised into the HTTP
   * response. tests/user-welcome-mail.test.js asserts all of that against the
   * real logger and the real DB call log rather than trusting this comment.
   */
  let provisioning = null;
  let welcome = null;
  try {
    let tempPassword = null;

    // `.catch` here (not only the outer try) because once the deadline expires
    // this promise is unawaited — an unhandled rejection would take the process
    // down on Node 18+.
    const running = entraProvisioning.provisionUserMailbox({
      userId: r.insertId,
      userName: name,
      officialEmail: email,
      trigger: 'create-user',
      actorId: createdBy || null,
      onTempPassword: (pw) => { tempPassword = pw; },
    }).then(async (outcome) => {
      /*
       * Send ONLY on mailboxReady — an account with no licence has no mailbox,
       * so "here are your Outlook and Teams credentials" would be actively
       * misleading (licence_status 'no_seats_available' is a real live case).
       * The gate itself lives in the mail service so there is exactly one copy
       * of it; every other outcome returns a `skipped` with the reason.
       */
      let mail;
      try {
        mail = await welcomeMail.sendWelcomeMail({
          userId: r.insertId,
          userName: name,
          officialEmail: email,
          personalEmail: personalEmail.value,
          tempPassword,
          provisioning: outcome,
        });
      } catch (e) {
        // sendWelcomeMail is fail-soft by contract; this is the belt in case a
        // future edit breaks that. Crucially it keeps the MAIL failure from
        // being reported as a PROVISIONING failure by the outer .catch — the
        // mailbox may well be fine, and saying otherwise would send an operator
        // to re-provision an account that needs nothing.
        mail = { status: welcomeMail.MAIL_STATUS.FAILED, reason: e.message };
      } finally {
        tempPassword = null; // done with it — do not retain past the send
      }
      return { outcome, mail };
    }).catch((e) => {
      tempPassword = null;
      logger.warn('Mailbox provisioning threw after user create (user IS created) · userId=' + r.insertId + ' · ' + e.message);
      return {
        outcome: { attempted: false, accountStatus: 'failed', licenceStatus: 'not_attempted', mailboxReady: false, reason: e.message },
        mail: { status: welcomeMail.MAIL_STATUS.SKIPPED, reason: 'mailbox provisioning failed, so no credentials were issued' },
      };
    });

    const settled = await withProvisionInlineDeadline(running);

    if (settled.timedOut) {
      logger.warn('Mailbox provisioning exceeded the inline deadline — continuing in the background · userId='
        + r.insertId + ' · deadlineMs=' + PROVISION_INLINE_DEADLINE_MS);
      provisioning = {
        attempted: true,
        pending: true,
        accountStatus: 'pending',
        licenceStatus: 'pending',
        mailboxReady: false,
        reason: 'still running after ' + PROVISION_INLINE_DEADLINE_MS
          + 'ms — the outcome will be recorded; read it from GET /api/admin/users/'
          + r.insertId + '/provisioning',
      };
      welcome = {
        status: welcomeMail.MAIL_STATUS.PENDING,
        reason: 'waiting on mailbox provisioning — the sign-in details are mailed automatically if it completes',
      };
    } else {
      provisioning = settled.value.outcome;
      welcome = settled.value.mail;
    }
  } catch (e) {
    logger.warn('Mailbox provisioning threw after user create (user IS created) · userId=' + r.insertId + ' · ' + e.message);
    provisioning = { attempted: false, accountStatus: 'failed', licenceStatus: 'not_attempted', mailboxReady: false, reason: e.message };
    welcome = { status: welcomeMail.MAIL_STATUS.SKIPPED, reason: 'mailbox provisioning failed, so no credentials were issued' };
  }
  if (row) {
    row.provisioning = provisioning;
    // Named `welcome_mail` to match the snake_case the rest of this payload
    // uses. NEVER carries the password — see the block comment above.
    row.welcome_mail = welcome;
  }
  return row;
}

// ─── Update ──────────────────────────────────────────────────────────
/*
 * Per-column value-equality used by updateUser to short-circuit writes
 * when the incoming PATCH would be a no-op against the current row.
 *
 *   - Numeric FKs (user_role, city_id, reporting_manager) compare as
 *     numbers; '' / null collapse to null.
 *   - Scope CSVs (manage_*) compare as canonical sorted-int sets so
 *     "5,10" and "10,5" both match an existing "5,10". The literal
 *     "0" wildcard stays its own value (matches only itself).
 *   - String columns (mobile_no, alternate_no) trim + compare; ''
 *     collapses to null.
 */
function normaliseForCompare(key, val) {
  const csvKeys = new Set(['manage_clients', 'manage_cities', 'manage_states', 'manage_verticals']);
  const numKeys = new Set(['user_role', 'city_id', 'reporting_manager']);
  if (val === undefined || val === null) return null;
  if (csvKeys.has(key)) {
    const s = String(val).trim();
    if (s === '' || s === null) return '';
    if (s === '0') return '0';
    const ids = s.split(',').map((x) => x.trim()).filter(Boolean).map(Number).filter((n) => !Number.isNaN(n));
    return Array.from(new Set(ids)).sort((a, b) => a - b).join(',');
  }
  if (numKeys.has(key)) {
    if (val === '' || val === null) return null;
    const n = Number(val);
    return Number.isNaN(n) ? null : n;
  }
  // string column
  const s = String(val).trim();
  return s === '' ? null : s;
}

/**
 * @param {Object}  [opts]
 * @param {boolean} [opts.dryRun]
 * @param {boolean} [opts.enforcePersonalEmail=true]
 *   Whether the personal_email requiredness matrix applies to this edit.
 *   DEFAULTS TO TRUE — a caller that forgets it gets the stricter behaviour.
 *
 *   The BULK paths (POST /api/admin/users/bulk-update and the users-bulk
 *   spreadsheet upload) pass FALSE, deliberately. They exist to push scope
 *   CSVs, a reporting manager or a role onto hundreds of EXISTING users, and
 *   they never carry a personal_email — so enforcing it there would not
 *   "backfill" anything, it would simply make every one of the ~7.5k
 *   personal-email-less active users permanently un-bulk-updatable. The matrix
 *   is about the Add/Edit User FORM, which is the surface that can actually
 *   collect the address.
 */
async function updateUser(userId, fields, updatedBy, opts = {}) {
  const { dryRun = false, enforcePersonalEmail = true, enforceHrIdentifiers = false } = opts;
  logger.info('Update user · userId=' + userId + ' · dryRun=' + dryRun);

  // Load every column we might compare against. The single round-trip
  // replaces the older mobile-only SELECT and unlocks the "skip-on-no-
  // change" path: if every supplied field already matches the row, we
  // never issue an UPDATE (no update_date bump, no updated_by churn,
  // no idempotent re-application of the same data on re-uploads).
  const [[me]] = await pool.query(
    /*
     * user_code is projected so the no-change short-circuit below can see it.
     * Without it `me.user_code` is undefined, every PATCH that echoes the user's
     * EXISTING code looks like a change, and the row gets a pointless UPDATE
     * plus a duplicate probe on every save. (The probe would still be correct —
     * it excludes the row being edited — but bumping update_date on a no-op is
     * exactly what the short-circuit exists to prevent.)
     */
    `SELECT user_id, user_type_id, user_code, mobile_no, alternate_no,
            user_role, city_id,
            manage_clients, manage_cities, manage_states, manage_verticals,
            reporting_manager, user_status
       FROM tbl_user WHERE user_id = ? LIMIT 1`,
    [userId]
  );
  if (!me) {
    logger.warn('Update user rejected · not found · userId=' + userId);
    throw mkErr(404, 'User not found');
  }
  if (me.user_type_id !== INTERNAL_USER_TYPE_ID) {
    logger.warn('Update user rejected · not an internal CRM user · userId=' + userId);
    throw mkErr(403, 'This user is not an internal CRM user and can\'t be edited here');
  }

  /*
   * ── personal_email requiredness ───────────────────────────────────────
   * ACTIVE user  → REQUIRED.  INACTIVE user → not required.
   * The edit that DEACTIVATES  → not required (offboarding someone who has
   * already left must never require chasing them for a personal address).
   *
   * Enforced HERE as well as in the route's Joi, on purpose: this is the deeper
   * layer, and the deeper layer silently wins. The mobile_no episode is the
   * cautionary tale — the Joi schema was loosened, the service check was not,
   * and the API kept answering "mobile_no is required" while the form showed the
   * field as optional.
   *
   * NOTE the asymmetry with createUser: there the field must be PRESENT in the
   * payload; here "required" means the row must not be left without one, which
   * is the same thing for the form (it always posts the field) but does not
   * punish an active user who already has an address on record.
   */
  const personalRequired = enforcePersonalEmail
    && isPersonalEmailRequiredOnUpdate(me.user_status, fields.is_active);

  const suppliedPersonalEmail = fields.personal_email !== undefined;
  /*
   * HR identifiers, validated BEFORE any column write so a bad PAN rejects the
   * whole edit rather than half-applying it.
   */
  const identifiers = collectHrIdentifiers(fields);
  if (!identifiers.ok) {
    logger.warn('Update user rejected · ' + identifiers.message + ' · userId=' + userId);
    throw mkErr(400, identifiers.message);
  }
  const hrIdentifiers = identifiers.values;

  /*
   * PERSONAL DETAILS ARE MANDATORY ON EDIT — with the same two exemptions
   * personal_email already carries, and for the same reason. An INACTIVE user,
   * and the edit that DEACTIVATES one, are both excused: offboarding someone
   * who has already left must never require chasing them for a PAN, and
   * ~1.2k existing users have none of these six on file today, so a rule
   * without the exemption would make every one of them unable to be
   * deactivated at all.
   *
   * The check is a MERGE against what is stored (see missingHrIdentifiers), so
   * an operator editing a user whose PAN is already on file is not asked to
   * re-type a number the form is not allowed to show them.
   */
  if (enforceHrIdentifiers
      && isPersonalEmailRequiredOnUpdate(me.user_status, fields.is_active)) {
    const stored = await loadPersonalIdentifiers(userId);
    const missing = missingHrIdentifiers(hrIdentifiers, stored);
    if (missing.length) {
      const names = missing.map((k) => HR_IDENTIFIER_LABELS[k]).join(', ');
      logger.warn('Update user rejected · missing personal details · userId=' + userId
        + ' · ' + missing.join(','));
      throw mkErr(400, `${names} ${missing.length === 1 ? 'is' : 'are'} required`);
    }
  }

  let personalEmailValue = null;   // the value to write, when we write one
  let writePersonalEmail = false;  // true only when it actually changed

  if (suppliedPersonalEmail || personalRequired) {
    // FAIL-SOFT read (see loadPersonalEmail): on a pre-migration host this
    // resolves to null rather than throwing, so an INACTIVE user — the path the
    // matrix exempts — stays editable instead of 500-ing.
    const current = String((await loadPersonalEmail(userId)) || '').trim().toLowerCase() || null;

    if (suppliedPersonalEmail) {
      const parsed = normalisePersonalEmail(fields.personal_email, { required: personalRequired });
      if (!parsed.ok) {
        logger.warn('Update user rejected · ' + parsed.message + ' · userId=' + userId);
        throw mkErr(400, parsed.message);
      }
      personalEmailValue = parsed.value;
      // Same no-change short-circuit the mutable columns get: an unchanged
      // value must not bump updated_on or turn a genuine no-op into an update.
      writePersonalEmail = personalEmailValue !== current;
    } else if (!current) {
      // Not supplied AND the row has none. This is the case the matrix forbids.
      logger.warn('Update user rejected · personal_email required for an active user · userId=' + userId);
      throw mkErr(400, 'personal_email is required when editing an active user');
    }
  }

  const sets   = [];
  const params = [];
  let suppliedCount = 0;

  for (const key of MUTABLE_COLUMNS) {
    if (fields[key] === undefined) continue;
    suppliedCount++;

    // Skip the column entirely when the incoming value already matches
    // the persisted value. This is the core of the no-change short-
    // circuit — without it, every re-upload bumps update_date even
    // though no business data changed.
    if (normaliseForCompare(key, fields[key]) === normaliseForCompare(key, me[key])) continue;

    let val = fields[key];
    if (key === 'user_role' && val) {
      const role = await roleService.getRoleById(val);
      if (!role) throw mkErr(400, `Unknown role_id ${val}`);
      if (role.group !== 'admin') {
        throw mkErr(400, `Role "${role.role_name}" is not an admin role`);
      }
      val = Number(val);
    }
    if (key === 'mobile_no' && val) {
      const mob = String(val).trim();
      // Mobile is actually changing here (the equality short-circuit
      // above guarantees that), so the uniqueness probe is meaningful.
      const [[dup]] = await pool.query(
        `SELECT user_id FROM tbl_user
          WHERE mobile_no = ? AND user_status = 1 AND user_type_id = ?
            AND user_id <> ? LIMIT 1`,
        [mob, INTERNAL_USER_TYPE_ID, userId]
      );
      if (dup) {
        logger.warn('Update user rejected · mobile already used by another active user · userId=' + userId);
        throw mkErr(409, `Another active user already uses mobile "${mob}"`);
      }
      val = mob;
    }
    if (key === 'user_code' && val) {
      const code = String(val).trim();
      if (!EMP_CODE_RE.test(code)) {
        throw mkErr(400, `user_code ${EMP_CODE_FORMAT_HINT} — got "${code}"`);
      }
      /*
       * ── SELF-EXCLUSION — `user_id <> ?` ──────────────────────────────────
       * This is the bug this shape of check usually ships with: without it, a
       * user who re-saves the form with their OWN unchanged code matches their
       * own row and gets told the code is taken, i.e. nobody can ever edit
       * anything about themselves again.
       *
       * The equality short-circuit above ALREADY skips an unchanged code, so
       * this looks redundant — it is not. It is the only guard that survives
       * the short-circuit being bypassed (a bulk path that does not project
       * user_code, a future caller that builds `sets` differently), and it was
       * genuinely load-bearing until the SELECT above was widened to project
       * user_code. Belt AND braces, deliberately.
       *
       * Unfiltered by status/type for the same reason as the create path: a
       * code belongs to a person permanently, including an ex-employee's.
       */
      const [[dup]] = await pool.query(
        'SELECT user_id FROM tbl_user WHERE user_code = ? AND user_id <> ? LIMIT 1',
        [code, userId]
      );
      if (dup) {
        logger.warn('Update user rejected · duplicate user_code · code=' + code + ' · heldBy=' + dup.user_id);
        const err = mkErr(409, `Employee code "${code}" is already in use — pick another`);
        err.code  = 'USER_CODE_TAKEN';
        err.field = 'user_code';
        throw err;
      }
      /*
       * ponytail: check-then-UPDATE here is NOT under GET_LOCK, unlike the
       * create path — a deliberate, bounded ceiling rather than an oversight.
       * updateUser builds its SET list against the shared pool (no pinned
       * connection and no transaction), so a named lock taken here would be
       * acquired on one pool connection and the UPDATE issued on another,
       * guarding nothing while looking like it guarded something.
       *
       * The residual race is also much narrower than the create one. Create
       * races because the suggestion endpoint reserves nothing, so two admins
       * opening Add User are HANDED the same code — the collision is the
       * default outcome. To collide here two admins must independently TYPE the
       * same code onto two different users within the same few milliseconds.
       *
       * Upgrade path if that ever shows up: pin updateUser onto a connection
       * from pool.getConnection(), wrap it in a transaction, and reuse the
       * create path's GET_LOCK(EMP_CODE_LOCK)/RELEASE_LOCK around the probe and
       * the UPDATE — or hand the whole thing to withMysqlNamedLock, which
       * already passes its pinned connection to the task.
       */
      val = code;
    }
    sets.push(`${key} = ?`);
    params.push(val === '' ? null : val);
  }

  if (fields.is_active !== undefined) {
    suppliedCount++;
    const wantActive = fields.is_active ? 1 : 0;
    if (wantActive !== me.user_status) {
      sets.push('user_status = ?');
      params.push(wantActive);
    }
  }

  // Job Stage Access — present (an array, including [], or null) means the
  // operator intends to (re)set the user's allowed stages. Reconciled AFTER the
  // tbl_user write, independent of the column diff so a stage-only PATCH still
  // applies. ABSENT = untouched. Counts toward suppliedCount so a stage-only
  // change isn't mistaken for an empty body.
  const hasAllowedStages = fields.allowed_stages !== undefined;
  if (hasAllowedStages) suppliedCount++;

  // personal_email lives in the side table, so it is counted (and no-op
  // short-circuited) alongside allowed_stages rather than as a tbl_user column.
  if (suppliedPersonalEmail) suppliedCount++;

  /*
   * The five HR identifiers are side-table writes too, and they must be counted
   * on BOTH lines below or they are silently unreachable:
   *
   *   - suppliedCount: a PATCH carrying ONLY identifiers — the bulk sheet's
   *     whole point, an HR run that fills in Date Of Joining and nothing else —
   *     would otherwise 400 with "No mutable fields supplied" while the
   *     operator is plainly supplying five fields.
   *   - the no-op short-circuit: a PATCH whose tbl_user columns all match the
   *     stored row would otherwise return the __unchanged sentinel and RETURN
   *     BEFORE upsertPersonalIdentifiers ever runs — the identifiers dropped on
   *     the floor and reported to the operator as a successful "unchanged".
   *     That is silent data loss, the worst of the two.
   *
   * Presence, not a diff, for the same reason the write below is payload-keyed:
   * pan/aadhaar re-encrypt to different ciphertext every time, so there is no
   * cheap comparison that would not report a change on every save.
   */
  const hasHrIdentifiers = Object.keys(hrIdentifiers).length > 0;
  if (hasHrIdentifiers) suppliedCount++;

  // Distinguish "operator sent nothing" (real 400) from "operator sent
  // values that all match" (no-op, return unchanged sentinel).
  if (suppliedCount === 0) throw mkErr(400, 'No mutable fields supplied');
  if (!sets.length && !hasAllowedStages && !writePersonalEmail && !hasHrIdentifiers) {
    logger.info('Update user no-op · userId=' + userId + ' · all supplied values match');
    const row = await getUserById(userId);
    if (row) row.__unchanged = true;
    return row;
  }

  // Dry-run path — diff has happened, we KNOW this would mutate the
  // row, but we don't want to actually write. Returns a sentinel the
  // bulk-upload route uses to report 'valid' (vs 'unchanged') so the
  // operator gets an accurate preview.
  if (dryRun) {
    logger.info('Update user dry-run · userId=' + userId + ' · wouldChange fields=' + sets.length);
    const row = await getUserById(userId);
    if (row) row.__wouldUpdate = true;
    return row;
  }

  // tbl_user column write — only when a mutable column actually changed. A
  // stage-only PATCH (sets empty) skips this and just reconciles below.
  if (sets.length) {
    sets.push('update_date = NOW()', 'updated_by = ?');
    params.push(updatedBy || null, userId);

    await pool.query(`UPDATE tbl_user SET ${sets.join(', ')} WHERE user_id = ?`, params);
    logger.info('User updated · id=' + userId + ' · fields=' + sets.length);
    // Per-user perms cache invalidation. A user_role change is the obvious
    // trigger; other field edits (name, email, etc.) don't change perms but
    // clearing one entry is cheap so we do it unconditionally.
    roleService.invalidatePermissionsCache(userId);
    // Hierarchy adjacency invalidation. reporting_manager / user_status /
    // user_type_id are all reachable via this update path; rather than
    // sniff which field changed, just clear unconditionally (rebuild ~1 ms).
    invalidateHierarchyCache();
  }

  // Personal contact upsert — side table, after the column write, and only when
  // the value actually changed (see writePersonalEmail above).
  if (writePersonalEmail) {
    await upsertPersonalEmail(userId, personalEmailValue);
    logger.info('Personal email updated · userId=' + userId + ' · cleared=' + (personalEmailValue === null));
  }

  /*
   * HR identifiers. Keyed off the PAYLOAD, not off a diff against the stored
   * row: pan and aadhaar are encrypted with a fresh IV every time, so the
   * ciphertext of an unchanged value differs from what is stored and a
   * value-comparison would report a change on every save. Absent keys are
   * already skipped inside the upsert, which is the only "did it change"
   * test this needs.
   */
  if (Object.keys(hrIdentifiers).length) {
    await upsertPersonalIdentifiers(userId, hrIdentifiers);
    logger.info('HR identifiers updated · userId=' + userId
      + ' · fields=' + Object.keys(hrIdentifiers).join(','));
  }

  // Job Stage Access reconcile — after the column write, atomically swaps the
  // user's grants. null = unrestricted (clears all rows); [] = no access.
  // Only when supplied.
  if (hasAllowedStages) {
    await reconcileAllowedStages(userId, fields.allowed_stages, updatedBy);
  }

  return getUserById(userId);
}

// ─── Soft-delete (status flag) ──────────────────────────────────────
/**
 * Hierarchy DFS — return every user_id that reports to `rootUserId`
 * directly or transitively via `tbl_user.reporting_manager`.
 *
 * Strategy: load the (manager_id, user_id) adjacency for all internal
 * users once (cheap — single SELECT, ~few thousand rows), build an
 * in-memory map, then DFS from the root. Cycles are guarded by a
 * `visited` set; legacy production data has at least one self-loop.
 *
 * Returns: { descendants: number[], directReports: number[] }
 *   descendants — DFS-flattened all-levels (excluding rootUserId itself)
 *   directReports — only the level-1 children (drives the graph view's
 *                   initial render)
 *
 * Cached briefly: hierarchy mutations are rare (org change ≪ per-request)
 * so we hold a 60s cache to avoid re-scanning on every /auth/me hit.
 */
let _hierarchyCache = { at: 0, byManager: null };

/*
 * Explicit hierarchy-adjacency cache invalidation (added 2026-05-30).
 *
 * Any mutation to tbl_user that could change who appears as a direct
 * report calls this — specifically:
 *   - createUser           — new active row that might list a manager
 *   - updateUser           — reporting_manager / user_status / user_type_id
 *                            could have changed; conservatively clear on
 *                            any field-write
 *   - deactivateUser       — user disappears from the active-only query
 *                            inside _loadHierarchyAdjacency
 *
 * Without this, the cache still self-corrects within 60 seconds (the
 * existing TTL on _loadHierarchyAdjacency), but operators reassigning a
 * reporting manager via Manage Users would see stale "team data" reads
 * for up to that window. Resetting `at=0` forces the next read to
 * refetch from DB regardless of TTL.
 *
 * Cheap by design: this is a single object assignment; the cache rebuild
 * is one indexed query on tbl_user, returning typically <500 rows.
 */
function invalidateHierarchyCache() {
  _hierarchyCache = { at: 0, byManager: null };
}

async function _loadHierarchyAdjacency() {
  if (_hierarchyCache.byManager && Date.now() - _hierarchyCache.at < 60_000) {
    return _hierarchyCache.byManager;
  }
  const [rows] = await pool.query(
    `SELECT user_id, reporting_manager
       FROM tbl_user
      WHERE user_type_id = ?
        AND user_status = 1`,
    [INTERNAL_USER_TYPE_ID]
  );
  const byManager = new Map();
  for (const r of rows) {
    const mgr = Number(r.reporting_manager || 0);
    if (!mgr) continue;
    if (!byManager.has(mgr)) byManager.set(mgr, []);
    byManager.get(mgr).push(Number(r.user_id));
  }
  _hierarchyCache = { at: Date.now(), byManager };
  return byManager;
}

async function findDescendantUserIds(rootUserId) {
  const adj = await _loadHierarchyAdjacency();
  const directReports = adj.get(Number(rootUserId)) || [];
  const descendants = [];
  const visited = new Set([Number(rootUserId)]);
  const stack = [...directReports];
  while (stack.length) {
    const id = stack.pop();
    if (visited.has(id)) continue; // cycle guard
    visited.add(id);
    descendants.push(id);
    const children = adj.get(id) || [];
    for (const c of children) stack.push(c);
  }
  return { descendants, directReports };
}

/**
 * Build a hierarchy tree rooted at `rootUserId` — used by the Users →
 * Hierarchy graph view. Returns the user node + nested children, plus
 * the chain of ancestors so the UI can show "this person reports up to".
 */
async function buildHierarchyTree(rootUserId) {
  logger.info('Build hierarchy tree · rootUserId=' + rootUserId);
  const adj = await _loadHierarchyAdjacency();
  const [[root]] = await pool.query(
    `SELECT u.user_id, u.user_name, u.official_email, u.mobile_no,
            u.user_role, r.role_name, u.reporting_manager
       FROM tbl_user u LEFT JOIN tbl_role r ON r.role_id = u.user_role
      WHERE u.user_id = ? AND u.user_type_id = ?`,
    [rootUserId, INTERNAL_USER_TYPE_ID]
  );
  if (!root) {
    logger.warn('Build hierarchy tree · root user not found · rootUserId=' + rootUserId);
    return null;
  }

  // Collect every user_id we'll need in one query (root + descendants + ancestors).
  const { descendants } = await findDescendantUserIds(rootUserId);
  const ancestors = [];
  let cursor = root.reporting_manager;
  const seen = new Set([Number(rootUserId)]);
  while (cursor && !seen.has(Number(cursor))) {
    seen.add(Number(cursor));
    ancestors.push(Number(cursor));
    const [[mgrRow]] = await pool.query(
      'SELECT reporting_manager FROM tbl_user WHERE user_id = ? LIMIT 1',
      [cursor]
    );
    cursor = mgrRow ? mgrRow.reporting_manager : null;
  }

  const allIds = [Number(rootUserId), ...descendants, ...ancestors];
  if (allIds.length === 0) return root;
  const placeholders = allIds.map(() => '?').join(',');
  const [allUsers] = await pool.query(
    `SELECT u.user_id, u.user_name, u.official_email, u.mobile_no,
            u.user_role, r.role_name, u.reporting_manager
       FROM tbl_user u LEFT JOIN tbl_role r ON r.role_id = u.user_role
      WHERE u.user_id IN (${placeholders})`,
    allIds
  );
  const byId = new Map(allUsers.map((u) => [u.user_id, { ...u, children: [] }]));

  // Build nested children tree
  function attach(uid) {
    const node = byId.get(uid);
    if (!node) return null;
    const childIds = adj.get(uid) || [];
    node.children = childIds.map(attach).filter(Boolean);
    return node;
  }
  const tree = attach(Number(rootUserId));
  const ancestorChain = ancestors.map((id) => byId.get(id)).filter(Boolean);
  logger.info('Hierarchy tree built · rootUserId=' + rootUserId + ' · descendants=' + descendants.length + ' · ancestors=' + ancestorChain.length);
  return { tree, ancestors: ancestorChain };
}

/*
 * Real-time mobile-uniqueness probe — drives the Add/Edit User form's
 * inline validation so the operator finds out BEFORE clicking Save that
 * a number is already taken. Cheap (mobile_no has an index in production
 * and the table is ~hundreds of rows of internal staff), so a debounced
 * call per keystroke is acceptable. We mirror the same active-internal
 * gate used on create/update — historical inactive duplicates don't count.
 */
async function isMobileTakenByAnother(mobile, excludeUserId) {
  logger.info('Check mobile availability · excludeUserId=' + (excludeUserId || ''));
  const mob = String(mobile || '').trim();
  // Same canonical rule the routes enforce: an Indian mobile starts 6-9.
  // A looser probe here would report a number 'available' that the create
  // call then rejects, which reads to the operator as a backend bug.
  if (!/^[6-9][0-9]{9}$/.test(mob)) return { available: false, reason: 'invalid' };
  const params = [mob, INTERNAL_USER_TYPE_ID];
  let sql = `SELECT user_id, user_name FROM tbl_user
              WHERE mobile_no = ? AND user_status = 1 AND user_type_id = ?`;
  if (excludeUserId) { sql += ' AND user_id <> ?'; params.push(Number(excludeUserId)); }
  sql += ' LIMIT 1';
  const [[row]] = await pool.query(sql, params);
  if (!row) return { available: true };
  logger.info('Mobile already taken · takenByUserId=' + row.user_id);
  return { available: false, takenBy: { user_id: row.user_id, user_name: row.user_name } };
}

/*
 * Real-time email-uniqueness probe — drives the Add User form's inline
 * validation so the operator finds out BEFORE clicking Save that the
 * address is already taken. When `name` is supplied we also generate a
 * suggestion in the legacy convention `<first>.<last>[<n>]@easyfix.in`,
 * bumping the numeric suffix until a free slot is found (looked up in a
 * single `WHERE official_email IN (...)` query to avoid an N+1 loop).
 */
async function isEmailTakenByAnother(email, excludeUserId, name) {
  logger.info('Check email availability · excludeUserId=' + (excludeUserId || ''));
  const e = String(email || '').trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(e)) return { available: false, reason: 'invalid' };
  const params = [e, INTERNAL_USER_TYPE_ID];
  let sql = `SELECT user_id, user_name FROM tbl_user
              WHERE LOWER(official_email) = ? AND user_status = 1 AND user_type_id = ?`;
  if (excludeUserId) { sql += ' AND user_id <> ?'; params.push(Number(excludeUserId)); }
  sql += ' LIMIT 1';
  const [[row]] = await pool.query(sql, params);
  const taken = !!row;

  let suggestion = null;
  if (taken && name && String(name).trim()) {
    suggestion = await suggestAvailableEmail(name, excludeUserId);
  }

  if (!taken) return { available: true };
  logger.info('Email already taken · takenByUserId=' + row.user_id + ' · hasSuggestion=' + !!suggestion);
  return {
    available: false,
    takenBy: { user_id: row.user_id, user_name: row.user_name },
    ...(suggestion ? { suggestion } : {}),
  };
}

/*
 * Build a deterministic `<first>.<last>[<n>]@easyfix.in` candidate and
 * return the first unused variant. Strategy:
 *   1. Tokenise name → [first, last]. Single-token name uses just that
 *      token. 3+ tokens use first + last (skip middles).
 *   2. Sanitise each token (lowercase, strip non a-z0-9).
 *   3. Generate candidates: base, base1, base2, ... base50.
 *   4. SELECT all taken emails in that set in one query, pick the first
 *      candidate not in the result.
 */
async function suggestAvailableEmail(name, excludeUserId) {
  logger.info('Suggest available email · excludeUserId=' + (excludeUserId || ''));
  const sanitise = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const toks = String(name).trim().split(/\s+/).filter(Boolean).map(sanitise).filter(Boolean);
  if (toks.length === 0) return null;
  const base = toks.length === 1
    ? toks[0]
    : `${toks[0]}.${toks[toks.length - 1]}`;
  const candidates = [`${base}@easyfix.in`];
  for (let i = 1; i <= 50; i++) candidates.push(`${base}${i}@easyfix.in`);

  const placeholders = candidates.map(() => '?').join(',');
  const params = [...candidates, INTERNAL_USER_TYPE_ID];
  let sql = `SELECT LOWER(official_email) AS email FROM tbl_user
              WHERE LOWER(official_email) IN (${placeholders})
                AND user_status = 1 AND user_type_id = ?`;
  if (excludeUserId) { sql += ' AND user_id <> ?'; params.push(Number(excludeUserId)); }
  const [rows] = await pool.query(sql, params);
  const taken = new Set(rows.map((r) => r.email));
  return candidates.find((c) => !taken.has(c)) || null;
}

async function deactivateUser(userId, updatedBy) {
  logger.info('Deactivate user · userId=' + userId);
  const [r] = await pool.query(
    `UPDATE tbl_user
        SET user_status = 0, update_date = NOW(), updated_by = ?
      WHERE user_id = ? AND user_type_id = ?`,
    [updatedBy || null, userId, INTERNAL_USER_TYPE_ID]
  );
  logger.info('User deactivated · userId=' + userId + ' · affected=' + r.affectedRows);
  if (r.affectedRows) {
    // Deactivated user's perms cache entry would still serve stale data
    // until TTL; drop it now so a re-activation or any racing request
    // immediately re-resolves against the live row.
    roleService.invalidatePermissionsCache(userId);
    // Hierarchy view: _loadHierarchyAdjacency queries WHERE user_status=1,
    // so this user just disappeared from every manager's downstream list.
    // Clear so the next read reflects the change.
    invalidateHierarchyCache();
  }
  return r.affectedRows > 0;
}

module.exports = {
  listUsers,
  getUserById,
  createUser,
  updateUser,
  deactivateUser,
  isMobileTakenByAnother,
  isEmailTakenByAnother,
  suggestAvailableEmail,
  // Employee code — the prefill for the Add User form. The FORMAT itself lives
  // in lib/emp-code.js and is imported, never re-declared, by both layers.
  suggestNextEmpCode,
  findDescendantUserIds,
  buildHierarchyTree,
  // Job Stage Access — per-user allowed lifecycle stages.
  loadAllowedStages,
  loadAllowedStagesForUsers,
  reconcileAllowedStages,
  // Personal contact — the ONE definition of the personal_email rules, shared
  // with routes/admin/users.js so the route and the service cannot drift.
  isPersonalEmailRequiredOnUpdate,
  normalisePersonalEmail,
  upsertPersonalEmail,
  // The HR master-data identifiers — all optional, all on the same side table.
  normaliseUan,
  normalisePan,
  normaliseAadhaar,
  normaliseDateOfBirth,
  normaliseDateOfJoining,
  normaliseAddress,
  missingHrIdentifiers,
  HR_IDENTIFIER_LABELS,
  upsertPersonalIdentifiers,
  loadPersonalIdentifiers,
  loadPersonalEmail,
  loadPersonalEmails,
  // Hierarchy adjacency cache invalidation hook — call from any external
  // write path that mutates tbl_user beyond the create/update/deactivate
  // entrypoints here (e.g. a future bulk-import path that writes
  // reporting_manager directly via pool.query without going through
  // updateUser). Internal write paths already self-invalidate.
  invalidateHierarchyCache,
  // Mailbox provisioning inline deadline — exported so the repair route races
  // the SAME number with the SAME code instead of growing a second copy.
  withProvisionInlineDeadline,
  PROVISION_INLINE_DEADLINE_MS,
  SORTABLE_COLUMNS,
  INTERNAL_USER_TYPE_ID,
};
