/*
 * /api/admin/config/* — small read-only surface for GLOBAL runtime UI
 * toggles the CRM frontend needs to know about at render time.
 *
 * These are plain easyfix_properties booleans (flipped by DBA / ops via the
 * migration or a direct UPDATE — there is intentionally NO write endpoint
 * here). Distinct from routes/admin/access.js /features, which returns
 * PER-USER email-allowlist capabilities; the flags here are global (same for
 * every operator) and carry no permission gate beyond the /api/admin/* auth
 * already applied upstream.
 */

const router = require('express').Router();
const { getProperty } = require('../../services/properties.service');
const { modernOk } = require('../../utils/response');

// Property missing → safe default that preserves the historical behaviour:
//   customer numbers MASKED (visible=false), map CLICKABLE (clickable=true).
function isTrue(key, dflt) {
  const raw = getProperty(key);
  if (raw == null || String(raw).trim() === '') return dflt;
  return String(raw).trim().toLowerCase() === 'true';
}

/*
 * GET /api/admin/config/ui-flags
 *   → { customerNumberVisible, mapClickable, bankChangeOtpRequired }
 *
 * bankChangeOtpRequired mirrors `bank.change.crm.otp.required`, the property
 * that decides whether a CRM bank change demands the technician's OTP
 * (services/easyfixer-sensitive-change.service.js::crmOtpRequired). It is
 * surfaced here so EasyfixerBankDialog can render the right number of steps
 * up front instead of hardcoding the default and discovering the truth from a
 * 400 on submit — which makes the operator retype nothing but does make them
 * hit an error to learn the rules.
 *
 * The default MUST match crmOtpRequired()'s own `?? 'false'`: if the two
 * disagree, a missing property makes the UI and the server contradict each
 * other, which is worse than either posture on its own. This is a render
 * hint, never the gate — the server still enforces it regardless.
 */
router.get('/ui-flags', (req, res) => {
  return modernOk(res, {
    customerNumberVisible: isTrue('ui.customer.number.visible', false),
    mapClickable: isTrue('ui.map.clickable', true),
    bankChangeOtpRequired: isTrue('bank.change.crm.otp.required', false),
  });
});

module.exports = router;
