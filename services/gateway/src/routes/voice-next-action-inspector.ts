/**
 * VTID-03063 (B0d-real slice Xf.3): Candidate Inspector read-only endpoint.
 *
 *   GET /api/v1/voice/next-action/inspector?user_id=<uuid>&hours=24
 *
 * Returns the recent B0d-real lifecycle events for a single user,
 * grouped by decision_id. Used by the Command Hub Candidate Inspector
 * panel to answer "what did Vitana suggest, what did the user do?".
 *
 * Auth: requireExafyAdmin. The inspector exposes raw OASIS metadata
 * (source evidence + reasons + dedupe keys) so it's an operator surface,
 * not a per-user one.
 *
 * Response shape:
 *   {
 *     ok: true,
 *     vtid: 'VTID-03063',
 *     window_hours: 24,
 *     user_id: '<uuid>',
 *     decisions: [
 *       {
 *         decision_id: 'd-...',
 *         suggested_at?: string,       // when the candidate was offered
 *         suggested?: {                // payload of the suggested event
 *           dedupe_key, priority, source_evidence, reason_evidence, …
 *         },
 *         suppressed_at?: string,
 *         suppressed?: { provider_status, suppress_reason, … },
 *         outcome?: 'accepted' | 'dismissed' | null,
 *         outcome_at?: string,
 *         outcome_payload?: { source, surface, metadata, … },
 *       },
 *     ],
 *     totals: {
 *       suggested: number,
 *       accepted: number,
 *       dismissed: number,
 *       suppressed: number,
 *     },
 *   }
 *
 * Read-only. Never mutates anything. Caps result to 200 decisions.
 */

import { Router, Response } from 'express';
import {
  requireExafyAdmin,
  AuthenticatedRequest,
} from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import {
  NEXT_ACTION_SUGGESTED,
  NEXT_ACTION_ACCEPTED,
  NEXT_ACTION_DISMISSED,
  NEXT_ACTION_SUPPRESSED,
  NEXT_ACTION_CANDIDATE,
} from '../services/assistant-continuation/telemetry';

const router = Router();
const VTID = 'VTID-03063';

const TOPICS = [
  NEXT_ACTION_SUGGESTED,
  NEXT_ACTION_ACCEPTED,
  NEXT_ACTION_DISMISSED,
  NEXT_ACTION_SUPPRESSED,
  NEXT_ACTION_CANDIDATE,
] as const;

const MAX_DECISIONS = 200;
const MAX_HOURS = 24 * 14; // two weeks

router.get(
  '/voice/next-action/inspector',
  requireExafyAdmin,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = String(req.query.user_id ?? '').trim();
      const hours = Math.max(
        1,
        Math.min(MAX_HOURS, Number(req.query.hours ?? 24) || 24),
      );

      // VTID-03063: UUID-ish gate to keep the SQL injection surface narrow.
      // Same pattern the rest of the routes use for query-param IDs.
      if (!userId || !/^[0-9a-f-]{8,}$/i.test(userId)) {
        return res
          .status(400)
          .json({ ok: false, error: 'user_id is required (uuid)', vtid: VTID });
      }

      const sb = getSupabase();
      if (!sb) {
        return res
          .status(503)
          .json({ ok: false, error: 'DB_UNAVAILABLE', vtid: VTID });
      }

      const sinceIso = new Date(Date.now() - hours * 3_600_000).toISOString();
      const { data, error } = await sb
        .from('oasis_events')
        .select('id, topic, created_at, payload, actor_id')
        .in('topic', TOPICS as unknown as string[])
        .eq('actor_id', userId)
        .gte('created_at', sinceIso)
        .order('created_at', { ascending: false })
        .limit(800); // 4 topic types × 200 decisions cap

      if (error) {
        return res
          .status(500)
          .json({ ok: false, error: error.message, vtid: VTID });
      }

      const rows = (data || []) as OasisRowLike[];
      const decisions = groupByDecision(rows, MAX_DECISIONS);
      const totals = countTotals(rows);

      return res.json({
        ok: true,
        vtid: VTID,
        window_hours: hours,
        user_id: userId,
        decisions,
        totals,
      });
    } catch (err) {
      console.error(`[${VTID}] inspector error: ${(err as Error).message}`);
      return res
        .status(500)
        .json({ ok: false, error: 'internal_error', vtid: VTID });
    }
  },
);

export default router;

// ---------------------------------------------------------------------------
// Pure helpers — exported for tests
// ---------------------------------------------------------------------------

export interface OasisRowLike {
  id: string;
  topic: string;
  created_at: string;
  payload: Record<string, unknown> | null;
  actor_id: string | null;
}

export interface InspectorDecision {
  decision_id: string;
  suggested_at: string | null;
  suggested: Record<string, unknown> | null;
  suppressed_at: string | null;
  suppressed: Record<string, unknown> | null;
  outcome: 'accepted' | 'dismissed' | null;
  outcome_at: string | null;
  outcome_payload: Record<string, unknown> | null;
}

export interface InspectorTotals {
  suggested: number;
  accepted: number;
  dismissed: number;
  suppressed: number;
}

/**
 * Group OASIS rows by decision_id (from payload). Newest-first by
 * suggested_at when present, else by suppressed_at. Caps the output.
 */
export function groupByDecision(
  rows: ReadonlyArray<OasisRowLike>,
  cap: number,
): InspectorDecision[] {
  const byId = new Map<string, InspectorDecision>();
  for (const r of rows) {
    const did = r.payload && typeof r.payload.decision_id === 'string'
      ? (r.payload.decision_id as string)
      : null;
    if (!did) continue;
    const existing = byId.get(did) ?? blankDecision(did);
    if (r.topic === NEXT_ACTION_SUGGESTED) {
      existing.suggested_at = r.created_at;
      existing.suggested = r.payload;
    } else if (r.topic === NEXT_ACTION_SUPPRESSED) {
      existing.suppressed_at = r.created_at;
      existing.suppressed = r.payload;
    } else if (r.topic === NEXT_ACTION_ACCEPTED) {
      existing.outcome = 'accepted';
      existing.outcome_at = r.created_at;
      existing.outcome_payload = r.payload;
    } else if (r.topic === NEXT_ACTION_DISMISSED) {
      existing.outcome = 'dismissed';
      existing.outcome_at = r.created_at;
      existing.outcome_payload = r.payload;
    }
    byId.set(did, existing);
  }
  const out = Array.from(byId.values()).sort((a, b) => {
    const aKey = a.suggested_at ?? a.suppressed_at ?? '';
    const bKey = b.suggested_at ?? b.suppressed_at ?? '';
    return bKey.localeCompare(aKey);
  });
  return out.slice(0, cap);
}

export function countTotals(rows: ReadonlyArray<OasisRowLike>): InspectorTotals {
  const totals: InspectorTotals = {
    suggested: 0,
    accepted: 0,
    dismissed: 0,
    suppressed: 0,
  };
  for (const r of rows) {
    if (r.topic === NEXT_ACTION_SUGGESTED) totals.suggested += 1;
    else if (r.topic === NEXT_ACTION_ACCEPTED) totals.accepted += 1;
    else if (r.topic === NEXT_ACTION_DISMISSED) totals.dismissed += 1;
    else if (r.topic === NEXT_ACTION_SUPPRESSED) totals.suppressed += 1;
  }
  return totals;
}

function blankDecision(decisionId: string): InspectorDecision {
  return {
    decision_id: decisionId,
    suggested_at: null,
    suggested: null,
    suppressed_at: null,
    suppressed: null,
    outcome: null,
    outcome_at: null,
    outcome_payload: null,
  };
}
