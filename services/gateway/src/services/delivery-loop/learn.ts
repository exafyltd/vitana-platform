/**
 * Delivery loop, learn and improve: every outcome leaves a lesson, and a failure that keeps coming back becomes a proposal.
 *
 * Learning is a SWEEP over the outcome rows of the last day, not a call made inline where the outcome happens: a memory write that
 * fails (the store is down) leaves the outcome without its `delivery.learn.recorded` row, and the next cycle's sweep tries again. A
 * lesson is written once (its key), and its row is recorded only after the write succeeded.
 *
 *   verified repair     -> the repair pattern (fingerprint -> what fixed it) and a memory note        (LearnPort.recordRepair, recordOutcome)
 *   exhausted repair    -> a memory note: it could not be repaired, and why                           (LearnPort.recordOutcome)
 *   delivered task      -> a memory note: the issue was delivered through a merge request             (LearnPort.recordOutcome)
 *   rework              -> a memory note with the reviewer's finding count                           (LearnPort.recordOutcome)
 *
 * Improvement closes the loop through a person: a failure fingerprint detected IMPROVE_MIN_COUNT times in 7 days becomes one proposal
 * per week, as a GitLab issue labeled `delivery-proposal` (not the intake label). A Developer who agrees applies the intake label,
 * and the issue enters the loop as any task. The loop never labels its own proposals for intake.
 */
import type { LedgerEvent } from './facts';
import { K, T, isoWeek } from './keys';
import { find, may, must, record, sinceMs, spend, type Ctx } from './context';
import { LABEL_PROPOSAL } from './labels';

export const LEARN_WINDOW_MS = 24 * 60 * 60 * 1000;
export const IMPROVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const IMPROVE_MIN_COUNT = 3;

/** Pure. The lessons the rows of one window imply, each with its key. A row without what a lesson needs gives none. */
export interface LessonPlan {
  key: string;
  kind: 'repair_verified' | 'repair_exhausted' | 'review_rework' | 'intake_delivered';
  row: LedgerEvent;
}

export function lessonsFrom(rows: { verified: LedgerEvent[]; exhausted: LedgerEvent[]; reworks: LedgerEvent[] }): LessonPlan[] {
  const out: LessonPlan[] = [];
  for (const r of rows.verified) out.push({ key: K.learned('repair_verified', r.id), kind: 'repair_verified', row: r });
  for (const r of rows.exhausted) out.push({ key: K.learned('repair_exhausted', r.id), kind: 'repair_exhausted', row: r });
  for (const r of rows.reworks) out.push({ key: K.learned('review_rework', r.id), kind: 'review_rework', row: r });
  return out;
}

export async function learnSweep(ctx: Ctx): Promise<void> {
  if (!may(ctx, 'learn')) return;
  const since = sinceMs(ctx, LEARN_WINDOW_MS);
  const plans = lessonsFrom({
    verified: await find(ctx, T.healVerified, {}, { since, limit: 50 }),
    exhausted: await find(ctx, T.healExhausted, {}, { since, limit: 50 }),
    reworks: await find(ctx, T.reviewRework, {}, { since, limit: 50 }),
  });

  for (const p of plans) {
    if ((await find(ctx, T.learned, { lesson_key: p.key }, { limit: 1 })).length > 0) continue;
    const m = p.row.metadata;
    const project = String(m.project ?? '');
    if (!ctx.controls.projects.includes(project)) continue;

    let ok = true;
    if (p.kind === 'repair_verified') {
      const attempts = typeof m.attempts === 'number' ? m.attempts : 1;
      // A repair is only a pattern when a change fixed it; a bare retry that went green says "this was infrastructure", which is also
      // worth remembering, but not as a code fix.
      if (m.action === 'run_task' && m.changed !== false) {
        const r = await ctx.deps.learn.recordRepair({
          project, fingerprint: String(m.fingerprint ?? ''), failure_class: String(m.failure_class ?? 'code'), jobs: strings(m.jobs), excerpt: [], attempts,
          mr_url: typeof m.mr_url === 'string' ? m.mr_url : null, work_key: typeof m.work_key === 'string' ? m.work_key : null,
        });
        ok = ok && r.ok;
      }
      const o = await ctx.deps.learn.recordOutcome({
        project, kind: 'repair_verified',
        summary: `A pipeline failure on ${String(m.branch)} (${strings(m.jobs).join(', ') || 'unknown job'}) was ${m.action === 'retry_pipeline' ? 'cleared by retrying the failed jobs' : 'repaired'} after ${attempts} attempt${attempts === 1 ? '' : 's'} and verified by a green pipeline.`,
        tags: ['delivery-loop', 'repair', String(m.failure_class ?? 'code')], refs: refs(m),
      });
      ok = ok && o.ok;
    } else if (p.kind === 'repair_exhausted') {
      const o = await ctx.deps.learn.recordOutcome({
        project, kind: 'repair_exhausted',
        summary: `The delivery loop stopped repairing ${String(m.branch)} (${strings(m.jobs).join(', ') || 'unknown job'}): ${String(m.reason ?? 'unknown reason')}${typeof m.attempts === 'number' && m.attempts > 0 ? ` after ${m.attempts} attempt${m.attempts === 1 ? '' : 's'}` : ''}. It needs a person.`,
        tags: ['delivery-loop', 'repair-exhausted', String(m.reason ?? 'unknown')], refs: refs(m),
      });
      ok = o.ok;
    } else {
      const o = await ctx.deps.learn.recordOutcome({
        project, kind: 'review_rework',
        summary: `The reviewer asked for changes on !${String(m.mr_iid)} (${String(m.findings ?? 0)} finding${m.findings === 1 ? '' : 's'}, round ${String(m.round ?? 1)}).`,
        tags: ['delivery-loop', 'review-rework'], refs: refs(m),
      });
      ok = o.ok;
    }

    if (!ok) {
      ctx.stats.errors += 1; // the memory is down: no row is written, so the sweep tries this lesson again next cycle
      continue;
    }
    await record(ctx, { type: T.learned, status: 'success', message: `Lesson recorded: ${p.kind}`, payload: { lesson_key: p.key, kind: p.kind, project, source_event: p.row.id }, key: p.key });
    ctx.stats.learned += 1;
  }
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
function refs(m: Record<string, unknown>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const k of ['branch', 'heal_key', 'fingerprint', 'work_key', 'mr_url', 'pipeline_id', 'mr_iid']) {
    const v = m[k];
    if (typeof v === 'string' || typeof v === 'number') out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Improve
// ---------------------------------------------------------------------------------------------------------

export interface Recurrence {
  project: string;
  fingerprint: string;
  count: number;
  jobs: string[];
  lastPipeline: number | null;
  lastUrl: string | null;
}

/** Pure. The failures detected at least `min` times in the rows, most frequent first. */
export function recurrences(detected: readonly LedgerEvent[], min = IMPROVE_MIN_COUNT): Recurrence[] {
  const by = new Map<string, Recurrence & { at: string }>();
  for (const r of detected) {
    const m = r.metadata;
    const project = String(m.project ?? '');
    const fingerprint = String(m.fingerprint ?? '');
    if (!project || !fingerprint) continue;
    const k = `${project}|${fingerprint}`;
    const cur = by.get(k) ?? { project, fingerprint, count: 0, jobs: [], lastPipeline: null, lastUrl: null, at: '' };
    cur.count += 1;
    if (r.created_at >= cur.at) {
      cur.at = r.created_at;
      cur.jobs = Array.isArray(m.jobs) ? m.jobs.map(String) : cur.jobs;
      cur.lastPipeline = typeof m.pipeline_id === 'number' ? m.pipeline_id : cur.lastPipeline;
      cur.lastUrl = typeof m.url === 'string' ? m.url : cur.lastUrl;
    }
    by.set(k, cur);
  }
  return [...by.values()].filter((r) => r.count >= min).sort((a, b) => b.count - a.count).map(({ at: _at, ...rest }) => rest);
}

export async function improveSweep(ctx: Ctx): Promise<void> {
  if (!may(ctx, 'record')) return;
  const detected = await find(ctx, T.healDetected, {}, { since: sinceMs(ctx, IMPROVE_WINDOW_MS), limit: 200 });
  const week = isoWeek(ctx.deps.now());

  for (const r of recurrences(detected).filter((x) => ctx.controls.projects.includes(x.project)).slice(0, 3)) {
    const key = K.improve(r.project, r.fingerprint, week);
    if ((await find(ctx, T.improve, { proposal_key: key }, { limit: 1 })).length > 0) continue;

    let issueIid: number | null = null;
    if (may(ctx, 'prepare')) {
      await spend(ctx);
      const created = must(
        'gitlab.createIssue',
        await ctx.deps.gitlab.createIssue(r.project, {
          title: `Recurring pipeline failure: ${r.jobs[0] ?? 'a job'} (${r.count} times in 7 days)`,
          description: [
            `The delivery loop saw the same pipeline failure ${r.count} times in the last 7 days.`,
            '',
            `- Jobs (job:reason): ${r.jobs.join(', ') || 'unknown'}`,
            `- Failure fingerprint: \`${r.fingerprint}\``,
            r.lastUrl ? `- Latest pipeline: ${r.lastUrl}` : '',
            '',
            'A failure that keeps coming back is a cause worth removing, not a failure worth repairing a fourth time. If you agree, apply the label of the delivery loop that marks a task and it will prepare the change; otherwise close this issue.',
          ].filter((l) => l !== '').join('\n'),
          labels: [LABEL_PROPOSAL],
        }),
      );
      issueIid = created?.iid ?? null;
    }
    // The row is written after the issue: a crash between them proposes the same failure twice at worst, never zero times.
    await record(ctx, {
      type: T.improve,
      status: 'info',
      message: `Improvement proposed in ${r.project}: ${r.jobs[0] ?? 'a job'} failed ${r.count} times in 7 days`,
      payload: { proposal_key: key, project: r.project, fingerprint: r.fingerprint, count: r.count, jobs: r.jobs, issue_iid: issueIid, week },
      key,
    });
    ctx.stats.proposals += 1;
  }
}
