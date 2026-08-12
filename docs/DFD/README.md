# EasyFix editable data-flow diagrams

Snapshot date: 11 August 2026  
Basis: static audit of the current local EasyFix worktrees

## Deliverables

| File | Purpose |
| --- | --- |
| `easyfix-platform-dfd.drawio` | Primary editable Draw.io workbook with all three DFD pages |
| `easyfix-dfd-level-0-context.svg` / `.png` | Platform context, actors, trust boundary, stores, and providers |
| `easyfix-dfd-level-1-platform.svg` / `.png` | Screen-to-process-to-store platform decomposition |
| `easyfix-dfd-level-2-technician-job-lifecycle.svg` / `.png` | Detailed technician offer-to-checkout data flow |
| `generate-easyfix-dfd.js` | Deterministic source used to regenerate the workbook and previews |

The SVG files are vector graphics and can also be edited in tools such as Figma, Illustrator, or Inkscape. The Draw.io workbook is the easiest source for changing nodes, connectors, labels, and colors.

## Edit the diagram

1. Open [app.diagrams.net](https://app.diagrams.net/) or the Draw.io desktop application.
2. Choose **File → Open From → Device**.
3. Select `easyfix-platform-dfd.drawio`.
4. Use the page tabs at the bottom to switch between:
   - `Level 0 - Context`
   - `Level 1 - Platform`
   - `Level 2 - Technician Job Lifecycle`
5. Double-click text to edit it. Drag nodes or connector waypoints to change the layout.
6. Export an updated screen image with **File → Export as → PNG** or **SVG**.

The workbook uses uncompressed Draw.io XML, so it remains editable and can be reviewed in source control.

## How to read the three pages

### Level 0 — Context

Shows who exchanges data with EasyFix and which trust boundaries the data crosses. The current target platform contains the technician Expo app, CRM UI, client surfaces, public/integration surfaces, unified backend, MySQL, media storage, and device-local state. Messaging, voice/maps/AI/KYC, client callback endpoints, and the legacy parity lane sit outside that boundary.

### Level 1 — Platform

Decomposes the unified backend into seven logical processes:

1. API boundary, authentication, and access control
2. Job intake and scheduling
3. Candidate ranking and assignment
4. Technician job lifecycle
5. Workforce, attendance, and finance
6. Job detail, media, and quotations
7. Notifications, webhooks, and schedulers

Database tables are grouped into logical stores to keep the DFD readable; the groups do not imply separate physical databases.

### Level 2 — Technician job lifecycle

Traces the highest-value mobile path: login and lifecycle gating → dashboard/offers → scheduled/reached → customer PIN and start work → estimate/work progress → completion or revisit. It also shows server-authoritative transitions, idempotency, device state, media, location, notification delivery, and downstream CRM/client/customer views.

## Legend and design decisions

- Red cards: app screens or client-facing surfaces
- Blue cards: backend processes
- Green cylinders: data stores
- Purple cards: external providers or consumers
- Solid blue: API or data request
- Solid green: store read/write
- Dashed orange: asynchronous push or event delivery
- Dotted red: local/offline state
- Dashed grey: legacy or parity reference

Three levels are provided instead of one oversized diagram: Level 0 is suitable for stakeholder context, Level 1 for platform review, and Level 2 for implementation and lifecycle analysis. Legacy applications are shown in a dashed lane because they are parity/cutover references, not confirmed authoritative target paths.

## Scope and verification caveats

The source code in the current local worktrees was treated as authoritative for this snapshot. Several repositories contain uncommitted changes, so this is a design/worktree view—not proof of what is deployed in production.

Items deliberately marked in the DFD for follow-up:

- The technician lifecycle migration and offer/auth indexes exist locally but their installation in deployed databases was not verified.
- Current client callers and backend routes include dashboard, notice/filter, maps/signup, and related contract mismatches.
- CRM bulk-payout request shape and some technician update semantics need deployment-contract verification.
- CRM/client logout cache cleanup needs review.
- The mobile outbox/dead-letter mechanism exists, but no current business mutation is eligible for durable offline queueing.
- Mobile server logout/device deregistration and parts of legacy report-media parity are not currently verified.
- Configured provider integrations indicate code dependencies; they do not prove live credentials, routing, or provider health.

## Performance boundaries captured

The DFD calls out structural safeguards found in the audited code: rate-limited API tiers, bounded JSON and multipart uploads, a finite database pool/queue, capped lists and location retention, client cache/single-flight behavior, stable idempotency keys, bounded push fan-out, dead-token pruning, and post-commit delivery.

This documentation change has no application runtime or database-query impact. No live load test, production query plan, provider latency measurement, or scheduler-concurrency test was run while creating the DFD. Residual performance risks include unbounded or high-cap lookup requests, sequential client uploads, process-local rate buckets, potentially overlapping schedulers, and the uncertainty around whether pending indexes are deployed.

## Primary evidence map

The diagram was derived from these current repositories and code areas:

- `EasyFix_Backend/routes/index.js`, `routes/mobile/index.js`, `routes/admin/index.js`, `routes/client/index.js`, `routes/integration/index.js`, `routes/public.js`, and `routes/webhook.js`
- `EasyFix_Backend/services/job.service.js`, `services/job-offer-persistence.service.js`, `services/job-location.service.js`, `services/webhook.service.js`, `server.js`, and `db.js`
- `Easyfix_Technician_Mobile_Application/src/lib/api.ts`, cache/outbox/session modules, background-location modules, and job API/service screens
- `Easyfix_CRM_UI` API wrappers, screens, permissions, session caching, operations, finance, and reporting flows
- Current EasyFix client mobile/web callers for OTP, booking, tracking, approvals, quotations, and team management
- `Technician_mobile_App_v2`, `API_AngularClientDashboard`, `EasyFix_API`, and the old CRM/Angular dashboard only for legacy parity comparison

## Regenerate the files

From this directory, run:

```bash
NODE_PATH=/Users/harshit/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules \
  /Users/harshit/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  generate-easyfix-dfd.js
```

Generation rewrites the `.drawio`, `.svg`, and `.png` outputs from the JavaScript model. Make structural changes in `generate-easyfix-dfd.js` if they must survive regeneration; use Draw.io directly for one-off visual edits.
