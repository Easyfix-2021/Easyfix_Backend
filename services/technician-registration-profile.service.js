const { pool } = require('../db');
const logger = require('../logger');
const { createCanonicalTechnicianUser } = require('./technician-user.service');

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function optionalText(value) {
  const text = value == null ? '' : String(value).trim();
  return text || null;
}

/*
 * Registration pincode resolver shared by:
 *   - the unauthenticated login form;
 *   - the authenticated registration/profile forms; and
 *   - the post-OTP persistence path below.
 *
 * This intentionally does ONE indexed lookup (tbl_pincode.pincode is UNIQUE)
 * plus PK joins to city/state. Do not delegate to pincode.service's CRM detail
 * method here: that method also computes technician and zone counts, which are
 * unrelated to registration and make this pre-login hot path several queries.
 */
async function resolvePincode(pincode, runner = pool) {
  const pin = optionalText(pincode);
  if (!pin || !/^\d{6}$/.test(pin)) {
    throw httpError(400, 'pincode must be exactly 6 digits');
  }

  const [[row]] = await runner.query(
    `SELECT p.pincode,
            p.city_id,
            c.city_name,
            COALESCE(NULLIF(TRIM(p.district), ''), NULLIF(TRIM(c.district), '')) AS district,
            s.state_name
       FROM tbl_pincode p
       LEFT JOIN tbl_city c ON c.city_id = p.city_id
       LEFT JOIN tbl_state s ON s.state_id = c.state_id
      WHERE p.pincode = ?
      LIMIT 1`,
    [pin],
  );

  if (!row) return null;
  return {
    pincode: String(row.pincode),
    cityId: row.city_id == null ? null : Number(row.city_id),
    city: row.city_name || null,
    district: row.district || null,
    state: row.state_name || null,
  };
}

/*
 * Persist metadata collected on the login screen only after the OTP has been
 * proven. The caller installs this as tech-auth's pre-consume hook: if any
 * write fails the transaction rolls back AND the OTP remains reusable.
 *
 * Home pincode is WRITE-ONCE, matching persistPersonalDetails: the first PIN a
 * technician gives becomes their home, and a later verify never relocates them.
 * When it is written, both legacy representations move together in one
 * transaction. Re-sending the SAME pincode is still a write, so a half-enriched
 * row (pincode set, efr_cityId 0) can still be backfilled. Referral is first-touch/immutable: the
 * additive side table's PK plus the no-op duplicate clause makes concurrent
 * verifies idempotent without ever overwriting the original answer.
 */
async function persistVerifiedProfile(efrId, fields = {}, database = pool) {
  const id = Number(efrId);
  if (!Number.isInteger(id) || id <= 0) {
    throw httpError(400, 'valid technician id is required');
  }

  const homePincode = optionalText(fields.homePincode);
  const referralSource = optionalText(fields.referralSource);
  const language = optionalText(fields.language);

  if (homePincode && !/^\d{6}$/.test(homePincode)) {
    throw httpError(400, 'homePincode must be exactly 6 digits');
  }
  if (referralSource && referralSource.length > 255) {
    throw httpError(400, 'referralSource must not exceed 255 characters');
  }
  if (language && language.length > 50) {
    throw httpError(400, 'language must not exceed 50 characters');
  }
  if (!homePincode && !referralSource && !language) {
    return { location: null, language: null };
  }

  // A caller already holding a pinned MySQL named-lock connection can pass it
  // directly. Otherwise acquire/release our own connection as usual.
  const ownsConnection = typeof database.getConnection === 'function';
  const conn = ownsConnection ? await database.getConnection() : database;
  try {
    await conn.beginTransaction();

    // Resolve before taking the technician row lock to keep its hold time tiny.
    const location = homePincode
      ? await resolvePincode(homePincode, conn)
      : null;
    if (homePincode && !location) {
      throw httpError(422, 'home pincode is not available in the pincode directory');
    }
    if (location && (!location.cityId || !location.city || !location.state)) {
      throw httpError(422, 'home pincode has no complete city and state mapping');
    }

    /* efr_pin_no is read here rather than in a second query: this is already a
     * locking read of the row we are about to update, so the stored home cannot
     * change between the check and the write. */
    const [[identity]] = await conn.query(
      `SELECT e.efr_no, e.user_id, e.efr_pin_no, u.user_id AS linked_user_id
         FROM tbl_easyfixer e
         LEFT JOIN tbl_user u ON u.user_id = e.user_id
        WHERE e.efr_id = ?
        LIMIT 1
        FOR UPDATE`,
      [id],
    );
    if (!identity) throw httpError(404, 'technician not found');

    if (location) {
      let linkedUserId = Number(identity.linked_user_id);
      if (!Number.isInteger(linkedUserId) || linkedUserId <= 0) {
        // 3,414 legacy identities in the measured database have a valid
        // tbl_easyfixer mobile but no tbl_user link. Repair only AFTER OTP proof,
        // on this row-locked transaction, so a mandatory Home PIN cannot strand
        // them and no unauthenticated request can mint users.
        linkedUserId = await createCanonicalTechnicianUser(identity.efr_no, conn);
        const [linked] = await conn.query(
          `UPDATE tbl_easyfixer
              SET user_id = ?, update_date = ?
            WHERE efr_id = ? AND user_id <=> ?`,
          [linkedUserId, new Date(), id, identity.user_id ?? null],
        );
        if (Number(linked.affectedRows) !== 1) {
          throw httpError(409, 'technician user profile changed during verification');
        }
        logger.info({ efrId: id, userId: linkedUserId }, 'Repaired missing technician user profile link');
      }
      /*
       * WRITE-ONCE. A technician who already has a home pincode keeps it — this
       * hook runs on every verify-otp, so without the guard any later
       * verification carrying a different PIN silently relocated them, which is
       * the same defect persistPersonalDetails carried until 2026-09-07. The
       * serviceable list is not touched here at all, so skipping is safe: it
       * cannot leave home and list disagreeing.
       */
      const storedHome = String(identity.efr_pin_no ?? '').trim();
      if (storedHome && storedHome !== location.pincode) {
        logger.warn(
          { efrId: id, storedHome, submitted: location.pincode },
          'Kept the stored home pincode; verify-otp does not relocate a technician',
        );
      } else {
        await conn.query(
          'UPDATE tbl_easyfixer SET efr_pin_no = ?, efr_cityId = ? WHERE efr_id = ?',
          [location.pincode, location.cityId, id],
        );
        await conn.query(
          'UPDATE tbl_user SET pin_code = ?, city = ?, state = ? WHERE user_id = ?',
          [location.pincode, location.city, location.state, linkedUserId],
        );
      }
    }

    if (referralSource) {
      await conn.query(
        `INSERT INTO tbl_easyfixer_registration_attribution
           (efr_id, referral_source, captured_at)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE referral_source = referral_source`,
        [id, referralSource, new Date()],
      );
    }

    if (language) {
      // Lazy import keeps the public pincode-only route from loading the full
      // onboarding service graph, while still using its canonical writer.
      // eslint-disable-next-line global-require
      const { setLanguage } = require('./mobile-registration.service');
      await setLanguage(id, language, conn);
    }

    await conn.commit();
    logger.info({ efrId: id, hasPincode: Boolean(location), hasReferral: Boolean(referralSource), hasLanguage: Boolean(language) },
      'Verified registration profile persisted');
    return { location, language };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    if (ownsConnection) conn.release();
  }
}

module.exports = { resolvePincode, persistVerifiedProfile };
