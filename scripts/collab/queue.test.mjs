// VTID-05145 — tests for scripts/collab/queue.mjs. Run: node --test scripts/collab/queue.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  validateRegistry, loadSeats,
  parseFrontMatter, classifyPath, validatePlan, validateLane, checkTransition,
  collect, buildQueue, validateRange, claim, release, listClaims, sessionId,
  scopeCheck, governanceRecord, globToRegex, matchesAny, globTouchesGovernance, isSessionId, seatOf, loadPrograms, validatePrograms, programIndex,
} from './queue.mjs';

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

test('scope-check: a governance path inside paths needs governance: true; since VTID-05259 legacy claude lanes no longer reach it', () => {
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
    assert.ok(scopeCheck(g.work, { base, head: h2 }).errors.some((x) => x.includes('legacy executor: claude lanes no longer reach')));
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
    const out = execFileSync('node', [path.join(path.dirname(new URL(import.meta.url).pathname), 'queue.mjs'), '--repo', f.work, '--program', 'alpha'], { encoding: 'utf8' });
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

test('VTID-05213 review: a lane PR cannot widen its own permissions; since VTID-05259 not even a session_ id on a claude lane', () => {
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
    const e2 = scopeCheck(f.work, { base: b2, head: h2 }).errors;
    assert.ok(e2.some((x) => x.includes('paths changed in a lane PR')), e2.join('\n'));
    assert.ok(e2.some((x) => x.startsWith('b/x.ts is outside')), 'judged against the base paths: ' + e2.join('\n'));
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

// ── VTID-05259 (retire-claude-code): governance lanes without Claude Code ──

const GOV = { executor: 'kiro', seat: 'exafyltd', reviewer_seat: 'jtadic', governance: 'true', paths: ['.github/workflows/**', 'scripts/x.mjs'] };
const omit = (o, k) => Object.fromEntries(Object.entries(o).filter(([key]) => key !== k));

test('VTID-05259 validateLane: governance: true lets a Kiro lane declare governance paths, with two different Kiro seats', () => {
  const v = (o) => validateLane(parseFrontMatter(laneMd('a', o)), 'cards', 'a', new Set(['a']));
  assert.deepEqual(v(GOV), []);
  assert.ok(v({ ...GOV, governance: 'false' }).some((e) => e.includes('needs governance: true')), 'false = not a governance lane');
  assert.ok(v({ executor: 'kiro', paths: ['.github/workflows/x.yml'] }).some((e) => e.includes('needs governance: true')));
  assert.ok(v({ ...GOV, governance: 'yes' }).some((e) => e.includes('governance must be true or false')));
  assert.ok(v({ ...GOV, reviewer_seat: 'claude' }).some((e) => e.includes('not claude')));
  assert.ok(v(omit(GOV, 'reviewer_seat')).some((e) => e.includes('reviewer_seat')));
  assert.ok(v({ ...GOV, reviewer_seat: 'exafyltd' }).some((e) => e.includes('reviewer_seat must differ')));
  assert.ok(v(omit(GOV, 'seat')).some((e) => e.includes('needs a seat')));
  assert.ok(v({ ...GOV, executor: 'claude' }).some((e) => e.includes('for executor: kiro lanes')));
  assert.deepEqual(v({ executor: 'claude', paths: ['.github/workflows/x.yml'] }), [], 'legacy claude lanes unchanged');
});

test('VTID-05259 scope-check: a governance lane may change governance paths, built by its seat and reviewed by reviewer_seat only', () => {
  const f = fixture();
  try {
    const base = scopeFixture(f, GOV);
    const EX2 = 'kiro-exafyltd-202610201041-ab5d';
    write(f.work, '.github/workflows/x.yml', 'runs-on: ubuntu-24.04');
    write(f.work, '.kiro/specs/cards/lanes/card-01.md', laneMd('card-01', { ...GOV, state: 'executing', vtid: 'VTID-00002', claimed_by: EX2 }));
    const head = commit(f.work, 'pin', { 'Collab-Session': EX2, 'Collab-Lane': 'cards/card-01' });
    assert.deepEqual(scopeCheck(f.work, { base, head, branch: 'kiro/cards/card-01' }).errors, []);
    // review entry from reviewer_seat passes; from the builder's seat, unseated or session_ ids fails
    const review = (session) => {
      sh(f.work, 'checkout', '-q', '-B', `kiro/rv-${session.slice(0, 12)}`, head);
      write(f.work, '.kiro/specs/cards/lanes/card-01.md', `${laneMd('card-01', { ...GOV, state: 'executing', vtid: 'VTID-00002', claimed_by: EX2 })}### review: approve\n`);
      const h = commit(f.work, 'review', { 'Collab-Session': session, 'Collab-Review': 'cards/card-01' });
      return scopeCheck(f.work, { base, head: h, branch: 'kiro/cards/card-01' }).errors;
    };
    assert.deepEqual(review(JT), []);
    assert.ok(review('kiro-exafyltd-202610201200-ee01').some((x) => x.includes('reviewed only by seat jtadic')), 'builder seat may not review');
    assert.ok(review(S1).some((x) => x.includes('reviewed only by seat jtadic')), 'unseated id refused');
    assert.ok(review(S2).some((x) => x.includes('reviewed only by seat jtadic')), 'session_ id refused');
    // built by another seat, or by an unseated id: refused
    for (const s of [JT, S1, S2]) {
      sh(f.work, 'checkout', '-q', '-B', `kiro/b-${s.slice(0, 12)}`, base);
      write(f.work, '.github/workflows/x.yml', 'y');
      const h = commit(f.work, 'pin', { 'Collab-Session': s, 'Collab-Lane': 'cards/card-01' });
      assert.ok(scopeCheck(f.work, { base, head: h, branch: 'kiro/cards/card-01' }).errors.some((x) => x.includes('built only by seat exafyltd')), s);
    }
    // still bounded by its paths
    sh(f.work, 'checkout', '-q', '-B', 'kiro/out', base);
    write(f.work, 'CLAUDE.md', 'x');
    const h5 = commit(f.work, 'out', { 'Collab-Session': EX2, 'Collab-Lane': 'cards/card-01' });
    assert.ok(scopeCheck(f.work, { base, head: h5, branch: 'kiro/cards/card-01' }).errors.some((x) => x.startsWith('CLAUDE.md is outside')));
  } finally { f.done(); }
});

test('VTID-05259 scope-check: a lane PR cannot make itself a governance lane; a non-governance Kiro lane still cannot touch governance', () => {
  const f = fixture();
  try {
    const base = scopeFixture(f, { ...LANE, paths: ['.github/workflows/**'] });
    write(f.work, '.kiro/specs/cards/lanes/card-01.md', laneMd('card-01', { ...LANE, paths: ['.github/workflows/**'], governance: 'true', state: 'executing', vtid: 'VTID-00002', claimed_by: JT }));
    write(f.work, '.github/workflows/x.yml', 'x');
    const head = commit(f.work, 'self-grant', { 'Collab-Session': JT, 'Collab-Lane': 'cards/card-01' });
    const e = scopeCheck(f.work, { base, head, branch: 'kiro/cards/card-01' }).errors;
    assert.ok(e.some((x) => x.includes('governance changed in a lane PR')), e.join('\n'));
    assert.ok(e.some((x) => x.includes('is a governance path')), 'judged as the base (non-governance) lane: ' + e.join('\n'));
  } finally { f.done(); }
});

test('VTID-05259 scope-check: legacy reviewer_seat claude accepts another named Kiro seat, not the lane seat', () => {
  const f = fixture();
  try {
    const L = { ...LANE, reviewer_seat: 'claude' };
    const base = scopeFixture(f, L);
    const review = (session) => {
      sh(f.work, 'checkout', '-q', '-B', `kiro/r-${session.slice(0, 12)}`, base);
      write(f.work, '.kiro/specs/cards/lanes/card-01.md', `${laneMd('card-01', { next_actor: 'kiro', vtid: 'VTID-00002', ...L })}### review\n`);
      return scopeCheck(f.work, { base, head: commit(f.work, 'r', { 'Collab-Session': session, 'Collab-Review': 'cards/card-01' }) }).errors;
    };
    assert.deepEqual(review(EX), []);
    assert.deepEqual(review(S2), []);
    assert.ok(review(JT).some((x) => x.includes('reviewer_seat is claude')), 'the lane seat never reviews its own lane');
    assert.ok(review(S1).some((x) => x.includes('reviewer_seat is claude')), 'unseated id refused');
  } finally { f.done(); }
});

test('VTID-05259 validate: an existing lane is never edited by a _plan commit — permissions change only in a new plan', () => {
  const f = fixture();
  try {
    write(f.work, '.kiro/specs/cards/handoff.md', planMd({ state: 'approved', sparring_record: 'x.md', vtids: ['VTID-00002'], executor: 'kiro', next_actor: 'kiro', author_seat: 'exafyltd' }));
    write(f.work, '.kiro/specs/cards/plan.md', 'plan v1\n');
    write(f.work, '.kiro/specs/cards/lanes/a.md', laneMd('a', { next_actor: 'kiro', vtid: 'VTID-00002', ...LANE }));
    const base = commit(f.work, 'seed', { 'Collab-Session': S2, 'Collab-Lane': 'cards/_plan' });
    sh(f.work, 'push', '-q', 'origin', 'main');
    const edit = (session, handoffSeat) => {
      sh(f.work, 'checkout', '-q', '-B', `p-${session.slice(5, 12)}-${handoffSeat}`, base);
      if (handoffSeat) write(f.work, '.kiro/specs/cards/handoff.md', planMd({ state: 'approved', sparring_record: 'x.md', vtids: ['VTID-00002'], executor: 'kiro', next_actor: 'kiro', author_seat: handoffSeat }));
      write(f.work, '.kiro/specs/cards/plan.md', 'plan v2\n');
      write(f.work, '.kiro/specs/cards/lanes/a.md', laneMd('a', { next_actor: 'kiro', vtid: 'VTID-00002', ...LANE, governance: 'true', paths: ['.github/**'] }));
      return validateRange(f.work, { base, head: commit(f.work, 'edit', { 'Collab-Session': session, 'Collab-Lane': 'cards/_plan' }) }).errors;
    };
    assert.ok(edit(EX).some((x) => x.includes('lanes/a.md')), 'even the author seat, with a plan.md change');
    assert.ok(edit(JT, 'jtadic').some((x) => x.includes('lanes/a.md')), 'rewriting author_seat in the same PR does not help');
  } finally { f.done(); }
});

test('VTID-05259 governanceRecord: only new, quoted log lines count', () => {
  const lane = (body, fmx = '') => `---\nlane: a\n${fmx}---\n## Log\n${body}`;
  assert.deepEqual(governanceRecord(lane(''), lane('- owner-instruction: "merge #4211" (2026-10-20)\n- merge: 2e3c9f12\n')), { instruction: true, merge: '2e3c9f12', mergeRepo: null });
  assert.deepEqual(governanceRecord(lane(''), lane('- merge: vitana-v1@2e3c9f12\n')), { instruction: false, merge: '2e3c9f12', mergeRepo: 'vitana-v1' });
  assert.equal(governanceRecord(lane(''), lane('- owner-instruction: "   "\n')).instruction, false, 'whitespace only');
  assert.equal(governanceRecord(lane(''), lane('', 'owner-instruction: "merge it"\nmerge: deadbeef\n')).instruction, false, 'front matter does not count');
  assert.equal(governanceRecord(lane(''), lane('', 'merge: deadbeef\n')).merge, null);
  const old = '- owner-instruction: "merge #1" (old cycle)\n';
  assert.equal(governanceRecord(lane(old), lane(old)).instruction, false, 'an older entry does not count');
  for (const ph of ['TODO', 'none', '-', 'tbd']) assert.equal(governanceRecord(lane(''), lane(`- owner-instruction: "${ph}"\n`)).instruction, false, ph);
  assert.equal(governanceRecord(lane(''), lane('- owner-instruction: merge it\n')).instruction, false, 'unquoted');
});

test('VTID-05259 validate: a governance lane reaches verified only with a new owner-instruction, done only with a real merge commit', () => {
  const f = fixture();
  try {
    const EX2 = 'kiro-exafyltd-202610201041-ab5d';
    const fm = (state) => ({ ...GOV, next_actor: 'kiro', vtid: 'VTID-00002', state });
    write(f.work, '.kiro/specs/cards/handoff.md', planMd({ state: 'executing', sparring_record: 'x.md', vtids: ['VTID-00002'], executor: 'kiro', next_actor: 'kiro' }));
    write(f.work, '.kiro/specs/cards/lanes/a.md', laneMd('a', fm('in-review')));
    const base = commit(f.work, 'seed', { 'Collab-Session': S2, 'Collab-Lane': 'cards/_plan' });
    sh(f.work, 'push', '-q', 'origin', 'main');
    let n = 0;
    const move = (state, extra, from = base) => {
      sh(f.work, 'checkout', '-q', '-B', `m-${n++}`, from);
      write(f.work, '.kiro/specs/cards/lanes/a.md', `${laneMd('a', fm(state))}${extra}`);
      const h = commit(f.work, 'move', { 'Collab-Session': EX2, 'Collab-Lane': 'cards/a' });
      return { h, e: validateRange(f.work, { base: from, head: h }).errors };
    };
    assert.ok(move('verified', '').e.some((x) => x.includes('owner-instruction')));
    assert.ok(move('verified', '- owner-instruction: "TODO"\n').e.some((x) => x.includes('owner-instruction')));
    const instr = '- owner-instruction: "merge #4211" (2026-10-20)\n';
    const ok = move('verified', instr);
    assert.deepEqual(ok.e, []);
    assert.ok(move('done', instr, ok.h).e.some((x) => x.includes('merge: <sha>')));
    assert.ok(move('done', `${instr}- merge: deadbeefcafe\n`, ok.h).e.some((x) => x.includes('not a commit')));
    assert.deepEqual(move('done', `${instr}- merge: ${base}\n`, ok.h).e, []);
  } finally { f.done(); }
});

test('VTID-05259 review fixes: _plan and review commits cannot carry code; new lanes grant no governance; v1 cannot shadow a platform lane', () => {
  const EX2 = 'kiro-exafyltd-202610201041-ab5d';
  const f = fixture();
  try {
    const base = scopeFixture(f, { ...GOV, state: 'executing', claimed_by: EX2 });
    write(f.work, '.github/workflows/x.yml', 'a');
    const built = commit(f.work, 'build', { 'Collab-Session': EX2, 'Collab-Lane': 'cards/card-01' });
    // F1: a _plan-labelled commit that changes governance code is not exempt
    for (const who of [JT, S1, S2]) {
      sh(f.work, 'checkout', '-q', '-B', `kiro/cards/card-01`, built);
      write(f.work, '.github/workflows/evil.yml', who);
      const h = commit(f.work, 'p', { 'Collab-Session': who, 'Collab-Lane': 'cards/_plan' });
      assert.ok(scopeCheck(f.work, { base, head: h, branch: 'kiro/cards/card-01' }).errors.some((x) => x.includes('built only by seat exafyltd')), who);
    }
    // a _plan commit touching only the spec folder stays fine
    sh(f.work, 'checkout', '-q', '-B', 'kiro/cards/card-01', built);
    write(f.work, '.kiro/specs/cards/handoff.md', planMd({ state: 'executing', sparring_record: 'x.md', vtids: ['VTID-00002'], executor: 'kiro', next_actor: 'kiro' }).replace('## Log', '## Log\n### note'));
    assert.deepEqual(scopeCheck(f.work, { base, head: commit(f.work, 'log', { 'Collab-Session': EX2, 'Collab-Lane': 'cards/_plan' }), branch: 'kiro/cards/card-01' }).errors, []);
    // F2: the reviewer rewrites code under Collab-Review
    sh(f.work, 'checkout', '-q', '-B', 'kiro/cards/card-01', built);
    write(f.work, '.github/workflows/x.yml', 'rewritten by reviewer');
    write(f.work, '.kiro/specs/cards/lanes/card-01.md', `${laneMd('card-01', { next_actor: 'kiro', vtid: 'VTID-00002', ...GOV, state: 'executing', claimed_by: EX2 })}### review: approve\n`);
    const hr = commit(f.work, 'review', { 'Collab-Session': JT, 'Collab-Review': 'cards/card-01' });
    assert.ok(scopeCheck(f.work, { base, head: hr, branch: 'kiro/cards/card-01' }).errors.some((x) => x.includes('may change only')));
  } finally { f.done(); }
  // F3: a governance lane created in the PR that uses it; and no new executor: claude lane
  const g = fixture();
  try {
    const base = scopeFixture(g, LANE);
    sh(g.work, 'checkout', '-q', '-B', 'kiro/cards/card-09');
    write(g.work, '.kiro/specs/cards/lanes/card-09.md', laneMd('card-09', { ...GOV, seat: 'jtadic', reviewer_seat: 'exafyltd', paths: ['.github/**', 'CLAUDE.md'] }));
    commit(g.work, 'create', { 'Collab-Session': JT, 'Collab-Lane': 'cards/_plan' });
    write(g.work, 'CLAUDE.md', 'x');
    const h = commit(g.work, 'build', { 'Collab-Session': JT, 'Collab-Lane': 'cards/card-09' });
    assert.ok(scopeCheck(g.work, { base, head: h, branch: 'kiro/cards/card-09' }).errors.some((x) => x.includes('created in this PR')));
    // nor any other path: a lane is used only after its plan PR merged
    sh(g.work, 'checkout', '-q', '-B', 'kiro/cards/card-11', base);
    write(g.work, '.kiro/specs/cards/lanes/card-11.md', laneMd('card-11', { ...LANE, seat: 'jtadic', next_actor: 'kiro', paths: ['src/**', 'supabase/**'] }));
    commit(g.work, 'create', { 'Collab-Session': JT, 'Collab-Lane': 'cards/_plan' });
    write(g.work, 'supabase/migrations/9999_x.sql', 'drop table x;');
    const h3 = commit(g.work, 'build', { 'Collab-Session': JT, 'Collab-Lane': 'cards/card-11' });
    assert.ok(scopeCheck(g.work, { base, head: h3, branch: 'kiro/cards/card-11' }).errors.some((x) => x.includes('grants no paths yet')));
    sh(g.work, 'checkout', '-q', '-B', 'kiro/cards/card-10', base);
    write(g.work, '.kiro/specs/cards/lanes/card-10.md', laneMd('card-10', { executor: 'claude', next_actor: 'kiro', paths: ['.github/**'] }));
    const h2 = commit(g.work, 'create', { 'Collab-Session': JT, 'Collab-Lane': 'cards/_plan' });
    assert.ok(validateRange(g.work, { base, head: h2 }).errors.some((x) => x.includes('not executor: claude')));
  } finally { g.done(); }
  // F4: a vitana-v1 PR that adds its own copy of a platform lane is judged by the platform copy
  const v = fixture();
  try {
    const base = sh(v.work, 'rev-parse', 'HEAD');
    sh(v.work, 'checkout', '-q', '-b', 'kiro/cards/rules-v1');
    write(v.work, '.kiro/specs/cards/handoff.md', planMd());
    write(v.work, '.kiro/specs/cards/lanes/rules-v1.md', laneMd('rules-v1', { ...GOV, paths: ['**'] }));
    commit(v.work, 'shadow', { 'Collab-Session': EX2, 'Collab-Lane': 'cards/_plan' });
    write(v.work, 'CLAUDE.md', 'x');
    const h = commit(v.work, 'build', { 'Collab-Session': EX2, 'Collab-Lane': 'cards/rules-v1' });
    const platform = () => laneMd('rules-v1', { ...GOV, paths: ['.github/workflows/PR-GATE.yml'], state: 'executing', vtid: 'VTID-00003', claimed_by: EX2 });
    const r = scopeCheck(v.work, { base, head: h, branch: 'kiro/cards/rules-v1', fetchLane: platform });
    assert.equal(r.source, 'vitana-platform');
    assert.ok(r.errors.some((x) => x.startsWith('CLAUDE.md is outside')), r.errors.join('\n'));
    assert.ok(scopeCheck(v.work, { base, head: h, branch: 'kiro/cards/rules-v1', fetchLane: () => null }).errors.some((x) => x.includes('created in this PR')));
  } finally { v.done(); }
});

test('VTID-05259 review fixes: a seatless legacy reviewer_seat claude lane is not self-reviewed; a reviewer that built is refused', () => {
  const f = fixture();
  try {
    const L = { executor: 'kiro', reviewer_seat: 'claude', paths: ['src/backoffice/**'], state: 'executing', claimed_by: JT };
    const base = scopeFixture(f, L);
    write(f.work, 'src/backoffice/a.ts', 'x');
    commit(f.work, 'build', { 'Collab-Session': JT, 'Collab-Lane': 'cards/card-01' });
    write(f.work, '.kiro/specs/cards/lanes/card-01.md', `${laneMd('card-01', { next_actor: 'kiro', vtid: 'VTID-00002', ...L })}### review: approve\n`);
    const h = commit(f.work, 'review', { 'Collab-Session': JT, 'Collab-Review': 'cards/card-01' });
    assert.ok(scopeCheck(f.work, { base, head: h }).errors.some((x) => x.includes('reviewer_seat is claude')));
  } finally { f.done(); }
});

test('VTID-05259 round 2: merge must be on base (or verified in the other repo); new governance lanes only in a newly approved plan', () => {
  const EX2 = 'kiro-exafyltd-202610201041-ab5d';
  const f = fixture();
  try {
    const fm = (state) => ({ ...GOV, next_actor: 'kiro', vtid: 'VTID-00002', state });
    write(f.work, '.kiro/specs/cards/handoff.md', planMd({ state: 'executing', sparring_record: 'x.md', vtids: ['VTID-00002'], executor: 'kiro', next_actor: 'kiro' }));
    write(f.work, '.kiro/specs/cards/lanes/a.md', laneMd('a', fm('verified')));
    const base = commit(f.work, 'seed', { 'Collab-Session': S2, 'Collab-Lane': 'cards/_plan' });
    sh(f.work, 'push', '-q', 'origin', 'main');
    sh(f.work, 'checkout', '-q', '-b', 'kiro/cards/a');
    write(f.work, '.github/workflows/x.yml', 'noise');
    const own = commit(f.work, 'noise', { 'Collab-Session': EX2, 'Collab-Lane': 'cards/a' });
    const done = (line, verifyMerge) => {
      sh(f.work, 'checkout', '-q', '-B', 'kiro/cards/a', own);
      write(f.work, '.kiro/specs/cards/lanes/a.md', `${laneMd('a', fm('done'))}${line}`);
      const h = commit(f.work, 'done', { 'Collab-Session': EX2, 'Collab-Lane': 'cards/a' });
      return validateRange(f.work, { base, head: h, verifyMerge }).errors;
    };
    assert.ok(done(`- merge: ${own}\n`).some((x) => x.includes('not a commit on the base branch')), 'a commit of the PR itself');
    assert.deepEqual(done(`- merge: ${base}\n`), []);
    assert.deepEqual(done('- merge: vitana-v1@4f0c2a9e1b7d\n', (r, sha) => r === 'vitana-v1' && sha === '4f0c2a9e1b7d'), []);
    assert.ok(done('- merge: vitana-v1@4f0c2a9e1b7d\n', () => false).some((x) => x.includes('could not be verified')));
    assert.ok(done('- merge: vitana-v1@4f0c2a9e1b7d\n', () => { throw new Error('gh down'); }).some((x) => x.includes('could not be verified')), 'fail closed');
    assert.ok(done('- merge: vitana-v1@4f0c2a9e1b7d\n', null).some((x) => x.includes('could not be verified')), 'no verifier = fail closed');
  } finally { f.done(); }
  // N6: minting a governance lane into an existing plan, or without PLAN-SPAR approval, or from another seat
  const g = fixture();
  try {
    const base = scopeFixture(g, LANE);
    sh(g.work, 'checkout', '-q', '-B', 'not-a-plan');
    write(g.work, '.kiro/specs/cards/lanes/card-02.md', laneMd('card-02', { ...GOV, next_actor: 'kiro' }));
    const h = commit(g.work, 'mint', { 'Collab-Session': EX2, 'Collab-Lane': 'cards/_plan' });
    assert.ok(validateRange(g.work, { base, head: h }).errors.some((x) => x.includes('creates governance lane')), 'existing plan');
  } finally { g.done(); }
  const n = fixture();
  try {
    const base = sh(n.work, 'rev-parse', 'HEAD');
    sh(n.work, 'checkout', '-q', '-b', 'kiro/new/plan');
    const mk = (session) => {
      sh(n.work, 'checkout', '-q', '-B', `kiro/new/plan-${session.slice(5, 11)}`, base);
      write(n.work, '.kiro/specs/new/handoff.md', planMd({ slug: 'new', author_seat: 'exafyltd' }));
      write(n.work, '.kiro/specs/new/lanes/g.md', laneMd('g', { ...GOV, next_actor: 'kiro' }));
      commit(n.work, 'plan', { 'Collab-Session': session, 'Collab-Lane': 'new/_plan' });
      const before = validateRange(n.work, { base, head: sh(n.work, 'rev-parse', 'HEAD') }).errors;
      write(n.work, '.kiro/specs/new/handoff.md', planMd({ slug: 'new', author_seat: 'exafyltd', state: 'approved', sparring_record: 'x.md', vtids: ['VTID-09001'], next_actor: 'kiro' }));
      write(n.work, '.kiro/specs/new/lanes/g.md', laneMd('g', { ...GOV, next_actor: 'kiro', vtid: 'VTID-09001' }));
      const h = commit(n.work, 'spar', { 'Collab-Session': 'ci-plan-spar', 'Collab-Lane': 'new/_plan' });
      return { before, after: validateRange(n.work, { base, head: h }).errors };
    };
    const ok = mk(EX2);
    assert.ok(ok.before.some((x) => x.includes('creates governance lane')), 'not yet approved by PLAN-SPAR');
    assert.deepEqual(ok.after.filter((x) => x.includes('governance lane')), [], ok.after.join('\n'));
    assert.ok(mk(JT).after.some((x) => x.includes('creates governance lane')), 'not the author seat');
    assert.ok(mk(S1).after.some((x) => x.includes('creates governance lane')), 'unseated');
  } finally { n.done(); }
});
