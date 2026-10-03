/**
 * VTID-04808: Jev P2 gate A7 — clash check between parallel green Dev
 * Autopilot PRs. (docs/JEV-INTEGRATION-PLAN.md §10.4 A7)
 *
 *   pr_clash   (JEV_PR_CLASH_MODE = off | shadow | enforce)
 *
 * The watcher merges each green PR on its own. When several executions are
 * open at once, merging one can leave another un-mergeable or broken: in the
 * 60 days to 2026-10-01, 18 Dev Autopilot CI failures were
 * `mergeable_state: dirty` (13 of them on one day of parallel runs).
 *
 * Right before the watcher merges a green PR, the other open executions (in
 * CI or merging, with a PR) that share a file or a directory with it are
 * listed — at most 3, shared files first — and Jev `pr_clash` is asked, per
 * pair, whether merging this one now will make the other conflict or break.
 * One `jev_shadow_decisions` row per merge, listing each other execution and
 * Jev's call; never awaited, the merge goes ahead exactly as before. When one
 * of those other executions next reports — CI failed with a dirty merge state,
 * or CI passed — the row records whether Jev's call for it was right.
 * No enforce behaviour: holding the second PR or merging in a safer order
 * comes after the data.
 */

import * as path from 'path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from '../../../lib/supabase';
import { decide, DecideOptions } from '../jev-decision-service';
import * as repo from '../jev-repository';
import { jevGateMode, recordJevShadowDecision, recordJevShadowOutcome } from '../jev-shadow';

export const PR_CLASH_GATE = 'pr_clash';
export const MAX_OTHERS = 3;
const SYSTEM_CALLER = { actor_id: 'dev-autopilot-watcher', system: true } as const;
const OUTCOME_LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000;

export interface OpenChange {
  execution_id: string;
  title: string;
  files: string[];
}

export interface ClashPair {
  other: OpenChange;
  shared_files: string[];
  shared_dirs: string[];
}

export function isPrClashOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return jevGateMode(PR_CLASH_GATE, env) !== 'off';
}

const dirOf = (p: string) => path.posix.dirname(p);

/** Others that share a file or a directory with the merging change; shared files first, at most 3. */
export function overlappingChanges(merging: OpenChange, others: OpenChange[]): ClashPair[] {
  const files = new Set(merging.files);
  const dirs = new Set(merging.files.map(dirOf));
  const pairs: ClashPair[] = [];
  for (const o of others) {
    if (o.execution_id === merging.execution_id) continue;
    const shared_files = o.files.filter((f) => files.has(f));
    const shared_dirs = [...new Set(o.files.map(dirOf).filter((d) => dirs.has(d)))];
    if (shared_files.length || shared_dirs.length) pairs.push({ other: o, shared_files, shared_dirs });
  }
  return pairs
    .sort((a, b) => b.shared_files.length - a.shared_files.length || b.shared_dirs.length - a.shared_dirs.length)
    .slice(0, MAX_OTHERS);
}

export interface PrClashDeps {
  loadMerging: () => Promise<OpenChange | null>;
  loadOthers: () => Promise<OpenChange[]>;
}

/** Ask Jev about each overlapping open change and write one row. Returns the row id or null; never throws. */
export async function runPrClashCheck(a: {
  executionId: string;
  deps: PrClashDeps;
  env?: NodeJS.ProcessEnv;
  sb?: SupabaseClient | null;
  decideOptions?: Omit<DecideOptions, 'source' | 'env'>;
}): Promise<string | null> {
  const env = a.env ?? process.env;
  const mode = jevGateMode(PR_CLASH_GATE, env);
  if (mode === 'off') return null;
  try {
    const merging = await a.deps.loadMerging();
    if (!merging || merging.files.length === 0) return null;
    const pairs = overlappingChanges(merging, await a.deps.loadOthers());
    if (pairs.length === 0) return null;
    const others: Array<{ execution_id: string; shared_files: number; shared_dirs: number; clash: boolean | null; probability: number | null }> = [];
    let cost = 0;
    let outcome = 'fallback';
    let reason: string | undefined;
    for (const p of pairs) {
      const r = await decide(
        'pr_clash',
        {
          merging_title: merging.title.slice(0, 300) || '(untitled)',
          merging_files: merging.files.slice(0, 40),
          other_title: p.other.title.slice(0, 300) || '(untitled)',
          other_files: p.other.files.slice(0, 40),
          shared_files: p.shared_files.slice(0, 40),
          shared_dirs: p.shared_dirs.slice(0, 20),
        },
        SYSTEM_CALLER,
        { ...(a.decideOptions || {}), source: `gate:${PR_CLASH_GATE}`, env },
      );
      if (r.ok) { cost += r.cost_usd; if (outcome !== 'decided') outcome = r.outcome; } else reason = r.reason;
      others.push({
        execution_id: p.other.execution_id,
        shared_files: p.shared_files.length,
        shared_dirs: p.shared_dirs.length,
        clash: r.ok && r.outcome === 'decided' ? r.verdict.value === true : null,
        probability: r.ok ? r.answers.clash?.probability ?? null : null,
      });
    }
    return await recordJevShadowDecision(
      {
        gate: PR_CLASH_GATE,
        decision: 'pr_clash',
        mode,
        plane: 'internal',
        tenant_id: null,
        subject_type: 'dev_autopilot_execution',
        subject_ref: a.executionId,
        jev_outcome: outcome,
        jev_verdict: { others, ...(outcome === 'fallback' && reason ? { reason } : {}) },
        jev_confidence: null,
        system_action: 'merged',
        cost_usd: cost,
      },
      a.sb,
    );
  } catch (err: any) {
    console.warn(`[jev] ${PR_CLASH_GATE} check failed for ${a.executionId}: ${err?.message || err}`);
    return null;
  }
}

/**
 * An open execution reported CI: `conflicted` when it failed with a dirty
 * merge state, false when it passed. Every open row that judged it gets its
 * outcome. Never throws.
 */
export async function recordPrClashOutcome(
  executionId: string,
  conflicted: boolean,
  opts: { sb?: SupabaseClient | null; now?: () => number } = {},
): Promise<number> {
  try {
    const sb = opts.sb === undefined ? getSupabase() : opts.sb;
    if (!sb) return 0;
    const since = new Date((opts.now ?? Date.now)() - OUTCOME_LOOKBACK_MS).toISOString();
    const { data, error } = await repo.fetchOpenShadowRowsNamingOther(sb, PR_CLASH_GATE, executionId, since);
    if (error || !data) return 0;
    let n = 0;
    for (const row of data as Array<{ id: string; jev_verdict?: { others?: Array<{ execution_id: string; clash: boolean | null }> } }>) {
      const call = (row.jev_verdict?.others || []).find((o) => o.execution_id === executionId);
      if (!call) continue;
      const agreed = call.clash === null ? null : call.clash === conflicted;
      await recordJevShadowOutcome(row.id, `${conflicted ? 'other_conflicted' : 'other_merged_clean'}:${executionId.slice(0, 8)}`, agreed, sb);
      n++;
    }
    return n;
  } catch (err: any) {
    console.warn(`[jev] ${PR_CLASH_GATE} outcome not recorded for ${executionId}: ${err?.message || err}`);
    return 0;
  }
}
