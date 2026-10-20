#!/usr/bin/env node
// VTID-05272 — continuous plan driver (plan kiro-autonomy-fallback §4.7, §5 H, §7).
//
// One driver per approved plan carries it from the plan( PR to Gate 2, around the clock. This script is the
// deterministic part (no LLM): it keeps the driver's heartbeat and says what to do next. The loop that runs the
// actions (answer a round, build a lane in its own worktree, call the reviewer agent, fix forward) is documented in
// `.kiro/pipeline/driver.md` (lane exceptions-seat); collaboration.md §8 names it (lane steering-rules).
//
//   node scripts/collab/plan-driver.mjs heartbeat     --slug <s> --session <id> [--repo .]
//   node scripts/collab/plan-driver.mjs heartbeat-age --slug <s> [--repo .]
//   node scripts/collab/plan-driver.mjs next          --slug <s> --repo <platform> [--repo <v1>] [--cap 6] [--json]
//
// heartbeat     — commit on refs/heads/collab-driver/<slug>: tree = origin/main^{tree}, parent = the previous tip
//                 (fast-forward only, never forced), trailers Collab-Session / Collab-Driver. Exit 3 when another
//                 session's tip is younger than 45 min (a live driver) or the push lost a race. Older → taken over.
// heartbeat-age — ms since the tip's committer date, or `none`.
// next          — ordered actions for the plan: answer an open sparring round, fix forward a lane whose PR has a
//                 failed check (max 3, then park), review `in-review` lanes, build `ready` lanes whose depends_on are
//                 all `done` (at most `cap` lanes executing|in-review per plan, hot files sequenced), else wait/done.
//
// Reads only: `collect` (claims via its `listClaims`), `buildQueue`, `parseFrontMatter` from queue.mjs (not edited) and `gh pr view`
// for check state. The only write is the heartbeat ref. Run `git fetch --prune origin` first (next does it).
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Claims reach the rows through collect() (it calls listClaims), so a claimed `ready` lane counts as active.
import { collect, buildQueue, parseFrontMatter, globToRegex, isSessionId, PLAN_LANE } from './queue.mjs';

export const DRIVER_PREFIX = 'collab-driver/';
export const ALIVE_MS = 45 * 60 * 1000;
export const HEARTBEAT_INTERVAL_MS = 15 * 60 * 1000;
export const DEFAULT_CAP = 6;
export const MAX_CAP = 6;
export const MAX_FIX_FORWARD = 3;
// Plan §7 rule 4: files two lanes never change in parallel.
export const HOT_PATTERNS = ['supabase/migrations/**', 'DATABASE_SCHEMA.md', 'src/App.tsx', '**/screens.json', '**/exclusions.json',
  'apps/mobile/parity/ledger.json', 'CLAUDE.md'];
const I18N_RE = /^src\/i18n\/[^/]+\/(.+\.json)$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

class Usage extends Error {}

function git(repo, args, opts = {}) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trimEnd();
}
function gitOk(repo, args, opts) {
  try { return git(repo, args, opts); } catch { return null; }
}
function checkSlug(slug) {
  if (!SLUG_RE.test(slug || '')) throw new Usage('--slug <slug> is required (lowercase letters, digits, dashes)');
}

// ── Heartbeat (§4.7) ─────────────────────────────────────────────────────────────────────────────────────────────
/** The remote tip of the driver ref: { sha, session, at } or null. Fetches it so its commit is readable. */
export function driverTip(repo, slug) {
  checkSlug(slug);
  const ref = `refs/heads/${DRIVER_PREFIX}${slug}`;
  const line = gitOk(repo, ['ls-remote', 'origin', ref]);
  const sha = line ? line.split(/\s+/)[0] : '';
  if (!/^[0-9a-f]{40}$/.test(sha)) return null;
  if (gitOk(repo, ['cat-file', '-t', sha]) !== 'commit') git(repo, ['fetch', '-q', 'origin', ref]);
  const out = git(repo, ['log', '-1', '--format=%ct%n%B', sha]);
  const [ts, ...body] = out.split('\n');
  const session = (/^Collab-Session:\s*(\S+)/m.exec(body.join('\n')) || [])[1] || null;
  return { sha, session, at: Number(ts) * 1000 };
}

export function heartbeatAge(repo, slug, { now = Date.now() } = {}) {
  const tip = driverTip(repo, slug);
  return tip ? Math.max(0, now - tip.at) : 'none';
}

export function heartbeat(repo, slug, session, { now = Date.now() } = {}) {
  checkSlug(slug);
  if (!isSessionId(session)) throw new Usage('--session <id> is required (session_… or kiro-…-YYYYMMDDHHMM-xxxx)');
  git(repo, ['fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
  const tip = driverTip(repo, slug);
  if (tip && tip.session !== session && now - tip.at < ALIVE_MS) {
    return { ok: false, code: 3, holder: tip.session, age_ms: now - tip.at, note: 'another driver is alive' };
  }
  const tree = git(repo, ['rev-parse', 'origin/main^{tree}']);
  const parent = tip ? tip.sha : git(repo, ['rev-parse', 'origin/main']);
  // A marker commit authored by the session itself, like a claim (queue.mjs claim) — works on machines with no identity.
  const ident = { GIT_AUTHOR_NAME: session, GIT_AUTHOR_EMAIL: `${session}@collab.invalid`, GIT_COMMITTER_NAME: session, GIT_COMMITTER_EMAIL: `${session}@collab.invalid` };
  const sha = git(repo, ['commit-tree', tree, '-p', parent, '-m', `collab-driver ${slug}`, '-m', `Collab-Session: ${session}\nCollab-Driver: ${slug}`],
    { env: { ...process.env, ...ident } });
  try {
    git(repo, ['push', '-q', 'origin', `${sha}:refs/heads/${DRIVER_PREFIX}${slug}`]);
  } catch (err) {
    const t = driverTip(repo, slug);
    return { ok: false, code: 3, holder: t?.session || 'unknown', note: 'push rejected (another driver moved the ref)', detail: String(err.stderr || err.message).trim() };
  }
  return { ok: true, sha, took_over: tip && tip.session !== session ? tip.session : null };
}

// ── Next actions (§5 H, §7) ──────────────────────────────────────────────────────────────────────────────────────
/** Hot keys a lane's `paths` reach: a hot pattern it names, matches or is matched by; i18n shards by namespace. */
export function hotKeys(paths) {
  const keys = new Set();
  for (const raw of paths || []) {
    const p = String(raw).trim();
    if (!p) continue;
    for (const h of HOT_PATTERNS) {
      const probe = h.replace(/^\*\*\//, 'x/').replace(/\/\*\*$/, '/x/y.sql');
      if (p === h || globToRegex(h).test(p) || globToRegex(p).test(probe) || globToRegex(p).test(h.replace(/^\*\*\//, ''))) keys.add(h);
    }
    const ns = I18N_RE.exec(p);
    if (ns) keys.add(/[*?]/.test(ns[1]) ? 'i18n:*' : `i18n:${ns[1]}`);
    else if (globToRegex(p).test('src/i18n/de/x.json')) keys.add('i18n:*');
  }
  return keys;
}
export function hotConflict(a, b) {
  for (const k of a) {
    if (b.has(k)) return k;
    if (k.startsWith('i18n:') && (k === 'i18n:*' ? [...b].some((x) => x.startsWith('i18n:')) : b.has('i18n:*'))) return k;
  }
  return null;
}

/** Sparring rounds still waiting for the planner's answer: round-<n> with no responses-<n> (per s<k>- prefix). */
export function openRounds(sparringFiles) {
  const names = (sparringFiles || []).map((f) => path.posix.basename(String(f)));
  if (names.includes('verdict.md')) return [];
  const rounds = new Map();
  const answered = new Set();
  for (const n of names) {
    const r = /^((?:s\d+-)?)round-(\d+)\.md$/.exec(n);
    if (r) rounds.set(r[1], Math.max(rounds.get(r[1]) || 0, Number(r[2])));
    const a = /^((?:s\d+-)?)responses-(\d+)\.md$/.exec(n);
    if (a) answered.add(`${a[1]}${a[2]}`);
  }
  return [...rounds.entries()].filter(([pre, n]) => !answered.has(`${pre}${n}`)).map(([prefix, round]) => ({ prefix, round }))
    .sort((x, y) => x.prefix.localeCompare(y.prefix));
}

const fixForwardCount = (text) => [...String(text || '').matchAll(/^###\s+.*\bfix[- ]forward\b/gim)].length;
const gate2Logged = (text) => /^###\s+.*\bgate ?2\b/im.test(String(text || '')) || /\bGate 2 (?:sent|posted)\b/i.test(String(text || ''));

/**
 * Pure decision. `plan` = { state, text }; `lanes` = [{ lane, state, vtid, depends_on, paths, claimed_by, pr, text }];
 * `sparring` = file names under sparring/; `checks(lane)` → 'failed' | 'pending' | 'green' | 'unknown'.
 * Returns { status: 'act'|'wait'|'done', actions: [...] }.
 */
export function planNext({ slug, plan = {}, lanes = [], sparring = [], checks = () => 'unknown', cap = DEFAULT_CAP }) {
  const capN = Math.max(0, Math.min(MAX_CAP, Number.isFinite(Number(cap)) ? Number(cap) : DEFAULT_CAP));
  if (plan.state === 'parked') return { status: 'done', actions: [{ action: 'done', slug, reason: 'plan parked' }] };
  if (plan.state === 'done' || gate2Logged(plan.text)) return { status: 'done', actions: [{ action: 'done', slug, reason: 'Gate 2 sent' }] };
  const actions = [];
  for (const r of openRounds(sparring)) actions.push({ action: 'answer_round', slug, round: r.round, prefix: r.prefix });
  const sorted = [...lanes].sort((a, b) => a.lane.localeCompare(b.lane));
  const fixes = [];
  const reviews = [];
  for (const l of sorted) {
    if (l.state !== 'in-review' && l.state !== 'executing') continue;
    const c = l.pr || l.state === 'in-review' ? checks(l) : 'unknown';
    if (c === 'failed') {
      const n = fixForwardCount(l.text);
      fixes.push(n >= MAX_FIX_FORWARD ? { action: 'park', slug, lane: l.lane, reason: `${n} fix-forward attempts failed` }
        : { action: 'fix_forward', slug, lane: l.lane, attempt: n + 1, pr: l.pr || '' });
    } else if (l.state === 'in-review') reviews.push({ action: 'review', slug, lane: l.lane, pr: l.pr || '', reviewer: 'agent:vitana-lane-reviewer' });
  }
  actions.push(...fixes, ...reviews);
  const states = new Map(lanes.map((l) => [l.lane, l.state]));
  const isActive = (l) => l.state === 'executing' || l.state === 'in-review' || (l.state === 'ready' && l.claimed_by);
  const active = sorted.filter(isActive);
  let slots = Math.max(0, capN - active.length);
  const held = active.map((l) => hotKeys(l.paths));
  const small = lanes.length === 1 && (lanes[0].paths || []).length <= 3;
  for (const l of sorted) {
    if (slots <= 0) break;
    if (l.state !== 'ready' || l.claimed_by || !l.vtid) continue;
    if ((l.depends_on || []).some((d) => states.get(d) !== 'done')) continue;
    const keys = hotKeys(l.paths);
    if (held.some((h) => hotConflict(keys, h))) continue;
    actions.push({ action: 'build', slug, lane: l.lane, vtid: l.vtid, fan_out: !small });
    held.push(keys);
    slots--;
  }
  if (actions.length) return { status: 'act', actions };
  return { status: 'wait', actions: [{ action: 'wait', slug }] };
}

function repoSlugOf(repo) {
  const url = gitOk(repo, ['remote', 'get-url', 'origin']) || '';
  const m = /github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/.exec(url.trim());
  return m ? m[1] : null;
}
/** Check state of a lane's PR via gh (read-only). Unknown on any error. */
export function ghChecks(repoSlug) {
  return (lane) => {
    const ref = lane.pr ? String(lane.pr).replace(/^.*\/pull\//, '') : lane.branch;
    if (!ref || !repoSlug) return 'unknown';
    try {
      const out = execFileSync('gh', ['pr', 'view', ref, '--repo', repoSlug, '--json', 'statusCheckRollup'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      const rollup = JSON.parse(out).statusCheckRollup || [];
      const states = rollup.map((c) => String(c.conclusion || c.state || c.status || '').toUpperCase());
      if (states.some((s) => ['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ERROR', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(s))) return 'failed';
      if (states.some((s) => ['', 'PENDING', 'QUEUED', 'IN_PROGRESS', 'EXPECTED', 'WAITING'].includes(s))) return 'pending';
      return 'green';
    } catch { return 'unknown'; }
  };
}

/** Gather the plan from every repo (first repo wins on a lane id) and decide. */
export function next(repos, slug, { cap = DEFAULT_CAP, checks = null } = {}) {
  checkSlug(slug);
  let plan = null;
  const lanes = new Map();
  let sparring = [];
  for (const repo of repos) {
    gitOk(repo, ['fetch', '--prune', '-q', 'origin']);
    const collected = collect(repo);
    const rows = buildQueue(collected, path.basename(repo)).filter((r) => r.slug === slug);
    const textOf = new Map(collected.files.filter((f) => f.slug === slug).map((f) => [f.lane, f]));
    for (const r of rows) {
      const f = textOf.get(r.lane);
      if (r.lane === PLAN_LANE) { if (!plan) plan = { state: r.state, text: f?.text || '', ref: f?.ref || '' }; continue; }
      if (!f || lanes.has(r.lane)) continue;
      const fm = f.fm || parseFrontMatter(f.text) || {};
      lanes.set(r.lane, { lane: r.lane, state: r.state, vtid: r.vtid, depends_on: r.depends_on || [], paths: r.paths || [],
        claimed_by: r.claimed_by || '', pr: fm.pr || '', branch: fm.branch || '', text: f.text, repoSlug: repoSlugOf(repo) });
    }
    // Sparring files live on the plan( PR branch until it merges: read them where the handoff was found.
    if (plan && sparring.length === 0) {
      const ref = plan.ref || 'origin/main';
      const ls = gitOk(repo, ['ls-tree', '--name-only', ref, '--', `.kiro/specs/${slug}/sparring/`]);
      sparring = ls ? ls.split('\n').filter(Boolean) : [];
    }
  }
  const byRepo = new Map();
  const check = checks || ((l) => {
    if (!byRepo.has(l.repoSlug)) byRepo.set(l.repoSlug, ghChecks(l.repoSlug));
    return byRepo.get(l.repoSlug)(l);
  });
  return planNext({ slug, plan: plan || {}, lanes: [...lanes.values()], sparring, checks: check, cap });
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { _: [], repo: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = /^--([\w-]+)=(.*)$/.exec(a);
    const [k, v] = eq ? [eq[1], eq[2]] : a.startsWith('--') ? [a.slice(2), undefined] : [null, a];
    if (k === null) { out._.push(v); continue; }
    const val = k === 'json' ? true : v ?? argv[++i];
    if (k === 'repo') out.repo.push(val); else out[k] = val;
  }
  if (out.repo.length === 0) out.repo.push('.');
  return out;
}
export function main(argv) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  const repos = args.repo.map((r) => path.resolve(r));
  if (cmd === 'heartbeat') {
    const r = heartbeat(repos[0], args.slug, args.session);
    console.log(JSON.stringify(r));
    if (!r.ok) console.error(`refused: ${r.note} (holder ${r.holder})`);
    return r.ok ? 0 : 3;
  }
  if (cmd === 'heartbeat-age') { console.log(String(heartbeatAge(repos[0], args.slug))); return 0; }
  if (cmd === 'next') {
    const r = next(repos, args.slug, { cap: args.cap === undefined ? DEFAULT_CAP : Number(args.cap) });
    if (args.json) console.log(JSON.stringify(r, null, 2));
    else for (const a of r.actions) console.log([a.action, a.lane || '', a.round ? `${a.prefix}round-${a.round}` : '', a.reason || ''].filter(Boolean).join('\t'));
    return 0;
  }
  throw new Usage(`unknown command "${cmd || ''}" (heartbeat | heartbeat-age | next)`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) {
    console.error(`plan-driver.mjs: ${e.message}`);
    process.exitCode = e instanceof Usage ? 2 : 1;
  }
}
