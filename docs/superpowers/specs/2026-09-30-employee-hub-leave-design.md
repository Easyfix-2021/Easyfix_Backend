# Employee Hub — Attendance & Leaves, Leave Approvals (design)

**Date:** 2026-09-30 · **Status:** approved by owner (flow + answers 2026-09-30), awaiting spec review
**Repos:** EasyFix_Backend, Easyfix_CRM_UI · **Builds on:** Team Roster (Prod 2026-09-29)

## 1. Goal

Employees pre-inform leave from the CRM; their Reporting Head (RH) approves or rejects;
the Team Roster reflects it — pending as a marker, approved as a locked leave day.

## 2. Decisions (owner, 2026-09-30)

| Topic | Decision |
|---|---|
| Leave kinds | Two only: **LV** (Leave) and **SL** (Sick Leave). No types, no balances. |
| LV start | at least **2 days ahead** (request on 30 Sep → 2 Oct earliest). Multi-day allowed. |
| SL | **today only** — a single day (full or half). Sick again tomorrow = a new SL tomorrow. |
| Past dates | never (neither kind). |
| Duration | `duration` ∈ `FULL` / `FIRST_HALF` / `SECOND_HALF`. Half only on single-day requests; counts 0.5. |
| Approval | both kinds need RH approval. SL additionally raises an **instant popup** for the RH. |
| Cancel | `WITHDRAWN` = employee cancels while PENDING. `CANCELLED` = approved leave called off: by the employee **before its first day**; after that only the RH or a Roster Admin (remaining days). |
| Approver | the direct `reporting_manager`, snapshotted on the request. Roster Admins (`isRosterAdmin`) may act on any request. No RH → routed to Roster Admins. |
| Popup channel | option 1: light polling (30 s, visible tabs) + modal + browser desktop notification. |
| Attendance | no punch feed yet → "Present" = **planned** present from the roster, labelled as such. |

## 3. Data model — `migrations/2026-09-30-employee-leave-01-tables.sql`

Minimal-migration style; EasyFix-owned new tables (the CLAUDE.md exception); no FKs.

```sql
CREATE TABLE IF NOT EXISTS tbl_employee_leave_request (
  id BIGINT NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  kind CHAR(2) NOT NULL,                 -- LV | SL
  from_date DATE NOT NULL,
  to_date DATE NOT NULL,
  duration VARCHAR(12) NOT NULL,         -- FULL | FIRST_HALF | SECOND_HALF
  days DECIMAL(5,1) NOT NULL,            -- working days at request time (display; recomputed on approve)
  reason VARCHAR(500) NULL,
  status VARCHAR(10) NOT NULL,           -- PENDING | APPROVED | REJECTED | WITHDRAWN | CANCELLED
  approver_user_id INT NULL,             -- RH snapshot; NULL = routed to Roster Admins
  decided_by INT NULL, decided_at DATETIME NULL, decision_note VARCHAR(500) NULL,
  cancelled_by INT NULL, cancelled_at DATETIME NULL, cancel_note VARCHAR(500) NULL,
  created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  KEY idx_elr_user_dates (user_id, from_date, to_date),
  KEY idx_elr_approver_status (approver_user_id, status),
  KEY idx_elr_status_dates (status, from_date)
);
CREATE TABLE IF NOT EXISTS tbl_user_alert_ack (
  user_id INT NOT NULL, alert_key VARCHAR(64) NOT NULL, acked_at DATETIME NOT NULL,
  PRIMARY KEY (user_id, alert_key)
);
```

`kind`/`status`/`duration` are VARCHAR + one JS constant each (same reason as the roster tables).
`alert_key` = `leave:<id>` — generic so other urgent alerts can reuse the popup later.

`migrations/2026-09-30-employee-leave-02-rbac.sql` — menu **Employee Hub** (top level) with
children **Attendance & Leaves** (`employeeAttendance`) and **Approvals** (`employeeLeaveApprovals`),
granted to **every active admin-group role** (every CRM user); `new.crm.visible.menu.ids` appended.
No new action key: who may approve is data (RH / `isRosterAdmin`), not a role.

**Deploy order** (the roster lesson): 01 before the backend; 02 after the CRM is live.

## 4. Rules (one validator, `services/leave.service.js`)

- `kind` LV: `from_date ≥ today + 2`. SL: `from_date = to_date = today`.
- `to_date ≥ from_date`; `duration ≠ FULL` ⇒ `from_date = to_date`.
- Working days = days in range whose resolved roster day is PR and not a holiday; half = 0.5.
  0 working days ⇒ 400 "Those dates are week offs or holidays".
- Overlap: any PENDING/APPROVED request of the same user intersecting the range ⇒ 409.
  (Two half days on one date — FIRST_HALF + SECOND_HALF — are allowed; same half ⇒ 409.)
- Only the requester withdraws (PENDING → WITHDRAWN).
- Cancel an APPROVED leave: the requester only while `from_date > today`; the RH / a Roster Admin
  any time. Not started yet → `CANCELLED`. Already started → the past days stay leave: `to_date`
  is trimmed to yesterday, status stays `APPROVED`, and `cancelled_by/at/note` record who cut it
  short (history shows "Approved · Ended Early").
- Decide: only PENDING; actor = `approver_user_id` or a Roster Admin; never the requester.
  Reject needs a note. Approve re-counts days from the current roster.

## 5. Roster integration (`services/roster.service.js`)

- `resolveDays` gains a top layer: an APPROVED leave covering the date → `{ type: 'LV'|'SL',
  half: FULL|FIRST_HALF|SECOND_HALF, leaveId, source: 'LEAVE' }`; PENDING → the planned day plus
  `pendingLeave: { id, kind, half }`. One extra indexed query per resolve.
- **Lock:** `saveCells` / `fillPattern` / `bulk` / `resetRange` skip dates with an APPROVED
  full-day leave (grid cell disabled; Update Roster preview counts "N Leave Days Kept"; Bulk
  Update reports them as "Locked — approved leave"; a direct PUT on one → 409).
- Headcount + routing: full-day leave = off duty. Lookup users gain `on_leave_today` next to the
  existing `week_off_today` (not renamed — the transfer dialogs read it); bulk-reassign skips
  both. Half day = available.
- Export: LV / SL / ½LV / ½SL in the cell. My Roster + dashboard show the leave.

## 6. API (`routes/admin/leave.js`, mounted `/api/admin/leave`, every CRM user)

| Method + path | Who | Purpose |
|---|---|---|
| `GET /me?month=YYYY-MM` | self | calendar days (resolved + leaves), monthly summary, my requests |
| `POST /requests` | self | create (validates §4, emails RH cc self, inbox item, SL → alert) |
| `POST /requests/:id/withdraw` | requester | PENDING → WITHDRAWN |
| `POST /requests/:id/cancel` | requester (before start) / RH / Roster Admin | APPROVED → CANCELLED (or trim) |
| `GET /approvals?status=pending\|history&page&limit` | RH / Roster Admin | requests I may decide |
| `POST /requests/:id/decide` `{decision, note}` | approver / Roster Admin | → APPROVED / REJECTED |
| `GET /alerts` | self | unacked urgent alerts (pending SL where I'm approver) |
| `POST /alerts/:key/ack` | self | dismiss popup |

## 7. Notifications

Email via `services/email.service.js send()`; link base = `CRM_PUBLIC_BASE_URL` →
`MAGIC_LINK_BASE_URL` (never `CRM_URL` — that is the CORS allowlist); no base ⇒ omit the link.

| Event | To | CC | Link |
|---|---|---|---|
| Requested | RH (or Roster Admins) | employee | `/employee-hub/approvals?request=<id>` |
| Approved / Rejected | employee | RH | `/employee-hub/attendance` |
| Cancelled (after approval) | RH | employee | `/employee-hub/approvals?request=<id>` |

Each also creates an inbox item (`notification-inbox.service create`). Email failure never fails
the request (logged; inbox still written).

**SL popup:** CRM authed layout mounts `<UrgentAlerts/>`: polls `GET /admin/leave/alerts` every
30 s while `document.visibilityState === 'visible'` (+ on focus). New alert → modal
("Sick Leave · Ravi · Today (Full Day) — Review / Later"); "Later" acks for this session only,
"Review" opens the request. Hidden tab → `Notification` API desktop alert (permission asked once,
from the popup). Server query: `status='PENDING' AND kind='SL' AND approver = me AND no ack`.

## 8. CRM screens

- `/employee-hub/attendance` — month calendar (P / W / HO / LV / SL / ½, pending badge, legend),
  Monthly Summary cards (Total Days · Elapsed · Planned Present · Leaves · Week Offs & Holidays),
  **Request Leave** dialog (Kind toggle LV/SL, dates, Duration, reason, live "N working days"),
  My Requests table (status chip, Withdraw / Cancel with confirm).
- `/employee-hub/approvals` — tabs Pending / History; row: employee, kind, dates, duration,
  working days, reason, requested at; Approve / Reject (note) with `useConfirm`; `?request=` opens
  and highlights that row.
- Team Roster grid — pending badge on a cell; approved leave cell LV/SL, locked, tooltip with the
  request; legend updated.
- Shared: `UrgentAlerts` in the authed layout.

## 9. Testing

Backend node:test + fake pool: every §4 rule (each mutation-checked), decide/withdraw/cancel
authorisation matrix (requester, RH, Roster Admin, stranger), roster lock on all four writers,
resolveDays leave layer (approved wins, pending is overlay, cancelled vanishes), alert query
excludes acked. Route guards. CRM: typecheck, lint, tests, build; static render of calendar,
approvals and popup.

## 10. Phases

1. Migration 01 + leave service/API + emails + inbox (backend).
2. Employee Hub pages (CRM) + migration 02.
3. Roster integration (leave layer, locks, export, routing).
4. SL popup (alerts endpoint + UrgentAlerts).

## 11. Out of scope (v1)

Leave balances/quotas, leave types, attendance punch reconciliation, Web Push / SSE, delegation
of approvals, payroll export.
