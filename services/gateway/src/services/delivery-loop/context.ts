/**
 * Delivery loop: what every step of a cycle shares. The dependencies (ports), the controls read at the start of the cycle, the
 * budget of side effects, and the counters of what the cycle did.
 */
import type { GitlabClient } from './gitlab-client';
import type { Controls } from './controls';
import { mayDo } from './controls';
import type { Ledger, LoopEvent, MetaValue, RecordResult } from './ledger';
import type { LedgerEvent } from './facts';
import type { LearnPort, ReviewerPort, TaskPort } from './ports';
import type { GitlabResult, LoopAction } from './types';
import { K, T } from './keys';

export interface LoopDeps {
  gitlab: GitlabClient;
  ledger: Ledger;
  tasks: TaskPort;
  /** Null when no reviewer is configured: the loop then does not review. */
  reviewer: ReviewerPort | null;
  learn: LearnPort;
  now: () => number;
}

export interface CycleStats {
  facts: number;
  skipped: Record<string, number>;
  decisions: number;
  intents: number;
  dispatched: number;
  retried: number;
  notes: number;
  reviews: number;
  verified: number;
  exhausted: number;
  learned: number;
  proposals: number;
  polled: number;
  errors: number;
}

export const emptyStats = (): CycleStats => ({
  facts: 0, skipped: {}, decisions: 0, intents: 0, dispatched: 0, retried: 0, notes: 0, reviews: 0, verified: 0, exhausted: 0, learned: 0, proposals: 0, polled: 0, errors: 0,
});

export interface Ctx {
  deps: LoopDeps;
  /** The environment the cycle was configured from (the intake label); injected, never read from process.env inside a step. */
  env: NodeJS.ProcessEnv;
  controls: Controls;
  stats: CycleStats;
  /** Side effects left in this cycle (GitLab writes and executions). Decisions and records are not counted. */
  budget: { actions: number };
  /**
   * The right to write in this window, taken lazily before the first write or side effect of the cycle and never for a cycle that only
   * reads (the repo's rule: polling is not an OASIS event). `lost` means another gateway task holds the window.
   */
  claim: { state: 'unclaimed' | 'held' | 'lost'; acquire: () => Promise<'held' | 'lost'> };
}

/** Another gateway task holds this window: the cycle stops quietly, the other task does the work. */
export class ClaimedElsewhere extends Error {
  constructor() {
    super('claimed elsewhere');
    this.name = 'ClaimedElsewhere';
  }
}

/** Takes the window's claim if the cycle does not hold it yet. Throws ClaimedElsewhere when another task has it. */
export async function ensureClaim(ctx: Ctx): Promise<void> {
  if (ctx.claim.state === 'held') return;
  if (ctx.claim.state === 'lost') throw new ClaimedElsewhere();
  ctx.claim.state = await ctx.claim.acquire();
  if (ctx.claim.state === 'lost') throw new ClaimedElsewhere();
}

/** A failure that is the world's, not the fact's (GitLab or OASIS down): the fact is handled again next cycle. */
export class LoopError extends Error {
  constructor(readonly where: string, message: string) {
    super(`${where}: ${message}`);
    this.name = 'LoopError';
  }
}

/**
 * The action budget of this cycle is spent in the middle of a fact. The cycle stops at that fact without passing it, and the next
 * cycle handles it again: every step records idempotently, so what was done is skipped and what is missing is completed. No
 * decision is lost to the cap, and a fact is never half-handled for good.
 */
export class DeferredByBudget extends Error {
  constructor() {
    super('deferred: the action budget of this cycle is spent');
    this.name = 'DeferredByBudget';
  }
}

export const skip = (ctx: Ctx, reason: string): void => {
  ctx.stats.skipped[reason] = (ctx.stats.skipped[reason] ?? 0) + 1;
};

/**
 * Takes one side effect from the budget, after taking the window's claim; throws DeferredByBudget when none is left, so no step can
 * carry on past the cap. Every side effect of the loop is preceded by this.
 */
export async function spend(ctx: Ctx): Promise<void> {
  if (ctx.budget.actions <= 0) throw new DeferredByBudget();
  await ensureClaim(ctx);
  ctx.budget.actions -= 1;
}

/**
 * May the loop do this now? A budget of 0 means "no side effects at all": prepare and act are off (record and learn are not side
 * effects on anything but the ledger), so a zero budget never leaves the cycle waiting for an action it can never take.
 */
export function may(ctx: Ctx, action: LoopAction): boolean {
  if (ctx.controls.maxActions === 0 && (action === 'prepare' || action === 'act')) return false;
  return mayDo(ctx.controls, action);
}

/**
 * A write that only states what GitLab shows (the poller's fact rows). It does not take the window's claim, for two reasons. It is
 * idempotent by key, so two gateway tasks that write the same fact write one row and nothing needs guarding. And the poller reads again,
 * on purpose, what GitLab changed in the last minutes (so that nothing falls between two polls): each of those repeats answers
 * `duplicate` and writes no row, but if it took the claim first, every repeat would leave a claim row behind, and a loop with nothing to
 * do would still write a row per cycle (found by the rehearsal on a real GitLab). Decisions and side effects take the claim (`record`,
 * `spend`); a fact does not.
 */
export async function recordFact(ctx: Ctx, e: LoopEvent): Promise<Extract<RecordResult, { ok: true }>> {
  const r = await ctx.deps.ledger.record(e);
  if (!r.ok) throw new LoopError('ledger.record', r.error);
  return r;
}

/** A ledger write that must succeed: a failure ends the step, the fact is handled again next cycle. */
export async function record(ctx: Ctx, e: LoopEvent): Promise<Extract<RecordResult, { ok: true }>> {
  await ensureClaim(ctx);
  const r = await ctx.deps.ledger.record(e);
  if (!r.ok) throw new LoopError('ledger.record', r.error);
  return r;
}

export async function find(ctx: Ctx, topic: string, where: Readonly<Record<string, MetaValue>> = {}, opts: { since?: string; limit?: number } = {}): Promise<LedgerEvent[]> {
  const r = await ctx.deps.ledger.find({ topic, where, since: opts.since, limit: opts.limit });
  if (!r.ok) throw new LoopError('ledger.find', r.error);
  return r.events;
}

/** The data of a GitLab call, or a LoopError when it failed (a 404 is the caller's to handle: pass `allow404`). */
export function must<T>(where: string, r: GitlabResult<T>, opts: { allow404?: boolean } = {}): T | null {
  if (r.ok) return r.data;
  if (opts.allow404 && r.status === 404) return null;
  throw new LoopError(where, r.error);
}

export const isoNow = (ctx: Ctx): string => new Date(ctx.deps.now()).toISOString();
export const sinceMs = (ctx: Ctx, ms: number): string => new Date(ctx.deps.now() - ms).toISOString();

// ---------------------------------------------------------------------------------------------------------
// Notes: what the loop says on GitLab
// ---------------------------------------------------------------------------------------------------------

export type NoteResult = 'posted' | 'already' | 'requested';

export interface Note {
  scope: string;
  project: string;
  target: 'issue' | 'mr';
  iid: number;
  body: string;
  addLabels?: string[];
  removeLabels?: string[];
}

/**
 * Says something on an issue or a merge request, once per scope. A note is an intent like any other work of the loop: it is REQUESTED
 * (a row, always, at L1 and up) and POSTED (a comment and label changes, at L2 and up). A note requested while the level did not allow
 * posting is posted by `noteSweep` when it does, so raising the level never loses what the loop wanted to say.
 */
export async function postNote(ctx: Ctx, n: Note): Promise<NoteResult> {
  if (!may(ctx, 'record')) return 'already';
  const requested = await record(ctx, {
    type: T.noteRequested,
    status: 'info',
    message: `Note requested on ${n.target === 'issue' ? 'issue #' : 'merge request !'}${n.iid} in ${n.project}`,
    payload: { note_key: K.note(n.scope), scope: n.scope, project: n.project, target: n.target, iid: n.iid, body: n.body.slice(0, 4000), add_labels: n.addLabels ?? [], remove_labels: n.removeLabels ?? [] },
    key: K.noteRequested(n.scope),
  });
  void requested;
  return deliverNote(ctx, n);
}

/**
 * Posts a requested note when the level allows it. The comment and the label change are two GitLab calls, so each is recorded on its
 * own: a failure of the label after the comment went out repeats only the label next time, never the comment (a comment is the one
 * GitLab write that is visible to people and is not idempotent). The note is posted when both steps are recorded.
 */
async function deliverNote(ctx: Ctx, n: Note): Promise<NoteResult> {
  if (!may(ctx, 'prepare')) return 'requested';
  const key = K.note(n.scope);
  if ((await find(ctx, T.note, { note_key: key }, { limit: 1 })).length > 0) return 'already';

  const g = ctx.deps.gitlab;
  const commentKey = `${key}:comment`;
  if ((await find(ctx, T.note, { note_key: commentKey }, { limit: 1 })).length === 0) {
    await spend(ctx);
    must('gitlab.comment', n.target === 'issue' ? await g.commentIssue(n.project, n.iid, n.body) : await g.commentMergeRequest(n.project, n.iid, n.body));
    await record(ctx, {
      type: T.note,
      status: 'info',
      message: `Commented on ${n.target === 'issue' ? 'issue #' : 'merge request !'}${n.iid} in ${n.project}`,
      payload: { note_key: commentKey, scope: n.scope, project: n.project, target: n.target, iid: n.iid, step: 'comment' },
      key: commentKey,
    });
  }
  if (n.target === 'issue' && ((n.addLabels?.length ?? 0) > 0 || (n.removeLabels?.length ?? 0) > 0)) {
    // Label changes are idempotent on GitLab (adding a label that is there changes nothing), so this step may repeat safely.
    must('gitlab.labels', await g.updateIssueLabels(n.project, n.iid, { add: n.addLabels, remove: n.removeLabels }));
  }
  await record(ctx, {
    type: T.note,
    status: 'info',
    message: `Posted a note on ${n.target === 'issue' ? 'issue #' : 'merge request !'}${n.iid} in ${n.project}`,
    payload: { note_key: key, scope: n.scope, project: n.project, target: n.target, iid: n.iid, step: 'done' },
    key,
  });
  ctx.stats.notes += 1;
  return 'posted';
}

/** Posts the notes that were requested and not posted (the level was too low, or GitLab was down), newest day first, bounded. */
export async function noteSweep(ctx: Ctx): Promise<void> {
  if (!may(ctx, 'prepare')) return;
  const rows = (await find(ctx, T.noteRequested, {}, { since: sinceMs(ctx, 24 * 60 * 60 * 1000), limit: 50 })).sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  for (const r of rows) {
    const m = r.metadata;
    if (!ctx.controls.projects.includes(String(m.project))) continue;
    if (typeof m.iid !== 'number' || (m.target !== 'issue' && m.target !== 'mr')) continue;
    try {
      await deliverNote(ctx, {
        scope: String(m.scope), project: String(m.project), target: m.target, iid: m.iid, body: String(m.body ?? ''),
        addLabels: Array.isArray(m.add_labels) ? m.add_labels.map(String) : [], removeLabels: Array.isArray(m.remove_labels) ? m.remove_labels.map(String) : [],
      });
    } catch (e) {
      if (e instanceof DeferredByBudget || e instanceof ClaimedElsewhere) throw e;
      ctx.stats.errors += 1; // GitLab is down for this one; the note stays requested and the next cycle tries again
    }
  }
}
