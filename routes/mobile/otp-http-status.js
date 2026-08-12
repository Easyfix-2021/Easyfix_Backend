/* Map service-level technician OTP outcomes to stable HTTP semantics. */

const STATUS_BY_REASON = Object.freeze({
  OTP_EXPIRED: 410,
  OTP_ALREADY_USED: 409,
  OTP_VERIFICATION_BUSY: 409,
  ONBOARDING_FAILED: 503,
});

function otpFailureHttpStatus(reason) {
  return STATUS_BY_REASON[reason] ?? 401;
}

module.exports = { otpFailureHttpStatus };
