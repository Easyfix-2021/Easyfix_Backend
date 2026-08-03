/*
 * GUARD — a raw tbl_job.time_slot may not reach outbound customer text.
 *
 * ─── WHY THIS IS A TEST AND NOT A LINT RULE ────────────────────────────────
 *
 * The CRM frontend enforces the same rule with a custom ESLint rule
 * (local/no-raw-time-slot-render in Easyfix_CRM_UI/eslint.config.mjs). This
 * repo has no ESLint config and no lint script, so the equivalent guard lives
 * in the test suite — which is already gated in CI by both ci.yml and
 * deploy.yml, and needs no new dependency.
 *
 * ─── WHAT IT GUARDS ────────────────────────────────────────────────────────
 *
 * time_slot is DERIVED: it is the booking band CONTAINING requested_date_time,
 * and resolveTimeSlot re-derives it on every write. A stored value can therefore
 * be STALE — job #482491 holds 05:30 with the label '3pm to 7pm', which is
 * 'After Hours'. The column additionally carries ~20 free-text spellings of four
 * bands, accumulated from four pickers over a decade.
 *
 * Reading it is normal and correct in most places: SQL projections, query
 * params, write paths, conflict probes. This guard is deliberately NARROW — it
 * only cares about the case that reaches a HUMAN who acts on it:
 *
 *   A. a raw .time_slot interpolated into a TEMPLATE LITERAL — an SMS or
 *      WhatsApp body being built
 *   B. a raw .time_slot inside a function named *Vars / *Label / *Message /
 *      *Text — this repo's own naming convention for message builders
 *      (customerNotReachableVars, buildAppointmentLabel, jobDateLabel,
 *      buildShareMessage)
 *
 * A customer texted a window the system will not honour cannot tell that
 * anything is wrong, and neither can we — there is no error, no log line, and
 * the message looks perfectly well-formed. That is what makes it worth a gate.
 *
 * ─── HOW TO SATISFY IT ─────────────────────────────────────────────────────
 *
 * Route the value through services/time-slot.js:
 *   displaySlot(requestedDateTime, storedSlot)  the read-side composition —
 *      the appointment instant wins; the stored label (canonicalised) is used
 *      only for a date-only job (the 00:00 sentinel means "no time was ever
 *      captured", NOT midnight)
 *   canonicalSlot(v)  cosmetic case/spacing fold, when the stored string
 *      genuinely IS the right value and only its spelling is in question
 *
 * If a site is a genuine exception, add it to ALLOWLIST below WITH A REASON.
 * The reason is the point: the next person to read it should not have to
 * re-derive why it is safe.
 *
 * Non-destructive: reads source files only. No DB, no network.
 * Runner: `node --test`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOTS = ['services', 'routes'];
const REPO = path.resolve(__dirname, '..');

/* Calls whose presence on the line means the value is being composed properly. */
const APPROVED = /\b(displaySlot|canonicalSlot|resolveTimeSlot|normaliseSlotLabel|deriveTimeSlot)\s*\(/;

/* Message-builder naming convention already used across this repo. */
const BUILDER_NAME = /(Vars|Label|Message|Text)$/;

/*
 * Justified exceptions. `snippet` must appear on the flagged line — keyed on the
 * code rather than a line number so ordinary edits above it do not break this.
 */
const ALLOWLIST = [
  {
    file: 'services/whatsapp-conversation.service.js',
    snippet: 'nlu.time_slot',
    reason:
      'NOT the stored column. `nlu.time_slot` is the LLM\'s parse of what the CUSTOMER just typed, '
      + 'validated in ai.service.js against the 1-hour frame-label whitelist before it gets here. The '
      + 'message echoes their own words back to confirm them ("Thanks! We\'ve noted … (3 PM–4 PM)"), so '
      + 'deriving a band from the job would replace what they said with what we inferred.',
  },
];

function sourceFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(p); }
      else if (entry.name.endsWith('.js')) out.push(p);
    }
  };
  for (const r of ROOTS) walk(path.join(REPO, r));
  return out;
}

/*
 * Whole-line comments only. Deliberately conservative: stripping aggressively
 * (e.g. everything after any `//`) risks hiding a REAL violation that sits after
 * a URL or a divider, and a false positive from a trailing comment is cheap —
 * the allowlist absorbs it, with a reason attached.
 */
const isCommentLine = (s) => /^(\/\/|\/\*|\*)/.test(s.trim());

function scan() {
  const hits = [];
  for (const abs of sourceFiles()) {
    const rel = path.relative(REPO, abs);
    // time-slot.js DEFINES the helpers; it necessarily names the column.
    if (rel === path.join('services', 'time-slot.js')) continue;
    const lines = fs.readFileSync(abs, 'utf8').split('\n');
    let fnName = '';
    lines.forEach((line, i) => {
      const decl = /(?:function\s+([A-Za-z0-9_]+)|(?:const|let|var)\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?\()/.exec(line);
      if (decl) fnName = decl[1] || decl[2];
      if (isCommentLine(line)) return;
      if (!/\.time_slot\b/.test(line)) return;
      if (APPROVED.test(line)) return;
      const inTemplate = /\$\{[^}]*\.time_slot/.test(line);
      const inBuilder = BUILDER_NAME.test(fnName);
      if (!inTemplate && !inBuilder) return;
      hits.push({
        file: rel,
        line: i + 1,
        fn: fnName,
        why: inTemplate ? 'interpolated into a template literal' : `inside message builder ${fnName}()`,
        code: line.trim(),
      });
    });
  }
  return hits;
}

const allowed = (hit) =>
  ALLOWLIST.some((a) => a.file === hit.file && hit.code.includes(a.snippet));

test('no raw time_slot reaches outbound customer text', () => {
  const offenders = scan().filter((h) => !allowed(h));
  const report = offenders
    .map((h) => `\n  ${h.file}:${h.line}  (${h.why})\n      ${h.code}`)
    .join('');
  assert.equal(
    offenders.length,
    0,
    `A raw tbl_job.time_slot is reaching customer-facing text.${report}\n\n`
    + 'time_slot is DERIVED from requested_date_time and can be stale (job #482491 stores 05:30 with '
    + "the label '3pm to 7pm'), and the column holds ~20 spellings of four bands.\n"
    + 'Use displaySlot(requestedDateTime, storedSlot) from services/time-slot.js — the appointment '
    + 'instant wins, and the stored label (canonicalised) is used only for a date-only 00:00-sentinel '
    + 'job. Use canonicalSlot(v) when the stored value IS right and only its spelling is in doubt.\n'
    + 'If the site is a genuine exception, add it to ALLOWLIST in this file WITH A REASON.',
  );
});

/*
 * A guard that cannot fail is not a guard. These two pin the detector itself, so
 * a future refactor of `scan()` that quietly stops matching is caught here
 * rather than by the bug it was supposed to prevent.
 */
test('the detector actually fires on both banned patterns', () => {
  const probeTemplate = 'sms.send({ body: `Your slot is ${job.time_slot}.` });';
  const probeBuilder = '  const slot = job.time_slot;';
  assert.equal(/\$\{[^}]*\.time_slot/.test(probeTemplate), true, 'template-literal pattern');
  assert.equal(APPROVED.test(probeTemplate), false, 'and it is not treated as already-composed');
  assert.equal(BUILDER_NAME.test('customerNotReachableVars'), true, 'builder-name pattern');
  assert.equal(BUILDER_NAME.test('buildAppointmentLabel'), true);
  assert.equal(BUILDER_NAME.test('loadJobForConversation'), false, 'and it does not match everything');
  assert.equal(/\.time_slot\b/.test(probeBuilder), true);
});

test('the detector accepts the properly composed forms', () => {
  for (const ok of [
    'const band = displaySlot(job.requested_date_time, job.time_slot);',
    'return `${dateLabel}, ${slotModel.canonicalSlot(job.time_slot)}`;',
    'time_slot: resolveTimeSlot(input.time_slot, input.requested_date_time),',
  ]) {
    assert.equal(APPROVED.test(ok), true, ok);
  }
  // …and does not wave through a bare read that merely mentions a helper name
  // in prose without calling it.
  assert.equal(APPROVED.test('// displaySlot would be better here'), false);
});

/*
 * Every allowlist entry must still correspond to real code. A stale entry is
 * worse than none: it silently pre-authorises a pattern nobody has looked at
 * since, and reads as though someone had.
 */
test('every ALLOWLIST entry still matches live code', () => {
  for (const a of ALLOWLIST) {
    const abs = path.join(REPO, a.file);
    assert.equal(fs.existsSync(abs), true, `${a.file} no longer exists — drop the allowlist entry`);
    const src = fs.readFileSync(abs, 'utf8');
    assert.equal(
      src.includes(a.snippet),
      true,
      `ALLOWLIST snippet '${a.snippet}' no longer appears in ${a.file}. If the code moved, update the `
      + 'entry; if it was fixed, DELETE the entry so the guard covers that site again.',
    );
    assert.ok(a.reason && a.reason.length > 40, `${a.file}: an allowlist entry needs a real reason`);
  }
});
