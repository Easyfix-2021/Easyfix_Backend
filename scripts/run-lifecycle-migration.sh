#!/usr/bin/env bash
#
# run-lifecycle-migration.sh — safe, one-session applier for the two pending
# technician-lifecycle migrations:
#   migrations/2026-08-10-technician-lifecycle-status.sql   (shared tbl_easyfixer)
#   migrations/2026-08-10-index-job-offer-mobile-latest.sql (EasyFix-owned tbl_job_offer)
#
# WHY A DEDICATED RUNNER (see the prod deploy-risk analysis):
#   * The lifecycle file must run ALTER -> CREATE -> backfill as ONE uninterrupted
#     mysql session. easyfixer-work-eligibility.sqlPredicate() flips to
#     `lifecycle_status IN ('ACTIVE','UNDER_MASTER')` the instant the columns exist
#     (schema probe, 30s negative TTL). If the backfill has not committed yet, every
#     still-NULL technician is excluded and job assignment goes blank platform-wide.
#     Piping the whole file into one `mysql` invocation closes that window.
#   * Both ALTERs are already pinned ALGORITHM=INPLACE, LOCK=NONE in the .sql files
#     so they stay online and fail fast instead of COPY-rebuilding a shared table.
#
# SAFETY MODEL:
#   * DRY-RUN BY DEFAULT. It only reads (version, long-txn probe, current state,
#     a legacy-column distribution snapshot) until you pass --apply.
#   * IDEMPOTENT / re-runnable: if the columns already exist it runs ONLY the
#     idempotent tail (CREATE IF NOT EXISTS + WHERE-guarded backfill + seeds) so a
#     re-run can never error on the non-repeatable ADD COLUMN.
#   * VERIFIES after applying: backfill complete (0 NULLs), and the coupled legacy
#     columns efr_status/is_technician_verified are byte-identical before vs after.
#   * NEVER prints the DB password (uses a chmod-600 --defaults-extra-file, cleaned
#     up on exit) and NEVER promotes files into migrations/executed/ (your deploy
#     process owns that).
#
# USAGE:
#   scripts/run-lifecycle-migration.sh                 # dry run (default) — plan + checks only
#   scripts/run-lifecycle-migration.sh --apply         # actually apply both migrations
#   scripts/run-lifecycle-migration.sh --apply --strict-locks   # abort if long transactions are open
#
# CREDENTIALS: read from the environment, else from ./.env (DB_HOST, DB_PORT,
#   DB_NAME, DB_USER, DB_PASSWORD). Run it against ONE database at a time; point it
#   at prod only inside the 02:00–04:00 IST low-traffic window.

set -euo pipefail

APPLY=0
STRICT_LOCKS=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --strict-locks) STRICT_LOCKS=1 ;;
    -h|--help) grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "[FAIL] unknown argument: $arg" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${ENV_FILE:-$REPO_ROOT/.env}"
LIFECYCLE_SQL="$REPO_ROOT/migrations/2026-08-10-technician-lifecycle-status.sql"
INDEX_SQL="$REPO_ROOT/migrations/2026-08-10-index-job-offer-mobile-latest.sql"

log()  { printf '%s\n' "$*"; }
ok()   { printf '[OK]   %s\n' "$*"; }
warn() { printf '[WARN] %s\n' "$*"; }
plan() { printf '[PLAN] %s\n' "$*"; }
fail() { printf '[FAIL] %s\n' "$*" >&2; exit 1; }

command -v mysql >/dev/null 2>&1 || fail "the 'mysql' client is not on PATH"
[ -f "$LIFECYCLE_SQL" ] || fail "missing $LIFECYCLE_SQL"
[ -f "$INDEX_SQL" ]     || fail "missing $INDEX_SQL"

# --- credentials: env wins, else parse the 5 keys out of .env (no sourcing) ------
read_env() {
  local key="$1" line val
  [ -f "$ENV_FILE" ] || return 0
  line="$(grep -E "^${key}=" "$ENV_FILE" | tail -n1 || true)"
  [ -n "$line" ] || return 0
  val="${line#*=}"; val="${val%\"}"; val="${val#\"}"; val="${val%\'}"; val="${val#\'}"
  printf '%s' "$val"
}
DB_HOST="${DB_HOST:-$(read_env DB_HOST)}";         DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-$(read_env DB_PORT)}";         DB_PORT="${DB_PORT:-3306}"
DB_NAME="${DB_NAME:-$(read_env DB_NAME)}";         DB_NAME="${DB_NAME:-easyfix_core}"
DB_USER="${DB_USER:-$(read_env DB_USER)}"
DB_PASSWORD="${DB_PASSWORD:-$(read_env DB_PASSWORD)}"
[ -n "${DB_USER:-}" ] || fail "DB_USER is not set (env or $ENV_FILE)"

# --- password stays out of argv/ps: a chmod-600 defaults file, wiped on exit -----
CNF="$(mktemp "${TMPDIR:-/tmp}/lifecycle-mig.XXXXXX.cnf")"
chmod 600 "$CNF"
trap 'rm -f "$CNF"' EXIT
{
  printf '[client]\n'
  printf 'host=%s\n' "$DB_HOST"
  printf 'port=%s\n' "$DB_PORT"
  printf 'user=%s\n' "$DB_USER"
  printf 'password=%s\n' "$DB_PASSWORD"
} > "$CNF"
MYSQL=(mysql --defaults-extra-file="$CNF" --protocol=TCP "$DB_NAME")

scalar() { "${MYSQL[@]}" -N -B -e "$1"; }

log "=== Technician lifecycle migration runner ==="
log "Target : ${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
log "Mode   : $([ "$APPLY" -eq 1 ] && echo 'APPLY (will mutate)' || echo 'DRY RUN (read-only; pass --apply to mutate)')"
scalar "SELECT 1" >/dev/null 2>&1 || fail "cannot connect to ${DB_NAME} — check credentials / host / VPN"
ok "connected"

# --- pre-flight ------------------------------------------------------------------
VERSION="$(scalar "SELECT VERSION()")"
log "MySQL version: $VERSION"
VER_NUM="$(printf '%s' "$VERSION" | grep -oE '^[0-9]+\.[0-9]+\.[0-9]+' || true)"
ver_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -t. -k1,1n -k2,2n -k3,3n | head -1)" = "$2" ]; }
if [ -n "$VER_NUM" ] && ver_ge "$VER_NUM" "8.0.12"; then
  ok "8.0.12+ — ADD COLUMN could be INSTANT; INPLACE (as pinned) is safe too"
else
  warn "server < 8.0.12 (or unknown) — ADD COLUMN is an INPLACE rebuild; keep the LOCK=NONE pin and a maintenance window"
fi

LONG_TX="$(scalar "SELECT COUNT(*) FROM information_schema.innodb_trx WHERE trx_started < (NOW() - INTERVAL 10 SECOND)")"
if [ "${LONG_TX:-0}" -gt 0 ]; then
  warn "$LONG_TX transaction(s) open >10s — an ALTER can queue behind them and stall tbl_easyfixer. Inspect: SHOW FULL PROCESSLIST"
  [ "$STRICT_LOCKS" -eq 1 ] && fail "--strict-locks: refusing to proceed while long transactions are open"
else
  ok "no long-running transactions (>10s)"
fi

COL_EXISTS="$(scalar "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='tbl_easyfixer' AND column_name='lifecycle_status'")"
NEW_IDX="$(scalar "SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='tbl_job_offer' AND index_name='idx_job_offer_efr_status_open'")"
OLD_IDX="$(scalar "SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='tbl_job_offer' AND index_name='idx_job_offer_efr_status'")"

# --- legacy-column snapshot (must be identical after the backfill) ---------------
dist_query="SELECT CONCAT_WS(':', COALESCE(efr_status,'NULL'), COALESCE(is_technician_verified,'NULL'), COUNT(*)) \
  FROM tbl_easyfixer GROUP BY efr_status, is_technician_verified ORDER BY 1, 2"
DIST_BEFORE="$(scalar "$dist_query")"
log "Legacy work-column distribution (efr_status : is_technician_verified : count) snapshotted."

# --- plan ------------------------------------------------------------------------
log ""
log "--- Plan ---"
if [ "$COL_EXISTS" -eq 0 ]; then
  plan "tbl_easyfixer: run the FULL lifecycle file in ONE session (ALTER -> CREATE -> backfill -> seeds)"
else
  plan "tbl_easyfixer: lifecycle_status already exists -> run ONLY the idempotent tail (CREATE IF NOT EXISTS + backfill + seeds)"
fi
if [ "$NEW_IDX" -gt 0 ]; then
  plan "tbl_job_offer: new index already present -> SKIP the index migration"
elif [ "$OLD_IDX" -gt 0 ]; then
  plan "tbl_job_offer: swap idx_job_offer_efr_status -> two new indexes (one atomic ALTER)"
else
  warn "tbl_job_offer: neither the old nor the new index is present — unexpected; inspect before applying"
fi

if [ "$APPLY" -eq 0 ]; then
  log ""
  ok "DRY RUN complete — no changes made. Re-run with --apply inside the maintenance window."
  exit 0
fi

# --- apply: lifecycle (one session) ----------------------------------------------
log ""
log "--- Applying ---"
if [ "$COL_EXISTS" -eq 0 ]; then
  "${MYSQL[@]}" < "$LIFECYCLE_SQL"
  ok "lifecycle file applied in one session"
else
  # ADD COLUMN is not repeatable (no IF NOT EXISTS on 5.7); run the idempotent tail
  # straight from the SAME file so nothing drifts.
  awk '/^CREATE TABLE IF NOT EXISTS/{p=1} p' "$LIFECYCLE_SQL" | "${MYSQL[@]}"
  ok "idempotent tail (CREATE/backfill/seeds) applied"
fi

# --- verify lifecycle ------------------------------------------------------------
REMAINING="$(scalar "SELECT COUNT(*) FROM tbl_easyfixer WHERE lifecycle_status IS NULL AND NOT (efr_status <=> 3)")"
[ "${REMAINING:-1}" -eq 0 ] || fail "backfill incomplete: $REMAINING technician row(s) still have lifecycle_status IS NULL — the assignment gate will exclude them"
ok "backfill complete (0 NULL lifecycle_status among non-deleted technicians)"

DIST_AFTER="$(scalar "$dist_query")"
[ "$DIST_BEFORE" = "$DIST_AFTER" ] || fail "efr_status / is_technician_verified distribution CHANGED across the migration — the backfill must only write lifecycle_* columns. Investigate before proceeding."
ok "legacy work columns (efr_status, is_technician_verified) unchanged"

FLAGS="$(scalar "SELECT CONCAT(property_key,'=',property_value) FROM easyfix_properties WHERE property_key IN ('easyfixer.lifecycle.evaluation.enabled','easyfixer.auto_reactivation.enabled') ORDER BY property_key")"
log "Cron kill-switches:"; printf '  %s\n' $FLAGS
if printf '%s' "$FLAGS" | grep -q '=true'; then
  warn "a lifecycle cron flag is 'true' — leave BOTH 'false' until the technician app cutover (a restart is required to apply)"
else
  ok "both lifecycle crons are OFF ('false')"
fi

# --- apply + verify index --------------------------------------------------------
if [ "$NEW_IDX" -gt 0 ]; then
  ok "tbl_job_offer index already swapped — skipped"
elif [ "$OLD_IDX" -gt 0 ]; then
  "${MYSQL[@]}" < "$INDEX_SQL"
  CHECK_IDX="$(scalar "SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='tbl_job_offer' AND index_name='idx_job_offer_efr_status_open'")"
  [ "${CHECK_IDX:-0}" -gt 0 ] || fail "index swap did not create idx_job_offer_efr_status_open"
  ok "tbl_job_offer index swapped"
else
  warn "tbl_job_offer: skipped index migration (neither old nor new index present — inspect manually)"
fi

log ""
ok "MIGRATION COMPLETE."
log "Next: run 'npm run verify:migrations', then promote the two .sql files into migrations/executed/ per your deploy process."
log "Reminder: EXPLAIN listOfferedForTech / techHasOpenOffer to confirm the covering index path, and keep both cron flags 'false' until the app cutover."
