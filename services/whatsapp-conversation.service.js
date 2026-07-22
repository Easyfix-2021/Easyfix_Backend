const logger = require('../logger');
const gallabox = require('./gallabox.whatsapp.service');
const ai = require('./ai.service');
const maps = require('./maps.service');
const jml = require('./job-magic-link.service');
const s3 = require('../utils/s3-storage');

/*
 * services/whatsapp-conversation.service.js
 *
 * Inbound, stateful, AI-assisted WhatsApp conversation that collects an
 * unconfirmed order's customer-side details IN CHAT (an alternative to the
 * magic-link FORM, selectable per client). Built on Gallabox.
 *
 * Flow (per the CultFit spec):
 *   awaiting_datetime        → customer types a date/time (AI-parsed) OR taps
 *                              "I Don't Need a Service"
 *   awaiting_no_service_reason → 3 buttons: Self Assembly / Site not ready /
 *                              Work already done → log tbl_job_customer_request
 *   awaiting_media_choice    → buttons: Upload Pics/Video | I don't have pics
 *   awaiting_media           → ingest photos (tbl_job_image) + videos
 *                              (tbl_job_media) until "Done"
 *   awaiting_location        → location pin (reverse-geocoded) OR typed address
 *                              → FINALIZE (writeCustomerOrderDetails) → thank-you
 *
 * State lives in tbl_whatsapp_conversation (one active row per job). The state
 * machine owns the flow + writes; ai.service only interprets free text. All
 * outbound sends honour NOTIFICATIONS_DISABLE + TEST_MOBILE via the gallabox
 * senders. The FIRST message is a pre-approved template (24h-window rule);
 * everything after is free-form/interactive in-session.
 */

// Stable button ids the inbound webhook maps interactive replies onto.
const BTN = {
  NO_SERVICE:   'no_service',
  REASON_SELF:  'reason_self_assembly',
  REASON_SITE:  'reason_site_not_ready',
  REASON_DONE:  'reason_work_completed',
  UPLOAD:       'upload_media',
  NO_PICS:      'no_pics',
  MEDIA_DONE:   'media_done',
};

const STEP = {
  DATETIME:   'awaiting_datetime',
  NO_SERVICE: 'awaiting_no_service_reason',
  MEDIA_PICK: 'awaiting_media_choice',
  MEDIA:      'awaiting_media',
  LOCATION:   'awaiting_location',
};

const MAX_PHOTOS = 5;
const SESSION_HOURS = 24;

// Pre-approved Gallabox template that OPENS the conversation. Hardcoded to
// `confirm_order_flow` to match the same pattern as the magic-link FORM flow
// (`confirm_order` in services/job-magic-link.service.js, also a string
// literal). The Gallabox wrapper resolves templates by NAME, not id — id
// (e.g. 6a15430b61391f6456078776) is only used inside the Gallabox dashboard
// for authoring. Body variables: {1}=CustomerName, {2}=ClientName. The
// "I Don't Need a Service" quick-reply is part of the template definition.
const CONVERSATION_TEMPLATE_NAME = 'confirm_order_flow';

// AI 'YYYY-MM-DDTHH:mm' (IST wall-clock) → MySQL 'YYYY-MM-DD HH:mm:00'. Null on
// anything that doesn't match — we never write a malformed datetime.
function toMysqlDatetime(s) {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::\d{2})?$/.exec(String(s || '').trim());
  return m ? `${m[1]} ${m[2]}:00` : null;
}

function parseContext(row) {
  if (!row || row.context == null) return {};
  if (typeof row.context === 'object') return row.context;
  try { return JSON.parse(row.context); } catch { return {}; }
}

async function getActiveByMobile(mobile, pool) {
  const norm = gallabox.normaliseIndianPhone(mobile) || String(mobile || '');
  const last10 = norm.replace(/\D/g, '').slice(-10);
  // Match on the last 10 digits so 91-prefix / no-prefix variants both resolve.
  const [rows] = await pool.query(
    `SELECT * FROM tbl_whatsapp_conversation
      WHERE status = 'active' AND RIGHT(REPLACE(customer_mob_no, ' ', ''), 10) = ?
      ORDER BY conversation_id DESC LIMIT 1`,
    [last10],
  );
  return rows[0] || null;
}

async function updateConversation(id, fields, pool) {
  const sets = [];
  const params = [];
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'context') { sets.push('context = ?'); params.push(JSON.stringify(v || {})); }
    else { sets.push(`${k} = ?`); params.push(v); }
  }
  if (!sets.length) return;
  params.push(id);
  await pool.query(`UPDATE tbl_whatsapp_conversation SET ${sets.join(', ')} WHERE conversation_id = ?`, params);
}

/*
 * startConversation(jobId, { action }, pool)
 *
 * Sends the initiating (pre-approved) template and upserts an active
 * conversation row at step awaiting_datetime. Reuses the magic_link_* audit
 * columns on tbl_job for send cadence/cap (shared with the form path).
 * Returns { delivered, conversationId } or { error }.
 */
async function startConversation(jobId, { action = 'first' } = {}, pool) {
  logger.info('Starting WhatsApp conversation · job=' + jobId + ' · action=' + action);
  const [[job]] = await pool.query(
    `SELECT j.job_id, j.job_status,
            c.customer_mob_no,
            COALESCE(j.job_customer_name, c.customer_name) AS customer_name,
            cl.client_name
       FROM tbl_job j
  LEFT JOIN tbl_customer c ON c.customer_id = j.fk_customer_id
  LEFT JOIN tbl_client   cl ON cl.client_id = j.fk_client_id
      WHERE j.job_id = ? LIMIT 1`,
    [jobId],
  );
  if (!job) logger.warn('Start conversation skipped · job ' + jobId + ' not found');
  if (!job) return { error: 'job not found' };
  if (Number(job.job_status) !== 9) logger.warn('Start conversation skipped · job=' + jobId + ' not Unconfirmed · status=' + job.job_status);
  if (Number(job.job_status) !== 9) return { error: 'job is not Unconfirmed (status != 9)' };
  if (!job.customer_mob_no) logger.warn('Start conversation skipped · job=' + jobId + ' has no customer mobile on file');
  if (!job.customer_mob_no) return { error: 'no customer mobile on file' };

  const result = await gallabox.sendTemplate({
    to: job.customer_mob_no,
    recipientName: job.customer_name || '',
    templateName: CONVERSATION_TEMPLATE_NAME,
    bodyValues: { 1: job.customer_name || 'there', 2: job.client_name || 'EasyFix' },
  });

  // Upsert the conversation row regardless of delivery (so an inbound reply
  // still resolves even if the provider ack was flaky) — but only when we
  // actually attempted a send (not suppressed-disabled in dev).
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 3600 * 1000);
  const [existing] = await pool.query(
    `SELECT conversation_id FROM tbl_whatsapp_conversation
      WHERE job_id = ? AND status = 'active' ORDER BY conversation_id DESC LIMIT 1`,
    [jobId],
  );
  let conversationId;
  if (existing[0]) {
    conversationId = existing[0].conversation_id;
    await updateConversation(conversationId, {
      current_step: STEP.DATETIME, context: {}, expires_at: expiresAt,
    }, pool);
  } else {
    const [ins] = await pool.query(
      `INSERT INTO tbl_whatsapp_conversation
         (job_id, customer_mob_no, status, current_step, context, expires_at)
       VALUES (?, ?, 'active', ?, ?, ?)`,
      [jobId, job.customer_mob_no, STEP.DATETIME, JSON.stringify({}), expiresAt],
    );
    conversationId = ins.insertId;
  }

  // Reuse the magic-link audit columns for cadence (shared cron cap).
  await pool.query(
    `UPDATE tbl_job
        SET magic_link_sent_at = NOW(),
            magic_link_send_count = magic_link_send_count + 1,
            magic_link_last_action = ?
      WHERE job_id = ?`,
    [`conversation_${action}`, jobId],
  );

  logger.info({ jobId, conversationId, delivered: result.delivered }, 'whatsapp-conversation: started');
  return { delivered: !!result.delivered, suppressed: !!result.disabled, conversationId };
}

/*
 * handleInbound(inbound, pool)
 *
 * Entry point from the webhook. `inbound` is the normalised shape the webhook
 * builds:
 *   { from, messageId, type: 'text'|'button'|'location'|'image'|'video',
 *     text?, buttonId?, location?: {lat,lng}, media?: {url, kind:'image'|'video'} }
 * Returns { handled: boolean, step?, reason? }.
 */
async function handleInbound(inbound, pool) {
  logger.info('Handling inbound WhatsApp message · type=' + (inbound && inbound.type));
  const convo = await getActiveByMobile(inbound.from, pool);
  if (!convo) logger.info('No active WhatsApp conversation for inbound message');
  if (!convo) return { handled: false, reason: 'no_active_conversation' };

  // Dedupe provider retries.
  if (inbound.messageId && convo.last_inbound_msg_id === inbound.messageId) {
    logger.info('Ignoring duplicate inbound message · job=' + convo.job_id);
    return { handled: false, reason: 'duplicate' };
  }

  // Session expiry — free-form replies are only valid inside the 24h window.
  if (convo.expires_at && new Date(convo.expires_at).getTime() < Date.now()) {
    logger.info('WhatsApp conversation expired · job=' + convo.job_id);
    await updateConversation(convo.conversation_id, { status: 'expired' }, pool);
    return { handled: false, reason: 'expired' };
  }

  await updateConversation(convo.conversation_id, {
    last_inbound_msg_id: inbound.messageId || null,
    last_inbound_at: new Date(),
  }, pool);

  const ctx = parseContext(convo);
  const to = convo.customer_mob_no;

  logger.info('Routing WhatsApp inbound · job=' + convo.job_id + ' · step=' + convo.current_step + ' · type=' + inbound.type);
  try {
    switch (convo.current_step) {
      case STEP.DATETIME:       return await stepDatetime(convo, ctx, inbound, to, pool);
      case STEP.NO_SERVICE:     return await stepNoServiceReason(convo, ctx, inbound, to, pool);
      case STEP.MEDIA_PICK:     return await stepMediaChoice(convo, ctx, inbound, to, pool);
      case STEP.MEDIA:          return await stepMedia(convo, ctx, inbound, to, pool);
      case STEP.LOCATION:       return await stepLocation(convo, ctx, inbound, to, pool);
      default:
        return { handled: false, reason: `unknown_step:${convo.current_step}` };
    }
  } catch (err) {
    logger.error({ jobId: convo.job_id, step: convo.current_step, err: err && err.message }, 'whatsapp-conversation: step failed');
    await gallabox.sendText({ to, body: 'Sorry, something went wrong on our side. Please try again in a moment.' });
    return { handled: false, reason: 'error' };
  }
}

// ── Step handlers ───────────────────────────────────────────────────────

async function sendNoServiceButtons(to) {
  return gallabox.sendButtons({
    to,
    body: 'No problem. Could you tell us why?',
    buttons: [
      { id: BTN.REASON_SELF, title: 'Self Assembly' },
      { id: BTN.REASON_SITE, title: 'Site not ready' },
      { id: BTN.REASON_DONE, title: 'Work already done' },
    ],
  });
}

async function sendMediaChoice(to) {
  return gallabox.sendButtons({
    to,
    body: 'Great! To help us understand the problem and bring the right solution, you can share photos or a short video.',
    buttons: [
      { id: BTN.UPLOAD, title: 'Upload Pics/Video' },
      { id: BTN.NO_PICS, title: "I don't have pics" },
    ],
  });
}

async function sendLocationPrompt(to) {
  return gallabox.sendLocationRequest({
    to,
    body: 'Lastly, please share your address location so the technician can reach you. Tap the button to share your GPS location, or simply type your full address.',
  });
}

async function stepDatetime(convo, ctx, inbound, to, pool) {
  // Explicit "no service" button on the initiating template.
  if (inbound.type === 'button' && inbound.buttonId === BTN.NO_SERVICE) {
    await sendNoServiceButtons(to);
    await updateConversation(convo.conversation_id, { current_step: STEP.NO_SERVICE }, pool);
    return { handled: true, step: STEP.NO_SERVICE };
  }

  if (inbound.type !== 'text' || !inbound.text) {
    await gallabox.sendText({ to, body: 'Please reply with your preferred date and time for the technician visit (e.g. "15 Jun, 3–7 PM").' });
    return { handled: true, step: STEP.DATETIME };
  }

  const nlu = await ai.interpretReply({ step: STEP.DATETIME, text: inbound.text, timeSlots: jml.TIME_SLOTS });

  if (nlu.intent === 'no_service') {
    await sendNoServiceButtons(to);
    await updateConversation(convo.conversation_id, { current_step: STEP.NO_SERVICE }, pool);
    return { handled: true, step: STEP.NO_SERVICE };
  }

  if (nlu.intent === 'datetime') {
    const mysqlDt = toMysqlDatetime(nlu.datetime);
    if (!mysqlDt) {
      await gallabox.sendText({ to, body: 'Sorry, I couldn’t read that date/time. Please share it like "15 Jun, 3–7 PM" or "tomorrow 11am".' });
      return { handled: true, step: STEP.DATETIME };
    }
    const nextCtx = { ...ctx, requested_date_time: mysqlDt, time_slot: nlu.time_slot || null };
    logger.info('Captured requested date/time · job=' + convo.job_id + ' · when=' + mysqlDt);
    await updateConversation(convo.conversation_id, { current_step: STEP.MEDIA_PICK, context: nextCtx }, pool);
    const human = nlu.datetime.replace('T', ' ');
    await gallabox.sendText({ to, body: `Thanks! We’ve noted ${human}${nlu.time_slot ? ` (${nlu.time_slot})` : ''} for the visit.` });
    await sendMediaChoice(to);
    return { handled: true, step: STEP.MEDIA_PICK };
  }

  // unclear / disabled
  await gallabox.sendText({ to, body: 'Sorry, I didn’t catch that. Please reply with a date and time for the technician visit (e.g. "15 Jun, 3–7 PM"), or tap "I Don\'t Need a Service".' });
  return { handled: true, step: STEP.DATETIME };
}

async function stepNoServiceReason(convo, ctx, inbound, to, pool) {
  // Map a button id, else let AI map typed text to a reason.
  let reason = null; // { type, label }
  const byId = {
    [BTN.REASON_SELF]: { type: 'cancel',     label: 'Self Assembly' },
    [BTN.REASON_SITE]: { type: 'reschedule', label: 'Site Not Ready' },
    [BTN.REASON_DONE]: { type: 'cancel',     label: 'Work already completed' },
  };
  if (inbound.type === 'button' && byId[inbound.buttonId]) {
    reason = byId[inbound.buttonId];
  } else if (inbound.type === 'text') {
    const nlu = await ai.interpretReply({ step: STEP.NO_SERVICE, text: inbound.text, timeSlots: [] });
    if (nlu.reason === 'self_assembly') reason = byId[BTN.REASON_SELF];
    else if (nlu.reason === 'site_not_ready') reason = byId[BTN.REASON_SITE];
    else if (nlu.reason === 'work_completed') reason = byId[BTN.REASON_DONE];
  }

  if (!reason) {
    await sendNoServiceButtons(to);
    return { handled: true, step: STEP.NO_SERVICE };
  }

  await pool.query(
    `INSERT INTO tbl_job_customer_request (job_id, request_type, reason, remarks)
     VALUES (?, ?, ?, ?)`,
    [convo.job_id, reason.type, reason.label, 'Logged via WhatsApp conversation'],
  );
  // Mirror the ask into the job comment thread (tbl_job_comment) so it also
  // shows in the CRM "Remarks / Comments" panel — the web magic-link path
  // (routes/public/job-completion.js) already does this; without the mirror a
  // WhatsApp-origin reschedule/cancel reason is invisible there. Best-effort:
  // the request row above is the source of truth, so a comment hiccup must
  // never break the customer's WhatsApp reply. comment_on=1 = lifecycle.
  try {
    const label = reason.type === 'cancel' ? 'Cancellation' : 'Reschedule';
    await require('./job-comment.service').addComment(convo.job_id, {
      comments: `${label} requested (via WhatsApp): ${reason.label}`,
      comment_on: 1,
      commented_by: null,
      appointment_on: null,
    });
  } catch (e) {
    logger.warn({ jobId: convo.job_id, err: e && e.message }, 'whatsapp-conversation: comment mirror failed');
  }
  await updateConversation(convo.conversation_id, {
    status: 'closed_no_service',
    context: { ...ctx, no_service_reason: reason.label, request_type: reason.type },
  }, pool);
  await gallabox.sendText({ to, body: 'Thank you — we’ve noted that and our team will update your order. No visit will be scheduled.' });
  logger.info({ jobId: convo.job_id, reason: reason.label, type: reason.type }, 'whatsapp-conversation: no-service request logged');
  return { handled: true, step: 'closed_no_service' };
}

async function stepMediaChoice(convo, ctx, inbound, to, pool) {
  if (inbound.type === 'button' && inbound.buttonId === BTN.UPLOAD) {
    await updateConversation(convo.conversation_id, { current_step: STEP.MEDIA }, pool);
    await gallabox.sendButtons({
      to,
      body: 'Please send your photos or video now. Tap "Done" when you’ve finished.',
      buttons: [{ id: BTN.MEDIA_DONE, title: 'Done' }],
    });
    return { handled: true, step: STEP.MEDIA };
  }
  if (inbound.type === 'button' && inbound.buttonId === BTN.NO_PICS) {
    await updateConversation(convo.conversation_id, { current_step: STEP.LOCATION }, pool);
    await sendLocationPrompt(to);
    return { handled: true, step: STEP.LOCATION };
  }
  // Anything else → re-show the choice.
  await sendMediaChoice(to);
  return { handled: true, step: STEP.MEDIA_PICK };
}

async function stepMedia(convo, ctx, inbound, to, pool) {
  // "Done" → move on to location.
  if ((inbound.type === 'button' && inbound.buttonId === BTN.MEDIA_DONE)
      || (inbound.type === 'text' && /^\s*done\s*$/i.test(inbound.text || ''))) {
    await updateConversation(convo.conversation_id, { current_step: STEP.LOCATION }, pool);
    await sendLocationPrompt(to);
    return { handled: true, step: STEP.LOCATION };
  }

  if ((inbound.type === 'image' || inbound.type === 'video') && inbound.media && inbound.media.url) {
    const isVideo = inbound.type === 'video';
    const dl = await gallabox.fetchInboundMedia({ url: inbound.media.url });
    if (dl.error) {
      await gallabox.sendText({ to, body: 'Sorry, we couldn’t download that file. Please try again, or tap "Done".' });
      return { handled: true, step: STEP.MEDIA };
    }

    if (isVideo) {
      const [[{ vcount }]] = await pool.query('SELECT COUNT(*) AS vcount FROM tbl_job_media WHERE job_id = ?', [convo.job_id]);
      const seq = Number(vcount) + 1;
      const key = await s3.putJobImage({
        jobId: convo.job_id, seq, buffer: dl.buffer,
        contentType: dl.contentType, originalName: `whatsapp_video_${seq}`, category: 'BookingVideo',
      });
      await pool.query(
        `INSERT INTO tbl_job_media (job_id, s3_key, content_type, source) VALUES (?, ?, ?, 'customer_whatsapp')`,
        [convo.job_id, key, dl.contentType || null],
      );
      logger.info('Saved customer WhatsApp video · job=' + convo.job_id + ' · seq=' + seq);
      const nextCtx = { ...ctx, video_count: (ctx.video_count || 0) + 1 };
      await updateConversation(convo.conversation_id, { context: nextCtx }, pool);
    } else {
      const [[{ icount }]] = await pool.query('SELECT COUNT(*) AS icount FROM tbl_job_image WHERE job_id = ?', [convo.job_id]);
      if (Number(icount) >= MAX_PHOTOS) {
        await gallabox.sendButtons({
          to, body: `You’ve reached the limit of ${MAX_PHOTOS} photos. Tap "Done" to continue.`,
          buttons: [{ id: BTN.MEDIA_DONE, title: 'Done' }],
        });
        return { handled: true, step: STEP.MEDIA };
      }
      const seq = Number(icount) + 1;
      const key = await s3.putJobImage({
        jobId: convo.job_id, seq, buffer: dl.buffer,
        contentType: dl.contentType, originalName: `whatsapp_photo_${seq}`, category: 'Booking',
      });
      await pool.query(
        `INSERT INTO tbl_job_image (job_id, image, image_category, job_stage, created_date)
         VALUES (?, ?, 'booking', 0, NOW())`,
        [convo.job_id, key],
      );
      logger.info('Saved customer WhatsApp photo · job=' + convo.job_id + ' · seq=' + seq);
      const nextCtx = { ...ctx, photo_count: (ctx.photo_count || 0) + 1 };
      await updateConversation(convo.conversation_id, { context: nextCtx }, pool);
    }

    await gallabox.sendButtons({
      to, body: 'Got it ✅ Send another, or tap "Done".',
      buttons: [{ id: BTN.MEDIA_DONE, title: 'Done' }],
    });
    return { handled: true, step: STEP.MEDIA };
  }

  // Unexpected input at media step — nudge.
  await gallabox.sendButtons({
    to, body: 'Please send a photo or video, or tap "Done".',
    buttons: [{ id: BTN.MEDIA_DONE, title: 'Done' }],
  });
  return { handled: true, step: STEP.MEDIA };
}

async function finalize(convo, ctx, addressFields, to, pool) {
  const fields = {
    requested_date_time: ctx.requested_date_time || null,
    time_slot: ctx.time_slot || null,
    ...addressFields,
    payload: { ...ctx, ...addressFields, channel: 'whatsapp_conversation' },
  };
  await jml.writeCustomerOrderDetails(convo.job_id, fields, pool);
  await updateConversation(convo.conversation_id, { status: 'completed', context: fields.payload }, pool);
  await gallabox.sendText({ to, body: 'Thank you! We’ve received all your details and will confirm your technician visit shortly. 🙌' });
  logger.info({ jobId: convo.job_id }, 'whatsapp-conversation: completed');
  return { handled: true, step: 'completed' };
}

async function stepLocation(convo, ctx, inbound, to, pool) {
  if (inbound.type === 'location' && inbound.location) {
    // Pass the pool so reverseGeocode also resolves city_name → city_id from
    // tbl_city (memoised). Falls back to null silently if no match, so the
    // finalize write still lands with gps + address + pin even when the city
    // name is novel.
    const geo = await maps.reverseGeocode(inbound.location.lat, inbound.location.lng, pool);
    return finalize(convo, ctx, {
      gps_location: geo.gps_location,
      address: geo.formatted_address || null,
      pin_code: geo.pin_code || null,
      city_id: geo.city_id || null,
    }, to, pool);
  }
  if (inbound.type === 'text' && inbound.text && inbound.text.trim()) {
    return finalize(convo, ctx, { address: inbound.text.trim() }, to, pool);
  }
  await sendLocationPrompt(to);
  return { handled: true, step: STEP.LOCATION };
}

module.exports = {
  startConversation,
  handleInbound,
  STEP,
  BTN,
  toMysqlDatetime,
};
