const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

/*
 * Profile 100% once Skills, Identity and Work Area are done (owner,
 * 2026-09-30): efr_profile_perc had no writer on this stack, so the CRM's
 * final activation (efr_profile_perc >= 100) and its Pending Member
 * Verification queue saw every new-app technician as incomplete.
 */
const fake = installFakePool([[/UPDATE tbl_easyfixer e/i, { affectedRows: 1 }]]);
after(() => fake.restore());
const registration = require('../services/mobile-registration.service');
const profileCompletion = require('../services/profile-completion.service');

test('the stamp writes 100 only for a complete profile, and never lowers a stored value', async () => {
  const stamped = await registration.markProfileComplete(10798);
  assert.equal(stamped, true);
  const [call] = fake.calls.filter((c) => /UPDATE tbl_easyfixer e/.test(c.sql));
  assert.match(call.sql, /SET e\.efr_profile_perc = 100/);
  assert.match(call.sql, /COALESCE\(e\.efr_profile_perc, 0\) < 100/, 'never lowers');
  const { profileComplete } = profileCompletion.sqlPredicates({ technicianAlias: 'e', userAlias: 'u' });
  assert.ok(call.sql.includes(profileComplete), 'the same predicate the app checklist reads');
  assert.deepEqual(call.params, [10798]);
});

test('every Gate 1 finalize stamps first — the one path all profile saves share', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'services/mobile-registration.service.js'), 'utf8');
  const body = src.slice(src.indexOf('async function finalizeGate1(efrId)'));
  assert.ok(body.indexOf('markProfileComplete(efrId)') > 0
    && body.indexOf('markProfileComplete(efrId)') < body.indexOf('finalizeMobileRegistrationGate1'));
});
