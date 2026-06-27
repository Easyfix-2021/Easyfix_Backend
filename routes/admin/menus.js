const router = require('express').Router();
const Joi = require('joi');
const { pool } = require('../../db');
const validate = require('../../middleware/validate');
const { roleByName } = require('../../middleware/role');
const { modernOk, modernError } = require('../../utils/response');
const logger = require('../../logger');

/*
 * Admin CRUD over `tbl_menu` — drives the sidebar tree.
 *
 * Legacy `MenuAction.java` exposed manageMenu/addEditMenu but the CRM rarely
 * exercised it (menus are typically seeded once per environment). This route
 * gives ops a way to add/edit a menu row without going to the DB directly.
 *
 * Column shape (verified in services/lookup.service.js::menus):
 *   menu_id (PK), menu_name, parent_menu (0 = root), menu_depth, has_child,
 *   url, icons, sequence, menu_status (1/0)
 */

const idParam = Joi.object({ id: Joi.number().integer().positive().required() });

const createBody = Joi.object({
  menu_name:   Joi.string().trim().min(1).max(200).required(),
  parent_menu: Joi.number().integer().min(0).default(0),
  menu_depth:  Joi.number().integer().min(1).max(5).default(1),
  has_child:   Joi.number().integer().valid(0, 1).default(0),
  url:         Joi.string().trim().max(255).allow('', null).optional(),
  icons:       Joi.string().trim().max(100).allow('', null).optional(),
  sequence:    Joi.number().integer().min(0).optional(),
});

const updateBody = Joi.object({
  menu_name:   Joi.string().trim().min(1).max(200).optional(),
  parent_menu: Joi.number().integer().min(0).optional(),
  menu_depth:  Joi.number().integer().min(1).max(5).optional(),
  has_child:   Joi.number().integer().valid(0, 1).optional(),
  url:         Joi.string().trim().max(255).allow('', null).optional(),
  icons:       Joi.string().trim().max(100).allow('', null).optional(),
  sequence:    Joi.number().integer().min(0).optional(),
  menu_status: Joi.number().integer().valid(0, 1).optional(),
}).min(1);

router.get('/', async (_req, res, next) => {
  try {
    logger.info('Listing menu tree');
    const [rows] = await pool.query(
      `SELECT menu_id, menu_name, parent_menu, menu_depth, has_child, url, icons, sequence, menu_status
         FROM tbl_menu
        ORDER BY COALESCE(sequence, 999) ASC, menu_id ASC`
    );
    logger.info('Found ' + rows.length + ' menus');
    modernOk(res, rows);
  } catch (e) { next(e); }
});

router.post('/', roleByName(['Admin']), validate(createBody), async (req, res, next) => {
  try {
    const b = req.body;
    logger.info('Creating menu · name=' + b.menu_name + ' parent=' + b.parent_menu);
    const [ins] = await pool.query(
      `INSERT INTO tbl_menu (menu_name, parent_menu, menu_depth, has_child, url, icons, sequence, menu_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      [b.menu_name, b.parent_menu, b.menu_depth, b.has_child, b.url || null, b.icons || null, b.sequence ?? null]
    );
    logger.info('Menu created · id=' + ins.insertId);
    res.status(201);
    modernOk(res, { menu_id: ins.insertId }, 'Menu added');
  } catch (e) { next(e); }
});

router.patch('/:id', roleByName(['Admin']), validate(idParam, 'params'), validate(updateBody), async (req, res, next) => {
  try {
    logger.info('Updating menu · id=' + req.params.id + ' fields=' + Object.keys(req.body).join(','));
    const sets = [];
    const params = [];
    for (const [k, v] of Object.entries(req.body)) {
      sets.push(`${k} = ?`);
      params.push(v === '' ? null : v);
    }
    params.push(req.params.id);
    const [r] = await pool.query(`UPDATE tbl_menu SET ${sets.join(', ')} WHERE menu_id = ?`, params);
    if (r.affectedRows === 0) return modernError(res, 404, 'Menu not found');
    logger.info('Menu updated · id=' + req.params.id);
    modernOk(res, { updated: true });
  } catch (e) { next(e); }
});

router.delete('/:id', roleByName(['Admin']), validate(idParam, 'params'), async (req, res, next) => {
  try {
    logger.info('Deactivating menu · id=' + req.params.id);
    // Soft-delete via menu_status=0 (legacy convention; sidebar filters
    // status=1 only). Avoids breaking role.menu_ids CSV references.
    const [r] = await pool.query('UPDATE tbl_menu SET menu_status = 0 WHERE menu_id = ?', [req.params.id]);
    if (r.affectedRows === 0) return modernError(res, 404, 'Menu not found');
    logger.info('Menu deactivated · id=' + req.params.id);
    modernOk(res, { deactivated: true });
  } catch (e) { next(e); }
});

module.exports = router;
