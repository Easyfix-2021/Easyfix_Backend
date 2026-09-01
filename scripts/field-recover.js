#!/usr/bin/env node
'use strict';

/*
 * field-recover — BREAK GLASS for lib/field-crypto.js envelopes.
 *
 * Every protected value carries its data key sealed to the RECOVERY PUBLIC KEY
 * as well as wrapped under the operational key. This tool walks that second
 * door, using the recovery PRIVATE key that lives in the owner's notes and
 * nowhere else. It is the reason losing or rotating EASYFIX_FIELD_ENC_KEY is
 * not a data-loss event.
 *
 * ── THE PRIVATE KEY HANDLING IS THE SECURITY BOUNDARY OF THIS WHOLE DESIGN ──
 *
 * The key is read from a FILE PATH or from STDIN. It is NEVER taken from an
 * environment variable and NEVER from a command-line argument, and those are not
 * stylistic choices:
 *
 *   argv  is world-readable. `ps aux`, `ps -ef`, /proc/<pid>/cmdline — any other
 *         user on the box, and every process-listing agent, monitoring sidecar
 *         and crash reporter, sees the full command line of every process. A key
 *         passed as an argument is a key published to the machine.
 *   env   leaks almost as widely: /proc/<pid>/environ, a child process that
 *         inherits it, a crash dump, an APM agent that helpfully attaches the
 *         environment to an error report. It is also exactly the place this
 *         design exists to keep the recovery key OUT of — if the recovery key
 *         is ever in env, it is no safer than the operational key it backstops.
 *
 * And it is never written, never logged, never echoed, and never attached to an
 * error. The closest anything gets to naming it is the FINGERPRINT of its public
 * half, which lib/field-crypto uses to say "this row wants key X, you supplied
 * key Y" — useful, and not key material.
 *
 * ── USAGE ───────────────────────────────────────────────────────────────
 *
 *   node scripts/field-recover.js inspect <envelope> [--key-file PATH]
 *   node scripts/field-recover.js rewrap  <envelope> [--key-file PATH]
 *
 *   --key-file PATH   read the recovery private key PEM from PATH.
 *                     Omit it and the PEM is read from STDIN:
 *                       node scripts/field-recover.js inspect 'v2:…' < recovery.pem
 *   --value-file PATH read the envelope from a file instead of the argument.
 *                     An envelope is ~1.5k characters; pasting one into a shell
 *                     is a good way to truncate it and get a confusing error.
 *
 * MODES
 *   inspect  Decrypt one value and print the plaintext to stdout. Needs ONLY the
 *            recovery private key — EASYFIX_FIELD_ENC_KEY is not read, and may
 *            be absent, wrong, or from another environment entirely.
 *   rewrap   Unseal the data key with the recovery key and re-wrap it under the
 *            CURRENT EASYFIX_FIELD_ENC_KEY, printing the new envelope to stdout.
 *            The value ciphertext and the sealed data key are copied through
 *            byte for byte, so the break-glass door stays open afterwards and a
 *            run that is interrupted has damaged nothing. This is how a lost or
 *            rotated operational key is repaired without re-encrypting anything.
 *
 * Deliberately DATABASE-FREE. It takes one envelope on the command line and
 * prints one result; the operator does the SELECT and the UPDATE. A break-glass
 * tool that also needs production database credentials to run is a tool that
 * cannot be run from a laptop during the incident it was built for — and a tool
 * that writes to the column is one bad argument away from being the incident.
 */

require('dotenv').config();

const fs = require('node:fs');
const {
  recoverField, rewrapField, isEncrypted,
} = require('../lib/field-crypto');

const MODES = new Set(['inspect', 'rewrap']);

function usage(message) {
  if (message) console.error(`field-recover: ${message}\n`);
  console.error(`Usage:
  node scripts/field-recover.js inspect <envelope> [--key-file PATH] [--value-file PATH]
  node scripts/field-recover.js rewrap  <envelope> [--key-file PATH] [--value-file PATH]

  inspect  decrypt one value with the recovery private key and print it
  rewrap   re-wrap its data key under the CURRENT EASYFIX_FIELD_ENC_KEY and
           print the new envelope

  --key-file PATH    read the recovery private key PEM from PATH
                     (omit to read the PEM from STDIN)
  --value-file PATH  read the envelope from PATH instead of the argument

The recovery private key is NEVER read from an argument or an environment
variable: argv is visible to every user on the box via \`ps\`.`);
  process.exit(2);
}

/* Minimal flag parsing — no dependency for six lines of work. Unknown flags are
 * an error rather than an ignore: a typo'd --key-file would otherwise silently
 * fall through to reading a key from an interactive stdin and just hang. */
function parseArgs(argv) {
  const out = { mode: argv[0], positional: [], keyFile: null, valueFile: null };
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--key-file') {
      i += 1;
      out.keyFile = argv[i];
      if (!out.keyFile) usage('--key-file needs a path');
    } else if (a === '--value-file') {
      i += 1;
      out.valueFile = argv[i];
      if (!out.valueFile) usage('--value-file needs a path');
    } else if (a.startsWith('--')) {
      usage(`unknown option ${a}`);
    } else {
      out.positional.push(a);
    }
  }
  return out;
}

/*
 * Read the PEM. Returned to the caller and dropped; never assigned to anything
 * module-scoped, never printed, never included in an error.
 */
function readPrivateKey(keyFile) {
  let pem;
  if (keyFile) {
    try {
      pem = fs.readFileSync(keyFile, 'utf8');
    } catch (e) {
      // e.message names the PATH, which is fine, and never the contents.
      console.error(`field-recover: could not read the key file — ${e.message}`);
      process.exit(1);
    }
  } else {
    if (process.stdin.isTTY) {
      usage('no --key-file given and STDIN is a terminal — pipe the PEM in, '
        + 'e.g. `… inspect \'v2:…\' < recovery.pem`');
    }
    pem = fs.readFileSync(0, 'utf8');   // fd 0
  }
  if (!pem || !pem.includes('-----BEGIN')) {
    usage('that does not look like a PEM private key (no -----BEGIN line)');
  }
  return pem;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!MODES.has(args.mode)) usage(args.mode ? `unknown mode "${args.mode}"` : 'a mode is required');

  let envelope = args.positional[0];
  if (args.valueFile) {
    try {
      envelope = fs.readFileSync(args.valueFile, 'utf8').trim();
    } catch (e) {
      console.error(`field-recover: could not read the value file — ${e.message}`);
      process.exit(1);
    }
  }
  if (!envelope) usage('an envelope is required (as an argument or via --value-file)');
  if (!isEncrypted(envelope)) {
    console.error('field-recover: that is not a v2 envelope. Expected'
      + ' v2:<op_fp>:<rec_fp>:… — check for a truncated copy/paste.');
    process.exit(1);
  }

  /* Everything diagnostic goes to STDERR so STDOUT carries only the result and
   * stays pipeable — and so a warning is never mistaken for the value. */
  const [, opFp, recFp] = envelope.split(':');
  console.error('┌──────────────────────────────────────────────────────────────────┐');
  console.error('│  ⚠  THIS TOOL DECRYPTS PRODUCTION SECRETS.                       │');
  console.error('│     Bank account numbers and account-holder names, in the clear. │');
  console.error('│     Run it on a machine you trust, with a reason you could state  │');
  console.error('│     out loud. Do not paste the output into a ticket or a chat.    │');
  console.error('└──────────────────────────────────────────────────────────────────┘');
  console.error(`  operational key: ${opFp}`);
  console.error(`  recovery key:    ${recFp}`);
  console.error('');

  const pem = readPrivateKey(args.keyFile);

  try {
    if (args.mode === 'inspect') {
      process.stdout.write(recoverField(envelope, pem) + '\n');
      console.error('\n  ↑ plaintext on stdout. Close this terminal when you are done.');
    } else {
      const rewrapped = rewrapField(envelope, pem);
      process.stdout.write(rewrapped + '\n');
      console.error('\n  ↑ the new envelope, on stdout. The value ciphertext and the sealed');
      console.error('    data key are byte-identical to the original — only the wrapped data');
      console.error('    key changed. Write it back, e.g.');
      console.error('      UPDATE tbl_user_personal_details SET bank_account_number = \'<above>\'');
      console.error('       WHERE user_id = <id>;');
    }
  } catch (e) {
    // e.message is written by lib/field-crypto and carries fingerprints only.
    console.error(`field-recover: ${e.code || 'FAILED'} — ${e.message}`);
    process.exit(1);
  }
}

main();
