/*
 * QuickSight — MTD Client Report: "What the comments say".
 *
 * A PORT of the owner's MIS engine file `engine/themes.py`, which tags a free
 * text cancellation comment with ONE theme by keyword. It is their rule, not
 * ours: the theme names, the keyword patterns, the order they are tried in and
 * the two ways a comment ends up as "No reason in comment" are all reproduced
 * character for character, so the card on the CRM tab and the card in their
 * workbook name the same theme for the same comment.
 *
 * ─── HOW TO EDIT IT ────────────────────────────────────────────────────────
 *
 * Everything editable is in THEME_RULES below — one array, one entry per
 * theme, each a name and the keyword pattern that claims a comment for it. To
 * change what a theme catches, change its pattern there and nowhere else. To
 * add a theme, add its NAME to THEMES (which fixes the order the dashboard
 * lists them in) AND a rule to THEME_RULES (which fixes when it wins).
 *
 * TWO ORDERS, BOTH LOAD-BEARING, AND THEY ARE NOT THE SAME ORDER:
 *
 *   THEMES        the display list. themes.py builds its theme dictionary from
 *                 it, so it is also the order the MIS dashboard shows them in.
 *   THEME_RULES   the order the patterns are TRIED in. FIRST MATCH WINS, and
 *                 the rules are deliberately sequenced so a comment saying
 *                 "duplicate, new job created" is a duplicate rather than a
 *                 reschedule. Re-sorting this array silently re-tags history.
 *
 * "Other" and "No reason in comment" have no rule: they are the two fall
 * throughs, one for a comment that matched nothing and one for a comment with
 * no usable text in it at all.
 *
 * ─── PYTHON → JS ───────────────────────────────────────────────────────────
 *
 * The patterns are kept as SOURCE STRINGS and compiled with the RegExp
 * constructor rather than written as /regex/ literals, so they can be diffed
 * against themes.py line by line without an escaping layer in between. Three
 * differences are deliberate and are the only ones:
 *
 *   re.I               → the 'i' flag.
 *   re.S on "@.*$"     → '[\\s\\S]*' , since JS has no DOTALL flag here.
 *   EMPTY.match(core)  → EMPTY.test(core). Python's .match anchors at the
 *                        start of the string; every alternative in that
 *                        pattern already begins with '^', so .test is the same
 *                        test. (Python's '$' would also match before a single
 *                        trailing newline where JS's does not — unreachable,
 *                        because clean_comment has already trimmed.)
 *
 * This module is pure: no database, no clock, no logging. It is a function of
 * the comment text and nothing else.
 */

'use strict';

/**
 * The theme names, in themes.py's own order. Identical strings — the MIS
 * report and this one must agree on the label, not only on the grouping.
 */
const THEMES = Object.freeze([
  'Customer self-installed / self-assembled',
  "Done by another vendor / client's own team",
  'Customer not responding / unreachable',
  'Customer wants a later date / reschedule',
  'Product not delivered / parts missing / returned',
  'Duplicate / already booked job',
  'Wrong booking / wrong customer details',
  'Technician or service not available',
  'Site not ready / work not feasible',
  'Client asked to cancel / on hold',
  'Customer cancelled / not interested',
  'Work already done (not stated by whom)',
  'Other',
  'No reason in comment',
]);

const OTHER = 'Other';
const NO_REASON = 'No reason in comment';

/**
 * The keyword rules, in the order they are tried. FIRST MATCH WINS.
 * themes.py RULES, verbatim.
 */
const THEME_RULES = Object.freeze([
  ['Duplicate / already booked job',
    'duplicat|dublicat|already (booked|created|raised|open)|same (job|ticket|booking)|double booking|new (job|ticket)( id)? (created|raised|booked)|rebook|re-book|already (have|has) (a )?(job|ticket)|we have already job|already closed|double book|same work|already been booked|booked earlier'],
  ['Wrong booking / wrong customer details',
    "wrong(ly)? (?!(number|no\\b|contact|mobile|phone))|incorrect|mistake|galat|test (job|ticket|booking)|ticket not found|not fo?u?nd in|address (has |is )?chang|wrong$|(not|n'?t|did not|has not|have not) purchas"],
  ['Customer self-installed / self-assembled',
    '\\bself\\b|self[- ]?(install|assembl)|by (him|her|them)sel|cx (has )?(done|did|installed|assembled) (it )?(by|him|her|on)|customer (has )?(done|did|installed|assembled) (it )?(by|him|her|on)|(installed|assembled|done) by (cx|customer)\\b|(by|from) (cx|customer) (side|end)'],
  ["Done by another vendor / client's own team",
    'other vend|another vend|vender|vendor|verm?n?der|vendr|local (tx|techn|carpenter|person|guy|mistri)|another (tx|techn|carpenter|person|company)|other (tx|techn|carpenter|source|person|company)|own (team|techn|carpenter|staff|person)|(apml|store|client|brand|company|mall|in-?house|internal) (team|techn|staff|carpenter)|third party|outside (techn|person|carpenter)|own tx|our (team|techn|tx|carpenter)|from (our|are|their) end|in-?house|in house'],
  ['Technician or service not available',
    "\\b(tx|techn\\w*|carpenter|engineer|resource|partner)s? (is |are )?not avail|no (tx|techn\\w*|carpenter|engineer|resource|partner)|service not avail|not servic|non[- ]?servic|pin ?code|out of (area|scope|zone|coverage)|ooca|upcountry|skill|serviceable|tech avl|\\bavl\\b|(don'?t|do not) have (any )?(tx|techn)|service available|not under|\\bscope?\\b"],
  ['Customer not responding / unreachable',
    "not respon|no respon|not pick|not reach|unreach|switch(ed)? off|not connect|call not|not answer|ringing|busy|invalid (number|no)|wrong (number|no|contact)|number (is )?(invalid|wrong|not)|\\brnr\\b|no answer|did not pick|didn'?t pick|not attend|disconnect|nt respon"],
  ['Site not ready / work not feasible',
    'site not ready|not ready|permission|not possib|not feasible|construction|renovation|\\bmall\\b|society|wall (is )?not|pop ceiling|underground|site issue|maintenance (is )?(still )?pending|store (is )?closed|cutting (is )?pending|work (is )?pending'],
  ['Customer wants a later date / reschedule',
    'later|reschedul|postpon|next (week|month|day)|\\b\\d{1,2} ?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|\\b(mon|tues|wednes|thurs|fri|satur|sun)day|after \\d+ ?(days|day|week)|\\b\\d{1,2} ?(st|nd|rd|th)\\b|tomorrow|out of (station|town|city)|not (at|in) (home|house|station)|shifting|will (call|inform|contact)|want(s|ed)? (the )?(install|service|visit|work)\\w* (on|after|in)|need(s)? (the )?(install|service)\\w* (on|after|in)|(cx|customer|he|she) (is )?not available|shif|left the location|going out|come back'],
  ['Product not delivered / parts missing / returned',
    'not deliver|undeliver|delivery|not (yet )?received|missing|\\bparts?\\b|spare|damage|broken|defect|return|refund|exchange|replace|material not|product not|item not'],
  ['Client asked to cancel / on hold',
    "client|clinet|cleint|\\btsc\\b|brand|hold|approval|as per (\\w+ ){0,2}(sir|mam|ma'?am|team)|asked by|instructed|as discussed"],
  ['Customer cancelled / not interested',
    "(cx|customer|client)\\s*(has |have )?(want(s|ed)? to |request(ed)? to )?cancel|not interest|don'?t want|no need|not (required|needed)|denied|refus|changed (his|her|their) mind|does not want|doesn'?t want|don'?t need|does ?n[o']?t need|not want|\\bdeny|cancle|wa?n?ts? (to )?cancel|watns"],
  ['Work already done (not stated by whom)',
    'already (done|completed|installed|fixed|resolved)|work (is )?(done|completed)|job (is )?(done|completed)|work already|alre?a?dy? complet|work complete|solved'],
]);

/*
 * Compiled once. A rule naming a theme that is not in THEMES is a typo that
 * would otherwise show up as a chart bar nobody can explain, so it is caught
 * at require time instead.
 */
const COMPILED_RULES = THEME_RULES.map(([name, pattern]) => {
  if (!THEMES.includes(name)) {
    throw new Error(`mtd-comment-themes: rule "${name}" is not one of THEMES — add the name to THEMES too`);
  }
  return { name, re: new RegExp(pattern, 'i') };
});

/*
 * "There is no usable text here." themes.py EMPTY: punctuation and digits
 * only, or one of the filler words people type when the form insists on a
 * comment ("na", "ok", "cancel", "please cancel this job", "as per Rahul").
 */
const EMPTY = new RegExp(
  '^[\\s#\\-\\d.:,/@]*$|^(na|n/a|nil|none|null|ok|done|cancel(led)?)\\.?$'
  + "|^(pls |please )?(need to |kindly )?(cancel|cancell?ing|cancell?ed)( (this|the|it))?( job| ticket| it)?( please| pls)?\\.?$"
  + '|^(as per [\\w ]{1,20}?)( (so )?(we are |i am |i\'?m )?cancell?ing (this|the) job)?\\.?$',
  'i',
);

const CANCEL_PREFIX = /^\s*cancel\s*-\s*:\s*/i;

/**
 * themes.py clean_comment(): drop the export's "Cancel - :" prefix and trim.
 * A null, an empty cell and the literal string 'nan' the workbook writes for a
 * blank all become ''.
 */
function cleanComment(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.toLowerCase() === 'nan') return '';
  return s.replace(CANCEL_PREFIX, '').trim();
}

/**
 * The ONE theme a cancellation comment belongs to.
 *
 * themes.py theme_of(): phone numbers and anything from the first '@' onward
 * are stripped first — both are contact details rather than a reason, and a
 * comment that is only a phone number must read as "no reason given", not as
 * a match on some digit pattern. What is left is tried against each rule in
 * order; the first that matches wins, and a comment matching none is "Other".
 *
 * @param {string|null|undefined} comment  the Cancel/Enquiry Comment cell
 * @returns {string} a member of THEMES
 */
function themeOf(comment) {
  const s = cleanComment(comment);
  let core = s.replace(/\d{5,}/g, ' ');
  core = core.replace(/@[\s\S]*$/, ' ').trim();
  if (!core || EMPTY.test(core)) return NO_REASON;
  for (const rule of COMPILED_RULES) {
    if (rule.re.test(core)) return rule.name;
  }
  return OTHER;
}

module.exports = {
  THEMES,
  THEME_RULES,
  OTHER,
  NO_REASON,
  cleanComment,
  themeOf,
};
