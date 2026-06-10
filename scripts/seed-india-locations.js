#!/usr/bin/env node
/* eslint-disable no-console */
/*
 * One-time India locations seeder (CLI shim — original 2026-06-08).
 *
 *   node scripts/seed-india-locations.js <csv-path> [--force] [--dry-run]
 *
 * The actual seeding logic lives in services/india-locations.service.js
 * so both this CLI AND the HTTP endpoint POST /api/admin/india-locations/seed
 * share the same implementation. See the service module for the full
 * design rationale (idempotency, schema notes, property gate, etc.).
 *
 * This wrapper only:
 *   - parses argv
 *   - prints human-readable progress / final stats
 *   - exits with the appropriate process code
 */

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { runSeed } = require('../services/india-locations.service');

async function main() {
  const args = process.argv.slice(2);
  const csvPath = args.find((a) => !a.startsWith('--'));
  const force = args.includes('--force');
  const dryRun = args.includes('--dry-run');

  if (!csvPath) {
    console.error('Usage: node scripts/seed-india-locations.js <csv-path> [--force] [--dry-run]');
    process.exit(2);
  }
  if (!fs.existsSync(csvPath)) {
    console.error(`ERROR: CSV file not found at ${path.resolve(csvPath)}`);
    process.exit(2);
  }

  // Minimal logger shim — forwards info / warn to console so the CLI keeps
  // its original "streamed progress" UX. The service expects pino-like
  // .info/.warn methods.
  const cliLogger = {
    info: (m) => console.log(typeof m === 'string' ? m : JSON.stringify(m)),
    warn: (m) => console.warn(typeof m === 'string' ? m : JSON.stringify(m)),
    error: (m) => console.error(typeof m === 'string' ? m : JSON.stringify(m)),
  };

  const result = await runSeed({ csvPath, force, dryRun, logger: cliLogger });

  if (result.skipped) {
    console.log(result.reason);
    process.exit(0);
  }

  const { stats, took_ms: tookMs } = result;
  console.log('─'.repeat(60));
  console.log(`Done${dryRun ? ' (dry-run; no writes)' : ''}.`);
  console.log(`  rows_seen           : ${stats.rows_seen.toLocaleString('en-IN')}`);
  console.log(`  rows_invalid        : ${stats.rows_invalid.toLocaleString('en-IN')}`);
  console.log(`  states_created      : ${stats.states_created}`);
  console.log(`  cities_created      : ${stats.cities_created}`);
  console.log(`  pincodes_inserted   : ${stats.pincodes_inserted.toLocaleString('en-IN')}`);
  console.log(`  pincodes_skipped_dupe: ${stats.pincodes_skipped_dupe.toLocaleString('en-IN')}`);
  console.log(`  took_ms             : ${tookMs.toLocaleString('en-IN')}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
