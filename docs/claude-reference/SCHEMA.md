# EasyFix_Backend — Schema Reference

> Deep schema notes extracted from CLAUDE.md to keep the always-loaded core lean.
> Read this when a task touches `tbl_easyfixer`, `tbl_job`, lookup tables, or DB type casting.

## Table-name reconciliations (blueprint §3 vs reality)

Some lookup tables are named differently from the blueprint — verified on QA 2026-04-17:

| Blueprint | Actual | Notes |
|---|---|---|
| `tbl_reschedule_reason` | `reschedule_reason_app` | 4 rows; app-facing list |
| `tbl_bank` | `bank_name` | 154 rows + `is_easyfix_bank` BIT flag |
| `tbl_cancel_reason` | `tbl_cancel_reason` | Exists but **only 1 row** ("cancle job"). The canonical technician-app cancel list appears to live in `job_cancel_reason_by_easyfixer_app` — merge on next pass. |

Unmapped tables worth knowing about for future lookups:
- `tbl_enum_reason` (102 rows, `enum_type`-discriminated multi-purpose list)
- `job_cancel_reason_by_easyfixer_app` (richer cancel reasons)
- `revisit_reason_by_app`, `collect_cash_reason_by_app`, `problem_with_job_reason` (app-specific reason lists)

## tbl_easyfixer glossary (86 cols — column-name drift from blueprint)

The blueprint documents this table with camelCase identifiers; the DB uses snake_case. When writing queries or validators, **match the DB**:

| Blueprint | Actual DB column |
|---|---|
| `first_name` | `efr_first_name` |
| `last_name` | `efr_last_name` |
| `isTechnicianVerified` | `is_technician_verified` |
| `isEmailVerified` | `is_email_verified` |
| `efrProfilePercentage` | `efr_profile_perc` |
| `efrPersonalDetailsPercentage` | `efr_personal_details_perc` |
| `efrProfessionalDetailsPercentage` | `efr_professional_details_perc` |
| `efrBankDetailsPercentage` | `efr_bank_details_perc` |
| `efrIdentityDetailsPercentage` | `efr_identity_details_perc` |
| `efrManagerId` | `efr_manager_id` |
| `noOfChildren` | `efr_children` |
| `haveBike` | `have_bike` |
| `useWhatsapp` | `use_whatsapp` |
| `doYouHaveHealthInsurance` | `health_insurance` |
| `doYouHaveAccidentalInsurance` | `accidental_insurance` |
| `doYouHaveDrivingLisence` | `have_driving_lisence` (**preserve typo** — matches schema) |
| `adhaarCardNumber` | `adhaar_card_number` (`adhaar`, not `aadhar`) |
| `panCardNumber` | `pan_card_number` |
| `finalSubmission` | `final_submission` |
| `newEasyfixer` | `new_easy_fixer` |
| `isExistingEasyfixer` | `is_existing_easyfixer` |
| `aboutYourself` | `about_yourself` |

**`efr_no` is NOT DB-unique.** The blueprint says `efr_no VARCHAR UNIQUE`, but `SHOW INDEXES FROM tbl_easyfixer` shows only `efr_id` as primary. Production data has duplicate mobile numbers. `easyfixer.service.create()` adds an app-level check: "409 if an *active* easyfixer with this `efr_no` exists". Updates do not enforce uniqueness (existing dupes would break). If you ever add a DB unique index, backfill-deduplicate first.

**Status model**: `efr_status` is 0/1 (active flag). Deactivation captures `inactive_reason` (FK, nullable), `inactive_comment`, and stamps `last_inactive_date_time`. Reactivation clears the reason/comment but does NOT touch `last_inactive_date_time` (that's a historical marker). We never DELETE rows — soft-delete only.

**Projections**: `LIST_COLUMNS` = 14-col compact view; `DETAIL_COLUMNS` = `SELECT e.*` + city join. Don't return `SELECT *` from list — the response bloat on 4,254 active rows (paginated, but still) hurts clients.

## tbl_job (141 cols, ~384k rows) — key facts

**Column-name landmines (preserve verbatim — 5 services depend on them)**:
- `fk_easyfixter_id` — the "t" is a typo of "easyfixer" but canonical since 2013.
- `Efr_dis_travelled` — capital E, preserved.

**Status codes** (defined as constants in `services/job.service.js`):

| Code | Name | When stamped |
|---|---|---|
| 0 | BOOKED | Default on create |
| 1 | SCHEDULED | Auto-set on first assign |
| 2 | IN_PROGRESS | Technician checked in |
| 3 | COMPLETED | Auto-stamps `checkout_date_time` if null |
| 5 | COMPLETED_ALT | Alternative completion (kept for legacy) |
| 6 | CANCELLED | Stamps `cancel_date_time`, `cancel_reason_id`, `cancel_comment`, `cancel_by` |
| 7 | ENQUIRY | Information request only |
| 9 | CALL_LATER | Deferred / soft deleted |
| 10 | REVISIT | Needs return visit |

**Source fields**: `source_type` (varchar) is the human-readable source (`"manual"`, `"excel"`, `"dashboard"`, `"decathlon API"`); `source` (tinyint) is legacy — don't use.

**Create flow** (`POST /api/admin/jobs`): single transaction —
1. `upsertCustomer`: if `customer_id` given, validate it exists; else look up by `customer_mob_no`; else insert fresh.
2. `insertAddress`: new address row bound to the customer (unless `address_id` supplied).
3. Insert `tbl_job` with resolved FKs + audit fields (`fk_created_by`, `created_date_time`, `ticket_created_date_time`, `last_update_time`, `job_status=0`).
4. If `services[]` is given, insert each into `tbl_job_services`.
5. Commit, then `getById()` for the full payload.

**Assign flow** (`PATCH /api/admin/jobs/:id/assign`): single transaction —
1. Reject if easyfixer doesn't exist or is inactive.
2. `UPDATE tbl_job SET fk_easyfixter_id = ?, scheduled_date_time = NOW(), fk_scheduled_by = ?, job_status = IF(status=0, 1, status), first_scheduled_by = COALESCE(first_scheduled_by, ?)`.
3. `INSERT scheduling_history`. `reason_id`/`reschedule_reason` are only stamped on *reassignment*, not initial assignment.

**Update guardrails**: `MUTABLE_COLUMNS` whitelist prevents mass-assignment of `job_id`, `created_date_time`, audit fields, and status-change-only columns. Use `PATCH /status` for status transitions (it stamps related fields) and `PATCH /assign` for tech changes (it writes scheduling_history).

**Projections**: LIST returns ~24 cols (joined names from 5 tables). DETAIL returns `SELECT j.* + joined names + services[] + images[]`. Never return `SELECT *` on list — response bloat on 384k-row pagination would hurt clients.

## Schema gotchas caught during build

- `tbl_job.job_desc` is **NOT NULL** despite `INFORMATION_SCHEMA` reporting `text`. `job.service.create()` defaults to `''` when omitted. Caught during Step 8 smoke testing of a payload without a description.
- `tbl_easyfixer.efr_no` has **no unique constraint** despite blueprint claims. Dup active mobiles are detected in application code only.
- `tbl_job.fk_easyfixter_id` — preserve the `easyfixter` typo; 5 services reference it.
- `tbl_job.Efr_dis_travelled` — capital E, preserved.
- `have_driving_lisence` (tbl_easyfixer) — preserve the `lisence` typo.
- `is_expired` (otp_details) and many other BIT(1) columns — require `typeCast` in `db.js` to return booleans instead of `Buffer`. Removing that cast silently breaks OTP replay guards, `efr_status`, etc.

## BIT(1) → boolean at the pool

MySQL `BIT(1)` columns (e.g. `otp_details.is_expired`, `tbl_user.is_*`) are returned as `Buffer` by default. `db.js` has a `typeCast` that coerces them to `true`/`false`/`null`. This is why code can write `if (row.is_expired)` naturally. Don't remove it — several tables rely on it.
