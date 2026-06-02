# EasyFix_Backend — Phase History (reference snapshot)

> Migration phase log extracted from CLAUDE.md. Kept for reference; not needed for day-to-day work.

## Phase plan — ✅ MIGRATION COMPLETE 2026-05-12

All migration phases (1-13) are functionally complete and verified across three independent adversarial review passes. The legacy 5-service Java stack (CRM, EasyFix_API, ACD_APIs, API_AngularClientDashboard, Webhook_2023) has full coverage in this Node backend plus the three frontends (Easyfix_CRM_UI, Easyfix_client_UI, EasyFixer_App). Phases 14-15 (operational: Redis lift, Nginx cutover) remain deferred by design — they require production access and are not migration code.

The earlier `PHASE_PLAN.md` planning doc was removed once the work it tracked was closed out. The phase table below is the kept-for-reference snapshot of what each phase covered.

### Phase 1A — Admin CRM foundation ✅ DONE

- [x] Step 1: Scaffold Express + mysql2 pool + health endpoints
- [x] Step 2: Auth routes (OTP-based) — `/login` returns 501 (see **auth reality** in CLAUDE.md)
- [x] Step 3: Role middleware — group + exact-name guards with 5-min cache
- [x] Step 4: Shared lookup routes — 11 endpoints
- [x] Step 5: Admin easyfixer CRUD — soft-deactivation only
- [x] Step 6: Admin job CRUD + status + assign — transactional create
- [x] Step 7: Admin job bulk xlsx upload — per-row error reporting, dry-run
- [x] Step 8: Admin job owner change — 4-layer validation + audit
- [x] Step 9: Auto-assignment engine — 3-layer pipeline, weighted scoring
- [x] Step 10: Shared file upload/delete — path-traversal safe
- [x] Step 11: Notification services — SMS/Email/WhatsApp/FCM with disable flag

### Remaining phases

| # | Phase | Priority | Scope summary |
|---|---|---|---|
| 🔥 1B | CRM_UI frontend | parallel | Next.js, **separate repo** — not started |
| ✅ 2 | Webhook delivery | DONE | Admin CRUD + dispatcher with retry/DLQ + job-lifecycle auto-triggers |
| ✅ 3 | External Integration API | DONE | `/api/integration/v1/*` Basic Auth + legacy-shape adapters for all Dropwizard endpoints |
| ✅ 4 | Client Dashboard backend | DONE | SPOC OTP auth, client-scoped jobs/dashboard/profile/approve/reject |
| ✅ 5 | Technician Mobile backend | DONE | Tech OTP auth, job accept/reject/checkin/checkout/reschedule, profile steps, device FCM |
| ✅ 6 | Notification wiring | DONE | Orchestrator fans out events to SMS/email/WhatsApp/FCM; in-app inbox CRUD |
| ✅ 7 | Finance & Invoicing | DONE | Invoices list/generate/payment, transactions ledger, POs, payout |
| ✅ 8 | Extended admin CRUD | DONE | Clients + contacts + billing; Users; Rate cards |
| ✅ 9 | Quotations + Order-Lifecycle enablers | DONE | Product/material quotations, validator stub, questionnaires |
| ✅ 10 | Settings + Masters | DONE | Generic CRUD factory for cities/service-types/categories/banks/doc-types/cancel-reasons |
| ✅ 11 | Reports + Tracking | DONE | Completed-jobs, easyfixer, payout-sheet, city-analysis, job-tracking, user-hours |
| ✅ 12 | Auxiliary flows | DONE | Attendance, materials, training, Aadhaar check, geocoding, experience, email-verify callback |
| ✅ 13 | Inactive/legacy preserved | DONE | Snapdeal, Exotel, JMS behind feature flags (`*_ENABLED=false`) |
| ✅ 14 | Performance optimization | DONE | Compression + per-tier rate limiting (integration/client/mobile) + perf guide |
| ✅ 15 | Legacy retirement runbook | DONE | Step-by-step Nginx cutover + rollback triggers (`RETIREMENT_RUNBOOK.md`) |
| 🔥 3 | External Integration API (Decathlon) | high | 40+ `/api/integration/v1/*` with legacy Dropwizard contract |
| 🔥 4 | Client Dashboard backend + Client_UI | high | ~45 endpoints, SPOC auth via `tbl_client_contacts` |
| 🔥 5 | Technician Mobile backend + EasyFixer_App | high | ~55 endpoints, tech auth via `tbl_easyfixer` |
| 🔥 6 | Notification wiring | high | Trigger outbound on job events + in-app inbox |
| 🟡 7 | Finance & Invoicing | monthly | 42 endpoints (invoices, payouts, recharges) |
| 🟡 8 | Extended admin CRUD | medium | Client contacts, billing, custom-props, products, users |
| 🟡 9 | Quotations + Order-Lifecycle enablers | medium | Order Lifecycle §13 CRITICAL GAPs |
| 🟢 10 | Settings + Masters | low | Cities/tools/skills/doc-types/rate-cards |
| 🟢 11 | Reports + Tracking | low | Completed-jobs, easyfixer, payout sheet, analytics |
| 🟢 12 | Auxiliary flows | low | Attendance, materials, training, Aadhaar, geocoding |
| 🟢 13 | Inactive/Legacy-preserved | low | Snapdeal, Exotel, JMS (feature-flag gated, never deleted) |
| 🟢 14 | Performance optimization pass | cross-cutting | Redis, rate-limit, query plans, N+1 audit |
| 🟢 15 | Legacy retirement | final | Nginx cutover + decomm Tomcat/Dropwizard/Spring Boot |

Integration routes (`/api/integration/v1/*`) are scaffolded from Step 1 onward so the contract-compat work stays visible throughout.
