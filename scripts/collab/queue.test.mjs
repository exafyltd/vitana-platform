// VTID-05145 — tests for scripts/collab/queue.mjs. Run: node --test scripts/collab/queue.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateRegistry, loadSeats, catFileBatch, gitSpawns, renderTable,
  parseFrontMatter, classifyPath, validatePlan, validateLane, checkTransition,
  collect, buildQueue, validateRange, claim, release, listClaims, sessionId,
  scopeCheck, globToRegex, matchesAny, globTouchesGovernance, isSessionId, seatOf, loadPrograms, validatePrograms, programIndex,
} from './queue.mjs';
// VTID-05276: newer exports are read through the namespace so each new test fails on its own on an older queue.mjs.
import * as Q from './queue.mjs';

const S1 = 'kiro-202610131200-ab12';
const S2 = 'session_01ABCdef';

const planMd = (o = {}) => `---\n${Object.entries({ slug: 'cards', author: 'kiro', executor: 'claude', next_actor: 'claude', state: 'drafted', updated: '2026-10-13T10:00Z', ...o })
  .map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.join(', ')}]` : v}`).join('\n')}\n---\n## Log\n### 2026-10-13 · kiro · drafted\n`;
const laneMd = (lane, o = {}) => `---\n${Object.entries({ lane, state: 'ready', next_actor: 'claude', updated: '2026-10-13T10:00Z', ...o })
  .map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.join(', ')}]` : v}`).join('\n')}\n---\n## Log\n### 2026-10-13 · start\n`;

// ── pure functions ──

test('parseFrontMatter: scalars, inline lists, block lists, comments', () => {
  const fm = parseFrontMatter('---\na: 1\nb: [x, y]\nc:\n  - p\n  - "q"\nd: v # note\n---\nbody');
  assert.deepEqual(fm, { a: '1', b: ['x', 'y'], c: ['p', 'q'], d: 'v' });
  assert.equal(parseFrontMatter('no front matter'), null);
});

test('classifyPath', () => {
  assert.deepEqual(classifyPath('.kiro/specs/cards/handoff.md'), { slug: 'cards', lane: '_plan', kind: 'plan' });
  assert.deepEqual(classifyPath('.kiro/specs/cards/lanes/card-01.md'), { slug: 'cards', lane: 'card-01', kind: 'lane' });
  assert.equal(classifyPath('.kiro/specs/cards/tasks.md'), null);
});

test('validatePlan: valid passes, each bad field is named', () => {
  assert.deepEqual(validatePlan(parseFrontMatter(planMd()), 'cards'), []);
  const bad = validatePlan(parseFrontMatter(planMd({ author: 'bob', next_actor: 'x', state: 'nope', slug: 'other' })), 'cards');
  assert.ok(bad.some((e) => e.startsWith('author')));
  assert.ok(bad.some((e) => e.startsWith('next_actor')));
  assert.ok(bad.some((e) => e.startsWith('state')));
  assert.ok(bad.some((e) => e.startsWith('slug')));
  assert.ok(validatePlan(parseFrontMatter(planMd({ state: 'approved', sparring_record: 'x.md' })), 'cards').some((e) => e.includes('vtids required')));
  assert.ok(validatePlan(parseFrontMatter(planMd({ state: 'sparred' })), 'cards').some((e) => e.includes('sparring_record required')));
  assert.deepEqual(validatePlan(parseFrontMatter(planMd({ state: 'approved', sparring_record: 'x.md', vtids: ['VTID-00001'] })), 'cards'), []);
});

test('validateLane: plan-only states rejected, vtid required once working, deps must exist', () => {
  const ids = new Set(['a', 'b']);
  assert.deepEqual(validateLane(parseFrontMatter(laneMd('a')), 'cards', 'a', ids), []);
  assert.ok(validateLane(parseFrontMatter(laneMd('a', { state: 'drafted' })), 'cards', 'a', ids).some((e) => e.includes('plan-only')));
  assert.ok(validateLane(parseFrontMatter(laneMd('a', { state: 'executing' })), 'cards', 'a', ids).some((e) => e.includes('vtid required')));
  assert.ok(validateLane(parseFrontMatter(laneMd('a', { depends_on: ['zz'] })), 'cards', 'a', ids).some((e) => e.includes('not a lane')));
  assert.ok(validateLane(parseFrontMatter(laneMd('a', { claimed_by: 'someone' })), 'cards', 'a', ids).some((e) => e.includes('session id')));
});

test('checkTransition: plan and lane tables, done terminal, parked returns only where it came from', () => {
  const p = (state, extra = {}) => ({ state, ...extra });
  for (const [a, b] of [['drafted', 'sparred'], ['sparred', 'approved'], ['sparred', 'drafted'], ['approved', 'executing'], ['executing', 'in-review'], ['in-review', 'executing'], ['in-review', 'verified'], ['verified', 'done'], ['executing', 'parked']]) {
    assert.deepEqual(checkTransition('plan', p(a), p(b)), [], `${a}→${b}`);
  }
  for (const [a, b] of [['drafted', 'approved'], ['approved', 'done'], ['done', 'executing'], ['done', 'parked'], ['executing', 'verified']]) {
    assert.equal(checkTransition('plan', p(a), p(b)).length, 1, `${a}→${b}`);
  }
  assert.deepEqual(checkTransition('plan', p('parked', { parked_from: 'executing' }), p('executing')), []);
  assert.equal(checkTransition('plan', p('parked', { parked_from: 'executing' }), p('approved')).length, 1);
  for (const [a, b] of [['ready', 'executing'], ['executing', 'in-review'], ['in-review', 'executing'], ['verified', 'done']]) {
    assert.deepEqual(checkTransition('lane', p(a), p(b)), [], `lane ${a}→${b}`);
  }
  assert.equal(checkTransition('lane', p('ready'), p('done')).length, 1);
  assert.equal(checkTransition('lane', null, p('executing')).length, 1);
  assert.deepEqual(checkTransition('lane', null, p('executing'), { allowInitial: true }), []);
  assert.equal(checkTransition('plan', null, p('sparred')).length, 1);
  assert.equal(checkTransition('plan', p('drafted'), null).length, 1);
});

test('sessionId format', () => {
  assert.match(sessionId('kiro', new Date(Date.UTC(2026, 9, 13, 9, 5))), /^kiro-202610130905-[0-9a-f]{4}$/);
  assert.throws(() => sessionId('claude'));
});

// ── git fixtures ──

function sh(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
}

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'collab-'));
  const origin = path.join(dir, 'origin.git');
  sh(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  const work = path.join(dir, 'work');
  sh(dir, 'clone', '-q', origin, work);
  sh(work, 'checkout', '-q', '-b', 'main');
  writeFileSync(path.join(work, 'README.md'), 'x\n');
  sh(work, 'add', '.');
  sh(work, 'commit', '-q', '-m', 'init');
  sh(work, 'push', '-q', 'origin', 'main');
  sh(work, 'remote', 'set-head', 'origin', 'main');
  return { dir, origin, work, done: () => rmSync(dir, { recursive: true, force: true }) };
}

function write(work, rel, text) {
  mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
  writeFileSync(path.join(work, rel), text);
}

function commit(work, msg, trailers = {}) {
  sh(work, 'add', '-A');
  const t = Object.entries(trailers).map(([k, v]) => `${k}: ${v}`).join('\n');
  sh(work, 'commit', '-q', '-m', msg, ...(t ? ['-m', t] : []));
  return sh(work, 'rev-parse', 'HEAD');
}

function seedSpec(f) {
  write(f.work, '.kiro/specs/cards/handoff.md', planMd({ state: 'executing', sparring_record: 'x.md', vtids: ['VTID-00001'], executor: 'kiro', next_actor: 'kiro' }));
  write(f.work, '.kiro/specs/cards/lanes/card-01.md', laneMd('card-01', { next_actor: 'kiro' }));
  write(f.work, '.kiro/specs/cards/lanes/card-02.md', laneMd('card-02', { next_actor: 'kiro', depends_on: ['card-01'] }));
  const sha = commit(f.work, 'seed', { 'Collab-Session': S2, 'Collab-Lane': 'cards/_plan' });
  sh(f.work, 'push', '-q', 'origin', 'main');
  sh(f.work, 'fetch', '-q', 'origin');
  return sha;
}

test('queue: empty repo → no rows; one row per lane; blocked dependency; newest version across branches wins', () => {
  const f = fixture();
  try {
    sh(f.work, 'fetch', '-q', 'origin');
    assert.deepEqual(buildQueue(collect(f.work), 'r'), []);
    seedSpec(f);
    let rows = buildQueue(collect(f.work), 'r');
    assert.deepEqual(rows.map((r) => r.lane), ['_plan', 'card-01', 'card-02']);
    assert.equal(rows.find((r) => r.lane === 'card-02').blocked, true);
    assert.equal(rows.find((r) => r.lane === 'card-01').blocked, false);
    // A work branch moves card-01 forward: the queue shows the branch version.
    sh(f.work, 'checkout', '-q', '-b', 'kiro/cards/card-01');
    write(f.work, '.kiro/specs/cards/lanes/card-01.md', laneMd('card-01', { state: 'executing', vtid: 'VTID-00002', claimed_by: S1, updated: '2026-10-13T11:00Z' }));
    commit(f.work, 'work', { 'Collab-Session': S1, 'Collab-Lane': 'cards/card-01' });
    sh(f.work, 'push', '-q', 'origin', 'kiro/cards/card-01');
    sh(f.work, 'fetch', '-q', 'origin');
    rows = buildQueue(collect(f.work), 'r');
    const c1 = rows.find((r) => r.lane === 'card-01');
    assert.equal(c1.state, 'executing');
    assert.equal(c1.branch, 'origin/kiro/cards/card-01');
  } finally { f.done(); }
});

test('queue: a spec without lanes is one implicit lane "main"', () => {
  const f = fixture();
  try {
    write(f.work, '.kiro/specs/solo/handoff.md', planMd({ slug: 'solo' }));
    commit(f.work, 'plan', { 'Collab-Session': S1, 'Collab-Lane': 'solo/_plan' });
    sh(f.work, 'push', '-q', 'origin', 'main');
    sh(f.work, 'fetch', '-q', 'origin');
    assert.deepEqual(buildQueue(collect(f.work), 'r').map((r) => r.lane), ['_plan', 'main']);
  } finally { f.done(); }
});

test('claims: atomic — second session is refused; release by holder; stale break only after 24 h; nested refs listed', () => {
  const f = fixture();
  try {
    sh(f.work, 'fetch', '-q', 'origin');
    assert.equal(claim(f.work, 'cards/card-01', S1).ok, true);
    const second = claim(f.work, 'cards/card-01', S2);
    assert.equal(second.ok, false);
    assert.equal(second.holder, S1);
    assert.equal(claim(f.work, 'cards/card-02', S2).ok, true, 'another lane of the same spec runs in parallel');
    assert.equal(claim(f.work, 'cards/_plan', S2).ok, true);
    assert.deepEqual(listClaims(f.work).map((c) => c.key).sort(), ['cards/_plan', 'cards/card-01', 'cards/card-02']);
    assert.equal(release(f.work, 'cards/card-01', S2).ok, false, 'not the holder');
    assert.equal(release(f.work, 'cards/card-01', S2, { stale: true }).ok, false, 'younger than 24 h');
    assert.equal(release(f.work, 'cards/card-01', S2, { stale: true, now: Date.now() + 25 * 3600e3 }).broke, S1);
    assert.equal(claim(f.work, 'cards/card-01', S2).ok, true);
    assert.equal(release(f.work, 'cards/card-01', S2).ok, true);
    assert.throws(() => claim(f.work, 'bad key', S1));
    assert.throws(() => claim(f.work, 'cards/card-01', 'not-a-session'));
  } finally { f.done(); }
});

test('validate: a correct lane PR passes', () => {
  const f = fixture();
  try {
    const base = seedSpec(f);
    sh(f.work, 'checkout', '-q', '-b', 'kiro/cards/card-01');
    write(f.work, '.kiro/specs/cards/lanes/card-01.md', laneMd('card-01', { state: 'executing', vtid: 'VTID-00002', claimed_by: S1, updated: '2026-10-13T11:00Z' }));
    write(f.work, 'src/a.ts', 'x');
    const head = commit(f.work, 'work', { 'Collab-Session': S1, 'Collab-Lane': 'cards/card-01' });
    const r = validateRange(f.work, { base, head, branch: 'kiro/cards/card-01' });
    assert.deepEqual(r.errors, []);
  } finally { f.done(); }
});

test('validate: foreign lane file, branch/lane mismatch, claimed_by ≠ session, missing trailers, two lanes, illegal transition all fail', () => {
  const f = fixture();
  try {
    const base = seedSpec(f);
    sh(f.work, 'checkout', '-q', '-b', 'kiro/cards/card-01');
    write(f.work, '.kiro/specs/cards/lanes/card-01.md', laneMd('card-01', { state: 'executing', vtid: 'VTID-00002', claimed_by: S2, updated: '2026-10-13T11:00Z' }));
    commit(f.work, 'w1', { 'Collab-Session': S1, 'Collab-Lane': 'cards/card-01' });
    write(f.work, '.kiro/specs/cards/lanes/card-02.md', laneMd('card-02', { state: 'done', vtid: 'VTID-00003' }));
    commit(f.work, 'w2', { 'Collab-Session': S1, 'Collab-Lane': 'cards/card-01' });
    write(f.work, 'src/b.ts', 'x');
    commit(f.work, 'no trailers');
    write(f.work, 'src/c.ts', 'x');
    const head = commit(f.work, 'other lane', { 'Collab-Session': S1, 'Collab-Lane': 'cards/card-09' });
    const { errors } = validateRange(f.work, { base, head, branch: 'kiro/cards/card-01' });
    const has = (s) => assert.ok(errors.some((e) => e.includes(s)), `expected an error containing "${s}" in:\n${errors.join('\n')}`);
    has('changes .kiro/specs/cards/lanes/card-02.md');
    has('claimed_by is session_01ABCdef');
    has('needs Collab-Session and Collab-Lane');
    has('one PR per lane');
    has('but commits name cards/card-09');
    has('illegal transition "ready" → "done"');
  } finally { f.done(); }
});

test('validate: reviewer may append a log entry with Collab-Review, but not change front matter', () => {
  const f = fixture();
  try {
    const base = seedSpec(f);
    sh(f.work, 'checkout', '-q', '-b', 'rev');
    write(f.work, '.kiro/specs/cards/lanes/card-01.md', `${laneMd('card-01', { next_actor: 'kiro' })}### review · ok\n`);
    let head = commit(f.work, 'review', { 'Collab-Session': S2, 'Collab-Review': 'cards/card-01' });
    assert.deepEqual(validateRange(f.work, { base, head }).errors, []);
    write(f.work, '.kiro/specs/cards/lanes/card-01.md', laneMd('card-01', { next_actor: 'owner' }));
    head = commit(f.work, 'review edits state', { 'Collab-Session': S2, 'Collab-Review': 'cards/card-01' });
    assert.ok(validateRange(f.work, { base, head }).errors.some((e) => e.includes('front matter unchanged')));
  } finally { f.done(); }
});

test('validate: new plan must start drafted unless --allow-initial; _plan may create lanes but not edit them', () => {
  const f = fixture();
  try {
    sh(f.work, 'fetch', '-q', 'origin');
    const base = sh(f.work, 'rev-parse', 'HEAD');
    write(f.work, '.kiro/specs/cards/handoff.md', planMd({ state: 'executing', sparring_record: 'x.md', vtids: ['VTID-00001'] }));
    write(f.work, '.kiro/specs/cards/lanes/card-01.md', laneMd('card-01'));
    let head = commit(f.work, 'backfill', { 'Collab-Session': S2, 'Collab-Lane': 'cards/_plan' });
    assert.ok(validateRange(f.work, { base, head }).errors.some((e) => e.includes('must start at "drafted"')));
    assert.deepEqual(validateRange(f.work, { base, head, allowInitial: ['cards'] }).errors, []);
    write(f.work, '.kiro/specs/cards/lanes/card-01.md', laneMd('card-01', { next_actor: 'owner' }));
    head = commit(f.work, 'coordinator edits a lane', { 'Collab-Session': S2, 'Collab-Lane': 'cards/_plan' });
    assert.ok(validateRange(f.work, { base, head, allowInitial: ['cards'] }).errors.some((e) => e.includes('card-01.md but its Collab-Lane')));
  } finally { f.done(); }
});

test('validate: PR without spec changes and without trailers passes untouched', () => {
  const f = fixture();
  try {
    const base = seedSpec(f);
    write(f.work, 'src/x.ts', 'x');
    const head = commit(f.work, 'ordinary work');
    assert.deepEqual(validateRange(f.work, { base, head, branch: 'claude/whatever' }).errors, []);
  } finally { f.done(); }
});

// ── VTID-05145 A1: seats ──

test('seat session ids: generated with a seat, old form still valid, bad seat refused', () => {
  const id = sessionId('kiro', new Date(Date.UTC(2026, 9, 14, 16, 5)), 'jtadic');
  assert.match(id, /^kiro-jtadic-202610141605-[0-9a-f]{4}$/);
  assert.throws(() => sessionId('kiro', new Date(), 'J-Tadic'));
  assert.throws(() => sessionId('kiro', new Date(), 'k1'));
  const ids = new Set(['a', 'b']);
  assert.deepEqual(validateLane(parseFrontMatter(laneMd('a', { claimed_by: id })), 'cards', 'a', ids), []);
  assert.deepEqual(validateLane(parseFrontMatter(laneMd('a', { claimed_by: S1 })), 'cards', 'a', ids), []);
});

test('lane seat: valid seat passes, malformed seat fails', () => {
  const ids = new Set(['a']);
  assert.deepEqual(validateLane(parseFrontMatter(laneMd('a', { seat: 'exafyltd', area: 'messenger' })), 'cards', 'a', ids), []);
  assert.ok(validateLane(parseFrontMatter(laneMd('a', { seat: 'Kiro-1' })), 'cards', 'a', ids).some((e) => e.includes('seat')));
});

test('queue rows carry seat; a seat-session lane PR validates', () => {
  const f = fixture();
  try {
    write(f.work, '.kiro/specs/cards/handoff.md', planMd({ state: 'executing', sparring_record: 'x.md', vtids: ['VTID-00001'], executor: 'kiro', next_actor: 'kiro' }));
    write(f.work, '.kiro/specs/cards/lanes/card-01.md', laneMd('card-01', { next_actor: 'kiro', seat: 'jtadic', area: 'backoffice' }));
    const base = commit(f.work, 'seed', { 'Collab-Session': S2, 'Collab-Lane': 'cards/_plan' });
    sh(f.work, 'push', '-q', 'origin', 'main');
    sh(f.work, 'fetch', '-q', 'origin');
    const rows = buildQueue(collect(f.work), 'r');
    assert.equal(rows.find((r) => r.lane === 'card-01').seat, 'jtadic');
    const seatSession = 'kiro-jtadic-202610141605-ab12';
    sh(f.work, 'checkout', '-q', '-b', 'kiro/cards/card-01');
    write(f.work, '.kiro/specs/cards/lanes/card-01.md', laneMd('card-01', { state: 'executing', vtid: 'VTID-00002', seat: 'jtadic', claimed_by: seatSession, updated: '2026-10-14T16:10Z' }));
    const head = commit(f.work, 'work', { 'Collab-Session': seatSession, 'Collab-Lane': 'cards/card-01' });
    assert.deepEqual(validateRange(f.work, { base, head, branch: 'kiro/cards/card-01' }).errors, []);
  } finally { f.done(); }
});

// ── VTID-05213: lane schema, Lane scope, programme registry ──

test('session ids: pm-agent and ci-plan-spar literals; seatOf', () => {
  for (const ok of ['pm-agent', 'ci-plan-spar', 'session_01A', 'kiro-jtadic-202610151200-ab12', 'kiro-202610151200-ab12']) assert.ok(isSessionId(ok), ok);
  for (const bad of ['pm', 'ci', 'pm-agent-2', 'kiro-JT-202610151200-ab12']) assert.ok(!isSessionId(bad), bad);
  assert.equal(seatOf('kiro-jtadic-202610151200-ab12'), 'jtadic');
  assert.equal(seatOf('kiro-202610151200-ab12'), '');
  assert.equal(seatOf('session_01A'), '');
});

test('globs: ** spans segments, * stays in one, dir/** matches dir; governance detection', () => {
  assert.ok(matchesAny('src/a/b.ts', ['src/**']));
  assert.ok(matchesAny('services/gateway/src/routes/chat-x.ts', ['services/gateway/src/routes/chat*.ts']));
  assert.ok(!matchesAny('services/gateway/src/routes/x/chat.ts', ['services/gateway/src/routes/chat*.ts']));
  assert.ok(!matchesAny('docs/a/b.md', ['docs/*.md']));
  assert.ok(globToRegex('a.b/**').test('a.b/c'));
  assert.ok(!globToRegex('a.b/**').test('aXb/c'));
  for (const g of ['.github/**', 'scripts/**', 'scripts/collab/queue.mjs', '**', 'CLAUDE.md', 'docs/programs/**', '.kiro/automations/jtadic.md']) assert.ok(globTouchesGovernance(g), g);
  for (const g of ['src/**', 'services/gateway/src/services/project-manager/**', 'docs/programs/*/program.md', 'supabase/migrations/*.sql']) assert.ok(!globTouchesGovernance(g), g);
});

test('validateLane: executor, reviewer_seat ≠ seat, paths required once working, Kiro lanes never declare governance paths', () => {
  const v = (o) => validateLane(parseFrontMatter(laneMd('a', o)), 'cards', 'a', new Set(['a']));
  assert.deepEqual(v({ executor: 'kiro', seat: 'jtadic', reviewer_seat: 'exafyltd', paths: ['src/**'] }), []);
  assert.ok(v({ executor: 'bob' }).some((e) => e.startsWith('executor')));
  assert.ok(v({ seat: 'jtadic', reviewer_seat: 'jtadic' }).some((e) => e.includes('reviewer_seat must differ')));
  assert.ok(v({ reviewer_seat: 'Bad1' }).some((e) => e.includes('reviewer_seat')));
  assert.deepEqual(v({ reviewer_seat: 'claude', seat: 'jtadic' }), []);
  assert.ok(v({ executor: 'kiro', state: 'executing', vtid: 'VTID-00002' }).some((e) => e.includes('paths required')));
  assert.ok(v({ executor: 'kiro', paths: ['src/**', '.github/workflows/x.yml'] }).some((e) => e.includes('governance')));
  assert.deepEqual(v({ executor: 'claude', paths: ['.github/workflows/x.yml'] }), []);
  assert.ok(validatePlan(parseFrontMatter(planMd({ author_seat: 'J1' })), 'cards').some((e) => e.includes('author_seat')));
});

function scopeFixture(f, laneFm) {
  write(f.work, '.kiro/specs/cards/handoff.md', planMd({ state: 'executing', sparring_record: 'x.md', vtids: ['VTID-00002'], executor: 'kiro', next_actor: 'kiro' }));
  write(f.work, '.kiro/specs/cards/lanes/card-01.md', laneMd('card-01', { next_actor: 'kiro', vtid: 'VTID-00002', ...laneFm }));
  const base = commit(f.work, 'seed', { 'Collab-Session': S2, 'Collab-Lane': 'cards/_plan' });
  sh(f.work, 'push', '-q', 'origin', 'main');
  sh(f.work, 'checkout', '-q', '-b', 'kiro/cards/card-01');
  return base;
}
const LANE = { executor: 'kiro', seat: 'jtadic', reviewer_seat: 'exafyltd', paths: ['src/backoffice/**'] };
const JT = 'kiro-jtadic-202610151200-ab12';
const EX = 'kiro-exafyltd-202610151300-cd34';

test('scope-check: changes inside paths + own spec + own evidence pass', () => {
  const f = fixture();
  try {
    const base = scopeFixture(f, LANE);
    write(f.work, 'src/backoffice/a.ts', 'x');
    write(f.work, 'docs/validation/VTID-00002/scope.json', '{}');
    write(f.work, '.kiro/specs/cards/lanes/card-01.md', laneMd('card-01', { ...LANE, state: 'executing', vtid: 'VTID-00002', claimed_by: JT }));
    const head = commit(f.work, 'work', { 'Collab-Session': JT, 'Collab-Lane': 'cards/card-01' });
    const r = scopeCheck(f.work, { base, head, branch: 'kiro/cards/card-01' });
    assert.ok(r.applies);
    assert.deepEqual(r.errors, []);
  } finally { f.done(); }
});

test('scope-check: outside paths, governance path, foreign seat, missing trailer, wrong reviewer all fail', () => {
  const f = fixture();
  try {
    const base = scopeFixture(f, LANE);
    write(f.work, 'src/other.ts', 'x');
    write(f.work, '.github/workflows/x.yml', 'x');
    write(f.work, '.kiro/specs/cards/lanes/card-01.md', laneMd('card-01', { ...LANE, state: 'executing', vtid: 'VTID-00002', claimed_by: EX }));
    const head = commit(f.work, 'work', { 'Collab-Session': EX, 'Collab-Lane': 'cards/card-01' });
    const e = scopeCheck(f.work, { base, head, branch: 'kiro/cards/card-01' }).errors;
    assert.ok(e.some((x) => x.startsWith('src/other.ts is outside')), e.join('\n'));
    assert.ok(e.some((x) => x.startsWith('.github/workflows/x.yml is outside')), e.join('\n'));
    assert.ok(e.some((x) => x.includes('belongs to seat jtadic')), e.join('\n'));
    // a Kiro branch without any trailer
    sh(f.work, 'checkout', '-q', '-b', 'kiro/loose', base);
    write(f.work, 'src/backoffice/b.ts', 'x');
    const h2 = commit(f.work, 'no trailers');
    assert.ok(scopeCheck(f.work, { base, head: h2, branch: 'kiro/loose' }).errors.some((x) => x.includes('no commit carries')));
    // review entry from a seat that is not reviewer_seat
    sh(f.work, 'checkout', '-q', '-b', 'kiro/review', base);
    write(f.work, '.kiro/specs/cards/lanes/card-01.md', `${laneMd('card-01', { next_actor: 'kiro', vtid: 'VTID-00002', ...LANE })}### review\n`);
    const h3 = commit(f.work, 'review', { 'Collab-Session': JT, 'Collab-Review': 'cards/card-01' });
    assert.ok(scopeCheck(f.work, { base, head: h3, branch: 'kiro/review' }).errors.some((x) => x.includes('reviewer_seat is exafyltd')));
    const h4 = (() => { sh(f.work, 'checkout', '-q', '-b', 'kiro/review2', base); write(f.work, '.kiro/specs/cards/lanes/card-01.md', `${laneMd('card-01', { next_actor: 'kiro', vtid: 'VTID-00002', ...LANE })}### review\n`); return commit(f.work, 'review', { 'Collab-Session': EX, 'Collab-Review': 'cards/card-01' }); })();
    assert.deepEqual(scopeCheck(f.work, { base, head: h4, branch: 'kiro/review2' }).errors, []);
  } finally { f.done(); }
});

test('scope-check: a governance path inside paths still needs executor claude; claude lanes may', () => {
  const f = fixture();
  try {
    const base = scopeFixture(f, { executor: 'kiro', paths: ['**'] });
    write(f.work, 'CLAUDE.md', 'x');
    const head = commit(f.work, 'w', { 'Collab-Session': S1, 'Collab-Lane': 'cards/card-01' });
    assert.ok(scopeCheck(f.work, { base, head }).errors.some((x) => x.includes('governance path')));
  } finally { f.done(); }
  const g = fixture();
  try {
    const base = scopeFixture(g, { executor: 'claude', paths: ['CLAUDE.md'] });
    write(g.work, 'CLAUDE.md', 'y');
    const h2 = commit(g.work, 'w', { 'Collab-Session': S2, 'Collab-Lane': 'cards/card-01' });
    assert.deepEqual(scopeCheck(g.work, { base, head: h2 }).errors, []);
  } finally { f.done(); }
});

test('scope-check: legacy lane without paths is report-only; non-lane PR does not apply; lane file fetched from platform', () => {
  const f = fixture();
  try {
    const base = scopeFixture(f, {});
    write(f.work, 'anything.ts', 'x');
    const head = commit(f.work, 'w', { 'Collab-Session': S1, 'Collab-Lane': 'cards/card-01' });
    const r = scopeCheck(f.work, { base, head });
    assert.deepEqual(r.errors, []);
    assert.ok(r.warnings.some((w) => w.includes('declares no paths')));
    sh(f.work, 'checkout', '-q', '-b', 'feature', base);
    write(f.work, 'x.ts', 'x');
    assert.equal(scopeCheck(f.work, { base, head: commit(f.work, 'plain') }).applies, false);
    // vitana-v1 PR whose lane lives in vitana-platform: fetched through fetchLane
    sh(f.work, 'checkout', '-q', '-b', 'kiro/plat/lane-x', base);
    write(f.work, 'src/backoffice/z.ts', 'x');
    const h3 = commit(f.work, 'w', { 'Collab-Session': JT, 'Collab-Lane': 'plat/lane-x' });
    const asked = [];
    const fetchLane = (p) => { asked.push(p); return laneMd('lane-x', { ...LANE, vtid: 'VTID-00003' }); };
    const r3 = scopeCheck(f.work, { base, head: h3, branch: 'kiro/plat/lane-x', fetchLane });
    assert.deepEqual(asked, ['.kiro/specs/plat/lanes/lane-x.md']);
    assert.equal(r3.source, 'vitana-platform');
    assert.deepEqual(r3.errors, []);
    assert.ok(scopeCheck(f.work, { base, head: h3, branch: 'kiro/plat/lane-x', fetchLane: () => null }).errors.some((x) => x.includes('not found')));
  } finally { f.done(); }
});

test('programme registry: shape, a spec in two programmes, queue --program column', () => {
  const prog = (id, o = {}) => `---\n${Object.entries({ id, title: 'T', status: 'active', priority: 2, ...o })
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.join(', ')}]` : v}`).join('\n')}\n---\n`;
  const f = fixture();
  try {
    write(f.work, 'docs/programs/alpha/program.md', prog('alpha', { specs: ['work:cards'] }));
    write(f.work, 'docs/programs/beta/program.md', prog('beta', { specs: ['work:cards', 'bad spec'], status: 'nope', priority: 9 }));
    write(f.work, '.kiro/specs/cards/handoff.md', planMd());
    commit(f.work, 'reg');
    sh(f.work, 'push', '-q', 'origin', 'main');
    sh(f.work, 'fetch', '-q', 'origin');
    const programs = loadPrograms(f.work, 'origin/main');
    assert.deepEqual(programs.map((p) => p.id).sort(), ['alpha', 'beta']);
    const e = validatePrograms(programs);
    assert.ok(e.some((x) => x.includes('already belongs to programme alpha')));
    assert.ok(e.some((x) => x.includes('status')));
    assert.ok(e.some((x) => x.includes('priority')));
    assert.ok(e.some((x) => x.includes('<repo>:<slug>')));
    assert.deepEqual(validatePrograms([programs.find((p) => p.id === 'alpha')]), []);
    assert.equal(programIndex(programs).get('work:cards'), 'alpha');
    const out = execFileSync('node', [path.join(path.dirname(fileURLToPath(import.meta.url)), 'queue.mjs'), '--repo', f.work, '--program', 'alpha'], { encoding: 'utf8' });
    assert.match(out, /\| work \| alpha \| cards \|/);
  } finally { f.done(); }
});

test('validate: a lane whose spec lives in the other repo is read through fetchLane', () => {
  const f = fixture();
  try {
    const base = sh(f.work, 'rev-parse', 'HEAD');
    sh(f.work, 'checkout', '-q', '-b', 'kiro/plat/lane-x');
    write(f.work, 'src/a.ts', 'x');
    const head = commit(f.work, 'w', { 'Collab-Session': JT, 'Collab-Lane': 'plat/lane-x' });
    assert.ok(validateRange(f.work, { base, head }).errors.some((e) => e.includes('does not exist')));
    const fetchLane = () => laneMd('lane-x', { claimed_by: JT });
    assert.deepEqual(validateRange(f.work, { base, head, branch: 'kiro/plat/lane-x', fetchLane }).errors, []);
    const other = () => laneMd('lane-x', { claimed_by: EX });
    assert.ok(validateRange(f.work, { base, head, fetchLane: other }).errors.some((e) => e.includes('claimed_by')));
  } finally { f.done(); }
});

test('VTID-05214: a ci-plan-spar commit may take a plan drafted → approved and write VTIDs into ready lanes; nobody else may', () => {
  const f = fixture();
  try {
    write(f.work, '.kiro/specs/cards/handoff.md', planMd());
    write(f.work, '.kiro/specs/cards/lanes/a.md', laneMd('a', { next_actor: 'kiro' }));
    const base = commit(f.work, 'plan', { 'Collab-Session': S1, 'Collab-Lane': 'cards/_plan' });
    sh(f.work, 'push', '-q', 'origin', 'main');
    sh(f.work, 'checkout', '-q', '-b', 'kiro/cards/_plan');
    write(f.work, '.kiro/specs/cards/handoff.md', planMd({ state: 'approved', sparring_record: 'x.md', vtids: ['VTID-09001'], next_actor: 'kiro' }));
    write(f.work, '.kiro/specs/cards/lanes/a.md', laneMd('a', { next_actor: 'kiro', vtid: 'VTID-09001' }));
    const head = commit(f.work, 'spar', { 'Collab-Session': 'ci-plan-spar', 'Collab-Lane': 'cards/_plan' });
    assert.deepEqual(validateRange(f.work, { base, head }).errors, []);
    // the same change from a normal session is refused (illegal transition + lane edit)
    sh(f.work, 'checkout', '-q', '-b', 'other', base);
    write(f.work, '.kiro/specs/cards/handoff.md', planMd({ state: 'approved', sparring_record: 'x.md', vtids: ['VTID-09001'], next_actor: 'kiro' }));
    write(f.work, '.kiro/specs/cards/lanes/a.md', laneMd('a', { next_actor: 'kiro', vtid: 'VTID-09001' }));
    const h2 = commit(f.work, 'spar', { 'Collab-Session': S2, 'Collab-Lane': 'cards/_plan' });
    const e = validateRange(f.work, { base, head: h2 }).errors;
    assert.ok(e.some((x) => x.includes('illegal transition')), e.join('\n'));
    assert.ok(e.some((x) => x.includes('lanes/a.md')), e.join('\n'));
    // ci-plan-spar may not move a lane out of ready
    sh(f.work, 'checkout', '-q', '-b', 'third', base);
    write(f.work, '.kiro/specs/cards/lanes/a.md', laneMd('a', { next_actor: 'kiro', vtid: 'VTID-09001', state: 'executing' }));
    const h3 = commit(f.work, 'x', { 'Collab-Session': 'ci-plan-spar', 'Collab-Lane': 'cards/_plan' });
    assert.ok(validateRange(f.work, { base, head: h3 }).errors.some((x) => x.includes('lanes/a.md')));
  } finally { f.done(); }
});

test('VTID-05213 review: a lane PR cannot widen its own permissions; Claude may adjust a claude lane', () => {
  const f = fixture();
  try {
    const base = scopeFixture(f, LANE);
    write(f.work, '.kiro/specs/cards/lanes/card-01.md', laneMd('card-01', { ...LANE, executor: 'claude', paths: ['**'], state: 'executing', vtid: 'VTID-00002', claimed_by: JT }));
    write(f.work, '.github/workflows/evil.yml', 'x');
    const head = commit(f.work, 'widen', { 'Collab-Session': JT, 'Collab-Lane': 'cards/card-01' });
    const e = scopeCheck(f.work, { base, head, branch: 'kiro/cards/card-01' }).errors;
    assert.ok(e.some((x) => x.includes('executor, paths changed in a lane PR')), e.join('\n'));
    assert.ok(e.some((x) => x.startsWith('.github/workflows/evil.yml is outside')), 'judged against the base paths: ' + e.join('\n'));
    // a Claude session on a claude lane may extend the paths it works in
    sh(f.work, 'checkout', '-q', 'main');
    write(f.work, '.kiro/specs/cards/lanes/card-01.md', laneMd('card-01', { next_actor: 'claude', vtid: 'VTID-00002', executor: 'claude', paths: ['a/**'] }));
    const b2 = commit(f.work, 'claude lane', { 'Collab-Session': S2, 'Collab-Lane': 'cards/_plan' });
    sh(f.work, 'checkout', '-q', '-b', 'claude/x', b2);
    write(f.work, '.kiro/specs/cards/lanes/card-01.md', laneMd('card-01', { next_actor: 'claude', vtid: 'VTID-00002', executor: 'claude', paths: ['a/**', 'b/**'], state: 'executing' }));
    write(f.work, 'b/x.ts', 'x');
    const h2 = commit(f.work, 'extend', { 'Collab-Session': S2, 'Collab-Lane': 'cards/card-01' });
    assert.deepEqual(scopeCheck(f.work, { base: b2, head: h2 }).errors, []);
  } finally { f.done(); }
});

test('VTID-05213 review: unanchored globs that reach governance files are refused for Kiro lanes', () => {
  for (const g of ['**/*.yml', '**/*.mjs', '*.md', '**/SKILL.md', '.*/**']) assert.ok(globTouchesGovernance(g), g);
  assert.ok(!globTouchesGovernance('src/**/*.tsx'));
});

test('VTID-05213 review: seats must exist in areas.yaml; a touched spec must be in a programme once the registry exists', () => {
  const f = fixture();
  try {
    write(f.work, 'docs/programs/areas.yaml', '# x\nseats:\n  jtadic:   { account: a }\n  exafyltd: { account: b }\nareas:\n  frontend:\n    seat: exafyltd\n');
    write(f.work, '.kiro/specs/cards/handoff.md', planMd());
    write(f.work, '.kiro/specs/cards/lanes/a.md', laneMd('a', { seat: 'nobody', reviewer_seat: 'claude' }));
    write(f.work, '.kiro/specs/cards/lanes/b.md', laneMd('b', { seat: 'jtadic', reviewer_seat: 'unknown' }));
    const head = commit(f.work, 'x');
    const seats = loadSeats(f.work, head);
    assert.deepEqual([...seats].sort(), ['exafyltd', 'jtadic']);
    const touched = ['.kiro/specs/cards/lanes/a.md', '.kiro/specs/cards/lanes/b.md'];
    const e = validateRegistry(f.work, { head, touched, repoName: 'work', seats, programs: [] });
    assert.ok(e.some((x) => x.includes('seat "nobody"')));
    assert.ok(e.some((x) => x.includes('reviewer_seat "unknown"')));
    assert.equal(e.length, 2);
    const prog = [{ id: 'p', path: 'docs/programs/p/program.md', fm: { specs: ['work:other'] } }];
    assert.ok(validateRegistry(f.work, { head, touched, repoName: 'work', seats: null, programs: prog }).some((x) => x.includes('not listed by any')));
    assert.deepEqual(validateRegistry(f.work, { head, touched, repoName: 'work', seats: null, programs: [{ ...prog[0], fm: { specs: ['work:cards'] } }] }), []);
  } finally { f.done(); }
});

// ── collab-queue-perf / queue-batch-read: batched reads ──

// The implementation of collect()/listClaims() before the batched read (origin/main a7433dfef), kept verbatim as the
// reference the new one must equal. Private git helpers: these calls are NOT counted by gitSpawns.
const REF_CLAIM_PREFIX = 'collab-claim/';
function refGit(repo, args, opts = {}) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trimEnd();
}
function refGitOk(repo, args) {
  try { return refGit(repo, args); } catch { return null; }
}
const refShowFile = (repo, ref, p) => refGitOk(repo, ['show', `${ref}:${p}`]);
function refSpecFilesAt(repo, ref) {
  const out = refGitOk(repo, ['ls-tree', '-r', '--name-only', ref, '--', '.kiro/specs']);
  return out ? out.split('\n').filter((p) => classifyPath(p)) : [];
}
function refDefaultRemoteBranch(repo) {
  const sym = refGitOk(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (sym) return sym;
  for (const b of ['origin/main', 'origin/master']) if (refGitOk(repo, ['rev-parse', '--verify', '-q', b])) return b;
  return null;
}
function listClaimsReference(repo) {
  const out = refGitOk(repo, ['for-each-ref', '--format=%(refname)%09%(objectname)%09%(committerdate:unix)', `refs/remotes/origin/${REF_CLAIM_PREFIX}`]);
  if (!out) return [];
  return out.split('\n').filter(Boolean).map((line) => {
    const [ref, sha, ts] = line.split('\t');
    const key = ref.slice(`refs/remotes/origin/${REF_CLAIM_PREFIX}`.length);
    const msg = refGitOk(repo, ['log', '-1', '--format=%B', sha]) || '';
    const session = (/^Collab-Session:\s*(\S+)/m.exec(msg) || [])[1] || null;
    const [slug, ...rest] = key.split('/');
    return { key, slug, lane: rest.join('/'), sha, session, at: Number(ts) * 1000 };
  });
}
function collectReference(repo, { days = 30, now = Date.now() } = {}) {
  const main = refDefaultRemoteBranch(repo);
  if (!main) throw new Error(`${repo}: no origin/main — run git fetch origin`);
  const best = new Map();
  const consider = (ref, p) => {
    const text = refShowFile(repo, ref, p);
    if (text === null) return;
    const fm = parseFrontMatter(text);
    const prev = best.get(p);
    if (!prev || (fm?.updated || '') > (prev.fm?.updated || '')) best.set(p, { path: p, ref, fm, text, ...classifyPath(p) });
  };
  for (const p of refSpecFilesAt(repo, main)) consider(main, p);
  const since = Math.floor((now - days * 86400000) / 1000);
  const refs = (refGitOk(repo, ['for-each-ref', '--format=%(refname:short)%09%(committerdate:unix)', 'refs/remotes/origin']) || '')
    .split('\n').filter(Boolean).map((l) => l.split('\t'))
    .filter(([r, ts]) => r !== main && r !== 'origin/HEAD' && r !== 'origin' && !r.startsWith(`origin/${REF_CLAIM_PREFIX}`) && Number(ts) >= since);
  for (const [ref] of refs) {
    const changed = refGitOk(repo, ['diff', '--name-only', `${main}...${ref}`, '--', '.kiro/specs']);
    if (!changed) continue;
    for (const p of changed.split('\n')) if (classifyPath(p)) consider(ref, p);
  }
  return { main, files: [...best.values()], claims: listClaimsReference(repo) };
}

/** `sh` with a fixed author/committer date (ISO). */
function shAt(cwd, isoDate, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate } }).trim();
}

const spawnsOf = (fn) => { const before = gitSpawns.count; const value = fn(); return { value, spawns: gitSpawns.count - before }; };

test('catFileBatch: byte-accurate multi-byte, CRLF, empty, no trailing LF, binary, large, missing, newline query — one process', () => {
  const f = fixture();
  try {
    sh(f.work, 'config', 'core.autocrlf', 'false');
    const multi = 'Größe ✓ 🙂\r\nzeile 2\r\n';
    const binary = Buffer.from(Array.from({ length: 512 }, (_, i) => i % 256));
    const large = `${'ü'.repeat(600000)}\n🙂\n`; // > 1 MB of UTF-8
    write(f.work, 'a.md', multi);
    write(f.work, 'empty.md', '');
    write(f.work, 'b.md', 'x');
    write(f.work, 'bin.dat', binary);
    write(f.work, 'large.md', large);
    const sha = commit(f.work, 'blobs subject');
    sh(f.work, 'push', '-q', 'origin', 'main');
    sh(f.work, 'fetch', '-q', 'origin');
    const qs = ['origin/main:a.md', 'origin/main:empty.md', 'origin/main:b.md', 'origin/main:bin.dat', 'origin/main:large.md',
      'origin/main:nope.md', 'bad\nquery', sha, 'origin/main:a.md'];
    const { value: m, spawns } = spawnsOf(() => catFileBatch(f.work, qs));
    assert.equal(spawns, 1);
    assert.equal(m.get('origin/main:a.md'), multi);
    assert.equal(m.get('origin/main:empty.md'), '');
    assert.equal(m.get('origin/main:b.md'), 'x');
    assert.equal(m.get('origin/main:bin.dat'), binary.toString('utf8'));
    assert.equal(m.get('origin/main:large.md'), large);
    assert.equal(m.get('origin/main:nope.md'), null);
    assert.equal(m.get('bad\nquery'), null);
    assert.ok(m.get(sha).includes('\n\nblobs subject'));
    assert.equal(m.size, 8);
    assert.equal(spawnsOf(() => catFileBatch(f.work, ['x\ny'])).spawns, 0, 'nothing sendable → no process');
  } finally { f.done(); }
});

/** Fixture covering every collect() edge case; returns the repo with remote branches + claims fetched. */
function batchFixture() {
  const f = fixture();
  sh(f.work, 'config', 'core.autocrlf', 'false');
  write(f.work, '.kiro/specs/cards/notes.md', 'notes\n');
  write(f.work, '.kiro/specs/gone/handoff.md', planMd({ slug: 'gone' }));
  write(f.work, '.kiro/specs/gone/lanes/g-1.md', laneMd('g-1'));
  write(f.work, '.kiro/specs/cards/lanes/card-03.md', laneMd('card-03'));
  write(f.work, '.kiro/specs/cards/lanes/card-04.md', laneMd('card-04'));
  // CRLF lane file on main
  write(f.work, '.kiro/specs/crlf/handoff.md', planMd({ slug: 'crlf' }).replace(/\n/g, '\r\n'));
  write(f.work, '.kiro/specs/crlf/lanes/c-1.md', laneMd('c-1').replace(/\n/g, '\r\n'));
  seedSpec(f);
  const branch = (name, fn) => {
    sh(f.work, 'checkout', '-q', '-b', name, 'main');
    fn();
    sh(f.work, 'push', '-q', 'origin', name);
    sh(f.work, 'checkout', '-q', 'main');
  };
  const card02 = laneMd('card-02', { next_actor: 'kiro', depends_on: ['card-01'] });
  branch('kiro/cards/card-01', () => {
    write(f.work, '.kiro/specs/cards/lanes/card-01.md', laneMd('card-01', { state: 'executing', vtid: 'VTID-00002', claimed_by: S1, updated: '2026-10-13T11:00Z' }));
    commit(f.work, 'work', { 'Collab-Session': S1, 'Collab-Lane': 'cards/card-01' });
  });
  branch('kiro/cards/revert', () => {
    write(f.work, '.kiro/specs/cards/lanes/card-02.md', laneMd('card-02', { next_actor: 'kiro', updated: '2026-10-13T12:00Z' }));
    commit(f.work, 'change');
    write(f.work, '.kiro/specs/cards/lanes/card-02.md', card02);
    commit(f.work, 'revert');
  });
  branch('kiro/newspec/_plan', () => {
    write(f.work, '.kiro/specs/newspec/handoff.md', planMd({ slug: 'newspec' }));
    write(f.work, '.kiro/specs/newspec/lanes/n-1.md', laneMd('n-1'));
    // added then removed on the branch: must not appear
    write(f.work, '.kiro/specs/newspec/lanes/n-tmp.md', laneMd('n-tmp'));
    commit(f.work, 'plan');
    rmSync(path.join(f.work, '.kiro/specs/newspec/lanes/n-tmp.md'));
    commit(f.work, 'drop tmp');
  });
  branch('kiro/old/x', () => {
    write(f.work, '.kiro/specs/cards/lanes/card-02.md', laneMd('card-02', { next_actor: 'kiro', updated: '2026-10-14T00:00Z' }));
    sh(f.work, 'add', '-A');
    shAt(f.work, '2020-01-01T00:00:00Z', 'commit', '-q', '-m', 'old');
  });
  branch('kiro/gone/revert', () => {
    write(f.work, '.kiro/specs/gone/lanes/g-1.md', laneMd('g-1', { updated: '2026-10-15T00:00Z' }));
    commit(f.work, 'change');
    write(f.work, '.kiro/specs/gone/lanes/g-1.md', laneMd('g-1'));
    commit(f.work, 'revert');
  });
  // A branch that ADDED a lane file (status A) to a spec main later deleted: old and new both keep it.
  branch('kiro/gone/add', () => {
    write(f.work, '.kiro/specs/gone/lanes/g-2.md', laneMd('g-2', { updated: '2026-10-15T00:00Z' }));
    commit(f.work, 'add g-2');
  });
  branch('kiro/cards/conflict', () => {
    write(f.work, '.kiro/specs/cards/lanes/card-03.md', laneMd('card-03', { next_actor: 'kiro', updated: '2026-10-13T13:00Z' }));
    commit(f.work, 'branch side');
  });
  branch('kiro/cards/rename', () => {
    sh(f.work, 'mv', '.kiro/specs/cards/notes.md', '.kiro/specs/cards/notes2.md');
    commit(f.work, 'rename');
  });
  branch('kiro/crlf/c-1', () => {
    write(f.work, '.kiro/specs/crlf/lanes/c-1.md', laneMd('c-1', { updated: '2026-10-15T00:00Z' }).replace(/\n/g, '\r\n'));
    // a large lane file (≈ 0.8 MB of log; the old git show had a 1 MB maxBuffer) and a binary-ish one
    write(f.work, '.kiro/specs/crlf/lanes/big.md', `${laneMd('big')}${'### entry ü\n'.repeat(60000)}`);
    write(f.work, '.kiro/specs/crlf/lanes/bin.md', Buffer.concat([Buffer.from(laneMd('bin')), Buffer.from([0, 0xff, 0xfe, 0x80, 0x0a])]));
    commit(f.work, 'crlf work');
  });
  branch('kiro/merged/main-into-branch', () => {
    write(f.work, 'src/x.ts', 'x');
    commit(f.work, 'unrelated');
  });
  // main moves on: delete gone/, change card-03 (conflicts with kiro/cards/conflict), then merge main into branches
  rmSync(path.join(f.work, '.kiro/specs/gone'), { recursive: true, force: true });
  write(f.work, '.kiro/specs/cards/handoff.md', planMd({ state: 'executing', sparring_record: 'x.md', vtids: ['VTID-00001'], executor: 'kiro', next_actor: 'kiro', updated: '2026-10-13T10:30Z' }));
  write(f.work, '.kiro/specs/cards/lanes/card-03.md', laneMd('card-03', { next_actor: 'claude', updated: '2026-10-13T14:00Z' }));
  commit(f.work, 'delete gone specs');
  sh(f.work, 'push', '-q', 'origin', 'main');
  // A clean merge of main must not inject main's files.
  sh(f.work, 'checkout', '-q', 'kiro/merged/main-into-branch');
  sh(f.work, 'merge', '-q', '--no-edit', 'main');
  sh(f.work, 'push', '-q', 'origin', 'kiro/merged/main-into-branch');
  // A merge of main with a conflict resolution in a spec file, plus an edit made only in the merge commit (card-04):
  // both are changes of the branch (three-dot diff) and come from the merge commit itself (`log --cc`).
  sh(f.work, 'checkout', '-q', 'kiro/cards/conflict');
  assert.throws(() => sh(f.work, 'merge', '-q', '--no-edit', 'main'), 'card-03 conflicts');
  write(f.work, '.kiro/specs/cards/lanes/card-03.md', laneMd('card-03', { next_actor: 'kiro', updated: '2026-10-16T00:00Z' }));
  write(f.work, '.kiro/specs/cards/lanes/card-04.md', laneMd('card-04', { next_actor: 'kiro', updated: '2026-10-16T01:00Z' }));
  sh(f.work, 'add', '-A');
  sh(f.work, 'commit', '-q', '--no-edit');
  assert.equal(sh(f.work, 'rev-list', '--parents', '-1', 'HEAD').split(' ').length, 3, 'a merge commit');
  sh(f.work, 'push', '-q', 'origin', 'kiro/cards/conflict');
  sh(f.work, 'checkout', '-q', 'main');
  sh(f.work, 'fetch', '-q', 'origin');
  assert.equal(claim(f.work, 'cards/card-01', S1).ok, true);
  assert.equal(claim(f.work, 'newspec/_plan', S2).ok, true);
  sh(f.work, 'fetch', '-q', '--prune', 'origin');
  return f;
}

test('collect: batched read equals the old implementation; 6 git spawns with origin/HEAD set', () => {
  const f = batchFixture();
  try {
    const { value: got, spawns } = spawnsOf(() => collect(f.work, { days: 30 }));
    assert.equal(spawns, 6, `collect used ${spawns} git processes`);
    const ref = collectReference(f.work, { days: 30 });
    assert.deepEqual(got, ref);
    const at = (p) => got.files.find((x) => x.path === p);
    assert.equal(at('.kiro/specs/cards/lanes/card-01.md').ref, 'origin/kiro/cards/card-01');
    assert.equal(at('.kiro/specs/cards/lanes/card-02.md').ref, 'origin/main', 'reverted branch never wins; old branch outside the window');
    assert.equal(at('.kiro/specs/cards/handoff.md').ref, 'origin/main', 'a merge of main into a branch does not inject main files');
    assert.equal(at('.kiro/specs/cards/lanes/card-03.md').ref, 'origin/kiro/cards/conflict', 'conflict resolution in the merge commit');
    assert.match(at('.kiro/specs/cards/lanes/card-03.md').text, /updated: 2026-10-16T00:00Z/);
    assert.equal(at('.kiro/specs/cards/lanes/card-04.md').ref, 'origin/kiro/cards/conflict', 'a change made only in the merge commit');
    assert.ok(at('.kiro/specs/newspec/handoff.md') && at('.kiro/specs/newspec/lanes/n-1.md'));
    assert.equal(at('.kiro/specs/newspec/lanes/n-tmp.md'), undefined, 'added then removed on the branch');
    assert.equal(at('.kiro/specs/gone/lanes/g-2.md')?.ref, 'origin/kiro/gone/add', 'added on the branch (status A), spec deleted on main');
    assert.equal(at('.kiro/specs/gone/lanes/g-1.md'), undefined, 'reverted change on a deleted spec stays gone');
    assert.equal(got.files.some((x) => x.path.startsWith('.kiro/specs/gone/') && x.path !== '.kiro/specs/gone/lanes/g-2.md'), false);
    assert.equal(at('.kiro/specs/crlf/lanes/c-1.md').ref, 'origin/kiro/crlf/c-1');
    assert.ok(at('.kiro/specs/crlf/lanes/c-1.md').text.includes('\r\n'));
    assert.ok(at('.kiro/specs/crlf/lanes/big.md').text.length > 500000);
    assert.ok(at('.kiro/specs/crlf/lanes/bin.md'));
    assert.deepEqual(got.claims.map((c) => c.session).sort(), [S1, S2].sort());
    assert.equal(JSON.stringify(buildQueue(got, 'r')), JSON.stringify(buildQueue(ref, 'r')));
    assert.equal(renderTable(buildQueue(got, 'r')), renderTable(buildQueue(ref, 'r')));
    // every ref "recent" (the 2020 branch included) and no ref recent at all
    for (const now of [Date.parse('2020-01-05T00:00:00Z'), Date.now() + 400 * 86400000]) {
      const r = spawnsOf(() => collect(f.work, { days: 30, now }));
      assert.ok(r.spawns <= 6, `collect used ${r.spawns} git processes`);
      assert.deepEqual(r.value, collectReference(f.work, { days: 30, now }));
    }
    assert.equal(spawnsOf(() => collect(f.work, { days: 30, now: Date.now() + 400 * 86400000 })).spawns, 4, 'no recent refs → no rev-list/log');
    // origin/HEAD unset: main is found without it, still within the budget of 8
    sh(f.work, 'remote', 'set-head', 'origin', '-d');
    const noHead = spawnsOf(() => collect(f.work, { days: 30 }));
    assert.ok(noHead.spawns <= 8, `collect used ${noHead.spawns} git processes without origin/HEAD`);
    assert.deepEqual(noHead.value, collectReference(f.work, { days: 30 }));
  } finally { f.done(); }
});

// plan.md "Difference from today, accepted" — the guard. This fixture is NOT part of the equality check: a stale branch
// that modified (status M) a lane file main has since deleted. The old three-dot diff brought it back as a row; the
// batched collect() does not.
test('collect guard: a stale branch that modified a lane file main deleted does not bring it back', () => {
  const f = fixture();
  try {
    seedSpec(f);
    write(f.work, '.kiro/specs/gone2/handoff.md', planMd({ slug: 'gone2' }));
    write(f.work, '.kiro/specs/gone2/lanes/g2.md', laneMd('g2'));
    commit(f.work, 'gone2');
    sh(f.work, 'push', '-q', 'origin', 'main');
    sh(f.work, 'checkout', '-q', '-b', 'kiro/gone2/g2', 'main');
    write(f.work, '.kiro/specs/gone2/lanes/g2.md', laneMd('g2', { updated: '2026-10-15T00:00Z' }));
    commit(f.work, 'modify');
    sh(f.work, 'push', '-q', 'origin', 'kiro/gone2/g2');
    sh(f.work, 'checkout', '-q', 'main');
    rmSync(path.join(f.work, '.kiro/specs/gone2'), { recursive: true, force: true });
    commit(f.work, 'delete gone2');
    sh(f.work, 'push', '-q', 'origin', 'main');
    sh(f.work, 'fetch', '-q', 'origin');
    const LANE = '.kiro/specs/gone2/lanes/g2.md';
    assert.equal(collectReference(f.work).files.find((x) => x.path === LANE)?.ref, 'origin/kiro/gone2/g2', 'the old implementation resurrected it');
    const got = collect(f.work);
    assert.equal(got.files.some((x) => x.path === LANE), false);
    assert.ok(got.files.some((x) => x.path === '.kiro/specs/cards/lanes/card-01.md'));
  } finally { f.done(); }
});

test('listClaims: one for-each-ref + one cat-file; equals the old implementation', () => {
  const f = fixture();
  try {
    sh(f.work, 'fetch', '-q', 'origin');
    assert.deepEqual(spawnsOf(() => listClaims(f.work)).value, []);
    assert.equal(claim(f.work, 'cards/card-01', S1).ok, true);
    assert.equal(claim(f.work, 'cards/card-02', S2).ok, true);
    const { value: c, spawns } = spawnsOf(() => listClaims(f.work));
    assert.equal(spawns, 2, `listClaims used ${spawns} git processes`);
    assert.deepEqual(c, listClaimsReference(f.work));
    assert.deepEqual(c.map((x) => x.session), [S1, S2]);
    assert.equal(claim(f.work, 'other/_plan', S2).ok, true);
    assert.equal(spawnsOf(() => listClaims(f.work)).spawns, 2);
    assert.deepEqual(listClaims(f.work), listClaimsReference(f.work));
  } finally { f.done(); }
});

test('collect: spawn count does not grow with branch count (3 and 8 recent branches)', () => {
  const f = fixture();
  try {
    seedSpec(f);
    const addBranches = (from, to) => {
      for (let i = from; i < to; i++) {
        sh(f.work, 'checkout', '-q', '-b', `kiro/cards/b-${i}`, 'main');
        write(f.work, '.kiro/specs/cards/lanes/card-01.md', laneMd('card-01', { next_actor: 'kiro', updated: `2026-10-13T11:${String(i).padStart(2, '0')}Z` }));
        write(f.work, `.kiro/specs/cards/lanes/x-${i}.md`, laneMd(`x-${i}`));
        commit(f.work, `b${i}`);
        sh(f.work, 'push', '-q', 'origin', `kiro/cards/b-${i}`);
      }
      sh(f.work, 'checkout', '-q', 'main');
      sh(f.work, 'fetch', '-q', 'origin');
    };
    addBranches(0, 3);
    const three = spawnsOf(() => collect(f.work));
    assert.equal(three.spawns, 6);
    assert.deepEqual(three.value, collectReference(f.work));
    addBranches(3, 8);
    const eight = spawnsOf(() => collect(f.work));
    assert.equal(eight.spawns, three.spawns);
    assert.deepEqual(eight.value, collectReference(f.work));
    assert.equal(eight.value.files.find((x) => x.path === '.kiro/specs/cards/lanes/card-01.md').ref, 'origin/kiro/cards/b-7');
  } finally { f.done(); }
});

test('collect: spec blobs over 2 MB in total read back in full (maxBuffer)', () => {
  const f = fixture();
  try {
    sh(f.work, 'config', 'core.autocrlf', 'false');
    const body = (n) => `${'### entry ü ✓\n'.repeat(n)}`; // ~17 bytes per line
    for (const id of ['h-1', 'h-2', 'h-3']) write(f.work, `.kiro/specs/heavy/lanes/${id}.md`, `${laneMd(id)}${body(50000)}`);
    write(f.work, '.kiro/specs/heavy/handoff.md', planMd({ slug: 'heavy' }));
    commit(f.work, 'heavy');
    sh(f.work, 'push', '-q', 'origin', 'main');
    sh(f.work, 'checkout', '-q', '-b', 'kiro/heavy/h-1', 'main');
    write(f.work, '.kiro/specs/heavy/lanes/h-1.md', `${laneMd('h-1', { updated: '2026-10-14T00:00Z' })}${body(70000)}`);
    commit(f.work, 'bigger');
    sh(f.work, 'push', '-q', 'origin', 'kiro/heavy/h-1');
    sh(f.work, 'checkout', '-q', 'main');
    sh(f.work, 'fetch', '-q', 'origin');
    const got = collect(f.work);
    const total = got.files.reduce((n, x) => n + Buffer.byteLength(x.text), 0);
    assert.ok(total > 2 * 1024 * 1024, `only ${total} bytes`);
    // No equality with collectReference here: its one `git show` per file had Node's 1 MB maxBuffer and silently
    // dropped the > 1 MB branch copy of h-1.
    for (const id of ['h-2', 'h-3']) assert.equal(got.files.find((x) => x.path === `.kiro/specs/heavy/lanes/${id}.md`).text, `${laneMd(id)}${body(50000)}`.trimEnd());
    const h1 = got.files.find((x) => x.path === '.kiro/specs/heavy/lanes/h-1.md');
    assert.equal(h1.ref, 'origin/kiro/heavy/h-1');
    assert.equal(h1.text, `${laneMd('h-1', { updated: '2026-10-14T00:00Z' })}${body(70000)}`.trimEnd());
  } finally { f.done(); }
});

test('loadPrograms: ls-tree + one cat-file (2 git spawns); same result as one git show per file', () => {
  const prog = (id, o = {}) => `---\n${Object.entries({ id, title: 'T', status: 'active', priority: 2, ...o })
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.join(', ')}]` : v}`).join('\n')}\n---\nbody\n`;
  const f = fixture();
  try {
    for (const id of ['alpha', 'beta', 'gamma']) write(f.work, `docs/programs/${id}/program.md`, prog(id, { specs: [`work:${id}`] }));
    write(f.work, 'docs/programs/delta/notes.md', 'not a programme\n');
    commit(f.work, 'programmes');
    sh(f.work, 'push', '-q', 'origin', 'main');
    sh(f.work, 'fetch', '-q', 'origin');
    const { value, spawns } = spawnsOf(() => loadPrograms(f.work, 'origin/main'));
    assert.equal(spawns, 2, `loadPrograms used ${spawns} git processes`);
    // the old loadPrograms: one `git show <ref>:<path>` per program.md
    const reference = refGit(f.work, ['ls-tree', '-r', '--name-only', 'origin/main', '--', 'docs/programs']).split('\n')
      .map((p) => /^docs\/programs\/([^/]+)\/program\.md$/.exec(p)).filter(Boolean)
      .map((m) => ({ id: m[1], path: m[0], fm: parseFrontMatter(refShowFile(f.work, 'origin/main', m[0])) }));
    assert.deepEqual(value, reference);
    assert.deepEqual(value.map((p) => p.id), ['alpha', 'beta', 'gamma']);
    assert.deepEqual(spawnsOf(() => loadPrograms(f.work, 'origin/nope')), { value: [], spawns: 1 });
  } finally { f.done(); }
});

// ── VTID-05276 (kiro-autonomy-fallback/scope-check): governance by the reviewer agent, protected gate files,
//    lanes from the open plan( PR, pm-agent exemption, Collab handoff check ──

const AG = 'agent:vitana-lane-reviewer';
const AGS = 'agent-vitana-lane-reviewer-202610201700-ab12';
const KA = { executor: 'kiro', seat: 'jtadic', reviewer_seat: AG, paths: ['.kiro/steering/**', 'src/backoffice/**'] };
const HEAD40 = 'c'.repeat(40);
const planLane = (laneFm, o = {}) => ({
  text: laneMd('card-01', { next_actor: 'kiro', vtid: 'VTID-00002', ...laneFm }),
  handoffText: planMd({ state: 'approved', sparring_record: 'x.md', vtids: ['VTID-00002'], executor: 'kiro', next_actor: 'kiro' }),
  lastSession: 'ci-plan-spar', pr: 4224, sha: HEAD40, ...o,
});
const SECTION_43 = ['CLAUDE.md', 'scripts/collab/plan-spar.mjs', 'scripts/collab/queue.mjs', 'scripts/collab/protected-gate-files.json',
  'services/gateway/src/services/plan-sparring/**', 'services/gateway/src/services/project-manager/governance.ts',
  '.github/workflows/PLAN-SPAR.yml', '.github/workflows/PR-GATE.yml', '.github/workflows/AWS-PROD-*.yml',
  '.kiro/agents/vitana-lane-reviewer.md', 'supabase/migrations/*vtid_ledger*.sql', 'supabase/migrations/*plan_sparring*.sql'];

test('VTID-05276 T1-T3: validateLane — kiro lane with the agent reviewer may declare governance paths, never a protected gate file; the agent needs executor kiro', () => {
  const v = (o) => validateLane(parseFrontMatter(laneMd('a', o)), 'cards', 'a', new Set(['a']));
  assert.deepEqual(v({ executor: 'kiro', seat: 'jtadic', reviewer_seat: AG, paths: ['.kiro/steering/**', '.claude/rules/collaboration.md'] }), []);
  for (const g of ['CLAUDE.md', 'scripts/collab/queue.mjs', '.github/workflows/**', '.github/workflows/PLAN-SPAR.yml', 'scripts/collab/**']) {
    const e = v({ executor: 'kiro', seat: 'jtadic', reviewer_seat: AG, paths: [g] });
    assert.ok(e.some((x) => x.includes('protected gate')), `${g}: ${e.join('\n')}`);
  }
  const t3 = v({ executor: 'claude', seat: 'jtadic', reviewer_seat: AG, paths: ['src/**'] });
  assert.ok(t3.some((x) => x.includes('executor: kiro')), t3.join('\n'));
  // without the agent a Kiro governance lane is refused exactly as before
  assert.ok(v({ executor: 'kiro', seat: 'jtadic', reviewer_seat: 'exafyltd', paths: ['.kiro/steering/**'] }).some((x) => x.includes('governance')));
});

test('VTID-05276 guard: validateLane does not newly refuse Kiro lanes on non-governance gate code (scope-check refuses the change itself)', () => {
  const v = (o) => validateLane(parseFrontMatter(laneMd('a', o)), 'cards', 'a', new Set(['a']));
  assert.deepEqual(v({ executor: 'kiro', seat: 'exafy', reviewer_seat: 'exafyltd', paths: ['services/gateway/src/services/project-manager/**'] }), []);
  assert.deepEqual(v({ executor: 'kiro', seat: 'exafy', reviewer_seat: 'exafyltd', paths: ['.kiro/agents/vitana-lane-reviewer.md'] }), []);
});

test('VTID-05276 T4: scope-check passes a governance file on a kiro lane with the agent reviewer from main', () => {
  const f = fixture();
  try {
    const base = scopeFixture(f, KA);
    write(f.work, '.kiro/steering/x.md', 'x');
    const head = commit(f.work, 'w', { 'Collab-Session': JT, 'Collab-Lane': 'cards/card-01' });
    assert.deepEqual(scopeCheck(f.work, { base, head, branch: 'kiro/cards/card-01' }).errors, []);
  } finally { f.done(); }
});

test('VTID-05276 T5: protected gate files never pass for a kiro lane, whatever its reviewer or paths', () => {
  const f = fixture();
  try {
    const base = scopeFixture(f, { executor: 'kiro', seat: 'jtadic', reviewer_seat: AG, paths: ['**'] });
    for (const p of ['CLAUDE.md', 'scripts/collab/queue.mjs', 'services/gateway/src/services/plan-sparring/x.ts', '.kiro/agents/vitana-lane-reviewer.md']) write(f.work, p, 'x');
    const head = commit(f.work, 'w', { 'Collab-Session': JT, 'Collab-Lane': 'cards/card-01' });
    const e = scopeCheck(f.work, { base, head, branch: 'kiro/cards/card-01' }).errors;
    for (const p of ['CLAUDE.md', 'scripts/collab/queue.mjs', 'services/gateway/src/services/plan-sparring/x.ts', '.kiro/agents/vitana-lane-reviewer.md']) {
      assert.ok(e.some((x) => x.startsWith(`${p} is a protected gate file`)), `${p}: ${e.join('\n')}`);
    }
  } finally { f.done(); }
});

test('VTID-05276 T6: a lane PR cannot grant itself the agent reviewer', () => {
  const f = fixture();
  try {
    const base = scopeFixture(f, { ...KA, reviewer_seat: 'exafyltd' });
    write(f.work, '.kiro/specs/cards/lanes/card-01.md', laneMd('card-01', { ...KA, state: 'executing', vtid: 'VTID-00002', claimed_by: JT }));
    write(f.work, '.kiro/steering/x.md', 'x');
    const head = commit(f.work, 'w', { 'Collab-Session': JT, 'Collab-Lane': 'cards/card-01' });
    const e = scopeCheck(f.work, { base, head, branch: 'kiro/cards/card-01' }).errors;
    assert.ok(e.some((x) => x.includes('reviewer_seat changed in a lane PR')), e.join('\n'));
    assert.ok(e.some((x) => x.startsWith('.kiro/steering/x.md is a governance path') && x.includes(AG)), e.join('\n'));
  } finally { f.done(); }
});

test('VTID-05276 T7: an agent review entry passes scope-check and validate; the same entry from a Kiro seat fails', () => {
  const f = fixture();
  try {
    const base = scopeFixture(f, KA);
    const fmSame = laneMd('card-01', { next_actor: 'kiro', vtid: 'VTID-00002', ...KA });
    write(f.work, '.kiro/specs/cards/lanes/card-01.md', `${fmSame}### 2026-10-20T17:00Z · ${AGS} · review\nreview: accept\n`);
    const head = commit(f.work, 'review', { 'Collab-Session': AGS, 'Collab-Review': 'cards/card-01', 'Collab-Verdict': 'accept',
      'Collab-Reviewer': 'agent:vitana-lane-reviewer (claude-sonnet-5.5)', 'Collab-Reviewed-Head': HEAD40 });
    assert.deepEqual(scopeCheck(f.work, { base, head, branch: 'kiro/cards/card-01' }).errors, []);
    assert.deepEqual(validateRange(f.work, { base, head }).errors, []);
    sh(f.work, 'checkout', '-q', '-b', 'kiro/review-seat', base);
    write(f.work, '.kiro/specs/cards/lanes/card-01.md', `${fmSame}### review\n`);
    const h2 = commit(f.work, 'review', { 'Collab-Session': EX, 'Collab-Review': 'cards/card-01' });
    const e = scopeCheck(f.work, { base, head: h2, branch: 'kiro/review-seat' }).errors;
    assert.ok(e.some((x) => x.includes(`reviewer_seat is ${AG}`)), e.join('\n'));
  } finally { f.done(); }
});

test('VTID-05276 T8: agent session ids — format, agentOf, session-id for a listed agent only', () => {
  assert.ok(isSessionId(AGS));
  assert.equal(Q.agentOf(AGS), AG);
  assert.equal(Q.agentOf(JT), '');
  assert.equal(seatOf(AGS), '');
  assert.ok(Q.isReviewerAgent(AG));
  assert.ok(!Q.isReviewerAgent('agent:other'));
  const id = sessionId(AG, new Date(Date.UTC(2026, 9, 20, 17, 0)));
  assert.match(id, /^agent-vitana-lane-reviewer-202610201700-[0-9a-f]{4}$/);
  assert.ok(isSessionId(id));
  assert.throws(() => sessionId('agent:other'));
  assert.throws(() => sessionId('claude'));
  for (const bad of ['agent-202610201700-ab12', 'agent-X-202610201700-ab12', 'agent-vitana-lane-reviewer-2026102017-ab12']) assert.ok(!isSessionId(bad), bad);
});

// VTID-05407 (reviewer-session-id-permission): the reviewer agent now runs `queue.mjs session-id --agent
// agent:vitana-lane-reviewer` itself (no --seat) and uses the printed id. The agent's own round-trip and the
// "a reviewer agent id names no seat" guard are the contract the agent relies on; T8 covers the id shape and
// agentOf() round-trip but not the seat-rejection path, so assert it explicitly here.
test('VTID-05407: reviewer session-id round-trips to its agent and a reviewer id names no seat', () => {
  // The id the reviewer mints for itself (agent, no seat) round-trips back to the reviewer_seat the validator checks.
  const id = sessionId(AG, new Date(Date.UTC(2026, 9, 29, 10, 49)));
  assert.match(id, /^agent-vitana-lane-reviewer-202610291049-[0-9a-f]{4}$/);
  assert.ok(isSessionId(id), 'minted reviewer id matches SESSION_RE');
  assert.equal(Q.agentOf(id), AG, 'agentOf(sessionId(agent)) === agent — the scope-check accepts-the-entry invariant');
  // A reviewer agent id names no seat: passing a --seat is a usage error, with that exact message. The reviewer
  // runs the command with no --seat; this guard is why a stray seat can never produce a mis-scoped reviewer id.
  assert.throws(() => sessionId(AG, new Date(Date.UTC(2026, 9, 29, 10, 49)), 'someseat'),
    /a reviewer agent id names no seat/);
  assert.throws(() => sessionId(AG, new Date(Date.UTC(2026, 9, 29, 10, 49)), 'exafy'),
    /a reviewer agent id names no seat/);
});

test('VTID-05276 T9: a lane only on a qualifying open plan( PR is read from there and trusted', () => {
  const f = fixture();
  try {
    const base = sh(f.work, 'rev-parse', 'HEAD');
    sh(f.work, 'checkout', '-q', '-b', 'kiro/cards/card-01');
    write(f.work, 'src/backoffice/a.ts', 'x');
    const head = commit(f.work, 'w', { 'Collab-Session': JT, 'Collab-Lane': 'cards/card-01' });
    const asked = [];
    const fetchPlanLane = (slug, p) => { asked.push([slug, p]); return planLane(LANE); };
    const r = scopeCheck(f.work, { base, head, branch: 'kiro/cards/card-01', fetchPlanLane });
    assert.deepEqual(asked[0], ['cards', '.kiro/specs/cards/lanes/card-01.md']);
    assert.equal(r.source, 'plan-pr');
    assert.deepEqual(r.errors, []);
  } finally { f.done(); }
});

test('VTID-05276 T10: plan-PR permissions win over a lane file the lane PR widened', () => {
  const f = fixture();
  try {
    const base = sh(f.work, 'rev-parse', 'HEAD');
    sh(f.work, 'checkout', '-q', '-b', 'kiro/cards/card-01');
    write(f.work, '.kiro/specs/cards/lanes/card-01.md', laneMd('card-01', { ...LANE, paths: ['**'], state: 'executing', vtid: 'VTID-00002', claimed_by: JT }));
    write(f.work, 'src/other.ts', 'x');
    const head = commit(f.work, 'w', { 'Collab-Session': JT, 'Collab-Lane': 'cards/card-01' });
    const e = scopeCheck(f.work, { base, head, branch: 'kiro/cards/card-01', fetchPlanLane: () => planLane(LANE) }).errors;
    assert.ok(e.some((x) => x.startsWith('src/other.ts is outside')), e.join('\n'));
    assert.ok(e.some((x) => x.includes('paths changed in a lane PR')), e.join('\n'));
  } finally { f.done(); }
});

test('VTID-05276 T11: an unqualified plan( PR is never trusted for a governance change', () => {
  const variants = {
    drafted: { handoffText: planMd({ state: 'drafted', executor: 'kiro', next_actor: 'kiro' }) },
    'no sparring record': { handoffText: planMd({ state: 'approved', vtids: ['VTID-00002'], executor: 'kiro', next_actor: 'kiro' }) },
    'not ci-plan-spar': { lastSession: JT },
    'vtid not in handoff': { handoffText: planMd({ state: 'approved', sparring_record: 'x.md', vtids: ['VTID-00009'], executor: 'kiro', next_actor: 'kiro' }) },
  };
  const f = fixture();
  try {
    const base = sh(f.work, 'rev-parse', 'HEAD');
    sh(f.work, 'checkout', '-q', '-b', 'kiro/cards/card-01');
    write(f.work, '.kiro/steering/x.md', 'x');
    const head = commit(f.work, 'w', { 'Collab-Session': JT, 'Collab-Lane': 'cards/card-01' });
    for (const [name, o] of Object.entries(variants)) {
      assert.equal(Q.planLaneQualifies(planLane(KA, o)), false, name);
      const e = scopeCheck(f.work, { base, head, branch: 'kiro/cards/card-01', fetchPlanLane: () => planLane(KA, o) }).errors;
      assert.ok(e.some((x) => x.startsWith('.kiro/steering/x.md is a governance path')), `${name}: ${e.join('\n')}`);
    }
    assert.equal(Q.planLaneQualifies(planLane(KA)), true);
    assert.deepEqual(scopeCheck(f.work, { base, head, branch: 'kiro/cards/card-01', fetchPlanLane: () => planLane(KA) }).errors, []);
    // fail closed: the fetcher found nothing → not found, never a pass
    assert.ok(scopeCheck(f.work, { base, head, branch: 'kiro/cards/card-01', fetchPlanLane: () => null }).errors.some((x) => x.includes('not found')));
  } finally { f.done(); }
});

test('VTID-05276 T12: a lane file only in the lane PR head gets no governance exemption', () => {
  const f = fixture();
  try {
    const base = sh(f.work, 'rev-parse', 'HEAD');
    sh(f.work, 'checkout', '-q', '-b', 'kiro/cards/card-01');
    write(f.work, '.kiro/specs/cards/lanes/card-01.md', laneMd('card-01', { ...KA, state: 'executing', vtid: 'VTID-00002', claimed_by: JT }));
    write(f.work, '.kiro/steering/x.md', 'x');
    const head = commit(f.work, 'w', { 'Collab-Session': JT, 'Collab-Lane': 'cards/card-01' });
    const e = scopeCheck(f.work, { base, head, branch: 'kiro/cards/card-01' }).errors;
    assert.ok(e.some((x) => x.startsWith('.kiro/steering/x.md is a governance path') && x.includes(AG)), e.join('\n'));
  } finally { f.done(); }
});

test('VTID-05276 T13: findPlanPr picks the one same-repo plan(<slug>) PR; ghPlanLaneFetcher reads the ci-plan-spar revision and fails closed', () => {
  const prs = [
    { number: 1, title: 'plan(cards): x', headRefOid: HEAD40, isCrossRepository: false },
    { number: 2, title: 'plan(cards-2): y', headRefOid: HEAD40, isCrossRepository: false },
    { number: 3, title: 'plan(cards): fork', headRefOid: HEAD40, isCrossRepository: true },
    { number: 4, title: 'VTID-00001: plan(cards)', headRefOid: HEAD40, isCrossRepository: false },
  ];
  assert.equal(Q.findPlanPr(prs, 'cards').number, 1);
  assert.equal(Q.findPlanPr([...prs, { number: 5, title: 'plan(cards): again', headRefOid: HEAD40, isCrossRepository: false }], 'cards'), null);
  assert.equal(Q.findPlanPr([], 'cards'), null);
  const lanePath = '.kiro/specs/cards/lanes/card-01.md';
  const spar = 'd'.repeat(40);
  const calls = [];
  const run = (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'pr') return JSON.stringify(prs);
    const url = args[args.length - 1];
    if (url.startsWith('repos/o/r/commits?')) return JSON.stringify([
      { sha: 'e'.repeat(40), commit: { message: 'later edit\n\nCollab-Session: kiro-exafyltd-202610201700-ab12' } },
      { sha: spar, commit: { message: 'spar\n\nCollab-Session: ci-plan-spar\nCollab-Lane: cards/_plan' } },
    ]);
    if (url === `repos/o/r/contents/.kiro/specs/cards/handoff.md?ref=${HEAD40}`) return 'HANDOFF';
    if (url === `repos/o/r/contents/${lanePath}?ref=${spar}`) return 'LANE@SPAR';
    throw new Error(`unexpected ${url}`);
  };
  const got = Q.ghPlanLaneFetcher('o/r', run)('cards', lanePath);
  assert.deepEqual(got, { text: 'LANE@SPAR', handoffText: 'HANDOFF', lastSession: 'ci-plan-spar', pr: 1, sha: spar });
  assert.equal(Q.ghPlanLaneFetcher('o/r', () => { throw new Error('gh: rate limited'); })('cards', lanePath), null);
  assert.equal(Q.ghPlanLaneFetcher('o/r', (a) => (a[0] === 'pr' ? 'not json' : ''))('cards', lanePath), null);
});

test('VTID-05276 T14: the registry accepts the reviewer agent as reviewer_seat', () => {
  const f = fixture();
  try {
    write(f.work, 'docs/programs/areas.yaml', 'seats:\n  jtadic:   { account: a }\n');
    write(f.work, '.kiro/specs/cards/handoff.md', planMd());
    write(f.work, '.kiro/specs/cards/lanes/a.md', laneMd('a', { seat: 'jtadic', reviewer_seat: AG }));
    const head = commit(f.work, 'x');
    const seats = loadSeats(f.work, head);
    assert.deepEqual(validateRegistry(f.work, { head, touched: ['.kiro/specs/cards/lanes/a.md'], repoName: 'work', seats, programs: [] }), []);
  } finally { f.done(); }
});

test('VTID-05276 T15: pm-agent lane-state commits are exempt from one-session-per-lane and claimed_by; any other change is refused', () => {
  const f = fixture();
  try {
    const IR = { ...LANE, state: 'in-review', claimed_by: JT };
    const base = scopeFixture(f, IR);
    const at = (o) => laneMd('card-01', { next_actor: 'kiro', vtid: 'VTID-00002', ...IR, ...o });
    write(f.work, '.kiro/specs/cards/lanes/card-01.md', `${at({})}### work\n`);
    write(f.work, 'src/backoffice/a.ts', 'x');
    commit(f.work, 'work', { 'Collab-Session': JT, 'Collab-Lane': 'cards/card-01' });
    write(f.work, '.kiro/specs/cards/lanes/card-01.md', `${at({ state: 'verified', updated: '2026-10-20T18:00Z' })}### work\n### pm · verified\n`);
    const head = commit(f.work, 'pm W1', { 'Collab-Session': 'pm-agent', 'Collab-Lane': 'cards/card-01' });
    assert.deepEqual(validateRange(f.work, { base, head, branch: 'kiro/cards/card-01' }).errors, []);
    assert.deepEqual(scopeCheck(f.work, { base, head, branch: 'kiro/cards/card-01' }).errors, []);
    write(f.work, '.kiro/specs/cards/lanes/card-01.md', `${at({ state: 'verified', updated: '2026-10-20T18:00Z', paths: ['**'] })}### work\n### pm · verified\n`);
    const h2 = commit(f.work, 'pm widens', { 'Collab-Session': 'pm-agent', 'Collab-Lane': 'cards/card-01' });
    const e = validateRange(f.work, { base, head: h2, branch: 'kiro/cards/card-01' }).errors;
    assert.ok(e.some((x) => x.includes('pm-agent may only change') && x.includes('paths')), e.join('\n'));
  } finally { f.done(); }
  const g = fixture();
  try {
    // W2 bookkeeping: a pm-agent `_plan` commit moves a verified lane to done
    const V = { ...LANE, state: 'verified', claimed_by: JT };
    const base = scopeFixture(g, V);
    sh(g.work, 'checkout', '-q', '-b', 'pm-agent/cards', base);
    const { claimed_by: _released, ...done } = { ...V, state: 'done' };
    write(g.work, '.kiro/specs/cards/lanes/card-01.md', `${laneMd('card-01', { next_actor: 'kiro', vtid: 'VTID-00002', ...done })}### pm · done\n`);
    const head = commit(g.work, 'pm W2', { 'Collab-Session': 'pm-agent', 'Collab-Lane': 'cards/_plan' });
    assert.deepEqual(validateRange(g.work, { base, head, branch: 'pm-agent/cards' }).errors, []);
  } finally { g.done(); }
});

test('VTID-05276 T16: protected-gate-files.json parses, equals plan §4.3 and the loaded list; every entry is governance or gate code', () => {
  const json = JSON.parse(readFileSync(new URL('./protected-gate-files.json', import.meta.url), 'utf8'));
  assert.ok(Array.isArray(json.globs) && json.globs.length > 0);
  assert.deepEqual(json.globs, SECTION_43);
  assert.deepEqual([...Q.PROTECTED_GATE_PATHS], SECTION_43);
  assert.deepEqual(Q.PROTECTED_GATE_BUILTIN, SECTION_43, 'the compiled-in copy (single-file runs in CI and vitana-v1) equals the JSON');
  const GATE_CODE = ['services/gateway/src/services/plan-sparring/', 'services/gateway/src/services/project-manager/governance.ts',
    '.kiro/agents/vitana-lane-reviewer.md', 'supabase/migrations/'];
  for (const g of json.globs) {
    assert.equal(typeof g, 'string');
    assert.ok(Q.globTouchesGovernance(g) || GATE_CODE.some((p) => g.startsWith(p)), g);
    globToRegex(g); // compiles
  }
});

test('VTID-05276 T17: PR-GATE runs a "Collab handoff" job over every collab test and Lane scope with the base revision\'s checker', () => {
  const y = readFileSync(new URL('../../.github/workflows/PR-GATE.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const jobs = y.slice(y.indexOf('\njobs:\n')).split(/\n(?= {2}[a-z][\w-]*:\n)/).slice(1);
  const job = (name) => jobs.find((j) => j.includes(`\n    name: ${name}\n`));
  const collab = job('Collab handoff');
  assert.ok(collab, 'a job named exactly "Collab handoff"');
  assert.match(collab, /node --test scripts\/collab\/\*\.test\.mjs/);
  assert.match(collab, /queue\.mjs validate/);
  assert.doesNotMatch(collab, /continue-on-error/);
  const lane = job('Lane scope');
  assert.ok(lane, 'a job named "Lane scope"');
  assert.match(lane, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(lane, /git show "\$BASE:scripts\/collab\/queue\.mjs" > "\$RUNNER_TEMP\/queue\.mjs"/);
  assert.match(lane, /node "\$RUNNER_TEMP\/queue\.mjs" scope-check/);
  assert.doesNotMatch(lane, /node scripts\/collab\/queue\.mjs scope-check/);
});

// ── VTID-05351 (plan pipeline-lane-state-efficiency): a chain of legal transitions in one closing record ──

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const PR_URL = 'https://github.com/exafyltd/vitana-platform/pull/4400';
const MERGE = 'c0ffee1234567890c0ffee1234567890c0ffee12';
/** Lane file text: front matter + `## Log` + entries (each `[header, body]`). */
const laneLog = (fm, entries) => `---\n${Object.entries({ lane: 'card-01', next_actor: 'kiro', updated: '2026-10-27T12:00Z', vtid: 'VTID-00002', ...fm })
  .map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n# Lane\n\n## Log\n${entries.map(([h, b]) => `### ${h}\n${b ? `${b}\n` : ''}`).join('\n')}`;
const E = {
  created: ['2026-10-27T10:00Z · kiro-x · ready', 'Lane created.'],
  claim: ['2026-10-27T10:05Z · kiro-x · ready → executing', 'Claimed.'],
  review: (v, h, t = '2026-10-27T11:00Z') => [`${t} · agent-vitana-lane-reviewer-202610271100-ab12 · review: ${v}`, `review: ${v}\nhead: ${h}\nreviewer: agent:vitana-lane-reviewer (claude-opus-5.5)`],
  inReview: (t = '2026-10-27T11:10Z') => [`${t} · kiro-x · executing → in-review`, `PR ${PR_URL} opened.`],
  verified: (t = '2026-10-27T11:20Z', body = 'Accept on the current head; checks green.') => [`${t} · kiro-x · in-review → verified`, body],
  done: (t = '2026-10-27T11:30Z', body = `Lane closed under §7b. Merge \`${MERGE}\` (#4400).`) => [`${t} · kiro-x · verified → done`, body],
};
/** A review-only commit that appended `entry` (what reviewBacking returns). */
const backed = (entry, verdict, reviewedHead) => ({ verdict, reviewedHead, appended: `\n### ${entry[0]}\n${entry[1]}\n` });
const chain = (kind, before, after, o = {}) => Q.transitionChain(kind, before, after, { reviewCommits: [], ...o });
const hasErr = (errs, s) => assert.ok(errs.some((e) => e.includes(s)), `expected an error containing "${s}" in:\n${errs.join('\n')}`);

test('transitionChain: valid lane chains (both merge-sha conventions, changes loop, intermediate parked)', () => {
  const base = laneLog({ state: 'executing' }, [E.created, E.claim]);
  // executing → in-review → verified → done, the accept already in the base log (stored by an earlier PR).
  const baseWithReview = laneLog({ state: 'executing' }, [E.created, E.claim, E.review('accept', HEAD_A)]);
  const full = laneLog({ state: 'done' }, [E.created, E.claim, E.review('accept', HEAD_A), E.inReview(), E.verified(), E.done()]);
  assert.deepEqual(chain('lane', baseWithReview, full), []);
  // merge: <sha> in the in-review → verified entry instead (the other convention).
  const full2 = laneLog({ state: 'done' }, [E.created, E.claim, E.review('accept', HEAD_A), E.inReview(), E.verified(undefined, `merge: ${MERGE} · authority: §7b PM rule`), E.done(undefined, 'Closed.')]);
  assert.deepEqual(chain('lane', baseWithReview, full2), []);
  // The owner/repo#N short form of the PR reference (what the real closing records write).
  const full4 = laneLog({ state: 'in-review' }, [E.created, E.claim, ['2026-10-27T11:10Z · kiro-x · executing → in-review', 'exafyltd/vitana-v1#1500 was opened.']]);
  const base4 = laneLog({ state: 'ready' }, [E.created]);
  assert.deepEqual(chain('lane', base4, full4), []);
  // The accept entry is new in this range: backed by its Collab-Review commit with the same head.
  const full3 = laneLog({ state: 'verified' }, [E.created, E.claim, E.inReview('2026-10-27T10:50Z'), E.review('accept', HEAD_A), E.verified()]);
  assert.deepEqual(chain('lane', base, full3, { reviewCommits: [backed(E.review('accept', HEAD_A), 'accept', HEAD_A)] }), []);
  // ...but not by a commit that carries the trailers without having appended that entry.
  hasErr(chain('lane', base, full3, { reviewCommits: [{ verdict: 'accept', reviewedHead: HEAD_A, appended: '' }] }), 'Collab-Review commit');
  // A review entry appended by a review commit must survive exactly once: removed or copied → refused.
  const accept = E.review('accept', HEAD_A, '2026-10-27T10:55Z');
  const changes = E.review('changes', HEAD_B, '2026-10-27T11:05Z');
  const reviewed = [backed(accept, 'accept', HEAD_A), backed(changes, 'changes', HEAD_B)];
  const dropChanges = laneLog({ state: 'verified' }, [E.created, E.claim, E.inReview('2026-10-27T10:50Z'), accept, E.verified()]);
  hasErr(chain('lane', base, dropChanges, { reviewCommits: reviewed }), 'appears 0×');
  const copyAccept = laneLog({ state: 'verified' }, [E.created, E.claim, E.inReview('2026-10-27T10:50Z'), accept, changes, ['2026-10-27T11:06Z · kiro-x · in-review → executing', 'x'], E.inReview('2026-10-27T11:10Z'), accept, E.verified()]);
  hasErr(chain('lane', base, copyAccept, { reviewCommits: reviewed }), 'appears 2×');
  // in-review → executing → in-review with a review: changes entry.
  const inRev = laneLog({ state: 'in-review' }, [E.created, E.claim, E.inReview('2026-10-27T10:50Z')]);
  const loop = laneLog({ state: 'in-review' }, [E.created, E.claim, E.inReview('2026-10-27T10:50Z'), E.review('changes', HEAD_A), ['2026-10-27T11:05Z · kiro-x · in-review → executing', 'Fixing findings.'], E.inReview('2026-10-27T11:15Z')]);
  assert.deepEqual(chain('lane', inRev, loop, { reviewCommits: [backed(E.review('changes', HEAD_A), 'changes', HEAD_A)] }), []);
  // executing → parked → executing → in-review (parked_from tracked through the chain).
  const parkedLoop = laneLog({ state: 'in-review' }, [E.created, E.claim, ['2026-10-27T10:20Z · kiro-x · executing → parked', 'Blocked.'], ['2026-10-27T10:40Z · kiro-x · parked → executing', 'Unblocked.'], E.inReview()]);
  assert.deepEqual(chain('lane', base, parkedLoop), []);
});

test('transitionChain: valid plan chain, one entry per edge; plan → done needs every lane done', () => {
  const pm = (state, entries) => laneLog({ state, slug: 'cards', lane: undefined }, entries).replace('lane: undefined\n', '');
  const base = pm('executing', [['2026-10-27T10:00Z · kiro-x · approved → executing', 'Started.']]);
  const head = pm('done', [['2026-10-27T10:00Z · kiro-x · approved → executing', 'Started.'], ['2026-10-27T11:00Z · kiro-x · executing → in-review', 'All lanes in review.'], ['2026-10-27T11:10Z · kiro-x · in-review → verified', 'All lanes verified.'], ['2026-10-27T11:20Z · kiro-x · verified → done', 'All lanes done.']]);
  assert.deepEqual(chain('plan', base, head, { laneStates: ['done', 'done'] }), []);
  hasErr(chain('plan', base, head, { laneStates: ['done', 'verified'] }), 'every lane');
});

test('transitionChain: invalid chains each fail with their own error', () => {
  const base = laneLog({ state: 'executing' }, [E.created, E.claim]);
  const baseRev = laneLog({ state: 'executing' }, [E.created, E.claim, E.review('accept', HEAD_A)]);
  // skipped state: only one entry for executing → verified
  hasErr(chain('lane', baseRev, laneLog({ state: 'verified' }, [E.created, E.claim, E.review('accept', HEAD_A), ['2026-10-27T11:20Z · kiro-x · executing → verified', 'x']])), 'illegal transition "executing" → "verified"');
  // entries out of order
  hasErr(chain('lane', baseRev, laneLog({ state: 'verified' }, [E.created, E.claim, E.review('accept', HEAD_A), E.inReview('2026-10-27T11:30Z'), E.verified('2026-10-27T11:20Z')])), 'out of order');
  // an entry ready → done
  hasErr(chain('lane', laneLog({ state: 'ready' }, [E.created]), laneLog({ state: 'done' }, [E.created, ['2026-10-27T10:05Z · kiro-x · ready → executing', 'x'], ['2026-10-27T10:06Z · kiro-x · executing → done', 'x']])), 'illegal transition "executing" → "done"');
  // leaving done
  hasErr(chain('lane', laneLog({ state: 'done' }, [E.created]), laneLog({ state: 'in-review' }, [E.created, ['2026-10-27T10:05Z · kiro-x · done → executing', 'x'], E.inReview()])), '"done" is terminal');
  // parked returns to the wrong state (parked_from tracked = executing)
  hasErr(chain('lane', base, laneLog({ state: 'in-review' }, [E.created, E.claim, ['2026-10-27T10:20Z · kiro-x · executing → parked', 'x'], ['2026-10-27T10:40Z · kiro-x · parked → in-review', 'x']])), 'may only return to "executing"');
  // head parked with a parked_from other than the tracked one
  hasErr(chain('lane', base, laneLog({ state: 'parked', parked_from: 'ready' }, [E.created, E.claim, E.inReview(), ['2026-10-27T11:20Z · kiro-x · in-review → parked', 'x']])), 'parked_from');
  // in-review → verified without an accept entry in its window
  hasErr(chain('lane', base, laneLog({ state: 'verified' }, [E.created, E.claim, E.inReview(), E.verified()])), 'no accept review');
  // accept added in this range without its Collab-Review commit
  hasErr(chain('lane', base, laneLog({ state: 'verified' }, [E.created, E.claim, E.inReview('2026-10-27T10:50Z'), E.review('accept', HEAD_A), E.verified()])), 'Collab-Review commit');
  // accept whose head differs from Collab-Reviewed-Head
  hasErr(chain('lane', base, laneLog({ state: 'verified' }, [E.created, E.claim, E.inReview('2026-10-27T10:50Z'), E.review('accept', HEAD_A), E.verified()]), { reviewCommits: [backed(E.review('accept', HEAD_A), 'accept', HEAD_B)] }), 'Collab-Review commit');
  // a note entry whose body quotes 'review: accept' is not a review entry
  hasErr(chain('lane', base, laneLog({ state: 'verified' }, [E.created, E.claim, E.inReview(), ['2026-10-27T11:15Z · kiro-x · note', `review: accept\nhead: ${HEAD_A}`], E.verified()])), 'no accept review');
  // executing → in-review without a PR URL
  hasErr(chain('lane', baseRev, laneLog({ state: 'verified' }, [E.created, E.claim, E.review('accept', HEAD_A), ['2026-10-27T11:10Z · kiro-x · executing → in-review', 'no link'], E.verified()])), 'PR URL');
  // in-review → executing without a changes entry
  const inRev = laneLog({ state: 'in-review' }, [E.created, E.claim, E.inReview('2026-10-27T10:50Z')]);
  hasErr(chain('lane', inRev, laneLog({ state: 'in-review' }, [E.created, E.claim, E.inReview('2026-10-27T10:50Z'), ['2026-10-27T11:05Z · kiro-x · in-review → executing', 'x'], E.inReview('2026-10-27T11:15Z')])), 'no changes review');
  // verified → done without a merge sha in either entry
  hasErr(chain('lane', baseRev, laneLog({ state: 'done' }, [E.created, E.claim, E.review('accept', HEAD_A), E.inReview(), E.verified(), E.done(undefined, 'Closed.')])), 'merge sha');
  // a base log entry edited
  hasErr(chain('lane', baseRev, laneLog({ state: 'verified' }, [E.created, ['2026-10-27T10:05Z · kiro-x · ready → executing', 'Claimed (edited).'], E.review('accept', HEAD_A), E.inReview(), E.verified()])), 'log rewritten');
  // more than 6 edges
  const many = [E.created, E.claim];
  for (let i = 0; i < 4; i++) many.push([`2026-10-27T11:${10 + 2 * i}Z · kiro-x · executing → parked`, 'x'], [`2026-10-27T11:${11 + 2 * i}Z · kiro-x · parked → executing`, 'x']);
  hasErr(chain('lane', base, laneLog({ state: 'executing' }, many)), 'at most 6');
  // last edge does not reach the head state
  hasErr(chain('lane', baseRev, laneLog({ state: 'done' }, [E.created, E.claim, E.review('accept', HEAD_A), E.inReview(), E.verified()])), 'does not connect');
  // first edge does not start at the base state
  hasErr(chain('lane', base, laneLog({ state: 'verified' }, [E.created, E.claim, E.verified('2026-10-27T11:00Z'), ['2026-10-27T11:05Z · kiro-x · verified → in-review', 'x']])), 'does not connect');
});

test('validate: a closing-record PR may carry executing → in-review → verified → done; authorization still applies', () => {
  const f = fixture();
  try {
    const lanePath = '.kiro/specs/cards/lanes/card-01.md';
    write(f.work, '.kiro/specs/cards/handoff.md', planMd({ state: 'executing', sparring_record: 'x.md', vtids: ['VTID-00001'], executor: 'kiro', next_actor: 'kiro' }));
    write(f.work, lanePath, laneLog({ state: 'executing', claimed_by: S1 }, [E.created, E.claim]));
    const base = commit(f.work, 'seed', { 'Collab-Session': S2, 'Collab-Lane': 'cards/_plan' });
    sh(f.work, 'push', '-q', 'origin', 'main');
    sh(f.work, 'fetch', '-q', 'origin');
    sh(f.work, 'checkout', '-q', '-b', 'kiro/cards/card-01');
    write(f.work, lanePath, laneLog({ state: 'executing', claimed_by: S1 }, [E.created, E.claim, E.inReview('2026-10-27T10:50Z').map((x, i) => (i ? x : x.replace(' · executing → in-review', ' · note'))), E.review('accept', HEAD_A)]));
    commit(f.work, 'review entry', { 'Collab-Session': 'agent-vitana-lane-reviewer-202610271100-ab12', 'Collab-Review': 'cards/card-01', 'Collab-Verdict': 'accept', 'Collab-Reviewer': 'agent:vitana-lane-reviewer (claude-opus-5.5)', 'Collab-Reviewed-Head': HEAD_A });
    const closed = laneLog({ state: 'done', claimed_by: S1 }, [E.created, E.claim, E.inReview('2026-10-27T10:50Z').map((x, i) => (i ? x : x.replace(' · executing → in-review', ' · note'))), E.review('accept', HEAD_A), E.inReview('2026-10-27T11:10Z'), E.verified(), E.done()]);
    write(f.work, lanePath, closed);
    const head = commit(f.work, 'closing record', { 'Collab-Session': S1, 'Collab-Lane': 'cards/card-01' });
    assert.deepEqual(validateRange(f.work, { base, head, branch: 'kiro/cards/card-01' }).errors, []);
    // Same chain from a second session: still one session per lane / claimed_by.
    write(f.work, lanePath, `${closed}\n### 2026-10-27T11:40Z · kiro-y · note\nx\n`);
    const head2 = commit(f.work, 'other session', { 'Collab-Session': 'kiro-202610271140-cd34', 'Collab-Lane': 'cards/card-01' });
    hasErr(validateRange(f.work, { base, head: head2, branch: 'kiro/cards/card-01' }).errors, 'one session per lane');
  } finally { f.done(); }
});

test('validate: a chain whose accept entry has no Collab-Review commit fails; a single legal edge needs no new evidence', () => {
  const f = fixture();
  try {
    const lanePath = '.kiro/specs/cards/lanes/card-01.md';
    write(f.work, '.kiro/specs/cards/handoff.md', planMd({ state: 'executing', sparring_record: 'x.md', vtids: ['VTID-00001'], executor: 'kiro', next_actor: 'kiro' }));
    write(f.work, lanePath, laneLog({ state: 'executing', claimed_by: S1 }, [E.created, E.claim]));
    const base = commit(f.work, 'seed', { 'Collab-Session': S2, 'Collab-Lane': 'cards/_plan' });
    sh(f.work, 'push', '-q', 'origin', 'main');
    sh(f.work, 'fetch', '-q', 'origin');
    sh(f.work, 'checkout', '-q', '-b', 'kiro/cards/card-01');
    // The builder writes the accept entry itself, then chains through verified: refused.
    write(f.work, lanePath, laneLog({ state: 'verified', claimed_by: S1 }, [E.created, E.claim, E.inReview('2026-10-27T10:50Z'), E.review('accept', HEAD_A), E.verified()]));
    let head = commit(f.work, 'forged accept', { 'Collab-Session': S1, 'Collab-Lane': 'cards/card-01' });
    hasErr(validateRange(f.work, { base, head, branch: 'kiro/cards/card-01' }).errors, 'Collab-Review commit');
    // The builder adds the Collab-Review trailers to its own Collab-Lane commit: still refused.
    sh(f.work, 'checkout', '-q', '-B', 'kiro/cards/card-01', base);
    write(f.work, lanePath, laneLog({ state: 'verified', claimed_by: S1 }, [E.created, E.claim, E.inReview('2026-10-27T10:50Z'), E.review('accept', HEAD_A), E.verified()]));
    const forgedTrailers = { 'Collab-Session': S1, 'Collab-Lane': 'cards/card-01', 'Collab-Review': 'cards/card-01', 'Collab-Verdict': 'accept', 'Collab-Reviewer': 'agent:vitana-lane-reviewer (claude-opus-5.5)', 'Collab-Reviewed-Head': HEAD_A };
    head = commit(f.work, 'forged with trailers', forgedTrailers);
    hasErr(validateRange(f.work, { base, head, branch: 'kiro/cards/card-01' }).errors, 'Collab-Review commit');
    // An empty review-trailer commit next to the builder's own accept entry: still refused.
    sh(f.work, 'checkout', '-q', '-B', 'kiro/cards/card-01', base);
    write(f.work, lanePath, laneLog({ state: 'verified', claimed_by: S1 }, [E.created, E.claim, E.inReview('2026-10-27T10:50Z'), E.review('accept', HEAD_A), E.verified()]));
    commit(f.work, 'builder writes accept', { 'Collab-Session': S1, 'Collab-Lane': 'cards/card-01' });
    sh(f.work, 'commit', '-q', '--allow-empty', '-m', 'empty review', '--trailer', 'Collab-Session: agent-vitana-lane-reviewer-202610271100-ab12', '--trailer', 'Collab-Review: cards/card-01', '--trailer', 'Collab-Verdict: accept', '--trailer', `Collab-Reviewed-Head: ${HEAD_A}`);
    head = sh(f.work, 'rev-parse', 'HEAD');
    hasErr(validateRange(f.work, { base, head, branch: 'kiro/cards/card-01' }).errors, 'Collab-Review commit');
    // A review-only commit from a session that is neither a reviewer agent nor Claude Code: refused.
    sh(f.work, 'checkout', '-q', '-B', 'kiro/cards/card-01', base);
    write(f.work, lanePath, laneLog({ state: 'executing', claimed_by: S1 }, [E.created, E.claim, E.inReview('2026-10-27T10:50Z').map((x, i) => (i ? x : x.replace(' · executing → in-review', ' · note'))), E.review('accept', HEAD_A)]));
    commit(f.work, 'review by a kiro seat', { 'Collab-Session': 'kiro-other-202610271100-ab12', 'Collab-Review': 'cards/card-01', 'Collab-Verdict': 'accept', 'Collab-Reviewed-Head': HEAD_A });
    write(f.work, lanePath, laneLog({ state: 'verified', claimed_by: S1 }, [E.created, E.claim, E.inReview('2026-10-27T10:50Z').map((x, i) => (i ? x : x.replace(' · executing → in-review', ' · note'))), E.review('accept', HEAD_A), E.inReview('2026-10-27T11:10Z'), E.verified()]));
    head = commit(f.work, 'closing', { 'Collab-Session': S1, 'Collab-Lane': 'cards/card-01' });
    hasErr(validateRange(f.work, { base, head, branch: 'kiro/cards/card-01' }).errors, 'Collab-Review commit');
    // A Claude Code session that built the lane cannot back its own accept with a review-only commit.
    sh(f.work, 'checkout', '-q', '-B', 'kiro/cards/card-01', base);
    write(f.work, lanePath, laneLog({ state: 'executing', claimed_by: S2 }, [E.created, E.claim]));
    commit(f.work, 'claude builds', { 'Collab-Session': S2, 'Collab-Lane': 'cards/card-01' });
    write(f.work, lanePath, laneLog({ state: 'executing', claimed_by: S2 }, [E.created, E.claim, E.inReview('2026-10-27T10:50Z').map((x, i) => (i ? x : x.replace(' · executing → in-review', ' · note'))), E.review('accept', HEAD_A)]));
    commit(f.work, 'self review', { 'Collab-Session': S2, 'Collab-Review': 'cards/card-01', 'Collab-Verdict': 'accept', 'Collab-Reviewed-Head': HEAD_A });
    write(f.work, lanePath, laneLog({ state: 'verified', claimed_by: S2 }, [E.created, E.claim, E.inReview('2026-10-27T10:50Z').map((x, i) => (i ? x : x.replace(' · executing → in-review', ' · note'))), E.review('accept', HEAD_A), E.inReview('2026-10-27T11:10Z'), E.verified()]));
    head = commit(f.work, 'closing', { 'Collab-Session': S2, 'Collab-Lane': 'cards/card-01' });
    hasErr(validateRange(f.work, { base, head, branch: 'kiro/cards/card-01' }).errors, 'Collab-Review commit');
    // A single legal edge (executing → in-review) without a PR URL passes as today.
    sh(f.work, 'checkout', '-q', '-B', 'kiro/cards/card-01', base);
    write(f.work, lanePath, laneLog({ state: 'in-review', claimed_by: S1 }, [E.created, E.claim, ['2026-10-27T11:10Z · kiro-x · executing → in-review', 'no link']]));
    head = commit(f.work, 'single edge', { 'Collab-Session': S1, 'Collab-Lane': 'cards/card-01' });
    assert.deepEqual(validateRange(f.work, { base, head, branch: 'kiro/cards/card-01' }).errors, []);
  } finally { f.done(); }
});

// ── VTID-05408 (kiro-lane-admin): reviewed, auditable Kiro lane administration. T-A..T-K (design §7). ──
// An admin lane: executor: kiro, reviewer_seat: agent:vitana-lane-reviewer, lane_admin: true, whose paths cover the
// TARGET lane file(s) it administers. Only such a lane (from a trusted source) may reassign a target lane's seat /
// narrow its paths; the admin lane can never self-widen; protected gate files and seat ownership stay as before.
const ADMIN_PATHS = ['.kiro/specs/feat/lanes/*.md'];
const ADMIN_LANE_FM = { executor: 'kiro', seat: 'jtadic', reviewer_seat: AG, lane_admin: 'true', paths: ADMIN_PATHS };

/**
 * A spec `admin` holding a lane-admin lane `admin-01` (paths cover `.kiro/specs/feat/lanes/*.md`) and a target spec
 * `feat` with an ordinary lane `target-01` owned by seat `other`. Returns the base sha on `main` and checks out a
 * branch for the admin PR. `o.adminFm` overrides the admin lane front matter.
 */
function adminFixture(f, o = {}) {
  write(f.work, '.kiro/specs/admin/handoff.md', planMd({ slug: 'admin', state: 'executing', sparring_record: 'x.md', vtids: ['VTID-05408'], executor: 'kiro', next_actor: 'kiro' }));
  write(f.work, '.kiro/specs/admin/lanes/admin-01.md', laneMd('admin-01', { next_actor: 'kiro', vtid: 'VTID-05408', ...ADMIN_LANE_FM, ...o.adminFm }));
  write(f.work, '.kiro/specs/feat/handoff.md', planMd({ slug: 'feat', state: 'executing', sparring_record: 'x.md', vtids: ['VTID-05409'], executor: 'kiro', next_actor: 'kiro' }));
  write(f.work, '.kiro/specs/feat/lanes/target-01.md', laneMd('target-01', { next_actor: 'kiro', vtid: 'VTID-05409', executor: 'kiro', seat: 'other', reviewer_seat: 'jtadic', paths: ['src/wide/**'] }));
  const base = commit(f.work, 'seed admin + feat', { 'Collab-Session': S2, 'Collab-Lane': 'admin/_plan' });
  sh(f.work, 'push', '-q', 'origin', 'main');
  sh(f.work, 'checkout', '-q', '-b', 'kiro/admin/admin-01');
  return base;
}
// the reassigned target lane file: narrower paths, reassigned to seat jtadic — the audited outcome
const targetReassigned = () => laneMd('target-01', { next_actor: 'kiro', vtid: 'VTID-05409', executor: 'kiro', seat: 'jtadic', reviewer_seat: 'exafyltd', paths: ['src/narrow/**'] });

test('VTID-05408 T-A: validateLane recognises the lane_admin marker and requires kiro + the reviewer agent + a lane-file path', () => {
  const v = (o) => validateLane(parseFrontMatter(laneMd('a', o)), 'cards', 'a', new Set(['a']));
  // a well-formed lane-admin lane passes
  assert.deepEqual(v({ executor: 'kiro', seat: 'jtadic', reviewer_seat: AG, lane_admin: 'true', paths: ['.kiro/specs/feat/lanes/target-01.md'] }), []);
  assert.deepEqual(v({ executor: 'kiro', seat: 'jtadic', reviewer_seat: AG, lane_admin: 'true', paths: ['.kiro/specs/*/lanes/*.md'] }), []);
  // without the reviewer agent / without kiro / without a lane-file path → a clear error
  const needsAgent = v({ executor: 'kiro', seat: 'jtadic', reviewer_seat: 'exafyltd', lane_admin: 'true', paths: ['.kiro/specs/feat/lanes/target-01.md'] });
  assert.ok(needsAgent.some((e) => e.includes('lane_admin: true needs')), needsAgent.join('\n'));
  const needsKiro = v({ executor: 'claude', seat: 'jtadic', reviewer_seat: AG, lane_admin: 'true', paths: ['.kiro/specs/feat/lanes/target-01.md'] });
  assert.ok(needsKiro.some((e) => e.includes('lane_admin: true needs')), needsKiro.join('\n'));
  const needsLaneFile = v({ executor: 'kiro', seat: 'jtadic', reviewer_seat: AG, lane_admin: 'true', paths: ['src/**'] });
  assert.ok(needsLaneFile.some((e) => e.includes('lane_admin: true needs')), needsLaneFile.join('\n'));
  // a non-lane_admin lane is unchanged
  assert.deepEqual(v({ executor: 'kiro', seat: 'jtadic', reviewer_seat: 'exafyltd', paths: ['src/**'] }), []);
});

test('VTID-05408 T-B: a trusted lane_admin lane reassigns a TARGET lane seat + narrows its paths → Collab handoff and Lane scope pass', () => {
  const f = fixture();
  try {
    const base = adminFixture(f);
    write(f.work, '.kiro/specs/feat/lanes/target-01.md', targetReassigned());
    const head = commit(f.work, 'reassign target-01 to jtadic, narrow paths', { 'Collab-Session': JT, 'Collab-Lane': 'admin/admin-01' });
    assert.deepEqual(validateRange(f.work, { base, head, branch: 'kiro/admin/admin-01' }).errors, []);
    assert.deepEqual(scopeCheck(f.work, { base, head, branch: 'kiro/admin/admin-01' }).errors, []);
  } finally { f.done(); }
});

test('VTID-05408 T-C: the same cross-lane-file reassignment from an ordinary (non lane_admin) lane is refused', () => {
  const f = fixture();
  try {
    const base = adminFixture(f, { adminFm: { lane_admin: undefined } }); // ordinary kiro lane (no lane_admin)
    write(f.work, '.kiro/specs/feat/lanes/target-01.md', targetReassigned());
    const head = commit(f.work, 'ordinary lane edits a foreign lane file', { 'Collab-Session': JT, 'Collab-Lane': 'admin/admin-01' });
    const e = validateRange(f.work, { base, head, branch: 'kiro/admin/admin-01' }).errors;
    assert.ok(e.some((x) => x.includes('target-01.md but its Collab-Lane')), e.join('\n'));
  } finally { f.done(); }
});

test('VTID-05408 T-D: a PR that self-grants lane_admin: true in its own head does not unlock the exemption (lane_admin pinned to trusted)', () => {
  const f = fixture();
  try {
    // trusted admin-01 is an ORDINARY lane (no lane_admin); the PR head rewrites it to lane_admin: true and uses that
    // to reassign the foreign target lane file
    const base = adminFixture(f, { adminFm: { lane_admin: undefined, reviewer_seat: AG } });
    write(f.work, '.kiro/specs/admin/lanes/admin-01.md', laneMd('admin-01', { next_actor: 'kiro', vtid: 'VTID-05408', ...ADMIN_LANE_FM, state: 'executing', claimed_by: JT }));
    write(f.work, '.kiro/specs/feat/lanes/target-01.md', targetReassigned());
    const head = commit(f.work, 'self-grant lane_admin + reassign', { 'Collab-Session': JT, 'Collab-Lane': 'admin/admin-01' });
    // the shared predicate reads the TRUSTED admin-01 (not lane_admin) → the head self-grant does not qualify it
    assert.equal(Q.laneAdminCovers(f.work, base, head, 'admin/admin-01', '.kiro/specs/feat/lanes/target-01.md'), false);
    // Collab handoff therefore refuses the cross-lane-file edit
    assert.ok(validateRange(f.work, { base, head, branch: 'kiro/admin/admin-01' }).errors.some((x) => x.includes('target-01.md but its Collab-Lane')));
  } finally { f.done(); }
});

test('VTID-05408 T-E: a lane_admin lane that changes a protected gate file is still refused', () => {
  const f = fixture();
  try {
    const base = adminFixture(f, { adminFm: { paths: [...ADMIN_PATHS, 'scripts/collab/queue.mjs'] } });
    write(f.work, 'scripts/collab/queue.mjs', '// x\n');
    const head = commit(f.work, 'lane_admin touches a protected gate file', { 'Collab-Session': JT, 'Collab-Lane': 'admin/admin-01' });
    const e = scopeCheck(f.work, { base, head, branch: 'kiro/admin/admin-01' }).errors;
    assert.ok(e.some((x) => x.startsWith('scripts/collab/queue.mjs is a protected gate file')), e.join('\n'));
  } finally { f.done(); }
});

test('VTID-05408 T-F: an ordinary lane PR editing a foreign seat\u2019s own lane file is still refused (seat ownership preserved)', () => {
  const f = fixture();
  try {
    const base = scopeFixture(f, { executor: 'kiro', seat: 'jtadic', reviewer_seat: 'exafyltd', paths: ['src/**'] });
    // EX (seat exafyltd) edits card-01, which belongs to seat jtadic
    write(f.work, '.kiro/specs/cards/lanes/card-01.md', `${laneMd('card-01', { next_actor: 'kiro', vtid: 'VTID-00002', executor: 'kiro', seat: 'jtadic', reviewer_seat: 'exafyltd', paths: ['src/**'] })}### edit\n`);
    const head = commit(f.work, 'foreign seat edits a lane', { 'Collab-Session': EX, 'Collab-Lane': 'cards/card-01' });
    const e = scopeCheck(f.work, { base, head, branch: 'kiro/cards/card-01' }).errors;
    assert.ok(e.some((x) => x.includes('belongs to seat jtadic')), e.join('\n'));
  } finally { f.done(); }
});

test('VTID-05408 T-G: validateRange cross-lane-file exemption passes only for a trusted lane_admin lane', () => {
  const f = fixture();
  try {
    const base = adminFixture(f);
    write(f.work, '.kiro/specs/feat/lanes/target-01.md', `${targetReassigned()}### admin edit\n`);
    const head = commit(f.work, 'admin edits the target lane file', { 'Collab-Session': JT, 'Collab-Lane': 'admin/admin-01' });
    assert.deepEqual(validateRange(f.work, { base, head, branch: 'kiro/admin/admin-01' }).errors, []);
  } finally { f.done(); }
});

test('VTID-05408 T-H: an ordinary cross-lane-file edit with a mismatched Collab-Lane is still refused', () => {
  const f = fixture();
  try {
    const base = seedSpec(f); // cards/_plan with card-01 + card-02
    sh(f.work, 'checkout', '-q', '-b', 'kiro/cards/card-01');
    write(f.work, '.kiro/specs/cards/lanes/card-02.md', `${laneMd('card-02', { next_actor: 'kiro', depends_on: ['card-01'] })}### edit\n`);
    const head = commit(f.work, 'card-01 edits card-02', { 'Collab-Session': S1, 'Collab-Lane': 'cards/card-01' });
    assert.ok(validateRange(f.work, { base, head, branch: 'kiro/cards/card-01' }).errors.some((x) => x.includes('card-02.md but its Collab-Lane')));
  } finally { f.done(); }
});

test('VTID-05408 T-I: a lane_admin lane cannot widen/change its OWN PERM fields or lane_admin (self-widen impossible)', () => {
  for (const [label, headFm] of [
    ['paths', { paths: ['src/wide/**', ...ADMIN_PATHS] }],
    ['executor', { executor: 'claude' }],
    ['reviewer_seat', { reviewer_seat: 'exafyltd' }],
    ['seat', { seat: 'exafyltd' }],
  ]) {
    const f = fixture();
    try {
      const base = adminFixture(f);
      write(f.work, '.kiro/specs/admin/lanes/admin-01.md', laneMd('admin-01', { next_actor: 'kiro', vtid: 'VTID-05408', ...ADMIN_LANE_FM, state: 'executing', claimed_by: JT, ...headFm }));
      const head = commit(f.work, `admin widens its own ${label}`, { 'Collab-Session': JT, 'Collab-Lane': 'admin/admin-01' });
      const r = scopeCheck(f.work, { base, head, branch: 'kiro/admin/admin-01' });
      assert.ok(r.errors.some((x) => x.includes('lane admin/admin-01:') && x.includes('changed in a lane PR')), `${label}: ${r.errors.join('\n')}`);
      // the admin lane's own permissions are pinned back to the trusted (narrow) values
      assert.deepEqual(r.paths, ADMIN_PATHS, `${label}: paths pinned to trusted`);
    } finally { f.done(); }
  }
});

test('VTID-05408 T-J: lane_admin parses as the STRING \u2018true\u2019 and still unlocks the carve-outs (toBool, never === true)', () => {
  // validateLane recognises the string marker
  const v = (o) => validateLane(parseFrontMatter(laneMd('a', o)), 'cards', 'a', new Set(['a']));
  assert.deepEqual(parseFrontMatter(laneMd('a', { lane_admin: 'true' })).lane_admin, 'true', 'parseFrontMatter yields the STRING true');
  assert.deepEqual(v({ executor: 'kiro', seat: 'jtadic', reviewer_seat: AG, lane_admin: 'true', paths: ['.kiro/specs/feat/lanes/target-01.md'] }), []);
  // the shared predicate recognises a trusted string-'true' admin lane and its coverage
  const f = fixture();
  try {
    const base = adminFixture(f);
    write(f.work, '.kiro/specs/feat/lanes/target-01.md', `${targetReassigned()}### edit\n`);
    const head = commit(f.work, 'admin edits target', { 'Collab-Session': JT, 'Collab-Lane': 'admin/admin-01' });
    // laneAdminCovers returns true for the string-'true' admin lane over the target file, false over an unrelated file
    assert.equal(Q.laneAdminCovers(f.work, base, head, 'admin/admin-01', '.kiro/specs/feat/lanes/target-01.md'), true);
    assert.equal(Q.laneAdminCovers(f.work, base, head, 'admin/admin-01', '.kiro/specs/other/lanes/x.md'), false);
    // the cross-lane-file exemption (which only fires via toBool) passes — reverting any comparison to === true breaks this
    assert.deepEqual(validateRange(f.work, { base, head, branch: 'kiro/admin/admin-01' }).errors, []);
  } finally { f.done(); }
});

test('VTID-05408 T-K: the validateRange exemption resolves a trusted admin lane via fetchPlanLane from a qualifying plan( PR (symmetric with scope-check)', () => {
  const f = fixture();
  try {
    // Only the TARGET spec exists on main (the merge-base). The admin spec is brand-new in this PR and its trusted
    // qualification is resolvable ONLY via fetchPlanLane (a qualifying open plan( PR) — the asymmetry R2-F2 fixes.
    const base = sh(f.work, 'rev-parse', 'HEAD');
    write(f.work, '.kiro/specs/feat/handoff.md', planMd({ slug: 'feat', state: 'executing', sparring_record: 'x.md', vtids: ['VTID-05409'], executor: 'kiro', next_actor: 'kiro' }));
    write(f.work, '.kiro/specs/feat/lanes/target-01.md', laneMd('target-01', { next_actor: 'kiro', vtid: 'VTID-05409', executor: 'kiro', seat: 'other', reviewer_seat: 'jtadic', paths: ['src/wide/**'] }));
    const seeded = commit(f.work, 'seed feat', { 'Collab-Session': S2, 'Collab-Lane': 'feat/_plan' });
    sh(f.work, 'push', '-q', 'origin', 'main');
    sh(f.work, 'checkout', '-q', '-b', 'kiro/admin/admin-01', seeded);
    // the admin spec is created in this PR by its _plan commit (valid new files: handoff drafted, lane ready)
    write(f.work, '.kiro/specs/admin/handoff.md', planMd({ slug: 'admin', state: 'drafted', executor: 'kiro', next_actor: 'kiro' }));
    write(f.work, '.kiro/specs/admin/lanes/admin-01.md', laneMd('admin-01', { next_actor: 'kiro', ...ADMIN_LANE_FM }));
    commit(f.work, 'create admin spec', { 'Collab-Session': S2, 'Collab-Lane': 'admin/_plan' });
    // the admin lane reassigns the target lane file (cross-lane-file edit with Collab-Lane: admin/admin-01)
    write(f.work, '.kiro/specs/feat/lanes/target-01.md', `${targetReassigned()}### edit\n`);
    const head = commit(f.work, 'admin reassigns the target', { 'Collab-Session': JT, 'Collab-Lane': 'admin/admin-01' });
    // the admin lane's qualifying front matter lives only in the open plan( PR, resolved via fetchPlanLane
    const adminPlanLane = {
      text: laneMd('admin-01', { next_actor: 'kiro', vtid: 'VTID-05408', ...ADMIN_LANE_FM }),
      handoffText: planMd({ slug: 'admin', state: 'approved', sparring_record: 'x.md', vtids: ['VTID-05408'], executor: 'kiro', next_actor: 'kiro' }),
      lastSession: 'ci-plan-spar', pr: 4242, sha: 'f'.repeat(40),
    };
    const asked = [];
    const fetchPlanLane = (slug, p) => { asked.push([slug, p]); return slug === 'admin' ? adminPlanLane : null; };
    // with fetchPlanLane the exemption resolves the trusted admin lane → Collab handoff passes
    assert.deepEqual(validateRange(f.work, { base: seeded, head, branch: 'kiro/admin/admin-01', allowInitial: ['admin'], fetchPlanLane }).errors, []);
    assert.ok(asked.some(([s]) => s === 'admin'), 'fetchPlanLane was consulted for the admin slug');
    // without fetchPlanLane threaded, the admin lane's trusted qualification is unreachable (head is untrusted) → refused
    assert.ok(validateRange(f.work, { base: seeded, head, branch: 'kiro/admin/admin-01', allowInitial: ['admin'] }).errors.some((x) => x.includes('target-01.md but its Collab-Lane')));
  } finally { f.done(); }
});

// ── VTID-05365 (collab-handoff-check-fix/validator-fix): R1, stderr report, batched reads ──

const QUEUE_CLI = fileURLToPath(new URL('./queue.mjs', import.meta.url));
const PS = 'ci-plan-spar';
const S3 = 'kiro-exafy-202610281200-cd34';

/** A plan PR: planner commit (new drafted plan + ready lane) then `extra` commits on top. → { base, head } */
function planPrFixture(f, extra) {
  sh(f.work, 'checkout', '-q', '-b', 'kiro/cards/plan');
  const base = sh(f.work, 'rev-parse', 'HEAD');
  write(f.work, '.kiro/specs/cards/handoff.md', planMd({ executor: 'kiro', next_actor: 'kiro' }));
  write(f.work, '.kiro/specs/cards/lanes/a.md', laneMd('a', { next_actor: 'kiro' }));
  commit(f.work, 'plan', { 'Collab-Session': S1, 'Collab-Lane': 'cards/_plan' });
  extra();
  return { base, head: sh(f.work, 'rev-parse', 'HEAD') };
}
const spar = (f) => {
  write(f.work, '.kiro/specs/cards/handoff.md', planMd({ executor: 'kiro', next_actor: 'kiro', state: 'approved', sparring_record: 'x.md', vtids: ['VTID-09001'] }));
  write(f.work, '.kiro/specs/cards/lanes/a.md', laneMd('a', { next_actor: 'kiro', vtid: 'VTID-09001' }));
  commit(f.work, 'spar', { 'Collab-Session': PS, 'Collab-Lane': 'cards/_plan' });
};

test('VTID-05365 R1: a planner commit and a ci-plan-spar commit on `_plan` are one session', () => {
  const f = fixture();
  try {
    const { base, head } = planPrFixture(f, () => spar(f));
    assert.deepEqual(validateRange(f.work, { base, head, branch: 'kiro/cards/plan' }).errors, []);
  } finally { f.done(); }
});

test('VTID-05365 R1 negative: a second kiro session on `_plan` still fails', () => {
  const f = fixture();
  try {
    const { base, head } = planPrFixture(f, () => {
      spar(f);
      write(f.work, '.kiro/specs/cards/tasks.md', 'x\n');
      commit(f.work, 'other', { 'Collab-Session': S3, 'Collab-Lane': 'cards/_plan' });
    });
    const e = validateRange(f.work, { base, head }).errors;
    assert.ok(e.some((x) => x.includes('lane cards/_plan: commits from 2 sessions') && x.includes(S1) && x.includes(S3) && !x.includes(PS)), e.join('\n'));
  } finally { f.done(); }
});

test('VTID-05365 R1 negative: a ci-plan-spar commit that edits the paths of a lane past `ready` still fails', () => {
  const f = fixture();
  try {
    const base = scopeFixture(f, { ...LANE, reviewer_seat: AG, state: 'executing', claimed_by: JT });
    write(f.work, '.kiro/specs/cards/lanes/card-01.md', laneMd('card-01', { next_actor: 'kiro', vtid: 'VTID-00002', ...LANE, reviewer_seat: AG, state: 'executing', claimed_by: JT, paths: ['**'] }));
    const head = commit(f.work, 'widen', { 'Collab-Session': PS, 'Collab-Lane': 'cards/_plan' });
    const e = validateRange(f.work, { base, head }).errors;
    assert.ok(e.some((x) => x.includes('changes .kiro/specs/cards/lanes/card-01.md but its Collab-Lane is "cards/_plan"')), e.join('\n'));
  } finally { f.done(); }
});

/** Run the CLI; never throws. → { status, stdout, stderr } */
function cli(args) {
  try {
    const stdout = execFileSync(process.execPath, [QUEUE_CLI, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GITHUB_REPOSITORY: '' } });
    return { status: 0, stdout, stderr: '' };
  } catch (e) { return { status: e.status, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') }; }
}

test('VTID-05365 silent failure: validate --summary prints the problems as ::error:: annotations on stderr', () => {
  const f = fixture();
  try {
    const base = seedSpec(f);
    sh(f.work, 'checkout', '-q', '-b', 'kiro/cards/card-01');
    write(f.work, '.kiro/specs/cards/lanes/card-01.md', laneMd('card-01', { next_actor: 'kiro', state: 'done', vtid: 'VTID-00001' }));
    const head = commit(f.work, 'jump', { 'Collab-Session': S1, 'Collab-Lane': 'cards/card-01' });
    const summary = path.join(f.dir, 'summary.md');
    const r = cli(['validate', '--repo', f.work, '--base', base, '--head', head, '--branch', 'kiro/cards/card-01', '--summary', summary]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^::error::collab handoff: \.kiro\/specs\/cards\/lanes\/card-01\.md: illegal transition "ready" → "done"$/m);
    assert.match(r.stderr, /\*\*collab handoff\*\* — 1 problem\(s\)/);
    assert.doesNotMatch(r.stderr, /Collab queue/, 'the queue table stays in the summary only');
    assert.equal(r.stdout, '');
    const s = readFileSync(summary, 'utf8');
    assert.match(s, /illegal transition/);
    assert.match(s, /<summary>Collab queue<\/summary>/);
    // without --summary: stdout unchanged, nothing on stderr
    const p = cli(['validate', '--repo', f.work, '--base', base, '--head', head, '--branch', 'kiro/cards/card-01']);
    assert.equal(p.status, 1);
    assert.match(p.stdout, /illegal transition/);
    assert.equal(p.stderr, '');
  } finally { f.done(); }
});

test('VTID-05365 silent failure: scope-check --summary prints ::error::lane scope: annotations; newlines escaped', () => {
  const f = fixture();
  try {
    const base = scopeFixture(f, LANE);
    write(f.work, 'src/elsewhere/x.ts', 'x');
    const head = commit(f.work, 'out', { 'Collab-Session': JT, 'Collab-Lane': 'cards/card-01' });
    const summary = path.join(f.dir, 'summary.md');
    const r = cli(['scope-check', '--repo', f.work, '--base', base, '--head', head, '--branch', 'kiro/cards/card-01', '--summary', summary]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^::error::lane scope: src\/elsewhere\/x\.ts is outside lane cards\/card-01 \(paths: src\/backoffice\/\*\*\)$/m);
    assert.match(r.stderr, /\*\*lane scope\*\* — 1 problem\(s\)/);
    for (const line of r.stderr.split('\n').filter((l) => l.startsWith('::'))) assert.match(line, /^::(error|warning)::lane scope: [^\n]*$/);
    assert.match(readFileSync(summary, 'utf8'), /is outside lane cards\/card-01/);
    assert.equal(Q.annotation('error', 'lane scope', 'a\nb\r\nc%'), '::error::lane scope: a%0Ab%0D%0Ac%25');
  } finally { f.done(); }
});

// validateRange as it was before VTID-05365 (origin/main cf009eca8f), kept as the reference the batched one must
// equal (except R1). Private git helpers: these calls are NOT counted by gitSpawns.
const refCommitsInRange = (repo, base, head) => {
  const keys = ['Collab-Session', 'Collab-Lane', 'Collab-Review', 'Collab-Verdict', 'Collab-Reviewer', 'Collab-Reviewed-Head'];
  const fmt = `%H${keys.map((k) => `%x1f%(trailers:key=${k},valueonly,separator=%x2c)`).join('')}%x1e`;
  const out = refGit(repo, ['log', '--no-merges', `--format=${fmt}`, `${base}..${head}`]);
  return out.split('\x1e').map((s) => s.trim()).filter(Boolean).map((rec) => {
    const [sha, session, lane, review, verdict, reviewer, reviewedHead] = rec.split('\x1f').map((s) => (s || '').trim());
    const files = refGit(repo, ['diff-tree', '--no-commit-id', '--name-only', '-r', sha]).split('\n').filter(Boolean);
    return { sha, session, lane, review, verdict, reviewer, reviewedHead, files };
  });
};
const REF_PM_KEYS = ['state', 'parked_from', 'next_actor', 'seat', 'claimed_by', 'updated'];
function refPmAgentOverreach(repo, sha, p) {
  const a = refShowFile(repo, `${sha}^`, p);
  const b = refShowFile(repo, sha, p);
  if (a === null || b === null) return [a === null ? 'created the lane file' : 'deleted the lane file'];
  const fa = parseFrontMatter(a) || {};
  const fb = parseFrontMatter(b) || {};
  const out = [...new Set([...Object.keys(fa), ...Object.keys(fb)])]
    .filter((k) => !REF_PM_KEYS.includes(k) && JSON.stringify(fa[k]) !== JSON.stringify(fb[k])).map((k) => `changed ${k}`);
  const body = (t) => t.replace(/^---\r?\n[\s\S]*?\r?\n---/, '').replace(/\r\n/g, '\n');
  if (!body(b).startsWith(body(a))) out.push('rewrote the log (only appending an entry is allowed)');
  return out;
}
function refFrontMatterChanged(repo, sha, p) {
  const fm = (t) => (/^---\r?\n([\s\S]*?)\r?\n---/.exec(t || '') || [])[1] ?? null;
  return fm(refShowFile(repo, `${sha}^`, p)) !== fm(refShowFile(repo, sha, p));
}
function validateRangeReference(repo, { base, head, branch = '', allowInitial = [], fetchLane = null, fetchPlanLane = null }) {
  const errors = [];
  const warnings = [];
  const changed = refGit(repo, ['diff', '--name-only', `${base}...${head}`]).split('\n').filter(Boolean);
  const mergeBase = refGit(repo, ['merge-base', base, head]);
  const touched = changed.map((p) => ({ p, c: classifyPath(p) })).filter((x) => x.c);
  const slugs = new Set(touched.map((t) => t.c.slug));
  for (const slug of slugs) {
    const headFiles = refSpecFilesAt(repo, head).filter((p) => classifyPath(p).slug === slug);
    const laneIds = new Set(headFiles.map((p) => classifyPath(p)).filter((c) => c.kind === 'lane').map((c) => c.lane));
    for (const p of headFiles) {
      const c = classifyPath(p);
      const fm = parseFrontMatter(refShowFile(repo, head, p));
      const e = c.kind === 'plan' ? validatePlan(fm, slug) : validateLane(fm, slug, c.lane, laneIds);
      for (const x of e) errors.push(`${p}: ${x}`);
    }
    if (laneIds.size && !headFiles.some((p) => classifyPath(p).kind === 'plan')) errors.push(`.kiro/specs/${slug}: lanes without a handoff.md`);
  }
  const commits = refCommitsInRange(repo, base, head);
  for (const { p, c } of touched) {
    const before = parseFrontMatter(refShowFile(repo, mergeBase, p));
    const after = parseFrontMatter(refShowFile(repo, head, p));
    const ciSparred = c.kind === 'plan' && commits.some((k) => k.session === PS && k.files.includes(p))
      && ['drafted', 'sparred', undefined].includes(before?.state) && ['drafted', 'sparred', 'approved', 'parked'].includes(after?.state);
    if (ciSparred) continue;
    for (const x of checkTransition(c.kind, before, after, { allowInitial: allowInitial.includes(c.slug) })) errors.push(`${p}: ${x}`);
  }
  const laneTrailers = new Set(commits.map((k) => k.lane).filter(Boolean).flatMap((l) => l.split(',').map((s) => s.trim())));
  const workLanes = [...laneTrailers].filter((l) => !l.endsWith('/_plan'));
  if (workLanes.length > 1) errors.push(`one PR per lane: commits name ${workLanes.length} lanes (${workLanes.join(', ')})`);
  const sessionsByLane = new Map();
  for (const k of commits) {
    const short = k.sha.slice(0, 8);
    if (laneTrailers.size && (!k.session || !k.lane) && !k.review) errors.push(`${short}: a lane PR needs Collab-Session and Collab-Lane trailers on every commit`);
    if (k.session && !isSessionId(k.session)) errors.push(`${short}: Collab-Session "${k.session}" is not a session id`);
    if (k.lane && k.session !== 'pm-agent') {
      if (!sessionsByLane.has(k.lane)) sessionsByLane.set(k.lane, new Set());
      sessionsByLane.get(k.lane).add(k.session);
    }
    for (const f of k.files) {
      const c = classifyPath(f);
      if (!c) continue;
      const key = `${c.slug}/${c.lane}`;
      if (c.kind === 'lane' && k.session === 'pm-agent' && (k.lane === key || k.lane === `${c.slug}/_plan`)) {
        const bad = refPmAgentOverreach(repo, k.sha, f);
        if (bad.length) errors.push(`${short}: pm-agent may only change ${REF_PM_KEYS.join(', ')} and append a log entry in ${f} (${bad.join('; ')})`);
        continue;
      }
      if (k.lane === key) continue;
      if (c.kind === 'lane' && k.lane === `${c.slug}/_plan` && refShowFile(repo, `${k.sha}^`, f) === null) continue;
      if (c.kind === 'lane' && k.session === PS && k.lane === `${c.slug}/_plan`
        && parseFrontMatter(refShowFile(repo, k.sha, f))?.state === 'ready') continue;
      if (c.kind === 'lane' && k.review === key && !refFrontMatterChanged(repo, k.sha, f)) continue;
      if (c.kind === 'lane' && k.lane && k.lane !== key && Q.laneAdminCovers(repo, base, head, k.lane, f, fetchPlanLane, fetchLane)) continue;
      errors.push(`${short}: changes ${f} but its Collab-Lane is "${k.lane || 'none'}" (needs "${key}"${c.kind === 'lane' ? `, or Collab-Review: ${key} with the front matter unchanged` : ''})`);
    }
  }
  for (const [lane, sessions] of sessionsByLane) {
    if (sessions.size > 1) errors.push(`lane ${lane}: commits from ${sessions.size} sessions (${[...sessions].join(', ')}) — one session per lane`);
    const [slug, id] = lane.split('/');
    if (id === '_plan') continue;
    const lanePath = `.kiro/specs/${slug}/lanes/${id}.md`;
    const fm = parseFrontMatter(refShowFile(repo, head, lanePath) ?? (fetchLane ? fetchLane(lanePath) : null));
    if (!fm) { errors.push(`Collab-Lane ${lane}: ${lanePath} does not exist${fetchLane ? ' here or in vitana-platform' : ''}`); continue; }
    const s = [...sessions][0];
    if (fm.claimed_by && fm.claimed_by !== s) errors.push(`lane ${lane}: claimed_by is ${fm.claimed_by} but the commits come from ${s}`);
  }
  const bm = /^(kiro|claude)\/([^/]+)\/([^/]+)$/.exec(branch);
  if (bm) {
    const want = `${bm[2]}/${bm[3]}`;
    for (const l of workLanes) if (l !== want) errors.push(`branch ${branch} is lane ${want} but commits name ${l}`);
  } else if (branch && workLanes.length) {
    warnings.push(`branch "${branch}" is not in the form <kiro|claude>/<slug>/<lane-id>; matched by trailers only`);
  }
  return { errors, warnings, touched: touched.map((t) => t.p) };
}

/**
 * A lane PR with `n` pm-agent lane-state commits, plus: the builder's work commit, an overreaching pm-agent commit, a
 * pm-agent commit that rewrites the log, a review entry, a `_plan` commit by ci-plan-spar that creates a lane and one
 * that writes its VTID, and a CRLF / multi-byte lane-file log. → { base, head }
 */
function batchRangeFixture(f, n) {
  const L = { ...LANE, reviewer_seat: AG, state: 'executing', claimed_by: JT };
  const base = scopeFixture(f, L);
  const at = (o, log) => `${laneMd('card-01', { next_actor: 'kiro', vtid: 'VTID-00002', ...L, ...o })}${log}`;
  let log = '### work · ünïcödé — ✓\r\n';
  write(f.work, '.kiro/specs/cards/lanes/card-01.md', at({}, log));
  write(f.work, 'src/backoffice/a.ts', 'x');
  commit(f.work, 'work', { 'Collab-Session': JT, 'Collab-Lane': 'cards/card-01' });
  for (let i = 0; i < n; i++) {
    log += `### pm ${i}\n`;
    write(f.work, '.kiro/specs/cards/lanes/card-01.md', at({ updated: `2026-10-20T18:${String(i % 60).padStart(2, '0')}Z` }, log));
    commit(f.work, `pm ${i}`, { 'Collab-Session': 'pm-agent', 'Collab-Lane': 'cards/card-01' });
  }
  write(f.work, '.kiro/specs/cards/lanes/card-01.md', at({ paths: ['**'] }, log));
  commit(f.work, 'pm widens', { 'Collab-Session': 'pm-agent', 'Collab-Lane': 'cards/card-01' });
  write(f.work, '.kiro/specs/cards/lanes/card-01.md', at({}, log.replace('### pm 0\n', '')));
  commit(f.work, 'pm rewrites', { 'Collab-Session': 'pm-agent', 'Collab-Lane': 'cards/card-01' });
  const cur = readFileSync(path.join(f.work, '.kiro/specs/cards/lanes/card-01.md'), 'utf8');
  write(f.work, '.kiro/specs/cards/lanes/card-01.md', `${cur}### review\n`);
  commit(f.work, 'review', { 'Collab-Session': AGS, 'Collab-Review': 'cards/card-01', 'Collab-Verdict': 'accept', 'Collab-Reviewer': `${AG} (claude-sonnet-5.5)` });
  write(f.work, '.kiro/specs/cards/lanes/card-02.md', laneMd('card-02', { next_actor: 'kiro' }));
  commit(f.work, 'new lane', { 'Collab-Session': PS, 'Collab-Lane': 'cards/_plan' });
  write(f.work, '.kiro/specs/cards/lanes/card-02.md', laneMd('card-02', { next_actor: 'kiro', vtid: 'VTID-00003' }));
  const head = commit(f.work, 'vtid', { 'Collab-Session': PS, 'Collab-Lane': 'cards/_plan' });
  return { base, head };
}

test('VTID-05365 batching: validateRange and scopeCheck start as many git processes for 3 as for 30 commits; output equals the reference', () => {
  const runs = [3, 30].map((n) => {
    const f = fixture();
    try {
      const { base, head } = batchRangeFixture(f, n);
      const opts = { base, head, branch: 'kiro/cards/card-01' };
      const v = spawnsOf(() => validateRange(f.work, opts));
      const s = spawnsOf(() => scopeCheck(f.work, opts));
      const ref = validateRangeReference(f.work, opts);
      assert.deepEqual(v.value.errors, ref.errors, `n=${n}`);
      assert.deepEqual(v.value.warnings, ref.warnings, `n=${n}`);
      assert.deepEqual(v.value.touched, ref.touched, `n=${n}`);
      for (const e of [v.value.errors, s.value.errors]) {
        assert.ok(e.some((x) => x.includes('pm-agent may only change') && x.includes('changed paths')), e.join('\n'));
        assert.ok(e.some((x) => x.includes('rewrote the log')), e.join('\n'));
      }
      assert.equal(v.value.errors.filter((x) => x.includes('pm-agent may only change')).length, 2, v.value.errors.join('\n'));
      return { v: v.spawns, s: s.spawns };
    } finally { f.done(); }
  });
  assert.equal(runs[0].v, runs[1].v, `validateRange spawns: 3 commits ${runs[0].v}, 30 commits ${runs[1].v}`);
  assert.equal(runs[0].s, runs[1].s, `scopeCheck spawns: 3 commits ${runs[0].s}, 30 commits ${runs[1].s}`);
});

test('VTID-05365 batching: commit files equal diff-tree per commit (add, delete, rename, nested, unusual names)', () => {
  const f = fixture();
  try {
    const base = sh(f.work, 'rev-parse', 'HEAD');
    write(f.work, 'a/b c/ü.txt', 'x\n');
    write(f.work, 'old.txt', 'x\n'.repeat(20));
    commit(f.work, 'one', { 'Collab-Session': S1, 'Collab-Lane': 'cards/card-01' });
    sh(f.work, 'mv', 'old.txt', 'new.txt');
    rmSync(path.join(f.work, 'a/b c/ü.txt'));
    commit(f.work, 'two', { 'Collab-Session': S1 });
    sh(f.work, 'commit', '-q', '--allow-empty', '-m', 'empty');
    const head = sh(f.work, 'rev-parse', 'HEAD');
    const got = Q.commitsInRange(f.work, base, head);
    const ref = refCommitsInRange(f.work, base, head);
    assert.deepEqual(got, ref);
    assert.equal(got.length, 3);
  } finally { f.done(); }
});

test('VTID-05365 batching: commitFileReader equals git show in memory and through the temporary file; 2 git spawns', () => {
  const f = fixture();
  try {
    write(f.work, 'l/a.md', '---\nx: 1\n---\nünï ✓\r\n\n\n');
    write(f.work, 'l/e.md', '');
    const c1 = commit(f.work, 'one');
    write(f.work, 'l/a.md', '---\nx: 2\n---\nbody\n');
    rmSync(path.join(f.work, 'l/e.md'));
    write(f.work, 'l/n.md', 'new\n');
    const c2 = commit(f.work, 'two');
    const needs = [c1, c2].flatMap((sha) => ['l/a.md', 'l/e.md', 'l/n.md', 'l/none.md'].map((p) => ({ sha, path: p })));
    for (const inMemoryMax of [Infinity, 0]) {
      const { value: r, spawns } = spawnsOf(() => Q.commitFileReader(f.work, needs, { inMemoryMax }));
      assert.equal(spawns, 2, `inMemoryMax ${inMemoryMax}`);
      try {
        for (const { sha, path: p } of needs) for (const rev of [`${sha}^`, sha]) assert.equal(r.read(rev, p), refShowFile(f.work, rev, p), `${rev}:${p} (${inMemoryMax})`);
      } finally { r.close(); }
    }
    const none = spawnsOf(() => Q.commitFileReader(f.work, []));
    assert.equal(none.spawns, 0);
  } finally { f.done(); }
});