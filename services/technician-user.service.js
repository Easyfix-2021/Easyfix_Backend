/*
 * Canonical tbl_user writer for technician onboarding and legacy-link repair.
 *
 * Keep this INSERT in one place: both a genuinely new technician and an
 * existing tbl_easyfixer row whose legacy user link is absent need the same
 * role-19, un-vetted user shape. The caller owns the surrounding transaction
 * and per-mobile lock so this helper never acquires a connection by itself.
 */

const TECH_ROLE_ID = 19;

function invalidMobileError() {
  const err = new Error('technician mobile is not valid for user-profile creation');
  err.status = 409;
  return err;
}

/**
 * Create the canonical un-vetted technician user row on a caller-owned runner.
 *
 * @param {string} mobile Verified ten-digit technician mobile number.
 * @param {object} runner mysql2 pool connection participating in the caller TXN.
 * @returns {Promise<number>} Newly-created tbl_user.user_id.
 */
async function createCanonicalTechnicianUser(mobile, runner) {
  const normalizedMobile = String(mobile ?? '').trim();
  if (!/^\d{10}$/.test(normalizedMobile)) throw invalidMobileError();
  if (!runner || typeof runner.query !== 'function') {
    throw new TypeError('a database runner is required');
  }

  const [result] = await runner.query(
    `INSERT INTO tbl_user
       (mobile_no, user_role, is_personal_detail_filled, user_status, insert_date)
     VALUES (?, ?, 0, 0, NOW())`,
    [normalizedMobile, TECH_ROLE_ID],
  );
  const userId = Number(result?.insertId);
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error('technician user-profile creation returned no user id');
  }
  return userId;
}

module.exports = { TECH_ROLE_ID, createCanonicalTechnicianUser };
