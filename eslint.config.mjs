/*
 * EasyFix_Backend — ESLint flat config (ESLint 9).
 *
 * ─── WHY THIS EXISTS ───────────────────────────────────────────────────────
 *
 * `npm run build` in this repo is `node scripts/build-check.js`, i.e. a
 * `node --check` sweep over every .js file. That is a SYNTAX check and nothing
 * more. A reference to a variable that does not exist is perfectly valid
 * syntax — it fails at RUNTIME, on the line, when the line executes.
 *
 * That is exactly how `POST /api/admin/calls/web-start` shipped a 500 to
 * production: a conference block was copy-pasted out of /click-to-call and kept
 * its `resolvedProvider === 'plivo' &&` guard. `resolvedProvider` is a local of
 * the /click-to-call handler; in the web-start handler it simply does not
 * exist. Build passed. Tests passed (they covered the service either side of
 * the seam, not the handler). Every web call ReferenceError'd.
 *
 * `no-undef` catches that class of bug in milliseconds, across every file, with
 * no test to write. That rule is the point of this file. Everything else here
 * is a small set of same-family "this is a bug, not a style opinion" checks.
 *
 * ─── WHAT THIS IS DELIBERATELY NOT ─────────────────────────────────────────
 *
 * NOT a formatter and NOT a style gate. No `quotes`, no `semi`, no `indent`, no
 * `comma-dangle`, no naming conventions. This codebase carries years of
 * accumulated style across ~405 files; turning any of that on would bury the
 * one signal we actually want under thousands of cosmetic findings and make
 * every future diff unreviewable. If you are tempted to add a stylistic rule
 * here, put it in a formatter (prettier) behind its own separate decision —
 * do not put it in the gate that blocks deploys.
 *
 * Rule bar for anything added below: "a hit is a latent runtime failure or a
 * dead branch, essentially always." If a rule needs judgement to triage, it
 * belongs in code review, not here.
 *
 * ─── RUNNING IT ────────────────────────────────────────────────────────────
 *
 *   npm run lint           # eslint . --max-warnings=0
 *
 * Wired into CI in .github/workflows/ci.yml (PR path) and deploy.yml's
 * `precheck` job (push path), alongside `npm run build` and `npm test`, so a
 * `no-undef` can never reach QA or Production again.
 *
 * ─── ESCAPE HATCH ──────────────────────────────────────────────────────────
 *
 * Targeted, one line, with a reason:
 *
 *   // eslint-disable-next-line no-unused-vars -- destructured to document the
 *   // webhook payload shape; the field is intentionally not read here.
 *
 * Never a file-level `/* eslint-disable *\/`. If a whole file fights a rule,
 * the rule is wrong for this repo — turn it off here, with a note, so the
 * decision is visible in one place.
 */

import globals from 'globals';

export default [
  // ── Exclusions ───────────────────────────────────────────────────────────
  // Mirrors the SKIP set in scripts/build-check.js so `npm run lint` and
  // `npm run build` cover exactly the same file population.
  {
    ignores: [
      'node_modules/**',
      'uploads/**',       // runtime file drop, not source
      'logs/**',          // runtime
      'coverage/**',      // generated
      'dist/**',          // generated (not currently produced, kept in sync
      'build/**',         //   with build-check.js's SKIP set)
      'stt-service/**',   // Python sidecar — no JS, and its venv/__pycache__
                          //   must never be walked
    ],
  },

  // ── The whole backend ────────────────────────────────────────────────────
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      // CommonJS is the DEFAULT because every .js file in this repo is
      // `require`/`module.exports`. Getting this wrong is how you get a flood of
      // false `no-undef` on `require`/`module`.
      //
      // The five .mjs files (scripts/*.mjs + this config) are ESM and are
      // re-pointed at sourceType 'module' by the block below. They match here so
      // they inherit this rule set — until 2026-09-09 the glob was '**/*.js'
      // only, so `eslint .` walked them, applied NO rules, and reported them
      // clean. Two of them are CI gates.
      sourceType: 'commonjs',
      ecmaVersion: 2022,
      globals: {
        // globals.node  → require, module, exports, process, __dirname, Buffer,
        //                 console, setTimeout/Interval/Immediate, URL,
        //                 URLSearchParams, fetch, AbortController, TextEncoder,
        //                 structuredClone, performance, queueMicrotask, …
        //                 (i.e. the Node 18+ global surface — omitting this
        //                 produces hundreds of false positives immediately)
        // globals.es2021 → globalThis, BigInt, Promise, Symbol, Proxy, Reflect,
        //                 WeakRef, FinalizationRegistry
        ...globals.node,
        ...globals.es2021,
      },
    },
    linterOptions: {
      // The codebase already carries ~30 `eslint-disable-next-line` comments
      // written speculatively against rules this config does NOT enable
      // (no-console, global-require, no-await-in-loop, no-shadow, …). ESLint 9
      // defaults this meta-check to 'warn', and `--max-warnings=0` would turn
      // every one of those dormant comments into a CI failure — punishing
      // authors for defensive comments rather than catching bugs. Off.
      reportUnusedDisableDirectives: 'off',
    },
    rules: {
      /*
       * ── THE RULE ────────────────────────────────────────────────────────
       * Reference to an identifier that is not declared anywhere in scope and
       * is not a known global. This is the production-500 class:
       *   ReferenceError: resolvedProvider is not defined
       * Never downgrade this to 'warn'. A hit is not a style preference; it is
       * a line that throws the moment it runs.
       */
      'no-undef': 'error',

      /*
       * ── THE SECOND RULE, AND WHY no-undef WAS NOT ENOUGH ────────────────
       *
       * On 2026-08-20 the Manage Jobs export returned "Internal Server Error"
       * for every operator, on every filter. The cause, in routes/admin/jobs.js:
       *
       *     const imposed = buildExportWhere(filters).appliedDefaults || [];  // 426
       *     …
       *     const filters = { ...req.query, scope: req.scope, … };            // 451
       *
       * `filters` was READ twenty-five lines ABOVE its own declaration — the
       * TEMPORAL DEAD ZONE. `const` is not hoisted the way `var` is, so that is
       * a throw, not undefined:
       *
       *     ReferenceError: Cannot access 'filters' before initialization
       *
       * no-undef does NOT catch it, and that is the whole point of adding this:
       * the identifier IS declared and IS in scope, just later. To no-undef the
       * code is correct. It is the ENGINE that objects, at runtime, on the line.
       *
       * The same properties that hid the web-start 500 hid this one: the module
       * still IMPORTS cleanly (a dead-zone read only fires when the function
       * RUNS), so `node --check` passed, `require()` printed nothing, and the
       * 38 tests covering that export all exercised the service beneath the
       * route rather than the handler itself. Everything was green through a
       * total outage of the feature.
       *
       * It then happened a SECOND time the same day, in the same file, from a
       * different author who had been told about the first one — which is the
       * argument for a rule rather than a note. Knowing about this class does
       * not prevent it; only a check that runs does.
       *
       * ⚠ `variables: false` IS THE LOAD-BEARING SETTING, and it reads backwards.
       * It does NOT mean "don't check variables". Per the rule's own docs it
       * means: ignore a reference when the declaration is in an UPPER scope.
       *
       * That is exactly the line this codebase needs drawn. Measured with
       * `variables: true` first: 20 errors, and every single one was SAFE — a
       * module-scope const referenced from inside a function defined above it,
       * such as WEEKDAY_RE used at whatsapp-conversation.service.js:494 and
       * declared at :522, or `pool` in this very file. Those functions only run
       * after the module has finished evaluating, so the binding always exists.
       * Zero of the 20 could ever throw. Turning the rule on that way would have
       * failed CI on day one over twenty non-bugs — precisely the outcome the
       * header of this file warns gets a linter --no-verify'd and then deleted.
       *
       * With `variables: false` the rule reports only a reference whose
       * declaration is in the SAME scope — straight-line code inside one
       * function body. That is the export bug exactly, and it is the only shape
       * that actually throws. Measured after: ZERO hits repo-wide, so this goes
       * on at no cleanup cost and the gate stays green.
       *
       * `functions: false` is deliberate — function DECLARATIONS are hoisted and
       * calling one above its definition is a normal, safe idiom used widely in
       * this codebase. Only let/const/class have a dead zone, so only those are
       * reported. `classes: false` for the same reason as functions: this repo
       * has no class-before-use pattern to protect, and reporting it would be a
       * style opinion rather than a runtime failure.
       */
      'no-use-before-define': ['error', {
        variables: false,  // see the note above — this is the load-bearing option
        functions: false,  // hoisted; calling one above its definition is fine
        classes: false,
      }],

      /*
       * ── Same family: guaranteed-runtime-failure ─────────────────────────
       * All of these are "the engine will throw" or "this code provably cannot
       * behave as written". None require judgement to triage.
       */
      'no-const-assign': 'error',   // TypeError: Assignment to constant variable
      'no-dupe-args': 'error',      // function f(a, a) — second silently wins
      'no-dupe-keys': 'error',      // { a: 1, a: 2 } — the first value is lost
      'no-dupe-else-if': 'error',   // an else-if branch that can never be taken
      'no-duplicate-case': 'error', // a switch case that can never be taken
      'no-func-assign': 'error',    // reassigning a function declaration
      'no-obj-calls': 'error',      // Math() / JSON() — always a TypeError
      'no-self-assign': 'error',    // x = x — always a typo for something else
      'no-unsafe-negation': 'error',// !k in obj (means (!k) in obj)
      'no-unsafe-finally': 'error', // return/throw in finally discards the real
                                    //   outcome of try/catch — silent data loss
      'use-isnan': 'error',         // x === NaN is always false
      'valid-typeof': 'error',      // typeof x === 'strng'
      'getter-return': 'error',     // a getter that returns undefined
      'no-ex-assign': 'error',      // overwriting the caught error
      'no-async-promise-executor': 'error', // new Promise(async …) swallows throws

      /*
       * ── console, and why this could only be turned on today ──────────────
       *
       * CLAUDE.md coding rule 6 has always said "No `console.log` — use
       * `logger`". It was enforced by review only: `no-console` was deliberately
       * NOT enabled, and the header below explains the cost of enabling a rule
       * the tree does not already satisfy — a gate that is red on arrival gets
       * `--no-verify`'d and then deleted.
       *
       * On 2026-09-08 the last nine `console.warn` calls in routes/, services/,
       * middleware/, utils/ and lib/ were migrated to `logger.warn`, so the
       * production tree satisfies the rule and it costs nothing to turn on.
       *
       * WHY THE RULE IS WORTH HAVING, beyond tidiness — `console` bypasses
       * everything logger.js does: the AsyncLocalStorage request context
       * (utils/request-context) that stamps a line with its request identity,
       * and `redactUrl` (utils/log-format), which scrubs magic-link tokens and
       * customer mobile numbers out of logged URLs. A console line in a request
       * path is therefore both unattributable and un-redacted.
       *
       * TWO of those nine calls also proved that the migration is not
       * mechanical: logger.js's splitArgs only lifts an OBJECT into the
       * structured field, so `logger.warn(msg, someString)` and a three-argument
       * call SILENTLY DROP the error text. See CLAUDE.md rule 6.
       *
       * No `allow: ['warn','error']` escape hatch: every one of the nine was a
       * console.warn, so allowing warn would have exempted the entire real
       * population. Sanctioned surfaces get an explicit override block below.
       */
      'no-console': 'error',

      /*
       * ── The one rule that keeps ~1300 catch blocks safe ──────────────────
       *
       * `catch (e)` binds whatever was thrown, and this codebase dereferences
       * it (`e.message`) and forwards it (`next(e)`) in ~1300 places without
       * checking the shape first. Every one of those is harmless TODAY, and
       * scripts/scan-catch-shape.js exists to keep measuring that. The reason
       * they are harmless is a property of the THROW side, not the catch side:
       *
       *   nothing in this repo, or in its 290-package production dependency
       *   tree, ever rejects with a FALSY value.
       *
       * That was verified on 2026-09-08 — 886 throw statements classified by
       * AST (zero falsy literals; all 31 object literals carry `.message`;
       * every mkErr/httpError/badReq-style factory returns `new Error`), plus a
       * positive-controlled sweep of the production tree (the four syntactic
       * candidates are all inert: a Flow type-comment in xlsx, a
       * `typeof util.inherits !== 'function'` branch that is dead on Node, and
       * a bare-stream file that is never loaded outside the Bare runtime).
       *
       * It matters because a falsy rejection is the SEVERE half of the defect:
       * `next(null)` is read by Express 4 as "no error, continue", so the
       * request falls through to the 404 handler with no 500 and nothing
       * logged. The failure is indistinguishable from success — no log line, no
       * error-rate blip, nothing to alert on.
       *
       * `Promise.reject()` with no argument rejects with `undefined`, and is
       * the only remaining way to produce that without writing a literal
       * `throw null`. This rule forbids it. Measured at ZERO violations
       * repo-wide before enabling, so it goes on at no cleanup cost and the
       * gate stays green — the bar the header of this file sets.
       *
       * ⚠ Its sibling `no-throw-literal` is deliberately NOT enabled. It would
       * guard the other half of the same invariant, but it has 37 violations
       * (measured), every one the deliberate `throw { status, code, message }`
       * idiom in utils/jwt.js and the magic-link/maps services. Those are
       * truthy and carry `.message`, so they are cosmetic at worst — turning
       * the rule on would fail CI on day one over 37 non-bugs, which by this
       * file's own history is how a linter gets --no-verify'd and then deleted.
       */
      'prefer-promise-reject-errors': 'error',

      /*
       * ── Dead code ───────────────────────────────────────────────────────
       * `no-unreachable` is how you find a `return` accidentally left above a
       * block (the exact shape of the copy-paste accident this config exists
       * for). `no-fallthrough` finds a missing `break` — a real behavioural
       * bug in a status-code switch, of which this repo has many.
       */
      'no-unreachable': 'error',
      'no-fallthrough': 'error',

      /*
       * ── Redeclaration ───────────────────────────────────────────────────
       * `const x` twice in one scope is a SyntaxError (build-check would catch
       * it); `var x` twice is silent and usually means two merged edits.
       */
      'no-redeclare': 'error',

      /*
       * ── no-unused-vars ──────────────────────────────────────────────────
       * Catches the other half of the copy-paste failure: the variables a
       * pasted block left BEHIND. Tuned so it reports bugs, not bookkeeping:
       *
       *   args: 'after-used'      Express handlers are (req, res, next) and an
       *                           error handler MUST be 4-arity to be
       *                           registered as one — reporting an unused
       *                           leading `req` would be reporting the
       *                           framework's signature, not a mistake.
       *   argsIgnorePattern '^_'  the documented way to keep a positional slot.
       *   varsIgnorePattern '^_'  same, for destructured fields kept to
       *                           document a payload shape.
       *   caughtErrors: 'none'    `catch (e) { /* best-effort *\/ }` appears
       *                           ~200× here as a deliberate idiom. Reporting
       *                           it would be pure noise and would train people
       *                           to ignore this rule.
       *   ignoreRestSiblings      `const { password, ...safe } = row` is the
       *                           standard omit idiom — the omitted key is the
       *                           whole point.
       */
      /*
       * OFF FOR NOW — deliberately, and this is not a shrug.
       *
       * On the first run it found 36 hits, of which 34 are PRE-EXISTING dead
       * code spread over 28 files with no relation to each other. Cleaning them
       * is a worthwhile chore but it is a separate change: done here it would
       * bury the diff that introduced this linter, and a few are risky enough to
       * need thought rather than deletion (an unused `require` can still be
       * loaded for a side effect).
       *
       * The reason it is OFF rather than left red: a gate that fails on day one
       * gets `--no-verify`'d, then ignored, then removed. `no-undef` and the
       * no-dupe rules are at ZERO and catch the bug class that prompted all this
       * (a copy-pasted block referencing a variable from its source scope, which
       * 500'd every web call in production). Those are worth protecting, and
       * they only stay protected if `npm run lint` is green.
       *
       * TO TURN IT ON: fix the 34, then restore the config below — it is already
       * tuned for this codebase and is left here deliberately so re-enabling is
       * one uncomment, not a fresh design. The notable one to look at first is
       * services/notification-orchestrator.service.js, which imports the email,
       * WhatsApp and FCM senders and uses NONE of them while its own header
       * documents WhatsApp as a channel — that is a product gap, not lint noise.
       */
      'no-unused-vars': 'off',
      // 'no-unused-vars': ['error', {
      //   args: 'after-used',        // Express (req,res,next) — a leading unused
      //                              // arg is the framework's signature, not a bug
      //   argsIgnorePattern: '^_',   // the documented way to keep a positional slot
      //   varsIgnorePattern: '^_',
      //   caughtErrors: 'none',      // `catch (e) { /* best-effort */ }` ~200× here
      //   ignoreRestSiblings: true,  // `const { password, ...safe } = row`
      // }],
    },
  },

  // ── ESM scripts (.mjs) ───────────────────────────────────────────────────
  // Same rule set as everything else; only the module system differs. This block
  // carries no `rules` of its own on purpose — flat config merges, so the rules
  // above apply and cannot drift apart from the .js set.
  {
    files: ['**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
      globals: {
        // CommonJS globals genuinely do NOT exist in ESM. Switching them off
        // here means `require(...)` or `__dirname` in a .mjs is caught by
        // no-undef at lint time instead of throwing at runtime — which is the
        // whole point of pointing no-undef at these files.
        require: 'off',
        module: 'off',
        exports: 'off',
        __dirname: 'off',
        __filename: 'off',
      },
    },
  },

  // ── Where console IS the output, not a mistake ───────────────────────────
  // logger.js is the sanctioned exit: the rule above exists precisely to force
  // every other file through it, so the implementation cannot be subject to it.
  // scripts/ are CLI tools whose stdout is their interface (231 calls), tests/
  // print harness detail, and docs/ holds generators. Listed explicitly rather
  // than as a broad ignore, so a NEW directory does not inherit the exemption
  // by accident — that is how a ban erodes.
  {
    files: ['logger.js', 'scripts/**/*.{js,mjs}', 'tests/**/*.js', 'docs/**/*.js', 'eslint.config.mjs'],
    rules: { 'no-console': 'off' },
  },

  // ── SQL clock functions (2026-09-16) ────────────────────────────────────
  // Every timestamp this backend writes is a bound JS Date: the pool's
  // `timezone: '+05:30'` serialises it as the IST wall clock on any host.
  // NOW() / CURDATE() read the DB SESSION zone (SYSTEM), which is IST only
  // because the host happens to be. A comparison must use the clock the column
  // was written in, so SQL clock functions in runtime code are a latent
  // off-by-5.5h the day the DB zone changes — bind `new Date()` instead
  // (`NOW()` → `?`, `CURDATE()` → `DATE(?)`).
  // Escape hatch, one line with a reason, for the two legitimate shapes:
  // reading the DB clock ON PURPOSE (/api/health/db), or comparing a column
  // that only a DB DEFAULT CURRENT_TIMESTAMP ever writes.
  {
    files: ['routes/**/*.js', 'services/**/*.js', 'middleware/**/*.js', 'lib/**/*.js',
      'utils/**/*.js', 'workers/**/*.js', 'server/**/*.js', 'shared/**/*.js', 'db.js', 'server.js'],
    rules: {
      'no-restricted-syntax': ['error',
        {
          selector: 'Literal[value=/(^|[^.\\w])(NOW|CURDATE|CURTIME|SYSDATE|UTC_TIMESTAMP|LOCALTIMESTAMP|UNIX_TIMESTAMP|CURRENT_TIMESTAMP|CURRENT_DATE)\\s*\\(/i]',
          message: 'SQL clock function: bind a JS Date instead (the pool stores it as IST). See eslint.config.mjs "SQL clock functions".',
        },
        {
          selector: 'TemplateElement[value.raw=/(^|[^.\\w])(NOW|CURDATE|CURTIME|SYSDATE|UTC_TIMESTAMP|LOCALTIMESTAMP|UNIX_TIMESTAMP|CURRENT_TIMESTAMP|CURRENT_DATE)\\s*\\(/i]',
          message: 'SQL clock function: bind a JS Date instead (the pool stores it as IST). See eslint.config.mjs "SQL clock functions".',
        },
      ],
    },
  },

  // ── Tests ────────────────────────────────────────────────────────────────
  // node:test's describe/it/before/after are IMPORTED here, not injected as
  // globals (`node --test` does not create them), so no extra globals are
  // needed and a missing import stays a genuine no-undef. This block exists
  // only to relax no-unused-vars for the fake-pool harness: test doubles
  // routinely accept (sql, params) and read just one of them, and the unread
  // parameter documents the real call signature being emulated.
  {
    files: ['tests/**/*.js'],
    rules: {
      // Deferred with the source-file rule above — see the long note there. Left
      // in place, commented, so re-enabling both is one change rather than a
      // rediscovery of why tests need `args: 'none'` (fake-pool doubles accept
      // (sql, params) and read one; the unread arg documents the real signature).
      'no-unused-vars': 'off',
      // 'no-unused-vars': ['error', {
      //   args: 'none',
      //   varsIgnorePattern: '^_',
      //   caughtErrors: 'none',
      //   ignoreRestSiblings: true,
      // }],
    },
  },
];
