/*
 * 3.9 MONEY SPLIT — no client price on the technician's phone (V3 spec rule 5).
 *
 * Design sheet 07b: "TOTAL ORDER VALUE on a technician's phone means his share
 * — ₹800 — and nothing else. Never the client's ₹1,600, never the margin. The
 * moment he can see two numbers he starts doing arithmetic on us instead of
 * the job." His figure already rides on every job as technician_share
 * (decorateTechnicianShare in ./index.js); this removes the other one.
 *
 * WHY A DENY-LIST WALK AND NOT A NARROWER PROJECTION. The detail is getById —
 * the CRM's own `j.*` + service lines + images — and the list is the CRM's
 * list. Re-projecting them for mobile would fork two of the busiest shapes in
 * the backend. Instead every mobile serializer that can carry one of these
 * keys passes its payload through here, at any depth (service lines are
 * nested), and tests/v3p3-a-money-split.test.js walks every one of those
 * responses for every key below.
 *
 * WHAT IS ALLOWED THROUGH, deliberately:
 *   technician_share / _estimated   his share (sheet 07b's number)
 *   collectFromCustomer             cash-collect jobs only — what he must
 *                                   collect, named so it cannot be read as
 *                                   "order value" (spec rule 5's exception)
 *   material_charge                 cash HE typed at checkout, not a price
 *   billing_label                   'Free' / 'Paid' — a word, not a figure
 *
 * Keys, not values: a new client-price field added to getById later is caught
 * only if it uses one of these names, so the test pins the list against the
 * payloads the services actually return today.
 */
const CLIENT_PRICE_KEYS = Object.freeze([
  // tbl_job / order level
  'total_amount', 'totalAmount', 'order_value', 'orderValue', 'order_total', 'orderTotal',
  // tbl_job_services lines on the detail (getById) — the client's per-line price
  'total_charge', 'totalCharge', 'total_cost', 'totalCost', 'effective_charge', 'effectiveCharge',
  // quotation / estimate lines and charges
  'client_charge', 'clientCharge', 'approved_charge', 'approvedCharge', 'unit_price', 'unitPrice',
  'client_amount', 'clientAmount', 'margin',
]);

const DENY = new Set(CLIENT_PRICE_KEYS);

/**
 * Delete every client-price key from `value`, in place, at any depth, and
 * return it. `extraKeys` adds route-specific names that are generic elsewhere
 * — the rate card's and material picker's `price`, a quotation line's
 * `amount` — which cannot go on the global list without stripping, say, a
 * reward's points or his own earnings.
 *
 * Iterative, so a deep payload cannot blow the stack; Dates and Buffers are
 * leaves. A payload is bounded by its route (lists ≤ 200 rows), so this is a
 * linear pass over something already bounded.
 */
function stripClientPrices(value, extraKeys = []) {
  const deny = extraKeys.length ? new Set([...DENY, ...extraKeys]) : DENY;
  const stack = [value];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object' || node instanceof Date || Buffer.isBuffer(node)) continue;
    if (Array.isArray(node)) { for (const v of node) stack.push(v); continue; }
    for (const key of Object.keys(node)) {
      if (deny.has(key)) delete node[key];
      else stack.push(node[key]);
    }
  }
  return value;
}

module.exports = { stripClientPrices, CLIENT_PRICE_KEYS };
