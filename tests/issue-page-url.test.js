/*
 * The issue reporter's page_path keeps the QUERY STRING (owner, 2026-09-16).
 *
 * It used to strip it — a privacy call, so the issue queue could not double as
 * a log of which jobs a user viewed. The owner reversed that: the query is the
 * reproduction (which tab, which modal, which job). This pins the new rule and
 * the two things that did NOT change: the fragment still goes, and the value
 * still fits the VARCHAR(255) column.
 *
 * Runner: `node --test`.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { issueCreate } = require('../validators/issue.validator');

const body = (page_path) => ({ title: 'Reassign modal', description: 'Cancel button missing', page_path });

test('the query string survives — it is the reproduction', () => {
  const { error, value } = issueCreate.validate(body('/my-orders?tab=pending-start&action=reassign&jobId=509493'));
  assert.equal(error, undefined);
  assert.equal(value.page_path, '/my-orders?tab=pending-start&action=reassign&jobId=509493');
});

test('the fragment is still dropped, even one carrying its own query', () => {
  const { value } = issueCreate.validate(body('/jobs?tab=open#/detail?jobId=1'));
  assert.equal(value.page_path, '/jobs?tab=open');
});

test('the value is capped at the column width, 255', () => {
  const long = '/jobs?clientId=' + Array.from({ length: 120 }, (_, i) => 1000 + i).join(',');
  assert.ok(long.length > 255, 'positive control: the input must actually exceed the cap');
  const { error, value } = issueCreate.validate(body(long));
  assert.equal(error, undefined, 'a long URL truncates rather than 400s');
  assert.equal(value.page_path.length, 255);
  assert.ok(long.startsWith(value.page_path));
});

test('an empty page_path is still accepted (multipart posts "" for an untouched field)', () => {
  const { error, value } = issueCreate.validate(body(''));
  assert.equal(error, undefined);
  assert.equal(value.page_path, '');
});
