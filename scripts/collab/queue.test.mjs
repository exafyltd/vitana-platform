// VTID-05145 — tests for scripts/collab/queue.mjs. Run: node --test scripts/collab/queue.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseFrontMatter, classifyPath, validatePlan, validateLane, checkTransition,
  collect, buildQueue, validateRange, claim, release, listClaims, sessionId,
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
