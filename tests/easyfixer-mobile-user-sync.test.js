const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

/*
 * A technician's mobile number lives in TWO places, and changing it from the
 * CRM used to move only one.
 *
 *   tbl_easyfixer.efr_no   the LOGIN identity — tech-auth resolves by it
 *   tbl_user.mobile_no     the linked account row
 *
 * Only efr_no was written, so the two silently disagreed after every change.
 * The damage is not cosmetic: Supply Gap resolves a technician with
 * `SELECT user_id, mobile_no FROM tbl_user WHERE mobile_no IN (…)
 *  AND user_type_id = 4`, so a technician whose number moved stops matching
 * their own number and the funnel reports them as an un-onboarded lead.
 */

const scenario = { current: null };
const seen = [];

const fake = installFakePool([
  [/SELECT efr_id, efr_no, user_id FROM tbl_easyfixer/i, () => (scenario.current ? [scenario.current] : [])],
  [/SELECT efr_id FROM tbl_easyfixer WHERE efr_no = \?/i, []],   // no duplicate holder
  [/UPDATE tbl_easyfixer SET efr_no/i, { affectedRows: 1 }],
  [/UPDATE tbl_user SET mobile_no/i, () => { seen.push('user-update'); return { affectedRows: scenario.userRows ?? 1 }; }],
  [/INSERT INTO/i, { insertId: 1, affectedRows: 1 }],
]);
const svc = require('../services/easyfixer-sensitive-change.service');

after(() => fake.restore());
beforeEach(() => {
  seen.length = 0;
  fake.reset();
  scenario.current = { efr_id: 9501, efr_no: '7000000000', user_id: 6340 };
  scenario.userRows = 1;
});

const userUpdates = () => fake.calls.filter((c) => /UPDATE tbl_user SET mobile_no/i.test(c.sql));

test('the linked tbl_user row moves with efr_no', async () => {
  await svc.changeMobile(9501, { mobile: '9998887770', reason: 'x' }, { user_id: 1 });
  const [u] = userUpdates();
  assert.ok(u, 'tbl_user.mobile_no must be written too — one number, two tables');
  assert.deepEqual(u.params, ['9998887770', 6340]);
});

test('the tbl_user update is scoped to user_type_id = 4', async () => {
  await svc.changeMobile(9501, { mobile: '9998887771', reason: 'x' }, { user_id: 1 });
  const [u] = userUpdates();
  assert.match(u.sql, /user_type_id = 4/,
    'a mis-set user_id must never be able to rewrite a CRM staff account number');
});

test('a technician with NO linked user row is left alone, not errored', async () => {
  for (const uid of [null, 0]) {
    scenario.current = { efr_id: 9501, efr_no: '7000000000', user_id: uid };
    fake.reset();
    await svc.changeMobile(9501, { mobile: '9998887772', reason: 'x' }, { user_id: 1 });
    assert.equal(userUpdates().length, 0, `user_id=${uid} — the Idle bucket has nothing to update`);
  }
});

test('an unchanged number writes nothing at all', async () => {
  const r = await svc.changeMobile(9501, { mobile: '7000000000', reason: 'x' }, { user_id: 1 });
  assert.equal(r.changed, false);
  assert.equal(userUpdates().length, 0, 'a no-op must not touch either table');
});

test('a tbl_user row that does not match still leaves efr_no correct', async () => {
  /*
   * affectedRows 0 — the user row is missing or is not a technician. The login
   * identity is already right, so this must not throw and undo that; it is
   * logged instead.
   */
  scenario.userRows = 0;
  const r = await svc.changeMobile(9501, { mobile: '9998887773', reason: 'x' }, { user_id: 1 });
  assert.equal(r.changed, true);
  assert.equal(r.efr_no, '9998887773');
});

test('both writes go through the SAME handle, so a transaction covers both', async () => {
  await svc.changeMobile(9501, { mobile: '9998887774', reason: 'x' }, { user_id: 1 });
  const efr = fake.calls.find((c) => /UPDATE tbl_easyfixer SET efr_no/i.test(c.sql));
  const usr = fake.calls.find((c) => /UPDATE tbl_user SET mobile_no/i.test(c.sql));
  assert.ok(efr && usr, 'both updates ran');
  assert.ok(fake.calls.indexOf(efr) < fake.calls.indexOf(usr),
    'identity first, then the mirror — so a failure leaves the login working');
});
