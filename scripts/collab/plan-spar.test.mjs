// VTID-05214 — tests for scripts/collab/plan-spar.mjs. Run: node --test scripts/collab/plan-spar.test.mjs
// No network: the gateway is a scripted fake client / fake fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { detectSlug, parseResponses, setFrontMatter, step, gatewayClient, POLICY, parseSparRefs, resolveRef } from './plan-spar.mjs';
import { parseFrontMatter } from './queue.mjs';

const PLAN = (v = 1) => `---\nchange_class: standard\n---\n# Plan\n<!-- plan:begin -->\nDo the thing v${v}.\n<!-- plan:end -->\n`;
const HANDOFF = '---\nslug: cards\nauthor: kiro\nexecutor: kiro\nnext_actor: claude\nstate: drafted\nupdated: 2026-10-15T10:00Z\n---\n## Log\n';
// A handoff.md that declares one companion spar_refs entry (repo: branch-or-sha).
const HANDOFF_WITH_REF = (ref) =>
  `---\nslug: cards\nauthor: kiro\nexecutor: kiro\nnext_actor: claude\nstate: drafted\nspar_refs:\n  - exafyltd/vitana-v1: ${ref}\nupdated: 2026-10-15T10:00Z\n---\n## Log\n`;
const LANE = (id) => `---\nlane: ${id}\nstate: ready\nnext_actor: kiro\nupdated: 2026-10-15T10:00Z\n---\n## Log\n`;
const SHA = 'a'.repeat(40);

function spec(handoff = HANDOFF) {
  const dir = mkdtempSync(path.join(tmpdir(), 'plan-spar-'));
  const s = path.join(dir, '.kiro/specs/cards');
  mkdirSync(path.join(s, 'lanes'), { recursive: true });
  writeFileSync(path.join(s, 'plan.md'), PLAN());
  writeFileSync(path.join(s, 'handoff.md'), handoff);
  writeFileSync(path.join(s, 'lanes/a.md'), LANE('a'));
  writeFileSync(path.join(s, 'lanes/b.md'), LANE('b'));
  return { dir, s, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const finding = (id, severity = 'major') => ({ id, severity, claim: `claim ${id}`, evidence: [{ repo: 'r', path: 'p.ts', start_line: 3 }], suggestion: 'fix' });
const sess = (id, rounds, verdict, extra = {}) => ({
  id, verdict, escalation_reasons: [], final_plan_hash: verdict === 'in_progress' ? null : 'f'.repeat(64), policy_approved_at: null,
  rounds: rounds.map((fs, i) => ({ round: i + 1, plan_hash: 'h', review: { summary: 's', findings: fs, acknowledgements: [] } })), ...extra,
});

function fakeClient(script) {
  const calls = [];
  let last = null;
  const take = () => { last = script.shift(); return last; };
  return {
    calls,
    create: async (b) => { calls.push(['create', b]); return take(); },
    round: async (id, n, b) => { calls.push(['round', id, n, b]); return take(); },
    get: async (id) => (last && last.id === id ? { producer: 'ci-plan-spar.cards', ...last } : null),
    allocate: async (b) => { calls.push(['allocate', b]); return `VTID-0900${calls.filter((c) => c[0] === 'allocate').length}`; },
  };
}

const respond = (s, name, items) => writeFileSync(path.join(s, 'sparring', name), `answers\n\n\`\`\`json\n${JSON.stringify(items)}\n\`\`\`\n`);

test('detectSlug / parseResponses / setFrontMatter', () => {
  assert.equal(detectSlug(['.kiro/specs/cards/plan.md', 'x.ts']), 'cards');
  assert.equal(detectSlug(['.kiro/specs/cards/sparring/s2-responses-1.md']), 'cards');
  assert.equal(detectSlug(['.kiro/specs/cards/sparring/round-1.md']), null);
  assert.throws(() => detectSlug(['.kiro/specs/a/plan.md', '.kiro/specs/b/plan.md']), /one plan per PR/);
  assert.deepEqual(parseResponses('x\n```json\n[{"finding_id":"F1"}]\n```\n'), [{ finding_id: 'F1' }]);
  assert.throws(() => parseResponses('no block'));
  const t = setFrontMatter('---\na: 1\nvtids:\n  - X\nb: 2\n---\nbody', { a: 9, vtids: ['Y', 'Z'], c: 'n' });
  assert.deepEqual(parseFrontMatter(t), { a: '9', vtids: ['Y', 'Z'], b: '2', c: 'n' });
  assert.ok(t.endsWith('\nbody'));
});

test('round 1 is written, then the session waits for the planner', async () => {
  const f = spec();
  try {
    const c = fakeClient([sess('S1', [[finding('R1-F1')]], 'in_progress')]);
    const r = await step({ dir: f.dir, slug: 'cards', baseSha: SHA, repo: 'exafyltd/vitana-platform', client: c });
    assert.equal(r.action, 'create');
    assert.equal(c.calls[0][1].approval_policy, POLICY);
    assert.equal(c.calls[0][1].producer, 'ci-plan-spar.cards');
    assert.match(c.calls[0][1].plan_text, /plan:begin/);
    const round1 = readFileSync(path.join(f.s, 'sparring/round-1.md'), 'utf8');
    assert.match(round1, /### R1-F1 \[major\]/);
    assert.match(round1, /sparring\/responses-1\.md/);
    assert.equal((await step({ dir: f.dir, slug: 'cards', baseSha: SHA, repo: 'r', client: c })).action, 'waiting_for_planner');
    assert.equal(c.calls.length, 1);
  } finally { f.done(); }
});

test('responses → converged + policy-approved; without allocation the plan goes to Claude as sparred', async () => {
  const f = spec();
  try {
    const conv = sess('S1', [[finding('R1-F1')], []], 'converged', { policy_approved_at: '2026-10-15T12:00:00Z' });
    const c = fakeClient([sess('S1', [[finding('R1-F1')]], 'in_progress'), conv]);
    await step({ dir: f.dir, slug: 'cards', baseSha: SHA, repo: 'r', client: c });
    respond(f.s, 'responses-1.md', [{ finding_id: 'R1-F1', disposition: 'accepted', rationale: 'done' }]);
    writeFileSync(path.join(f.s, 'plan.md'), PLAN(2));
    const r = await step({ dir: f.dir, slug: 'cards', baseSha: SHA, repo: 'r', client: c });
    assert.equal(r.action, 'round+approved');
    assert.deepEqual(c.calls[1].slice(0, 3), ['round', 'S1', 2]);
    assert.equal(c.calls[1][3].responses[0].finding_id, 'R1-F1');
    const h = parseFrontMatter(readFileSync(path.join(f.s, 'handoff.md'), 'utf8'));
    assert.equal(h.state, 'sparred');
    assert.equal(h.next_actor, 'claude');
    assert.equal(h.sparring_record, '.kiro/specs/cards/sparring/verdict.md');
    assert.match(readFileSync(path.join(f.s, 'sparring/verdict.md'), 'utf8'), /allocation is off/);
    assert.ok(!c.calls.some((x) => x[0] === 'allocate'));
    // the same responses are never submitted twice
    assert.equal((await step({ dir: f.dir, slug: 'cards', baseSha: SHA, repo: 'r', client: c })).action, 'nothing_to_do');
  } finally { f.done(); }
});

test('with allocation on: one VTID per lane, the first bound to the sparring record; plan approved, lanes to Kiro', async () => {
  const f = spec();
  try {
    const c = fakeClient([sess('S1', [[finding('R1-F1')]], 'in_progress'), sess('S1', [[finding('R1-F1')], []], 'converged', { policy_approved_at: 'x' })]);
    await step({ dir: f.dir, slug: 'cards', baseSha: SHA, repo: 'r', client: c, allocate: true });
    respond(f.s, 'responses-1.md', [{ finding_id: 'R1-F1', disposition: 'accepted', rationale: 'done' }]);
    await step({ dir: f.dir, slug: 'cards', baseSha: SHA, repo: 'r', client: c, allocate: true });
    const allocs = c.calls.filter((x) => x[0] === 'allocate').map((x) => x[1]);
    assert.equal(allocs.length, 2);
    assert.equal(allocs[0].sparring_id, 'S1');
    assert.equal(allocs[0].plan_hash, 'f'.repeat(64));
    assert.equal(allocs[1].sparring_id, undefined);
    const h = parseFrontMatter(readFileSync(path.join(f.s, 'handoff.md'), 'utf8'));
    assert.equal(h.state, 'approved');
    assert.equal(h.next_actor, 'kiro');
    assert.deepEqual(h.vtids, ['VTID-09001', 'VTID-09002']);
    const a = parseFrontMatter(readFileSync(path.join(f.s, 'lanes/a.md'), 'utf8'));
    assert.equal(a.vtid, 'VTID-09001');
    assert.equal(a.state, 'ready');
  } finally { f.done(); }
});

test('escalation: one re-plan session on a changed plan, a second escalation parks the plan', async () => {
  const f = spec();
  try {
    const esc = (id) => sess(id, [[finding('R1-F1')], [finding('R2-F1')], [finding('R3-F1')]], 'escalated', { escalation_reasons: ['round_cap_reached'] });
    const c = fakeClient([esc('S1'), esc('S2')]);
    await step({ dir: f.dir, slug: 'cards', baseSha: SHA, repo: 'r', client: c });
    assert.equal(parseFrontMatter(readFileSync(path.join(f.s, 'handoff.md'), 'utf8')).state, 'drafted', 'first escalation does not park');
    assert.equal((await step({ dir: f.dir, slug: 'cards', baseSha: SHA, repo: 'r', client: c })).action, 'nothing_to_do', 'unchanged plan: no re-plan');
    writeFileSync(path.join(f.s, 'plan.md'), PLAN(3));
    const r = await step({ dir: f.dir, slug: 'cards', baseSha: SHA, repo: 'r', client: c });
    assert.equal(r.action, 'replan+escalated-parked');
    assert.ok(existsSync(path.join(f.s, 'sparring/s2-round-3.md')));
    const h = parseFrontMatter(readFileSync(path.join(f.s, 'handoff.md'), 'utf8'));
    assert.equal(h.state, 'parked');
    assert.equal(h.parked_from, 'drafted');
  } finally { f.done(); }
});

test('a partner outage hands the plan to Claude, is never parked, and the retry does not use up a session', async () => {
  const f = spec();
  try {
    const down = sess('S1', [[]], 'escalated', { escalation_reasons: ['code_access_unavailable'] });
    const c = fakeClient([down, sess('S1b', [[finding('R1-F1')]], 'in_progress')]);
    const r = await step({ dir: f.dir, slug: 'cards', baseSha: SHA, repo: 'r', client: c });
    assert.equal(r.action, 'create+escalated-infra');
    const h = parseFrontMatter(readFileSync(path.join(f.s, 'handoff.md'), 'utf8'));
    assert.equal(h.state, 'drafted');
    assert.equal(h.next_actor, 'claude');
    assert.equal((await step({ dir: f.dir, slug: 'cards', baseSha: SHA, repo: 'r', client: c })).action, 'retry');
    const state = JSON.parse(readFileSync(path.join(f.s, 'sparring/state.json'), 'utf8'));
    assert.deepEqual(state.sessions.map((s) => s.id), ['S1b']);
  } finally { f.done(); }
});

test('gateway client: a lost long call is recovered by polling the session', async () => {
  const seq = [];
  const fetchImpl = async (url, opts) => {
    seq.push(`${opts.method} ${url.replace('https://g', '')}`);
    if (opts.method === 'POST' && url.endsWith('/rounds')) return { status: 504, text: async () => '<html>timeout</html>' };
    if (opts.method === 'GET') {
      const n = seq.filter((x) => x.startsWith('GET')).length;
      const s = { id: 'S1', verdict: 'in_progress', rounds: n < 2 ? [{ round: 1 }] : [{ round: 1 }, { round: 2 }] };
      return { status: 200, text: async () => JSON.stringify({ ok: true, session: s }) };
    }
    return { status: 201, text: async () => JSON.stringify({ ok: true, vtid: 'VTID-09009' }) };
  };
  let t = 0;
  const c = gatewayClient({ baseUrl: 'https://g', token: 'tok', fetchImpl, sleep: async (ms) => { t += ms; }, now: () => t });
  const s = await c.round('S1', 2, { responses: [], revised_plan_text: 'x' });
  assert.equal(s.rounds.length, 2);
  assert.deepEqual(seq, ['POST /api/v1/plans/spar/S1/rounds', 'GET /api/v1/plans/spar/S1', 'GET /api/v1/plans/spar/S1']);
  assert.equal(await c.allocate({ source: 'x' }), 'VTID-09009');
});

test('review fix: a round is only submitted to this plan\'s own in-progress session', async () => {
  const f = spec();
  try {
    const c = fakeClient([sess('S1', [[finding('R1-F1')]], 'in_progress')]);
    await step({ dir: f.dir, slug: 'cards', baseSha: SHA, repo: 'r', client: c });
    respond(f.s, 'responses-1.md', [{ finding_id: 'R1-F1', disposition: 'accepted', rationale: 'x' }]);
    // the PR edits state.json to point at another plan's session
    const sp = path.join(f.s, 'sparring/state.json');
    const st = JSON.parse(readFileSync(sp, 'utf8'));
    st.sessions[0].id = 'OTHER';
    writeFileSync(sp, JSON.stringify(st));
    c.get = async (id) => ({ id, producer: 'ci-plan-spar.other', verdict: 'in_progress', rounds: [{}] });
    await assert.rejects(step({ dir: f.dir, slug: 'cards', baseSha: SHA, repo: 'r', client: c }), /not this plan's in-progress session/);
    assert.ok(!c.calls.some((x) => x[0] === 'round'));
  } finally { f.done(); }
});

test('review fix: partner_output_invalid goes to Claude but is not auto-retried (the gateway would dedup it)', async () => {
  const f = spec();
  try {
    const bad = sess('S1', [[]], 'escalated', { escalation_reasons: ['partner_output_invalid'] });
    const c = fakeClient([bad]);
    const r = await step({ dir: f.dir, slug: 'cards', baseSha: SHA, repo: 'r', client: c });
    assert.equal(r.action, 'create+escalated-infra');
    assert.equal(parseFrontMatter(readFileSync(path.join(f.s, 'handoff.md'), 'utf8')).next_actor, 'claude');
    assert.equal((await step({ dir: f.dir, slug: 'cards', baseSha: SHA, repo: 'r', client: c })).action, 'nothing_to_do');
    assert.equal(c.calls.filter((x) => x[0] === 'create').length, 1);
  } finally { f.done(); }
});

// ── VTID-05273: late-lane VTID allocation (retry, idempotent per lane) ──────────────────────────────
const HASH = 'f'.repeat(64);
const readFm = (f, rel) => parseFrontMatter(readFileSync(path.join(f.s, rel), 'utf8'));
const allocCalls = (c) => c.calls.filter((x) => x[0] === 'allocate').map((x) => x[1]);
/** A plan that converged (policy-approved) in an earlier PLAN-SPAR run: state.json as that run committed it. */
function convergedState(f, extra = {}) {
  mkdirSync(path.join(f.s, 'sparring'), { recursive: true });
  const st = { sessions: [{ id: 'S1', submitted: [1], plan_text_sha: 'x', rounds: 2, verdict: 'converged', infra: false, retryable: false,
    final_plan_hash: HASH, policy_approved_at: '2026-10-20T12:00:00Z', ...extra }] };
  writeFileSync(path.join(f.s, 'sparring/state.json'), `${JSON.stringify(st, null, 2)}\n`);
}
/** The live session the gateway returns for the retry path. */
const liveSession = (extra = {}) => ({ id: 'S1', producer: 'ci-plan-spar.cards', verdict: 'converged', policy_approved_at: '2026-10-20T12:00:00Z',
  final_plan_hash: HASH, vtid: null, rounds: [{ round: 1 }, { round: 2 }], escalation_reasons: [], ...extra });
const VTID_LANE = (id, vtid) => `---\nlane: ${id}\nstate: ready\nnext_actor: kiro\nvtid: ${vtid}\nupdated: 2026-10-15T10:00Z\n---\n## Log\n`;
const APPROVED_HANDOFF = (vtids) => `---\nslug: cards\nauthor: kiro\nexecutor: kiro\nnext_actor: kiro\nstate: approved\nsparring_record: .kiro/specs/cards/sparring/verdict.md\nvtids: [${vtids.join(', ')}]\nupdated: 2026-10-15T10:00Z\n---\n## Log\n`;

async function convergeWithAllocation(f, c) {
  await step({ dir: f.dir, slug: 'cards', baseSha: SHA, repo: 'r', client: c, allocate: true });
  respond(f.s, 'responses-1.md', [{ finding_id: 'R1-F1', disposition: 'accepted', rationale: 'done' }]);
  return step({ dir: f.dir, slug: 'cards', baseSha: SHA, repo: 'r', client: c, allocate: true });
}
const convScript = () => [sess('S1', [[finding('R1-F1')]], 'in_progress'), sess('S1', [[finding('R1-F1')], []], 'converged', { policy_approved_at: 'x' })];

test('late lane: a converged, policy-approved plan allocates a lane added after convergence', async () => {
  const f = spec();
  try {
    const c = fakeClient(convScript());
    await convergeWithAllocation(f, c);
    writeFileSync(path.join(f.s, 'lanes/c.md'), LANE('c'));
    c.get = async (id) => liveSession({ id, vtid: 'VTID-09001' });
    const r = await step({ dir: f.dir, slug: 'cards', baseSha: SHA, repo: 'r', client: c, allocate: true });
    assert.equal(r.action, 'allocate_retry');
    assert.equal(allocCalls(c).length, 3);
    assert.equal(readFm(f, 'lanes/c.md').vtid, 'VTID-09003');
    assert.equal(readFm(f, 'lanes/c.md').next_actor, 'kiro');
    const h = readFm(f, 'handoff.md');
    assert.equal(h.state, 'approved');
    assert.equal(h.next_actor, 'kiro');
    assert.deepEqual(h.vtids, ['VTID-09001', 'VTID-09002', 'VTID-09003']);
    assert.equal(h.reason, undefined);
    assert.match(readFileSync(path.join(f.s, 'sparring/verdict.md'), 'utf8'), /VTIDs: VTID-09001, VTID-09002, VTID-09003/);
    // no new round, no new session
    assert.equal(c.calls.filter((x) => x[0] === 'round' || x[0] === 'create').length, 2);
    // idempotent: the next run on the same state allocates nothing and writes nothing
    const again = await step({ dir: f.dir, slug: 'cards', baseSha: SHA, repo: 'r', client: c, allocate: true });
    assert.equal(again.action, 'nothing_to_do');
    assert.deepEqual(again.wrote, []);
    assert.equal(allocCalls(c).length, 3);
  } finally { f.done(); }
});

test('late lane: the retry never re-sends the sparring id once the session is bound', async () => {
  const f = spec();
  try {
    const c = fakeClient(convScript());
    await convergeWithAllocation(f, c);
    writeFileSync(path.join(f.s, 'lanes/c.md'), LANE('c'));
    c.get = async (id) => liveSession({ id, vtid: 'VTID-09001' });
    await step({ dir: f.dir, slug: 'cards', baseSha: SHA, repo: 'r', client: c, allocate: true });
    const late = allocCalls(c)[2];
    assert.ok(late, 'the late lane was allocated');
    assert.equal(late.sparring_id, undefined);
    assert.equal(late.plan_hash, undefined);
    assert.equal(allocCalls(c).filter((b) => b.sparring_id).length, 1, 'sparring id sent once per session');
  } finally { f.done(); }
});

test('no lanes at convergence: handoff goes to kiro with reason lanes_missing, not "allocation is off"', async () => {
  const f = spec();
  try {
    rmSync(path.join(f.s, 'lanes'), { recursive: true, force: true });
    const c = fakeClient(convScript());
    await convergeWithAllocation(f, c);
    const h = readFm(f, 'handoff.md');
    assert.equal(h.state, 'sparred');
    assert.equal(h.next_actor, 'kiro');
    assert.equal(h.reason, 'lanes_missing');
    const ht = readFileSync(path.join(f.s, 'handoff.md'), 'utf8');
    assert.doesNotMatch(ht, /allocation is off/);
    assert.match(ht, /No lane files yet/);
    assert.doesNotMatch(readFileSync(path.join(f.s, 'sparring/verdict.md'), 'utf8'), /allocation is off/);
    assert.equal(allocCalls(c).length, 0);
  } finally { f.done(); }
});

test('lanes added later to a lane-less converged plan: first lane gets the bound VTID', async () => {
  const f = spec();
  try {
    rmSync(path.join(f.s, 'lanes'), { recursive: true, force: true });
    const c = fakeClient(convScript());
    await convergeWithAllocation(f, c);
    mkdirSync(path.join(f.s, 'lanes'));
    writeFileSync(path.join(f.s, 'lanes/a.md'), LANE('a'));
    writeFileSync(path.join(f.s, 'lanes/b.md'), LANE('b'));
    c.get = async (id) => liveSession({ id, vtid: null });
    const r = await step({ dir: f.dir, slug: 'cards', baseSha: SHA, repo: 'r', client: c, allocate: true });
    assert.equal(r.action, 'allocate_retry');
    const allocs = allocCalls(c);
    assert.equal(allocs.length, 2);
    assert.equal(allocs[0].sparring_id, 'S1');
    assert.equal(allocs[0].plan_hash, HASH);
    assert.equal(allocs[1].sparring_id, undefined);
    const h = readFm(f, 'handoff.md');
    assert.equal(h.state, 'approved');
    assert.equal(h.next_actor, 'kiro');
    assert.equal(h.reason, undefined, 'the lanes_missing reason is cleared');
    assert.deepEqual(h.vtids, ['VTID-09001', 'VTID-09002']);
  } finally { f.done(); }
});

test('allocation failure keeps the VTIDs already allocated and retries the rest on the next run', async () => {
  const f = spec();
  try {
    const c = fakeClient(convScript());
    const ok = c.allocate;
    let n = 0;
    c.allocate = async (b) => { n++; if (n === 2) { c.calls.push(['allocate-failed', b]); throw new Error('allocate: HTTP 503 null'); } return ok(b); };
    const r = await convergeWithAllocation(f, c);
    assert.match(r.action, /\+partial$/);
    assert.equal(r.failed.lane, 'b');
    assert.equal(readFm(f, 'lanes/a.md').vtid, 'VTID-09001');
    assert.equal(readFm(f, 'lanes/b.md').vtid, undefined);
    let h = readFm(f, 'handoff.md');
    assert.equal(h.next_actor, 'kiro');
    assert.equal(h.reason, 'allocation_pending');
    assert.equal(h.state, 'approved');
    assert.deepEqual(h.vtids, ['VTID-09001']);
    assert.match(readFileSync(path.join(f.s, 'handoff.md'), 'utf8'), /lane b.*HTTP 503/);
    // the next PLAN-SPAR run allocates the rest, unbound
    c.get = async (id) => liveSession({ id, vtid: 'VTID-09001' });
    const r2 = await step({ dir: f.dir, slug: 'cards', baseSha: SHA, repo: 'r', client: c, allocate: true });
    assert.equal(r2.action, 'allocate_retry');
    const allocs = allocCalls(c);
    assert.equal(allocs.length, 2);
    assert.equal(allocs[1].sparring_id, undefined);
    assert.equal(readFm(f, 'lanes/b.md').vtid, 'VTID-09002');
    h = readFm(f, 'handoff.md');
    assert.equal(h.reason, undefined);
    assert.deepEqual(h.vtids, ['VTID-09001', 'VTID-09002']);
  } finally { f.done(); }
});

test('orphaned bound VTID is adopted, not re-allocated', async () => {
  const f = spec();
  try {
    rmSync(path.join(f.s, 'lanes/b.md'));
    convergedState(f);
    const c = fakeClient([]);
    c.get = async (id) => liveSession({ id, vtid: 'VTID-09007' });
    const r = await step({ dir: f.dir, slug: 'cards', baseSha: SHA, repo: 'r', client: c, allocate: true });
    assert.equal(r.action, 'allocate_retry');
    assert.equal(allocCalls(c).length, 0);
    assert.equal(readFm(f, 'lanes/a.md').vtid, 'VTID-09007');
    const h = readFm(f, 'handoff.md');
    assert.equal(h.state, 'approved');
    assert.deepEqual(h.vtids, ['VTID-09007']);
  } finally { f.done(); }
});

test('retry refuses a state.json that names another plan\'s session', async () => {
  for (const bad of [{ producer: 'ci-plan-spar.other' }, { final_plan_hash: 'e'.repeat(64) }, { verdict: 'escalated' }, { policy_approved_at: null }]) {
    const f = spec();
    try {
      convergedState(f);
      const c = fakeClient([]);
      c.get = async (id) => liveSession({ id, ...bad });
      await assert.rejects(step({ dir: f.dir, slug: 'cards', baseSha: SHA, repo: 'r', client: c, allocate: true }), /not this plan's converged, policy-approved session/);
      assert.equal(allocCalls(c).length, 0);
      assert.equal(readFm(f, 'lanes/a.md').vtid, undefined);
    } finally { f.done(); }
  }
});

test('retry with every lane allocated is a no-op with zero writes', async () => {
  const f = spec();
  try {
    writeFileSync(path.join(f.s, 'lanes/a.md'), VTID_LANE('a', 'VTID-09001'));
    writeFileSync(path.join(f.s, 'lanes/b.md'), VTID_LANE('b', 'VTID-09002'));
    writeFileSync(path.join(f.s, 'handoff.md'), APPROVED_HANDOFF(['VTID-09001', 'VTID-09002']));
    convergedState(f);
    const c = fakeClient([]);
    let gets = 0;
    c.get = async (id) => { gets++; return liveSession({ id, vtid: 'VTID-09001' }); };
    const r = await step({ dir: f.dir, slug: 'cards', baseSha: SHA, repo: 'r', client: c, allocate: true });
    assert.equal(r.action, 'nothing_to_do');
    assert.deepEqual(r.wrote, []);
    assert.equal(gets, 0);
    assert.equal(c.calls.length, 0);
  } finally { f.done(); }
});

test('allocation off: a converged plan with a late lane is not retried and still goes to claude', async () => {
  const f = spec();
  try {
    convergedState(f);
    const c = fakeClient([]);
    const r = await step({ dir: f.dir, slug: 'cards', baseSha: SHA, repo: 'r', client: c, allocate: false });
    assert.equal(r.action, 'nothing_to_do');
    assert.deepEqual(r.wrote, []);
    assert.equal(c.calls.length, 0);
  } finally { f.done(); }
});

test('spar_refs: a declared 40-hex SHA is forwarded as extra_refs with no GitHub API call (AC2, AC4)', async () => {
  const V1 = 'b'.repeat(40);
  const f = spec(HANDOFF_WITH_REF(V1));
  try {
    const c = fakeClient([sess('S1', [[finding('R1-F1')]], 'in_progress')]);
    let fetched = 0;
    const fetchImpl = async () => { fetched++; return { status: 200, json: async () => ({ sha: 'x' }) }; };
    await step({ dir: f.dir, slug: 'cards', baseSha: SHA, repo: 'exafyltd/vitana-platform', client: c, token: 'tok', fetchImpl });
    const create = c.calls.find((x) => x[0] === 'create')[1];
    assert.deepEqual(create.extra_refs, { 'exafyltd/vitana-v1': V1 });
    assert.equal(fetched, 0, 'a 40-hex SHA must not trigger a GitHub API call');
  } finally { f.done(); }
});

test('spar_refs: a declared branch is resolved to a SHA via the GitHub API and forwarded (AC3)', async () => {
  const RESOLVED = 'c'.repeat(40);
  const f = spec(HANDOFF_WITH_REF('claude/cards/impl'));
  try {
    const c = fakeClient([sess('S1', [[finding('R1-F1')]], 'in_progress')]);
    const seen = [];
    const fetchImpl = async (url, opts) => { seen.push({ url, opts }); return { status: 200, json: async () => ({ sha: RESOLVED }) }; };
    await step({ dir: f.dir, slug: 'cards', baseSha: SHA, repo: 'exafyltd/vitana-platform', client: c, token: 'tok', fetchImpl });
    const create = c.calls.find((x) => x[0] === 'create')[1];
    assert.deepEqual(create.extra_refs, { 'exafyltd/vitana-v1': RESOLVED });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, 'https://api.github.com/repos/exafyltd/vitana-v1/commits/claude%2Fcards%2Fimpl');
    assert.equal(seen[0].opts.headers.Authorization, 'Bearer tok');
  } finally { f.done(); }
});

test('spar_refs: absent → the create body is byte-identical to the current 6-key body, no extra_refs (AC1, AC6)', async () => {
  const f = spec(); // plain HANDOFF, no spar_refs
  try {
    const c = fakeClient([sess('S1', [[finding('R1-F1')]], 'in_progress')]);
    let fetched = 0;
    const fetchImpl = async () => { fetched++; return { status: 200, json: async () => ({ sha: 'x' }) }; };
    const planText = readFileSync(path.join(f.s, 'plan.md'), 'utf8');
    await step({ dir: f.dir, slug: 'cards', baseSha: SHA, repo: 'exafyltd/vitana-platform', client: c, token: 'tok', fetchImpl });
    const create = c.calls.find((x) => x[0] === 'create')[1];
    assert.ok(!('extra_refs' in create), 'extra_refs must be ABSENT, not an empty object');
    assert.deepEqual(create, {
      plan_text: planText, producer: 'ci-plan-spar.cards', change_class: 'standard', base_ref: SHA,
      repo: 'exafyltd/vitana-platform', approval_policy: POLICY,
    });
    assert.deepEqual(Object.keys(create), ['plan_text', 'producer', 'change_class', 'base_ref', 'repo', 'approval_policy']);
    assert.equal(fetched, 0, 'no spar_refs ⇒ no GitHub API call at all');
  } finally { f.done(); }
});

test('spar_refs: an inline-commented or multi-token entry fails loud rather than silently truncating (AC5)', async () => {
  // parseFrontMatter does not strip a trailing "# note" from a block-list item, so parseSparRefs must reject it.
  const f1 = spec(HANDOFF_WITH_REF('my-branch # note'));
  try {
    const c = fakeClient([]);
    await assert.rejects(
      step({ dir: f1.dir, slug: 'cards', baseSha: SHA, repo: 'exafyltd/vitana-platform', client: c, token: 'tok', fetchImpl: async () => { throw new Error('must not fetch'); } }),
      /spar_refs entry is not/,
    );
    assert.ok(!c.calls.some((x) => x[0] === 'create'), 'a malformed ref must not reach create()');
  } finally { f1.done(); }
  // A multi-token value with no "#" is rejected the same way.
  const f2 = spec(HANDOFF_WITH_REF('a b'));
  try {
    const c = fakeClient([]);
    await assert.rejects(step({ dir: f2.dir, slug: 'cards', baseSha: SHA, repo: 'exafyltd/vitana-platform', client: c, token: 'tok' }), /spar_refs entry is not/);
  } finally { f2.done(); }
});

test('spar_refs: a disallowed repo and the plan\'s own repo both fail loud (AC5, FR5)', async () => {
  const bad = (ref) => `---\nslug: cards\nauthor: kiro\nexecutor: kiro\nnext_actor: claude\nstate: drafted\nspar_refs:\n  - ${ref}\nupdated: 2026-10-15T10:00Z\n---\n## Log\n`;
  const f1 = spec(bad('exafyltd/other-repo: ' + 'd'.repeat(40)));
  try {
    const c = fakeClient([]);
    await assert.rejects(step({ dir: f1.dir, slug: 'cards', baseSha: SHA, repo: 'exafyltd/vitana-platform', client: c, token: 'tok' }), /not an allowed sparring repo/);
    assert.ok(!c.calls.some((x) => x[0] === 'create'));
  } finally { f1.done(); }
  // Declaring the plan's own repo is rejected (it is already pinned by --base-sha).
  const f2 = spec(bad('exafyltd/vitana-platform: ' + 'e'.repeat(40)));
  try {
    const c = fakeClient([]);
    await assert.rejects(step({ dir: f2.dir, slug: 'cards', baseSha: SHA, repo: 'exafyltd/vitana-platform', client: c, token: 'tok' }), /plan's own repo/);
  } finally { f2.done(); }
});

test('spar_refs: a resolve failure (non-200) is fatal and nothing is sent to create (AC5)', async () => {
  const f = spec(HANDOFF_WITH_REF('no-such-branch'));
  try {
    const c = fakeClient([]);
    const fetchImpl = async () => ({ status: 404, json: async () => ({}) });
    await assert.rejects(
      step({ dir: f.dir, slug: 'cards', baseSha: SHA, repo: 'exafyltd/vitana-platform', client: c, token: 'tok', fetchImpl }),
      /HTTP 404/,
    );
    assert.ok(!c.calls.some((x) => x[0] === 'create'));
  } finally { f.done(); }
});

test('spar_refs: a re-plan reuses the same resolved companion ref on the second create (round reuse)', async () => {
  const V1 = 'f'.repeat(40);
  const f = spec(HANDOFF_WITH_REF(V1));
  try {
    const esc = (id) => sess(id, [[finding('R1-F1')], [finding('R2-F1')], [finding('R3-F1')]], 'escalated', { escalation_reasons: ['round_cap_reached'] });
    const c = fakeClient([esc('S1'), esc('S2')]);
    await step({ dir: f.dir, slug: 'cards', baseSha: SHA, repo: 'exafyltd/vitana-platform', client: c, token: 'tok' });
    writeFileSync(path.join(f.s, 'plan.md'), PLAN(3)); // change the plan so a re-plan session is created
    await step({ dir: f.dir, slug: 'cards', baseSha: SHA, repo: 'exafyltd/vitana-platform', client: c, token: 'tok' });
    const creates = c.calls.filter((x) => x[0] === 'create').map((x) => x[1]);
    assert.equal(creates.length, 2);
    assert.deepEqual(creates[1].extra_refs, { 'exafyltd/vitana-v1': V1 }, 'the re-plan pins the same companion ref');
  } finally { f.done(); }
});

test('parseSparRefs: parses entries, defaults to [] when absent, and rejects malformed entries', () => {
  assert.deepEqual(parseSparRefs({}), []);
  assert.deepEqual(parseSparRefs({ spar_refs: undefined }), []);
  assert.deepEqual(parseSparRefs(null), []);
  assert.deepEqual(parseSparRefs({ spar_refs: ['exafyltd/vitana-v1: main'] }), [['exafyltd/vitana-v1', 'main']]);
  // parseFrontMatter yields a single-element list as an array; a lone string is tolerated too.
  assert.deepEqual(parseSparRefs({ spar_refs: 'exafyltd/vitana-v1: ' + 'a'.repeat(40) }), [['exafyltd/vitana-v1', 'a'.repeat(40)]]);
  assert.throws(() => parseSparRefs({ spar_refs: ['exafyltd/vitana-v1: my-branch # note'] }), /spar_refs entry is not/);
  assert.throws(() => parseSparRefs({ spar_refs: ['exafyltd/vitana-v1: a b'] }), /spar_refs entry is not/);
  assert.throws(() => parseSparRefs({ spar_refs: ['no-colon-here'] }), /spar_refs entry is not/);
});

test('resolveRef: a 40-hex SHA is returned verbatim with no fetch; a branch resolves via the API', async () => {
  // 40-hex in → returned lowercased, no network.
  let called = 0;
  const noFetch = async () => { called++; throw new Error('must not fetch'); };
  assert.equal(await resolveRef('exafyltd/vitana-v1', 'A'.repeat(40), { token: 't', fetchImpl: noFetch }), 'a'.repeat(40));
  assert.equal(called, 0);
  // Branch → 200 with .sha → that sha (lowercased).
  const ok = async () => ({ status: 200, json: async () => ({ sha: 'B'.repeat(40) }) });
  assert.equal(await resolveRef('exafyltd/vitana-v1', 'main', { token: 't', fetchImpl: ok }), 'b'.repeat(40));
  // 200 but no sha → throws.
  const noSha = async () => ({ status: 200, json: async () => ({}) });
  await assert.rejects(resolveRef('exafyltd/vitana-v1', 'main', { token: 't', fetchImpl: noSha }), /no commit sha/);
  // Non-200 → throws.
  const bad = async () => ({ status: 500, json: async () => ({}) });
  await assert.rejects(resolveRef('exafyltd/vitana-v1', 'main', { token: 't', fetchImpl: bad }), /HTTP 500/);
});
