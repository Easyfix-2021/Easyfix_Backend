/*
 * GET /api/public/privacy — the EasyFix Technician app privacy policy.
 *
 * ─── WHY THIS EXISTS ───────────────────────────────────────────────────────
 *
 * Google Play's background-location declaration requires a PUBLICLY REACHABLE
 * privacy policy URL that explicitly discloses background location collection.
 * EasyFix had none — the in-app screen said "the full policy is provided by
 * EasyFix" and linked nowhere, which is a missing mandatory artefact rather
 * than a wording problem.
 *
 * ─── WHY HERE, AND NOT THE CRM ─────────────────────────────────────────────
 *
 * backend.easyfix.in is provably internet-reachable without the corporate VPN:
 * the technician app calls /api/public/pincodes/* from field phones, on mobile
 * networks, unauthenticated. That is proof by shipped traffic. The CRM sits
 * behind an ALB allowlist and would need reasoning about exceptions.
 *
 * ─── THE AUTH EXCEPTION, STATED OUT LOUD ───────────────────────────────────
 *
 * routes/public/index.js says every sub-router mounted here MUST self-verify
 * its own token, and warns against adding one that relies on a parent guard.
 * This router is the deliberate exception: a privacy policy that required a
 * token would not be a public privacy policy. It is safe because it is
 * READ-ONLY, STATIC, and touches NO database and NO user data — there is
 * nothing here to scope to a caller. Do not use it as precedent for a
 * sub-router that reads anything.
 *
 * ─── KEEP IN STEP ──────────────────────────────────────────────────────────
 *
 * This page, the app's in-app summary (src/app/privacy.tsx) and the consent
 * dialog (locationPermission.backgroundMessage) must agree. Three surfaces
 * disagreeing about background location is itself a Play rejection, and was
 * the exact defect this work started from. This page is the CANONICAL text;
 * the other two are summaries of it.
 */

const router = require('express').Router();
const logger = require('../../logger');

/** ISO date shown to the reader and used for the Last-Modified header. */
const LAST_UPDATED = '2026-08-25';

const SECTIONS = [
  {
    h: 'Who this covers',
    p: [
      'This policy covers the <strong>EasyFix Technician app</strong>, used by technicians ("EasyFixers") who accept and carry out service jobs for EasyFix. It does not cover the EasyFix customer experience or the internal tools used by EasyFix staff.',
    ],
  },
  {
    h: 'What we collect',
    p: [
      '<strong>Account and identity.</strong> Your name, mobile number, email address, photograph, and the KYC and bank details you provide during registration, including identity documents you upload for verification.',
      '<strong>Work.</strong> The jobs you are offered, accept, reject and complete; check-in and completion times; photographs and notes you attach to a job; questionnaire answers; ratings and performance figures; attendance and leave; earnings, advances and withdrawals.',
      '<strong>Skills and availability.</strong> Your service categories and skills, the pincodes you serve, and the days you mark yourself available.',
      '<strong>Device and technical.</strong> Your device model and app version, a push notification token, and error diagnostics.',
      '<strong>Location.</strong> Set out in full in the next section, because two different things happen and only one of them runs in the background.',
    ],
  },
  {
    h: 'Location',
    id: 'location',
    p: [
      '<h3>One-off location readings</h3>',
      'When you mark attendance, and when you send your reached-location selfie, the app takes a <strong>single</strong> location reading at that moment to record where the action happened. Nothing continues after it.',
      '<h3>Continuous location sharing while you hold a job</h3>',
      '<p class="callout"><strong>From the moment you accept a job until you mark it complete — or the job is cancelled — EasyFix collects your device’s location and shares it with the EasyFix operations team. This collection continues in the background, including when the app is closed or not in use.</strong></p>',
      '<strong>Why.</strong> So the operations team can tell the waiting customer when you will arrive, confirm that you reached the site, and help you if you are delayed or cannot find the address.',
      '<strong>Why it needs background access.</strong> You cannot hold the app open while riding. Android may close the app to reclaim memory, and on modern Android versions an app cannot restart location sharing from the background without this permission. Without it the trail would stop permanently the first time the system closed the app — which is exactly when it is most needed.',
      '<strong>When it starts.</strong> When you tap <em>Accept job</em>. Because a job can be accepted days before its appointment, this can begin well before the work itself.',
      '<strong>What is sent.</strong> Latitude, longitude and an accuracy figure — nothing else. No more often than every 25 seconds, and not until your device has moved at least 40 metres.',
      '<strong>What tells you it is running.</strong> On Android, a permanent notification stays in your notification shade for as long as sharing is active. On iOS, the system location indicator is shown.',
      '<strong>When it stops.</strong> Whichever comes first: you mark the job complete; the job is cancelled; 12 hours after sharing started, automatically, even if the job is still open; you sign out; or you turn off location permission for EasyFix in your device settings.',
      '<strong>Your choice.</strong> You can decline background location and keep using the app. Some job features will not work without it, and the operations team will not be able to tell the customer where you are.',
    ],
  },
  {
    h: 'How we use what we collect',
    p: [
      'To offer you jobs that match your skills, availability and service area, and to assign and route work. To verify your identity and your arrival at a job. To keep the customer informed about when you will arrive. To calculate your earnings, incentives, rewards and performance. To manage attendance, leave and account status. To provide support. To keep the platform secure and investigate misuse.',
      '<strong>We do not sell your personal information.</strong> We do not use your location for advertising, for profiling unrelated to your work, or to track you across other apps or companies. The app contains no advertising, analytics or attribution software.',
    ],
  },
  {
    h: 'Who we share it with',
    p: [
      '<strong>EasyFix operations staff</strong>, who need it to run jobs and support you. <strong>Customers</strong>, who are told your first name and your expected arrival — customers are not shown your continuous location trail. <strong>Service providers</strong> who host and operate the platform on our behalf, under contract and only for that purpose. And <strong>where the law requires it</strong>, or to establish or defend legal claims.',
      'Location data is sent only to EasyFix systems. It is not shared with third parties for their own purposes.',
    ],
  },
  {
    h: 'How long we keep it',
    p: [
      'Location trails are kept while the job is live and for a limited period afterwards for dispute resolution and service-quality review. Account, KYC and payment records are kept for as long as you have an account, and afterwards where tax, regulatory or contractual rules require it. Job records are kept as business records for the customer relationship.',
    ],
  },
  {
    h: 'Your choices and rights',
    p: [
      '<strong>Location.</strong> Turn the permission off at any time in your device settings, or complete or cancel the job to stop sharing immediately.',
      '<strong>Notifications.</strong> Manage them in your device settings.',
      '<strong>Your profile.</strong> View and edit it in the app.',
      '<strong>Access, correction and deletion.</strong> Contact EasyFix support to ask for a copy of your data, to correct it, or to ask for it to be deleted. Some records must be retained where the law or a contract requires it, and we will tell you when that applies.',
      '<strong>Withdrawing consent.</strong> Declining or withdrawing location permission does not by itself end your engagement with EasyFix, but it will limit which jobs you can complete.',
    ],
  },
  {
    h: 'Security',
    p: [
      'Access to technician data is restricted to staff who need it. Data is transmitted over encrypted connections. Identity documents are stored in access-controlled storage and are not exposed publicly.',
    ],
  },
  {
    h: 'Children',
    p: ['The app is for working technicians and is not intended for anyone under 18.'],
  },
  {
    h: 'Changes to this policy',
    p: [
      'We update this page when the app’s data practices change, and update the date above. Material changes affecting location collection are also reflected in the in-app permission disclosure you see before sharing starts.',
    ],
  },
  {
    h: 'Contact',
    p: [
      'EasyFix is operated by Channelplay. For privacy questions, data access requests, or to withdraw consent, contact EasyFix support from the <strong>Profile</strong> screen in the app, or write to us at the address published on the EasyFix website.',
    ],
  },
];

const PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Privacy Policy · EasyFix Technician App</title>
<meta name="description" content="How the EasyFix Technician app collects and uses data, including location collected in the background.">
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px 16px 64px; background:#F4F6F7; color:#171B1F;
         font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;
         line-height:1.6; }
  main { max-width:760px; margin:0 auto; background:#fff; border-radius:16px;
         padding:32px 28px; box-shadow:0 2px 14px rgba(0,0,0,.07); }
  .brand { font-weight:700; font-size:13px; letter-spacing:.09em; color:#C42430;
           text-transform:uppercase; margin-bottom:10px; }
  h1 { font-size:28px; line-height:1.25; margin:0 0 6px; }
  .updated { color:#5C636B; font-size:14px; margin:0 0 28px; }
  h2 { font-size:19px; margin:32px 0 8px; padding-top:20px;
       border-top:1px solid #E4E7EA; }
  h2:first-of-type { border-top:0; padding-top:0; }
  h3 { font-size:16px; margin:22px 0 6px; color:#363B41; }
  p { margin:0 0 12px; }
  .callout { background:#FBF0F1; border-left:4px solid #C42430; border-radius:8px;
             padding:14px 16px; margin:14px 0 18px; }
  a { color:#2A6FBF; }
  @media (max-width:520px) { main { padding:24px 18px; } h1 { font-size:23px; } }
</style>
</head><body>
<main>
  <div class="brand">EasyFix</div>
  <h1>Technician App Privacy Policy</h1>
  <p class="updated">Last updated ${LAST_UPDATED}</p>
  ${SECTIONS.map(
    (s) =>
      `<h2${s.id ? ` id="${s.id}"` : ''}>${s.h}</h2>` +
      s.p.map((t) => (t.startsWith('<h3') || t.startsWith('<p') ? t : `<p>${t}</p>`)).join(''),
  ).join('\n  ')}
</main>
</body></html>`;

/*
 * Deliberately NOT noindex, unlike the other pages under /api/public/*. Those
 * are magic-link surfaces for one job and must stay out of search results; a
 * privacy policy is the opposite — it has to be findable, and a Play reviewer
 * following the listing URL must reach it without a token.
 *
 * Served from a module-level constant: the page has no inputs, so there is
 * nothing to escape and nothing to rebuild per request.
 */
router.get('/', (req, res) => {
  logger.info('Public privacy policy served · ip=' + req.ip);
  res.set('Cache-Control', 'public, max-age=3600');
  res.type('html').status(200).send(PAGE);
});

module.exports = router;
