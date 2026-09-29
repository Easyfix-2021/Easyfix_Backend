'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { readMigration } = require('./helpers/migration-file');

/*
 * 2026-09-29-ops-desk-jobs-menu.sql puts Ops Desk under Jobs in the sidebar.
 * The invariants: re-runnable, placed as a sibling of Manage Jobs (parent Jobs,
 * depth 2), and visible to exactly the roles that hold isJobAppRequestResolve
 * — derived in SQL, never a role id typed into the file.
 */

const raw = readMigration('2026-09-29-ops-desk-jobs-menu.sql');
const sql = raw.replace(/^\s*--.*$/gm, '');
const statements = sql.split(';').map((s) => s.trim()).filter(Boolean);
const one = (re) => {
  const hits = statements.filter((s) => re.test(s));
  assert.equal(hits.length, 1, `expected exactly one statement matching ${re}`);
  return hits[0];
};

const insert = one(/^INSERT INTO tbl_menu\b/i);
const grant = one(/^UPDATE tbl_role\b/i);
const allow = one(/^UPDATE easyfix_properties\b/i);

test('the tbl_menu insert is guarded by NOT EXISTS on its own url', () => {
  assert.match(insert, /WHERE NOT EXISTS \(SELECT 1 FROM \(SELECT url FROM tbl_menu\) g WHERE g\.url = 'opsDesk'\)/);
});

test('the leaf is a depth-2 sibling of Manage Jobs, under Jobs', () => {
  const cols = insert.match(/INSERT INTO tbl_menu \(([^)]+)\)/)[1].split(',').map((s) => s.trim());
  const vals = insert.match(/SELECT ('Ops Desk'.*?) FROM \(/)[1].split(',').map((s) => s.trim());
  const row = Object.fromEntries(cols.map((c, i) => [c, vals[i]]));
  // Parent, depth, sequence, icon and legacy action_name come from the Manage
  // Jobs row — Jobs' menu_id differs between QA and production.
  assert.equal(row.parent_menu, 's.parent_menu');
  assert.equal(row.menu_depth, 's.menu_depth');
  assert.equal(row.sequence, 's.sequence');
  assert.equal(row.action_name, 's.action_name');
  assert.match(insert, /FROM tbl_menu WHERE url = 'job' AND menu_name = 'Manage Jobs' LIMIT 1\) s/);
  assert.equal(row.url, "'opsDesk'");
  assert.equal(row.menu_status, '1');
  assert.equal(row.has_child, '0');
});

test('the sidebar grant is derived from the isJobAppRequestResolve holders, idempotently', () => {
  assert.match(grant, /WHERE EXISTS \(SELECT 1 FROM role_menu_action rma JOIN menu_action ma ON ma\.id = rma\.menu_action_id WHERE rma\.role_id = r\.role_id AND rma\.isDeleted = 0 AND ma\.action_name = 'isJobAppRequestResolve'\)/);
  assert.match(grant, /AND NOT FIND_IN_SET\(\(SELECT menu_id FROM tbl_menu WHERE url = 'opsDesk' LIMIT 1\)/);
});

test('no role id is hardcoded anywhere in the file', () => {
  assert.ok(!/role_id\s*(=|IN)\s*\(?\s*\d/i.test(sql), 'grants must follow the action, not a list of roles');
});

test('the allowlist is appended to, never created', () => {
  assert.match(allow, /WHERE p\.property_key = 'new\.crm\.visible\.menu\.ids' AND NOT FIND_IN_SET/);
  assert.ok(!/INSERT INTO easyfix_properties/i.test(sql));
});

test('the permission itself is not moved: no menu_action / role_menu_action write', () => {
  assert.ok(!/(INSERT INTO|UPDATE|DELETE FROM)\s+(menu_action|role_menu_action)\b/i.test(sql));
});
