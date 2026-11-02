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
 *   node scripts/collab/queue.mjs session-id --agent agent:vitana-lane-reviewer      (VTID-05276 reviewer agent)
 *   node scripts/collab/queue.mjs claim   <slug>/<lane-id> --session <id> [--repo <path>]
 *   node scripts/collab/queue.mjs release <slug>/<lane-id> --session <id> [--stale] [--repo <path>]
 *   node scripts/collab/queue.mjs claims  [--repo <path>]          (claims with age; housekeeping input)
 *   node scripts/collab/queue.mjs validate --base <sha> --head <sha> [--repo .] [--branch <name>]
 *                                         [--allow-initial=<slug>] [--lane-repo <owner/repo>] [--plan-repo <owner/repo>]... [--summary <file>]
 *   node scripts/collab/queue.mjs scope-check --base <sha> --head <sha> [--repo .] [--branch <name>]
 *                                         [--lane-repo <owner/repo>] [--plan-repo <owner/repo>]... [--summary <file>]
 *                                         (VTID-05213 Lane scope; VTID-05276: lane files of an open plan( PR)
 *   node scripts/collab/queue.mjs [...] --program <id>             (lanes of one programme, docs/programs/<id>/program.md)
 *
 * Read the queue after `git fetch --prune origin` in every checkout. Exit codes: 0 ok, 1 validation
 * failed / claim refused, 2 usage.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, closeSync, mkdtempSync, openSync, readFileSync, readSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
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
// VTID-05276: a reviewer agent's own id, agent-<name>-YYYYMMDDHHMM-xxxx (`session-id --agent agent:<name>`).
const SESSION_RE = /^(session_[A-Za-z0-9]+|kiro-(?:[a-z]{1,12}-)?\d{12}-[0-9a-f]{4}|agent-[a-z][a-z0-9-]{0,40}-\d{12}-[0-9a-f]{4}|pm-agent|ci-plan-spar)$/;
export const SEAT_RE = /^[a-z]{1,12}$/;
export const isSessionId = (s) => SESSION_RE.test(s || '');
const CI_PLAN_SPAR = 'ci-plan-spar';
const PM_AGENT = 'pm-agent';
/** The seat named in a seat-scoped Kiro session id, else ''. */
export const seatOf = (s) => (/^kiro-([a-z]{1,12})-\d{12}-[0-9a-f]{4}$/.exec(s || '') || [])[1] || '';

// VTID-05276 (plan kiro-autonomy-fallback §4.1): reviewer agents — a `reviewer_seat` value that is not a Kiro seat. A
// lane with `executor: kiro` and `reviewer_seat: agent:vitana-lane-reviewer` may change governance paths (never a
// protected gate file); its review entries come from the agent's own session id.
export const REVIEWER_AGENTS = ['agent:vitana-lane-reviewer'];
export const isReviewerAgent = (v) => REVIEWER_AGENTS.includes(v);
/** The reviewer agent named in an agent session id (`agent:<name>`), else ''. */
export const agentOf = (s) => {
  const m = /^agent-([a-z][a-z0-9-]{0,40})-\d{12}-[0-9a-f]{4}$/.exec(s || '');
  return m ? `agent:${m[1]}` : '';
};

// VTID-05213: paths that only an `executor: claude` lane may change (governance: CI, rules, steering, automations,
// this script, the seat map). A Kiro lane that declares or touches one is refused by validate and scope-check —
// VTID-05276: unless the lane's reviewer is a reviewer agent and its permissions come from a trusted source.
export const GOVERNANCE_PATHS = ['.github/**', '.claude/**', '.kiro/steering/**', '.kiro/automations/**', 'scripts/collab/**',
  'CLAUDE.md', 'docs/programs/areas.yaml'];

// VTID-05276 (plan §4.3), VTID-05408 (kiro-lane-admin §4): protected gate files — the gates themselves. A Kiro lane
// never changes one on a reviewer-agent accept alone; it needs the owner's instruction naming the plan plus a
// reviewer-agent accept on the current head (Claude Code is retired). The list lives in protected-gate-files.json next
// to this script; CI and vitana-v1 run single-file copies of queue.mjs, so the same list is compiled in for when the
// JSON is absent. A JSON that is present but unreadable, malformed or empty fails loudly (never silently emptied).
export const PROTECTED_GATE_BUILTIN = ['CLAUDE.md', 'scripts/collab/plan-spar.mjs', 'scripts/collab/queue.mjs',
  'scripts/collab/protected-gate-files.json', 'services/gateway/src/services/plan-sparring/**',
  'services/gateway/src/services/project-manager/governance.ts', '.github/workflows/PLAN-SPAR.yml',
  '.github/workflows/PR-GATE.yml', '.github/workflows/AWS-PROD-*.yml', '.kiro/agents/vitana-lane-reviewer.md',
  'supabase/migrations/*vtid_ledger*.sql', 'supabase/migrations/*plan_sparring*.sql'];
function loadProtectedGatePaths() {
  let text;
  try { text = readFileSync(new URL('./protected-gate-files.json', import.meta.url), 'utf8'); } catch (e) {
    if (e && e.code === 'ENOENT') return PROTECTED_GATE_BUILTIN;
    throw e;
  }
  const globs = JSON.parse(text).globs;
  if (!Array.isArray(globs) || globs.length === 0 || !globs.every((g) => typeof g === 'string' && g.trim())) {
    throw new Error('scripts/collab/protected-gate-files.json: "globs" must be a non-empty list of path globs');
  }
  return globs;
}
export const PROTECTED_GATE_PATHS = Object.freeze(loadProtectedGatePaths());

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
// VTID-05276: a representative file for every protected gate glob that is also a governance path (`*`/`**` → `x`).
// validateLane refuses a Kiro lane whose declared glob reaches one of them. Protected gate code outside governance
// (plan-sparring service, PM governance guard, reviewer agent, gate migrations) is refused by scopeCheck when a
// Kiro lane actually changes it, not at declaration, so lanes that already declare those directories stay valid.
const PROTECTED_GOVERNANCE_PROBES = PROTECTED_GATE_PATHS.filter((g) => globTouchesGovernance(g))
  .map((g) => g.replace(/\*\*/g, 'x').replace(/\*/g, 'x'));
/** Does a declared lane glob reach a protected gate file that is a governance path? */
export const globTouchesProtected = (glob) => PROTECTED_GOVERNANCE_PROBES.some((f) => globToRegex(glob).test(f));

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
// VTID-05408 (kiro-lane-admin §0): parseFrontMatter assigns every scalar as a STRING, so `lane_admin: true` parses to
// the string 'true' and a `=== true` comparison on it is always false (dead on arrival). Every test of `lane_admin`
// uses toBool, never boolean strict equality; it also accepts a real boolean, so it stays correct if parseFrontMatter
// is ever hardened to emit booleans.
const toBool = (v) => v === true || v === 'true';

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
    if (isReviewerAgent(fm.reviewer_seat)) {
      if (fm.executor !== 'kiro') e.push(`reviewer_seat "${fm.reviewer_seat}" is a reviewer agent; it reviews only lanes with executor: kiro`);
    } else if (fm.reviewer_seat !== 'claude' && !SEAT_RE.test(fm.reviewer_seat)) {
      e.push(`reviewer_seat "${fm.reviewer_seat}" must be a seat, "claude" or a reviewer agent (${REVIEWER_AGENTS.join(', ')})`);
    }
    if (fm.seat && fm.reviewer_seat === fm.seat) e.push('reviewer_seat must differ from seat (one Kiro account never reviews its own lane)');
  }
  const paths = asList(fm.paths);
  if (fm.executor && fm.state && fm.state !== 'ready' && fm.state !== 'parked' && paths.length === 0) e.push(`paths required in state ${fm.state} for a lane that declares an executor`);
  if (fm.executor === 'kiro') {
    for (const g of paths) {
      if (globTouchesProtected(g)) e.push(`paths "${g}" reaches a protected gate file (a governance path an agent review cannot unlock, scripts/collab/protected-gate-files.json); such a lane needs executor: claude`);
      else if (globTouchesGovernance(g) && !isReviewerAgent(fm.reviewer_seat)) e.push(`paths "${g}" reaches a governance path; such a lane needs executor: claude, or reviewer_seat: ${REVIEWER_AGENTS[0]}`);
    }
  }
  // VTID-05408 (kiro-lane-admin §1): the lane-administration marker. A `lane_admin` lane (string marker via toBool; §0)
  // may, through the carve-outs in scopeCheck/validateRange, change the PERM fields of a TARGET lane it administers —
  // so it must be executor: kiro, reviewer-agent-gated, and declare at least one lane-file path it administers.
  // `lane_admin` is NOT a permission field; scopeCheck pins it to the trusted revision so a lane PR can never
  // self-grant it. The protected-gate / governance-path checks above are unchanged.
  if (toBool(fm.lane_admin) && !(fm.executor === 'kiro' && isReviewerAgent(fm.reviewer_seat) && paths.some((g) => globToRegex('.kiro/specs/*/lanes/*.md').test(g)))) {
    e.push(`lane_admin: true needs executor: kiro, reviewer_seat: ${REVIEWER_AGENTS[0]}, and a lane-file path (.kiro/specs/*/lanes/*.md)`);
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

// ── VTID-05351: a chain of legal transitions in one closing record ───────

const CHAIN_MAX_EDGES = 6;
const LOG_HEADER_RE = /^### (\S+) · (\S+) · (.*)$/;
// A PR reference: the full URL or the `owner/repo#N` short form the closing records use.
const PR_URL_RE = /https:\/\/github\.com\/[^\s)`]+\/pull\/\d+|\b[\w.-]+\/[\w.-]+#\d+\b/;
const MERGE_SHA_RE = /\bmerge[:\s]+`?([0-9a-f]{7,40})\b/i;
const REVIEW_RE = /^review:\s*(accept|changes)\b/m;
const REVIEW_HEAD_RE = /^head:\s*([0-9a-f]{40})\b/m;

/** The `## Log` section of a spec file (CRLF normalised), '' when there is none. */
function logSection(text) {
  const t = String(text || '').replace(/\r\n/g, '\n');
  const i = t.search(/^## Log[ \t]*$/m);
  return i < 0 ? '' : t.slice(i);
}

/** Log entries `{ time, session, change, body }` in file order; text before the first `### ` is ignored. */
function logEntries(log) {
  const out = [];
  for (const line of log.split('\n')) {
    if (line.startsWith('### ')) {
      const m = LOG_HEADER_RE.exec(line);
      out.push({ time: m ? m[1] : '', session: m ? m[2] : '', change: m ? m[3].trim() : line.slice(4), body: '' });
    } else if (out.length) out[out.length - 1].body += `${line}\n`;
  }
  return out;
}

/** A review entry: a `· review…` header whose body carries `review: accept|changes` and a 40-hex `head:`. */
function isReviewEntry(e) {
  return /^review\b/.test(e.change) && REVIEW_RE.test(e.body) && REVIEW_HEAD_RE.test(e.body);
}

/** The `<a> → <b>` edge an entry header records, or null (reviews, updates, notes and unknown headers carry none). */
function entryEdge(kind, entry) {
  const states = kind === 'plan' ? PLAN_STATES : LANE_STATES;
  const m = /^([a-z-]+) → ([a-z-]+)(?=$|[\s(;,.:])/.exec(entry.change);
  return m && states.includes(m[1]) && states.includes(m[2]) ? { a: m[1], b: m[2] } : null;
}

/**
 * Validates a change of `state` that spans several edges in one PR (plan pipeline-lane-state-efficiency §3.1).
 * Every edge must be its own newly appended log entry, connect base → head, be legal on its own (done terminal,
 * parked returns only to the parked_from tracked through the chain), be in time order, and carry its evidence:
 * lane `executing → in-review` a PR URL or `owner/repo#N`; `in-review → verified` / `in-review → executing` a `review: accept` /
 * `review: changes` entry (a `· review…` header with `head:`) as the latest review since the last changes round, backed
 * by its Collab-Review commit when that entry is new in this range (`reviewCommits` = `{ verdict, reviewedHead,
 * appended }` of this lane's authorized review-only commits in the range, `appended` = the log text the commit added;
 * see `reviewBacking`); `verified → done` a merge sha (`merge: <sha>` or ``Merge `<sha>` ``) in its own entry or in
 * the `in-review → verified` entry. A plan chain ending `done` needs every lane at the head `done` (`laneStates`).
 * Returns the list of errors ([] = valid). Fails closed: an unknown header carries no edge.
 */
export function transitionChain(kind, beforeText, afterText, { reviewCommits = [], laneStates = null } = {}) {
  const before = parseFrontMatter(beforeText);
  const after = parseFrontMatter(afterText);
  if (!before || !after) return ['chain needs the file at both the merge-base and the head'];
  const baseLog = logSection(beforeText);
  const headLog = logSection(afterText);
  if (!headLog.startsWith(baseLog)) return ['log rewritten: entries before the head may only be appended to'];
  const prior = logEntries(baseLog);
  const added = logEntries(headLog.slice(baseLog.length));
  const all = [...prior, ...added];
  const edges = added.map((e, i) => ({ e, i: prior.length + i, ...entryEdge(kind, e) })).filter((x) => x.a);
  const errors = [];
  if (edges.length === 0) return [`no logged transition for ${before.state} → ${after.state}`];
  if (edges.length > CHAIN_MAX_EDGES) errors.push(`a chain may carry at most ${CHAIN_MAX_EDGES} transitions (got ${edges.length})`);
  // Connected, legal edge by edge, parked_from tracked through the chain.
  let cur = before.state;
  let parkedFrom = before.parked_from;
  for (const x of edges) {
    if (x.a !== cur) { errors.push(`chain does not connect ${before.state} → ${after.state}: entry "${x.e.change}" starts at "${x.a}", expected "${cur}"`); break; }
    for (const err of checkTransition(kind, { state: x.a, parked_from: parkedFrom }, { state: x.b })) errors.push(`chain entry "${x.e.change}": ${err}`);
    if (x.b === 'parked') parkedFrom = x.a;
    cur = x.b;
  }
  if (!errors.length && cur !== after.state) errors.push(`chain does not connect ${before.state} → ${after.state}: the last entry ends at "${cur}"`);
  if (after.state === 'parked' && after.parked_from !== parkedFrom) errors.push(`parked_from "${after.parked_from ?? ''}" must be "${parkedFrom ?? ''}", the state the chain parked from`);
  // Time order of the new entries (ISO-8601 strings sort by time), after the last dated base entry.
  let last = [...prior].reverse().find((e) => e.time)?.time || '';
  for (const e of added) {
    if (!e.time) continue;
    if (e.time < last) { errors.push(`log entries out of order: "${e.time}" after "${last}"`); break; }
    last = e.time;
  }
  // Evidence per edge.
  // The review window of entry i: since the last `in-review → executing` (a changes round), else the whole log. The
  // LATEST review entry in it must carry the verdict, so an accept from before a changes round is never reused.
  const latestReview = (i) => {
    let s = 0;
    for (let k = i - 1; k >= 0; k--) { const g = entryEdge(kind, all[k]); if (g && g.a === 'in-review' && g.b === 'executing') { s = k + 1; break; } }
    for (let k = i - 1; k >= s; k--) if (isReviewEntry(all[k])) return { e: all[k], i: k };
    return null;
  };
  const review = (i, verdict) => { const r = latestReview(i); return r && REVIEW_RE.exec(r.e.body)[1] === verdict ? r : null; };
  for (const x of edges) {
    const edge = `${x.a} → ${x.b}`;
    if (kind === 'lane' && x.a === 'executing' && x.b === 'in-review' && !PR_URL_RE.test(x.e.body)) errors.push(`${edge} has no PR URL (or owner/repo#N) in its entry`);
    if (kind === 'lane' && x.a === 'in-review' && (x.b === 'verified' || x.b === 'executing')) {
      const verdict = x.b === 'verified' ? 'accept' : 'changes';
      const r = review(x.i, verdict);
      if (!r) errors.push(`${edge} has no ${verdict} review entry (review: ${verdict}, head: <sha>) as the latest review since the last changes round`);
      else if (r.i >= prior.length) {
        const head = REVIEW_HEAD_RE.exec(r.e.body)[1];
        const header = `### ${r.e.time} · ${r.e.session} · ${r.e.change}`;
        if (!reviewCommits.some((c) => c.verdict === verdict && c.reviewedHead === head && typeof c.appended === 'string' && c.appended.includes(header))) {
          errors.push(`${edge}: the ${verdict} review entry for head ${head.slice(0, 8)} was added without its Collab-Review commit (Collab-Verdict: ${verdict}, Collab-Reviewed-Head: ${head.slice(0, 8)}…)`);
        }
      }
    }
    if (kind === 'lane' && x.a === 'verified' && x.b === 'done') {
      const verifiedEntry = [...all.slice(0, x.i)].reverse().find((e) => entryEdge(kind, e)?.b === 'verified');
      if (!MERGE_SHA_RE.test(x.e.body) && !(verifiedEntry && MERGE_SHA_RE.test(verifiedEntry.body))) errors.push(`${edge} has no merge sha (merge: <sha> or Merge \`<sha>\`) in its entry or the in-review → verified entry`);
    }
  }
  if (kind === 'plan' && after.state === 'done' && laneStates && laneStates.some((s) => s !== 'done')) errors.push('a plan chain may end "done" only when every lane is done');
  // Review entries written by a reviewer in this range survive to the head exactly once (review of #4416 on 8034e629):
  // a builder commit can neither delete a later `changes` entry nor copy an earlier accept back into the log.
  const reviewHeaders = new Map();
  for (const c of reviewCommits) {
    for (const h of logEntries(c.appended || '').filter(isReviewEntry).map((e) => `### ${e.time} · ${e.session} · ${e.change}`)) {
      reviewHeaders.set(h, (reviewHeaders.get(h) || 0) + 1);
    }
  }
  for (const [h, n] of reviewHeaders) {
    const seen = added.filter((e) => `### ${e.time} · ${e.session} · ${e.change}` === h).length;
    if (seen !== n) errors.push(`review entry "${h.slice(4)}" appears ${seen}× at the head but its review commit(s) appended it ${n}× (a builder may not remove or copy review entries)`);
  }
  return errors;
}

/**
 * VTID-05351 (review of #4416): the review-only commits of the range that may back a chain's review entry for lane
 * `key` (file `p`). A commit counts only when it carries `Collab-Review: <key>` and **no** `Collab-Lane`, changes `p`
 * without touching its front matter and only appends to its log, comes from an authorized reviewer (the lane's
 * trusted `reviewer_seat` rule, as scopeCheck applies it; with none set, a reviewer agent or a Claude Code session),
 * and its session wrote no `Collab-Lane` commit in the range (a builder never backs its own review). Returns
 * `[{ verdict, reviewedHead, appended }]`, `appended` = the log text the commit added.
 */
function reviewBacking(repo, commits, key, p, trustedFm) {
  const builders = new Set(commits.filter((k) => k.lane).map((k) => k.session));
  const fm = trustedFm || {};
  const out = [];
  for (const k of commits) {
    if (!(k.review || '').split(',').map((x) => x.trim()).includes(key) || k.lane) continue;
    if (!k.files.includes(p) || builders.has(k.session) || frontMatterChanged((rev, f) => showFile(repo, rev, f), k.sha, p)) continue;
    const authorized = fm.reviewer_seat === 'claude' ? /^session_/.test(k.session)
      : isReviewerAgent(fm.reviewer_seat) ? agentOf(k.session) === fm.reviewer_seat
        : fm.reviewer_seat ? seatOf(k.session) === fm.reviewer_seat
          : isReviewerAgent(agentOf(k.session)) || /^session_/.test(k.session);
    if (!authorized) continue;
    const a = logSection(showFile(repo, `${k.sha}^`, p));
    const b = logSection(showFile(repo, k.sha, p));
    if (!b.startsWith(a)) continue;
    out.push({ verdict: k.verdict, reviewedHead: k.reviewedHead, appended: b.slice(a.length) });
  }
  return out;
}

// ── Git helpers ─────────────────────────────────────────────────────────

/** Number of git processes this module has started (the queue's spawn budget is asserted against it in tests). */
export const gitSpawns = { count: 0 };

function spawnGit(repo, args, opts = {}) {
  gitSpawns.count++;
  return execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

function git(repo, args, opts = {}) {
  return spawnGit(repo, args, { encoding: 'utf8', ...opts }).trimEnd();
}

// Batch-style calls (cat-file --batch, rev-list, log) read far more than Node's 1 MB default; overflow (ENOBUFS) throws.
const BIG_BUFFER = 256 * 1024 * 1024;

/**
 * Read many objects (`<rev>:<path>`, a commit sha, …) through ONE `git cat-file --batch` process.
 * → Map<query, string|null>: the raw object text (UTF-8, untrimmed), or null when the object is missing or the query
 * cannot be sent (contains a line break). Replies arrive in query order and are parsed by byte length.
 */
export function catFileBatch(repo, queries) {
  const out = new Map();
  const send = [];
  for (const q of queries) {
    if (out.has(q)) continue;
    out.set(q, null);
    if (!/[\r\n]/.test(q)) send.push(q);
  }
  if (send.length === 0) return out;
  const buf = spawnGit(repo, ['cat-file', '--batch'], { input: `${send.join('\n')}\n`, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: BIG_BUFFER });
  let pos = 0;
  for (const q of send) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl < 0) throw new Error(`${repo}: git cat-file --batch: truncated reply`);
    const header = buf.toString('utf8', pos, nl);
    pos = nl + 1;
    const m = /^[0-9a-f]{40,64} \S+ (\d+)$/.exec(header); // otherwise "<query> missing" / "<query> ambiguous"
    if (!m) continue;
    const size = Number(m[1]); // bytes
    if (pos + size > buf.length) throw new Error(`${repo}: git cat-file --batch: short object for ${q}`);
    out.set(q, buf.toString('utf8', pos, pos + size));
    pos += size + 1; // the LF after the content
  }
  return out;
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

const CLAIM_REF = `refs/remotes/origin/${CLAIM_PREFIX}`;
const REFS_FMT = '%(refname)%09%(refname:short)%09%(objectname)%09%(committerdate:unix)';

/** for-each-ref output in REFS_FMT → [{ ref, short, sha, ts }] in for-each-ref order. */
function parseRefs(out) {
  return (out || '').split('\n').filter(Boolean).map((l) => {
    const [ref, short, sha, ts] = l.split('\t');
    return { ref, short, sha, ts: Number(ts) };
  });
}

/** Claim rows (refs under CLAIM_REF) + their commit objects from catFileBatch → claims. */
function claimsFrom(claimRows, objects) {
  return claimRows.map(({ ref, sha, ts }) => {
    const key = ref.slice(CLAIM_REF.length);
    const raw = objects.get(sha) ?? '';
    const i = raw.indexOf('\n\n');
    const msg = (i < 0 ? '' : raw.slice(i + 2)).trimEnd(); // a commit object's message follows the first blank line
    const session = (/^Collab-Session:\s*(\S+)/m.exec(msg) || [])[1] || null;
    const [slug, ...rest] = key.split('/');
    return { key, slug, lane: rest.join('/'), sha, session, at: ts * 1000 };
  });
}

/** Claims from remote-tracking refs (run `git fetch --prune origin` first). Two git processes at most. */
export function listClaims(repo) {
  const rows = parseRefs(gitOk(repo, ['for-each-ref', `--format=${REFS_FMT}`, CLAIM_REF]));
  return claimsFrom(rows, catFileBatch(repo, rows.map((r) => r.sha)));
}

// ── Queue ───────────────────────────────────────────────────────────────

const bytewise = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Newest version (by `updated`) of every handoff/lane file across main and recent branches.
 * A constant number of git processes per repo (≤ 6), whatever the number of branches, files or claims:
 * symbolic-ref, for-each-ref, ls-tree, rev-list, log, cat-file --batch.
 * A branch contributes a spec file it changed off main when the file is on main or the branch added it, so a file
 * deleted from main does not come back through a stale branch.
 */
export function collect(repo, { days = 30, now = Date.now() } = {}) {
  const sym = gitOk(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  const rows = parseRefs(gitOk(repo, ['for-each-ref', `--format=${REFS_FMT}`, 'refs/remotes/origin']));
  const main = sym || ['origin/main', 'origin/master'].find((b) => rows.some((r) => r.short === b)) || null;
  if (!main) throw new Error(`${repo}: no origin/main — run git fetch origin`);
  const mainRow = rows.find((r) => r.short === main);
  const mainSha = mainRow?.sha ?? main;
  const mainRef = mainRow?.ref ?? main;
  const mainPaths = specFilesAt(repo, mainSha);
  const onMain = new Set(mainPaths);

  const since = Math.floor((now - days * 86400000) / 1000);
  const recent = rows.filter((r) => r.short !== main && r.short !== 'origin/HEAD' && r.short !== 'origin'
    && !r.short.startsWith(`origin/${CLAIM_PREFIX}`) && r.ts >= since);
  const claimRows = rows.filter((r) => r.ref.startsWith(CLAIM_REF));

  const branchPairs = [];
  if (recent.length) {
    const opts = { input: `${[...recent.map((r) => r.ref), `^${mainRef}`].join('\n')}\n`, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: BIG_BUFFER };
    // Every commit on a recent branch and not on main, with its parents.
    const graph = new Map();
    for (const line of git(repo, ['rev-list', '--parents', '--stdin'], opts).split('\n')) {
      if (!line) continue;
      const [sha, ...parents] = line.split(' ');
      graph.set(sha, parents);
    }
    // The handoff/lane files each of those commits touched. `--cc` keeps a merge commit's own conflict resolutions
    // (a combined status has one letter per parent; a file a merge took unchanged from one parent is not listed).
    const touchedBy = new Map();
    const log = git(repo, ['log', '--stdin', '--full-history', '--cc', '--no-renames', '--no-color',
      '--format=%x00%H', '--name-status', '--', '.kiro/specs'], opts);
    for (const chunk of log.split('\0').slice(1)) {
      const [sha, ...lines] = chunk.split('\n');
      const files = [];
      for (const l of lines) {
        const m = /^([A-Z]+)\d*\t/.exec(l);
        const p = m && l.slice(l.lastIndexOf('\t') + 1); // the path is the last tab field
        if (p && classifyPath(p)) files.push({ status: m[1], path: p });
      }
      touchedBy.set(sha.trim(), files);
    }
    for (const r of recent) {
      const touched = new Map(); // path → added on this branch
      const seen = new Set();
      const stack = [r.sha];
      while (stack.length) {
        const c = stack.pop();
        if (seen.has(c) || !graph.has(c)) continue; // on main (or the boundary)
        seen.add(c);
        for (const { status, path: p } of touchedBy.get(c) || []) touched.set(p, touched.get(p) || status.includes('A'));
        stack.push(...graph.get(c));
      }
      const paths = [...touched].filter(([p, added]) => onMain.has(p) || added).map(([p]) => p).sort(bytewise);
      if (paths.length) branchPairs.push({ ref: r.short, sha: r.sha, paths });
    }
  }

  const objects = catFileBatch(repo, [
    ...mainPaths.map((p) => `${mainSha}:${p}`),
    ...branchPairs.flatMap(({ sha, paths }) => paths.map((p) => `${sha}:${p}`)),
    ...claimRows.map((r) => r.sha),
  ]);
  const best = new Map();
  const consider = (ref, query, p) => {
    const raw = objects.get(query);
    if (raw === null || raw === undefined) return;
    const text = raw.trimEnd();
    const fm = parseFrontMatter(text);
    const prev = best.get(p);
    if (!prev || (fm?.updated || '') > (prev.fm?.updated || '')) best.set(p, { path: p, ref, fm, text, ...classifyPath(p) });
  };
  for (const p of mainPaths) consider(main, `${mainSha}:${p}`, p);
  for (const { ref, sha, paths } of branchPairs) for (const p of paths) consider(ref, `${sha}:${p}`, p);
  return { main, files: [...best.values()], claims: claimsFrom(claimRows, objects) };
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

/**
 * Non-merge commits in `base..head` (git log order) with their trailers and changed files. VTID-05365: one `git log
 * --name-only` for the whole range (it used to be one `git diff-tree` per commit); `--no-renames` keeps `files` equal
 * to `diff-tree --no-commit-id --name-only -r <sha>`. Each record starts with \x1e: the header line, then its files.
 */
export function commitsInRange(repo, base, head) {
  // VTID-05276 (plan §4.1): review entries also carry Collab-Verdict, Collab-Reviewer and Collab-Reviewed-Head.
  const keys = ['Collab-Session', 'Collab-Lane', 'Collab-Review', 'Collab-Verdict', 'Collab-Reviewer', 'Collab-Reviewed-Head'];
  const fmt = `%x1e%H${keys.map((k) => `%x1f%(trailers:key=${k},valueonly,separator=%x2c)`).join('')}`;
  const out = git(repo, ['log', '--no-merges', '--no-renames', '--name-only', `--format=${fmt}`, `${base}..${head}`], { maxBuffer: BIG_BUFFER });
  return out.split('\x1e').slice(1).map((rec) => {
    const [header, ...files] = rec.split('\n');
    const [sha, session, lane, review, verdict, reviewer, reviewedHead] = header.split('\x1f').map((s) => (s || '').trim());
    return { sha, session, lane, review, verdict, reviewer, reviewedHead, files: files.filter(Boolean) };
  });
}

// VTID-05365: up to this many object bytes are read into memory; more (a PR with thousands of lane-file commits) go
// through a temporary file and are read one object at a time.
const READ_IN_MEMORY_MAX = 64 * 1024 * 1024;

/**
 * VTID-05365: file reads at many commits through two git processes, whatever the number of commits.
 * `needs` = [{ sha, path }]: `<sha>^:<path>` and `<sha>:<path>` are resolved with one `git cat-file --batch-check` and
 * the distinct blobs are read with one `git cat-file --batch`. → { read(rev, path), close() }: `read` returns the text
 * `trimEnd()`ed, or null when the object is missing — the same as `showFile`. A query that is not a blob (or cannot be
 * sent) falls back to `showFile`. Call `close()` when done (it removes the temporary file, if any).
 */
export function commitFileReader(repo, needs, { inMemoryMax = READ_IN_MEMORY_MAX } = {}) {
  const queries = [...new Set(needs.flatMap(({ sha, path: p }) => [`${sha}^:${p}`, `${sha}:${p}`]))];
  const where = new Map(); // query → oid | null (missing) ; absent → showFile
  const blobs = new Map(); // oid → { size, at }
  const send = queries.filter((q) => !/[\r\n]/.test(q));
  if (send.length) {
    const lines = git(repo, ['cat-file', '--batch-check'], { input: `${send.join('\n')}\n`, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: BIG_BUFFER }).split('\n');
    send.forEach((q, i) => {
      const m = /^([0-9a-f]{40,64}) (\S+) (\d+)$/.exec(lines[i] || '');
      if (!m) { where.set(q, null); return; } // "<query> missing" / "ambiguous"
      if (m[2] !== 'blob') return;
      where.set(q, m[1]);
      if (!blobs.has(m[1])) blobs.set(m[1], { size: Number(m[3]), at: 0 });
    });
  }
  let total = 0;
  for (const [oid, b] of blobs) { // `--batch` reply: "<oid> blob <size>\n<content>\n" per object, in request order
    total += Buffer.byteLength(`${oid} blob ${b.size}\n`);
    b.at = total;
    total += b.size + 1;
  }
  let buf = null;
  let fd = null;
  let dir = null;
  if (blobs.size) {
    const opts = { input: `${[...blobs.keys()].join('\n')}\n`, maxBuffer: BIG_BUFFER };
    if (total <= inMemoryMax) buf = spawnGit(repo, ['cat-file', '--batch'], { ...opts, stdio: ['pipe', 'pipe', 'pipe'] });
    else {
      dir = mkdtempSync(path.join(tmpdir(), 'collab-reads-'));
      fd = openSync(path.join(dir, 'objects'), 'w+');
      spawnGit(repo, ['cat-file', '--batch'], { ...opts, stdio: ['pipe', fd, 'pipe'] });
    }
  }
  const bytes = (at, size) => {
    if (buf) return buf.subarray(at, at + size);
    const out = Buffer.alloc(size);
    let n = 0;
    while (n < size) { const r = readSync(fd, out, n, size - n, at + n); if (r === 0) break; n += r; }
    return out.subarray(0, n);
  };
  const close = () => {
    if (fd !== null) { closeSync(fd); fd = null; }
    if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null; }
  };
  const read = (rev, p) => {
    const q = `${rev}:${p}`;
    if (!where.has(q)) return showFile(repo, rev, p);
    const oid = where.get(q);
    if (oid === null) return null;
    const { size, at } = blobs.get(oid);
    const header = `${oid} blob ${size}\n`;
    const hlen = Buffer.byteLength(header);
    if (bytes(at - hlen, hlen).toString('latin1') !== header) { close(); throw new Error(`${repo}: git cat-file --batch: unexpected reply for ${q}`); }
    return bytes(at, size).toString('utf8').trimEnd();
  };
  return { read, close };
}

// VTID-05276 (plan §4.5): a `pm-agent` commit may change only these lane keys and append a log entry.
const PM_AGENT_KEYS = ['state', 'parked_from', 'next_actor', 'seat', 'claimed_by', 'updated'];
const FRONT_MATTER_RE = /^---\r?\n[\s\S]*?\r?\n---/;
/**
 * What a pm-agent commit changed in lane file `p` beyond its allowance ([] = only allowed keys + appended log).
 * `read(rev, path)` is a commitFileReader's `read` (VTID-05365).
 */
function pmAgentOverreach(read, sha, p) {
  const a = read(`${sha}^`, p);
  const b = read(sha, p);
  if (a === null || b === null) return [a === null ? 'created the lane file' : 'deleted the lane file'];
  const fa = parseFrontMatter(a) || {};
  const fb = parseFrontMatter(b) || {};
  const out = [...new Set([...Object.keys(fa), ...Object.keys(fb)])]
    .filter((k) => !PM_AGENT_KEYS.includes(k) && JSON.stringify(fa[k]) !== JSON.stringify(fb[k])).map((k) => `changed ${k}`);
  const body = (t) => t.replace(FRONT_MATTER_RE, '').replace(/\r\n/g, '\n');
  if (!body(b).startsWith(body(a))) out.push('rewrote the log (only appending an entry is allowed)');
  return out;
}
const pmAgentMessage = (short, p, bad) => `${short}: pm-agent may only change ${PM_AGENT_KEYS.join(', ')} and append a log entry in ${p} (${bad.join('; ')})`;

/** Front matter (the text between the first two `---` lines) changed by this commit? */
function frontMatterChanged(read, sha, p) {
  const a = read(`${sha}^`, p);
  const b = read(sha, p);
  const fm = (t) => (/^---\r?\n([\s\S]*?)\r?\n---/.exec(t || '') || [])[1] ?? null;
  return fm(a) !== fm(b);
}

export function validateRange(repo, { base, head, branch = '', allowInitial = [], fetchLane = null, fetchPlanLane = null }) {
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
    const single = checkTransition(c.kind, before, after, { allowInitial: allowInitial.includes(c.slug) });
    // VTID-05351: a state change one edge cannot make may be a chain of legal edges, each with its own log entry.
    // Two or more logged edges → the chain decides; otherwise the single-edge result stands unchanged.
    const beforeText = before && after && before.state !== after.state ? showFile(repo, mergeBase, p) : null;
    const afterText = beforeText ? showFile(repo, head, p) : null;
    const loggedEdges = beforeText && afterText && logSection(afterText).startsWith(logSection(beforeText))
      ? logEntries(logSection(afterText).slice(logSection(beforeText).length)).filter((e) => entryEdge(c.kind, e)).length
      : beforeText ? 2 : 0; // a rewritten log under a multi-state change is judged (and refused) by the chain
    if (single.length && loggedEdges >= 2) {
      const key = `${c.slug}/${c.lane}`;
      const reviewCommits = reviewBacking(repo, commits, key, p, parseFrontMatter(showFile(repo, mergeBase, p)));
      const laneStates = c.kind === 'plan'
        ? specFilesAt(repo, head).filter((f) => classifyPath(f)?.slug === c.slug && classifyPath(f).kind === 'lane')
          .map((f) => parseFrontMatter(showFile(repo, head, f))?.state)
        : null;
      for (const x of transitionChain(c.kind, beforeText, afterText, { reviewCommits, laneStates })) errors.push(`${p}: ${x}`);
      continue;
    }
    for (const x of single) errors.push(`${p}: ${x}`);
  }

  const laneTrailers = new Set(commits.map((k) => k.lane).filter(Boolean).flatMap((l) => l.split(',').map((s) => s.trim())));
  const workLanes = [...laneTrailers].filter((l) => !l.endsWith(`/${PLAN_LANE}`));
  if (workLanes.length > 1) errors.push(`one PR per lane: commits name ${workLanes.length} lanes (${workLanes.join(', ')})`);
  const sessionsByLane = new Map();
  // VTID-05365: every lane-file read the loop below may make, in one batch (pm-agent commits, and any commit that
  // changes a lane file other than its own Collab-Lane's).
  const reader = commitFileReader(repo, commits.flatMap((k) => k.files.map((f) => ({ f, c: classifyPath(f) }))
    .filter(({ c }) => c && c.kind === 'lane' && (k.session === PM_AGENT || k.lane !== `${c.slug}/${c.lane}`))
    .map(({ f }) => ({ sha: k.sha, path: f }))));
  const read = reader.read;
  try {
  for (const k of commits) {
    const short = k.sha.slice(0, 8);
    if (laneTrailers.size && (!k.session || !k.lane) && !k.review) errors.push(`${short}: a lane PR needs Collab-Session and Collab-Lane trailers on every commit`);
    if (k.session && !SESSION_RE.test(k.session)) errors.push(`${short}: Collab-Session "${k.session}" is not a session id`);
    // VTID-05276 (plan §4.5): the Project Manager's lane-state commits do not count for one-session-per-lane or claimed_by.
    // VTID-05365 (R1): PLAN-SPAR's own `_plan` commits are CI, not a second session; their writes are checked per file below.
    const isCiPlanCommit = k.session === CI_PLAN_SPAR && !!k.lane && k.lane.split(',').every((l) => l.trim().endsWith(`/${PLAN_LANE}`));
    if (k.lane && k.session !== PM_AGENT && !isCiPlanCommit) {
      if (!sessionsByLane.has(k.lane)) sessionsByLane.set(k.lane, new Set());
      sessionsByLane.get(k.lane).add(k.session);
    }
    for (const f of k.files) {
      const c = classifyPath(f);
      if (!c) continue;
      const key = `${c.slug}/${c.lane}`;
      // VTID-05276 (plan §4.5): pm-agent W1 (Collab-Lane: the lane) and W2 (Collab-Lane: `_plan`) lane-state commits.
      if (c.kind === 'lane' && k.session === PM_AGENT && (k.lane === key || k.lane === `${c.slug}/${PLAN_LANE}`)) {
        const bad = pmAgentOverreach(read, k.sha, f);
        if (bad.length) errors.push(pmAgentMessage(short, f, bad));
        continue;
      }
      if (k.lane === key) continue;
      // The coordinator declares the lanes: a `_plan` commit may create a lane file, never edit one.
      if (c.kind === 'lane' && k.lane === `${c.slug}/${PLAN_LANE}` && read(`${k.sha}^`, f) === null) continue;
      // VTID-05214: PLAN-SPAR.yml writes the allocated VTID into a lane that is still `ready`.
      if (c.kind === 'lane' && k.session === CI_PLAN_SPAR && k.lane === `${c.slug}/${PLAN_LANE}`
        && parseFrontMatter(read(k.sha, f))?.state === 'ready') continue;
      if (c.kind === 'lane' && k.review === key && !frontMatterChanged(read, k.sha, f)) continue; // reviewer appends a log entry
      // VTID-05408 (kiro-lane-admin §1a): a reviewed, trusted lane-admin lane may edit a target lane file it
      // administers, even though that file's own key differs from the commit's Collab-Lane. Gated identically to the
      // scopeCheck carve-out (shared laneAdminCovers, trusted source resolved via fetchPlanLane symmetrically with
      // scopeCheck — never the PR head), so it cannot be self-granted.
      if (c.kind === 'lane' && k.lane && k.lane !== key && laneAdminCovers(repo, base, head, k.lane, f, fetchPlanLane, fetchLane)) continue;
      errors.push(`${short}: changes ${f} but its Collab-Lane is "${k.lane || 'none'}" (needs "${key}"${c.kind === 'lane' ? `, or Collab-Review: ${key} with the front matter unchanged` : ''})`);
    }
  }
  } finally { reader.close(); }
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
export function scopeCheck(repo, { base, head, branch = '', fetchLane = null, fetchPlanLane = null }) {
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
  // VTID-05276: lane file source order — the lane PR head, then the open `plan(<slug>)` PR (fetchPlanLane), then the
  // other repo's main (fetchLane).
  let text = showFile(repo, head, lanePath);
  let source = 'this repo';
  let plan;
  const planLaneOnce = () => {
    if (plan === undefined) plan = fetchPlanLane ? (fetchPlanLane(slug, lanePath) || null) : null;
    return plan;
  };
  if (text === null && planLaneOnce()?.text) { text = plan.text; source = 'plan-pr'; }
  if (text === null && fetchLane) { text = fetchLane(lanePath); source = 'vitana-platform'; }
  if (text === null || text === undefined) {
    errors.push(`lane ${key}: ${lanePath} not found in this repo${fetchPlanLane ? ', an open plan( PR' : ''} or vitana-platform`);
    return { applies: true, errors, warnings, lane: key };
  }
  let fm = parseFrontMatter(text) || {};
  // The lane's permissions are the trusted revision's (VTID-05213 review): a lane PR must not widen its own `paths`,
  // `executor`, `seat` or `reviewer_seat`. Only a Claude Code session (session_…) may change them, and only on a lane
  // that already was `executor: claude`. VTID-05276: trusted = the merge-base, else a qualifying open plan( PR (its
  // ci-plan-spar revision), else the other repo's main — whatever the lane text's source. A lane file that exists only
  // in the lane PR head is untrusted: Lane scope judges it as before but grants no governance exemption.
  const mergeBase = gitOk(repo, ['merge-base', base, head]);
  let trustedFm = mergeBase ? parseFrontMatter(showFile(repo, mergeBase, lanePath)) : null;
  let trustedFrom = trustedFm ? 'merge-base' : null;
  if (!trustedFm && planLaneQualifies(planLaneOnce())) { trustedFm = parseFrontMatter(plan.text); trustedFrom = trustedFm ? 'plan-pr' : null; }
  if (!trustedFm && fetchLane) {
    trustedFm = parseFrontMatter(source === 'vitana-platform' ? text : fetchLane(lanePath));
    trustedFrom = trustedFm ? 'vitana-platform' : null;
  }
  // The Project Manager's lane-state commits (plan §4.5) are checked on their own and never decide who edited the lane.
  const pmCommits = commits.filter((k) => k.session === PM_AGENT && k.files.includes(lanePath));
  const reader = commitFileReader(repo, pmCommits.map((k) => ({ sha: k.sha, path: lanePath }))); // VTID-05365: one batch
  try {
    for (const k of pmCommits) {
      const bad = pmAgentOverreach(reader.read, k.sha, lanePath);
      if (bad.length) errors.push(pmAgentMessage(k.sha.slice(0, 8), lanePath, bad));
    }
  } finally { reader.close(); }
  if (trustedFm) {
    const PERM = ['executor', 'seat', 'reviewer_seat', 'paths'];
    // VTID-05408 (kiro-lane-admin §2): `lane_admin` is NOT a permission field but is pinned to the trusted revision
    // alongside PERM, so a lane PR can never self-grant it (T-D) and a head-written value cannot leak downstream.
    const TRUSTED_PINNED = [...PERM, 'lane_admin'];
    const changed = PERM.filter((k) => JSON.stringify(asList(trustedFm[k])) !== JSON.stringify(asList(fm[k])));
    const sessions = new Set(commits.filter((k) => k.files.includes(lanePath) && k.session !== PM_AGENT).map((k) => k.session));
    const claudeOnly = sessions.size > 0 && [...sessions].every((x) => /^session_/.test(x));
    // VTID-05408 (kiro-lane-admin §2): TARGET-ONLY PERM carve-out. A reviewed, trusted lane-admin lane (its OWN
    // qualification read from the trusted revision via toBool — never the head, R2-F1) may change a target lane's PERM
    // fields. scopeCheck keys on one lane per PR, so `lanePath` is the admin lane's OWN file; a lane never administers
    // its own file (laneAdminCovers tests `matchesAny(lanePath, trusted paths)`, and the admin lane's paths list the
    // TARGET files, not itself), so `targetOfAdmin` is false for the admin lane's own PERM fields — the admin lane can
    // never self-widen (T-I). The target lane file's own change passes the paths check below and the §1a validateRange
    // exemption; its new seat/paths are the reviewed, audited reassignment outcome.
    const selfTrustedLaneAdmin = trustedFm.executor === 'kiro' && isReviewerAgent(trustedFm.reviewer_seat)
      && toBool(trustedFm.lane_admin) && !!trustedFrom;
    const targetOfAdmin = selfTrustedLaneAdmin && laneAdminCovers(repo, base, head, key, lanePath, fetchPlanLane, fetchLane);
    const permAllowed = (trustedFm.executor === 'claude' && claudeOnly) || targetOfAdmin;
    if (changed.length && !permAllowed) {
      errors.push(`lane ${key}: ${changed.join(', ')} changed in a lane PR — lane permissions come from the base revision (reassign a target lane through an executor: kiro, reviewer_seat: ${REVIEWER_AGENTS[0]} lane with lane_admin: true from a trusted source whose paths cover it, or change an executor: claude Claude Code lane)`);
    }
    if (!permAllowed) fm = { ...fm, ...Object.fromEntries(TRUSTED_PINNED.map((k) => [k, trustedFm[k]])) };
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
      else if (fm.executor === 'claude') continue;
      // VTID-05276 (plan §4.3): a protected gate file never passes for a non-claude lane, whatever its reviewer.
      else if (matchesAny(f, PROTECTED_GATE_PATHS)) errors.push(`${f} is a protected gate file (governance path, scripts/collab/protected-gate-files.json); lane ${key} has executor ${fm.executor || 'unset'} — a reviewer-agent accept alone never unlocks it (the owner's instruction naming the plan is the authority; Claude Code is retired)`);
      else if (!matchesAny(f, GOVERNANCE_PATHS)) continue;
      else if (fm.executor === 'kiro' && isReviewerAgent(fm.reviewer_seat) && trustedFrom) continue;
      else errors.push(`${f} is a governance path; lane ${key} has executor ${fm.executor || 'unset'} (needs executor kiro with reviewer_seat ${REVIEWER_AGENTS[0]} from main or an approved plan( PR — or a legacy executor claude lane)`);
    }
  }
  for (const k of commits) {
    if (!k.files.includes(lanePath) || k.session === PM_AGENT) continue;
    const short = k.sha.slice(0, 8);
    const seat = seatOf(k.session);
    if (k.review === key && k.lane !== key) {
      const ok = fm.reviewer_seat === 'claude' ? /^session_/.test(k.session)
        : isReviewerAgent(fm.reviewer_seat) ? agentOf(k.session) === fm.reviewer_seat
          : !fm.reviewer_seat || seat === fm.reviewer_seat;
      if (!ok) errors.push(`${short}: review entry on ${key} from ${k.session || 'no session'}, but reviewer_seat is ${fm.reviewer_seat}`);
    } else if (fm.seat && seat && seat !== fm.seat) {
      errors.push(`${short}: ${k.session} (seat ${seat}) edits lane ${key}, which belongs to seat ${fm.seat}`);
    } else if (fm.seat && /^kiro-\d{12}-/.test(k.session)) {
      warnings.push(`${short}: ${k.session} names no seat; lane ${key} belongs to seat ${fm.seat}`);
    }
  }
  return { applies: true, errors, warnings, lane: key, source, trusted: trustedFrom, paths };
}

/**
 * VTID-05276: does a plan-PR lane read (`fetchPlanLane` result) come from an approved plan? handoff.md at the plan
 * PR head is `approved|executing` with a `sparring_record`, the lane's `vtid` is one of its `vtids`, and the lane text
 * was read at a ci-plan-spar commit (PLAN-SPAR writes the VTID into every approved lane).
 */
export function planLaneQualifies(planLane) {
  if (!planLane || !planLane.text || !planLane.handoffText) return false;
  const h = parseFrontMatter(planLane.handoffText);
  const l = parseFrontMatter(planLane.text);
  return !!h && !!l && ['approved', 'executing'].includes(h.state) && !!h.sparring_record && !!l.vtid
    && asList(h.vtids).includes(l.vtid) && planLane.lastSession === CI_PLAN_SPAR;
}

/**
 * VTID-05408 (kiro-lane-admin §1a/§2): the TRUSTED front matter of a lane, resolved through the SAME source chain
 * scopeCheck uses (merge-base, else a qualifying open `plan(` PR via `fetchPlanLane`, else the other repo's main via
 * `fetchLane`) — never the PR head. Returns `{ fm, from }` or `{ fm: null, from: null }`. Keeping this symmetric with
 * scopeCheck is what lets a lane-admin lane created inside a `plan(` PR be recognised by Collab handoff and Lane scope
 * alike (R2-F2); fetchPlanLane threading in validateRange is the other half.
 */
export function fetchTrustedLaneFm(repo, { base, head, laneSlug, laneFile, fetchLane = null, fetchPlanLane = null }) {
  const mergeBase = gitOk(repo, ['merge-base', base, head]);
  let fm = mergeBase ? parseFrontMatter(showFile(repo, mergeBase, laneFile)) : null;
  if (fm) return { fm, from: 'merge-base' };
  const plan = fetchPlanLane ? (fetchPlanLane(laneSlug, laneFile) || null) : null;
  if (planLaneQualifies(plan)) { fm = parseFrontMatter(plan.text); if (fm) return { fm, from: 'plan-pr' }; }
  if (fetchLane) { fm = parseFrontMatter(fetchLane(laneFile)); if (fm) return { fm, from: 'vitana-platform' }; }
  return { fm: null, from: null };
}

/**
 * VTID-05408 (kiro-lane-admin §1a/§2): is `adminLaneKey` (`<slug>/<id>`) a reviewed, trusted lane-administration lane
 * whose authority covers `targetLaneFile`? True only when the admin lane's TRUSTED front matter (never the PR head)
 * has `toBool(lane_admin)` + `executor: kiro` + `reviewer_seat: agent:vitana-lane-reviewer`, and `targetLaneFile`
 * matches one of that trusted admin lane's `paths` globs. One source of truth for both the validateRange cross-lane-file
 * exemption (§1a) and the scopeCheck target-only PERM carve-out (§2). Reading the admin lane's qualification from the
 * trusted revision is what stops a PR self-granting `lane_admin: true` in its own head.
 */
export function laneAdminCovers(repo, base, head, adminLaneKey, targetLaneFile, fetchPlanLane = null, fetchLane = null) {
  const [laneSlug, laneId] = String(adminLaneKey).split('/');
  if (!laneSlug || !laneId || laneId === PLAN_LANE) return false;
  const adminFile = `.kiro/specs/${laneSlug}/lanes/${laneId}.md`;
  const { fm } = fetchTrustedLaneFm(repo, { base, head, laneSlug, laneFile: adminFile, fetchLane, fetchPlanLane });
  if (!fm) return false;
  if (!(toBool(fm.lane_admin) && fm.executor === 'kiro' && isReviewerAgent(fm.reviewer_seat))) return false;
  return matchesAny(targetLaneFile, asList(fm.paths));
}

/** VTID-05276: the single open same-repo PR titled `plan(<slug>)…` in `gh pr list` JSON; none or several → null. */
export function findPlanPr(prs, slug) {
  const hits = (Array.isArray(prs) ? prs : []).filter((p) => p && !p.isCrossRepository && typeof p.title === 'string'
    && p.title.startsWith(`plan(${slug})`));
  return hits.length === 1 ? hits[0] : null;
}

const ghRun = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * VTID-05276: `fetchPlanLane(slug, lanePath)` over the GitHub CLI for `repoSlug` → `{ text, handoffText, lastSession,
 * pr, sha }`: the lane file at the newest commit on the plan PR head that touched it with `Collab-Session: ci-plan-spar`
 * (later edits ignored; without one, the newest commit, which never qualifies) and handoff.md at the PR head. Any gh
 * or parse failure → null (fail closed: no plan-PR source, no exemption).
 */
export function ghPlanLaneFetcher(repoSlug, run = ghRun) {
  return (slug, lanePath) => {
    try {
      const prs = JSON.parse(run(['pr', 'list', '--repo', repoSlug, '--state', 'open', '--search', `plan(${slug}) in:title`,
        '--json', 'number,title,headRefOid,isCrossRepository', '--limit', '20']));
      const pr = findPlanPr(prs, slug);
      if (!pr || !/^[0-9a-f]{40}$/.test(pr.headRefOid || '')) return null;
      const raw = (p, ref) => run(['api', '-H', 'Accept: application/vnd.github.raw', `repos/${repoSlug}/contents/${p}?ref=${ref}`]);
      const commits = JSON.parse(run(['api', `repos/${repoSlug}/commits?sha=${pr.headRefOid}&path=${lanePath}&per_page=50`]));
      if (!Array.isArray(commits) || commits.length === 0) return null;
      const sessionOf = (c) => (/^Collab-Session:\s*(\S+)/m.exec(c?.commit?.message || '') || [])[1] || '';
      const at = commits.find((c) => sessionOf(c) === CI_PLAN_SPAR) || commits[0];
      if (!/^[0-9a-f]{40}$/.test(at?.sha || '')) return null;
      const handoffText = raw(`.kiro/specs/${slug}/handoff.md`, pr.headRefOid);
      const text = raw(lanePath, at.sha);
      return { text, handoffText, lastSession: sessionOf(at), pr: pr.number, sha: at.sha };
    } catch { return null; }
  };
}

/** Read a file of exafyltd/vitana-platform (or `repoSlug`) on main through the GitHub CLI; null when unavailable. */
export function ghFetcher(repoSlug = 'exafyltd/vitana-platform') {
  return (p) => {
    try {
      return execFileSync('gh', ['api', '-H', 'Accept: application/vnd.github.raw', `repos/${repoSlug}/contents/${p}?ref=main`],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { return null; }
  };
}

// ── Programme registry (VTID-05213; content: VTID-05215) ─────────────────

/** docs/programs/<id>/program.md files at `ref` → [{id, fm}] (front matter: id, title, status, priority, specs, ...). */
export function loadPrograms(repo, ref) {
  const out = gitOk(repo, ['ls-tree', '-r', '--name-only', ref, '--', 'docs/programs']);
  if (!out) return [];
  const found = out.split('\n').map((p) => /^docs\/programs\/([^/]+)\/program\.md$/.exec(p)).filter(Boolean);
  const objects = catFileBatch(repo, found.map((m) => `${ref}:${m[0]}`)); // one process for every program.md
  return found.map((m) => {
    const raw = objects.get(`${ref}:${m[0]}`);
    return { id: m[1], path: m[0], fm: parseFrontMatter(raw === null || raw === undefined ? null : raw.trimEnd()) };
  });
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
    if (fm.reviewer_seat && fm.reviewer_seat !== 'claude' && !isReviewerAgent(fm.reviewer_seat) && !seats.has(fm.reviewer_seat)) e.push(`${p}: reviewer_seat "${fm.reviewer_seat}" is not a seat of docs/programs/areas.yaml`);
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
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}${p(now.getUTCHours())}${p(now.getUTCMinutes())}`;
  // VTID-05276: a reviewer agent mints its own id per review (agent-<name>-YYYYMMDDHHMM-xxxx); it has no seat.
  if (isReviewerAgent(agent)) {
    if (seat) throw new Usage('a reviewer agent id names no seat');
    return `agent-${agent.slice('agent:'.length)}-${stamp}-${randomBytes(2).toString('hex')}`;
  }
  if (agent !== 'kiro') throw new Usage(`only Kiro sessions and reviewer agents (${REVIEWER_AGENTS.join(', ')}) generate an id; a Claude cloud session uses its session_… id`);
  if (seat && !SEAT_RE.test(seat)) throw new Usage(`--seat "${seat}" must be 1-12 lowercase letters`);
  return `kiro-${seat ? `${seat}-` : ''}${stamp}-${randomBytes(2).toString('hex')}`;
}

// ── CLI ─────────────────────────────────────────────────────────────────

class Usage extends Error {}

/** VTID-05365: one GitHub annotation line (`::error::<title>: <message>`); %, CR and LF escaped as GitHub requires. */
export const annotation = (level, title, message) => `::${level}::${title}: ${String(message)
  .replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`;

/** VTID-05365: with --summary, also write each problem and warning as an annotation, then the status line, to stderr. */
function reportToLog(title, status, r) {
  for (const e of r.errors) console.error(annotation('error', title, e));
  for (const w of r.warnings) console.error(annotation('warning', title, w));
  console.error(status.split('\n')[0]);
}

function parseArgs(argv) {
  const out = { _: [], repo: [], allowInitial: [], planRepo: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = /^--([\w-]+)=(.*)$/.exec(a);
    const [k, v] = eq ? [eq[1], eq[2]] : a.startsWith('--') ? [a.slice(2), undefined] : [null, a];
    if (k === null) { out._.push(v); continue; }
    const flag = ['json', 'stale'].includes(k);
    const val = flag ? true : v ?? argv[++i];
    if (k === 'repo') out.repo.push(val);
    else if (k === 'allow-initial') out.allowInitial.push(val);
    else if (k === 'plan-repo') out.planRepo.push(val);
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
    // VTID-05408: lane files of an open plan( PR — --plan-repo (repeatable), else $GITHUB_REPOSITORY, then --lane-repo.
    // Threaded into validateRange so laneAdminCovers (§1a) resolves the admin lane's trusted source symmetrically with
    // scope-check (R2-F2).
    const planRepos = [...new Set((args.planRepo.length ? args.planRepo : [process.env.GITHUB_REPOSITORY, args['lane-repo']]).filter(Boolean))];
    const planFetchers = planRepos.map((r) => ghPlanLaneFetcher(r));
    const fetchPlanLane = planFetchers.length ? (slug, p) => { for (const f of planFetchers) { const x = f(slug, p); if (x) return x; } return null; } : null;
    const r = validateRange(repo, { base: args.base, head: args.head, branch: args.branch || '', allowInitial,
      fetchPlanLane, fetchLane: args['lane-repo'] ? ghFetcher(args['lane-repo']) : null });
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
    if (args.summary) {
      appendFileSync(args.summary, out);
      reportToLog('collab handoff', status, r); // VTID-05365: the job log says why, not only "exit code 1"
    } else console.log(out);
    return r.errors.length ? 1 : 0;
  }
  if (cmd === 'scope-check') {
    if (!args.base || !args.head) throw new Usage('scope-check needs --base <sha> --head <sha>');
    // VTID-05276: lane files of an open plan( PR — --plan-repo (repeatable), else $GITHUB_REPOSITORY, then --lane-repo.
    const planRepos = [...new Set((args.planRepo.length ? args.planRepo : [process.env.GITHUB_REPOSITORY, args['lane-repo']]).filter(Boolean))];
    const planFetchers = planRepos.map((r) => ghPlanLaneFetcher(r));
    const fetchPlanLane = planFetchers.length ? (slug, p) => { for (const f of planFetchers) { const x = f(slug, p); if (x) return x; } return null; } : null;
    const r = scopeCheck(repo, { base: args.base, head: args.head, branch: args.branch || '', fetchPlanLane,
      fetchLane: args['lane-repo'] ? ghFetcher(args['lane-repo']) : null });
    const status = !r.applies ? '➖ **lane scope** — not a lane PR'
      : r.errors.length ? `❌ **lane scope** — ${r.errors.length} problem(s)${r.lane ? ` (lane ${r.lane})` : ''}:\n${r.errors.map((e) => `- ${e}`).join('\n')}`
        : `✅ **lane scope** — lane ${r.lane}: every change is inside its paths`;
    const warn = r.warnings.length ? `\n\n⚠️ ${r.warnings.join('\n⚠️ ')}` : '';
    if (args.summary) {
      appendFileSync(args.summary, `${status}${warn}\n`);
      reportToLog('lane scope', status, r);
    } else console.log(`${status}${warn}`);
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
