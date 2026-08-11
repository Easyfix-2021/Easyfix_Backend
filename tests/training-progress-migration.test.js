const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migrationPath = path.join(
  __dirname,
  '..',
  'migrations',
  '2026-08-11-02-training-progress-uniqueness.sql',
);
const migration = fs.readFileSync(migrationPath, 'utf8');

test('training dedupe uses the exact table name declared by LOCK TABLES', () => {
  assert.match(
    migration,
    /LOCK TABLES\s+easyfixer_watched_video\s+WRITE/i,
  );
  assert.match(
    migration,
    /UPDATE\s+easyfixer_watched_video\s+JOIN\s+tmp_training_progress_dedupe/i,
  );
  assert.match(
    migration,
    /DELETE FROM\s+easyfixer_watched_video/i,
  );
  assert.doesNotMatch(
    migration,
    /UPDATE\s+easyfixer_watched_video\s+(?:AS\s+)?[a-z][a-z0-9_]*\s+JOIN/i,
  );
  assert.doesNotMatch(
    migration,
    /FROM\s+easyfixer_watched_video\s+(?:AS\s+)?[a-z][a-z0-9_]*\s+JOIN/i,
  );
});

test('training migration documents writer quiescence and verifies uniqueness', () => {
  assert.match(migration, /writers stopped\/drained/i);
  assert.match(migration, /writers stopped until/i);
  assert.match(
    migration,
    /UNIQUE KEY uq_easyfixer_watched_video \(easyfixer_id, video_id\)/i,
  );
  assert.match(migration, /GROUP BY easyfixer_id, video_id HAVING n > 1/i);
});
