'use strict';
/*
 * The Tx app's Work Area city search (GET /shared/lookup/cities?withPincodes=1).
 * tbl_city also holds thousands of one-PIN post-office "cities"; the plain
 * lookup sorts alphabetically under a cap, so "Gur" offered "Air Force Gurgaon"
 * and could cut Gurugram off (owner, 2026-09-28). Here: cities owning a PIN,
 * prefix first, then most PINs; "Gurgaon" also finds "Gurugram".
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const fake = installFakePool([
  [/FROM tbl_city c\s+JOIN tbl_pincode p/, () => [
    { city_id: 2, city_name: 'Gurugram', state_id: 13, state_name: 'Haryana', pincode_count: '2' },
  ]],
  [/FROM tbl_city/, () => [{ city_id: 689, city_name: 'Air Force Gurgaon', state_id: 13 }]],
]);
const lookup = require('../services/lookup.service');

test('withPincodes: joins PINs, no coverage filter, prefix then PIN count, count as a number', async () => {
  fake.reset();
  const rows = await lookup.cities({ q: 'Gur', limit: 20, withPincodes: true });
  const q = fake.calls.at(-1);
  assert.match(q.sql, /JOIN tbl_pincode p ON p\.city_id = c\.city_id/);
  assert.doesNotMatch(q.sql, /pincode_status/, 'coverage status must not hide uncovered PINs');
  assert.match(q.sql, /ORDER BY \(c\.city_name LIKE \?\) DESC, pincode_count DESC/);
  assert.deepEqual(q.params, ['%gur%', 'gur%', 20]);
  assert.equal(rows[0].pincode_count, 2);
});

test('withPincodes: a renamed city answers to either name', async () => {
  fake.reset();
  await lookup.cities({ q: 'Gurgaon', limit: 20, withPincodes: true });
  assert.deepEqual(fake.calls.at(-1).params, ['%gurgaon%', '%gurugram%', 'gurgaon%', 'gurugram%', 20]);
  fake.reset();
  await lookup.cities({ q: 'Gurugram', limit: 20, withPincodes: true });
  assert.deepEqual(fake.calls.at(-1).params.slice(0, 2), ['%gurugram%', '%gurgaon%']);
});

test('the plain lookup (CRM pickers) is unchanged', async () => {
  fake.reset();
  await lookup.cities({ q: 'Gur', limit: 20 });
  const q = fake.calls.at(-1);
  assert.doesNotMatch(q.sql, /tbl_pincode/);
  assert.match(q.sql, /ORDER BY city_name ASC LIMIT \?/);
});
