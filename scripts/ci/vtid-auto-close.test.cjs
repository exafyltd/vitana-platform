// VTID-04691 — unit tests for scripts/ci/vtid-auto-close.cjs (node --test).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractTitleVtids, autoCloseDecision, rowAction, autoClose } = require('./vtid-auto-close.cjs');

const GW = 'https://gw.test';

function fakeFetch(rows) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body });
    const m = url.match(/\/tasks\/(VTID-\d+)(\/complete)?$/);
    const vtid = m && m[1];
    if (m && m[2]) {
      if (rows[vtid] === 'close-fails') return { ok: false, status: 502, json: async () => ({ ok: false, error: 'DATABASE_ERROR' }) };
      return { ok: true, status: 200, json: async () => ({ ok: true, vtid }) };
    }
    const row = rows[vtid];
    if (row === undefined) return { ok: false, status: 404, json: async () => ({}) };
    if (row === 'read-fails') return { ok: false, status: 500, json: async () => ({}) };
    const r = row === 'close-fails' ? { status: 'in_progress', is_terminal: false } : row;
    return { ok: true, status: 200, json: async () => r };
  };
  return { impl, calls };
}

const quiet = () => {};

test('extractTitleVtids: title VTIDs only, deduplicated, in order', () => {
  assert.deepEqual(extractTitleVtids('Fix x (VTID-04602 / VTID-04603)'), ['VTID-04602', 'VTID-04603']);
  assert.deepEqual(extractTitleVtids('VTID-04602 again VTID-04602'), ['VTID-04602']);
  assert.deepEqual(extractTitleVtids('fix: no id here (VTID-DA-2a9edcb4)'), []);
  assert.deepEqual(extractTitleVtids(''), []);
  assert.deepEqual(extractTitleVtids(undefined), []);
});

test('autoCloseDecision: Dev Autopilot branches and opt-outs are skipped', () => {
  assert.equal(autoCloseDecision({ headRef: 'dev-autopilot/a08daafd' }).close, false);
  assert.equal(autoCloseDecision({ headRef: 'claude/x', labels: [{ name: 'vtid-keep-open' }] }).close, false);
  assert.equal(autoCloseDecision({ headRef: 'claude/x', labels: ['vtid-keep-open'] }).close, false);
  assert.equal(autoCloseDecision({ headRef: 'claude/x', body: 'intro\nVTID_AUTO_CLOSE: no\n' }).close, false);
  assert.equal(autoCloseDecision({ headRef: 'claude/x', body: 'mentions VTID_AUTO_CLOSE: no inline' }).close, true);
  assert.equal(autoCloseDecision({ headRef: 'claude/x', labels: [], body: '' }).close, true);
});

test('rowAction: only a non-terminal row is closed', () => {
  assert.equal(rowAction(null).act, false);
  assert.equal(rowAction({ status: 'cancelled', is_terminal: true, terminal_outcome: 'cancelled' }).act, false);
  assert.equal(rowAction({ status: 'completed', is_terminal: true, terminal_outcome: 'success' }).act, false);
  for (const status of ['allocated', 'scheduled', 'in_progress', 'pending']) {
    assert.equal(rowAction({ status, is_terminal: false }).act, true, status);
  }
});

test('autoClose: closes open rows as success and leaves terminal ones untouched', async () => {
  const { impl, calls } = fakeFetch({
    'VTID-00001': { status: 'in_progress', is_terminal: false },
    'VTID-00002': { status: 'cancelled', is_terminal: true, terminal_outcome: 'cancelled' },
  });
  const pr = { title: 'Thing (VTID-00001, VTID-00002, VTID-00003)', headRef: 'claude/x', labels: [], body: '', ref: 'repo#1' };
  const res = await autoClose({ gateway: GW, pr, fetchImpl: impl, log: quiet });
  assert.deepEqual(res.map((r) => [r.vtid, r.outcome]), [
    ['VTID-00001', 'closed'],
    ['VTID-00002', 'left'],
    ['VTID-00003', 'left'],
  ]);
  const posts = calls.filter((c) => c.method === 'POST');
  assert.equal(posts.length, 1, 'only the open row is posted — a cancelled row is never overwritten');
  assert.equal(posts[0].url, `${GW}/api/v1/oasis/tasks/VTID-00001/complete`);
  assert.equal(JSON.parse(posts[0].body).terminal_outcome, 'success');
});

test('autoClose: a skipped PR makes no ledger call at all', async () => {
  const { impl, calls } = fakeFetch({ 'VTID-00001': { status: 'in_progress', is_terminal: false } });
  const pr = { title: 'x (VTID-00001)', headRef: 'dev-autopilot/abc', labels: [], body: '', ref: 'repo#2' };
  const res = await autoClose({ gateway: GW, pr, fetchImpl: impl, log: quiet });
  assert.equal(res[0].outcome, 'skipped');
  assert.equal(calls.length, 0);
});

test('autoClose: a per-VTID failure is reported, never thrown, and the rest still run', async () => {
  const { impl } = fakeFetch({
    'VTID-00001': 'read-fails',
    'VTID-00002': 'close-fails',
    'VTID-00003': { status: 'scheduled', is_terminal: false },
  });
  const pr = { title: 'x VTID-00001 VTID-00002 VTID-00003', headRef: 'claude/x', labels: [], body: '', ref: 'repo#3' };
  const res = await autoClose({ gateway: GW, pr, fetchImpl: impl, log: quiet });
  assert.deepEqual(res.map((r) => r.outcome), ['error', 'error', 'closed']);
});

test('autoClose: no VTID in the title means no calls', async () => {
  const { impl, calls } = fakeFetch({});
  const res = await autoClose({ gateway: GW, pr: { title: 'chore: bump', ref: 'r' }, fetchImpl: impl, log: quiet });
  assert.deepEqual(res, []);
  assert.equal(calls.length, 0);
});

test('autoClose: sends the service token on the close and not on the read (VTID-04727)', async () => {
  const { impl, calls } = fakeFetch({ 'VTID-00001': { status: 'in_progress', is_terminal: false } });
  const seen = [];
  const spy = async (url, opts = {}) => { seen.push(opts.headers || {}); return impl(url, opts); };
  const pr = { title: 'x (VTID-00001)', headRef: 'claude/x', labels: [], body: '', ref: 'r' };
  await autoClose({ gateway: GW, pr, token: 'svc', fetchImpl: spy, log: quiet });
  assert.equal(calls.length, 2);
  assert.equal(seen[1].Authorization, 'Bearer svc');
  assert.equal(seen[0].Authorization, undefined);
});
