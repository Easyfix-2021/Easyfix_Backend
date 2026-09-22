const { pool } = require('../db');
const logger = require('../logger');
const s3Storage = require('../utils/s3-storage');
const { uploadJobImage, storeJobImageFile, resolveImageType } = require('./job-image.service');
const pushDelivery = require('./push-delivery.service');
const emailService = require('./email.service');

/*
 * ─── SITE-ACCESS PERMISSION REQUESTS ───────────────────────────────────────
 *
 * On site, a technician sometimes cannot get in — a mall gate pass, a society
 * NOC, a building access letter. He raises a REQUEST against the job; the
 * client sees it on the Client Dashboard, uploads the document (or declines
 * with a reason); the technician sees the result and carries on.
 *
 * ONE table (tbl_job_permission_request, migrations/2026-09-07-create-tbl-job-
 * permission-request.sql) and ONE service, called from two places:
 *   routes/mobile/permission-requests.js  — the technician side, its own file
 *   routes/client/index.js                — the client side, INLINE beside the
 *                                           loadJobInScope resolver it must
 *                                           reuse (a sub-router would need a
 *                                           require cycle to reach it — the
 *                                           reason is spelled out there)
 * The routes own AUTHORISATION (whose job is this) and nothing else; every rule
 * about what a request IS lives here, so the two sides cannot drift.
 *
 * ── THE DOCUMENT IS AN ORDINARY JOB IMAGE ───────────────────────────────
 * Uploads go through services/job-image.service.js with
 * image_category = 'permission' — the same convention the Billing & Charges
 * Job Sheet / Purchase Order documents use (routes/admin/job-documents.js).
 * That buys the canonical S3 key (JobSupportings/Permission_<jobId>_<seq>, NO
 * file extension, real MIME on Content-Type), the local-disk fallback when S3
 * is unconfigured, and the tbl_job_image row ops already knows how to read.
 *
 * 'permission' is deliberately NOT in PROOF_BEFORE_CATEGORIES or
 * PROOF_AFTER_CATEGORIES (utils/job-image-buckets.js), so a gate pass can never
 * be served to anyone as a before/after work photo.
 *
 * WHAT A CLIENT MAY UPLOAD is decided in that service, not here: images (PNG,
 * JPEG, GIF, WebP) and application/pdf, verified by sniffing the leading bytes
 * rather than by trusting the multipart Content-Type. A permit is a photo of a
 * paper form as often as it is a PDF export, so both must pass — and nothing
 * else may, since the stored object is served from a presigned URL.
 *
 * ── documentUrl IS PRESIGNED, NEVER AN AUTHED ENDPOINT ──────────────────
 * Neither frontend can attach a bearer to an <img> / <Image> / <iframe>: one
 * pointing at an authenticated endpoint 401s silently and shows a broken tile
 * with nothing in the console. So the read path is s3Storage.resolveImageUrl(),
 * which returns a short-TTL presigned S3 URL (or the Nginx-served /easydoc URL
 * when S3 is off) — a URL the tag can actually load. It is null when the row has
 * no document yet, and the frontends must treat null as "nothing to show", not
 * as an error.
 *
 * ── AND IT IS NOT ALWAYS AN IMAGE ───────────────────────────────────────
 * A permit is an arbitrary third-party artifact. Of the three real samples the
 * product owner supplied, one is a screenshot of a mall web portal, one a photo
 * of a signed-and-stamped paper form, and one a set of Pazo workflow exports —
 * PDFs. Two of the three are not images, and an <img> pointing at a PDF is the
 * same broken tile as a 401.
 *
 * The URL cannot be sniffed for the answer: the S3 key carries NO extension by
 * ops convention. So the item carries the type explicitly —
 *
 *   documentKind      'image' | 'pdf' | 'unknown', or null when there is no
 *                     document. THE FIELD TO BRANCH ON: <img> for 'image', a
 *                     PDF viewer / "Open document" link for 'pdf', and the same
 *                     link for 'unknown' — a download always works, a render
 *                     might not.
 *   documentMimeType  the exact type when it could be established, else null.
 *
 * Both are ADDITIVE; every field the two frontends already read is unchanged.
 * Derivation and its limits live in services/job-image.service.js
 * (resolveImageType) — the type is not a column on tbl_job_image, and the
 * comment there says exactly where it does come from.
 *
 * ── NO NEW CLIENT ACCESS SURFACE ────────────────────────────────────────
 * services/client-access.service.js gates six named SURFACES. This adds a
 * seventh nothing: answering a permission request is an action on a job the
 * SPOC can already open, exactly like /escalate and /client-request, which are
 * likewise ungated beyond loadJobInScope. Adding a surface would mean editing
 * the SURFACES enum, all five ROLES, and migrating every stored grant CSV — a
 * live access-model change nobody asked for, to gate an action that cannot
 * reach a job the caller could not already act on.
 */

/** The three values both frontends switch on. Nothing else is ever stored. */
const STATUS = { REQUESTED: 'requested', FULFILLED: 'fulfilled', DECLINED: 'declined' };

/** tbl_job_image.image_category for a permission document. */
const DOCUMENT_CATEGORY = 'Permission';

/*
 * Canonical form of a `kind`. Trim + collapse internal whitespace, so
 * "Mall  Gate Pass " and "Mall Gate Pass" are one kind. Casing is preserved —
 * the label is displayed as the technician chose it, and the DB's generated
 * dedupe key lower-cases it for the uniqueness comparison.
 */
function normaliseKind(raw) {
  return String(raw ?? '').trim().replace(/\s+/g, ' ');
}

/*
 * The requester's NAME comes back with the row, as a correlated subquery rather
 * than a per-row lookup in toItem(): toItem runs once per item and the client
 * portal renders a list, so a lookup there would be an N+1 over a panel that is
 * usually one or two rows but need not be.
 *
 * The client dashboard shows "Raised by <name>" — an access request is a person
 * standing at a gate, and a bare technician id tells the person who has to act
 * nothing useful. Null when the technician row is gone; the card then omits the
 * clause rather than printing a hollow "Raised by —".
 */
/*
 * One column list, optionally qualified. The client-wide list joins tbl_job,
 * where bare `id` / `status` / `note` would be ambiguous — and a second
 * hand-copied list is how two queries drift into disagreeing about the shape
 * they both claim to produce.
 */
const rowCols = (alias = '') => {
  const p = alias ? `${alias}.` : '';
  return `${p}id, ${p}job_id, ${p}requested_by_efr_id, ${p}kind, ${p}note, ${p}status,
          ${p}document_image_id, ${p}fulfilled_by_contact_id, ${p}decline_reason,
          ${p}requested_on, ${p}resolved_on,
          (SELECT e.efr_name FROM tbl_easyfixer e
            WHERE e.efr_id = ${p}requested_by_efr_id) AS requested_by_name`;
};
const ROW_COLS = rowCols();

async function rowById(id, db = pool) {
  const [[row]] = await db.query(
    `SELECT ${ROW_COLS} FROM tbl_job_permission_request WHERE id = ? LIMIT 1`, [Number(id)]);
  return row || null;
}

/*
 * DB row → the wire item both frontends consume. The ONE place the wire shape
 * is decided, so the mobile list, the client list and every mutation response
 * are the same object.
 *
 * `resolved_on` surfaces as `fulfilledAt` because the contract carries a single
 * resolution timestamp and no separate declinedAt; on a declined row it is when
 * it was declined. `reason` is additive (the contract's list item omits it) —
 * without it a declined request shows no explanation on either surface.
 */
async function toItem(row) {
  if (!row) return null;
  let documentUrl = null;
  // null = there is no document. 'unknown' = there IS one and we could not
  // establish its type — the frontend then offers a link rather than a render.
  let documentKind = row.document_image_id ? 'unknown' : null;
  let documentMimeType = null;
  if (row.document_image_id) {
    try {
      const [[img]] = await pool.query(
        'SELECT image FROM tbl_job_image WHERE image_id = ? LIMIT 1', [row.document_image_id]);
      if (img && img.image) {
        documentUrl = await s3Storage.resolveImageUrl(img.image);
        const type = await resolveImageType(img.image);
        documentMimeType = type.mimeType;
        documentKind = type.kind;
      }
    } catch (e) {
      // A storage hiccup must not blank the whole list — the row still says
      // "fulfilled", and the tile shows the empty state rather than an error.
      logger.warn('Permission-request document URL unresolved · id=' + row.id + ' · ' + e.message);
    }
  }
  return {
    id: row.id,
    jobId: row.job_id,
    kind: row.kind,
    note: row.note ?? null,
    status: row.status,
    requestedBy: row.requested_by_name ?? null,
    requestedAt: row.requested_on,
    fulfilledAt: row.resolved_on ?? null,
    documentUrl,
    documentKind,
    documentMimeType,
    reason: row.decline_reason ?? null,
  };
}

/** Every request on a job, newest first. Served by idx_jpr_job. */
async function listForJob(jobId) {
  const [rows] = await pool.query(
    `SELECT ${ROW_COLS} FROM tbl_job_permission_request
      WHERE job_id = ? ORDER BY id DESC`, [Number(jobId)]);
  return Promise.all(rows.map(toItem));
}

/*
 * Every open request across a CLIENT's jobs — what the portal's "Pending on
 * you" panel reads. The per-job list above cannot serve it: the client does not
 * know which jobs are waiting, which is the entire question.
 *
 * SCOPED EXACTLY AS loadJobInScope SCOPES ONE JOB, and that is not decoration.
 * Tenancy (fk_client_id) is necessary but NOT sufficient — a SPOC low in the
 * hierarchy must not see requests on a sibling's jobs. `contactIds` is what
 * hierarchyFilter() returns: an array to restrict to, or undefined for a
 * top-level / allStores caller who legitimately sees the whole client. Passing
 * an empty array means "restricted to nothing" and must return nothing, which
 * `IN ()` cannot express — hence the explicit guard rather than a clever SQL
 * fragment.
 *
 * The job context (reference, city, category) rides along so a row is
 * actionable without opening the job; it is merged ON TOP of toItem() rather
 * than inside it, so the wire shape stays decided in exactly one place.
 */
async function listForClient({ clientId, contactIds, status = STATUS.REQUESTED, limit = 100 }) {
  const scoped = Array.isArray(contactIds);
  if (scoped && contactIds.length === 0) return [];
  const bounded = Math.min(Math.max(Number(limit) || 100, 1), 200);

  const [rows] = await pool.query(
    `SELECT ${rowCols('pr')},
            j.job_reference_id, j.client_ref_id,
            COALESCE(city.city_name, 'Unknown') AS city_name,
            COALESCE(tsc.service_catg_name, 'Uncategorised') AS category_name
       FROM tbl_job_permission_request pr
       JOIN tbl_job j ON j.job_id = pr.job_id
       LEFT JOIN tbl_address a
              ON a.customer_id = j.fk_customer_id AND a.address_id = j.fk_address_id
       LEFT JOIN tbl_city city ON city.city_id = a.city_id
       LEFT JOIN tbl_service_catg tsc ON tsc.service_catg_id = j.fk_service_catg_id
      WHERE pr.status = ?
        AND j.fk_client_id = ?
        ${scoped ? 'AND j.reporting_contact_id IN (?)' : ''}
      ORDER BY pr.requested_on ASC
      LIMIT ?`,
    scoped
      ? [status, Number(clientId), contactIds, bounded]
      : [status, Number(clientId), bounded],
  );

  // Oldest first: the panel's claim is "someone is waiting", so the longest
  // wait belongs at the top rather than the newest arrival.
  return Promise.all(rows.map(async (row) => ({
    ...(await toItem(row)),
    reference: row.job_reference_id || row.client_ref_id || null,
    city: row.city_name,
    category: row.category_name,
  })));
}

/** The still-open request for this job+kind, if any. */
async function findOpen(jobId, kind) {
  const [[row]] = await pool.query(
    `SELECT ${ROW_COLS} FROM tbl_job_permission_request
      WHERE job_id = ? AND LOWER(kind) = ? AND status = ? LIMIT 1`,
    [Number(jobId), normaliseKind(kind).toLowerCase(), STATUS.REQUESTED]);
  return row || null;
}

/*
 * Raise a request. IDEMPOTENT ON (job_id, kind) WHILE OPEN: a second tap
 * returns the SAME request, it does not create a second one. Two layers,
 * because they fail at different times —
 *   the read below handles the ordinary double-tap;
 *   the UNIQUE index on the generated open_dedupe_key handles the two writes
 *   that raced past that read (offline outbox flush + a live tap), which is
 *   exactly the case a read-then-write cannot see.
 * `created` tells the caller which happened; the route logs it and returns the
 * same body either way.
 */
async function create({ jobId, efrId, kind, note = null }) {
  const cleanKind = normaliseKind(kind);
  const cleanNote = note == null || String(note).trim() === '' ? null : String(note).trim();

  const open = await findOpen(jobId, cleanKind);
  if (open) {
    logger.info('Permission request already open · job=' + jobId + ' · kind=' + cleanKind + ' · id=' + open.id);
    return { row: open, created: false };
  }

  let insertId;
  try {
    // new Date() + the pool's +05:30 session timezone stores the IST wall clock
    // verbatim. Never NOW() — the container clock is UTC.
    const [ins] = await pool.query(
      `INSERT INTO tbl_job_permission_request
         (job_id, requested_by_efr_id, kind, note, status, requested_on)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [Number(jobId), Number(efrId), cleanKind, cleanNote, STATUS.REQUESTED, new Date()]);
    insertId = ins.insertId;
  } catch (e) {
    if (e && e.code === 'ER_DUP_ENTRY') {
      // Lost the race. The winner's row is the answer — same body, no error.
      const winner = await findOpen(jobId, cleanKind);
      if (winner) {
        logger.info('Permission request race resolved to existing · job=' + jobId + ' · id=' + winner.id);
        return { row: winner, created: false };
      }
    }
    throw e;
  }

  const row = await rowById(insertId);
  logger.info('Permission request raised · id=' + insertId + ' · job=' + jobId
    + ' · kind=' + cleanKind + ' · efr=' + efrId);
  return { row, created: true };
}

/*
 * Fulfil — the client uploads the document. Returns null when the request is
 * not open (already answered), so the route can 409 rather than silently
 * overwrite an answer.
 *
 * `contentType` (2026-09-22, Material Request Flow v2 correction) lets a
 * caller that already validated the file itself (routes/*.js's approve
 * paths — mimetype AND extension, including heic/heif, which
 * uploadJobImage()'s byte-sniff gate does not recognise) hand the storage
 * write its own resolved type via storeJobImageFile directly, bypassing the
 * sniff rather than widening it for every caller. Omit it (the technician
 * upload path, routes/client/index.js) and this sniffs as before.
 */
async function fulfil({ id, jobId, file, spocId, contentType = null }) {
  const row = await rowById(id);
  if (!row || row.status !== STATUS.REQUESTED) return null;

  const uploaded = contentType
    ? await storeJobImageFile({ jobId, file, category: DOCUMENT_CATEGORY, contentType })
    : await uploadJobImage({ jobId, file, category: DOCUMENT_CATEGORY });
  await pool.query(
    `UPDATE tbl_job_permission_request
        SET status = ?, document_image_id = ?, fulfilled_by_contact_id = ?, resolved_on = ?
      WHERE id = ? AND status = ?`,
    [STATUS.FULFILLED, uploaded.image_id, Number(spocId) || null, new Date(), Number(id), STATUS.REQUESTED]);

  logger.info('Permission request fulfilled · id=' + id + ' · job=' + jobId
    + ' · imageId=' + uploaded.image_id + ' · spoc=' + spocId);
  return rowById(id);
}

/** Decline — the client says no, with a reason. null when not open. */
async function decline({ id, reason, spocId }) {
  const row = await rowById(id);
  if (!row || row.status !== STATUS.REQUESTED) return null;

  await pool.query(
    `UPDATE tbl_job_permission_request
        SET status = ?, decline_reason = ?, fulfilled_by_contact_id = ?, resolved_on = ?
      WHERE id = ? AND status = ?`,
    [STATUS.DECLINED, String(reason).trim(), Number(spocId) || null, new Date(), Number(id), STATUS.REQUESTED]);

  logger.info('Permission request declined · id=' + id + ' · spoc=' + spocId);
  return rowById(id);
}

/* ─── Notifications ────────────────────────────────────────────────────────
 *
 * BEST-EFFORT BY CONTRACT. Both functions swallow their own errors and resolve:
 * a technician who reached a locked gate must never be told his request failed
 * because a mailbox was down. The row is the durable record; the notification
 * is a nudge on top of it.
 *
 * Channels are the ones this repo already has, unchanged:
 *   client side     → services/email.service.js (Microsoft Graph)
 *   technician side → services/push-delivery.service.js (FCM, token routing +
 *                     dead-token pruning already solved there)
 *
 * NOT WhatsApp. services/gallabox.whatsapp.service.js sends only PRE-APPROVED
 * templates by templateName; there is no registered template for either of
 * these events, and inventing an id would produce a silent non-delivery (the
 * provider 200s, the handset gets nothing). Adding one is a Gallabox-console
 * task, not a code task — see the handover note.
 */

/*
 * Tell the client a technician is stuck at the door.
 *
 * Recipients: the SPOC who booked the job (tbl_job.reporting_contact_id), and
 * when the job has none — ~9,400 jobs do not, they were booked by the website,
 * an API or ops rather than by a SPOC — every active contact on the client, so
 * the request still reaches someone who can act on it. Capped at 5 so a client
 * with a large contact list does not turn one gate pass into a mail blast.
 */
async function notifyClientOfRequest({ job, row, techName }) {
  try {
    let recipients = [];
    if (job.reporting_contact_id) {
      const [rows] = await pool.query(
        'SELECT contact_email FROM tbl_client_contacts WHERE id = ? AND status = 1', [job.reporting_contact_id]);
      recipients = rows;
    }
    if (!recipients.length) {
      const [rows] = await pool.query(
        `SELECT contact_email FROM tbl_client_contacts
          WHERE client_id = ? AND status = 1 AND contact_email IS NOT NULL AND contact_email <> ''
          ORDER BY id LIMIT 5`, [job.fk_client_id]);
      recipients = rows;
    }
    const to = recipients.map((r) => String(r.contact_email || '').trim()).filter(Boolean);
    if (!to.length) {
      logger.warn('Permission request raised but client has no contact email · job=' + job.job_id);
      return { delivered: false, reason: 'no recipient' };
    }

    const text = `A technician needs site access before he can start this job.\n\n`
      + `Job          : ${job.job_id}${job.client_ref_id ? ` (${job.client_ref_id})` : ''}\n`
      + `Technician   : ${techName || row.requested_by_efr_id}\n`
      + `Asking for   : ${row.kind}\n`
      + (row.note ? `Note         : ${row.note}\n` : '')
      + `\nOpen the Client Dashboard to upload the document, or decline with a reason.`;

    await emailService.send({
      to,
      subject: `Site access needed — Job #${job.job_id} (${row.kind})`,
      text,
      category: 'client.permission-request',
    });
    logger.info('Permission request emailed to client · id=' + row.id + ' · recipients=' + to.length);
    return { delivered: true, recipients: to.length };
  } catch (e) {
    logger.warn('Permission request client notify failed · id=' + row?.id + ' · ' + e.message);
    return { delivered: false, error: e.message };
  }
}

/*
 * Tell the technician the client answered. `data.type` is 'permission_request'
 * so the app can re-fetch the job's requests on receipt rather than poll —
 * the same data-push pattern registration-status-push uses.
 */
async function notifyTechOfAnswer(row) {
  try {
    const fulfilled = row.status === STATUS.FULFILLED;
    const body = fulfilled
      ? `The client has uploaded the ${row.kind} for your job — open the app to view it.`
      : `The client could not provide the ${row.kind}. Open the app to see why.`;
    return await pushDelivery.deliverToEfr(
      row.requested_by_efr_id,
      {
        title: 'EasyFix',
        body,
        data: {
          type: 'permission_request',
          status: row.status,
          jobId: String(row.job_id),
          requestId: String(row.id),
        },
      },
      { channel: 'permission-request', label: `permission-request · efr=${row.requested_by_efr_id} · job=${row.job_id}` },
    );
  } catch (e) {
    logger.warn('Permission request tech notify failed · id=' + row?.id + ' · ' + e.message);
    return { delivered: false, error: e.message };
  }
}

/*
 * Raise (and, for 'now', immediately fulfil) an "Entry Permission" ask FROM
 * THE APPROVAL ITSELF — Material Request Flow v2, 2026-09-22 correction. The
 * client/CRM approving the material estimate says whether the technician will
 * need help getting on site for the chosen visit; this is the one place all
 * three approve surfaces (client portal, public link, admin on-behalf) land
 * that choice, exactly the way approveEstimateLinesAndStatus is the one place
 * they land the estimate approval itself.
 *
 * THE RAISER. create() above assumes a technician raises his own request
 * (`efrId` is the caller, checked at the mobile route). Here the CLIENT/CRM is
 * raising it, and requested_by_efr_id is NOT NULL with no column for "raised
 * by someone else" — this change ships no migration to add one. So the ask is
 * attributed to the JOB'S OWN assigned technician: an entry-permission ask
 * only ever matters for whoever ends up standing at the gate, so that
 * attribution is honest even though he did not personally raise it. Returns
 * null when the job has no technician (nobody to attribute it to, and nobody
 * who needs to get in yet) — this never throws for that reason alone.
 *
 * NEVER NOTIFIES THE CLIENT. create()'s own notifyClientOfRequest() is an
 * opt-in the CALLER fires (see routes/mobile/permission-requests.js) — this
 * function simply never calls it, so "a technician requested a document" can
 * never be emailed to the very client who just raised the ask themselves. The
 * technician still sees the row through the existing job-scoped
 * GET /api/mobile/jobs/:jobId/permission-requests, unaffected by who raised it.
 */
async function raiseForApproval({
  jobId, efrId, kind = 'Entry Permission', note = null,
  fulfilNow = false, file = null, fileContentType = null, spocId = null,
}) {
  if (!efrId) return null;
  const { row } = await create({ jobId, efrId, kind, note });
  if (!row) return null;
  if (fulfilNow && file) {
    await fulfil({
      id: row.id, jobId, file, spocId, contentType: fileContentType,
    });
  }
  return { requestId: row.id };
}

module.exports = {
  STATUS,
  DOCUMENT_CATEGORY,
  normaliseKind,
  toItem,
  listForJob,
  listForClient,
  findOpen,
  create,
  fulfil,
  decline,
  raiseForApproval,
  notifyClientOfRequest,
  notifyTechOfAnswer,
};
