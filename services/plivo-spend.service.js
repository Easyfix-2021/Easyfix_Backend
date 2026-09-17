/*
 * This month's Plivo spend — calls and transcriptions, separately — for the
 * Plivo Account card on Setting → Admin Actions.
 *
 * Plivo has no usage-summary API (the Account object carries only the
 * balance), so both figures are sums over per-item LIST endpoints:
 *   calls           /Call/           total_amount        end_time__gte honoured
 *   transcriptions  /Transcription/  transcription_cost  add_time filters are
 *                   NOT honoured (an empty page), so the walk stops by time.
 * Both lists are newest-first, and new items only ever PREPEND (a CDR is written
 * at hangup, a transcription at request), which is what makes the incremental
 * walk below exact: a page that holds nothing new means everything older is
 * already counted.
 *
 * Measured 2026-09-17: 7,413 CDRs by the 17th = 371 pages, 8¼ min read one page
 * at a time. So the sum is NEVER computed inside a request: getMonthSpend()
 * returns the cache and kicks a background refresh when stale; pages are read
 * WAVE at a time; after the first full walk a refresh reads only the new pages.
 * Offsets shifting under a concurrent walk (new items prepended) can only
 * repeat an item, never skip one — the Map dedupes by id.
 *
 * Month = IST calendar month. Amounts are USD, Plivo's billing currency. Call
 * amounts are the CDRs' total_amount; multi-party-call rooms bill 0 on this
 * account (billed_amount "0.00000"), so the legs are the whole call charge.
 */

const logger = require('../logger');
const plivo = require('./plivo.service');

const WAVE = 6;
const PAGE = 20;
const REFRESH_MS = 10 * 60 * 1000;
const RETRY_MS = 60 * 1000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const KINDS = {
  calls: {
    path: (sinceParam, offset) => `/Call/?limit=${PAGE}&offset=${offset}&end_time__gte=${encodeURIComponent(sinceParam)}`,
    id: 'call_uuid', amount: 'total_amount', time: 'end_time',
  },
  transcriptions: {
    path: (_sinceParam, offset) => `/Transcription/?limit=${PAGE}&offset=${offset}`,
    id: 'transcription_id', amount: 'transcription_cost', time: 'add_time',
  },
};

let state = null;

function istMonth(nowMs = Date.now()) {
  const ist = new Date(nowMs + IST_OFFSET_MS);
  const y = ist.getUTCFullYear();
  const m = ist.getUTCMonth();
  const startMs = Date.UTC(y, m, 1) - IST_OFFSET_MS;
  return {
    month: `${y}-${String(m + 1).padStart(2, '0')}`,
    startMs,
    // Plivo filter format, UTC: "YYYY-MM-DD HH:MM:SS"
    sinceParam: new Date(startMs).toISOString().slice(0, 19).replace('T', ' '),
  };
}

function freshState(nowMs) {
  const kind = () => ({ items: new Map(), walked: false, ready: false });
  return { ...istMonth(nowMs), calls: kind(), transcriptions: kind(), refreshedAt: null, refreshing: null, error: null, errorAt: null };
}

async function walk(kindName, st) {
  const k = KINDS[kindName];
  const s = st[kindName];
  // Only a walk that reached the end may stop early next time. Cleared first,
  // so a walk that throws half-way forces the next one to go all the way down.
  const incremental = s.walked;
  s.walked = false;
  for (let offset = 0; ; offset += WAVE * PAGE) {
    const pages = await Promise.all(
      Array.from({ length: WAVE }, (_, i) => plivo.listPage(k.path(st.sinceParam, offset + i * PAGE))),
    );
    let done = false;
    for (const objects of pages) {
      let fresh = 0;
      for (const o of objects) {
        if (plivo.plivoTimeMs(o[k.time]) < st.startMs) { done = true; continue; }
        if (s.items.has(o[k.id])) continue;
        s.items.set(o[k.id], Number(o[k.amount]) || 0);
        fresh += 1;
      }
      if (objects.length < PAGE) done = true;
      if (incremental && objects.length && fresh === 0) done = true;
    }
    if (done) break;
  }
  s.walked = true;
  s.ready = true;
}

function refresh(nowMs = Date.now()) {
  if (!state || state.month !== istMonth(nowMs).month) state = freshState(nowMs);
  if (state.refreshing) return state.refreshing;
  const st = state;
  // allSettled, not all: with Promise.all a failing walk would clear
  // `refreshing` while its sibling is still paging, and the next request would
  // start a second walk of that kind on top of it.
  st.refreshing = Promise.allSettled([walk('calls', st), walk('transcriptions', st)])
    .then((results) => {
      const failed = results.find((r) => r.status === 'rejected');
      if (failed) {
        st.error = failed.reason?.message || String(failed.reason);
        st.errorAt = nowMs;
        logger.warn('Plivo spend refresh failed · ' + st.error);
      } else {
        // Stamped with the refresh's START: anything that landed during the walk
        // is picked up by the next one, never assumed counted.
        st.refreshedAt = nowMs;
        st.error = null;
      }
    })
    .finally(() => { st.refreshing = null; });
  return st.refreshing;
}

/*
 * `estimate` — the figure may be wrong, with the reasons the card shows behind
 * its (i). Deliberately NOT a reason: what Plivo bills outside these records
 * (number rental, recording storage after 90 days, taxes). Those are not call
 * or transcription usage, so the card footnotes them instead. Measured
 * 2026-09-17 that nothing call-related hides outside the CDRs: 612 multi-party
 * calls this month billed $0.0000 in total, and recording is ₹0/min.
 */
function summary(s, st) {
  let usd = 0;
  for (const v of s.items.values()) usd += v;
  const estimateReasons = [];
  if (!s.ready) {
    estimateReasons.push("Still counting this month's Plivo records after a server restart — this is the total counted so far, so the real figure is higher.");
  }
  if (st.error) {
    estimateReasons.push(`The last update from Plivo failed (${st.error}), so records since the last successful update may be missing.`);
  }
  return {
    usd: Number(usd.toFixed(4)),
    count: s.items.size,
    ready: s.ready,
    estimate: estimateReasons.length > 0,
    estimateReasons,
  };
}

/*
 * Never awaits Plivo. `ready: false` on a kind = its first full walk for this
 * month has not finished (the totals so far are a floor, not the answer).
 */
function getMonthSpend(nowMs = Date.now()) {
  const stale = !state
    || state.month !== istMonth(nowMs).month
    || !state.refreshedAt
    || nowMs - state.refreshedAt > REFRESH_MS;
  // A failed refresh (e.g. Plivo 429) waits a minute before the next attempt,
  // so an open card is not a retry loop against the account's shared API quota.
  const coolingDown = state && state.error && state.month === istMonth(nowMs).month && nowMs - state.errorAt < RETRY_MS;
  if (stale && !coolingDown) refresh(nowMs);
  return {
    month: state.month,
    currency: 'USD',
    calls: summary(state.calls, state),
    transcriptions: summary(state.transcriptions, state),
    asOf: state.refreshedAt ? new Date(state.refreshedAt).toISOString() : null,
    refreshing: Boolean(state.refreshing),
    error: state.error,
  };
}

module.exports = { getMonthSpend, refresh, istMonth, _reset: () => { state = null; } };
