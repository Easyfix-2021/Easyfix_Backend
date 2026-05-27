---
name: api-scaffold
description: "Scaffolds a new HRMS API route with proper patterns — auth, validation, error handling, screen access. Use for 'new API', 'create endpoint', 'add route'."
allowed-tools: Read, Write, Edit, Grep, Glob
---

Create a new API route module for HRMS following established patterns.

## Input
$ARGUMENTS should describe the new API module (e.g., "training management", "employee documents").

## Steps

1. **Create route file**: `server/api/<module-name>.js`
2. **Follow the standard pattern**:

```javascript
const express = require('express');
const router = express.Router();
const pool = require('../db');
const { checkScreenAccess } = require('../screenAccessMiddleware');

// GET /api/<module> - List all
router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, name, ... FROM table_name WHERE active = 1 ORDER BY created_at DESC',
    );
    res.json({ success: true, data: rows });
  } catch (error) {
    console.error('Error fetching <module>:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch <module>' });
  }
});

// GET /api/<module>/:id - Get by ID
router.get('/:id', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, name, ... FROM table_name WHERE id = ?',
      [req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: '<Module> not found' });
    }
    res.json({ success: true, data: rows[0] });
  } catch (error) {
    console.error('Error fetching <module>:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch <module>' });
  }
});

// POST /api/<module> - Create
router.post('/', checkScreenAccess('SCREEN_ID', 'ACTION_ID'), async (req, res) => {
  try {
    const { field1, field2 } = req.body;
    if (!field1) {
      return res.status(400).json({ success: false, error: 'field1 is required' });
    }
    const [result] = await pool.query(
      'INSERT INTO table_name (field1, field2) VALUES (?, ?)',
      [field1, field2]
    );
    res.json({ success: true, data: { id: result.insertId } });
  } catch (error) {
    console.error('Error creating <module>:', error);
    res.status(500).json({ success: false, error: 'Failed to create <module>' });
  }
});

module.exports = router;
```

3. **Register in `server/api/index.js`**: Add the new router
4. **Add screen access**: If needed, define screen/actions in `shared/screens.js`
5. **Create migration**: If new tables needed, add `server/migrations/XXX_<description>.sql`
6. **Update CLAUDE.md**: Add the new module to the architecture section
