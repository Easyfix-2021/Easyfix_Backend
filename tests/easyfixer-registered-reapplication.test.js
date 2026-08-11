const test = require('node:test');
const assert = require('node:assert/strict');

const easyfixer = require('../services/easyfixer.service');

test('registered reapplication provenance survives approval and verification states', () => {
  const fields = easyfixer._internals.registeredReapplicationFields(
    { efr_id: 91 },
    { status: 'UNDER_VERIFICATION', reapplicationCount: 1 },
    12345.5,
  );
  assert.deepEqual(fields, {
    is_reapplication: true,
    previous_efr_id: 91,
    lifetime_earnings: 12345.5,
  });
});

test('registration status 10 filters by durable reapplication provenance', () => {
  const { where } = easyfixer._internals.buildRegisteredWhere(
    { registrationStatus: 10 },
    null,
    true,
  );
  // Durable provenance now derives from the audit log (a transition INTO
  // REAPPLIED was recorded), not the dropped lifecycle_reapplication_count
  // column — a single set-based EXISTS, not a per-row join.
  assert.match(where, /EXISTS \(\s*SELECT 1 FROM tbl_easyfixer_lifecycle_status_log/);
  assert.match(where, /to_status = 'REAPPLIED'/);
});
