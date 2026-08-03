/*
 * /api/public/shared-job/* — technician "share job" public link surface.
 *
 * UNAUTHENTICATED (mounted ahead of requireAuth). The `:token` path segment is
 * the sole authority: verifyJobShareToken() extracts the jobId, which pins all
 * SQL — a token can only reach the job it was minted for. Liveness (reject
 * finished/cancelled) is enforced in job-share.service, not a status-9 gate.
 *
 * Endpoints:
 *   GET  /:token                       → non-confidential job details
 *   POST /:token/customer-call/preview → masked from(visitor)→to(customer) chip
 *   POST /:token/customer-call         → bridge visitor ⇄ customer, masked
 *
 * The call is a fork of job-completion's spoc-call with the RECEIVER leg swapped
 * SPOC→customer and the CALLER leg = the number the visitor typed (a public
 * visitor has no number on file, and Plivo can't ring a numberless browser).
 * The customer's real number never leaves the server. Shared rate-limit / cap /
 * audit helpers come from ./_public-call.
 */

const router = require('express').Router();
const Joi = require('joi');

const { pool } = require('../../db');
const { verifyJobShareToken } = require('../../utils/jwt');
const shareService = require('../../services/job-share.service');
const voice = require('../../services/voice.service');
const { modernOk, modernError } = require('../../utils/response');
const logger = require('../../logger');
const {
  CALL_FAILED_PUBLIC_MSG,
  makePeekToken,
  tokenRateLimit,
  callRateLimit,
  mapKnownError,
  dailyBridgeCapReached,
  persistBridgeCall,
} = require('./_public-call');

// Peek key derivation uses the share-token verifier (not job_completion's).
const peekToken = makePeekToken(verifyJobShareToken);

// Per-endpoint cryptographic check. Liveness lives in the service layer.
function verify(req) {
  const { jobId } = verifyJobShareToken(req.params.token);
  return jobId;
}

const callerBody = Joi.object({
  caller_mobile: Joi.string().trim().pattern(/^\d{10}$/).required(),
}).required();

// ─── GET /:token — non-confidential job details for the shared page ──
router.get('/:token', peekToken, tokenRateLimit, async (req, res, next) => {
  try {
    const jobId = verify(req);
    logger.info('Fetch shared-job details · jobId=' + jobId);
    const details = await shareService.fetchShareDetails(jobId, pool); // throws 404/410
    return modernOk(res, details);
  } catch (e) {
    return mapKnownError(res, next, e);
  }
});

// ─── POST /:token/customer-call/preview — masked from(visitor)→to(customer) ──
router.post('/:token/customer-call/preview', peekToken, callRateLimit, async (req, res, next) => {
  try {
    const jobId = verify(req);
    const { error, value } = callerBody.validate(req.body || {});
    if (error) return modernError(res, 400, 'Enter a valid 10-digit mobile number');

    await shareService.fetchShareDetails(jobId, pool); // liveness (404/410)
    const customer = await shareService.resolveCustomerForCall(jobId, pool);
    if (!customer || !customer.mobile) {
      return modernError(res, 422, 'No customer number on file to connect the call');
    }
    const preview = await voice.previewCallLegs({
      provider: 'plivo',
      from: value.caller_mobile,
      to: customer.mobile,
      alwaysApplyEnvOverride: true,
    });
    return modernOk(res, preview);
  } catch (e) {
    return mapKnownError(res, next, e);
  }
});

// ─── POST /:token/customer-call — bridge visitor ⇄ customer, masked ──
router.post('/:token/customer-call', peekToken, callRateLimit, async (req, res, next) => {
  try {
    const jobId = verify(req);
    const { error, value } = callerBody.validate(req.body || {});
    if (error) return modernError(res, 400, 'Enter a valid 10-digit mobile number');

    await shareService.fetchShareDetails(jobId, pool); // liveness (410 on finished/cancelled)

    if (await dailyBridgeCapReached(jobId)) {
      return modernError(res, 429, 'Call limit reached for this job today. Please try again later.');
    }

    const customer = await shareService.resolveCustomerForCall(jobId, pool);
    if (!customer || !customer.mobile) {
      return modernError(res, 422, 'No customer number on file to connect the call');
    }

    logger.info('Place shared-job customer bridge call · jobId=' + jobId);
    // Caller leg = visitor's typed number; receiver leg = customer (real number
    // resolved server-side, never returned). alwaysApplyEnvOverride so QA never
    // dials a real customer (PLIVO_CALL_FROM/TO redirect applies in non-prod).
    const result = await voice.clickToCall({
      provider: 'plivo',
      from: value.caller_mobile,
      to: customer.mobile,
      alwaysApplyEnvOverride: true,
    });

    const audit = {
      jobId,
      callId: result.callId,
      fromMob: value.caller_mobile,
      fromName: 'Shared link visitor',
      toMob: customer.mobile,
      toId: null,
      toName: customer.name || 'Customer',
      jobStatus: customer.job_status,
      jobEfrId: customer.fk_easyfixter_id,
      provider: result.provider,
    };

    if (!result.delivered && (result.suppressed || result.disabled)) {
      // Calling disabled in this environment — 200 with delivered:false so the
      // FE shows "would have called" feedback. Still audit the intent.
      await persistBridgeCall(audit);
      return modernOk(res, { delivered: false, suppressed: true });
    }
    if (!result.delivered) {
      logger.warn(
        { jobId, diagnostic: result.diagnostic, err: result.error, providerError: result.providerError, providerStatus: result.providerStatus },
        'job-share: customer bridge call failed',
      );
      return modernError(res, 502, CALL_FAILED_PUBLIC_MSG);
    }
    await persistBridgeCall(audit);
    logger.info({ jobId }, 'job-share: customer bridge call placed');
    return modernOk(res, { delivered: true });
  } catch (e) {
    return mapKnownError(res, next, e);
  }
});

module.exports = router;
