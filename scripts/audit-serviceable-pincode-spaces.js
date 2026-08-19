#!/usr/bin/env node
/*
 * Blast-radius audit for the serviceable-pincode SPACE BUG.
 *
 * Settings → Manage Pincodes used to test coverage with
 *   FIND_IN_SET(p.pincode, sp.pincodes)
 * and NO space normalisation. `tbl_efr_serviceable_pincodes.pincodes` is a
 * hand-maintained CSV, so a list saved as '560001, 560002' — typed the natural
 * way — made FIND_IN_SET search for ' 560002' WITH a leading space and match
 * nothing. Every entry after the first was invisible to that screen, while
 * candidate ranking (which stripped the spaces) happily assigned work there.
 *
 * This script quantifies the damage WITHOUT writing anything:
 *   • how many technicians have a space-bearing CSV
 *   • how many pincode entries were being ignored because of it
 *   • how many DISTINCT pincodes flip Non-Serviceable → Serviceable
 *
 * Read-only. Safe to run against production.
 *
 *   node scripts/audit-serviceable-pincode-spaces.js
 */

const { pool } = require('../db');

/* The OLD behaviour: MySQL's FIND_IN_SET on the raw CSV. A token only matched
 * if it had no leading space, i.e. the CSV was split on ',' with NO trimming. */
const oldTokens = (csv) => String(csv).split(',');

/* The NEW behaviour, matching REPLACE(pincodes, ' ', '') exactly. */
const newTokens = (csv) => String(csv).split(',').map((t) => t.replace(/ /g, ''));

const isPin = (t) => /^[0-9]{6}$/.test(t);

async function main() {
  const [rows] = await pool.query(
    `SELECT sp.easyfixer_id, sp.pincodes, te.efr_status, te.is_technician_verified
       FROM tbl_efr_serviceable_pincodes sp
       JOIN tbl_easyfixer te ON te.efr_id = sp.easyfixer_id
      WHERE sp.pincodes IS NOT NULL AND sp.pincodes <> ''`,
  );

  let techsWithSpaces = 0;
  let entriesLost = 0;
  const oldCovered = new Set();
  const newCovered = new Set();
  const worst = [];

  for (const r of rows) {
    // Only DISPATCHABLE technicians make a pincode serviceable — the same gate
    // both screens apply, so the delta below is the real user-visible one.
    const dispatchable = Number(r.efr_status) === 1 && Number(r.is_technician_verified) === 1;
    const before = oldTokens(r.pincodes).filter(isPin);
    const after = newTokens(r.pincodes).filter(isPin);
    const lost = after.length - before.length;

    if (lost > 0) {
      techsWithSpaces += 1;
      entriesLost += lost;
      worst.push({ efrId: r.easyfixer_id, visible: before.length, actual: after.length, lost });
    }
    if (dispatchable) {
      for (const p of before) oldCovered.add(p);
      for (const p of after) newCovered.add(p);
    }
  }

  const flipped = [...newCovered].filter((p) => !oldCovered.has(p));
  worst.sort((a, b) => b.lost - a.lost);

  const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : '—');

  console.log('\n─── Serviceable-pincode space bug · blast radius ───\n');
  console.log(`Technicians with a serviceable list      : ${rows.length}`);
  console.log(`  …whose CSV contains spaces             : ${techsWithSpaces}  (${pct(techsWithSpaces, rows.length)})`);
  console.log(`Pincode entries that were INVISIBLE      : ${entriesLost}`);
  console.log('');
  console.log(`Distinct pincodes shown Serviceable      : ${oldCovered.size}   (old behaviour)`);
  console.log(`Distinct pincodes actually Serviceable   : ${newCovered.size}   (fixed behaviour)`);
  console.log(`  …that flip Non-Serviceable → Serviceable: ${flipped.length}  (${pct(flipped.length, newCovered.size)})`);

  if (worst.length) {
    console.log('\nWorst-affected technicians (visible → actual):');
    for (const w of worst.slice(0, 15)) {
      console.log(`  efr_id ${String(w.efrId).padStart(7)} : ${String(w.visible).padStart(4)} → ${String(w.actual).padStart(4)}   (+${w.lost})`);
    }
    if (worst.length > 15) console.log(`  … and ${worst.length - 15} more`);
  }

  if (flipped.length) {
    console.log('\nSample of pincodes that were wrongly Non-Serviceable:');
    console.log('  ' + flipped.slice(0, 30).join(', ') + (flipped.length > 30 ? ' …' : ''));
  }

  console.log('\nNothing was written. This is a read-only audit.\n');
  await pool.end();
}

main().catch((e) => {
  console.error('Audit failed:', e.message);
  process.exit(1);
});
