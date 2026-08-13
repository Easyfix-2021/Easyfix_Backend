/*
 * Generates the editable diagrams.net source and matching SVG/PNG previews.
 *
 * The page model below is the single source of truth. Edit node labels,
 * positions, or edges here, then run the command documented in README.md.
 */

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const OUTPUT_DIR = __dirname;
const SNAPSHOT = "Static worktree audit · 11 Aug 2026";

const C = Object.freeze({
  red50: "#FBF0F1",
  red100: "#F6DEE0",
  red500: "#C42430",
  red600: "#A71F29",
  red700: "#831820",
  ink900: "#171B1F",
  ink700: "#363B41",
  ink500: "#5C636B",
  ink300: "#9AA1A9",
  ink100: "#E4E7EA",
  ink50: "#F4F6F7",
  white: "#FFFFFF",
  blue100: "#E4EFFA",
  blue500: "#2A6FBF",
  blue700: "#1B4C87",
  blue900: "#10294D",
  green: "#1B9E5A",
  greenTint: "#E2F5EA",
  greenText: "#0E5C34",
  warning: "#E0930F",
  warningTint: "#FCF0D9",
  warningText: "#6B4405",
  gold: "#C99A2E",
  goldTint: "#FBF1D8",
  purple: "#6D4ACB",
  purpleTint: "#EEE8FC",
});

const edgeThemes = Object.freeze({
  api: { stroke: C.blue500, marker: "arrow-api", dash: "" },
  data: { stroke: C.green, marker: "arrow-data", dash: "" },
  async: { stroke: C.warning, marker: "arrow-async", dash: "10 7" },
  local: { stroke: C.red500, marker: "arrow-local", dash: "5 5" },
  legacy: { stroke: C.ink300, marker: "arrow-legacy", dash: "10 7" },
});

const pages = [
  {
    slug: "easyfix-dfd-level-0-context",
    name: "Level 0 - Context",
    title: "EasyFix Data Flow Diagram · Level 0 Context",
    subtitle: "Who exchanges which data with the current target platform",
    width: 2100,
    height: 1260,
    boundaries: [
      {
        id: "b-target",
        x: 380,
        y: 130,
        w: 1220,
        h: 980,
        title: "CURRENT TARGET PLATFORM · trust boundary",
        tone: "target",
      },
    ],
    nodes: [
      { id: "e-tech", kind: "external", badge: "E1", x: 40, y: 200, w: 270, h: 120, title: "Technician", lines: ["Identity, OTP, profile", "Job decisions & field work", "GPS, media, attendance"] },
      { id: "e-ops", kind: "external", badge: "E2", x: 40, y: 430, w: 270, h: 120, title: "CRM operator / admin", lines: ["Technicians & permissions", "Jobs, assignment, finance", "Monitoring & reports"] },
      { id: "e-spoc", kind: "external", badge: "E3", x: 40, y: 660, w: 270, h: 120, title: "Client SPOC", lines: ["OTP login", "Bookings / bulk upload", "Tracking & approvals"] },
      { id: "e-public", kind: "external", badge: "E4/E5", x: 40, y: 890, w: 270, h: 150, title: "Customer / integrator", lines: ["Website visitor or API client", "Booking / serviceability", "Completion links & PIN", "Basic-auth job API"] },

      { id: "s-tech", kind: "screen", badge: "S1", x: 430, y: 190, w: 300, h: 150, title: "Technician Expo app", lines: ["Login & registration", "Offers, jobs, lifecycle", "Profile, earnings, attendance"] },
      { id: "s-crm", kind: "screen", badge: "S2", x: 430, y: 420, w: 300, h: 150, title: "EasyFix CRM UI", lines: ["Operations control plane", "Scheduling & assignment", "Finance, config & reporting"] },
      { id: "s-client", kind: "screen", badge: "S3", x: 430, y: 650, w: 300, h: 150, title: "Client web & mobile", lines: ["SPOC dashboard", "New order / bulk order", "Status, team & quotations"] },
      { id: "s-public", kind: "screen", badge: "S4", x: 430, y: 880, w: 300, h: 170, title: "Public & integration surfaces", lines: ["Website booking", "Magic/share links", "Integration API & inbound hooks"] },

      { id: "p0", kind: "process", badge: "P0", x: 830, y: 430, w: 390, h: 300, title: "EasyFix unified backend", lines: ["Express / JSON APIs", "/api/mobile · /admin · /client", "/public · /integration · /webhook", "Auth, validation, transactions", "Schedulers & delivery orchestration"] },

      { id: "d-core", kind: "store", badge: "D1", x: 1290, y: 220, w: 250, h: 190, title: "MySQL · easyfix_core", lines: ["Identity & access", "Jobs / offers / audit", "Attendance & finance", "Config & integration state"] },
      { id: "d-media", kind: "store", badge: "D2", x: 1290, y: 500, w: 250, h: 150, title: "Media storage", lines: ["S3 job/profile media", "Short-lived signed reads", "Legacy file fallback"] },
      { id: "d-device", kind: "store", badge: "D3", x: 1290, y: 750, w: 250, h: 180, title: "Device-local state", lines: ["SecureStore JWT", "Owner-scoped cache", "Drafts & outbox infrastructure", "Active location job"] },

      { id: "x-msg", kind: "provider", badge: "X1", x: 1740, y: 190, w: 310, h: 170, title: "Messaging providers", lines: ["FCM push", "SMS / OTP / email", "WhatsApp notifications"] },
      { id: "x-other", kind: "provider", badge: "X2", x: 1740, y: 450, w: 310, h: 180, title: "Voice, map, AI & KYC providers", lines: ["Masked calls / conferences", "Geocoding & directions", "KYC / speech / call analysis"] },
      { id: "x-callback", kind: "provider", badge: "X3", x: 1740, y: 720, w: 310, h: 150, title: "Client callback endpoints", lines: ["6 lifecycle webhook events", "Enriched job payloads", "Retry / delivery history"] },
      { id: "legacy", kind: "legacy", badge: "L", x: 1700, y: 960, w: 350, h: 160, title: "Legacy / parity boundary", lines: ["Technician_mobile_App_v2", "API_AngularClientDashboard", "EasyFix_API & old CRM", "Parity/coexistence; deployment path unverified"] },
    ],
    edges: [
      { from: "e-tech", to: "s-tech", type: "api", label: ["Mobile UI events", "and field data"], labelAt: [370, 230] },
      { from: "e-ops", to: "s-crm", type: "api", label: ["Admin actions", "and views"], labelAt: [370, 462] },
      { from: "e-spoc", to: "s-client", type: "api", label: ["Bookings, approvals", "and tracking"], labelAt: [370, 692] },
      { from: "e-public", to: "s-public", type: "api", label: ["Bookings, tokens", "and API payloads"], labelAt: [370, 930] },

      { from: "s-tech", to: "p0", type: "api", via: [[780, 265], [780, 505]], label: ["Bearer JWT · jobs", "mutations · GPS · media"], labelAt: [780, 375] },
      { from: "s-crm", to: "p0", type: "api", label: ["Admin JWT · scoped CRUD", "assignment · finance"], labelAt: [780, 470] },
      { from: "s-client", to: "p0", type: "api", via: [[780, 725], [780, 650]], label: ["SPOC JWT · booking", "status · approvals"], labelAt: [780, 725] },
      { from: "s-public", to: "p0", type: "api", via: [[780, 965], [780, 690]], label: ["Public tokens / Basic Auth", "webhooks & booking"], labelAt: [780, 865] },

      { from: "p0", to: "d-core", type: "data", via: [[1250, 580], [1250, 315]], label: ["Validated queries", "atomic state changes"], labelAt: [1250, 395] },
      { from: "p0", to: "d-media", type: "data", label: ["Object keys", "uploads / signed reads"], labelAt: [1250, 550] },
      { from: "s-tech", to: "d-device", type: "local", via: [[760, 265], [760, 840]], label: ["JWT, cache, drafts", "outbox & location owner"], labelAt: [1100, 840] },

      { from: "p0", to: "x-msg", type: "async", via: [[1645, 580], [1645, 275]], label: ["OTP, push &", "notification payloads"], labelAt: [1645, 330] },
      { from: "p0", to: "x-other", type: "api", via: [[1645, 580]], label: ["Call / map / AI", "requests & callbacks"], labelAt: [1645, 535] },
      { from: "p0", to: "x-callback", type: "async", via: [[1645, 650], [1645, 795]], label: ["Post-transition", "client webhooks"], labelAt: [1645, 760] },
      { from: "legacy", to: "p0", type: "legacy", via: [[1645, 1040], [1645, 700]], label: ["Contract parity /", "migration reference"], labelAt: [1645, 950] },
    ],
    note: "Context scope: current target code paths. Production routing and legacy cutover state require deployment verification.",
  },
  {
    slug: "easyfix-dfd-level-1-platform",
    name: "Level 1 - Platform",
    title: "EasyFix Data Flow Diagram · Level 1 Platform",
    subtitle: "Screens → backend processes → authoritative stores → external delivery",
    width: 2400,
    height: 1650,
    boundaries: [
      { id: "b-surfaces", x: 20, y: 130, w: 430, h: 1180, title: "ACTORS & CLIENT SURFACES", tone: "neutral" },
      { id: "b-backend", x: 500, y: 130, w: 880, h: 1180, title: "UNIFIED BACKEND · /api trust boundary", tone: "target" },
      { id: "b-stores", x: 1430, y: 130, w: 520, h: 1180, title: "AUTHORITATIVE / DURABLE STORES", tone: "store" },
      { id: "b-external", x: 1990, y: 130, w: 380, h: 1180, title: "EXTERNAL SERVICES", tone: "external" },
    ],
    nodes: [
      { id: "ui-tech", kind: "screen", badge: "E1/S1", x: 60, y: 170, w: 350, h: 220, title: "Technician → Expo app", lines: ["Login / registration / lifecycle gate", "Dashboard · offers · jobs", "Reached · PIN · work · estimate · checkout", "Attendance · earnings · profile · notices"] },
      { id: "local", kind: "store", badge: "D0", x: 60, y: 420, w: 350, h: 120, title: "Client-side session & cache state", lines: ["Technician: SecureStore + owner-scoped cache/drafts", "Outbox exists; no current queueable business mutation", "CRM/client: local/session/memory token & lookup caches"] },
      { id: "ui-crm", kind: "screen", badge: "E2/S2", x: 60, y: 590, w: 350, h: 160, title: "CRM operator → CRM UI", lines: ["Tech registration & lifecycle override", "Jobs · scheduling · offers · finance", "Notices · settings · calls · reports"] },
      { id: "ui-client", kind: "screen", badge: "E3/S3", x: 60, y: 800, w: 350, h: 160, title: "Client SPOC → web / mobile", lines: ["OTP · dashboard · new order · bulk upload", "Tracking · escalation · team · quotation decision"] },
      { id: "ui-public", kind: "screen", badge: "E4/E5", x: 60, y: 1010, w: 350, h: 220, title: "Customer / website / API client", lines: ["Public website booking + photos", "Customer completion & job-share links", "Basic-auth integration jobs/status/images", "Inbound WhatsApp / voice callbacks"] },

      { id: "p-auth", kind: "process", badge: "P1", x: 550, y: 175, w: 350, h: 155, title: "API boundary, auth & access", lines: ["Route-tier dispatch · OTP / JWT / Basic / token", "Technician, SPOC & admin guards", "RBAC · hierarchy/stage scope · PII masking"] },
      { id: "p-intake", kind: "process", badge: "P2", x: 970, y: 175, w: 350, h: 155, title: "Job intake & scheduling", lines: ["CRM / client / website / integration", "Customer + address + services", "Unconfirmed → booked / schedule / reschedule"] },
      { id: "p-offer", kind: "process", badge: "P3", x: 550, y: 440, w: 350, h: 175, title: "Candidate ranking & assignment", lines: ["Direct assignment or offer pool", "Eligibility / skills / pincode / availability", "Transactional first-accept-wins claim", "Offer expiry / reminders"] },
      { id: "p-life", kind: "process", badge: "P4", x: 970, y: 440, w: 350, h: 175, title: "Technician job lifecycle", lines: ["Accept/reject · ETA · masked call", "Reached selfie · customer PIN · check-in", "Location pings · reschedule · checkout", "Ownership & lifecycle capability checks"] },
      { id: "p-workforce", kind: "process", badge: "P5", x: 550, y: 735, w: 350, h: 175, title: "Workforce, attendance & finance", lines: ["Registration / KYC / profile / lifecycle", "Attendance & leave", "Earnings, bank/UPI, withdrawals", "CRM approval & reporting"] },
      { id: "p-detail", kind: "process", badge: "P6", x: 970, y: 735, w: 350, h: 175, title: "Job detail, media & quotations", lines: ["Images / documents / S3 references", "Rate card · estimate · questionnaire", "Customer/client approval", "Bounded lists, exports & dashboards"] },
      { id: "p-event", kind: "process", badge: "P7", x: 760, y: 1035, w: 360, h: 185, title: "Notifications, webhooks & schedulers", lines: ["FCM token resolve / bounded fan-out", "SMS · email · WhatsApp · calls", "6 outbound lifecycle webhook events", "Cron reminders, expiry, sync & housekeeping"] },

      { id: "d-identity", kind: "store", badge: "D1", x: 1480, y: 175, w: 420, h: 145, title: "Identity & access tables", lines: ["tbl_user · tbl_easyfixer · tbl_client_contacts", "OTP · roles/stages · device_info · tbl_easyfixer_app"] },
      { id: "d-jobs", kind: "store", badge: "D2", x: 1480, y: 385, w: 420, h: 165, title: "Jobs, offers & audit", lines: ["tbl_job · tbl_job_offer", "scheduling_history · status/comments", "customer/address/services · customer requests"] },
      { id: "d-detail", kind: "store", badge: "D3", x: 1480, y: 615, w: 420, h: 165, title: "Field-work detail", lines: ["quotation + questionnaire rows", "tbl_job_image metadata / document refs", "tbl_job_location_track · call records"] },
      { id: "d-ops", kind: "store", badge: "D4", x: 1480, y: 845, w: 420, h: 165, title: "Operations & finance", lines: ["attendance / leave · withdrawals / payouts", "notices · rate cards · skills / serviceability", "easyfix_properties · scheduler/config state"] },
      { id: "d-delivery", kind: "store", badge: "D5", x: 1480, y: 1075, w: 420, h: 155, title: "Retry / delivery control", lines: ["tbl_idempotency_key", "webhook mappings, attempts & DLQ", "in-process rate buckets / scheduler telemetry"] },

      { id: "x-comms", kind: "provider", badge: "X1", x: 2030, y: 175, w: 300, h: 155, title: "SMS / email / WhatsApp", lines: ["OTP and customer PIN", "Transactional notifications", "Provider status callbacks"] },
      { id: "x-fcm", kind: "provider", badge: "X2", x: 2030, y: 405, w: 300, h: 135, title: "Firebase Cloud Messaging", lines: ["Job offers / reminders", "Registration, notice & attendance push"] },
      { id: "x-voice", kind: "provider", badge: "X3", x: 2030, y: 615, w: 300, h: 165, title: "Voice, maps, AI & KYC", lines: ["Plivo / Kaleyra masked calls", "Maps / geocoding · KYC vendors", "Transcription / call analysis"] },
      { id: "x-webhook", kind: "provider", badge: "X4", x: 2030, y: 855, w: 300, h: 155, title: "Client webhook endpoints", lines: ["TechAssigned · TechStart", "Reschedule · incomplete · complete", "CancelJob"] },
      { id: "x-s3", kind: "store", badge: "X5", x: 2030, y: 1080, w: 300, h: 150, title: "AWS S3 / legacy files", lines: ["JobSupportings & profile media", "5-minute UI presigns", "Longer webhook presigns"] },

      { id: "risk-deploy", kind: "risk", badge: "!", x: 20, y: 1340, w: 380, h: 110, title: "Deployment verification required", lines: ["Lifecycle migration + offer/auth indexes", "exist in the worktree; installation is unverified."] },
      { id: "legacy-note", kind: "legacy", badge: "L", x: 420, y: 1340, w: 1470, h: 110, title: "Legacy / parity lane (not an authoritative target path)", lines: ["Technician_mobile_App_v2 ↔ API_AngularClientDashboard · EasyFix_API · old CRM / Angular dashboard.", "Use for contract parity and cutover verification only."] },
      { id: "risk-contract", kind: "risk", badge: "!", x: 1910, y: 1340, w: 460, h: 110, title: "Current caller / backend drift", lines: ["Client dashboard/notices/maps/signup and CRM", "bulk-payout shapes include mismatches.", "CRM caches also need logout review."] },
    ],
    edges: [
      { from: "ui-tech", to: "p-auth", type: "api", via: [[465, 250]], label: ["/mobile · OTP/JWT", "profile · jobs · GPS/media"], labelAt: [470, 220] },
      { from: "ui-crm", to: "p-auth", type: "api", via: [[465, 670], [465, 285]], label: ["/admin · JWT", "jobs · assignment · finance"], labelAt: [465, 445] },
      { from: "ui-client", to: "p-auth", type: "api", via: [[478, 880], [478, 300]], label: ["/client · SPOC JWT", "booking · tracking · approval"], labelAt: [478, 665] },
      { from: "ui-public", to: "p-auth", type: "api", via: [[491, 1120], [491, 315]], label: ["/public · /integration · /webhook", "tokens · Basic Auth · provider secrets"], labelAt: [491, 940] },
      { from: "ui-tech", to: "local", type: "local", label: ["token · cache · drafts", "outbox infrastructure · location owner"], labelAt: [235, 405] },

      { from: "p-auth", to: "p-intake", type: "api" },
      { from: "p-auth", to: "p-offer", type: "api" },
      { from: "p-auth", to: "p-life", type: "api", via: [[935, 350], [935, 525]] },
      { from: "p-auth", to: "p-workforce", type: "api", via: [[520, 350], [520, 820]] },
      { from: "p-auth", to: "p-detail", type: "api", via: [[930, 350], [930, 820]] },

      { from: "p-intake", to: "d-jobs", type: "data", via: [[1400, 250], [1400, 465]], label: ["job + customer +", "address + services"], labelAt: [1400, 350] },
      { from: "p-intake", to: "p-offer", type: "api", via: [[940, 360], [725, 360]], label: ["booked job", "schedule context"], labelAt: [830, 360] },
      { from: "p-offer", to: "d-jobs", type: "data", label: ["job lock · assignment", "offer rows · audit"], labelAt: [1190, 520] },
      { from: "p-offer", to: "p-event", type: "async", via: [[725, 660], [725, 1120]], label: ["committed offer", "or expiry event"], labelAt: [725, 925] },
      { from: "p-event", to: "x-fcm", type: "async", via: [[1960, 1125], [1960, 470]], label: ["bounded token fan-out", "dead-token pruning"], labelAt: [1960, 540] },
      { from: "x-fcm", to: "ui-tech", type: "async", via: [[2005, 470], [2005, 145], [235, 145]], label: ["offer / notice /", "registration push"], labelAt: [1230, 145] },

      { from: "p-life", to: "d-jobs", type: "data", label: ["status / ownership", "timestamps / audit"], labelAt: [1400, 500] },
      { from: "p-life", to: "d-detail", type: "data", via: [[1400, 530], [1400, 695]], label: ["location pings", "selfie / call detail"], labelAt: [1400, 675] },
      { from: "p-life", to: "p-event", type: "async", via: [[1160, 660], [1160, 1120]], label: ["lifecycle event", "after state change"], labelAt: [1160, 925] },
      { from: "p-life", to: "x-voice", type: "api", via: [[1960, 530], [1960, 695]], label: ["masked call / map", "request & callback"], labelAt: [1960, 675] },

      { from: "p-workforce", to: "d-identity", type: "data", via: [[1385, 820], [1385, 250]], label: ["profile / lifecycle", "roles / devices"], labelAt: [1385, 285] },
      { from: "p-workforce", to: "d-ops", type: "data", via: [[725, 940], [1400, 940]], label: ["attendance / earnings", "withdrawal / configuration"], labelAt: [1210, 940] },
      { from: "p-detail", to: "d-detail", type: "data", label: ["rows / metadata", "bounded projections"], labelAt: [1400, 760] },
      { from: "p-detail", to: "x-s3", type: "data", via: [[1960, 820], [1960, 1155]], label: ["media bytes", "keys / presigns"], labelAt: [1960, 1140] },

      { from: "p-auth", to: "d-identity", type: "data", via: [[725, 145], [1435, 145], [1435, 247]], label: ["identity / OTP /", "device token state"], labelAt: [1390, 145] },
      { from: "p-auth", to: "x-comms", type: "async", via: [[725, 120], [1980, 120], [1980, 250]], label: ["login OTP /", "verification links"], labelAt: [1840, 120] },
      { from: "p-event", to: "d-delivery", type: "data", label: ["idempotency / attempts", "mapping / DLQ"], labelAt: [1400, 1150] },
      { from: "p-event", to: "x-comms", type: "async", via: [[1980, 1125], [1980, 250]], label: ["SMS / email /", "WhatsApp events"], labelAt: [1980, 360] },
      { from: "p-event", to: "x-webhook", type: "async", via: [[1980, 1125], [1980, 930]], label: ["enriched lifecycle", "payload + retry"], labelAt: [1980, 920] },
    ],
    note: "Performance boundaries shown: bounded client storage and retries, rate/body limits at the API, finite DB pool/queue, capped location history, bounded push fan-out, and post-state-change delivery. Provider code/configuration is not proof of active production credentials.",
  },
  {
    slug: "easyfix-dfd-level-2-technician-job-lifecycle",
    name: "Level 2 - Technician Lifecycle",
    title: "EasyFix Data Flow Diagram · Level 2 Technician Job Lifecycle",
    subtitle: "Editable screen-to-process trace for the highest-value mobile flow",
    width: 2400,
    height: 1450,
    boundaries: [
      { id: "b-app", x: 30, y: 135, w: 2340, h: 390, title: "TECHNICIAN APP · screens and account-scoped transport", tone: "neutral" },
      { id: "b-be", x: 30, y: 565, w: 2340, h: 370, title: "UNIFIED BACKEND · mobile API and authoritative transition logic", tone: "target" },
      { id: "b-bottom", x: 30, y: 975, w: 2340, h: 360, title: "DURABLE STORES & DELIVERY TARGETS", tone: "store" },
    ],
    nodes: [
      { id: "a1", kind: "screen", badge: "S1", x: 60, y: 200, w: 340, h: 205, title: "Login & registration", lines: ["Mobile + OTP", "Language / pincode / referral", "Profile, KYC & lifecycle gate", "JWT persisted only after verify"] },
      { id: "a2", kind: "screen", badge: "S2", x: 440, y: 200, w: 340, h: 205, title: "Dashboard & job offers", lines: ["Cached aggregated dashboard", "FCM deep-link / offer alert", "Open offers → detail", "Accept or reject online"] },
      { id: "a3", kind: "screen", badge: "S3", x: 820, y: 200, w: 340, h: 205, title: "Scheduled job / reached", lines: ["Job detail + masked customer call", "ETA / navigation", "Upload reached selfie", "Resend customer check-in PIN"] },
      { id: "a4", kind: "screen", badge: "S4", x: 1200, y: 200, w: 340, h: 205, title: "Check-in & start work", lines: ["Customer PIN verification", "Optional GPS stamp", "Status → IN_PROGRESS", "Start account/job-bound location task"] },
      { id: "a5", kind: "screen", badge: "S5", x: 1580, y: 200, w: 340, h: 205, title: "Estimate & work progress", lines: ["Rate card + quotation lines", "Images + questionnaire", "Send for approval", "Continue / reschedule / cancel"] },
      { id: "a6", kind: "screen", badge: "S6", x: 1960, y: 200, w: 340, h: 205, title: "Complete / revisit", lines: ["Problem + remarks", "Cash collection", "Completion or next visit", "Refresh cache and stop location"] },

      { id: "cross", kind: "note", badge: "M", x: 320, y: 435, w: 1760, h: 65, title: "Cross-cutting mobile transport", lines: ["15s JSON timeout · one safe retry · account-generation abort · owner-scoped cache/single-flight · stable Idempotency-Key · outbox infrastructure (no queueable current mutation) · GPS latest-fix only (25s / 40m)"] },

      { id: "b1", kind: "process", badge: "P1", x: 60, y: 650, w: 340, h: 190, title: "Auth & lifecycle policy", lines: ["OTP throttles / verify", "JWT + device/FCM token", "Registration state derived server-side", "Mutation capability gate"] },
      { id: "b2", kind: "process", badge: "P2", x: 440, y: 650, w: 340, h: 190, title: "Offer decision", lines: ["Open offer lookup", "Row/job locks", "First acceptance wins", "409 on lost race · rejection audit"] },
      { id: "b3", kind: "process", badge: "P3", x: 820, y: 650, w: 340, h: 190, title: "Reached & check-in", lines: ["Ownership check", "Selfie document reference", "Customer PIN match", "SCHEDULED → IN_PROGRESS"] },
      { id: "b4", kind: "process", badge: "P4", x: 1200, y: 650, w: 340, h: 190, title: "Location & job actions", lines: ["ETA / reschedule / masked call", "Append location while status = 2", "409 stops background task", "Job-scoped access only"] },
      { id: "b5", kind: "process", badge: "P5", x: 1580, y: 650, w: 340, h: 190, title: "Estimate & media", lines: ["Rate card / quotation", "Questionnaire & work progress", "Bounded upload validation", "S3 key + relational metadata"] },
      { id: "b6", kind: "process", badge: "P6", x: 1960, y: 650, w: 340, h: 190, title: "Checkout & post-commit events", lines: ["Completed (3) or revisit (10)", "Cash/problem/revisit stamps", "Status/audit write", "Push / SMS / webhook delivery"] },

      { id: "l-local", kind: "store", badge: "D0", x: 60, y: 1060, w: 290, h: 175, title: "Device state", lines: ["SecureStore JWT", "AsyncStorage cache/drafts", "Outbox/dead letters (infrastructure)", "Active job-location owner"] },
      { id: "l-id", kind: "store", badge: "D1", x: 385, y: 1060, w: 290, h: 175, title: "Identity & idempotency", lines: ["Easyfixer / lifecycle", "OTP + device tokens", "tbl_idempotency_key", "stored replay response"] },
      { id: "l-job", kind: "store", badge: "D2", x: 710, y: 1060, w: 290, h: 175, title: "Job & offer state", lines: ["tbl_job / tbl_job_offer", "scheduling_history", "status/comment audit", "customer / address / service"] },
      { id: "l-field", kind: "store", badge: "D3", x: 1035, y: 1060, w: 290, h: 175, title: "Field-work detail", lines: ["quotation/questionnaire", "job image metadata", "tbl_job_location_track", "checkout detail"] },
      { id: "l-s3", kind: "store", badge: "D4", x: 1360, y: 1060, w: 290, h: 175, title: "S3 media", lines: ["Reached / booking / completion", "Profile / KYC documents", "Short-lived signed reads", "Legacy local fallback"] },
      { id: "l-comms", kind: "provider", badge: "X1", x: 1685, y: 1060, w: 290, h: 175, title: "FCM / SMS / voice", lines: ["Offer and status push", "Customer PIN SMS", "Masked call bridge", "Dead-token pruning"] },
      { id: "l-consumers", kind: "provider", badge: "X2", x: 2010, y: 1060, w: 290, h: 175, title: "CRM, client & customer", lines: ["Updated job/report views", "6 client webhook events", "Customer completion flow", "Ops monitoring"] },
      { id: "mobile-risk", kind: "risk", badge: "!", x: 60, y: 1260, w: 2240, h: 52, title: "Current mobile gaps", lines: ["No verified server logout/device deregistration · FCM token is also sent as deviceId · outbox has no eligible queueable callsite · legacy report video/questionnaire-image parity is absent."] },
    ],
    edges: [
      { from: "a1", to: "a2", type: "api", label: ["verified session", "jobs unlocked"], labelAt: [420, 245] },
      { from: "a2", to: "a3", type: "api", label: ["accepted offer", "scheduled job"], labelAt: [800, 245] },
      { from: "a3", to: "a4", type: "api", label: ["selfie ref +", "customer PIN"], labelAt: [1180, 245] },
      { from: "a4", to: "a5", type: "api", label: ["IN_PROGRESS", "work context"], labelAt: [1560, 245] },
      { from: "a5", to: "a6", type: "api", label: ["approved/worked", "completion data"], labelAt: [1940, 245] },
      { from: "a6", to: "a2", type: "local", via: [[2325, 175], [610, 175]], label: ["invalidate + reconcile", "authoritative state"], labelAt: [1470, 175] },

      { from: "a1", to: "b1", type: "api", label: ["login/registration", "requests"], labelAt: [230, 590] },
      { from: "a2", to: "b2", type: "api", label: ["list/detail", "accept/reject"], labelAt: [610, 590] },
      { from: "a3", to: "b3", type: "api", label: ["document id", "PIN / GPS"], labelAt: [990, 590] },
      { from: "a4", to: "b4", type: "api", label: ["ETA / location", "reschedule / call"], labelAt: [1370, 590] },
      { from: "a5", to: "b5", type: "api", label: ["quotes / images", "answers / progress"], labelAt: [1750, 590] },
      { from: "a6", to: "b6", type: "api", label: ["checkout / revisit", "idempotency key"], labelAt: [2130, 590] },

      { from: "cross", to: "l-local", type: "local", via: [[200, 500], [200, 1015]], label: ["account-scoped", "cache / journal infra"], labelAt: [200, 955] },
      { from: "b1", to: "l-id", type: "data", label: ["OTP / identity /", "device session"], labelAt: [430, 960] },
      { from: "b2", to: "l-job", type: "data", label: ["offer + job locks", "claim / rejection"], labelAt: [755, 960] },
      { from: "b3", to: "l-job", type: "data", via: [[990, 920], [855, 920]], label: ["check-in status", "selfie reference"], labelAt: [900, 920] },
      { from: "b4", to: "l-field", type: "data", via: [[1370, 930], [1180, 930]], label: ["latest GPS batch", "trail / call audit"], labelAt: [1220, 930] },
      { from: "b5", to: "l-field", type: "data", via: [[1750, 950], [1180, 950]], label: ["quotation / answers", "media metadata"], labelAt: [1500, 950] },
      { from: "b5", to: "l-s3", type: "data", via: [[1750, 930], [1505, 930]], label: ["compressed media", "object key / presign"], labelAt: [1510, 930] },
      { from: "b6", to: "l-job", type: "data", via: [[2325, 900], [855, 900]], label: ["terminal/revisit status", "timestamps & audit"], labelAt: [1820, 900] },
      { from: "b3", to: "l-comms", type: "async", via: [[990, 970], [1830, 970]], label: ["customer check-in", "PIN SMS"], labelAt: [1610, 970] },
      { from: "b6", to: "l-comms", type: "async", via: [[2130, 950], [1830, 950]], label: ["status push /", "notification data"], labelAt: [1850, 950] },
      { from: "b6", to: "l-consumers", type: "async", label: ["post-transition event", "webhook / view refresh"], labelAt: [2160, 960] },
      { from: "l-comms", to: "a2", type: "async", via: [[1985, 1020], [2350, 1020], [2350, 150], [610, 150]], label: ["offer / reminder /", "status push"], labelAt: [1470, 150] },
      { from: "l-local", to: "l-id", type: "local", label: ["online retry key", "stored-response replay"], labelAt: [365, 1025] },
    ],
    note: "Lifecycle safety: mutable job state remains server-authoritative; location stops on a backend 409 or explicit cleanup; delayed offer decisions are not queued; retryable mutations carry stable actor-scoped idempotency keys.",
  },
];

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function htmlLabel(node) {
  const lines = (node.lines || []).map((line) => xmlEscape(line)).join("&lt;br&gt;");
  return `&lt;div&gt;&lt;b&gt;${xmlEscape(node.title)}&lt;/b&gt;${lines ? `&lt;br&gt;${lines}` : ""}&lt;/div&gt;`;
}

function nodeStyle(node) {
  const base = "whiteSpace=wrap;html=1;align=center;verticalAlign=middle;fontFamily=Arial;fontSize=14;fontColor=" + C.ink900 + ";spacing=8;";
  switch (node.kind) {
    case "external":
      return base + `rounded=0;fillColor=${C.white};strokeColor=${C.ink700};strokeWidth=2;`;
    case "screen":
      return base + `rounded=1;arcSize=12;fillColor=${C.red50};strokeColor=${C.red500};strokeWidth=2;`;
    case "process":
      return base + `rounded=1;arcSize=18;fillColor=${C.blue100};strokeColor=${C.blue500};strokeWidth=2;`;
    case "store":
      return base + `shape=datastore;fillColor=${C.greenTint};strokeColor=${C.green};strokeWidth=2;`;
    case "provider":
      return base + `rounded=1;arcSize=12;fillColor=${C.purpleTint};strokeColor=${C.purple};strokeWidth=2;`;
    case "legacy":
      return base + `rounded=1;arcSize=12;fillColor=${C.ink50};strokeColor=${C.ink300};strokeWidth=2;dashed=1;dashPattern=8 6;fontColor=${C.ink500};`;
    case "note":
      return base + `rounded=1;arcSize=12;fillColor=${C.goldTint};strokeColor=${C.gold};strokeWidth=1;`;
    case "risk":
      return base + `rounded=1;arcSize=10;fillColor=${C.red100};strokeColor=${C.red600};strokeWidth=2;dashed=1;dashPattern=6 4;fontColor=${C.red700};`;
    default:
      return base + `rounded=1;fillColor=${C.white};strokeColor=${C.ink300};`;
  }
}

function boundaryStyle(boundary) {
  const color = boundary.tone === "target"
    ? C.red500
    : boundary.tone === "store"
      ? C.green
      : boundary.tone === "external"
        ? C.purple
        : C.ink300;
  const fill = boundary.tone === "target"
    ? C.red50
    : boundary.tone === "store"
      ? C.greenTint
      : boundary.tone === "external"
        ? C.purpleTint
        : C.ink50;
  return `rounded=1;arcSize=8;fillColor=${fill};fillOpacity=25;strokeColor=${color};strokeWidth=2;dashed=1;dashPattern=8 6;html=1;align=left;verticalAlign=top;fontFamily=Arial;fontSize=13;fontStyle=1;fontColor=${color};spacingTop=8;spacingLeft=12;connectable=0;`;
}

function edgeStyle(edge) {
  const theme = edgeThemes[edge.type || "api"];
  return [
    "edgeStyle=orthogonalEdgeStyle",
    "orthogonalLoop=1",
    "jettySize=auto",
    "html=1",
    "rounded=1",
    `strokeColor=${theme.stroke}`,
    "strokeWidth=2",
    "endArrow=block",
    "endFill=1",
    edge.type === "async" || edge.type === "legacy" || edge.type === "local" ? "dashed=1" : "dashed=0",
    edge.type === "async" || edge.type === "legacy" ? "dashPattern=8 6" : edge.type === "local" ? "dashPattern=4 4" : "",
    "fontFamily=Arial",
    "fontSize=12",
    `fontColor=${C.ink700}`,
    `labelBackgroundColor=${C.white}`,
  ].filter(Boolean).join(";") + ";";
}

function makeDrawioCell(id, value, style, x, y, w, h) {
  return `<mxCell id="${xmlEscape(id)}" value="${value}" style="${xmlEscape(style)}" vertex="1" parent="1"><mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry"/></mxCell>`;
}

function drawioPage(page) {
  const cells = ["<mxCell id=\"0\"/>", "<mxCell id=\"1\" parent=\"0\"/>"];
  cells.push(makeDrawioCell(
    `${page.slug}-title`,
    `&lt;div style=&quot;text-align:left&quot;&gt;&lt;font style=&quot;font-size:26px&quot;&gt;&lt;b&gt;${xmlEscape(page.title)}&lt;/b&gt;&lt;/font&gt;&lt;br&gt;&lt;font color=&quot;${C.ink500}&quot;&gt;${xmlEscape(page.subtitle)} · ${xmlEscape(SNAPSHOT)}&lt;/font&gt;&lt;/div&gt;`,
    `rounded=0;whiteSpace=wrap;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;fontFamily=Arial;fontColor=${C.ink900};spacing=0;connectable=0;`,
    30, 24, page.width - 60, 80,
  ));

  for (const boundary of page.boundaries || []) {
    cells.push(makeDrawioCell(boundary.id, xmlEscape(boundary.title), boundaryStyle(boundary), boundary.x, boundary.y, boundary.w, boundary.h));
  }

  for (const node of page.nodes) {
    cells.push(makeDrawioCell(node.id, htmlLabel(node), nodeStyle(node), node.x, node.y, node.w, node.h));
  }

  page.edges.forEach((edge, index) => {
    const value = (edge.label || []).map(xmlEscape).join("&lt;br&gt;");
    const points = (edge.via || []).map(([x, y]) => `<mxPoint x="${x}" y="${y}"/>`).join("");
    const geometry = points
      ? `<mxGeometry relative="1" as="geometry"><Array as="points">${points}</Array></mxGeometry>`
      : `<mxGeometry relative="1" as="geometry"/>`;
    cells.push(`<mxCell id="${page.slug}-edge-${index + 1}" value="${value}" style="${xmlEscape(edgeStyle(edge))}" edge="1" parent="1" source="${xmlEscape(edge.from)}" target="${xmlEscape(edge.to)}">${geometry}</mxCell>`);
  });

  cells.push(makeDrawioCell(
    `${page.slug}-note`,
    `&lt;div style=&quot;text-align:left&quot;&gt;&lt;b&gt;Scope note:&lt;/b&gt; ${xmlEscape(page.note)}&lt;/div&gt;`,
    `rounded=1;arcSize=8;whiteSpace=wrap;html=1;strokeColor=${C.ink100};fillColor=${C.white};fontFamily=Arial;fontSize=12;fontColor=${C.ink500};align=left;spacing=8;connectable=0;`,
    30, page.height - 82, page.width - 60, 50,
  ));

  return `<diagram id="${xmlEscape(page.slug)}" name="${xmlEscape(page.name)}"><mxGraphModel dx="1600" dy="900" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="${page.width}" pageHeight="${page.height}" math="0" shadow="0"><root>${cells.join("")}</root></mxGraphModel></diagram>`;
}

function nodeCenter(node) {
  return { x: node.x + node.w / 2, y: node.y + node.h / 2 };
}

function boundaryPoint(node, toward) {
  const center = nodeCenter(node);
  const dx = toward.x - center.x;
  const dy = toward.y - center.y;
  if (dx === 0 && dy === 0) return center;
  const halfW = node.w / 2;
  const halfH = node.h / 2;
  const scale = Math.min(halfW / Math.max(Math.abs(dx), 0.0001), halfH / Math.max(Math.abs(dy), 0.0001));
  return { x: center.x + dx * scale, y: center.y + dy * scale };
}

function roundedPath(points, radius = 10) {
  if (points.length < 2) return "";
  if (points.length === 2) return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i += 1) {
    const prev = points[i - 1];
    const cur = points[i];
    const next = points[i + 1];
    const lenA = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    const lenB = Math.hypot(next.x - cur.x, next.y - cur.y);
    const r = Math.min(radius, lenA / 2, lenB / 2);
    const before = {
      x: cur.x - ((cur.x - prev.x) / (lenA || 1)) * r,
      y: cur.y - ((cur.y - prev.y) / (lenA || 1)) * r,
    };
    const after = {
      x: cur.x + ((next.x - cur.x) / (lenB || 1)) * r,
      y: cur.y + ((next.y - cur.y) / (lenB || 1)) * r,
    };
    d += ` L ${before.x} ${before.y} Q ${cur.x} ${cur.y} ${after.x} ${after.y}`;
  }
  const last = points[points.length - 1];
  d += ` L ${last.x} ${last.y}`;
  return d;
}

function edgePoints(page, edge) {
  const byId = new Map(page.nodes.map((node) => [node.id, node]));
  const source = byId.get(edge.from);
  const target = byId.get(edge.to);
  if (!source || !target) throw new Error(`Missing edge endpoint ${edge.from} -> ${edge.to}`);
  const sourceCenter = nodeCenter(source);
  const targetCenter = nodeCenter(target);
  const via = (edge.via || []).map(([x, y]) => ({ x, y }));
  const firstToward = via[0] || targetCenter;
  const lastToward = via[via.length - 1] || sourceCenter;
  return [boundaryPoint(source, firstToward), ...via, boundaryPoint(target, lastToward)];
}

function badgeColors(kind) {
  if (kind === "process") return { fill: C.blue500, text: C.white };
  if (kind === "store") return { fill: C.green, text: C.white };
  if (kind === "provider") return { fill: C.purple, text: C.white };
  if (kind === "legacy") return { fill: C.ink300, text: C.white };
  if (kind === "note") return { fill: C.gold, text: C.white };
  if (kind === "risk") return { fill: C.red600, text: C.white };
  return { fill: C.red500, text: C.white };
}

function svgTextLines(node, yOverride) {
  const lines = node.lines || [];
  const lineHeight = 19;
  const titleHeight = 24;
  const total = titleHeight + (lines.length ? 8 + lines.length * lineHeight : 0);
  let y = yOverride ?? (node.y + node.h / 2 - total / 2 + 18);
  const x = node.x + node.w / 2;
  let out = `<text x="${x}" y="${y}" text-anchor="middle" class="node-title">${xmlEscape(node.title)}</text>`;
  y += 28;
  for (const line of lines) {
    out += `<text x="${x}" y="${y}" text-anchor="middle" class="node-line">${xmlEscape(line)}</text>`;
    y += lineHeight;
  }
  return out;
}

function renderNode(node) {
  const badge = badgeColors(node.kind);
  let shape = "";
  if (node.kind === "store") {
    const ry = 13;
    shape = `<path d="M ${node.x} ${node.y + ry} Q ${node.x} ${node.y} ${node.x + node.w / 2} ${node.y} Q ${node.x + node.w} ${node.y} ${node.x + node.w} ${node.y + ry} L ${node.x + node.w} ${node.y + node.h - ry} Q ${node.x + node.w} ${node.y + node.h} ${node.x + node.w / 2} ${node.y + node.h} Q ${node.x} ${node.y + node.h} ${node.x} ${node.y + node.h - ry} Z" fill="${C.greenTint}" stroke="${C.green}" stroke-width="2"/><ellipse cx="${node.x + node.w / 2}" cy="${node.y + ry}" rx="${node.w / 2}" ry="${ry}" fill="none" stroke="${C.green}" stroke-width="2"/>`;
  } else {
    const style = node.kind === "screen"
      ? { fill: C.red50, stroke: C.red500, dash: "" }
      : node.kind === "process"
        ? { fill: C.blue100, stroke: C.blue500, dash: "" }
        : node.kind === "provider"
          ? { fill: C.purpleTint, stroke: C.purple, dash: "" }
          : node.kind === "legacy"
            ? { fill: C.ink50, stroke: C.ink300, dash: "10 7" }
            : node.kind === "note"
              ? { fill: C.goldTint, stroke: C.gold, dash: "" }
              : node.kind === "risk"
                ? { fill: C.red100, stroke: C.red600, dash: "7 5" }
              : { fill: C.white, stroke: C.ink700, dash: "" };
    const radius = node.kind === "external" ? 3 : 14;
    shape = `<rect x="${node.x}" y="${node.y}" width="${node.w}" height="${node.h}" rx="${radius}" fill="${style.fill}" stroke="${style.stroke}" stroke-width="2"${style.dash ? ` stroke-dasharray="${style.dash}"` : ""}/>`;
    if (node.kind === "screen") {
      shape += `<path d="M ${node.x + 14} ${node.y + 1} H ${node.x + node.w - 14}" stroke="${C.red500}" stroke-width="5" stroke-linecap="round"/>`;
    }
  }
  const badgeWidth = Math.max(36, String(node.badge || "").length * 9 + 18);
  const badgeMarkup = node.badge
    ? `<rect x="${node.x + 12}" y="${node.y + 12}" width="${badgeWidth}" height="26" rx="13" fill="${badge.fill}"/><text x="${node.x + 12 + badgeWidth / 2}" y="${node.y + 30}" text-anchor="middle" class="badge" fill="${badge.text}">${xmlEscape(node.badge)}</text>`
    : "";
  return `<g filter="url(#shadow)">${shape}</g>${badgeMarkup}${svgTextLines(node)}`;
}

function renderBoundary(boundary) {
  const color = boundary.tone === "target"
    ? C.red500
    : boundary.tone === "store"
      ? C.green
      : boundary.tone === "external"
        ? C.purple
        : C.ink300;
  const fill = boundary.tone === "target"
    ? C.red50
    : boundary.tone === "store"
      ? C.greenTint
      : boundary.tone === "external"
        ? C.purpleTint
        : C.ink50;
  return `<g><rect x="${boundary.x}" y="${boundary.y}" width="${boundary.w}" height="${boundary.h}" rx="18" fill="${fill}" fill-opacity="0.22" stroke="${color}" stroke-width="2" stroke-dasharray="10 8"/><rect x="${boundary.x + 18}" y="${boundary.y - 11}" width="${Math.max(200, boundary.title.length * 8.2 + 26)}" height="28" rx="14" fill="${C.white}" stroke="${color}" stroke-width="1.5"/><text x="${boundary.x + 31}" y="${boundary.y + 8}" class="boundary-label" fill="${color}">${xmlEscape(boundary.title)}</text></g>`;
}

function renderEdge(page, edge) {
  const theme = edgeThemes[edge.type || "api"];
  const points = edgePoints(page, edge);
  return `<path d="${roundedPath(points)}" fill="none" stroke="${theme.stroke}" stroke-width="2.4"${theme.dash ? ` stroke-dasharray="${theme.dash}"` : ""} marker-end="url(#${theme.marker})"/>`;
}

function renderEdgeLabel(edge) {
  if (!edge.labelAt || !edge.label || edge.label.length === 0) return "";
  const [x, y] = edge.labelAt;
  const lines = edge.label;
  const width = Math.max(...lines.map((line) => line.length)) * 7 + 22;
  const height = lines.length * 17 + 10;
  const top = y - height / 2;
  let text = "";
  lines.forEach((line, index) => {
    text += `<text x="${x}" y="${top + 17 + index * 17}" text-anchor="middle" class="edge-label">${xmlEscape(line)}</text>`;
  });
  return `<g><rect x="${x - width / 2}" y="${top}" width="${width}" height="${height}" rx="8" fill="${C.white}" fill-opacity="0.94" stroke="${C.ink100}" stroke-width="1"/>${text}</g>`;
}

function marker(id, color) {
  return `<marker id="${id}" markerWidth="10" markerHeight="10" refX="8" refY="4.5" orient="auto" markerUnits="strokeWidth"><path d="M 0 0 L 9 4.5 L 0 9 z" fill="${color}"/></marker>`;
}

function renderLegend(page) {
  const y = page.height - 106;
  const items = [
    { x: 42, label: "Screen / client surface", fill: C.red50, stroke: C.red500 },
    { x: 300, label: "Backend process", fill: C.blue100, stroke: C.blue500 },
    { x: 520, label: "Data store", fill: C.greenTint, stroke: C.green },
    { x: 685, label: "External provider", fill: C.purpleTint, stroke: C.purple },
  ];
  let out = "";
  for (const item of items) {
    out += `<rect x="${item.x}" y="${y}" width="26" height="16" rx="4" fill="${item.fill}" stroke="${item.stroke}"/><text x="${item.x + 36}" y="${y + 13}" class="legend-label">${xmlEscape(item.label)}</text>`;
  }
  const edgeItems = [
    { x: 940, label: "API/data request", theme: edgeThemes.api },
    { x: 1150, label: "Store read/write", theme: edgeThemes.data },
    { x: 1350, label: "Async push/event", theme: edgeThemes.async },
    { x: 1570, label: "Local/offline", theme: edgeThemes.local },
    { x: 1750, label: "Legacy/reference", theme: edgeThemes.legacy },
  ];
  for (const item of edgeItems) {
    out += `<line x1="${item.x}" y1="${y + 8}" x2="${item.x + 40}" y2="${y + 8}" stroke="${item.theme.stroke}" stroke-width="2.4"${item.theme.dash ? ` stroke-dasharray="${item.theme.dash}"` : ""}/><text x="${item.x + 48}" y="${y + 13}" class="legend-label">${xmlEscape(item.label)}</text>`;
  }
  return out;
}

function renderSvg(page) {
  const defs = `<defs>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="0" dy="3" stdDeviation="4" flood-color="${C.ink900}" flood-opacity="0.10"/></filter>
    ${marker("arrow-api", edgeThemes.api.stroke)}
    ${marker("arrow-data", edgeThemes.data.stroke)}
    ${marker("arrow-async", edgeThemes.async.stroke)}
    ${marker("arrow-local", edgeThemes.local.stroke)}
    ${marker("arrow-legacy", edgeThemes.legacy.stroke)}
    <style>
      text { font-family: Arial, Helvetica, sans-serif; }
      .page-title { font-size: 30px; font-weight: 700; fill: ${C.ink900}; }
      .page-subtitle { font-size: 16px; fill: ${C.ink500}; }
      .snapshot { font-size: 13px; fill: ${C.ink500}; }
      .node-title { font-size: 18px; font-weight: 700; fill: ${C.ink900}; }
      .node-line { font-size: 14px; fill: ${C.ink700}; }
      .badge { font-size: 12px; font-weight: 700; }
      .boundary-label { font-size: 13px; font-weight: 700; letter-spacing: 0.6px; }
      .edge-label { font-size: 12px; fill: ${C.ink700}; }
      .legend-label { font-size: 12px; fill: ${C.ink500}; }
      .note-text { font-size: 12px; fill: ${C.ink500}; }
    </style>
  </defs>`;
  const boundaryMarkup = (page.boundaries || []).map(renderBoundary).join("");
  const edgeMarkup = page.edges.map((edge) => renderEdge(page, edge)).join("");
  const nodeMarkup = page.nodes.map(renderNode).join("");
  const edgeLabels = page.edges.map(renderEdgeLabel).join("");
  const noteY = page.height - 42;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${page.width}" height="${page.height}" viewBox="0 0 ${page.width} ${page.height}" role="img" aria-labelledby="title-${page.slug} desc-${page.slug}">
    <title id="title-${page.slug}">${xmlEscape(page.title)}</title>
    <desc id="desc-${page.slug}">${xmlEscape(page.subtitle)}. ${xmlEscape(page.note)}</desc>
    ${defs}
    <rect width="${page.width}" height="${page.height}" fill="${C.white}"/>
    <circle cx="54" cy="54" r="28" fill="${C.red500}"/><text x="54" y="63" text-anchor="middle" font-family="Arial" font-size="20" font-weight="700" fill="${C.white}">EF</text>
    <text x="96" y="49" class="page-title">${xmlEscape(page.title)}</text>
    <text x="96" y="78" class="page-subtitle">${xmlEscape(page.subtitle)}</text>
    <text x="${page.width - 35}" y="54" text-anchor="end" class="snapshot">${xmlEscape(SNAPSHOT)}</text>
    <line x1="30" y1="105" x2="${page.width - 30}" y2="105" stroke="${C.ink100}" stroke-width="2"/>
    ${boundaryMarkup}
    ${edgeMarkup}
    ${nodeMarkup}
    ${edgeLabels}
    ${renderLegend(page)}
    <text x="36" y="${noteY}" class="note-text"><tspan font-weight="700">Scope note: </tspan>${xmlEscape(page.note)}</text>
  </svg>`;
}

async function main() {
  const drawio = `<?xml version="1.0" encoding="UTF-8"?><mxfile host="app.diagrams.net" modified="2026-08-11T00:00:00.000Z" agent="Codex" version="24.7.17" type="device" compressed="false">${pages.map(drawioPage).join("")}</mxfile>`;
  fs.writeFileSync(path.join(OUTPUT_DIR, "easyfix-platform-dfd.drawio"), drawio, "utf8");

  for (const page of pages) {
    const svg = renderSvg(page);
    const svgPath = path.join(OUTPUT_DIR, `${page.slug}.svg`);
    const pngPath = path.join(OUTPUT_DIR, `${page.slug}.png`);
    fs.writeFileSync(svgPath, svg, "utf8");
    await sharp(Buffer.from(svg))
      .resize({ width: page.width * 2 })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toFile(pngPath);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
