'use strict';
/*
 * A rejection is a STANDING DECISION, not a one-time cleanup (2026-09-09).
 *
 * Rejecting a city merges every referencing row onto an operator-chosen
 * replacement and records where they went in merged_into_city_id. Until this
 * change nothing ever READ that column, so the decision governed only the
 * past. The same town coming back through an automatic path went one of two
 * ways, and which one you got depended on a string from Google:
 *
 *   exact name  → findOrCreateCityByName's first lookup carries no
 *                 city_status filter, so it returned the DEAD status-0 row and
 *                 silently attached new pincodes and bookings to a city that
 *                 appears in no picker and can never return to the queue.
 *   near name   → fuzzyMatchCity restricts to (1, 2, NULL), so it could not
 *                 see the rejected row and minted a FRESH pending duplicate —
 *                 back in the approval queue, forever.
 *
 * ─── WHY THESE ASSERT WHAT THEY DO ─────────────────────────────────────────
 *
 * Forwarding is invisible in most return values: findOrCreateCityByName hands
 * back the same { city_id, created:false } shape whether it forwarded or not,
 * and only the VALUE of city_id moves. So the runtime tests below assert the
 * id that came back and, for geocodeAndMatch, the STATE that came with it.
 * (Not the name: that function returns the GEOCODER's string for `city.name`,
 * never the matched row's, so a name assertion there would pass whether or not
 * the forwarded row was ever read.)
 *
 * The guard tests assert that NO UPDATE was issued, not merely that a 409 was
 * thrown. A guard that throws after writing is indistinguishable from one that
 * throws before, by status alone.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { CITY_STATUS } = require(path.join(ROOT, 'lib/city-status'));

/**
 * Replace ../db in the require cache, then load the services fresh so they
 * capture the stub. Returns the call ledger; `handler` answers each query.
 */
function loadWith(handler) {
  const calls = [];
  const abs = require.resolve(path.join(ROOT, 'db'));
  require.cache[abs] = {
    id: abs,
    filename: abs,
    loaded: true,
    exports: {
      pool: {
        async query(sql, params) {
          const text = Array.isArray(sql) ? String(sql[0]) : String(sql);
          calls.push({ sql: text, params });
          return [handler(text, params), []];
        },
        async getConnection() { throw new Error('no transaction expected in this test'); },
      },
      getPoolStats: () => ({}),
      poolSaturation: () => ({ status: 'ok' }),
      testConnection: async () => true,
      closePool: async () => {},
    },
  };
  for (const m of ['services/pincode.service', 'services/city.service']) {
    delete require.cache[require.resolve(path.join(ROOT, m))];
  }
  return {
    calls,
    pincode: require(path.join(ROOT, 'services/pincode.service')),
    city: require(path.join(ROOT, 'services/city.service')),
  };
}

const updates = (calls) => calls.filter((c) => /^\s*UPDATE\s/i.test(c.sql));
const hasApprovalCols = (t) => /SHOW COLUMNS FROM tbl_city LIKE 'merged_into_city_id'/i.test(t);

/* ─── 1. the ungated CRUD surface is gone ──────────────────────────────── */

test('routes · /api/admin/settings no longer serves tbl_city', () => {
  /*
   * crudFactory is generic by design: no per-action permission (settings.js
   * inherits only requireAuth + role(['admin'])), no duplicate-name check, and
   * a blind city_status write. Against tbl_city that was a second, weaker way
   * to create a city ACTIVE, to flip a PENDING one to 1 behind approveCity, and
   * to retire one to 0 with no merge — every guard on /api/admin/cities
   * bypassed by a route nothing in this repo or CRM_UI ever called.
   */
  const src = require('fs').readFileSync(path.join(ROOT, 'routes/admin/settings.js'), 'utf8');
  assert.doesNotMatch(src, /crudFactory\(\s*'tbl_city'/,
    'tbl_city must not be served by the generic CRUD factory — use /api/admin/cities');

  // tbl_state followed deliberately on 2026-09-21: a state must carry a zonal
  // manager that reaches its cities in one transaction — /api/admin/states.
  assert.doesNotMatch(src, /crudFactory\(\s*'tbl_state'/,
    'tbl_state must not be served by the generic CRUD factory — use /api/admin/states');

  // The mount removal must not have taken its neighbours with it. Without this
  // the assertion above also passes on an empty file.
  for (const table of ['tbl_service_catg', 'tbl_service_type', 'tbl_document_type']) {
    assert.match(src, new RegExp(`crudFactory\\(\\s*'${table}'`),
      `${table} must still be served — only tbl_city was removed`);
  }
});

/* ─── 2. a PENDING city cannot be retired sideways ─────────────────────── */

test('deactivate · refuses a PENDING city, and writes nothing', async () => {
  const { calls, city } = loadWith((t) => {
    if (/SELECT city_status FROM tbl_city/i.test(t)) return [{ city_status: CITY_STATUS.PENDING }];
    return [];
  });
  await assert.rejects(
    () => city.deactivateCity(500),
    (e) => e.status === 409 && /awaiting approval/i.test(e.message),
  );
  assert.equal(updates(calls).length, 0,
    'the guard must refuse BEFORE the UPDATE — a 409 thrown after the write would look '
    + 'identical from the outside while the city was already retired');
});

test('deactivate · an ACTIVE city still deactivates', async () => {
  // The positive control. Without it "refuses a pending city" would also pass
  // against a deactivateCity that refuses everything.
  const { calls, city } = loadWith((t) => {
    if (/SELECT city_status FROM tbl_city/i.test(t)) return [{ city_status: CITY_STATUS.ACTIVE }];
    if (/^\s*UPDATE tbl_city/i.test(t)) return { affectedRows: 1 };
    return [];
  });
  assert.equal(await city.deactivateCity(500), true);
  assert.equal(updates(calls).length, 1);
  assert.match(updates(calls)[0].sql, /city_status = 0/);
});

test('update · the Active toggle cannot move a PENDING city', async () => {
  const { calls, city } = loadWith((t) => {
    if (/SELECT city_status FROM tbl_city/i.test(t)) return [{ city_status: CITY_STATUS.PENDING }];
    return [];
  });
  // is_active:false is the one that actually happened — the CRM's edit dialog
  // initialises the toggle from `city_status === 1`, which is false for a
  // pending city, so merely opening one and saving sent it.
  await assert.rejects(
    () => city.updateCity(500, { is_active: false }),
    (e) => e.status === 409 && /Approve or Reject/i.test(e.message),
  );
  // And the other direction: promoting to 1 here would skip approveCity's
  // stamp, leaving an approved city with no record of who approved it.
  await assert.rejects(
    () => city.updateCity(500, { is_active: true }),
    (e) => e.status === 409,
  );
  assert.equal(updates(calls).length, 0, 'neither direction may write');
});

test('update · a PENDING city is still editable, just not promotable', async () => {
  /*
   * The guard is on the STATUS FLAG, not on the row. An operator correcting a
   * district or a typo before deciding is exactly what the queue is for, so a
   * guard that froze the whole record would make the queue harder to work.
   */
  const { calls, city } = loadWith((t) => {
    if (/SELECT city_status FROM tbl_city/i.test(t)) return [{ city_status: CITY_STATUS.PENDING }];
    if (/^\s*UPDATE tbl_city/i.test(t)) return { affectedRows: 1 };
    if (/FROM tbl_city/i.test(t)) return [{ city_id: 500, city_name: 'Nowhere' }];
    return [];
  });
  await city.updateCity(500, { district: 'Palghar' });
  const u = updates(calls);
  assert.equal(u.length, 1, 'a non-status edit must still go through');
  assert.match(u[0].sql, /district = \?/);
  assert.doesNotMatch(u[0].sql, /city_status/, 'no status write was requested, so none may happen');
});

/* ─── 3. an ACTIVE city never carries a forward pointer ────────────────── */

test('update · reviving a rejected city clears its merge pointer', async () => {
  /*
   * Answers "what if I want that city back later". Reactivating returns the
   * CITY, not the rows — the merge is one-way. But the row must stop claiming
   * it was merged away, because the pointer is load-bearing now: leaving it
   * set would send every new booking for this town to the replacement, so the
   * revived city could never accumulate anything.
   */
  const { calls, city } = loadWith((t) => {
    if (hasApprovalCols(t)) return [{ Field: 'merged_into_city_id' }];
    if (/SELECT city_status FROM tbl_city/i.test(t)) return [{ city_status: CITY_STATUS.INACTIVE }];
    if (/^\s*UPDATE tbl_city/i.test(t)) return { affectedRows: 1 };
    if (/FROM tbl_city/i.test(t)) return [{ city_id: 500, city_name: 'Palghar' }];
    return [];
  });
  await city.updateCity(500, { is_active: true });
  const u = updates(calls);
  assert.equal(u.length, 1);
  assert.match(u[0].sql, /city_status = \?/);
  assert.match(u[0].sql, /approval_decision = NULL/);
  assert.match(u[0].sql, /merged_into_city_id = NULL/,
    'a city that is active again must not still point at the city that absorbed it');
});

test('update · DEACTIVATING does not clear the pointer', async () => {
  // The differential control for the test above. Clearing on the way DOWN
  // would erase the audit trail of a rejection the moment anyone toggled the
  // row, which is the opposite of what merged_into_city_id is for.
  const { calls, city } = loadWith((t) => {
    if (hasApprovalCols(t)) return [{ Field: 'merged_into_city_id' }];
    if (/SELECT city_status FROM tbl_city/i.test(t)) return [{ city_status: CITY_STATUS.ACTIVE }];
    if (/^\s*UPDATE tbl_city/i.test(t)) return { affectedRows: 1 };
    if (/FROM tbl_city/i.test(t)) return [{ city_id: 500, city_name: 'Palghar' }];
    return [];
  });
  await city.updateCity(500, { is_active: false });
  assert.doesNotMatch(updates(calls)[0].sql, /merged_into_city_id = NULL/);
});

test('update · the pointer is left alone where the migration has not run', async () => {
  const { calls, city } = loadWith((t) => {
    if (hasApprovalCols(t)) return [];                       // columns absent
    if (/SHOW COLUMNS/i.test(t)) return [];
    if (/SELECT city_status FROM tbl_city/i.test(t)) return [{ city_status: CITY_STATUS.INACTIVE }];
    if (/^\s*UPDATE tbl_city/i.test(t)) return { affectedRows: 1 };
    if (/FROM tbl_city/i.test(t)) return [{ city_id: 500, city_name: 'Palghar' }];
    return [];
  });
  await city.updateCity(500, { is_active: true });
  assert.doesNotMatch(updates(calls)[0].sql, /merged_into_city_id/,
    'naming a column that does not exist turns every reactivation into a 500');
});

test('approve · clears the merge pointer too', async () => {
  // Same invariant, the other doorway into ACTIVE. No path today can present
  // approveCity with a pointer-carrying row, but the invariant is "a
  // selectable city has no forward pointer" and it is enforced wherever a city
  // becomes selectable — otherwise a future re-queue feature silently produces
  // an active city that redirects its own traffic away.
  const { calls, city } = loadWith((t) => {
    if (/SHOW COLUMNS FROM tbl_city LIKE 'approval_decision'/i.test(t)) return [{ Field: 'approval_decision' }];
    if (/^\s*UPDATE tbl_city/i.test(t)) return { affectedRows: 1 };
    if (/FROM tbl_city/i.test(t)) return [{ city_id: 500, city_name: 'Nowhere' }];
    return [];
  });
  await city.approveCity(500, 42);
  const u = updates(calls);
  assert.match(u[0].sql, /approval_decision = 'approved'/);
  assert.match(u[0].sql, /merged_into_city_id = NULL/);
});

/* ─── 4. the pointer walk itself ───────────────────────────────────────── */

/** Build a handler over a { cityId -> merged_into_city_id } map. */
function pointerWorld(map, { cols = true } = {}) {
  return (t, p) => {
    if (hasApprovalCols(t)) return cols ? [{ Field: 'merged_into_city_id' }] : [];
    if (/SELECT merged_into_city_id FROM tbl_city/i.test(t)) {
      const v = map[Number(p[0])];
      return [{ merged_into_city_id: v === undefined ? null : v }];
    }
    return [];
  };
}

test('forward · one hop', async () => {
  const { pincode } = loadWith(pointerWorld({ 500: 900 }));
  assert.equal(await pincode.resolveMergedCity(500), 900);
});

test('forward · follows a chain to its end', async () => {
  const { pincode } = loadWith(pointerWorld({ 500: 900, 900: 901 }));
  assert.equal(await pincode.resolveMergedCity(500), 901);
});

test('forward · a city with no pointer is returned unchanged', async () => {
  const { pincode } = loadWith(pointerWorld({}));
  assert.equal(await pincode.resolveMergedCity(500), 500);
});

test('forward · a cycle terminates instead of spinning', async () => {
  /*
   * No path can build A→B→A today (reject requires a PENDING city and an
   * ACTIVE replacement, and a city is pending only once). But this walk now
   * runs on every automatic city resolution, over a column an operator or a
   * backfill can write, so an unguarded loop would hang a request thread.
   */
  const { pincode } = loadWith(pointerWorld({ 500: 900, 900: 500 }));
  assert.equal(await pincode.resolveMergedCity(500), 900);
});

test('forward · a long chain stops at the hop limit', async () => {
  const chain = {};
  for (let i = 1; i <= 40; i += 1) chain[i] = i + 1;
  const { pincode } = loadWith(pointerWorld(chain));
  const out = await pincode.resolveMergedCity(1);
  assert.ok(out > 1 && out <= 9, `walk must stop at the cap, landed on ${out}`);
});

test('forward · returns the target even when the target is INACTIVE', async () => {
  /*
   * The design decision this test exists to pin down. If B was deactivated
   * after A was merged into it, B is still the city that holds this town's
   * history — one more row belongs with them. The tempting alternative, "give
   * up and mint a fresh pending city", would re-split precisely what the merge
   * just joined, and would do it silently.
   */
  const { pincode } = loadWith((t, p) => {
    if (hasApprovalCols(t)) return [{ Field: 'merged_into_city_id' }];
    if (/SELECT merged_into_city_id FROM tbl_city/i.test(t)) {
      return [{ merged_into_city_id: Number(p[0]) === 500 ? 900 : null }];
    }
    if (/city_status/i.test(t)) return [{ city_status: CITY_STATUS.INACTIVE }];
    return [];
  });
  assert.equal(await pincode.resolveMergedCity(500), 900,
    'the walk must not consult the target status — see the comment on resolveMergedCity');
});

test('forward · is a no-op where the migration has not run', async () => {
  const { calls, pincode } = loadWith(pointerWorld({ 500: 900 }, { cols: false }));
  assert.equal(await pincode.resolveMergedCity(500), 500);
  assert.equal(calls.filter((c) => /SELECT merged_into_city_id/i.test(c.sql)).length, 0,
    'the pointer column cannot be selected on a database that does not have it');
});

test('forward · a probe FAILURE is not cached as "column absent"', async () => {
  /*
   * The trap this repo already has a test for elsewhere: caching a transient
   * fault as a schema answer disables the feature for the life of the process,
   * and nothing ever retries.
   */
  let firstCall = true;
  const { pincode } = loadWith((t, p) => {
    if (hasApprovalCols(t)) {
      if (firstCall) { firstCall = false; throw new Error('ER_CON_COUNT_ERROR: too many connections'); }
      return [{ Field: 'merged_into_city_id' }];
    }
    if (/SELECT merged_into_city_id FROM tbl_city/i.test(t)) {
      return [{ merged_into_city_id: Number(p[0]) === 500 ? 900 : null }];
    }
    return [];
  });
  assert.equal(await pincode.resolveMergedCity(500), 500, 'a failed probe degrades to no forwarding');
  assert.equal(await pincode.resolveMergedCity(500), 900,
    'the very next call must re-probe — a remembered failure would disable forwarding forever');
});

/* ─── 5. both resolvers actually forward ───────────────────────────────── */

test("resolver · geocodeAndMatch forwards, and takes the REPLACEMENT's state", async () => {
  /*
   * The second unfiltered exact-name lookup, and the one that fires FIRST in
   * the ensurePincode flow. Forwarding only findOrCreateCityByName would leave
   * this path binding new pincodes to the rejected city.
   *
   * The returned `city.name` is the GEOCODER's string, not the matched row's,
   * so the name cannot show whether the re-read happened. state_id can: the
   * replacement here sits in a DIFFERENT state, which rejectCity permits (it
   * validates that the replacement is active, not that it is local). If the
   * re-read were skipped, the rejected city's state would ride along and file
   * the pincode under the wrong one.
   */
  const { pincode } = loadWith((t, p) => {
    if (hasApprovalCols(t)) return [{ Field: 'merged_into_city_id' }];
    if (/SELECT merged_into_city_id FROM tbl_city/i.test(t)) {
      return [{ merged_into_city_id: Number(p[0]) === 500 ? 900 : null }];
    }
    if (/FROM tbl_state WHERE LOWER\(TRIM\(state_name\)\)/i.test(t)) {
      return [{ state_id: 21, state_name: 'Maharashtra' }];
    }
    if (/SELECT city_id, city_name, state_id FROM tbl_city WHERE state_id = \?/i.test(t)) {
      return [{ city_id: 500, city_name: 'Palghar', state_id: 21 }];
    }
    if (/SELECT city_id, city_name, state_id FROM tbl_city WHERE city_id = \?/i.test(t)) {
      return [{ city_id: 900, city_name: 'Thane', state_id: 22 }];
    }
    return [];
  });

  const geo = require(path.join(ROOT, 'services/pincode-geocode.service'));
  const original = geo.geocodePincodeDetail;
  geo.geocodePincodeDetail = async () => ({
    geocoded: true, lat: 19.1, lng: 72.8,
    state: 'Maharashtra', district: 'Palghar', city: 'Palghar',
    country: 'India', country_code: 'IN',
  });
  try {
    const out = await pincode.geocodeAndMatch('401404');
    assert.equal(out.city.city_id, 900, 'must bind to the replacement, not the rejected city');
    assert.equal(out.city.state_id, 22,
      "the target row must be re-read — 21 here means the rejected city's state rode along");
    assert.equal(out.city.isNew, false, 'a forwarded match is still a match, not a new city');
  } finally {
    geo.geocodePincodeDetail = original;
  }
});

test('resolver · the FUZZY path deliberately has no forwarding call', () => {
  /*
   * fuzzyMatchCity restricts to (city_status = 1 OR 2 OR NULL), so a rejected
   * city (0) can never come back from it. A resolveMergedCity call on that
   * branch would be a line that cannot run — and an unreachable guard reads,
   * to the next person, as evidence that the branch is reachable.
   */
  const src = require('fs').readFileSync(path.join(ROOT, 'services/pincode.service.js'), 'utf8');
  const block = src.match(/const fuzzy = await fuzzyMatchCity\([\s\S]{0,400}?\n  }/);
  assert.ok(block, 'the fuzzy branch must still exist');
  assert.doesNotMatch(block[0], /resolveMergedCity/,
    'the fuzzy matcher already excludes status 0; forwarding there would be dead code');

  const fuzzyQuery = src.match(/SELECT city_id, city_name FROM tbl_city WHERE state_id = \? AND \([^)]*\)/);
  assert.ok(fuzzyQuery, 'the fuzzy query must still exist');
  assert.doesNotMatch(fuzzyQuery[0], /city_status = 0/,
    'if the fuzzy matcher ever starts returning inactive cities, this branch DOES need '
    + 'forwarding and the assertion above must be revisited');
});

test('resolver · a manually added pincode also lands on the REPLACEMENT city', async () => {
  /*
   * findOrCreateCityByName's OWN forward, exercised through the one caller
   * that does not pass through geocodeAndMatch first: the admin Add Pincode
   * form with a typed new city (createPincode's `newCity` branch). An operator
   * typing "Palghar" for a town that was rejected and merged into Thane must
   * get Thane, not the retired row and not a fresh duplicate.
   *
   * This test exists because the ensurePincode one below could NOT see this
   * call site: geocodeAndMatch forwards first there, so removing this forward
   * left that test green. A guard whose removal breaks no test is not guarded.
   */
  const REJECTED = 500;
  const REPLACEMENT = 900;
  const { calls, pincode } = loadWith((t, p) => {
    if (hasApprovalCols(t)) return [{ Field: 'merged_into_city_id' }];
    if (/SHOW COLUMNS/i.test(t)) return [];
    if (/SELECT merged_into_city_id FROM tbl_city/i.test(t)) {
      return [{ merged_into_city_id: Number(p[0]) === REJECTED ? REPLACEMENT : null }];
    }
    if (/SELECT pincode_id FROM tbl_pincode/i.test(t)) return [];
    if (/FROM tbl_state WHERE state_id = \?/i.test(t)) return [{ state_id: 21 }];
    // The unfiltered exact-name lookup resolves to the REJECTED city.
    if (/SELECT city_id FROM tbl_city WHERE state_id = \? AND LOWER\(TRIM\(city_name\)\)/i.test(t)) {
      return [{ city_id: REJECTED }];
    }
    if (/^\s*INSERT INTO tbl_pincode/i.test(t)) return { insertId: 70002 };
    if (/WHERE p\.pincode_id = \?|WHERE pincode_id = \?/i.test(t)) {
      return [{ pincode_id: 70002, pincode: '401404', city_id: REPLACEMENT,
                pincode_status: 1, city_name: 'Thane', state_name: 'Maharashtra' }];
    }
    return [];
  });

  await pincode.createPincode(
    { pincode: '401404', newCity: { city_name: 'Palghar', state_id: 21 } },
    { userId: 7 },
  );

  const ins = calls.find((c) => /^\s*INSERT INTO tbl_pincode/i.test(c.sql));
  assert.ok(ins, 'a tbl_pincode INSERT must have been issued');
  assert.ok(ins.params.includes(REPLACEMENT),
    `must file under the replacement ${REPLACEMENT}; params were ${JSON.stringify(ins.params)}`);
  assert.ok(!ins.params.includes(REJECTED),
    `city ${REJECTED} was merged away — nothing new may point at it`);
  assert.ok(!calls.some((c) => /^\s*INSERT INTO tbl_city/i.test(c.sql)),
    'the replacement must be reused, not duplicated');
});

test('resolver · ensurePincode attaches a new pincode to the REPLACEMENT city', async () => {
  /*
   * End-to-end through the primary defect site. findOrCreateCityByName's
   * exact-name lookup is the one an operator actually hit: reject "Palghar"
   * into "Thane", and the next pincode whose geocoded city is exactly
   * "Palghar" used to be filed under the retired row — invisible in every
   * picker, unreachable from the queue, quietly accumulating.
   *
   * Asserted on the INSERT's city_id rather than on the return value: the
   * function returns the same row shape whichever city it picked.
   */
  const REJECTED = 500;
  const REPLACEMENT = 900;
  const { calls, pincode } = loadWith((t, p) => {
    if (hasApprovalCols(t)) return [{ Field: 'merged_into_city_id' }];
    if (/SHOW COLUMNS/i.test(t)) return [];
    if (/SELECT merged_into_city_id FROM tbl_city/i.test(t)) {
      return [{ merged_into_city_id: Number(p[0]) === REJECTED ? REPLACEMENT : null }];
    }
    if (/AS covered/i.test(t)) return [{ covered: 0 }];
    if (/FROM tbl_state WHERE LOWER\(TRIM\(state_name\)\)/i.test(t)) {
      return [{ state_id: 21, state_name: 'Maharashtra' }];
    }
    // Both unfiltered exact-name lookups resolve to the REJECTED city.
    if (/FROM tbl_city WHERE state_id = \? AND LOWER\(TRIM\(city_name\)\)/i.test(t)) {
      return [{ city_id: REJECTED, city_name: 'Palghar', state_id: 21 }];
    }
    if (/SELECT city_id, city_name, state_id FROM tbl_city WHERE city_id = \?/i.test(t)) {
      return [{ city_id: REPLACEMENT, city_name: 'Thane', state_id: 21 }];
    }
    if (/^\s*INSERT INTO tbl_pincode/i.test(t)) return { insertId: 70001 };
    if (/FROM tbl_city\b[\s\S]*WHERE city_id = \?/i.test(t)) {
      return [{ city_id: REPLACEMENT, city_name: 'Thane', state_id: 21 }];
    }
    if (/WHERE p\.pincode_id = \?|WHERE pincode_id = \?/i.test(t)) {
      return [{ pincode_id: 70001, pincode: '401404', city_id: REPLACEMENT,
                pincode_status: 0, city_name: 'Thane', state_name: 'Maharashtra' }];
    }
    return [];
  });

  const geo = require(path.join(ROOT, 'services/pincode-geocode.service'));
  const original = geo.geocodePincodeDetail;
  geo.geocodePincodeDetail = async () => ({
    geocoded: true, lat: 19.1, lng: 72.8,
    state: 'Maharashtra', district: 'Palghar', city: 'Palghar',
    country: 'India', country_code: 'IN',
  });
  try {
    await pincode.ensurePincode('401404', {});
  } finally {
    geo.geocodePincodeDetail = original;
  }

  const ins = calls.find((c) => /^\s*INSERT INTO tbl_pincode/i.test(c.sql));
  assert.ok(ins, 'a tbl_pincode INSERT must have been issued');
  assert.ok(ins.params.includes(REPLACEMENT),
    `the pincode must be filed under city ${REPLACEMENT}; params were ${JSON.stringify(ins.params)}`);
  assert.ok(!ins.params.includes(REJECTED),
    `city ${REJECTED} was rejected and merged away — nothing new may point at it`);

  // And no duplicate was minted: forwarding must REUSE the replacement, not
  // fall through to the mint-a-pending-city path.
  assert.ok(!calls.some((c) => /^\s*INSERT INTO tbl_city/i.test(c.sql)),
    'forwarding must reuse the replacement, never mint a same-named duplicate beside it');
});
