const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  ACTIVE_AADHAAR_GENERATED_COLUMN_SQL,
  matchesActiveAadhaarGeneratedColumn,
  matchesTrainingMonotonicTrigger,
} = require('../scripts/schema-verify')._internals;

test('startup accepts only the audited active-Aadhaar generated expression', () => {
  // Production MySQL omits MariaDB's IS_GENERATED metadata field.
  const correct = {
    extra: 'VIRTUAL GENERATED',
    generation_expression: `CASE WHEN NOT (efr_status <=> 3)
      THEN NULLIF(TRIM(adhaar_card_number), _utf8mb4'') ELSE NULL END`,
  };
  assert.equal(matchesActiveAadhaarGeneratedColumn(correct), true);
  assert.equal(matchesActiveAadhaarGeneratedColumn({
    ...correct,
    extra: 'PERSISTENT',
  }), true, 'MariaDB metadata remains compatible without querying IS_GENERATED');
  assert.equal(matchesActiveAadhaarGeneratedColumn({
    ...correct,
    extra: '',
  }), false, 'a plain column must fail closed');
  assert.equal(matchesActiveAadhaarGeneratedColumn({
    ...correct,
    generation_expression: 'NULLIF(TRIM(adhaar_card_number), \'\')',
  }), false, 'deleted technicians must remain excluded by the exact expression');
});

test('startup generated-column metadata query stays compatible with MySQL', () => {
  assert.doesNotMatch(
    ACTIVE_AADHAAR_GENERATED_COLUMN_SQL,
    /\bIS_GENERATED\b/i,
    'IS_GENERATED is MariaDB-only and crashes the production MySQL verifier',
  );
  assert.match(ACTIVE_AADHAAR_GENERATED_COLUMN_SQL, /\bGENERATION_EXPRESSION\b/i);
  assert.match(ACTIVE_AADHAAR_GENERATED_COLUMN_SQL, /\bEXTRA\b/i);
});

test('startup accepts only the monotonic BEFORE UPDATE training trigger', () => {
  const correct = {
    event_object_table: 'easyfixer_watched_video',
    action_timing: 'BEFORE',
    event_manipulation: 'UPDATE',
    action_statement: `SET NEW.watched_percentage = GREATEST(
      COALESCE(OLD.watched_percentage, 0),
      COALESCE(NEW.watched_percentage, 0)
    )`,
  };
  assert.equal(matchesTrainingMonotonicTrigger(correct), true);
  assert.equal(matchesTrainingMonotonicTrigger({
    ...correct,
    action_statement: 'SET NEW.watched_percentage = NEW.watched_percentage',
  }), false);
  assert.equal(matchesTrainingMonotonicTrigger({ ...correct, action_timing: 'AFTER' }), false);
});
