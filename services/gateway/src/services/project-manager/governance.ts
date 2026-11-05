/**
 * VTID-05274 — Project Manager: the governance guard (plan kiro-autonomy-fallback §4.1, §4.3, §5 C1).
 *
 * PROTECTED GATE FILE. This file is itself on the protected list below, so a
 * change to it never merges on a reviewer-agent accept alone: it needs the
 * owner's instruction naming the plan plus a reviewer-agent accept on the
 * current head (Claude Code is retired, VTID-05408).
 *
 * The one place that decides whether a review entry lets a lane PR merge:
 *   - an `accept` by the reviewer agent `agent:vitana-lane-reviewer
 *     (<model>)`, <model> in REVIEWER_AGENT_MODELS, on the PR's current head
 *     satisfies any lane;
 *   - a legacy seat `approve` keeps today's rule (reviewer_seat match, exact
 *     head; a governance lane additionally needs `reviewer_seat: claude`);
 *   - a PR that changes a protected gate file is ALWAYS refused in code
 *     (`protected_gate_file`): no review ever unlocks it programmatically; the
 *     owner's instruction naming the plan is the out-of-band authority, recorded
 *     in the lane log (VTID-05408 §5). Defense-in-depth with queue.mjs
 *     scope-check, which refuses the same files independently.
 *
 * `PROTECTED_GATE_GLOBS` is a compiled-in constant literal (= plan §4.3). The
 * runtime never reads scripts/collab/protected-gate-files.json, so a missing or
 * empty JSON can never empty the list; only the parity test reads that file.
 *
 * Pure: no I/O. Type-only imports from ./types (no runtime cycle).
 */
import type { ObservedLane, ObservedPr, ReviewEntry } from './types';

/** The reviewer agent's identity (plan §4.1 `Collab-Reviewer`). */
export const REVIEWER_AGENT = 'agent:vitana-lane-reviewer';
/**
 * The reviewer agent's ordered model fallback chain (owner 2026-10-21: "if one model
 * is not available it should pick up another one as fallback ... then a third one").
 * Each lane slot of the pipeline has one review step pinned to each model, in this
 * order; a later step reviews only when the earlier ones returned model_unavailable.
 * A verdict counts on any model in this chain, never outside it.
 * Mirrored (with a parity test) in scripts/ci/kiro-steering/guard.cjs REVIEWER_MODELS.
 */
export const REVIEWER_AGENT_MODELS: readonly string[] = Object.freeze([
  'claude-sonnet-5.5',
  'claude-opus-5.5',
  'claude-sonnet-4.5',
]);
/** The primary (first-choice) reviewer model. */
export const REVIEWER_AGENT_MODEL = REVIEWER_AGENT_MODELS[0];

/** Protected gate files (plan §4.3) — globs with scripts/collab/queue.mjs globToRegex semantics. */
export const PROTECTED_GATE_GLOBS: readonly string[] = Object.freeze([
  'CLAUDE.md',
  'scripts/collab/plan-spar.mjs',
  'scripts/collab/queue.mjs',
  'scripts/collab/protected-gate-files.json',
  'services/gateway/src/services/plan-sparring/**',
  'services/gateway/src/services/project-manager/governance.ts',
  '.github/workflows/PLAN-SPAR.yml',
  '.github/workflows/PR-GATE.yml',
  '.github/workflows/AWS-PROD-*.yml',
  '.kiro/agents/vitana-lane-reviewer.md',
  'supabase/migrations/*vtid_ledger*.sql',
  'supabase/migrations/*plan_sparring*.sql',
]);

/**
 * Governance paths (plan §1 of pm-agent). A lane whose `paths` reach one of these
 * merges only on an agent accept on the current head, or a legacy `claude`
 * review. Prefix match against each lane path glob.
 */
export const GOVERNANCE_PATHS = [
  '.github/',
  '.claude/',
  '.kiro/steering/',
  '.kiro/automations/',
  'scripts/collab/',
  'CLAUDE.md',
  'docs/programs/areas.yaml',
] as const;

/** The legacy reviewer value that unlocks a governance-path merge (never a protected gate file — VTID-05408 §5). */
export const GOVERNANCE_REVIEWER = 'claude';

/** Glob → RegExp, same semantics as scripts/collab/queue.mjs `globToRegex`. */
export function globToRegex(glob: string): RegExp {
  let re = '';
  const g = String(glob).trim();
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === '*' && g[i + 1] === '*') {
      i++;
      if (g[i + 1] === '/') {
        i++;
        re += '(?:.*/)?';
      } else re += '.*';
    } else if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  if (re.endsWith('/.*')) re = `${re.slice(0, -3)}(?:/.*)?`;
  return new RegExp(`^${re}$`);
}

const PROTECTED_RES: readonly RegExp[] = PROTECTED_GATE_GLOBS.map(globToRegex);

/** The changed files that are protected gate files. */
export function protectedFilesIn(files: readonly string[]): string[] {
  return files.filter((f) => {
    const norm = String(f).replace(/^\.?\//, '');
    return PROTECTED_RES.some((re) => re.test(norm));
  });
}

/** True when any changed file is a protected gate file. */
export function touchesProtectedGate(files: readonly string[]): boolean {
  return protectedFilesIn(files).length > 0;
}

/** Does a single lane path glob fall under a governance path? */
export function pathIsGovernance(p: string): boolean {
  const norm = p.replace(/^\.?\//, '').replace(/\*+$/g, '');
  return GOVERNANCE_PATHS.some((g) => {
    if (norm === g) return true;
    if (norm.startsWith(g)) return true;
    // lane path is a parent directory that contains a governance path
    if (norm.endsWith('/') && g.startsWith(norm)) return true;
    return false;
  });
}

/** True when any of the lane's declared paths is a governance path. */
export function laneTouchesGovernance(lane: ObservedLane): boolean {
  return lane.paths.some(pathIsGovernance);
}

/** The exact `Collab-Reviewer` values that identify the reviewer agent. */
const AGENT_REVIEWER_VALUES = new Set([REVIEWER_AGENT, ...REVIEWER_AGENT_MODELS.map((m) => `${REVIEWER_AGENT} (${m})`)]);

/** An `accept` written for the reviewer agent (exact identity; `agent:someone-else`, `…-fake`, null never count). */
export function isAgentReview(r: ReviewEntry): boolean {
  return r.verdict === 'accept' && typeof r.reviewer === 'string' && AGENT_REVIEWER_VALUES.has(r.reviewer.trim());
}

/** A legacy `claude` approve (no agent reviewer value). Unlocks a governance-path merge only — never a protected gate
 * file, which is always refused in code (VTID-05408 §5). */
export function isLegacyClaudeReview(r: ReviewEntry): boolean {
  return r.verdict === 'approve' && r.reviewer_seat === GOVERNANCE_REVIEWER && !r.reviewer;
}

/**
 * Is the review on the PR's current head? Exact head, or an earlier head after
 * which every commit only appended review entries / PM lane-state lines to this
 * lane's file (`review_only_since`, computed by the observer).
 */
export function reviewOnCurrentHead(r: ReviewEntry, pr: ObservedPr): boolean {
  if (r.head_sha === pr.head_sha) return true;
  return (pr.review_only_since ?? []).includes(r.head_sha);
}

/**
 * Does this review entry satisfy the lane's review precondition?
 *  - agent accept on the current head → yes (any lane, regardless of reviewer_seat);
 *  - an entry naming any other `reviewer` → no;
 *  - legacy entry: reviewer_seat match, `approve`, exact head; for a governance
 *    lane only when the lane's reviewer_seat is `claude`.
 */
export function reviewSatisfiesLane(lane: ObservedLane, r: ReviewEntry): boolean {
  const pr = lane.pr;
  if (!pr) return false;
  if (isAgentReview(r)) return reviewOnCurrentHead(r, pr);
  if (r.reviewer) return false;
  if (r.verdict !== 'approve') return false;
  if (r.reviewer_seat !== lane.reviewer_seat) return false;
  if (r.head_sha !== pr.head_sha) return false;
  if (laneTouchesGovernance(lane) && lane.reviewer_seat !== GOVERNANCE_REVIEWER) return false;
  return true;
}

export type GovernanceVerdict =
  | { ok: true }
  | { ok: false; reason: 'protected_gate_file' | 'no_agent_accept' | 'stale_head' };

/**
 * The final merge guard (decide precondition + act defence in depth).
 * Changed files are `pr.files` when the observer supplied them, else the lane's
 * declared paths are checked as file names.
 */
export function governanceMergeAllowed(
  lane: ObservedLane,
  pr: ObservedPr | null,
  review: ReviewEntry | null,
): GovernanceVerdict {
  const files = pr?.files ?? lane.paths;
  // VTID-05408 (kiro-lane-admin §5): the PM ALWAYS refuses a protected gate file in code — no review (legacy-claude or
  // agent) ever unlocks one programmatically. The legacy-claude unlock is RETIRED, not transferred: the authority for a
  // protected-gate merge is the owner's instruction naming the plan, recorded out-of-band in the lane log
  // (collaboration.md §7b), never a code-level unlock the PM can forge. Both independent layers (queue.mjs scope-check
  // AND this guard) keep refusing protected gate files, so a `--admin` override of Lane scope is still caught here —
  // defense-in-depth preserved, nothing less protected than before (R1-F3).
  if (touchesProtectedGate(files)) {
    return { ok: false, reason: 'protected_gate_file' };
  }
  if (!laneTouchesGovernance(lane)) return { ok: true };
  if (review == null) {
    // Legacy rule (no review supplied): the lane's reviewer must be claude.
    return lane.reviewer_seat === GOVERNANCE_REVIEWER ? { ok: true } : { ok: false, reason: 'no_agent_accept' };
  }
  if (isAgentReview(review)) {
    return pr != null && reviewOnCurrentHead(review, pr) ? { ok: true } : { ok: false, reason: 'stale_head' };
  }
  if (lane.reviewer_seat === GOVERNANCE_REVIEWER && isLegacyClaudeReview(review)) {
    return pr != null && review.head_sha === pr.head_sha ? { ok: true } : { ok: false, reason: 'stale_head' };
  }
  return { ok: false, reason: 'no_agent_accept' };
}
