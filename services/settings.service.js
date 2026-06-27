const { pool } = require('../db');
const logger = require('../logger');

/*
 * Per-client settings with global fallback — REALTIME reads (no cache).
 *
 *   tbl_autoallocation_setting — master list of settings
 *     (id, key, default_value, description, data_type)
 *   tbl_client_setting — per-client overrides keyed by setting_id
 *     (client_id, setting_id, value, deleted)
 *
 * Flow on a getClientSetting(clientId, key) call:
 *   1. Look up the setting row by `key` in tbl_autoallocation_setting
 *   2. If clientId given, check tbl_client_setting for an override
 *   3. Fall back to default_value
 *   4. Coerce the string value to its declared data_type
 *
 * We deliberately DON'T cache the result: ops staff flip these flags
 * interactively (e.g. toggle a client from batch → instant), and a 5-min
 * cache window would mean the first jobs created after the toggle silently
 * miss the new rule. Two indexed SELECTs per job-create is acceptable cost
 * for predictable behaviour.
 */

function coerce(raw, dataType) {
  if (raw == null || raw === '') return null;
  switch (dataType) {
    case 'integer': { const n = parseInt(raw, 10); return Number.isFinite(n) ? n : null; }
    case 'double':  { const n = parseFloat(raw);   return Number.isFinite(n) ? n : null; }
    case 'bool':
      // Legacy data uses both 'Yes'/'No' strings and '1'/'0' — handle both.
      return ['true', '1', 'yes', 'y'].includes(String(raw).trim().toLowerCase());
    case 'json':    try { return JSON.parse(raw); } catch { return null; }
    case 'time':    return String(raw);  // "HH:MM:SS"
    case 'string':
    default:        return String(raw);
  }
}

async function getClientSetting(clientId, key) {
  logger.info('Resolving client setting · key=' + key + ' · clientId=' + (clientId || 'global'));
  const [[meta]] = await pool.query(
    'SELECT id, `key`, default_value, data_type FROM tbl_autoallocation_setting WHERE `key` = ? LIMIT 1',
    [key]
  );
  if (!meta) {
    logger.warn('No setting defined for key=' + key);
    return null;
  }

  let raw = meta.default_value;
  if (clientId) {
    const [[override]] = await pool.query(
      `SELECT value FROM tbl_client_setting
        WHERE client_id = ? AND setting_id = ? AND deleted = 0
        LIMIT 1`,
      [clientId, meta.id]
    );
    if (override && override.value != null) raw = override.value;
  }
  return coerce(raw, meta.data_type);
}

/*
 * Returns the full effective settings map for a client — every key from
 * tbl_autoallocation_setting with its resolved value (client override or
 * default). Used by the Settings UI to render all knobs at once.
 */
async function getAllForClient(clientId) {
  logger.info('Loading all settings for client · clientId=' + (clientId || 'global'));
  const [rows] = await pool.query(
    'SELECT id, `key`, default_value, description, data_type FROM tbl_autoallocation_setting ORDER BY id'
  );
  logger.info('Found ' + rows.length + ' settings');
  const [overrides] = clientId
    ? await pool.query(
        `SELECT setting_id, value FROM tbl_client_setting
          WHERE client_id = ? AND deleted = 0`,
        [clientId])
    : [[]];
  const overrideById = new Map(overrides.map((o) => [o.setting_id, o.value]));
  logger.info('Returning ' + rows.length + ' settings · ' + overrideById.size + ' overridden');

  return rows.map((r) => {
    const hasOverride = overrideById.has(r.id);
    const raw = hasOverride ? overrideById.get(r.id) : r.default_value;
    return {
      id: r.id,
      key: r.key,
      description: r.description,
      data_type: r.data_type,
      default_value: r.default_value,
      effective_value: coerce(raw, r.data_type),
      is_overridden: hasOverride,
    };
  });
}

// No-op shim kept for callers that used to bust the cache after a write.
// Safe to delete once no caller references it.
function invalidate() { /* realtime — nothing to do */ }

module.exports = { getClientSetting, getAllForClient, invalidate };
