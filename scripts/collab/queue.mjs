#!/usr/bin/env node
/**
 * VTID-05145 — Claude Code ↔ Kiro collaboration queue.
 *
 * Git is the only channel between Claude Code and Kiro IDE sessions. Every plan lives in
 * `.kiro/specs/<slug>/` with a plan-level `handoff.md` and one `lanes/<lane-id>.md` per independently
 * executable unit. Sessions take a lane with an atomic claim ref `refs/heads/collab-claim/<slug>/<lane-id>`
 * (a push without force is refused when the ref already exists). Rules: `.claude/rules/collaboration.md`.
 * The single copy of this script lives in vitana-platform; vitana-v1 CI fetches it.
 *
 *   node scripts/collab/queue.mjs [--repo <path>]... [--mine <session>] [--seat <seat>] [--json] [--days 30]
 *   node scripts/collab/queue.mjs session-id --agent kiro [--seat <seat>]
 *   node scripts/collab/queue.mjs claim   <slug>/<lane-id> --session <id> [--repo <path>]
 *   node scripts/collab/queue.mjs release <slug>/<lane-id> --session <id> [--stale] [--repo <path>]
 *   node scripts/collab/queue.mjs claims  [--repo <path>]          (claims with age; housekeeping input)
 *   node scripts/collab/queue.mjs validate --base <sha> --head <sha> [--repo .] [--branch <name>]
 *                                         [--allow-initial=<slug>] [--lane-repo <owner/repo>] [--summary <file>]
 *   node scripts/collab/queue.mjs scope-check --base <sha> --head <sha> [--repo .] [--branch <name>]
 *                                         [--lane-repo <owner/repo>] [--summary <file>]   (VTID-05213 Lane scope)
 *   node scripts/collab/queue.mjs [...] --program <id>             (lanes of one programme, docs/programs/<id>/program.md)
 *
 * Read the queue after `git fetch --prune origin` in every checkout. Exit codes: 0 ok, 1 validation
 * failed / claim refused, 2 usage.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const AGENTS = ['claude', 'kiro'];
export const ACTORS = ['claude', 'kiro', 'owner'];
export const PLAN_STATES = ['drafted', 'sparred', 'approved', 'executing', 'in-review', 'verified', 'done', 'parked'];
export const LANE_STATES = ['ready', 'executing', 'in-review', 'verified', 'done', 'parked'];
const PLAN_NEEDS_VTIDS = new Set(['approved', 'executing', 'in-review', 'verified', 'done']);
const PLAN_EDGES = {
  drafted: ['sparred'],
  sparred: ['approved', 'drafted'],
  approved: ['executing'],
  executing: ['in-review'],
  'in-review': ['verified', 'executing'],
  verified: ['done'],
  done: [],
};
const LANE_EDGES = {
  ready: ['executing'],
  executing: ['in-review'],
  'in-review': ['verified', 'executing'],
  verified: ['done'],
  done: [],
};
export const PLAN_LANE = '_plan';
const CLAIM_PREFIX = 'collab-claim/';
const STALE_CLAIM_MS = 24 * 3600 * 1000;
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
// Kiro session ids may name the account seat (VTID-05145 A1): kiro-<seat>-YYYYMMDDHHMM-xxxx. Seats are letters only,
// so a seat can never be mistaken for the 12-digit stamp; the old kiro-YYYYMMDDHHMM-xxxx form stays valid.
// VTID-05213: two automation literals — `pm-agent` (the Project Manager's lane-file commits) and `ci-plan-spar`
// (PLAN-SPAR.yml's sparring-round commits).
const SESSION_RE = /^(session_[A-Za-z0-9]+|kiro-(?:[a-z]{1,12}-)?\d{12}-[0-9a-f]{4}|pm-agent|ci-plan-spar)$/;
export const SEAT_RE = /^[a-z]{1,12}$/;
export const isSessionId = (s) => SESSION_RE.test(s || '');
const CI_PLAN_SPAR = 'ci-plan-spar';
/** The seat named in a seat-scoped Kiro session id, else ''. */
export const seatOf = (s) => (/^kiro-([a-z]{1,12})-\d{12}-[0-9a-f]{4}$/.exec(s || '') || [])[1] || '';

// VTID-05213: governance paths (CI, rules, steering, automations, this script, the seat map). VTID-05259
// (retire-claude-code): a Kiro lane may declare and change them only with `governance: true`, built by its `seat` and
// reviewed by a different named Kiro `reviewer_seat`; legacy `executor: claude` lanes keep working.
export const GOVERNANCE_PATHS = ['.github/**', '.claude/**', '.kiro/steering/**', '.kiro/automations/**', 'scripts/collab/**',
  'CLAUDE.md', 'docs/programs/areas.yaml'];

/** Glob → RegExp: `**` any path (incl. `/`), `*` within one segment, `?` one char. `dir/**` also matches `dir`. */
export function globToRegex(glob) {
  let re = '';
  const g = String(glob).trim();
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === '*' && g[i + 1] === '*') {
      i++;
      if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
    } else if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  if (re.endsWith('/.*')) re = `${re.slice(0, -3)}(?:/.*)?`;
  return new RegExp(`^${re}$`);
}
export const matchesAny = (file, globs) => asList(globs).some((g) => globToRegex(g).test(file));
// Representative files under every governance path: a declared glob that matches any of them (e.g. `**/*.yml`,
// `*.md`) reaches governance even when it does not name the directory.
const GOVERNANCE_PROBES = ['.github/workflows/PR-GATE.yml', '.github/CODEOWNERS', '.claude/rules/collaboration.md',
  '.claude/skills/x/SKILL.md', '.claude/settings.json', '.kiro/steering/x.md', '.kiro/automations/x.md',
  'scripts/collab/queue.mjs', 'scripts/collab/x.test.mjs', 'CLAUDE.md', 'docs/programs/areas.yaml'];
/** Does a declared lane glob reach into a governance path? (it matches a governance file, names one, or is named by one) */
export const globTouchesGovernance = (glob) => GOVERNANCE_PROBES.some((f) => globToRegex(glob).test(f)) || GOVERNANCE_PATHS.some((gp) => {
  const probe = String(glob).replace(/\*\*.*$/, '').replace(/\*.*$/, '');
  return globToRegex(gp).test(probe.replace(/\/$/, '')) || globToRegex(glob).test(gp.replace(/\/\*\*$/, '')) || globToRegex(glob).test(gp);
});

// ── Parsing ──────────────────────────────────────────────────────────────

/** Minimal YAML front matter: `key: value`, `key: [a, b]`, and `key:` followed by `  - item` lines. */
export function parseFrontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ''));
  if (!m) return null;
  const out = {};
  let listKey = null;
  for (const raw of m[1].split(/\r?\n/)) {
    if (/^\s*(#.*)?$/.test(raw)) continue;
    const item = /^\s+-\s+(.*)$/.exec(raw);
    if (item && listKey) { out[listKey].push(clean(item[1])); continue; }
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(raw);
    if (!kv) continue;
    const v = kv[2].replace(/\s+#.*$/, '').trim();
    if (v === '') { listKey = kv[1]; out[listKey] = []; continue; }
    listKey = null;
    if (/^\[.*\]$/.test(v)) out[kv[1]] = v.slice(1, -1).split(',').map(clean).filter(Boolean);
    else out[kv[1]] = clean(v);
  }
  return out;
}

function clean(s) {
  const t = String(s).trim();
  return /^(["']).*\1$/.test(t) ? t.slice(1, -1) : t;
}

const asList = (v) => (v === undefined || v === '' ? [] : Array.isArray(v) ? v : [v]);

/** `.kiro/specs/<slug>/handoff.md` → {slug, lane:'_plan'}; `.kiro/specs/<slug>/lanes/<id>.md` → {slug, lane:id}. */
export function classifyPath(p) {
  let m = /^\.kiro\/specs\/([^/]+)\/handoff\.md$/.exec(p);
  if (m) return { slug: m[1], lane: PLAN_LANE, kind: 'plan' };
  m = /^\.kiro\/specs\/([^/]+)\/lanes\/([^/]+)\.md$/.exec(p);
  if (m) return { slug: m[1], lane: m[2], kind: 'lane' };
  return null;
}

// ── Validation of a single file and of a transition ─────────────────────

export function validatePlan(fm, slug) {
  const e = [];
  if (!fm) return ['no front matter'];
  if (fm.slug !== slug) e.push(`slug "${fm.slug ?? ''}" must equal the folder name "${slug}"`);
  if (!SLUG_RE.test(slug)) e.push(`slug "${slug}" must be lowercase letters, digits and dashes`);
  if (!AGENTS.includes(fm.author)) e.push(`author must be one of ${AGENTS.join('|')}`);
  if (!AGENTS.includes(fm.executor)) e.push(`executor must be one of ${AGENTS.join('|')}`);
  if (!ACTORS.includes(fm.next_actor)) e.push(`next_actor must be one of ${ACTORS.join('|')}`);
  if (!PLAN_STATES.includes(fm.state)) e.push(`state must be one of ${PLAN_STATES.join('|')}`);
  if (!fm.updated) e.push('updated is required');
  if (PLAN_NEEDS_VTIDS.has(fm.state) && asList(fm.vtids).length === 0) e.push(`vtids required in state ${fm.state}`);
  for (const v of asList(fm.vtids)) if (!/^VTID-\d{5}$/.test(v)) e.push(`bad VTID "${v}"`);
  if (fm.state && fm.state !== 'drafted' && !fm.sparring_record) e.push(`sparring_record required in state ${fm.state}`);
  if (fm.state === 'parked' && !PLAN_EDGES[fm.parked_from]) e.push('parked_from must name the non-terminal state the plan was parked from');
  if (fm.author_seat !== undefined && !SEAT_RE.test(fm.author_seat)) e.push(`author_seat "${fm.author_seat}" must be 1-12 lowercase letters`);
  return e;
}

export function validateLane(fm, slug, lane, laneIds) {
  const e = [];
  if (!fm) return ['no front matter'];
  if (fm.lane !== lane) e.push(`lane "${fm.lane ?? ''}" must equal the file name "${lane}"`);
  if (!SLUG_RE.test(lane) || lane === PLAN_LANE) e.push(`lane id "${lane}" must be lowercase letters, digits and dashes`);
  if (PLAN_STATES.includes(fm.state) && !LANE_STATES.includes(fm.state)) e.push(`state "${fm.state}" is a plan-only state; lanes use ${LANE_STATES.join('|')}`);
  else if (!LANE_STATES.includes(fm.state)) e.push(`state must be one of ${LANE_STATES.join('|')}`);
  if (!ACTORS.includes(fm.next_actor)) e.push(`next_actor must be one of ${ACTORS.join('|')}`);
  if (!fm.updated) e.push('updated is required');
  if (fm.vtid && !/^VTID-\d{5}$/.test(fm.vtid)) e.push(`bad VTID "${fm.vtid}"`);
  if (fm.state && fm.state !== 'ready' && !fm.vtid) e.push(`vtid required in state ${fm.state}`);
  if (fm.claimed_by && !SESSION_RE.test(fm.claimed_by)) e.push(`claimed_by "${fm.claimed_by}" is not a session id (session_… or kiro-[<seat>-]YYYYMMDDHHMM-xxxx)`);
  if (fm.seat !== undefined && !SEAT_RE.test(fm.seat)) e.push(`seat "${fm.seat}" must be 1-12 lowercase letters (see docs/programs/areas.yaml)`);
  // VTID-05213: who builds (executor), who reviews (reviewer_seat) and which files the lane may change (paths).
  if (fm.executor !== undefined && !AGENTS.includes(fm.executor)) e.push(`executor must be one of ${AGENTS.join('|')}`);
  if (fm.reviewer_seat !== undefined) {
    if (fm.reviewer_seat !== 'claude' && !SEAT_RE.test(fm.reviewer_seat)) e.push(`reviewer_seat "${fm.reviewer_seat}" must be a seat or "claude"`);
    if (fm.seat && fm.reviewer_seat === fm.seat) e.push('reviewer_seat must differ from seat (one Kiro account never reviews its own lane)');
  }
  const paths = asList(fm.paths);
  if (fm.executor && fm.state && fm.state !== 'ready' && fm.state !== 'parked' && paths.length === 0) e.push(`paths required in state ${fm.state} for a lane that declares an executor`);
  // VTID-05259: governance lanes. `governance: true` is the only way a Kiro lane reaches a governance path; such a lane
  // names both seats, and the reviewer is a different Kiro seat (never `claude`, never the builder).
  if (fm.governance !== undefined && !['true', 'false'].includes(fm.governance)) e.push('governance must be true or false');
  const gov = fm.governance === 'true';
  if (fm.executor === 'kiro' && !gov) for (const g of paths) if (globTouchesGovernance(g)) e.push(`paths "${g}" reaches a governance path; such a lane needs governance: true`);
  if (gov) {
    if (fm.executor !== 'kiro') e.push('governance: true is for executor: kiro lanes');
    if (!fm.seat) e.push('a governance lane needs a seat');
    if (!fm.reviewer_seat || fm.reviewer_seat === 'claude') e.push('a governance lane needs a reviewer_seat that is a Kiro seat (not claude)');
  }
  if (fm.state === 'parked' && !LANE_EDGES[fm.parked_from]) e.push('parked_from must name the non-terminal state the lane was parked from');
  for (const d of asList(fm.depends_on)) {
    if (d === lane) e.push('a lane cannot depend on itself');
    else if (laneIds && !laneIds.has(d)) e.push(`depends_on "${d}" is not a lane of this spec`);
  }
  return e;
}

/** Legal state change? `before`/`after` are front matter objects (before may be null for a new file). */
export function checkTransition(kind, before, after, { allowInitial = false } = {}) {
  const edges = kind === 'plan' ? PLAN_EDGES : LANE_EDGES;
  const initial = kind === 'plan' ? 'drafted' : 'ready';
  if (!after) return before && kind === 'plan' ? ['handoff.md was deleted'] : before ? ['lane file was deleted'] : [];
  if (!before) return allowInitial || after.state === initial ? [] : [`a new ${kind} file must start at "${initial}" (got "${after.state}")`];
  const a = before.state;
  const b = after.state;
  if (a === b) return [];
  if (a === 'done') return [`"done" is terminal (changed to "${b}")`];
  if (b === 'parked') return [];
  if (a === 'parked') return b === before.parked_from ? [] : [`a parked ${kind} may only return to "${before.parked_from}" (got "${b}")`];
  return (edges[a] || []).includes(b) ? [] : [`illegal transition "${a}" → "${b}"`];
}

// ── Git helpers ─────────────────────────────────────────────────────────

function git(repo, args, opts = {}) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trimEnd();
}

function gitOk(repo, args) {
  try { return git(repo, args); } catch { return null; }
}

function showFile(repo, ref, p) {
  return gitOk(repo, ['show', `${ref}:${p}`]);
}

function specFilesAt(repo, ref) {
  const out = gitOk(repo, ['ls-tree', '-r', '--name-only', ref, '--', '.kiro/specs']);
  return out ? out.split('\n').filter((p) => classifyPath(p)) : [];
}

function defaultRemoteBranch(repo) {
  const sym = gitOk(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (sym) return sym;
  for (const b of ['origin/main', 'origin/master']) if (gitOk(repo, ['rev-parse', '--verify', '-q', b])) return b;
  return null;
}

/** Claims from remote-tracking refs (run `git fetch --prune origin` first). */
export function listClaims(repo) {
  const out = gitOk(repo, ['for-each-ref', '--format=%(refname)%09%(objectname)%09%(committerdate:unix)', `refs/remotes/origin/${CLAIM_PREFIX}`]);
  if (!out) return [];
  return out.split('\n').filter(Boolean).map((line) => {
    const [ref, sha, ts] = line.split('\t');
    const key = ref.slice(`refs/remotes/origin/${CLAIM_PREFIX}`.length);
    const msg = gitOk(repo, ['log', '-1', '--format=%B', sha]) || '';
    const session = (/^Collab-Session:\s*(\S+)/m.exec(msg) || [])[1] || null;
    const [slug, ...rest] = key.split('/');
    return { key, slug, lane: rest.join('/'), sha, session, at: Number(ts) * 1000 };
  });
}

// ── Queue ───────────────────────────────────────────────────────────────

/** Newest version (by `updated`) of every handoff/lane file across main and recent branches. */
export function collect(repo, { days = 30, now = Date.now() } = {}) {
  const main = defaultRemoteBranch(repo);
  if (!main) throw new Error(`${repo}: no origin/main — run git fetch origin`);
  const best = new Map();
  const consider = (ref, p) => {
    const text = showFile(repo, ref, p);
    if (text === null) return;
    const fm = parseFrontMatter(text);
    const prev = best.get(p);
    if (!prev || (fm?.updated || '') > (prev.fm?.updated || '')) best.set(p, { path: p, ref, fm, text, ...classifyPath(p) });
  };
  for (const p of specFilesAt(repo, main)) consider(main, p);
  const since = Math.floor((now - days * 86400000) / 1000);
  const refs = (gitOk(repo, ['for-each-ref', '--format=%(refname:short)%09%(committerdate:unix)', 'refs/remotes/origin']) || '')
    .split('\n').filter(Boolean).map((l) => l.split('\t'))
    .filter(([r, ts]) => r !== main && r !== 'origin/HEAD' && r !== 'origin' && !r.startsWith(`origin/${CLAIM_PREFIX}`) && Number(ts) >= since);
  for (const [ref] of refs) {
    const changed = gitOk(repo, ['diff', '--name-only', `${main}...${ref}`, '--', '.kiro/specs']);
    if (!changed) continue;
    for (const p of changed.split('\n')) if (classifyPath(p)) consider(ref, p);
  }
  return { main, files: [...best.values()], claims: listClaims(repo) };
}

export function buildQueue(collected, repoName) {
  const bySlug = new Map();
  for (const f of collected.files) {
    if (!bySlug.has(f.slug)) bySlug.set(f.slug, { plan: null, lanes: [] });
    if (f.kind === 'plan') bySlug.get(f.slug).plan = f; else bySlug.get(f.slug).lanes.push(f);
  }
  const claimOf = (slug, lane) => collected.claims.find((c) => c.slug === slug && c.lane === lane) || null;
  const rows = [];
  for (const [slug, { plan, lanes }] of [...bySlug.entries()].sort()) {
    const pfm = plan?.fm || {};
    const pc = claimOf(slug, PLAN_LANE);
    rows.push({ repo: repoName, slug, lane: PLAN_LANE, state: pfm.state || '?', next_actor: pfm.next_actor || '?', executor: pfm.executor || '',
      claimed_by: pc?.session || '', blocked: false, vtid: asList(pfm.vtids).join(' '), branch: plan?.ref || '', pr: pfm.pr || '',
      updated: pfm.updated || '', last: lastLog(plan?.text) });
    if (lanes.length === 0 && plan) {
      // A spec without lanes is one implicit lane "main" backed by handoff.md.
      rows.push({ ...rows[rows.length - 1], lane: 'main', claimed_by: claimOf(slug, 'main')?.session || '' });
      continue;
    }
    const states = new Map(lanes.map((l) => [l.lane, l.fm?.state]));
    for (const l of lanes.sort((a, b) => a.lane.localeCompare(b.lane))) {
      const fm = l.fm || {};
      const deps = asList(fm.depends_on);
      rows.push({ repo: repoName, slug, lane: l.lane, state: fm.state || '?', next_actor: fm.next_actor || '?', executor: fm.executor || pfm.executor || '',
        seat: fm.seat || '', reviewer_seat: fm.reviewer_seat || '', paths: asList(fm.paths), area: fm.area || '', claimed_by: claimOf(slug, l.lane)?.session || '', blocked: deps.some((d) => states.get(d) !== 'done'), depends_on: deps,
        vtid: fm.vtid || '', branch: fm.branch || l.ref, pr: fm.pr || '', updated: fm.updated || '', last: lastLog(l.text) });
    }
  }
  return rows;
}

function lastLog(text) {
  if (!text) return '';
  const heads = [...String(text).matchAll(/^###\s+(.+)$/gm)];
  return heads.length ? heads[heads.length - 1][1].trim() : '';
}

export function renderTable(rows) {
  const head = '| repo | program | spec | lane | seat | state | next | claimed by | blocked | VTID | branch / PR | updated | last log |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|';
  const body = rows.map((r) => `| ${r.repo} | ${r.program || ''} | ${r.slug} | ${r.lane} | ${r.seat || ''} | ${r.state} | ${r.next_actor} | ${r.claimed_by || '—'} | ${r.blocked ? 'blocked' : ''} | ${r.vtid} | ${r.pr || r.branch} | ${r.updated} | ${String(r.last).replace(/\|/g, '/')} |`);
  return rows.length ? [head, ...body].join('\n') : '_No specs with a handoff.md._';
}

// ── PR validation ───────────────────────────────────────────────────────

function commitsInRange(repo, base, head) {
  const fmt = '%H%x1f%(trailers:key=Collab-Session,valueonly,separator=%x2c)%x1f%(trailers:key=Collab-Lane,valueonly,separator=%x2c)%x1f%(trailers:key=Collab-Review,valueonly,separator=%x2c)%x1e';
  const out = git(repo, ['log', '--no-merges', '--topo-order', `--format=${fmt}`, `${base}..${head}`]);
  return out.split('\x1e').map((s) => s.trim()).filter(Boolean).map((rec) => {
    const [sha, session, lane, review] = rec.split('\x1f');
    const files = git(repo, ['diff-tree', '--no-commit-id', '--name-only', '-r', sha]).split('\n').filter(Boolean);
    return { sha, session: session.trim(), lane: lane.trim(), review: review.trim(), files };
  });
}

/** Front matter (the text between the first two `---` lines) changed by this commit? */
function frontMatterChanged(repo, sha, p) {
  const a = showFile(repo, `${sha}^`, p);
  const b = showFile(repo, sha, p);
  const fm = (t) => (/^---\r?\n([\s\S]*?)\r?\n---/.exec(t || '') || [])[1] ?? null;
  return fm(a) !== fm(b);
}

/**
 * VTID-05259: the owner's governance record — `owner-instruction: "<words>"` and `merge: <sha>` log lines ADDED by this
 * PR below the front matter (not a front-matter key, not an older entry, not a placeholder). A merge SHA must name a
 * commit this checkout knows when it can be checked.
 */
export function governanceRecord(baseText, headText) {
  const body = (t) => String(t || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').split(/\r?\n/);
  const old = new Set(body(baseText).map((l) => l.trim()));
  const added = body(headText).map((l) => l.trim()).filter((l) => l && !old.has(l));
  const instr = added.find((l) => /^-?\s*owner-instruction:\s*"\s*\S[^"]*\S\s*"/.test(l) && !/"\s*(todo|tbd|none|n\/a|-+)\s*"/i.test(l));
  const m = added.map((l) => /^-?\s*merge:\s*(?:(vitana-v1|vitana-platform)@)?([0-9a-f]{7,40})\b/.exec(l)).find(Boolean);
  return { instruction: !!instr, merge: m ? m[2] : null, mergeRepo: m ? m[1] || null : null };
}

const APPROVED_STATES = ['approved', 'executing', 'in-review', 'verified', 'done'];
const LANE_PERM = ['executor', 'seat', 'reviewer_seat', 'paths', 'governance'];
/**
 * VTID-05259: was this NEW plan approved by PLAN-SPAR inside this PR, with `lanePath` already part of the approved
 * plan (present, same permissions, in the tree of the LAST ci-plan-spar commit on handoff.md)? A lane added after
 * the approval was never sparred.
 */
export function laneApprovedInPr(repo, { mergeBase, head, slug, lanePath, commits }) {
  const hp = `.kiro/specs/${slug}/handoff.md`;
  if (parseFrontMatter(showFile(repo, mergeBase, hp))) return false; // an existing plan: never re-sparred here
  if (!APPROVED_STATES.includes(parseFrontMatter(showFile(repo, head, hp))?.state)) return false;
  const spar = commits.find((x) => x.session === CI_PLAN_SPAR && x.files.includes(hp)); // newest first (topo order)
  // The approval is PLAN-SPAR's own: its commit wrote an approved state. An author writing `approved` after a round
  // that did not converge is not an approval this check can see (that needs the owner's Gate 1).
  if (!spar || !APPROVED_STATES.includes(parseFrontMatter(showFile(repo, spar.sha, hp))?.state)) return false;
  const at = parseFrontMatter(showFile(repo, spar.sha, lanePath));
  const now = parseFrontMatter(showFile(repo, head, lanePath));
  return !!at && !!now && LANE_PERM.every((k) => JSON.stringify(asList(at[k])) === JSON.stringify(asList(now[k])));
}

export function validateRange(repo, { base, head, branch = '', allowInitial = [], fetchLane = null, verifyMerge = null }) {
  const errors = [];
  const warnings = [];
  const changed = git(repo, ['diff', '--name-only', `${base}...${head}`]).split('\n').filter(Boolean);
  const mergeBase = git(repo, ['merge-base', base, head]);
  const touched = changed.map((p) => ({ p, c: classifyPath(p) })).filter((x) => x.c);

  // 1. Every handoff/lane file present at head is valid; every change is a legal transition.
  const slugs = new Set(touched.map((t) => t.c.slug));
  for (const slug of slugs) {
    const headFiles = specFilesAt(repo, head).filter((p) => classifyPath(p).slug === slug);
    const laneIds = new Set(headFiles.map((p) => classifyPath(p)).filter((c) => c.kind === 'lane').map((c) => c.lane));
    for (const p of headFiles) {
      const c = classifyPath(p);
      const fm = parseFrontMatter(showFile(repo, head, p));
      const e = c.kind === 'plan' ? validatePlan(fm, slug) : validateLane(fm, slug, c.lane, laneIds);
      for (const x of e) errors.push(`${p}: ${x}`);
    }
    if (laneIds.size && !headFiles.some((p) => classifyPath(p).kind === 'plan')) errors.push(`.kiro/specs/${slug}: lanes without a handoff.md`);
  }
  // 2. Lane / session separation (§9): commits that touch spec state carry matching trailers.
  const commits = commitsInRange(repo, base, head);
  for (const { p, c } of touched) {
    const before = parseFrontMatter(showFile(repo, mergeBase, p));
    const after = parseFrontMatter(showFile(repo, head, p));
    // VTID-05214: PLAN-SPAR.yml sparred the plan inside this PR, so a plan file may move from (new | drafted | sparred)
    // straight to sparred | approved | parked when a ci-plan-spar commit made that change.
    const ciSparred = c.kind === 'plan' && commits.some((k) => k.session === CI_PLAN_SPAR && k.files.includes(p))
      && ['drafted', 'sparred', undefined].includes(before?.state) && ['drafted', 'sparred', 'approved', 'parked'].includes(after?.state);
    if (ciSparred) continue;
    for (const x of checkTransition(c.kind, before, after, { allowInitial: allowInitial.includes(c.slug) })) errors.push(`${p}: ${x}`);
    // VTID-05259: the owner's merge instruction for a governance lane leaves a record the check can see.
    if (c.kind === 'lane' && after?.governance === 'true' && before?.state !== after.state && ['verified', 'done'].includes(after.state)) {
      const rec = governanceRecord(showFile(repo, mergeBase, p), showFile(repo, head, p));
      if (after.state === 'verified' && !rec.instruction) errors.push(`${p}: a governance lane needs a new log line owner-instruction: "<the owner's words>" (date) before verified`);
      if (after.state === 'done' && !rec.merge) errors.push(`${p}: a governance lane needs a new log line merge: <sha> before done`);
      // The merge must be a commit already on the base branch: a commit of this PR (never merged) does not count. A
      // lane merged in the other repo writes `merge: <repo>@<sha>`, verified there through verifyMerge (fail closed).
      // The commit must also name the lane (`<slug>/<lane>`, as every lane PR title does), so an unrelated commit on
      // main does not satisfy it.
      if (after.state === 'done' && rec.merge) {
        const laneKey = `${c.slug}/${c.lane}`;
        if (rec.mergeRepo && rec.mergeRepo !== repoNameOf(repo)) {
          let ok = false;
          try { ok = !!(verifyMerge && verifyMerge(rec.mergeRepo, rec.merge, laneKey, asList(after.paths))); } catch { ok = false; }
          if (!ok) errors.push(`${p}: merge: ${rec.mergeRepo}@${rec.merge} could not be verified as a commit of ${laneKey} on ${rec.mergeRepo} main`);
        } else if (gitOk(repo, ['cat-file', '-e', `${rec.merge}^{commit}`]) === null || gitOk(repo, ['merge-base', '--is-ancestor', rec.merge, base]) === null) {
          errors.push(`${p}: merge: ${rec.merge} is not a commit on the base branch of this repository`);
        } else if (!namesLane(gitOk(repo, ['log', '-1', '--format=%B', rec.merge]) || '', laneKey)) {
          errors.push(`${p}: merge: ${rec.merge} does not name ${laneKey} in its message`);
        } else if (!(gitOk(repo, ['diff', '--name-only', `${rec.merge}^1`, rec.merge]) || '').split('\n').filter(Boolean).some((x) => matchesAny(x, asList(after.paths)))) {
          errors.push(`${p}: merge: ${rec.merge} changes none of the lane's paths (not the lane's merge)`);
        }
      }
    }
    // VTID-05259: with Claude Code retired, no new executor: claude lane is created.
    if (c.kind === 'lane' && !before && after?.executor === 'claude') errors.push(`${p}: new lanes are not executor: claude (Claude Code is retired, retire-claude-code)`);
  }

  const laneTrailers = new Set(commits.map((k) => k.lane).filter(Boolean).flatMap((l) => l.split(',').map((s) => s.trim())));
  const workLanes = [...laneTrailers].filter((l) => !l.endsWith(`/${PLAN_LANE}`));
  if (workLanes.length > 1) errors.push(`one PR per lane: commits name ${workLanes.length} lanes (${workLanes.join(', ')})`);
  const sessionsByLane = new Map();
  for (const k of commits) {
    const short = k.sha.slice(0, 8);
    if (laneTrailers.size && (!k.session || !k.lane) && !k.review) errors.push(`${short}: a lane PR needs Collab-Session and Collab-Lane trailers on every commit`);
    if (k.session && !SESSION_RE.test(k.session)) errors.push(`${short}: Collab-Session "${k.session}" is not a session id`);
    if (k.lane) {
      if (!sessionsByLane.has(k.lane)) sessionsByLane.set(k.lane, new Set());
      sessionsByLane.get(k.lane).add(k.session);
    }
    for (const f of k.files) {
      const c = classifyPath(f);
      if (!c) continue;
      const key = `${c.slug}/${c.lane}`;
      if (k.lane === key) continue;
      // The coordinator declares the lanes: a `_plan` commit may create a lane file, never edit one.
      if (c.kind === 'lane' && k.lane === `${c.slug}/${PLAN_LANE}` && showFile(repo, `${k.sha}^`, f) === null) {
        // VTID-05259: a NEW governance lane is born only with a new plan that PLAN-SPAR approves in this same PR, and
        // only from the plan's author seat — never added to an existing (already converged) plan.
        if (parseFrontMatter(showFile(repo, k.sha, f))?.governance === 'true') {
          const hh = parseFrontMatter(showFile(repo, head, `.kiro/specs/${c.slug}/handoff.md`));
          const approvedHere = laneApprovedInPr(repo, { mergeBase, head, slug: c.slug, lanePath: f, commits });
          if (!approvedHere || !seatOf(k.session) || seatOf(k.session) !== hh?.author_seat) {
            errors.push(`${short}: creates governance lane ${f} — only the author seat of a new plan, in the plan PR that PLAN-SPAR approves`);
          }
        }
        continue;
      }
      // VTID-05214: PLAN-SPAR.yml writes the allocated VTID into a lane that is still `ready`.
      if (c.kind === 'lane' && k.session === CI_PLAN_SPAR && k.lane === `${c.slug}/${PLAN_LANE}`
        && parseFrontMatter(showFile(repo, k.sha, f))?.state === 'ready') continue;
      if (c.kind === 'lane' && k.review === key && !frontMatterChanged(repo, k.sha, f)) continue; // reviewer appends a log entry
      errors.push(`${short}: changes ${f} but its Collab-Lane is "${k.lane || 'none'}" (needs "${key}"${c.kind === 'lane' ? `, or Collab-Review: ${key} with the front matter unchanged` : ''})`);
    }
  }
  for (const [lane, sessions] of sessionsByLane) {
    if (sessions.size > 1) errors.push(`lane ${lane}: commits from ${sessions.size} sessions (${[...sessions].join(', ')}) — one session per lane`);
    const [slug, id] = lane.split('/');
    if (id === PLAN_LANE) continue;
    // A vitana-v1 PR may work a lane whose spec lives in vitana-platform (VTID-05213): fetchLane reads it there.
    const lanePath = `.kiro/specs/${slug}/lanes/${id}.md`;
    const fm = parseFrontMatter(showFile(repo, head, lanePath) ?? (fetchLane ? fetchLane(lanePath) : null));
    if (!fm) { errors.push(`Collab-Lane ${lane}: ${lanePath} does not exist${fetchLane ? ' here or in vitana-platform' : ''}`); continue; }
    const s = [...sessions][0];
    if (fm.claimed_by && fm.claimed_by !== s) errors.push(`lane ${lane}: claimed_by is ${fm.claimed_by} but the commits come from ${s}`);
  }

  // 3. Branch name: a branch in lane form must agree with the trailers. Cloud sessions get their branch
  //    name from the harness, so another form is only a warning.
  const bm = /^(kiro|claude)\/([^/]+)\/([^/]+)$/.exec(branch);
  if (bm) {
    const want = `${bm[2]}/${bm[3]}`;
    for (const l of workLanes) if (l !== want) errors.push(`branch ${branch} is lane ${want} but commits name ${l}`);
  } else if (branch && workLanes.length) {
    warnings.push(`branch "${branch}" is not in the form <kiro|claude>/<slug>/<lane-id>; matched by trailers only`);
  }
  return { errors, warnings, touched: touched.map((t) => t.p) };
}

// ── Lane scope (VTID-05213) ─────────────────────────────────────────────

/**
 * A lane PR may only change the files its lane declares in `paths` (plus its own spec folder and its
 * `docs/validation/<VTID>/` evidence); a governance path needs an `executor: claude` lane; a `kiro/` branch must name
 * its lane in `Collab-Lane` trailers; the lane file is edited only by a session of the lane's `seat` (a review entry:
 * by its `reviewer_seat`). Kiro Web pushes as the shared `exafyltd` identity without the gateway's denied prefixes, so
 * this check is the merge-time boundary the Project Manager requires. Lanes without `paths` (before VTID-05213) are
 * reported only. `fetchLane(path)` returns the lane file's text from vitana-platform when this repo does not hold it.
 */
export function scopeCheck(repo, { base, head, branch = '', fetchLane = null }) {
  const errors = [];
  const warnings = [];
  const commits = commitsInRange(repo, base, head);
  const keys = new Set(commits.map((k) => k.lane).filter(Boolean).flatMap((l) => l.split(',').map((x) => x.trim()))
    .filter((l) => !l.endsWith(`/${PLAN_LANE}`)));
  const bm = /^kiro\/(.+)$/.exec(branch);
  if (bm && !commits.some((k) => k.lane || k.review)) errors.push(`branch ${branch} is a Kiro branch but no commit carries a Collab-Lane (or Collab-Review) trailer`);
  // A review-only PR (Collab-Review, no Collab-Lane) is scoped to the lane it reviews.
  if (keys.size === 0) for (const k of commits) for (const l of (k.review || '').split(',').map((x) => x.trim()).filter(Boolean)) keys.add(l);
  if (keys.size === 0) return { applies: false, errors, warnings, lane: null };
  if (keys.size > 1) { errors.push(`one PR per lane: commits name ${[...keys].join(', ')}`); return { applies: true, errors, warnings, lane: null }; }
  const key = [...keys][0];
  const [slug, id] = key.split('/');
  const lanePath = `.kiro/specs/${slug}/lanes/${id}.md`;
  let text = showFile(repo, head, lanePath);
  let source = 'this repo';
  if (text === null && fetchLane) { text = fetchLane(lanePath); source = 'vitana-platform'; }
  if (text === null || text === undefined) { errors.push(`lane ${key}: ${lanePath} not found in this repo or vitana-platform`); return { applies: true, errors, warnings, lane: key }; }
  let fm = parseFrontMatter(text) || {};
  // The lane's permissions are the BASE revision's (VTID-05213 review): a lane PR must not widen its own `paths`,
  // `executor`, `seat` or `reviewer_seat`. Only a Claude Code session (session_…) may change them, and only on a lane
  // that already was `executor: claude`. A lane that is new in this PR is created by its plan (`_plan` commit).
  const mergeBase = gitOk(repo, ['merge-base', base, head]);
  let baseFm = source === 'this repo' && mergeBase ? parseFrontMatter(showFile(repo, mergeBase, lanePath)) : null;
  // VTID-05259: a lane file that is new in this PR grants nothing by itself. When vitana-platform holds the lane, its
  // copy is authoritative (a vitana-v1 PR cannot shadow it); otherwise the new lane may not reach governance paths.
  const newHere = source === 'this repo' && !baseFm;
  if (newHere && fetchLane) {
    const remote = fetchLane(lanePath);
    if (remote) { fm = parseFrontMatter(remote) || {}; baseFm = null; source = 'vitana-platform'; }
  }
  const newLane = newHere && source === 'this repo';
  // A lane new in this PR may still be built in its own plan PR (plan + build, e.g. #4184) for non-governance paths,
  // when PLAN-SPAR approved that new plan here with the lane already in it. Governance paths always wait for main.
  const newApproved = newLane && laneApprovedInPr(repo, { mergeBase, head, slug, lanePath, commits });
  if (baseFm) {
    const PERM = ['executor', 'seat', 'reviewer_seat', 'paths', 'governance'];
    const changed = PERM.filter((k) => JSON.stringify(asList(baseFm[k])) !== JSON.stringify(asList(fm[k])));
    const sessions = new Set(commits.filter((k) => k.files.includes(lanePath)).map((k) => k.session));
    // VTID-05259: Claude Code is retired, so no session may change a lane's permissions in a lane PR (the old
    // session_… route on executor: claude lanes is closed — a session_ id is self-declared like any other).
    void sessions;
    if (changed.length) {
      errors.push(`lane ${key}: ${changed.join(', ')} changed in a lane PR — lane permissions come from the base revision (a permission change is a new lane in a new plan)`);
    }
    fm = { ...fm, ...Object.fromEntries(PERM.map((k) => [k, baseFm[k]])) };
  }
  const paths = asList(fm.paths);
  const changed = git(repo, ['diff', '--name-only', `${base}...${head}`]).split('\n').filter(Boolean);
  const own = (f) => f.startsWith(`.kiro/specs/${slug}/`) || (fm.vtid && f.startsWith(`docs/validation/${fm.vtid}/`));
  if (paths.length === 0) {
    warnings.push(`lane ${key} declares no paths (pre-VTID-05213 lane): Lane scope reports only, and the Project Manager never merges it`);
  } else {
    for (const f of changed) {
      if (own(f)) continue;
      if (!matchesAny(f, paths)) errors.push(`${f} is outside lane ${key} (paths: ${paths.join(', ')})`);
      else if (newLane && (!newApproved || matchesAny(f, GOVERNANCE_PATHS))) errors.push(`${f}: lane ${key} is created in this PR, so it grants ${newApproved ? 'no governance paths' : 'no paths'} yet (its plan must be approved by PLAN-SPAR in this PR, and governance paths wait until it is on main)`);
      else if (fm.governance !== 'true' && matchesAny(f, GOVERNANCE_PATHS)) errors.push(`${f} is a governance path; lane ${key} is not governance: true (executor ${fm.executor || 'unset'}; legacy executor: claude lanes no longer reach governance paths)`);
    }
  }
  const buildSeats = new Set(commits.filter((k) => k.lane === key).map((k) => seatOf(k.session) || k.session));
  for (const k of commits) {
    // VTID-05259: a review commit only appends to this lane's file — a reviewer never ships code it then approves.
    if (k.review === key && k.lane !== key && k.files.some((f) => f !== lanePath)) {
      errors.push(`${k.sha.slice(0, 8)}: a Collab-Review commit may change only ${lanePath} (it changes ${k.files.filter((f) => f !== lanePath).join(', ')})`);
    }
    if (!k.files.includes(lanePath)) continue;
    const short = k.sha.slice(0, 8);
    const seat = seatOf(k.session);
    if (k.review === key && k.lane !== key) {
      // VTID-05259: a legacy `reviewer_seat: claude` lane also accepts a named Kiro seat — only when the lane names its
      // own seat, the reviewer is a different seat, and that seat built nothing in this PR.
      const kiroOk = !!seat && !!fm.seat && seat !== fm.seat && !buildSeats.has(seat);
      const ok = fm.reviewer_seat === 'claude' ? /^session_/.test(k.session) || kiroOk : !fm.reviewer_seat || seat === fm.reviewer_seat;
      if (!ok) errors.push(`${short}: review entry on ${key} from ${k.session || 'no session'}, but reviewer_seat is ${fm.reviewer_seat}`);
    } else if (fm.seat && seat && seat !== fm.seat) {
      errors.push(`${short}: ${k.session} (seat ${seat}) edits lane ${key}, which belongs to seat ${fm.seat}`);
    } else if (fm.seat && /^kiro-\d{12}-/.test(k.session)) {
      warnings.push(`${short}: ${k.session} names no seat; lane ${key} belongs to seat ${fm.seat}`);
    }
  }
  // VTID-05259: on a governance lane every commit is attributable: built by a session naming the lane's seat, reviewed
  // by one naming reviewer_seat. Unseated kiro-YYYY… and session_… ids are refused (seats are self-declared — all Kiro
  // accounts share one GitHub identity — so the owner's per-PR merge instruction stays the real boundary).
  if (fm.governance === 'true') {
    for (const k of commits) {
      const short = k.sha.slice(0, 8);
      const seat = seatOf(k.session);
      const plan = (k.lane || '').split(',').map((x) => x.trim()).every((l) => l === `${slug}/${PLAN_LANE}`) && !!k.lane
        && k.files.every((f) => f.startsWith(`.kiro/specs/${slug}/`));
      if (k.review === key && k.lane !== key) {
        if (!seat || seat !== fm.reviewer_seat || buildSeats.has(seat)) errors.push(`${short}: governance lane ${key} is reviewed only by seat ${fm.reviewer_seat} (session ${k.session || 'none'})`);
      } else if (plan) {
        continue;
      } else if (!seat || seat !== fm.seat) {
        errors.push(`${short}: governance lane ${key} is built only by seat ${fm.seat} (session ${k.session || 'none'})`);
      }
    }
  }
  return { applies: true, errors, warnings, lane: key, source, paths };
}

/** Read a file of exafyltd/vitana-platform (or `repoSlug`) on main through the GitHub CLI; null when unavailable. */
export function ghFetcher(repoSlug = 'exafyltd/vitana-platform') {
  return (p) => {
    try {
      return execFileSync('gh', ['api', '-H', 'Accept: application/vnd.github.raw', `repos/${repoSlug}/contents/${p}?ref=main`],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      // VTID-05259: only "not found" means "not there"; any other failure must not fall back to a PR-local copy.
      const msg = `${e?.stderr || ''} ${e?.message || ''}`;
      if (/HTTP 404|Not Found/i.test(msg)) return null;
      throw new Error(`could not read ${p} from ${repoSlug} (failing closed): ${msg.trim().slice(0, 200)}`);
    }
  };
}

/** VTID-05259: does a commit message name lane `<slug>/<lane>` as a whole token (not `cards/ab` for `cards/a`)? */
export function namesLane(message, laneKey) {
  const k = String(laneKey).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_/-])${k}(?![A-Za-z0-9_/-])`).test(String(message || ''));
}

/** VTID-05259: is `sha` a commit on `repo`'s main (exafyltd/<repo>)? Through the GitHub CLI; throws when unknown. */
export function ghMergeVerifier(owner = 'exafyltd') {
  return (repoName, sha, laneKey, paths = []) => {
    const opt = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
    const status = execFileSync('gh', ['api', `repos/${owner}/${repoName}/compare/${sha}...main`, '--jq', '.status'], opt).trim();
    if (status !== 'ahead' && status !== 'identical') return false;
    const c = JSON.parse(execFileSync('gh', ['api', `repos/${owner}/${repoName}/commits/${sha}`, '--jq', '{m: .commit.message, f: [.files[].filename]}'], opt));
    return (!laneKey || namesLane(c.m, laneKey)) && (!paths.length || c.f.some((x) => matchesAny(x, paths)));
  };
}

// ── Programme registry (VTID-05213; content: VTID-05215) ─────────────────

/** docs/programs/<id>/program.md files at `ref` → [{id, fm}] (front matter: id, title, status, priority, specs, ...). */
export function loadPrograms(repo, ref) {
  const out = gitOk(repo, ['ls-tree', '-r', '--name-only', ref, '--', 'docs/programs']);
  if (!out) return [];
  return out.split('\n').map((p) => /^docs\/programs\/([^/]+)\/program\.md$/.exec(p)).filter(Boolean)
    .map((m) => ({ id: m[1], path: m[0], fm: parseFrontMatter(showFile(repo, ref, m[0])) }));
}

export const PROGRAM_STATUSES = ['active', 'paused', 'done'];

/** Registry problems: front matter shape, and a spec listed by two programmes. Specs are `<repo>:<slug>`. */
export function validatePrograms(programs) {
  const e = [];
  const owner = new Map();
  for (const { id, path: p, fm } of programs) {
    if (!fm) { e.push(`${p}: no front matter`); continue; }
    if (fm.id !== id) e.push(`${p}: id "${fm.id ?? ''}" must equal the folder name "${id}"`);
    if (!fm.title) e.push(`${p}: title is required`);
    if (!PROGRAM_STATUSES.includes(fm.status)) e.push(`${p}: status must be one of ${PROGRAM_STATUSES.join('|')}`);
    if (!/^[1-5]$/.test(String(fm.priority ?? ''))) e.push(`${p}: priority must be 1-5`);
    for (const sp of asList(fm.specs)) {
      if (!/^[a-z0-9-]+:[a-z0-9][a-z0-9-]*$/.test(sp)) { e.push(`${p}: spec "${sp}" must be <repo>:<slug>`); continue; }
      if (owner.has(sp)) e.push(`${p}: spec ${sp} already belongs to programme ${owner.get(sp)}`);
      else owner.set(sp, id);
    }
  }
  return e;
}

/** Seat names from docs/programs/areas.yaml at `ref` (the keys of its top-level `seats:` map); null when absent. */
export function loadSeats(repo, ref) {
  const text = showFile(repo, ref, 'docs/programs/areas.yaml');
  if (text === null) return null;
  const seats = new Set();
  let inSeats = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\S/.test(line)) { inSeats = /^seats:\s*(#.*)?$/.test(line); continue; }
    const m = inSeats && /^ {2}([a-z]{1,12}):/.exec(line);
    if (m) seats.add(m[1]);
  }
  return seats;
}

/**
 * VTID-05213 review: registry checks for the specs this PR touches — every `seat` / `reviewer_seat` names a seat of
 * areas.yaml (`claude` is a reviewer), and once a programme registry exists, every touched spec belongs to one.
 */
export function validateRegistry(repo, { head, touched, repoName, seats, programs }) {
  const e = [];
  for (const p of touched) {
    const c = classifyPath(p);
    if (!c || c.kind !== 'lane' || !seats) continue;
    const fm = parseFrontMatter(showFile(repo, head, p)) || {};
    if (fm.seat && !seats.has(fm.seat)) e.push(`${p}: seat "${fm.seat}" is not a seat of docs/programs/areas.yaml`);
    if (fm.reviewer_seat && fm.reviewer_seat !== 'claude' && !seats.has(fm.reviewer_seat)) e.push(`${p}: reviewer_seat "${fm.reviewer_seat}" is not a seat of docs/programs/areas.yaml`);
  }
  if (programs.length) {
    const idx = programIndex(programs);
    for (const slug of new Set(touched.map((p) => classifyPath(p)?.slug).filter(Boolean))) {
      if (!idx.has(`${repoName}:${slug}`)) e.push(`.kiro/specs/${slug}: not listed by any docs/programs/<id>/program.md (specs: [${repoName}:${slug}])`);
    }
  }
  return e;
}

/** The repository's name from its origin URL (CI checkouts and worktrees may live in other directories). */
export function repoNameOf(repo) {
  const url = gitOk(repo, ['remote', 'get-url', 'origin']) || '';
  const m = /([^/:]+?)(?:\.git)?\/?$/.exec(url);
  return m && !url.startsWith('/') ? m[1] : path.basename(repo);
}

/** `<repo>:<slug>` → programme id. */
export function programIndex(programs) {
  const m = new Map();
  for (const { id, fm } of programs) for (const sp of asList(fm?.specs)) if (!m.has(sp)) m.set(sp, id);
  return m;
}

// ── Claims ──────────────────────────────────────────────────────────────

function parseKey(key) {
  const m = /^([a-z0-9][a-z0-9-]*)\/(_plan|[a-z0-9][a-z0-9-]*)$/.exec(key || '');
  if (!m) throw new Usage(`expected <slug>/<lane-id> or <slug>/_plan, got "${key}"`);
  return { slug: m[1], lane: m[2] };
}

export function claim(repo, key, session) {
  parseKey(key);
  if (!SESSION_RE.test(session || '')) throw new Usage('--session <id> is required (session_… or kiro-YYYYMMDDHHMM-xxxx)');
  const main = defaultRemoteBranch(repo);
  const tree = git(repo, ['rev-parse', `${main}^{tree}`]);
  // The claim commit is a marker, authored by the session itself — works on machines with no git identity (CI).
  const ident = { GIT_AUTHOR_NAME: session, GIT_AUTHOR_EMAIL: `${session}@collab.invalid`, GIT_COMMITTER_NAME: session, GIT_COMMITTER_EMAIL: `${session}@collab.invalid` };
  const sha = git(repo, ['commit-tree', tree, '-p', main, '-m', `collab-claim ${key}`, '-m', `Collab-Session: ${session}\nCollab-Lane: ${key}`], { env: { ...process.env, ...ident } });
  try {
    git(repo, ['push', 'origin', `${sha}:refs/heads/${CLAIM_PREFIX}${key}`]);
  } catch (err) {
    git(repo, ['fetch', '--prune', 'origin']);
    const holder = listClaims(repo).find((c) => c.key === key);
    return { ok: false, holder: holder?.session || 'unknown', since: holder ? new Date(holder.at).toISOString() : '', detail: String(err.stderr || err.message).trim() };
  }
  git(repo, ['fetch', '--prune', 'origin']);
  return { ok: true, sha };
}

export function release(repo, key, session, { stale = false, now = Date.now() } = {}) {
  parseKey(key);
  git(repo, ['fetch', '--prune', 'origin']);
  const c = listClaims(repo).find((x) => x.key === key);
  if (!c) return { ok: true, note: 'no claim' };
  const isStale = now - c.at > STALE_CLAIM_MS;
  if (c.session !== session && !(stale && isStale)) {
    return { ok: false, holder: c.session, note: stale ? 'claim is younger than 24 h' : 'held by another session (use --stale for a claim older than 24 h, and log it on the spec)' };
  }
  git(repo, ['push', 'origin', '--delete', `${CLAIM_PREFIX}${key}`]);
  git(repo, ['fetch', '--prune', 'origin']);
  return { ok: true, broke: c.session !== session ? c.session : null };
}

export function sessionId(agent, now = new Date(), seat = '') {
  if (agent !== 'kiro') throw new Usage('only Kiro sessions generate an id; a Claude cloud session uses its session_… id');
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}${p(now.getUTCHours())}${p(now.getUTCMinutes())}`;
  if (seat && !SEAT_RE.test(seat)) throw new Usage(`--seat "${seat}" must be 1-12 lowercase letters`);
  return `kiro-${seat ? `${seat}-` : ''}${stamp}-${randomBytes(2).toString('hex')}`;
}

// ── CLI ─────────────────────────────────────────────────────────────────

class Usage extends Error {}

function parseArgs(argv) {
  const out = { _: [], repo: [], allowInitial: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = /^--([\w-]+)=(.*)$/.exec(a);
    const [k, v] = eq ? [eq[1], eq[2]] : a.startsWith('--') ? [a.slice(2), undefined] : [null, a];
    if (k === null) { out._.push(v); continue; }
    const flag = ['json', 'stale'].includes(k);
    const val = flag ? true : v ?? argv[++i];
    if (k === 'repo') out.repo.push(val);
    else if (k === 'allow-initial') out.allowInitial.push(val);
    else out[k] = val;
  }
  if (out.repo.length === 0) out.repo.push('.');
  return out;
}

function main(argv) {
  const args = parseArgs(argv);
  const cmd = args._[0] || 'queue';
  const repo = path.resolve(args.repo[0]);
  if (cmd === 'session-id') { console.log(sessionId(args.agent, new Date(), args.seat || '')); return 0; }
  if (cmd === 'claim' || cmd === 'release') {
    const r = cmd === 'claim' ? claim(repo, args._[1], args.session) : release(repo, args._[1], args.session, { stale: args.stale });
    console.log(JSON.stringify(r));
    if (!r.ok) console.error(cmd === 'claim' ? `refused: ${args._[1]} is held by ${r.holder} since ${r.since} — pick another lane` : `refused: ${r.note}`);
    return r.ok ? 0 : 1;
  }
  if (cmd === 'claims') {
    const now = Date.now();
    for (const c of listClaims(repo)) console.log(`${c.key}\t${c.session}\t${Math.round((now - c.at) / 3600000)}h`);
    return 0;
  }
  if (cmd === 'validate') {
    if (!args.base || !args.head) throw new Usage('validate needs --base <sha> --head <sha>');
    // A one-time backfill of an existing spec is allowed by `"collab_allow_initial": ["<slug>"]` in a
    // docs/validation/<VTID>/scope.json that this same PR changes — never by a file already on main.
    const allowInitial = [...args.allowInitial];
    for (const p of git(repo, ['diff', '--name-only', `${args.base}...${args.head}`]).split('\n')) {
      if (!/^docs\/validation\/VTID-\d{5}\/scope\.json$/.test(p)) continue;
      try { allowInitial.push(...asList(JSON.parse(showFile(repo, args.head, p) || '{}').collab_allow_initial)); } catch { /* scope guard reports bad JSON */ }
    }
    const r = validateRange(repo, { base: args.base, head: args.head, branch: args.branch || '', allowInitial,
      fetchLane: args['lane-repo'] ? ghFetcher(args['lane-repo']) : null, verifyMerge: ghMergeVerifier() });
    const programs = loadPrograms(repo, args.head);
    r.errors.push(...validatePrograms(programs));
    // Seats are checked against areas.yaml from this repo, else from vitana-platform main (fetchLane reads any file).
    const fetch = args['lane-repo'] ? ghFetcher(args['lane-repo']) : null;
    let seats = loadSeats(repo, args.head);
    if (!seats && fetch) {
      const t = fetch('docs/programs/areas.yaml');
      if (t) { seats = new Set(); let on = false; for (const l of t.split(/\r?\n/)) { if (/^\S/.test(l)) { on = /^seats:/.test(l); continue; } const m = on && /^ {2}([a-z]{1,12}):/.exec(l); if (m) seats.add(m[1]); } }
    }
    r.errors.push(...validateRegistry(repo, { head: args.head, touched: r.touched, repoName: repoNameOf(repo), seats, programs }));
    let md;
    try {
      const rows = buildQueue(collect(repo), path.basename(repo));
      md = renderTable(rows);
    } catch (e) { md = `_queue unavailable: ${e.message}_`; }
    const status = r.errors.length ? `❌ **collab handoff** — ${r.errors.length} problem(s):\n${r.errors.map((e) => `- ${e}`).join('\n')}`
      : `✅ **collab handoff** — ${r.touched.length} handoff/lane file(s) changed, all valid`;
    const warn = r.warnings.length ? `\n\n⚠️ ${r.warnings.join('\n⚠️ ')}` : '';
    const out = `${status}${warn}\n\n<details><summary>Collab queue</summary>\n\n${md}\n\n</details>\n`;
    if (args.summary) appendFileSync(args.summary, out); else console.log(out);
    return r.errors.length ? 1 : 0;
  }
  if (cmd === 'scope-check') {
    if (!args.base || !args.head) throw new Usage('scope-check needs --base <sha> --head <sha>');
    const r = scopeCheck(repo, { base: args.base, head: args.head, branch: args.branch || '', fetchLane: args['lane-repo'] ? ghFetcher(args['lane-repo']) : null });
    const status = !r.applies ? '➖ **lane scope** — not a lane PR'
      : r.errors.length ? `❌ **lane scope** — ${r.errors.length} problem(s)${r.lane ? ` (lane ${r.lane})` : ''}:\n${r.errors.map((e) => `- ${e}`).join('\n')}`
        : `✅ **lane scope** — lane ${r.lane}: every change is inside its paths`;
    const warn = r.warnings.length ? `\n\n⚠️ ${r.warnings.join('\n⚠️ ')}` : '';
    if (args.summary) appendFileSync(args.summary, `${status}${warn}\n`); else console.log(`${status}${warn}`);
    return r.errors.length ? 1 : 0;
  }
  if (cmd === 'queue') {
    let rows = [];
    const programs = [];
    for (const r of args.repo) {
      const abs = path.resolve(r);
      const c = collect(abs, { days: Number(args.days || 30) });
      rows = rows.concat(buildQueue(c, path.basename(abs)));
      programs.push(...loadPrograms(abs, c.main));
    }
    const pidx = programIndex(programs);
    for (const row of rows) row.program = pidx.get(`${row.repo}:${row.slug}`) || '';
    if (args.program) rows = rows.filter((r) => r.program === args.program);
    if (args.mine) rows = rows.filter((r) => r.claimed_by === args.mine);
    if (args.seat) rows = rows.filter((r) => r.seat === args.seat);
    console.log(args.json ? JSON.stringify(rows, null, 2) : renderTable(rows));
    return 0;
  }
  throw new Usage(`unknown command "${cmd}"`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) {
    console.error(`queue.mjs: ${e.message}`);
    process.exitCode = e instanceof Usage ? 2 : 1;
  }
}
