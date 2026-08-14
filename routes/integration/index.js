/*
 * Integration routes — replicate the legacy Dropwizard :8090 contract.
 * Mount point here: /api/integration
 * Public URL (via Nginx rewrite):  https://core.easyfix.in/v1/*
 *
 * Contract invariants (MUST NOT drift):
 *   - HTTP Basic Auth (NOT JWT). Credentials sourced from tbl_client_website / ClientLogin.
 *   - Response body shape: { status: "200" (STRING), message, data }
 *   - Date format: "DD-MM-YYYY HH:mm" (IST), never ISO-8601.
 *   - currentStatus is a human label ("Unconfirmed"), NOT the numeric code from tbl_job.
 *   - Multipart upload field names: `file`, `JobId` (capital J, capital I).
 *   - Endpoints to replicate: /v1/services, /v1/jobs/, /v1/jobs/jobStatus,
 *                             /v1/jobImage/addJobImages, /v1/cities
 *
 * Any change to the response body is a breaking change for external clients
 * (e.g. Decathlon). Run the shadow-traffic diff harness before touching these.
 */

const router = require('express').Router();
const { legacyOk } = require('../../utils/response');

// Public health check (no auth) — canary for legacy shape
router.get('/_ping', (_req, res) => {
  legacyOk(res, { ping: 'pong' });
});

/*
 * GET /api/integration/docs — the partner integration guide.
 *
 * Deliberately UNAUTHENTICATED. It is a specification, not data: it contains
 * no credentials, no customer records and nothing partner-specific, and the
 * people who most need it — a client's developer, mid-integration — are
 * exactly the ones who do not yet have working credentials to read it with.
 * Requiring Basic Auth to read the document that explains Basic Auth is a
 * loop nobody escapes without a support ticket.
 *
 * Served from the repo file so the published guide and the code ship together
 * and can never drift: a contract change and its documentation land in one
 * commit or neither.
 */
const DOC_PATH = require('path').join(__dirname, '../../docs/CLIENT_API_INTEGRATION.html');
router.get('/docs', (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.sendFile(DOC_PATH, (err) => {
    if (err) {
      require('../../logger').error('Integration docs unavailable · ' + err.message);
      if (!res.headersSent) res.status(404).type('text/plain').send('Documentation not available');
    }
  });
});

// /api/integration/v1/* — HTTP Basic Auth, Dropwizard-contract replacement
router.use('/v1', require('./v1'));

module.exports = router;
