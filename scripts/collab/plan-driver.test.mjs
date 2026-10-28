// VTID-05272 — tests for scripts/collab/plan-driver.mjs. Run: node --test scripts/collab/plan-driver.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { heartbeat, heartbeatAge, driverTip, planNext, hotKeys, hotConflict, openRounds, next, ALIVE_MS } from './plan-driver.mjs';

const ME = 'kiro-exafy-202610201807-2a87';
const OTHER = 'kiro-jtadic-202610201807-022d';

// ── git fixtures (bare remote, as in queue.test.mjs) ──
function sh(cwd, args, env = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', ...env } }).trim();
}
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'driver-'));
  const origin = path.join(dir, 'origin.git');
  sh(dir, ['init', '-q', '--bare', '-b', 'main', origin]);
  const work = path.join(dir, 'work');
  sh(dir, ['clone', '-q', origin, work]);
  sh(work, ['checkout', '-q', '-b', 'main']);
  writeFileSync(path.join(work, 'README.md'), 'x\n');
  sh(work, ['add', '.']);
  sh(work, ['commit', '-q', '-m', 'init']);
  sh(work, ['push', '-q', 'origin', 'main']);
  sh(work, ['remote', 'set-head', 'origin', 'main']);
  return { dir, origin, work, done: () => rmSync(dir, { recursive: true, force: true }) };
}
function write(work, rel, text) {
  mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
  writeFileSync(path.join(work, rel), text);
}
/** A foreign driver tip whose committer date is `ageMs` in the past. */
function foreignTip(f, slug, session, ageMs) {
  const tree = sh(f.work, ['rev-parse', 'origin/main^{tree}']);
  const parent = sh(f.work, ['rev-parse', 'origin/main']);
  const date = `${Math.floor((Date.now() - ageMs) / 1000)} +0000`;
  const sha = sh(f.work, ['commit-tree', tree, '-p', parent, '-m', `collab-driver ${slug}`, '-m', `Collab-Session: ${session}\nCollab-Driver: ${slug}`],
    { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date });
  sh(f.work, ['push', '-q', 'origin', `${sha}:refs/heads/collab-driver/${slug}`]);
  return sha;
}

// ── heartbeat (§4.7) ──
test('heartbeat: first call creates the ref, the second fast-forwards it, the tree is main\'s tree', () => {
  const f = fixture();
  try {
    assert.equal(heartbeatAge(f.work, 'cards'), 'none');
    const a = heartbeat(f.work, 'cards', ME);
    assert.equal(a.ok, true);
    assert.equal(sh(f.work, ['rev-parse', `${a.sha}^{tree}`]), sh(f.work, ['rev-parse', 'origin/main^{tree}']));
    assert.equal(sh(f.work, ['rev-parse', `${a.sha}^`]), sh(f.work, ['rev-parse', 'origin/main']));
    const msg = sh(f.work, ['log', '-1', '--format=%B', a.sha]);
    assert.match(msg, new RegExp(`^Collab-Session: ${ME}$`, 'm'));
    assert.match(msg, /^Collab-Driver: cards$/m);
    const b = heartbeat(f.work, 'cards', ME);
    assert.equal(b.ok, true);
    assert.equal(sh(f.work, ['rev-parse', `${b.sha}^`]), a.sha, 'parent is the previous tip (fast-forward)');
    assert.equal(sh(f.work, ['ls-remote', 'origin', 'refs/heads/collab-driver/cards']).split(/\s+/)[0], b.sha);
    const age = heartbeatAge(f.work, 'cards');
    assert.equal(typeof age, 'number');
    assert.ok(age < ALIVE_MS);
    // main moves: the next heartbeat carries main's new tree, still on top of the previous tip
    write(f.work, 'more.txt', 'y\n');
    sh(f.work, ['add', '.']); sh(f.work, ['commit', '-q', '-m', 'more']); sh(f.work, ['push', '-q', 'origin', 'main']);
    const c = heartbeat(f.work, 'cards', ME);
    assert.equal(sh(f.work, ['rev-parse', `${c.sha}^`]), b.sha);
    assert.equal(sh(f.work, ['rev-parse', `${c.sha}^{tree}`]), sh(f.work, ['rev-parse', 'origin/main^{tree}']));
  } finally { f.done(); }
});
test('heartbeat: a foreign tip younger than 45 min is refused (exit code 3); an older one is taken over', () => {
  const f = fixture();
  try {
    const fresh = foreignTip(f, 'cards', OTHER, 5 * 60 * 1000);
    const r = heartbeat(f.work, 'cards', ME);
    assert.equal(r.ok, false);
    assert.equal(r.code, 3);
    assert.equal(r.holder, OTHER);
    assert.equal(driverTip(f.work, 'cards').sha, fresh, 'the live driver\'s ref is untouched');
    const stale = foreignTip(f, 'plates', OTHER, 50 * 60 * 1000);
    const t = heartbeat(f.work, 'plates', ME);
    assert.equal(t.ok, true);
    assert.equal(t.took_over, OTHER);
    assert.equal(sh(f.work, ['rev-parse', `${t.sha}^`]), stale, 'take-over is a fast-forward of the stale tip');
    assert.equal(driverTip(f.work, 'plates').session, ME);
  } finally { f.done(); }
});
test('heartbeat-age: none without a ref; heartbeat refuses a bad slug or session', () => {
  const f = fixture();
  try {
    assert.equal(heartbeatAge(f.work, 'nothing-here'), 'none');
    assert.throws(() => heartbeat(f.work, 'Bad Slug', ME), /--slug/);
    assert.throws(() => heartbeat(f.work, 'cards', 'nobody'), /--session/);
  } finally { f.done(); }
});

// ── next (§5 H, §7) ──
const lane = (id, o = {}) => ({ lane: id, state: 'ready', vtid: `VTID-0${String(id).length}000`, depends_on: [], paths: [`src/${id}/**`], claimed_by: '', pr: '', text: '', ...o });
const kinds = (r) => r.actions.map((a) => `${a.action}${a.lane ? `:${a.lane}` : ''}`);

test('next: answering an open round comes before review, review before build', () => {
  const r = planNext({
    slug: 'cards', plan: { state: 'approved' },
    sparring: ['.kiro/specs/cards/sparring/round-1.md', '.kiro/specs/cards/sparring/responses-1.md', '.kiro/specs/cards/sparring/round-2.md'],
    lanes: [lane('a', { state: 'in-review', pr: '12' }), lane('b')],
    checks: () => 'green',
  });
  assert.deepEqual(kinds(r), ['answer_round', 'review:a', 'build:b']);
  assert.equal(r.actions[0].round, 2);
  assert.equal(r.actions[1].reviewer, 'agent:vitana-lane-reviewer');
});
test('next: open rounds per session prefix; a verdict closes sparring', () => {
  assert.deepEqual(openRounds(['round-1.md', 'responses-1.md', 's2-round-1.md']), [{ prefix: 's2-', round: 1 }]);
  assert.deepEqual(openRounds(['round-1.md', 'round-2.md', 'verdict.md']), []);
  assert.deepEqual(openRounds([]), []);
});
test('next: a failed check fixes forward (attempt n+1); after 3 attempts the lane is parked', () => {
  const r = planNext({ slug: 'cards', lanes: [lane('a', { state: 'in-review', pr: '12', text: '## Log\n### 2026 · s · fix-forward 1\n' })], checks: () => 'failed' });
  assert.deepEqual(kinds(r), ['fix_forward:a']);
  assert.equal(r.actions[0].attempt, 2);
  const three = '### t · s · fix-forward 1\n### t · s · fix forward 2\n### t · s · fix-forward 3\n';
  const p = planNext({ slug: 'cards', lanes: [lane('a', { state: 'in-review', pr: '12', text: three })], checks: () => 'failed' });
  assert.deepEqual(kinds(p), ['park:a']);
});
test('next: a lane whose dependency is not done is not built', () => {
  const r = planNext({ slug: 'cards', lanes: [lane('a', { state: 'executing' }), lane('b', { depends_on: ['a'] })] });
  assert.deepEqual(kinds(r), ['wait']);
  const done = planNext({ slug: 'cards', lanes: [lane('a', { state: 'done' }), lane('b', { depends_on: ['a'] })] });
  assert.deepEqual(kinds(done), ['build:b']);
  const noVtid = planNext({ slug: 'cards', lanes: [lane('a', { vtid: '' })] });
  assert.deepEqual(kinds(noVtid), ['wait'], 'a lane without a VTID is never built');
});
test('next: 8 unblocked ready lanes → 6 builds; 6 active → 0; claimed ready lanes count as active', () => {
  const eight = 'abcdefgh'.split('').map((id) => lane(id));
  const r = planNext({ slug: 'cards', lanes: eight });
  assert.deepEqual(kinds(r), ['build:a', 'build:b', 'build:c', 'build:d', 'build:e', 'build:f']);
  const six = 'abcdef'.split('').map((id, i) => lane(id, { state: i % 2 ? 'executing' : 'in-review' }));
  const busy = planNext({ slug: 'cards', lanes: [...six, lane('g'), lane('h')], checks: () => 'pending' });
  assert.equal(busy.actions.filter((a) => a.action === 'build').length, 0);
  const claimed = planNext({ slug: 'cards', lanes: [...'abcde'.split('').map((id) => lane(id, { state: 'executing' })), lane('f', { claimed_by: OTHER }), lane('g')] });
  assert.equal(claimed.actions.filter((a) => a.action === 'build').length, 0);
  assert.equal(planNext({ slug: 'cards', lanes: eight, cap: 2 }).actions.length, 2);
  assert.equal(planNext({ slug: 'cards', lanes: eight, cap: 99 }).actions.length, 6, 'cap is at most 6');
});
test('next: two lanes on the same hot file → only the lower lane id starts; an active holder blocks too', () => {
  const r = planNext({ slug: 'cards', lanes: [lane('b-mig', { paths: ['supabase/migrations/**'] }), lane('a-mig', { paths: ['supabase/migrations/2026_x.sql', 'src/a/**'] }), lane('c')] });
  assert.deepEqual(kinds(r), ['build:a-mig', 'build:c']);
  const held = planNext({ slug: 'cards', lanes: [lane('z', { state: 'executing', paths: ['CLAUDE.md'] }), lane('a', { paths: ['CLAUDE.md', 'x/**'] })] });
  assert.deepEqual(kinds(held), ['wait']);
  assert.ok(hotConflict(hotKeys(['src/i18n/de/home.json']), hotKeys(['src/i18n/en/home.json'])));
  assert.equal(hotConflict(hotKeys(['src/i18n/de/home.json']), hotKeys(['src/i18n/de/feed.json'])), null);
  assert.ok(hotConflict(hotKeys(['src/i18n/**']), hotKeys(['src/i18n/de/feed.json'])));
  assert.ok(hotKeys(['src/navigation/registry/screens.json']).has('**/screens.json'));
  assert.equal(hotKeys(['services/gateway/src/x.ts']).size, 0);
});
test('next: a small task (1 lane, ≤ 3 files) runs without fan-out', () => {
  const small = planNext({ slug: 'cards', lanes: [lane('a', { paths: ['a.ts', 'a.test.ts', 'docs/a.md'] })] });
  assert.equal(small.actions[0].fan_out, false);
  const wide = planNext({ slug: 'cards', lanes: [lane('a', { paths: ['a.ts', 'b.ts', 'c.ts', 'd.ts'] })] });
  assert.equal(wide.actions[0].fan_out, true);
  const two = planNext({ slug: 'cards', lanes: [lane('a', { paths: ['a.ts'] }), lane('b', { paths: ['b.ts'] })] });
  assert.ok(two.actions.every((a) => a.fan_out === true));
});
test('next: done once Gate 2 is logged or the plan is parked', () => {
  assert.equal(planNext({ slug: 'cards', plan: { state: 'executing', text: '## Log\n### 2026-10-21T10:00Z · pm-agent · Gate 2 sent\n' }, lanes: [lane('a')] }).status, 'done');
  assert.equal(planNext({ slug: 'cards', plan: { state: 'parked' }, lanes: [lane('a')] }).status, 'done');
  assert.equal(planNext({ slug: 'cards', plan: { state: 'executing' }, lanes: [lane('a', { state: 'done' })] }).status, 'wait');
});
test('next: reads the plan, lanes and sparring files from git (collect/buildQueue)', () => {
  const f = fixture();
  try {
    const fm = (o) => `---\n${Object.entries(o).map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.join(', ')}]` : v}`).join('\n')}\n---\n## Log\n`;
    write(f.work, '.kiro/specs/cards/handoff.md', fm({ slug: 'cards', author: 'kiro', executor: 'kiro', next_actor: 'kiro', state: 'approved', updated: '2026-10-20T10:00Z', vtids: ['VTID-00001'] }));
    write(f.work, '.kiro/specs/cards/lanes/a.md', fm({ lane: 'a', state: 'done', next_actor: 'kiro', vtid: 'VTID-00001', updated: '2026-10-20T10:00Z', paths: ['src/a/**'] }));
    write(f.work, '.kiro/specs/cards/lanes/b.md', fm({ lane: 'b', state: 'ready', next_actor: 'kiro', vtid: 'VTID-00002', updated: '2026-10-20T10:00Z', depends_on: ['a'], paths: ['src/b/**'] }));
    write(f.work, '.kiro/specs/cards/lanes/c.md', fm({ lane: 'c', state: 'ready', next_actor: 'kiro', vtid: 'VTID-00003', updated: '2026-10-20T10:00Z', depends_on: ['b'], paths: ['src/c/**'] }));
    write(f.work, '.kiro/specs/cards/sparring/round-1.md', '# r1\n');
    write(f.work, '.kiro/specs/cards/sparring/verdict.md', '# converged\n');
    sh(f.work, ['add', '.']); sh(f.work, ['commit', '-q', '-m', 'spec']); sh(f.work, ['push', '-q', 'origin', 'main']);
    const r = next([f.work], 'cards', { checks: () => 'unknown' });
    assert.deepEqual(kinds(r), ['build:b']);
  } finally { f.done(); }
});
