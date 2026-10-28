#!/usr/bin/env node
/**
 * land-guard — the pipeline's step order, enforced in code (plan land-guard).
 *
 *   node scripts/collab/land-guard.mjs evidence --repo <dir> --vtid <VTID>
 *   node scripts/collab/land-guard.mjs review   --gh <owner/repo> --pr <n> --reviewed-head <sha>
 *   node scripts/collab/land-guard.mjs checks   --gh <owner/repo> --sha <sha> [--wait <sec>]
 *   node scripts/collab/land-guard.mjs merge    --gh <owner/repo> --pr <n> --reviewed-head <sha> --title <t> [--wait <sec>]
 *   node scripts/collab/land-guard.mjs release  --repo <dir> --slug <s> --lane <lane|_plan> --session <id>
 *   node scripts/collab/land-guard.mjs release-heartbeat --repo <dir> --slug <s>
 *
 * Exit 0 = the step may run (and, for merge / release, ran). Exit 1 = it may not (reason printed). Exit 2 = checks are
 * still pending (or there are none yet). A refusal never calls merge or release.
 *
 * The rules (common-rules.md rule 13): evidence exists before its commit; a review counts only for the current head
 * (or a head whose later commits only append to the lane file); every check's latest attempt is finished and green
 * before a merge, and the PR is up to date; claims and the driver heartbeat are released only after the closing
 * records are on main (lane `done` / `parked`; for `_plan` and the heartbeat, the plan and every lane).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { globToRegex, PROTECTED_GATE_PATHS } from './queue.mjs';

export const EVIDENCE_FILES = ['acceptance.md', 'commands.log', 'scope.json'];
export const OK_CONCLUSIONS = new Set(['success', 'skipped', 'neutral']);
export const RELEASABLE = new Set(['done', 'parked']);
const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── pure decisions ───────────────────────────────────────────────────────────
/** Missing evidence files for a VTID, given the repo's tracked ∪ staged paths. */
export function evidenceMissing(paths, vtid) {
  const have = new Set(paths);
  return EVIDENCE_FILES.map((f) => `docs/validation/${vtid}/${f}`).filter((p) => !have.has(p));
}

/** Does a review of `reviewed` still count at `head`? `after` = [{sha, session, files:[…]}] for reviewed..head;
 * `laneKey` = `<slug>/<lane>` restricts entry-only commits to that lane's file (and its handoff for pm-agent). */
export const laneKeyOf = (title) => (/\(([a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*)\)/.exec(title || '') || [])[1];
export function reviewCurrent(reviewed, head, after, laneKey) {
  if (reviewed === head) return { ok: true, reason: 'reviewed head is the PR head' };
  if (!after.length) return { ok: false, reason: `reviewed head ${reviewed.slice(0, 8)} is not an ancestor of head ${head.slice(0, 8)}` };
  for (const c of after) {
    // collaboration.md §3: entry-only commits on the lane file, or the Project Manager's lane-state commits.
    const [slug, lane] = (laneKey || '').split('/');
    const laneFile = slug && lane ? `.kiro/specs/${slug}/lanes/${lane}.md` : null;
    const ok = (f) => {
      if (c.session === 'pm-agent') return laneFile ? f === laneFile || f === `.kiro/specs/${slug}/handoff.md` : /^\.kiro\/specs\/[^/]+\/(lanes\/[^/]+|handoff)\.md$/.test(f);
      return laneFile ? f === laneFile : /^\.kiro\/specs\/[^/]+\/lanes\/[^/]+\.md$/.test(f);
    };
    const bad = c.files.filter((f) => !ok(f));
    if (bad.length || c.files.length === 0) return { ok: false, reason: `${c.sha.slice(0, 8)} after the reviewed head changes ${bad.join(', ') || 'nothing'}: a new review is needed` };
  }
  return { ok: true, reason: 'only lane-file entries after the reviewed head' };
}

/** Latest attempt per check name → {state: 'pass'|'fail'|'pending', detail}. */
export function checksVerdict(runs) {
  if (!runs.length) return { state: 'pending', detail: 'no check runs yet' };
  const latest = new Map();
  for (const r of runs) {
    const prev = latest.get(r.name);
    const key = (x) => `${x.started_at || '9999'}|${String(x.id || 0).padStart(20, '0')}`;
    if (!prev || key(r) >= key(prev)) latest.set(r.name, r);
  }
  const rows = [...latest.values()];
  const failed = rows.filter((r) => r.status === 'completed' && !OK_CONCLUSIONS.has(r.conclusion));
  if (failed.length) return { state: 'fail', detail: failed.map((r) => `${r.name}=${r.conclusion}`).join(', ') };
  // Any attempt of a name that is not completed (a queued re-run may have no started_at yet) keeps it pending.
  const pending = runs.filter((r) => r.status !== 'completed');
  if (pending.length) return { state: 'pending', detail: pending.map((r) => `${r.name}=${r.status}`).join(', ') };
  return { state: 'pass', detail: `${rows.length} checks green` };
}

/** Changed files that are protected gate files (queue.mjs glob semantics). */
export function protectedTouched(files, globs) {
  return files.filter((f) => globs.some((g) => globToRegex(g).test(f)));
}

/** Merge decision from the gates. */
export function mergeDecision({ review, checks, behindBy, protectedFiles = [] }) {
  if (protectedFiles.length) return { ok: false, code: 1, reason: `protected gate file(s) changed (${protectedFiles.join(', ')}): §7b needs a Claude review or an owner instruction; not merged by the guard` };
  if (!review.ok) return { ok: false, code: 1, reason: `review: ${review.reason}` };
  if (checks.state === 'fail') return { ok: false, code: 1, reason: `checks: ${checks.detail}` };
  if (checks.state === 'pending') return { ok: false, code: 2, reason: `checks: ${checks.detail}` };
  if (behindBy > 0) return { ok: false, code: 1, reason: `PR is ${behindBy} commit(s) behind its base: update it, then re-check` };
  return { ok: true, code: 0, reason: 'review current, checks green, up to date' };
}

/** May this claim be released? `lane` = lane id or `_plan`; states read from origin/main. */
export function releaseDecision(lane, { laneState, planState, laneStates }) {
  if (lane !== '_plan') {
    return RELEASABLE.has(laneState) ? { ok: true } : { ok: false, reason: `lanes/${lane}.md has state "${laneState}" on origin/main: merge its closing record (state: done) first` };
  }
  if (!RELEASABLE.has(planState)) return { ok: false, reason: `handoff.md has state "${planState}" on origin/main: merge the plan's closing record (state: done) first` };
  const open = Object.entries(laneStates).filter(([, s]) => !RELEASABLE.has(s)).map(([l, s]) => `${l}=${s}`);
  return open.length ? { ok: false, reason: `lanes not done: ${open.join(', ')}` } : { ok: true };
}

// ── IO ───────────────────────────────────────────────────────────────────────
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...opts }).trim();
const ghJson = (p) => JSON.parse(run('gh', ['api', p]) || 'null');
const stateOf = (text) => (/^state:\s*(\S+)/m.exec(text || '') || [])[1] || 'missing';

function showMain(repo, rel) {
  try { return run('git', ['-C', repo, 'show', `origin/main:${rel}`]); } catch { return null; }
}

export function specStates(repo, slug) {
  run('git', ['-C', repo, 'fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
  const dir = `.kiro/specs/${slug}`;
  let lanes = [];
  try { lanes = run('git', ['-C', repo, 'ls-tree', '--name-only', `origin/main:${dir}/lanes`]).split('\n').filter((f) => f.endsWith('.md')); } catch { /* none */ }
  const laneStates = Object.fromEntries(lanes.map((f) => [f.replace(/\.md$/, ''), stateOf(showMain(repo, `${dir}/lanes/${f}`))]));
  return { planState: stateOf(showMain(repo, `${dir}/handoff.md`)), laneStates };
}

function prHead(gh, pr) { return ghJson(`repos/${gh}/pulls/${pr}`); }
function afterCommits(gh, reviewed, head) {
  if (reviewed === head) return [];
  const cmp = ghJson(`repos/${gh}/compare/${reviewed}...${head}`);
  if (!cmp || cmp.behind_by > 0) return [];
  return (cmp.commits || []).map((c) => ({ sha: c.sha, session: (/^Collab-Session:\s*(\S+)/m.exec(c.commit?.message || '') || [])[1], files: (ghJson(`repos/${gh}/commits/${c.sha}`).files || []).map((f) => f.filename) }));
}
function checkRuns(gh, sha) {
  const out = [];
  for (let page = 1; page < 6; page++) {
    const r = ghJson(`repos/${gh}/commits/${sha}/check-runs?per_page=100&page=${page}`);
    out.push(...(r.check_runs || []));
    if ((r.check_runs || []).length < 100) break;
  }
  return out;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitChecks(gh, sha, waitSec) {
  const end = Date.now() + waitSec * 1000;
  for (;;) {
    const v = checksVerdict(checkRuns(gh, sha));
    if (v.state !== 'pending' || Date.now() >= end) return v;
    await sleep(60_000);
  }
}

function opts(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    else o._.push(argv[i]);
  }
  return o;
}
function need(o, ...keys) {
  const miss = keys.filter((k) => !o[k] || o[k] === true);
  if (miss.length) throw new Error(`missing ${miss.map((k) => `--${k}`).join(' ')}`);
}

export async function main(argv) {
  const o = opts(argv);
  const cmd = o._[0];
  const say = (code, msg) => { console.log(`land-guard ${cmd}: ${code === 0 ? 'ok' : code === 2 ? 'pending' : 'refused'} — ${msg}`); return code; };
  try {
    if (cmd === 'evidence') {
      need(o, 'repo', 'vtid');
      // Only the evidence directory: a whole-tree ls-files overflows the child-process buffer on a large repo.
      const dir = `docs/validation/${o.vtid}`;
      const deleted = new Set(run('git', ['-C', o.repo, 'diff', '--cached', '--name-only', '--diff-filter=D', '--', dir]).split('\n'));
      const tracked = run('git', ['-C', o.repo, 'ls-files', '--', dir]).split('\n').filter((f) => !deleted.has(f));
      const staged = run('git', ['-C', o.repo, 'diff', '--cached', '--name-only', '--diff-filter=d', '--', dir]).split('\n');
      const miss = evidenceMissing([...tracked, ...staged], o.vtid);
      return miss.length ? say(1, `evidence missing (write and stage it before the commit): ${miss.join(', ')}`) : say(0, `${o.vtid} evidence present`);
    }
    if (cmd === 'review') {
      need(o, 'gh', 'pr', 'reviewed-head');
      const head = prHead(o.gh, o.pr).head.sha;
      const r = reviewCurrent(o['reviewed-head'], head, afterCommits(o.gh, o['reviewed-head'], head), o.lane || laneKeyOf(prHead(o.gh, o.pr).title));
      return say(r.ok ? 0 : 1, r.reason);
    }
    if (cmd === 'checks') {
      need(o, 'gh', 'sha');
      const v = await waitChecks(o.gh, o.sha, Number(o.wait || 0));
      return say(v.state === 'pass' ? 0 : v.state === 'fail' ? 1 : 2, v.detail);
    }
    if (cmd === 'merge') {
      need(o, 'gh', 'pr', 'reviewed-head', 'title');
      const pr = prHead(o.gh, o.pr);
      if (pr.merged) return say(0, `already merged (${pr.merge_commit_sha})`);
      const head = pr.head.sha;
      const review = reviewCurrent(o['reviewed-head'], head, afterCommits(o.gh, o['reviewed-head'], head), o.lane || laneKeyOf(pr.title));
      const checks = review.ok ? await waitChecks(o.gh, head, Number(o.wait || 0)) : { state: 'pending', detail: 'not read' };
      const cmp = ghJson(`repos/${o.gh}/compare/${pr.base.ref}...${head}`);
      const files = [];
      for (let page = 1; page < 31; page++) {
        const f = ghJson(`repos/${o.gh}/pulls/${o.pr}/files?per_page=100&page=${page}`) || [];
        files.push(...f.map((x) => x.filename));
        if (f.length < 100) break;
      }
      const d = mergeDecision({ review, checks, behindBy: cmp.behind_by, protectedFiles: protectedTouched(files, PROTECTED_GATE_PATHS) });
      if (!d.ok) return say(d.code, d.reason);
      const res = JSON.parse(run('gh', ['api', '-X', 'PUT', `repos/${o.gh}/pulls/${o.pr}/merge`, '-f', 'merge_method=squash', '-f', `sha=${head}`, '-f', `commit_title=${o.title}`]));
      return say(0, `merged ${res.sha} (${d.reason})`);
    }
    if (cmd === 'release') {
      need(o, 'repo', 'slug', 'lane', 'session');
      const st = specStates(o.repo, o.slug);
      const d = releaseDecision(o.lane, { laneState: st.laneStates[o.lane], ...st });
      if (!d.ok) return say(1, d.reason);
      execFileSync(process.execPath, [path.join(HERE, 'queue.mjs'), 'release', `${o.slug}/${o.lane}`, '--session', o.session, '--repo', o.repo], { stdio: 'inherit' });
      return say(0, `${o.slug}/${o.lane} released`);
    }
    if (cmd === 'release-heartbeat') {
      need(o, 'repo', 'slug');
      const d = releaseDecision('_plan', specStates(o.repo, o.slug));
      if (!d.ok) return say(1, d.reason);
      try { run('git', ['-C', o.repo, 'push', '-q', 'origin', '--delete', `refs/heads/collab-driver/${o.slug}`]); } catch (e) { return say(1, `heartbeat delete failed: ${String(e.stderr || e.message).trim()}`); }
      return say(0, `collab-driver/${o.slug} removed`);
    }
    console.error('usage: land-guard.mjs evidence|review|checks|merge|release|release-heartbeat …');
    return 1;
  } catch (e) {
    return say(1, String(e.stderr || e.message).trim().split('\n')[0]);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; });
}
