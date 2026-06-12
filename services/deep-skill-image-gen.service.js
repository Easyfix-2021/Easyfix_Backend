/*
 * Deep Skill Image Auto-Generation pipeline (2026-06-12).
 *
 * Background fire-and-forget service that creates a DALL-E thumbnail
 * for a deep-skill row when the operator didn't upload one manually.
 * Triggered post-commit from `services/deep-skill.service.js::create()`
 * and `update()`, plus the manual `POST /:id/regenerate-image` route.
 *
 * Pipeline per skill id:
 *   1. Load skill row + active options.
 *   2. Build a DALL-E prompt from name + option list.
 *   3. POST to OpenAI /v1/images/generations (model = `getModel()`).
 *   4. Download the returned URL into a Buffer.
 *   5. Claim the DB row (guarded UPDATE — only while `deepskill_image`
 *      is still empty) with the computed key Skills/Skill_<id>_<seq>.
 *      affectedRows === 0 means a manual upload landed mid-generation:
 *      manual wins, the auto-gen result is discarded (no S3 write).
 *   6. Upload via `s3Storage.putSkillImage`; on failure the claim is
 *      reverted so the row never points at a nonexistent object.
 *   7. Invalidate the catalog + bulk-image caches.
 *   8. Bump the success counter; fire a budget-alert email if a
 *      milestone was just crossed.
 *
 * On any failure the row is marked `image_gen_status = 'failed'` (so
 * the FE can render a Retry button) and the counter is NOT bumped —
 * only successful generations count toward the budget.
 *
 * Single-flight: `inflightImageGen` Set prevents two concurrent
 * dispatches for the same skill id from racing to S3 + the DB.
 *
 * Per CLAUDE.md: parameterised SQL only, `logger` not console.log,
 * modern {success,data} responses upstream in the route handler.
 */

const { pool } = require('../db');
const logger = require('../logger');
const s3Storage = require('../utils/s3-storage');
const propertiesService = require('./properties.service');
const emailService = require('./email.service');
const { invalidateCatalogCaches } = require('./easyfixer-profile-update-link.service');
const deepSkillService = require('./deep-skill.service');

const OPENAI_IMAGES_URL = 'https://api.openai.com/v1/images/generations';

/*
 * In-code pricing snapshot — single source of truth for the cost figures
 * embedded in budget-alert emails. Updated alongside any model-swap PR
 * so the "current" price is whatever the OpenAI dashboard charges at
 * the time we shipped this build. NOT a property — see plan section
 * "Realtime Pricing Lookup" for the rationale.
 *
 * Source: https://openai.com/api/pricing — all values are USD per image.
 */
const PRICING_USD = {
  'dall-e-3': {
    '1024x1024': { standard: 0.040, hd: 0.080 },
    '1024x1792': { standard: 0.080, hd: 0.120 },
    '1792x1024': { standard: 0.080, hd: 0.120 },
  },
  'dall-e-2': {
    '1024x1024': { standard: 0.020 },
    '512x512':   { standard: 0.018 },
    '256x256':   { standard: 0.016 },
  },
  'gpt-image-1': {
    // gpt-image-1 is token-billed; values are mid-range per-image approximations.
    '1024x1024': { low: 0.011, medium: 0.042, high: 0.167 },
  },
};

function getUnitCostUsd(model, size, quality) {
  const m = PRICING_USD[model] ?? PRICING_USD['dall-e-3'];
  const s = m[size] ?? m['1024x1024'];
  return s[quality] ?? s.standard ?? Object.values(s)[0];
}

/*
 * Model selector — env override with a DALL-E 3 fallback. Per the
 * user's design call, DALL-E 3 is the default when the env var is
 * unset; ops can swap to gpt-image-1 / dall-e-2 by setting
 * DEEP_SKILL_IMAGE_GEN_MODEL without code changes.
 */
function getModel() {
  return process.env.DEEP_SKILL_IMAGE_GEN_MODEL || 'dall-e-3';
}

/*
 * Runtime gate: feature property must be truthy AND the OpenAI API
 * key must be present. Either being off short-circuits all dispatches
 * so the kill switch is instant.
 */
async function isAutoGenEnabled() {
  if (!process.env.OPENAI_API_KEY) return false;
  const raw = propertiesService.getProperty('deep_skill.auto_generate_image.enabled');
  // Cold-cache reads return undefined — treat as disabled until preload
  // resolves. Subsequent calls pick up the actual value.
  if (raw === undefined || raw === null) return false;
  const v = String(raw).trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

/*
 * Compose the DALL-E prompt. Skill name + comma-joined active options
 * + style guard-rails (flat illustration, white background, no text,
 * no faces, square crop) — keeps the output usable as a catalog
 * thumbnail and prevents accidental prompt injection from option text
 * (we never feed operator-controlled strings into a code-fence or
 * system role here, it's straight literal text).
 */
function buildPrompt(skill, options) {
  const name = String(skill?.deepskill_name || '').trim() || 'service skill';
  const optList = Array.isArray(options) ? options : [];
  const optNames = optList
    .map((o) => String(o?.skill_option || '').trim())
    .filter(Boolean);
  const aspectClause = optNames.length
    ? `, including aspects: ${optNames.join(', ')}`
    : '';
  return [
    `Flat illustrative icon of a technician performing ${name}${aspectClause}.`,
    'Clean white background, vector-style, suitable for a service catalog',
    "thumbnail. No text, no logos, no humans' faces. 1024x1024 square.",
  ].join(' ');
}

/*
 * Module-scope single-flight guard. setImmediate dispatches add the id,
 * the orchestrator removes it in its finally block. A second dispatch
 * for the same id while the first is still in-flight is a silent no-op.
 */
const inflightImageGen = new Set();

/*
 * OpenAI POST + image download core (extracted 2026-06-12). Steps 2-3
 * of the original generateImage flow, made reusable so both the async
 * background pipeline and the two synchronous on-demand endpoints
 * (generateForSkill / generatePreview) share identical fetch + download
 * + content-type handling.
 *
 * A 60s AbortSignal bounds BOTH the OpenAI generation call and the
 * image download — a hung upstream fails cleanly instead of holding a
 * request (or background worker) open forever. Throws on any failure;
 * the caller decides whether to markFailed (background) or surface a
 * 502 (sync routes).
 */
async function fetchGeneratedImageBuffer(prompt) {
  const model = getModel();
  const size = '1024x1024';
  const quality = 'standard';

  // 2. OpenAI HTTP call — mirrors the fetch shape in ai.service.js.
  const genController = new AbortController();
  const genTimer = setTimeout(() => genController.abort(), 60000);
  let res;
  try {
    res = await fetch(OPENAI_IMAGES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        prompt,
        n: 1,
        size,
        quality,
        response_format: 'url',
      }),
      signal: genController.signal,
    });
  } finally {
    clearTimeout(genTimer);
  }
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throw new Error(`OpenAI images HTTP ${res.status}: ${body}`);
  }
  const data = await res.json();
  const url = data?.data?.[0]?.url;
  if (!url) throw new Error('OpenAI images response missing data[0].url');

  // 3. Download to buffer (also bounded by a 60s timeout).
  const dlController = new AbortController();
  const dlTimer = setTimeout(() => dlController.abort(), 60000);
  let dl;
  try {
    dl = await fetch(url, { signal: dlController.signal });
  } finally {
    clearTimeout(dlTimer);
  }
  if (!dl.ok) throw new Error(`Image download HTTP ${dl.status}`);
  let contentType = 'image/png';
  const ct = dl.headers.get('content-type');
  if (ct && /^image\//i.test(ct)) contentType = ct.split(';')[0].trim();
  const ab = await dl.arrayBuffer();
  const buffer = Buffer.from(ab);
  if (!buffer.length) throw new Error('Downloaded image buffer empty');
  return { buffer, contentType };
}

function dispatch(skillId) {
  const id = Number(skillId);
  if (!Number.isInteger(id) || id <= 0) return false;
  if (inflightImageGen.has(id)) {
    logger.info(`deep-skill-image-gen: dispatch skipped — already in-flight skillId=${id}`);
    return false;
  }
  inflightImageGen.add(id);
  setImmediate(() => {
    generateImage(id)
      .catch((err) => {
        // generateImage handles its own markFailed; this catch is the
        // last-resort net for anything that escaped (logger throws etc).
        logger.warn({ err: err && err.message, skillId: id },
          'deep-skill-image-gen: dispatch outer catch');
      })
      .finally(() => {
        inflightImageGen.delete(id);
      });
  });
  return true;
}

/*
 * Mark a row as failed without bumping the success counter. Best-effort
 * — a UPDATE failure here just leaves the row in 'pending' which the
 * FE renders with the same spinner; ops can retry manually.
 */
async function markFailed(skillId, err) {
  try {
    await pool.query(
      `UPDATE tbl_deep_skill
          SET image_gen_status = 'failed',
              image_gen_attempted_at = NOW()
        WHERE deepskill_id = ?`,
      [skillId],
    );
  } catch (e) {
    logger.warn({ err: e && e.message, skillId },
      'deep-skill-image-gen: markFailed UPDATE failed (non-fatal)');
  }
  logger.warn({ err: err && err.message, skillId },
    'deep-skill-image-gen: generation failed');
}

/*
 * Orchestrator. Single skillId in, side-effects out. Throws on any
 * fatal step; the catch block marks the row failed and re-throws so
 * dispatch's outer catch can log too.
 */
async function generateImage(skillId) {
  const id = Number(skillId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`generateImage: invalid skillId=${skillId}`);
  }

  let skillRow;
  let options;
  try {
    // 1. Load skill + active options.
    const [[row]] = await pool.query(
      `SELECT deepskill_id, deepskill_name, deepskill_description,
              deepskill_image, status
         FROM tbl_deep_skill
        WHERE deepskill_id = ? LIMIT 1`,
      [id],
    );
    if (!row) {
      logger.warn(`deep-skill-image-gen: skill ${id} not found — abort`);
      return;
    }
    // Soft-deleted skills never get auto-gen — match the create/update
    // guard in deep-skill.service.js.
    if (Number(row.status) !== 1) {
      logger.info(`deep-skill-image-gen: skill ${id} inactive — abort`);
      return;
    }
    // Don't clobber an image somebody uploaded after the dispatch was queued.
    if (row.deepskill_image && String(row.deepskill_image).trim()) {
      logger.info(`deep-skill-image-gen: skill ${id} already has image — abort`);
      // Clear pending state so the FE badge disappears.
      await pool.query(
        `UPDATE tbl_deep_skill SET image_gen_status = NULL WHERE deepskill_id = ?`,
        [id],
      );
      return;
    }
    skillRow = row;

    const [optRows] = await pool.query(
      `SELECT id, skill_option
         FROM tbl_deepskill_options
        WHERE deepskill_id = ? AND status = 1
        ORDER BY id`,
      [id],
    );
    options = optRows;
  } catch (e) {
    await markFailed(id, e);
    return;
  }

  const model = getModel();
  const prompt = buildPrompt(skillRow, options);

  let imageBuffer;
  let imageContentType = 'image/png';
  try {
    // Steps 2-3 (OpenAI POST + download) now live in the shared helper.
    logger.info(`deep-skill-image-gen: skill=${id} model=${model} requesting`);
    const out = await fetchGeneratedImageBuffer(prompt);
    imageBuffer = out.buffer;
    imageContentType = out.contentType;
  } catch (e) {
    await markFailed(id, e);
    return;
  }

  let claimedKey = null;
  try {
    // 4. Compute next seq off the previous canonical key (mirrors
    //    replaceImage in deep-skill.service.js).
    const prev = String(skillRow.deepskill_image || '');
    const match = prev.match(/^Skills\/Skill_\d+_(\d+)$/);
    const seq = match ? Number(match[1]) + 1 : 1;
    const Key = s3Storage.keyForSkill(id, seq);

    // 5. Claim the DB row FIRST (guarded — only while the image is still
    //    empty). This makes a manual upload that landed mid-generation
    //    win, and removes the S3 key collision: a concurrent replaceImage
    //    running after the claim reads the claimed key and computes the
    //    next seq, producing a different key.
    const [claim] = await pool.query(
      `UPDATE tbl_deep_skill
          SET deepskill_image = ?,
              image_gen_status = NULL,
              image_gen_attempted_at = NOW()
        WHERE deepskill_id = ?
          AND (deepskill_image = '' OR deepskill_image IS NULL)`,
      [Key, id],
    );
    if (!claim || claim.affectedRows === 0) {
      // Manual upload landed mid-generation — discard the auto-gen
      // result. No S3 write, no cache invalidation, no counter bump.
      logger.info(`deep-skill-image-gen: skill=${id} image set concurrently — discarding auto-gen result`);
      // Clear any leftover pending badge so the FE spinner disappears.
      await pool.query(
        `UPDATE tbl_deep_skill SET image_gen_status = NULL WHERE deepskill_id = ? AND image_gen_status = 'pending'`,
        [id],
      );
      return;
    }
    claimedKey = Key;

    // 6. S3 upload (row already points at this key).
    await s3Storage.putSkillImage({
      skillId: id,
      seq,
      buffer: imageBuffer,
      contentType: imageContentType,
      originalName: 'auto-generated.png',
    });

    // 7. Invalidate caches so consumers see the new image immediately.
    try { deepSkillService.invalidateAllDeepSkillImagesCache(); } catch (_) { /* defensive */ }
    try { invalidateCatalogCaches(); } catch (_) { /* defensive */ }

    logger.info(`deep-skill-image-gen: skill=${id} success key=${Key}`);

    // 8. Bump counter + maybe notify (success-only).
    await bumpCounterAndMaybeNotify().catch((e) => {
      logger.warn({ err: e && e.message },
        'deep-skill-image-gen: bumpCounterAndMaybeNotify failed (non-fatal)');
    });
  } catch (e) {
    if (claimedKey) {
      // The claim landed but the S3 upload failed — revert so the row
      // doesn't point at a nonexistent object (markFailed only touches
      // image_gen_status / attempted_at, not deepskill_image).
      try {
        await pool.query(
          `UPDATE tbl_deep_skill SET deepskill_image = '' WHERE deepskill_id = ? AND deepskill_image = ?`,
          [id, claimedKey],
        );
      } catch (revertErr) {
        logger.warn({ err: revertErr && revertErr.message, skillId: id },
          'deep-skill-image-gen: claim revert failed (non-fatal)');
      }
    }
    await markFailed(id, e);
  }
}

/*
 * Counter increment + budget-alert email.
 *
 * Atomic UPDATE on easyfix_properties.total_count using
 * LAST_INSERT_ID(expr) so the post-increment value is captured on the
 * SAME pooled connection — each worker sees exactly the total its own
 * bump produced (a separate read-back could return a later value under
 * concurrency and miss the crossing entirely). Then compare
 * floor(total/T) vs floor((total-1)/T) to detect crossing each Nth
 * multiple. Robust to operators changing T mid-flight.
 *
 * Email send failures DO NOT roll back the counter — counter integrity
 * is more important than notification reliability (the next crossing
 * still fires).
 */
async function bumpCounterAndMaybeNotify() {
  // 1. Atomic increment + same-connection capture of the new value.
  //    LAST_INSERT_ID(expr) stores the incremented value AND stages it
  //    in the connection's LAST_INSERT_ID, so the read in step 2 is
  //    immune to interleaved bumps from concurrent workers.
  let total;
  const conn = await pool.getConnection();
  try {
    const [upd] = await conn.query(
      `UPDATE easyfix_properties
          SET property_value = LAST_INSERT_ID(CAST(property_value AS UNSIGNED) + 1)
        WHERE property_key = 'deep.skill.image.gen.total_count'`,
    );
    if (!upd || upd.affectedRows !== 1) {
      // Seed row absent — graceful no-op (do NOT read LAST_INSERT_ID
      // here; it would return a stale per-connection value).
      logger.warn('deep-skill-image-gen: counter row missing — skipping milestone check');
      return;
    }

    // 2. Read back this worker's own post-increment total.
    const [[row]] = await conn.query('SELECT LAST_INSERT_ID() AS v');
    total = Number(row?.v || 0);
  } finally {
    conn.release();
  }
  if (!total) return;

  // Flush the in-memory properties cache so other readers don't see a
  // stale total (best-effort — non-fatal if unavailable).
  try { await propertiesService.flushCache(); } catch (_) { /* ignore */ }

  const T = Math.max(1, Number(propertiesService.getProperty('deep.skill.image.gen.count')) || 500);

  // 3. Crossing condition.
  const crossed = Math.floor(total / T) > Math.floor((total - 1) / T);
  if (!crossed) return;

  // 4. Recipients.
  const recipientsRaw = String(propertiesService.getProperty('deep.skill.image.gen.budget.notification') || '').trim();
  if (!recipientsRaw) {
    logger.info(`deep-skill-image-gen: milestone ${total} reached but no recipients configured`);
    return;
  }

  const model = getModel();
  const size = '1024x1024';
  const quality = 'standard';
  const unitCostUsd = getUnitCostUsd(model, size, quality);
  const usdToInr = Number(propertiesService.getProperty('deep.skill.image.gen.usd_to_inr')) || 84;
  const costUsd = total * unitCostUsd;
  const costInr = costUsd * usdToInr;

  let recentSkills = [];
  try {
    const [rows] = await pool.query(
      `SELECT deepskill_id, deepskill_name, image_gen_attempted_at
         FROM tbl_deep_skill
        WHERE image_gen_status IS NULL
          AND image_gen_attempted_at IS NOT NULL
        ORDER BY image_gen_attempted_at DESC
        LIMIT 5`,
    );
    recentSkills = rows;
  } catch (e) {
    logger.warn({ err: e && e.message },
      'deep-skill-image-gen: recent-skills lookup failed (non-fatal)');
  }

  const sentAt = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date()) + ' IST';

  const html = renderBudgetAlertHtml({
    total, T, model, size, quality, unitCostUsd,
    costUsd, costInr, recentSkills,
    notifyCsvEmails: recipientsRaw,
    sentAt,
    usdToInr,
  });

  const subject = `🚨 EasyFix · Deep Skill Image Generation — ${total} images generated · ~$${costUsd.toFixed(2)} (₹${Math.round(costInr)}) spent`;

  try {
    const result = await emailService.send({
      to: recipientsRaw,
      subject,
      html,
      category: 'transactional',
    });
    if (result?.delivered) {
      logger.info(`deep-skill-image-gen: budget alert sent total=${total} to=${recipientsRaw}`);
    } else {
      logger.warn({ result },
        'deep-skill-image-gen: budget alert email NOT delivered (non-fatal)');
    }
  } catch (e) {
    logger.warn({ err: e && e.message },
      'deep-skill-image-gen: budget alert email threw (non-fatal)');
  }
}

/*
 * Escape user-controlled strings for inline HTML. Keeps operator-typed
 * skill names from breaking the email layout (or worse, injecting
 * spurious links into ops inboxes).
 */
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtAttemptedAt(value) {
  try {
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(d) + ' IST';
  } catch {
    return '';
  }
}

/*
 * Render the rich HTML budget-alert email body. All styles inline —
 * required for Gmail / Outlook / Apple Mail compatibility. No <style>
 * block, no images (avoids broken-image risk). Mulish font matches
 * EasyFix UI brand.
 */
function renderBudgetAlertHtml({
  total, T, model, size, quality, unitCostUsd,
  costUsd, costInr, recentSkills, notifyCsvEmails, sentAt,
}) {
  const crmUrl = process.env.CRM_URL || process.env.PUBLIC_CRM_URL || 'https://crm.easyfix.in';
  const nextMilestone = (Math.floor(total / T) + 1) * T;
  const nextSpendUsd = nextMilestone * unitCostUsd;

  const recentRowsHtml = (recentSkills || []).map((r) => `
      <tr>
        <td style="padding:10px 12px; color:#0f172a; border-bottom:1px solid #f1f5f9;">${escapeHtml(r.deepskill_id)}</td>
        <td style="padding:10px 12px; color:#0f172a; border-bottom:1px solid #f1f5f9;">${escapeHtml(r.deepskill_name)}</td>
        <td style="padding:10px 12px; color:#475569; border-bottom:1px solid #f1f5f9;">${escapeHtml(fmtAttemptedAt(r.image_gen_attempted_at))}</td>
      </tr>`).join('') || `
      <tr><td colspan="3" style="padding:14px 12px; color:#94a3b8; text-align:center;">No recent rows recorded.</td></tr>`;

  const inrFmt = Math.round(costInr).toLocaleString('en-IN');

  return `<!-- 1. Red banner header -->
<div style="background:#dc2626; color:#fff; padding:24px 32px; font-family:'Mulish',Arial,sans-serif;">
  <div style="font-size:14px; letter-spacing:1.5px; opacity:0.9; margin-bottom:6px;">EASYFIX · OPERATIONS ALERT</div>
  <div style="font-size:24px; font-weight:700; line-height:1.2;">
    🚨 Deep Skill Image Generation Milestone Reached
  </div>
  <div style="font-size:14px; margin-top:8px; opacity:0.95;">
    ${escapeHtml(total)} images auto-generated by DALL-E so far &mdash; your monitoring threshold of every ${escapeHtml(T)} images has been crossed.
  </div>
</div>

<!-- 2. Hero metrics row -->
<table role="presentation" style="width:100%; border-collapse:collapse; background:#f8fafc; font-family:'Mulish',Arial,sans-serif;">
  <tr>
    <td style="padding:24px 16px; text-align:center; border-right:1px solid #e2e8f0;">
      <div style="font-size:12px; color:#64748b; text-transform:uppercase; letter-spacing:1px;">Total Generated</div>
      <div style="font-size:32px; font-weight:700; color:#0f172a; margin-top:6px;">${escapeHtml(total)}</div>
      <div style="font-size:12px; color:#64748b; margin-top:4px;">images since launch</div>
    </td>
    <td style="padding:24px 16px; text-align:center; border-right:1px solid #e2e8f0;">
      <div style="font-size:12px; color:#64748b; text-transform:uppercase; letter-spacing:1px;">Cumulative Spend</div>
      <div style="font-size:32px; font-weight:700; color:#0f172a; margin-top:6px;">$${costUsd.toFixed(2)}</div>
      <div style="font-size:14px; color:#475569; margin-top:4px;">&asymp; &#8377;${inrFmt}</div>
    </td>
    <td style="padding:24px 16px; text-align:center;">
      <div style="font-size:12px; color:#64748b; text-transform:uppercase; letter-spacing:1px;">Per-Image Cost</div>
      <div style="font-size:32px; font-weight:700; color:#0f172a; margin-top:6px;">$${unitCostUsd.toFixed(3)}</div>
      <div style="font-size:12px; color:#64748b; margin-top:4px;">${escapeHtml(model)} &middot; ${escapeHtml(quality)}</div>
    </td>
  </tr>
</table>

<!-- 3. Configuration details -->
<div style="padding:24px 32px; background:#fff; font-family:'Mulish',Arial,sans-serif;">
  <h3 style="margin:0 0 16px; font-size:16px; color:#0f172a;">Configuration</h3>
  <table role="presentation" style="width:100%; border-collapse:collapse; font-size:14px;">
    <tr><td style="padding:8px 0; color:#64748b; width:40%;">Active model</td><td style="padding:8px 0; color:#0f172a; font-weight:600;">${escapeHtml(model)}</td></tr>
    <tr><td style="padding:8px 0; color:#64748b;">Image size / quality</td><td style="padding:8px 0; color:#0f172a; font-weight:600;">${escapeHtml(size)} &middot; ${escapeHtml(quality)}</td></tr>
    <tr><td style="padding:8px 0; color:#64748b;">Notification threshold</td><td style="padding:8px 0; color:#0f172a; font-weight:600;">Every ${escapeHtml(T)} images</td></tr>
    <tr><td style="padding:8px 0; color:#64748b;">Next notification at</td><td style="padding:8px 0; color:#0f172a; font-weight:600;">${escapeHtml(nextMilestone)} images (~$${nextSpendUsd.toFixed(2)})</td></tr>
    <tr><td style="padding:8px 0; color:#64748b;">Recipients (this mail)</td><td style="padding:8px 0; color:#0f172a; font-weight:600;">${escapeHtml(notifyCsvEmails)}</td></tr>
    <tr><td style="padding:8px 0; color:#64748b;">Sent at</td><td style="padding:8px 0; color:#0f172a; font-weight:600;">${escapeHtml(sentAt)}</td></tr>
  </table>
</div>

<!-- 4. Recently generated -->
<div style="padding:0 32px 24px; background:#fff; font-family:'Mulish',Arial,sans-serif;">
  <h3 style="margin:24px 0 12px; font-size:16px; color:#0f172a;">Recently Auto-Generated Deep Skills</h3>
  <table role="presentation" style="width:100%; border-collapse:collapse; font-size:13px;">
    <thead>
      <tr style="background:#f1f5f9;">
        <th style="padding:10px 12px; text-align:left; color:#64748b; font-weight:600;">Deep Skill ID</th>
        <th style="padding:10px 12px; text-align:left; color:#64748b; font-weight:600;">Name</th>
        <th style="padding:10px 12px; text-align:left; color:#64748b; font-weight:600;">Generated At</th>
      </tr>
    </thead>
    <tbody>${recentRowsHtml}
    </tbody>
  </table>
</div>

<!-- 5. Action buttons -->
<div style="padding:8px 32px 32px; background:#fff; text-align:center; font-family:'Mulish',Arial,sans-serif;">
  <a href="${escapeHtml(crmUrl)}/settings/deep-skills" style="display:inline-block; padding:12px 24px; background:#0ea5e9; color:#fff; text-decoration:none; border-radius:6px; font-weight:600; font-size:14px; margin:4px;">View Manage Deep Skills</a>
  <a href="${escapeHtml(crmUrl)}/settings/properties?key=deep.skill.image.gen.count" style="display:inline-block; padding:12px 24px; background:#f1f5f9; color:#0f172a; text-decoration:none; border-radius:6px; font-weight:600; font-size:14px; margin:4px; border:1px solid #cbd5e1;">Adjust Threshold</a>
  <a href="${escapeHtml(crmUrl)}/settings/properties?key=deep_skill.auto_generate_image.enabled" style="display:inline-block; padding:12px 24px; background:#fff; color:#dc2626; text-decoration:none; border-radius:6px; font-weight:600; font-size:14px; margin:4px; border:1px solid #dc2626;">Disable Auto-Generation</a>
</div>

<!-- 6. Footer -->
<div style="padding:16px 32px; background:#0f172a; color:#94a3b8; font-size:11px; text-align:center; font-family:'Mulish',Arial,sans-serif;">
  This alert was sent because EasyFix Deep Skill Auto-Generation crossed a ${escapeHtml(T)}-image milestone.
  Recipients are managed via the <code style="color:#cbd5e1;">deep.skill.image.gen.budget.notification</code> property &mdash; to add or remove emails, edit that property in Manage Properties.
  Pricing reflects the active model at send time and is sourced from OpenAI's published pricing as of the most recent EasyFix release.
</div>`;
}

/*
 * Orphan reset (2026-06-12). Wired to a standalone 5-min cron in
 * server/scheduler.js (NOT registered via registerJob() — this is
 * infrastructure plumbing, not an operator-facing scheduled task, so
 * it's deliberately absent from the Scheduled Jobs admin page).
 *
 * A row gets stuck in status='pending' when a server restart kills
 * the in-flight setImmediate worker before generateImage() can write
 * either the final image_url OR the 'failed' status. The in-memory
 * `inflightImageGen` Set is lost on restart, but the DB row stays
 * 'pending' forever — the FE polling loop would spin against it
 * indefinitely, and the operator has no way to retry.
 *
 * Reset criterion: status='pending' AND image_gen_attempted_at is at
 * least 10 minutes old. Real DALL-E generations finish well under
 * 60s; 10 min is a comfortable safety buffer that won't ever race a
 * legitimate in-flight call.
 *
 * Effect: flips status='failed', leaves image_gen_attempted_at as the
 * original pending-stamp (so the FE can display "Failed at <when>"
 * accurately and the operator can hit Retry which will re-stamp).
 *
 * Returns the count of rows reset for telemetry.
 */
async function resetOrphanedPendingImageGens() {
  const [result] = await pool.query(
    `UPDATE tbl_deep_skill
        SET image_gen_status = 'failed'
      WHERE image_gen_status = 'pending'
        AND image_gen_attempted_at IS NOT NULL
        AND image_gen_attempted_at < (NOW() - INTERVAL 10 MINUTE)`,
  );
  const count = result?.affectedRows || 0;
  if (count > 0) {
    logger.warn({ count }, 'deep-skill-image-gen: reset orphaned pending rows to failed');
  }
  return { resetCount: count };
}

/*
 * Synchronous "Generate Image" for an EXISTING skill (2026-06-12).
 *
 * Operator-driven regenerate/replace — distinct from the guarded auto
 * path (generateImage). This is an explicit user action, so the row's
 * image is replaced UNCONDITIONALLY (no claim-guard). The request awaits
 * the DALL-E round-trip; the 60s AbortSignal in fetchGeneratedImageBuffer
 * bounds the worst case.
 *
 *   name / options : when supplied (current modal form, possibly with
 *                    unsaved edits) they drive the prompt; otherwise we
 *                    SELECT the persisted name + active options.
 *
 * Throws err.status=404 when the skill row doesn't exist. OpenAI / S3
 * failures bubble as plain errors for the route to map to a 502.
 */
async function generateForSkill(skillId, { name, options } = {}) {
  const id = Number(skillId);
  if (!Number.isInteger(id) || id <= 0) {
    const err = new Error('invalid skillId');
    err.status = 400;
    throw err;
  }

  // Load the row regardless — we need deepskill_image for the seq calc,
  // and (when name/options weren't passed) the persisted name + options.
  const [[row]] = await pool.query(
    `SELECT deepskill_id, deepskill_name, deepskill_image
       FROM tbl_deep_skill
      WHERE deepskill_id = ? LIMIT 1`,
    [id],
  );
  if (!row) {
    const err = new Error('deep skill not found');
    err.status = 404;
    throw err;
  }

  let resolvedName = name;
  let resolvedOptions = Array.isArray(options) ? options : null;
  if (resolvedName === undefined || resolvedName === null || String(resolvedName).trim() === '') {
    resolvedName = row.deepskill_name;
  }
  if (!resolvedOptions) {
    const [optRows] = await pool.query(
      `SELECT skill_option
         FROM tbl_deepskill_options
        WHERE deepskill_id = ? AND status = 1
        ORDER BY id`,
      [id],
    );
    resolvedOptions = optRows.map((o) => o.skill_option);
  }
  resolvedOptions = resolvedOptions
    .map((o) => String(o ?? '').trim())
    .filter(Boolean);
  // Same rule as generatePreview: a meaningful thumbnail needs ≥1 option.
  // Covers the edit-modal case where the operator cleared all options (or
  // a skill genuinely has none) — a clear 400 beats the generic 502.
  if (resolvedOptions.length === 0) {
    const err = new Error('Please select at least one skill option to generate an image.');
    err.status = 400;
    throw err;
  }

  const prompt = buildPrompt(
    { deepskill_name: resolvedName },
    resolvedOptions.map((o) => ({ skill_option: o })),
  );

  const { buffer, contentType } = await fetchGeneratedImageBuffer(prompt);

  // Next seq off the current canonical key (mirrors generateImage).
  const prev = String(row.deepskill_image || '');
  const match = prev.match(/^Skills\/Skill_\d+_(\d+)$/);
  const seq = match ? Number(match[1]) + 1 : 1;
  const Key = s3Storage.keyForSkill(id, seq);

  await s3Storage.putSkillImage({
    skillId: id,
    seq,
    buffer,
    contentType,
    originalName: 'generated.png',
  });

  // Unconditional replace — explicit operator action, NOT the guarded
  // auto path. Clear any pending/failed badge in the same statement.
  await pool.query(
    `UPDATE tbl_deep_skill
        SET deepskill_image = ?,
            image_gen_status = NULL,
            image_gen_attempted_at = NOW()
      WHERE deepskill_id = ?`,
    [Key, id],
  );

  try { deepSkillService.invalidateAllDeepSkillImagesCache(); } catch (_) { /* defensive */ }
  try { invalidateCatalogCaches(); } catch (_) { /* defensive */ }

  // Real DALL-E spend counts toward the budget.
  await bumpCounterAndMaybeNotify().catch((e) => {
    logger.warn({ err: e && e.message },
      'deep-skill-image-gen: bumpCounterAndMaybeNotify failed (non-fatal)');
  });

  const url = await s3Storage.getPresignedUrl(Key);
  logger.info(`deep-skill-image-gen: sync regenerate skill=${id} key=${Key}`);
  return { image: Key, url };
}

/*
 * Synchronous preview for a NEW (unsaved) skill (2026-06-12).
 *
 * No skill row exists yet, so the generated image lands at a STAGING
 * key (`Skills/staging/<uuid>`). The FE passes the returned `image` as
 * `deepskill_image` on create; the existing create() persists it and
 * skips auto-gen because the image field is non-empty. No DB row is
 * touched here.
 *
 * Requires a non-empty name (throws err.status=400 otherwise).
 */
async function generatePreview({ name, options } = {}) {
  const resolvedName = name == null ? '' : String(name).trim();
  if (!resolvedName) {
    const err = new Error('deepskill_name required');
    err.status = 400;
    throw err;
  }
  const resolvedOptions = (Array.isArray(options) ? options : [])
    .map((o) => String(o ?? '').trim())
    .filter(Boolean);
  // At least one skill option is required — a name-only prompt yields a
  // weak/ambiguous thumbnail (and DALL-E may reject it). Surface a clear,
  // specific 400 so the FE shows "add a skill option" instead of the
  // generic "Image generation failed — please retry".
  if (resolvedOptions.length === 0) {
    const err = new Error('Please select at least one skill option to generate an image.');
    err.status = 400;
    throw err;
  }

  const prompt = buildPrompt(
    { deepskill_name: resolvedName },
    resolvedOptions.map((o) => ({ skill_option: o })),
  );

  const { buffer, contentType } = await fetchGeneratedImageBuffer(prompt);

  const Key = 'Skills/staging/' + require('crypto').randomUUID();
  await s3Storage.putAtKey({
    key: Key,
    buffer,
    contentType,
    originalName: 'generated.png',
  });

  // Real DALL-E spend counts toward the budget.
  await bumpCounterAndMaybeNotify().catch((e) => {
    logger.warn({ err: e && e.message },
      'deep-skill-image-gen: bumpCounterAndMaybeNotify failed (non-fatal)');
  });

  const url = await s3Storage.getPresignedUrl(Key);
  logger.info(`deep-skill-image-gen: sync preview key=${Key}`);
  return { image: Key, url };
}

module.exports = {
  getModel,
  isAutoGenEnabled,
  buildPrompt,
  generateImage,
  fetchGeneratedImageBuffer,
  generateForSkill,
  generatePreview,
  dispatch,
  markFailed,
  bumpCounterAndMaybeNotify,
  renderBudgetAlertHtml,
  resetOrphanedPendingImageGens,
  // Exposed for tests / introspection — not used by the route layer.
  getUnitCostUsd,
  PRICING_USD,
};
