// VTID-05780 (plan autonomous-to-staging-r2, lane protect-gate-workflow) — gate-audit.mjs on a fixture git history.
//
//   node --test scripts/collab/gate-audit.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { audit, auditMerge, protectedMerges, BOOTSTRAP } from './gate-audit.mjs';

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const S = 'claude-sonnet-5.5';
const O = 'claude-opus-5.5';
const BUILDER = 'kiro-exafy-202611110920-aaaa';
const LANE = '.kiro/specs/s/lanes/l.md';

/** A repo (origin = local bare repo) whose main gets one squash merge per `pr()`; `lookup` maps merge sha → PR. */
function history(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-audit-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const remote = path.join(tmp, 'o.git');
  const work = path.join(tmp, 'w');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  const g = (...a) => execFileSync('git', ['-C', work, '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (f, s) => { fs.mkdirSync(path.dirname(path.join(work, f)), { recursive: true }); fs.writeFileSync(path.join(work, f), s); };
  const commit = (msg) => { g('add', '-A'); g('commit', '-q', '--allow-empty', '-m', msg); return g('rev-parse', 'HEAD'); };
  write('scripts/collab/queue.mjs', 'export const V = 0;\n');
  write('README.md', 'r\n');
  write(LANE, '---\nlane: l\n---\n## Log\n');
  commit('base');
  g('remote', 'add', 'origin', remote);
  g('push', '-q', 'origin', 'main');
  g('fetch', '-q', 'origin');
  const lookup = new Map();
  let n = 0;
  let v = 0;
  const trailers = (o) => Object.entries(o).map(([k, x]) => `${k}: ${x}`).join('\n');
  /** One PR: `steps` = ['code' | ['review', model, session, 'reviewed'|'previous']]; squash-merged onto main. */
  const pr = (steps, { file = 'scripts/collab/queue.mjs', title } = {}) => {
    const num = ++n;
    g('checkout', '-q', '-b', `pr${num}`, 'origin/main');
    const codes = [];
    for (const s of steps) {
      if (s === 'code') {
        write(file, `export const V = ${++v};\n`);
        codes.push(commit(`code\n\n${trailers({ 'Collab-Session': BUILDER, 'Collab-Lane': 's/l' })}`));
      } else {
        const [, model, session, which] = s;
        const reviewed = which === 'previous' ? codes[codes.length - 2] : codes[codes.length - 1];
        fs.appendFileSync(path.join(work, LANE), `### t · ${session} · review\nreview: accept\nhead: ${reviewed}\n`);
        commit(`review\n\n${trailers({ 'Collab-Session': session, 'Collab-Review': 's/l', 'Collab-Verdict': 'accept', 'Collab-Reviewer': `agent:vitana-lane-reviewer (${model})`, 'Collab-Reviewed-Head': reviewed })}`);
      }
    }
    const head = g('rev-parse', 'HEAD');
    g('checkout', '-q', 'main');
    g('merge', '-q', '--ff-only', 'origin/main');
    const sq = g('commit-tree', `${head}^{tree}`, '-p', 'HEAD', '-m', `VTID-${num} (s/l): x (#${num})`);
    g('reset', '-q', '--hard', sq);
    g('push', '-q', 'origin', 'main');
    g('fetch', '-q', 'origin');
    lookup.set(sq, title === null ? null : { number: num, title: title || `VTID-${num} (s/l): x`, head: { sha: head } });
    return sq;
  };
  const direct = () => { g('checkout', '-q', 'main'); write('scripts/collab/queue.mjs', `export const V = ${++v};\n`); const c = commit('direct'); g('push', '-q', 'origin', 'main'); g('fetch', '-q', 'origin'); lookup.set(c, null); return c; };
  return { work, g, pr, direct, lookup };
}
const A1 = 'agent-vitana-lane-reviewer-202611120000-0001';
const A2 = 'agent-vitana-lane-reviewer-202611120000-0002';

test('gate-audit: a valid two-model, two-session merge passes; one accept, a stale accept, same model, a builder and a direct push are reported; a bootstrap sha passes', (t) => {
  const h = history(t);
  const valid = h.pr(['code', ['review', S, A1], ['review', O, A2]]);
  const one = h.pr(['code', ['review', S, A1]]);
  const stale = h.pr(['code', ['review', S, A1], 'code', ['review', O, A2]]);
  const staleBoth = h.pr(['code', ['review', S, A1], ['review', O, A2], 'code']);
  const sameModel = h.pr(['code', ['review', S, A1], ['review', S, A2]]);
  const sameSession = h.pr(['code', ['review', S, A1], ['review', O, A1]]);
  const builder = h.pr(['code', ['review', S, A1], ['review', O, BUILDER]]);
  const unprotected = h.pr(['code'], { file: 'README.md' });
  const direct = h.direct();
  const boot = h.pr(['code']);
  const res = audit({ repo: h.work, since: '10 years ago', ref: 'origin/main', lookupPr: (sha) => h.lookup.get(sha) ?? null, bootstrap: [{ sha: boot, reason: 'fixture bootstrap' }] });
  assert.deepEqual(res.checked.map((x) => x.sha), [valid]);
  assert.deepEqual(res.checked[0].models.sort(), [O, S]);
  assert.deepEqual(res.violations.map((x) => x.sha), [one, stale, staleBoth, sameModel, sameSession, builder, direct]);
  assert.match(res.violations.find((x) => x.sha === direct).reason, /direct push/);
  assert.deepEqual(res.bootstrapped.map((x) => x.sha), [boot]);
  assert.ok(!protectedMerges(h.work, { since: '10 years ago' }).some((m) => m.sha === unprotected), 'a merge that touches no protected file is not audited');
});

test('gate-audit: the merge tree must equal the PR head; a PR title without a lane key is reported', (t) => {
  const h = history(t);
  const ok = h.pr(['code', ['review', S, A1], ['review', O, A2]]);
  const pr = h.lookup.get(ok);
  const m = protectedMerges(h.work, { since: '10 years ago' }).find((x) => x.sha === ok);
  assert.equal(auditMerge(h.work, { ...m, pr }).ok, true);
  const other = h.pr(['code', ['review', S, A1], ['review', O, A2]]);
  assert.match(auditMerge(h.work, { ...m, pr: { ...pr, head: h.lookup.get(other).head } }).reason, /tree differs/);
  assert.match(auditMerge(h.work, { ...m, pr: { ...pr, title: 'chore: x' } }).reason, /no <slug>\/<lane>/);
});

test('gate-audit: the bootstrap list holds full SHAs with a reason, including the #5002 merge', () => {
  assert.ok(BOOTSTRAP.length > 0);
  for (const b of BOOTSTRAP) {
    assert.match(b.sha, /^[0-9a-f]{40}$/);
    assert.ok(typeof b.reason === 'string' && b.reason.length > 10, b.sha);
  }
  assert.ok(BOOTSTRAP.some((b) => b.sha.startsWith('e7077f27c3') && b.pr === 5002));
  assert.equal(new Set(BOOTSTRAP.map((b) => b.sha)).size, BOOTSTRAP.length);
});

test('gate-audit CLI: missing --repo/--gh exits 1', () => {
  const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'gate-audit.mjs');
  let code = 0;
  try { execFileSync(process.execPath, [SCRIPT], { stdio: 'ignore' }); } catch (e) { code = e.status; }
  assert.equal(code, 1);
});
