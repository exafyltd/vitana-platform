#!/usr/bin/env node
/**
 * land-guard — the pipeline's step order, enforced in code (plan land-guard).
 *
 *   node scripts/collab/land-guard.mjs evidence --repo <dir> --vtid <VTID>
 *   node scripts/collab/land-guard.mjs review   --gh <owner/repo> [--repo <checkout>] --pr <n> --reviewed-head <sha>
 *   node scripts/collab/land-guard.mjs checks   --gh <owner/repo> --sha <sha> [--wait <sec>]
 *   node scripts/collab/land-guard.mjs merge    --gh <owner/repo> [--repo <checkout>] --pr <n> --reviewed-head <sha> --title <t> [--wait <sec>]
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
 *
 * `--repo <checkout>` (plan review-survives-main-merge, collaboration.md §3): review/merge walk reviewed..head in that
 * local clone of <owner/repo> (its `origin` must name it), first-parent, so a clean merge of `main` keeps the review
 * when Git's automatic merge equals the merge commit, no governance or protected gate file comes in, and the PR's own
 * diff is byte-identical. Without `--repo` the GitHub-API walk is unchanged (a merge commit needs a new review).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { globToRegex, PROTECTED_GATE_PATHS, GOVERNANCE_PATHS } from './queue.mjs';

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
/** Does merge commit keep a review (collaboration.md §3, clean merge of main)? `autoMergeTree` = the tree of
 * `git merge-tree --write-tree p1 p2`, or null when it reported conflicts; `protectedFiles` = files changed p1..merge
 * that are governance paths or protected gate files. */
export function mergeKeepsReview({ parents = [], secondParentOnMain, autoMergeTree, commitTree, protectedFiles = [] }) {
  if (parents.length !== 2) return { ok: false, reason: `a ${parents.length} parent${parents.length === 1 ? '' : 's'} commit is not a two-parent merge of main` };
  if (!secondParentOnMain) return { ok: false, reason: 'it merges a branch that is not on origin/main' };
  if (!autoMergeTree) return { ok: false, reason: 'the merge has conflicts (git merge-tree), so it was resolved by hand' };
  if (autoMergeTree !== commitTree) return { ok: false, reason: 'its tree differs from Git\'s automatic merge (conflict resolution or extra edits)' };
  if (protectedFiles.length) return { ok: false, reason: `it brings in governance or protected gate file(s) (${protectedFiles.join(', ')})` };
  return { ok: true, reason: 'clean merge of main' };
}
/** `prDiffSame` (local walk only): the PR's own diff at head is byte-identical to the one at the reviewed head. A commit
 * in `after` with `merge` facts counts only when mergeKeepsReview is ok and prDiffSame === true. */
export function reviewCurrent(reviewed, head, after, laneKey, prDiffSame) {
  if (reviewed === head) return { ok: true, reason: 'reviewed head is the PR head' };
  if (!after.length) return { ok: false, reason: `reviewed head ${reviewed.slice(0, 8)} is not an ancestor of head ${head.slice(0, 8)}` };
  let merges = 0;
  for (const c of after) {
    if (c.merge) {
      const m = mergeKeepsReview(c.merge);
      if (!m.ok) return { ok: false, reason: `merge ${c.sha.slice(0, 8)} after the reviewed head: ${m.reason}: a new review is needed` };
      if (prDiffSame !== true) return { ok: false, reason: `merge ${c.sha.slice(0, 8)} after the reviewed head: the PR's own diff changed: a new review is needed` };
      merges++;
      continue;
    }
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
  return { ok: true, reason: merges ? 'only lane-file entries and clean merges of main after the reviewed head' : 'only lane-file entries after the reviewed head' };
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
// ── local walk (--repo) ──────────────────────────────────────────────────────
const isAncestor = (repo, a, b) => { try { run('git', ['-C', repo, 'merge-base', '--is-ancestor', a, b]); return true; } catch { return false; } };
/** Tree of Git's automatic merge of p1 and p2, or null when it has conflicts (merge-tree exit 1). */
function autoMergeTree(repo, p1, p2) {
  try { return run('git', ['-C', repo, 'merge-tree', '--write-tree', p1, p2]).split('\n')[0]; } catch (e) { if (e.status === 1) return null; throw e; }
}
/** Bytes of the PR's own diff at `tip` (from its merge-base with origin/main), over `paths`. */
const prDiff = (repo, tip, paths) => {
  const base = run('git', ['-C', repo, 'merge-base', 'origin/main', tip]);
  return execFileSync('git', ['-C', repo, 'diff', '--no-color', '--no-ext-diff', '--no-renames', '--full-index', '--binary', base, tip, '--', ...paths], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
};
const prPaths = (repo, tip) => run('git', ['-C', repo, 'diff', '--name-only', '--no-renames', run('git', ['-C', repo, 'merge-base', 'origin/main', tip]), tip]).split('\n').filter(Boolean);
/** reviewed..head in a local checkout (objects and origin/main already fetched): first-parent, so main's own commits
 * that a merge brings in are not listed. → { after: [{sha, session, files, merge?}], prDiffSame }. */
export function localAfter(repo, reviewed, head, laneKey) {
  if (reviewed === head) return { after: [], prDiffSame: true };
  if (!isAncestor(repo, reviewed, head)) return { after: [], prDiffSame: false };
  const gates = [...PROTECTED_GATE_PATHS, ...GOVERNANCE_PATHS];
  const after = run('git', ['-C', repo, 'rev-list', '--reverse', '--first-parent', '--parents', `${reviewed}..${head}`]).split('\n').filter(Boolean).map((line) => {
    const [sha, ...parents] = line.split(' ');
    const files = run('git', ['-C', repo, 'diff-tree', '--no-commit-id', '--name-only', '--no-renames', '-r', parents[0], sha]).split('\n').filter(Boolean);
    const session = (/^Collab-Session:\s*(\S+)/m.exec(run('git', ['-C', repo, 'log', '-1', '--format=%B', sha])) || [])[1];
    const c = { sha, session, files };
    if (parents.length > 1) {
      const two = parents.length === 2;
      c.merge = {
        parents,
        secondParentOnMain: two && isAncestor(repo, parents[1], 'origin/main'),
        autoMergeTree: two ? autoMergeTree(repo, parents[0], parents[1]) : null,
        commitTree: run('git', ['-C', repo, 'rev-parse', `${sha}^{tree}`]),
        protectedFiles: protectedTouched(files, gates),
      };
    }
    return c;
  });
  const [slug, lane] = (laneKey || '').split('/');
  const own = slug && lane ? new Set([`.kiro/specs/${slug}/lanes/${lane}.md`, `.kiro/specs/${slug}/handoff.md`]) : new Set();
  const paths = [...new Set([...prPaths(repo, reviewed), ...prPaths(repo, head)])].filter((p) => !own.has(p));
  const prDiffSame = paths.length === 0 || prDiff(repo, reviewed, paths).equals(prDiff(repo, head, paths));
  return { after, prDiffSame };
}
/** `--repo`: the checkout's origin must name <owner/repo>; fetch main and the PR head so the walk is local. */
function prepareLocal(repo, gh, pr, head) {
  const url = run('git', ['-C', repo, 'remote', 'get-url', 'origin']).replace(/\\/g, '/');
  const esc = gh.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`(^|[/:])${esc}(\\.git)?/?$`, 'i').test(url)) throw new Error(`--repo ${repo}: origin ${url} does not name ${gh}`);
  run('git', ['-C', repo, 'fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main', `refs/pull/${pr}/head`]);
  run('git', ['-C', repo, 'cat-file', '-e', `${head}^{commit}`]);
}
/** The `after` walk for review/merge: local with --repo, the GitHub API (unchanged) without. */
function reviewWalk(o, reviewed, head, laneKey) {
  if (!o.repo || o.repo === true) return { after: afterCommits(o.gh, reviewed, head), prDiffSame: undefined };
  prepareLocal(o.repo, o.gh, o.pr, head);
  return localAfter(o.repo, reviewed, head, laneKey);
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
      const pr = prHead(o.gh, o.pr);
      const head = pr.head.sha;
      const key = o.lane || laneKeyOf(pr.title);
      const { after, prDiffSame } = reviewWalk(o, o['reviewed-head'], head, key);
      const r = reviewCurrent(o['reviewed-head'], head, after, key, prDiffSame);
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
      const key = o.lane || laneKeyOf(pr.title);
      const { after, prDiffSame } = reviewWalk(o, o['reviewed-head'], head, key);
      const review = reviewCurrent(o['reviewed-head'], head, after, key, prDiffSame);
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
