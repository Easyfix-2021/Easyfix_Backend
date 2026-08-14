/*
 * Characterization tests for the four externally-documented /v1 endpoints —
 * the contract Decathlon and friends actually integrate against.
 *
 * These pin the SHAPE, not the plumbing. Every assertion here corresponds to
 * something a client parses out of the body, so a failure means an integrator
 * breaks, not merely that an internal detail moved.
 *
 * Reference: EasyFix_API ClientServicesDAO.java:76-142, ServicesResource.java:81-100,
 * EasyfixAPIUtils.java:459-473 (payment-collected-by enum).
 */

const test = require('node:test');
const assert = require('node:assert');
const { makeFakePool } = require('./helpers/fake-pool');

const {
  clientServiceCatalog,
  catalogShapeForRole,
  CATALOG_SHAPES,
  resolveCityId,
  paymentCollectedByCode,
  PAYMENT_COLLECTED_BY,
} = require('../services/integration.service');

// One client, two categories, three service types, four priced services.
const CATALOG_ROWS = [
  { client_service_id: 24055, service_type_id: 7, service_catg_id: 21,
    charge_type: 1, total_amount: 500,
    service_type_name: 'Estimate On VISIT', service_type_tool_names: 'Spanner,Drill',
    service_catg_name: 'Cycle & Fitness Machine Services', service_catg_desc: 'Gym Equipment Expert.',
    crc_ratecard_name: 'Failed Visit Charges' },
  { client_service_id: 24056, service_type_id: 7, service_catg_id: 21,
    charge_type: 1, total_amount: 50,
    service_type_name: 'Estimate On VISIT', service_type_tool_names: 'Spanner,Drill',
    service_catg_name: 'Cycle & Fitness Machine Services', service_catg_desc: 'Gym Equipment Expert.',
    crc_ratecard_name: 'Incentive' },
  { client_service_id: 24057, service_type_id: 9, service_catg_id: 21,
    charge_type: 2, total_amount: 50,
    service_type_name: 'Fixed Price', service_type_tool_names: null,
    service_catg_name: 'Cycle & Fitness Machine Services', service_catg_desc: 'Gym Equipment Expert.',
    crc_ratecard_name: 'Travel allowance' },
  { client_service_id: 30001, service_type_id: 12, service_catg_id: 30,
    charge_type: 1, total_amount: 1200,
    service_type_name: 'Installation', service_type_tool_names: null,
    service_catg_name: 'Water Purifier', service_catg_desc: 'RO & UV.',
    crc_ratecard_name: 'RO Installation' },
];

function catalogPool(rows = CATALOG_ROWS) {
  return makeFakePool([[/FROM tbl_client_service/i, rows]]);
}

test('service catalogue nests category → service_type → services', async () => {
  const fake = catalogPool();
  const data = await clientServiceCatalog(fake.pool, { clientId: 213 });

  assert.equal(data.length, 2, 'two categories');
  const gym = data[0];
  assert.equal(gym.service_catg_id, 21);
  assert.equal(gym.service_catg_name, 'Cycle & Fitness Machine Services');
  assert.equal(gym.service_catg_desc, 'Gym Equipment Expert.');
  assert.equal(gym.category_services.length, 2, 'two distinct service types in the category');

  // Each category_services element is exactly { service_type: {...} }
  assert.deepEqual(Object.keys(gym.category_services[0]), ['service_type']);
});

test('two services under one type collapse into ONE service_type entry', async () => {
  const data = await clientServiceCatalog(catalogPool().pool, { clientId: 213 });
  const type7 = data[0].category_services[0].service_type;
  assert.equal(type7.service_type_id, 7);
  assert.equal(type7.services.length, 2, 'both rows land in the same services[] bag');
  assert.deepEqual(type7.services.map((s) => s.service_id), [24055, 24056]);
});

test('service fields map to the documented names', async () => {
  const data = await clientServiceCatalog(catalogPool().pool, { clientId: 213 });
  const first = data[0].category_services[0].service_type.services[0];
  assert.deepEqual(Object.keys(first), ['service_id', 'service_name', 'service_amount', 'job_charge_type']);
  // service_name is the RATE CARD name, not the service-type name — a real
  // trap, since the type here is called "Estimate On VISIT".
  assert.equal(first.service_name, 'Failed Visit Charges');
  assert.equal(first.service_id, 24055, 'service_id is client_service_id');
  assert.equal(first.service_amount, 500);
  assert.equal(first.job_charge_type, 1);
});

test('serviceTypeToolNames is omitted when NULL, present when set', async () => {
  const data = await clientServiceCatalog(catalogPool().pool, { clientId: 213 });
  const withTools = data[0].category_services[0].service_type;
  const withoutTools = data[0].category_services[1].service_type;
  assert.equal(withTools.serviceTypeToolNames, 'Spanner,Drill');
  assert.ok(!('serviceTypeToolNames' in withoutTools), 'NULL tool names drop the key entirely (legacy Jackson NON_NULL)');
});

test('catalogue is scoped to the caller and to active services only', async () => {
  const fake = catalogPool();
  await clientServiceCatalog(fake.pool, { clientId: 213 });
  const { sql, params } = fake.calls[0];
  assert.match(sql, /cs\.client_id = \?/, 'client-scoped');
  assert.match(sql, /cs\.service_status = 1/, 'active services only');
  assert.match(sql, /LIMIT 100/, 'legacy setMaxResults(100) preserved');
  assert.deepEqual(params, [213]);
});

test('serviceTypeId filter is applied only when positive', async () => {
  const withFilter = catalogPool();
  await clientServiceCatalog(withFilter.pool, { clientId: 213, serviceTypeId: 7 });
  assert.match(withFilter.calls[0].sql, /cs\.service_type_id = \?/);
  assert.deepEqual(withFilter.calls[0].params, [213, 7]);

  for (const ignored of [undefined, null, '', 0, '0', 'abc']) {
    const fake = catalogPool();
    await clientServiceCatalog(fake.pool, { clientId: 213, serviceTypeId: ignored });
    assert.ok(!/cs\.service_type_id = \?/.test(fake.calls[0].sql), `serviceTypeId=${JSON.stringify(ignored)} must not filter`);
  }
});

test('a client with no purchased services gets an empty array, not an error', async () => {
  const data = await clientServiceCatalog(catalogPool([]).pool, { clientId: 999 });
  assert.deepEqual(data, []);
});

test('category ordering is stable across identical calls', async () => {
  const a = await clientServiceCatalog(catalogPool().pool, { clientId: 213 });
  const b = await clientServiceCatalog(catalogPool().pool, { clientId: 213 });
  assert.deepEqual(a.map((c) => c.service_catg_id), b.map((c) => c.service_catg_id));
  // Legacy grouped with a HashMap, so identical calls could return categories
  // in different orders. The ORDER BY is what makes that reproducible.
  const fake = catalogPool();
  await clientServiceCatalog(fake.pool, { clientId: 213 });
  assert.match(fake.calls[0].sql, /ORDER BY cs\.service_catg_id ASC/);
});

// ─── role → shape (legacy served TWO shapes from this one endpoint) ──

test('only the website role gets the nested category tree', () => {
  assert.equal(catalogShapeForRole('website'), CATALOG_SHAPES.TREE);
  assert.equal(catalogShapeForRole('WebSite'), CATALOG_SHAPES.TREE, 'case-insensitive');
  assert.equal(catalogShapeForRole('client'), CATALOG_SHAPES.FLAT);
  assert.equal(catalogShapeForRole('androidApp'), CATALOG_SHAPES.FLAT);
  assert.equal(catalogShapeForRole('crm'), CATALOG_SHAPES.FLAT);
});

test('an unresolved role falls back to the DOCUMENTED (tree) shape', () => {
  // The legacy role tables are separate from our credential table, so the
  // role can genuinely be unknown. Defaulting to flat would silently break a
  // partner who only ever had the published document to build against.
  for (const unknown of [null, undefined, '', '   ']) {
    assert.equal(catalogShapeForRole(unknown), CATALOG_SHAPES.TREE, `role=${JSON.stringify(unknown)}`);
  }
});

test('flat shape drops the category wrapper and nothing else', async () => {
  const tree = await clientServiceCatalog(catalogPool().pool, { clientId: 213, shape: CATALOG_SHAPES.TREE });
  const flat = await clientServiceCatalog(catalogPool().pool, { clientId: 213, shape: CATALOG_SHAPES.FLAT });

  // Every service_type entry survives, across ALL categories.
  const treeTypes = tree.flatMap((c) => c.category_services);
  assert.equal(flat.length, treeTypes.length);
  assert.equal(flat.length, 3, 'two types in category 21 + one in category 30');

  // Each element is still exactly { service_type: {...} } — byte-identical to
  // the tree's inner object, so a partner reading service_type.services is
  // unaffected by which branch it got.
  assert.deepEqual(flat, treeTypes);
  assert.deepEqual(Object.keys(flat[0]), ['service_type']);
  assert.ok(!('service_catg_id' in flat[0]), 'no category wrapper survives');
});

test('flat shape preserves the tree ordering', async () => {
  const flat = await clientServiceCatalog(catalogPool().pool, { clientId: 213, shape: CATALOG_SHAPES.FLAT });
  assert.deepEqual(flat.map((e) => e.service_type.service_type_id), [7, 9, 12]);
});

test('shape defaults to tree when not specified', async () => {
  const data = await clientServiceCatalog(catalogPool().pool, { clientId: 213 });
  assert.ok('service_catg_id' in data[0], 'callers that omit shape get the documented tree');
});

// ─── city resolution ────────────────────────────────────────────────

test('city_id wins over city_name when both are supplied', async () => {
  const fake = makeFakePool([]);
  const out = await resolveCityId(fake.pool, { city_id: 3, city_name: 'Ignored' });
  assert.deepEqual(out, { cityId: 3, unknownName: null });
  assert.equal(fake.calls.length, 0, 'no lookup needed');
});

test('city_name resolves to an id', async () => {
  const fake = makeFakePool([[/FROM tbl_city/i, [{ city_id: 12 }]]]);
  const out = await resolveCityId(fake.pool, { city_name: '  Gurgaon ' });
  assert.deepEqual(out, { cityId: 12, unknownName: null });
  assert.deepEqual(fake.calls[0].params, ['Gurgaon'], 'trimmed before lookup');
});

test('an unknown city is reported rather than silently stored as NULL', async () => {
  const fake = makeFakePool([[/FROM tbl_city/i, []]]);
  const out = await resolveCityId(fake.pool, { city_name: 'Atlantis' });
  assert.equal(out.cityId, null);
  assert.equal(out.unknownName, 'Atlantis', 'caller can turn this into a 400');
});

test('a missing city block is not an error — pincode alone can carry the address', async () => {
  const fake = makeFakePool([]);
  assert.deepEqual(await resolveCityId(fake.pool, null), { cityId: null, unknownName: null });
  assert.deepEqual(await resolveCityId(fake.pool, {}), { cityId: null, unknownName: null });
  assert.deepEqual(await resolveCityId(fake.pool, { city_name: '   ' }), { cityId: null, unknownName: null });
});

// ─── paymentCollectedBy enum ────────────────────────────────────────

test('paymentCollectedBy maps the four documented words, case-insensitively', () => {
  assert.equal(paymentCollectedByCode('Any'), 0);
  assert.equal(paymentCollectedByCode('Serviceman'), 1);
  assert.equal(paymentCollectedByCode('Easyfix'), 2);
  assert.equal(paymentCollectedByCode('Client'), 3);
  assert.equal(paymentCollectedByCode('  eAsYfIx  '), 2);
  assert.deepEqual(PAYMENT_COLLECTED_BY, { any: 0, serviceman: 1, easyfix: 2, client: 3 });
});

test('an unrecognised paymentCollectedBy falls back to 0, as legacy did', () => {
  assert.equal(paymentCollectedByCode('Nonsense'), 0);
});

test('an absent paymentCollectedBy is null so the client default applies', () => {
  // Distinct from 0 ("Any"): null means "do not override", which lets
  // create() fall back to tbl_client.collected_by.
  assert.equal(paymentCollectedByCode(undefined), null);
  assert.equal(paymentCollectedByCode(null), null);
  assert.equal(paymentCollectedByCode('   '), null);
});
