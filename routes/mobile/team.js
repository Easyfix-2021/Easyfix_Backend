const router = require('express').Router();

const { modernOk } = require('../../utils/response');
const team = require('../../services/mobile-team.service');

/*
 * /api/mobile/team — the authed technician's downline ("My Team").
 *
 * Auth: requireTechAuth is applied UPSTREAM in routes/mobile/index.js before
 * this router is mounted, so req.tech.efr_id is populated. The legacy {id} path
 * param is DROPPED — the master is always req.tech.efr_id, so a tech can only
 * see their own downline. `membershipType` is accepted for legacy compatibility
 * but not required (the downline is derived from efr_manager_id).
 *
 * Response: modern { success, data: { items, total } } — the app's extractList
 * reads the array from `items`.
 */
router.get('/', async (req, res, next) => {
  try {
    const members = await team.getMyTeam(req.tech.efr_id);
    modernOk(res, { items: members, total: members.length });
  } catch (e) { next(e); }
});

module.exports = router;
