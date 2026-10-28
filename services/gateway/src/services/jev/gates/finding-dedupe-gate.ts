/**
 * VTID-04797: Jev P2 gate A8 — is a new Dev Autopilot finding a near
 * duplicate of one that is already live? (docs/JEV-INTEGRATION-PLAN.md §10.4 A8)
 *
 *   finding_dedupe   (JEV_FINDING_DEDUPE_MODE = off | shadow | enforce)
 *
 * The scanner already merges an identical signal fingerprint into the live
 * row. What it cannot see is the same problem reported twice in different
 * words: a `missing_tests` and a `large_file` signal on one file, a TODO
 * re-worded by a refactor. In the 60 days to 2026-10-01, 57 auto-archived
 * dev findings sat on only 13 files.
 *
 * Runs after a new finding is inserted, fire-and-forget: the scan, the
 * insert and the finding are unchanged. Up to MAX_CANDIDATES live findings
 * on the same file are compared with the new one (Jev `finding_duplicate`,
 * telemetry: titles, summaries, signal types — code paths, never code).
 * One `jev_shadow_decisions` row per new finding (subject = the new row's
 * id), naming the closest candidate. Agreement comes later from how the
 * new finding ends (completed vs rejected/auto-archived), read by joining
 * on the subject id; nothing is written back here. No enforce behaviour
 * yet — merging into the candidate is a later slice, after the data.
 */

import { getSupabase } from '../../../lib/supabase';
import { decide, DecideOptions } from '../jev-decision-service';
import { jevGateMode, recordJevShadowDecision } from '../jev-shadow';
import type { SupabaseClient } from '@supabase/supabase-js';

export const FINDING_DEDUPE_GATE = 'finding_dedupe';
export const MAX_CANDIDATES = 3;
const SYSTEM_CALLER = { actor_id: 'dev-autopilot-synthesis', system: true } as const;

export interface FindingLike {
  id: string;
  title: string | null;
  summary: string | null;
  signal_type: string | null;
  file_path: string | null;
}

/** The text Jev sees for one finding: what it says and where, nothing else. */
export function findingText(f: FindingLike): string {
  return [
    f.title ? `title: ${f.title}` : null,
    f.signal_type ? `signal: ${f.signal_type}` : null,
    f.file_path ? `file: ${f.file_path}` : null,
    f.summary ? `summary: ${f.summary.slice(0, 1500)}` : null,
  ].filter(Boolean).join('\n').slice(0, 4000);
}

export interface FindingDedupeDeps {
  /** The new row by its signal fingerprint (insert returns no body). */
  loadNew: (fingerprint: string) => Promise<FindingLike | null>;
  /** Live dev findings on the same file, newest first, excluding `excludeId`. */
  loadCandidates: (filePath: string, excludeId: string, limit: number) => Promise<FindingLike[]>;
}

export function isFindingDedupeOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return jevGateMode(FINDING_DEDUPE_GATE, env) !== 'off';
}

/** Never throws. Returns the shadow row id, or null when off/skipped/failed. */
export async function runFindingDedupeCheck(a: {
  fingerprint: string;
  deps: FindingDedupeDeps;
  env?: NodeJS.ProcessEnv;
  sb?: SupabaseClient | null;
  decideOptions?: Omit<DecideOptions, 'source' | 'env'>;
}): Promise<string | null> {
  const env = a.env ?? process.env;
  const mode = jevGateMode(FINDING_DEDUPE_GATE, env);
  if (mode === 'off') return null;
  try {
    const fresh = await a.deps.loadNew(a.fingerprint);
    if (!fresh || !fresh.file_path) return null;
    const candidates = (await a.deps.loadCandidates(fresh.file_path, fresh.id, MAX_CANDIDATES)).slice(0, MAX_CANDIDATES);
    if (candidates.length === 0) return null;

    const finding = findingText(fresh);
    let best: { id: string; probability: number } | null = null;
    let lastFailure: string | null = null;
    let cost = 0;
    let decided = 0;
    for (const c of candidates) {
      const r = await decide('finding_duplicate', { finding, candidate: findingText(c) }, SYSTEM_CALLER, {
        ...(a.decideOptions || {}), source: `gate:${FINDING_DEDUPE_GATE}`, env,
      });
      if (!r.ok) { lastFailure = r.reason; continue; }
      cost += r.cost_usd;
      decided++;
      const p = r.answers.duplicate?.probability ?? (r.verdict.value === true ? 1 : 0);
      if (!best || p > best.probability) best = { id: c.id, probability: p };
    }

    const duplicate = best ? best.probability >= 0.75 : null;
    return await recordJevShadowDecision(
      {
        gate: FINDING_DEDUPE_GATE,
        decision: 'finding_duplicate',
        mode,
        plane: 'internal',
        tenant_id: null,
        subject_type: 'dev_autopilot_finding',
        subject_ref: fresh.id,
        jev_outcome: decided > 0 ? 'decided' : 'fallback',
        jev_verdict: decided > 0
          ? { duplicate, closest_id: best!.id, probability: best!.probability, candidates: candidates.length, compared: decided }
          : { reason: lastFailure, candidates: candidates.length },
        jev_confidence: best ? Math.max(best.probability, 1 - best.probability) : null,
        system_action: 'inserted_as_new',
        cost_usd: cost,
      },
      a.sb === undefined ? getSupabase() : a.sb,
    );
  } catch (err: any) {
    console.warn(`[jev] ${FINDING_DEDUPE_GATE} check failed for ${a.fingerprint}: ${err?.message || err}`);
    return null;
  }
}
