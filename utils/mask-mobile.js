/*
 * Mobile-number masking — privacy posture for /admin/* responses.
 *
 * Per ops 2026-05-21: every mobile number in a CRM-facing response must
 * be masked to "first 4 digits + bullets" before crossing the wire to
 * the FE. Two goals:
 *   1. The unmasked digits never appear in the operator's browser
 *      devtools / network tab.
 *   2. The FE no longer has to remember to mask at every display point
 *      — the value it receives is already masked.
 *
 * Scope:
 *   - Applied to /api/admin/* responses via middleware/mask-mobile.js.
 *   - NOT applied to /api/integration/v1/* (external client contract
 *     per CLAUDE.md THE NO-CLIENT-CHANGE RULE — Decathlon etc. expect
 *     full numbers).
 *   - NOT applied to webhook outbound payloads (same reason).
 *   - Edit endpoints can opt out via ?unmasked=true (see middleware).
 *
 * Bullet character `•` matches the FE's existing maskMobile() in
 * ClickToCallTab / format.ts so display is consistent across the stack.
 */

/* The set of object keys we treat as carrying mobile numbers. Any new
 * field name that ships a phone number to the FE MUST be added here or
 * its unmasked value will leak. */
const MOBILE_FIELDS = new Set([
  'customer_mob_no',
  'customer_mobile',
  'customer_mob',
  'mobile_no',
  'mobile',
  'mobile_number',
  'mobileNumber',
  'efr_no',
  // Aliased technician mobile that ships in /admin/jobs detail
  // (SELECT ef.efr_no AS easyfixer_mobile in services/job.service.js).
  // The raw column `efr_no` would already match above, but the alias
  // bypasses it — list both so neither path leaks.
  'easyfixer_mobile',
  'tech_mobile',
  'tech_no',
  'alternate_no',
  'phone',
  'phone_no',
  'phoneNumber',
  // Call-info / Kaleyra audit columns (tbl_job_caller_info)
  'caller',
  'reciever',
  // Frontend-friendly aliases the /admin/calls list returns
  'receiver',
  // Client SPOC contact numbers (tbl_client_contacts). These travel
  // through /admin/clients/* responses and a few aliased projections
  // (spoc_mobile, spoc_alt) in webhook-adjacent code; we mask the
  // canonical column names + their FE/webhook aliases.
  'contact_no',
  'contact_alt_no',
  'spoc_mobile',
  'spoc_alt',
  'spoc_no',
  // Legacy column on tbl_job that carries the SPOC mobile as plain
  // text (predates the move to tbl_client_contacts). Still populated
  // and returned in /admin/jobs detail under the literal key
  // `client_spoc`. NOT to be confused with `client_spoc_name` /
  // `client_spoc_email` which are name + email aliases (not masked).
  'client_spoc',
  'client_spoc_phone',
  // Operator profile fields that occasionally surface in /admin/users
  // detail joins (e.g. reporting-manager contact).
  'manager_mobile',
  'manager_no',
]);

/*
 * CUSTOMER-facing subset of MOBILE_FIELDS. When the global
 * `ui.customer.number.visible` flag is ON, middleware/mask-mobile.js passes
 * `{ unmaskCustomer: true }` and these keys are returned RAW while every other
 * mobile field (technician efr_no, client-SPOC contact_no, staff manager_no…)
 * stays masked.
 *
 * ONLY unambiguous CUSTOMER-owned fields belong here. The tbl_job_caller_info
 * call-audit legs (caller / reciever / receiver) are DELIBERATELY EXCLUDED:
 * they are polymorphic — on an admin click-to-call `caller` holds the
 * OPERATOR's own mobile, and `reciever` can be a customer, SPOC, or technician
 * — so unmasking them would leak staff/technician numbers. The customer's
 * number is still exposed via `customer_mob_no` (its own column in the
 * call-info projection), so nothing customer-facing is lost by excluding them.
 */
const CUSTOMER_MOBILE_FIELDS = new Set([
  'customer_mob_no',
  'customer_mobile',
  'customer_mob',
  'alternate_no',   // tbl_job alternate CUSTOMER contact
]);

/* `visible` defaults to 4 to match the "first 4 digits" UI convention. */
function maskMobile(s, visible = 4) {
  if (s == null || s === '') return s;
  const str = String(s);
  // Idempotent: already-masked input has a bullet character; return
  // verbatim. Without this guard, the digit-strip would erase the
  // bullets and the "<= visible" branch would truncate "9310••••••"
  // back to "9310" — silent corruption on any double-pass.
  if (str.includes('•')) return str;
  // Strip non-digits before masking so "+91 93109 92052" or
  // "9310-9920-52" doesn't end up with stray punctuation in the masked
  // output. Final form is purely digits + bullets.
  const d = str.replace(/\D/g, '');
  if (!d) return s;                  // nothing to mask (e.g. empty string)
  if (d.length <= visible) return d; // very short — return as-is, no point bulleting
  return d.slice(0, visible) + '•'.repeat(d.length - visible);
}

/* Recursively walk an arbitrary JSON-safe value and mask any string at
 * a known mobile-field key. Returns a new value; never mutates input.
 *
 * The walker is robust against:
 *   - Nested objects (Job → customer → addresses[] → …)
 *   - Arrays of objects (rows[])
 *   - Mixed types (numbers, null, undefined, booleans)
 *
 * Recursion depth is bounded by the response shape (no cycles in JSON).
 * For very large lists (~1k rows × ~30 fields) this adds ~ms; acceptable
 * for /admin/* throughput. If a hotspot emerges, we'd switch to a
 * stream-based JSON.stringify replacer instead.
 */
function maskMobileInResponse(value, opts) {
  // opts.unmaskCustomer — when true, keys in CUSTOMER_MOBILE_FIELDS are left
  // RAW (customer-number visibility flag ON); all other mobile fields still
  // mask. Default false → mask everything (the historical behaviour).
  const unmaskCustomer = !!(opts && opts.unmaskCustomer);
  if (value == null) return value;
  if (Array.isArray(value)) return value.map((v) => maskMobileInResponse(v, opts));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (MOBILE_FIELDS.has(k) && (typeof v === 'string' || typeof v === 'number')) {
        out[k] = (unmaskCustomer && CUSTOMER_MOBILE_FIELDS.has(k)) ? v : maskMobile(v);
      } else {
        out[k] = maskMobileInResponse(v, opts);
      }
    }
    return out;
  }
  return value;
}

module.exports = { maskMobile, maskMobileInResponse, MOBILE_FIELDS, CUSTOMER_MOBILE_FIELDS };
