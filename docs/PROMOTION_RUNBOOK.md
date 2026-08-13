# Branch Promotion Runbook — EasyFix_Backend

How a change gets from `HotFix` to QA and then to Production, and the two
things that must happen in a specific order or the deploy breaks.

## Branch model

```
HotFix  ──►  QA  ──►  Production
```

Promotion is **one-directional**. `HotFix` is always ahead; QA and Production
carry no commits that `HotFix` lacks. Nothing is developed on QA or Production
directly — if a fix is needed there, it starts on `HotFix` and is promoted.

| Branch | What a push does |
|---|---|
| `QA` | `.github/workflows/deploy.yml` → build image → ECR → SSM `docker compose up` on the QA EC2 |
| `Production` | same pipeline against `PROD_INSTANCE_ID` |

`.github/workflows/ci.yml` (build + lint + tests + `check:offline`) runs on
**pull requests** into QA/Production and on manual dispatch — not on push. A
promotion done as a direct merge and push therefore deploys *without* CI
gating it. Open a PR when you want the gate.

## One-time setup, per clone

```bash
npm run hooks:install
```

This sets `core.hooksPath` to `.githooks` (the pre-commit contract guard) and
registers the `theirs` merge driver that `.gitattributes` names for
`docs/offline-reliability-sync.json`. Git will not take either setting from a
tracked file, because both execute arbitrary commands — so without this the
merge attribute is inert and that file conflicts on every promotion.

## Promotion sequence

### 1. Apply pending migrations to the target environment FIRST

Anything still sitting in `migrations/` (not `migrations/executed/`) must be
applied to that environment's database **before** the image is deployed. The
container begins serving as soon as `docker compose up` reports healthy, and
route SQL that references a not-yet-added column fails immediately.

Statement-by-statement, per `feedback` style — expect `Duplicate column name`
on any line already applied.

Then confirm the schema matches what startup expects:

```bash
npm run verify:schema
```

Startup verification fails closed on a partially applied migration, so a
half-run migration takes the container down rather than serving broken reads.

### 2. Merge and push

```bash
git checkout QA
git merge HotFix
git push origin QA
```

`docs/offline-reliability-sync.json` resolves automatically to the incoming
copy via the merge driver. If it still conflicts, `npm run hooks:install` was
never run in this clone.

Watch the deploy in GitHub Actions, then confirm the smoke test passed
(`/api/health`).

Repeat for `Production` once QA looks good.

### 3. Re-record the offline reliability contract

```bash
npm run offline:record:worktree
git status --short
```

`docs/offline-reliability-sync.json` stores a SHA-256 over the watched source
files, and the merge driver picks a **parent's** hash. That is correct for an
ordinary promotion, where the merged tree equals the incoming tree. It is
wrong whenever the merge produced a tree that matches neither parent — a
genuine three-way merge, a conflict resolved by hand, or a migration moved
into `executed/` as part of the promotion. In those cases the recorded hash
describes source that no longer exists, and the next PR into QA/Production
fails `check:offline`.

Running the command always is the simple safe habit: if nothing changed it
rewrites identical bytes and `git status` stays clean. If it does show a diff,
commit it — that is the contract catching a real drift.

> `offline:record:worktree` runs `npm run test:offline` first, so it also
> re-proves the idempotency, identity and training-progress suites against the
> merged tree before recording.

## Order that matters

1. Migrations applied to the target DB
2. `npm run verify:schema`
3. Merge + push (deploy fires)
4. `npm run offline:record:worktree`

Steps 1 and 3 are the pair that causes real outages when reversed.

## Related

- [`OFFLINE-RELIABILITY.md`](OFFLINE-RELIABILITY.md) — what the contract covers
  and the future-change workflow
- [`AWS_DEPLOYMENT_GUIDE.md`](AWS_DEPLOYMENT_GUIDE.md) — EC2/ECR topology
- `.gitattributes` — why the sync manifest merges as `theirs`
