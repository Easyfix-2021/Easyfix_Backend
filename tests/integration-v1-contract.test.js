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
  jobUiStatus,
  legacyJobEntity,
} = require('../services/integration.service');

test('the integration router loads with every import resolved', () => {
  // Guards the whole class of bug that `node --check` cannot see: a helper
  // used in a handler but missing from the destructured require throws only
  // when that route is first hit, i.e. in front of a partner.
  const router = require('../routes/integration/v1/index.js');
  assert.ok(router.stack.length > 20, 'routes registered');
});

test('/jobs and /jobs/newJob are the SAME handler, so they cannot drift', () => {
  /*
   * Legacy exposed these as two methods with two different response shapes:
   * /jobs returned the bare entity, /jobs/newJob returned the envelope. We
   * deliberately serve the /jobs shape from both, so a partner on either path
   * parses one contract. Binding them to a single layer is what guarantees
   * that — two handlers would eventually diverge.
   */
  const router = require('../routes/integration/v1/index.js');
  const posts = router.stack.filter((l) => l.route?.methods?.post);
  const create = posts.filter((l) => /jobs/.test(l.route.path) || Array.isArray(l.route.path));
  const layer = create.find((l) => {
    const p = l.route.path;
    return Array.isArray(p) ? p.includes('/jobs') : p === '/jobs';
  });
  assert.ok(layer, 'a POST handler covers /jobs');
  const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
  assert.ok(paths.includes('/jobs'), 'serves /jobs');
  assert.ok(paths.includes('/jobs/newJob'), 'and /jobs/newJob from the same layer');
});

// ─── jobStatus label vocabulary (legacy getJobUIStatus) ─────────────

test('status 0 splits on whether a technician is attached', () => {
  assert.equal(jobUiStatus({ job_status: 0, fk_easyfixter_id: 44 }), 'Pending app acknowledgement');
  assert.equal(jobUiStatus({ job_status: 0, fk_easyfixter_id: null }), 'Pending for scheduling');
  assert.equal(jobUiStatus({ job_status: 0, fk_easyfixter_id: 0 }), 'Pending for scheduling');
});

test('a completed job with a follow-up visit reads "Visit Completed"', () => {
  assert.equal(jobUiStatus({ job_status: 3, sub_job_id: 991 }), 'Visit Completed');
  assert.equal(jobUiStatus({ job_status: 5, sub_job_id: 991 }), 'Visit Completed');
  assert.equal(jobUiStatus({ job_status: 3, sub_job_id: null }), 'Completed');
  assert.equal(jobUiStatus({ job_status: 5, sub_job_id: 0 }), 'Completed');
});

test('the remaining codes map exactly as the legacy service did', () => {
  const expected = {
    1: 'Pending to start', 2: 'Pending to close on app', 20: 'Pending to close on app',
    6: 'Cancelled', 7: 'Enquiry', 9: 'Unconfirmed', 10: 'Audit & complete',
    15: 'Pending for approval', 21: 'Fulfillment on hold',
  };
  for (const [code, label] of Object.entries(expected)) {
    assert.equal(jobUiStatus({ job_status: Number(code) }), label, `status ${code}`);
  }
});

test('an unmapped status returns an empty string, not "Unknown"', () => {
  // Legacy's `default:` branch. A client switching on the string would take a
  // different branch if this became a word.
  for (const code of [4, 8, 11, 14, 16, 19, 22, 99]) {
    assert.equal(jobUiStatus({ job_status: code }), '', `status ${code}`);
  }
});

// ─── POST /jobs response body ───────────────────────────────────────

const PERSISTED_JOB = {
  job_id: 212251, created_date_time: new Date(2026, 7, 14, 17, 42),
  requested_date_time: new Date(2026, 9, 16, 10, 0), requested_time: '10:00',
  client_ref_id: 'YOUR-ORDER-10231',
  client_spoc_name: 'Vikash', client_spoc_email: 'v@example.com', client_spoc: '9988765567',
  service_type_ids: '7,7', client_services: '24055,24056',
  fk_customer_id: 55, customer_mob_no: '9999578666', customer_name: 'Priyanka',
  address: 'Sector 44', building: 'Building 10', landmark: null,
  city_id: 3, city_name: 'Gurgaon', pin_code: '122001', gps_location: '28.45,77.02',
};

test('the created job is returned as a bare entity keyed by id', () => {
  const body = legacyJobEntity(PERSISTED_JOB);
  // Clients read `id` off the TOP level — there is no envelope on this one.
  assert.equal(body.id, 212251);
  assert.ok(!('status' in body) && !('data' in body), 'not the {status,message,data} envelope');
  assert.equal(body.reference_id, 'YOUR-ORDER-10231');
  assert.equal(body.created_date, '14-08-2026 17:42', 'DD-MM-YYYY HH:mm');
  assert.equal(body.requested_date, '16-10-2026 10:00');
  assert.deepEqual(body.customer, { id: 55, mobile: '9999578666', name: 'Priyanka' });
  assert.deepEqual(body.address.city, { city_id: 3, city_name: 'Gurgaon' });
  assert.equal(body.address.pinCode, '122001');
  assert.equal(body.address.gps, '28.45,77.02');
});

test('null fields are omitted entirely, as Jackson NON_NULL did', () => {
  const body = legacyJobEntity(PERSISTED_JOB);
  assert.ok(!('landmark' in body.address), 'a null landmark is absent, not null');
  const sparse = legacyJobEntity({ job_id: 7, city_id: null, city_name: null });
  assert.deepEqual(sparse, { id: 7 }, 'an emptied nested object is dropped too, never {}');
});

// ─── role → shape (legacy served TWO shapes from this one endpoint) ──

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

test('an unknown city surfaces its name so the caller can react', async () => {
  const fake = makeFakePool([[/FROM tbl_city/i, []]]);
  const out = await resolveCityId(fake.pool, { city_name: 'Atlantis' });
  assert.equal(out.cityId, null, 'stored as NULL, matching legacy');
  // The route logs this rather than rejecting — legacy accepted such requests
  // and created the job — but the name has to reach it to be logged at all.
  assert.equal(out.unknownName, 'Atlantis');
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
