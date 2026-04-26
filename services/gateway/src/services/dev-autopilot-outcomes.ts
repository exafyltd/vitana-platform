/**
 * Dev Autopilot Outcomes — write-through to the substrate that records
 * every approve / auto-exec / reject / dismiss decision and the eventual
 * execution outcome.
 *
 * The dev_autopilot_outcomes table is the data substrate the future
 * autonomy-graduation policy reads to decide which scanners earn a higher
 * autonomy level (e.g., "scanner X had 50 consecutive successful auto_exec
 * outcomes — promote it to full_auto"). For now we just *record*; the
 * policy that *acts* on these rows is a follow-up.
 *
 * Failures here are logged and swallowed — never break the user-facing
 * action because the substrate write failed.
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const LOG_PREFIX = '[dev-autopilot-outcomes]';

export type OutcomeDecision = 'auto_exec' | 'approved' | 'rejected' | 'dismissed' | 'demoted';
export type ExecOutcome = 'success' | 'failure' | 'rolled_back' | 'timeout';

interface SupaConfig {
  url: string;
  key: string;
}

function getSupa(): SupaConfig | null {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) return null;
  return { url: SUPABASE_URL, key: SUPABASE_SERVICE_ROLE };
}

interface FindingShape {
  source_type: 'dev_autopilot' | 'dev_autopilot_impact';
  risk_class: string | null;
  impact_score: number | null;
  effort_score: number | null;
  spec_snapshot: { scanner?: string } | null;
}

async function fetchFinding(supa: SupaConfig, findingId: string): Promise<FindingShape | null> {
  try {
    const r = await fetch(
      `${supa.url}/rest/v1/autopilot_recommendations` +
        `?id=eq.${findingId}` +
        `&select=source_type,risk_class,impact_score,effort_score,spec_snapshot` +
        `&limit=1`,
      { headers: { apikey: supa.key, Authorization: `Bearer ${supa.key}` } },
    );
    if (!r.ok) return null;
    const rows = (await r.json()) as FindingShape[];
    return rows[0] || null;
  } catch {
    return null;
  }
}

export interface RecordOutcomeInput {
  finding_id: string;
  decision: OutcomeDecision;
  approver_user_id?: string | null;
  vtid?: string | null;
  human_modified_plan?: boolean;
  reason?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Insert a new outcome row at the moment of decision. Idempotent in spirit:
 * a finding can have multiple outcome rows over its lifetime (e.g., an
 * auto_exec that fails → demoted → eventually approved by a human). Each
 * row represents one decision.
 */
export async function recordOutcome(input: RecordOutcomeInput): Promise<void> {
  const supa = getSupa();
  if (!supa) return;

  const finding = await fetchFinding(supa, input.finding_id);
  if (!finding) {
    // Finding gone or not a dev row — silently skip. Outcomes are dev-only.
    return;
  }
  if (finding.source_type !== 'dev_autopilot' && finding.source_type !== 'dev_autopilot_impact') {
    return;
  }

  const scanner_name = (finding.spec_snapshot?.scanner as string) || 'unknown';

  try {
    const r = await fetch(`${supa.url}/rest/v1/dev_autopilot_outcomes`, {
      method: 'POST',
      headers: {
        apikey: supa.key,
        Authorization: `Bearer ${supa.key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        finding_id: input.finding_id,
        scanner_name,
        source_type: finding.source_type,
        risk_class: finding.risk_class,
        impact_score: finding.impact_score,
        effort_score: finding.effort_score,
        decision: input.decision,
        approver_user_id: input.approver_user_id ?? null,
        vtid: input.vtid ?? null,
        human_modified_plan: input.human_modified_plan ?? false,
        reason: input.reason ?? null,
        metadata: input.metadata ?? {},
      }),
    });
    if (!r.ok) {
      const body = await r.text();
      console.warn(`${LOG_PREFIX} insert failed (${r.status}): ${body.slice(0, 200)}`);
    }
  } catch (err) {
    console.warn(`${LOG_PREFIX} insert error:`, err);
  }
}

/**
 * Backfill the exec_outcome on the most recent outcome row for a finding
 * after the worker reports completion/failure. There is normally a single
 * "open" outcome row per finding (the most recent decision='approved' or
 * 'auto_exec' with exec_outcome IS NULL); this updates that one.
 *
 * If no open outcome row exists (e.g., finding was approved before this
 * substrate shipped, or the approval-time write failed), this is a no-op —
 * we don't fabricate history.
 */
export async function recordExecOutcome(
  finding_id: string,
  exec_outcome: ExecOutcome,
  vtid?: string | null,
): Promise<void> {
  const supa = getSupa();
  if (!supa) return;

  // Find the latest open outcome row for this finding.
  const findUrl =
    `${supa.url}/rest/v1/dev_autopilot_outcomes` +
    `?finding_id=eq.${finding_id}` +
    `&decision=in.(approved,auto_exec)` +
    `&exec_outcome=is.null` +
    `&order=created_at.desc&limit=1` +
    `&select=id`;

  try {
    const findR = await fetch(findUrl, {
      headers: { apikey: supa.key, Authorization: `Bearer ${supa.key}` },
    });
    if (!findR.ok) return;
    const rows = (await findR.json()) as Array<{ id: string }>;
    const target = rows[0];
    if (!target) return;

    const patchR = await fetch(`${supa.url}/rest/v1/dev_autopilot_outcomes?id=eq.${target.id}`, {
      method: 'PATCH',
      headers: {
        apikey: supa.key,
        Authorization: `Bearer ${supa.key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        exec_outcome,
        exec_completed_at: new Date().toISOString(),
        ...(vtid ? { vtid } : {}),
      }),
    });
    if (!patchR.ok) {
      const body = await patchR.text();
      console.warn(`${LOG_PREFIX} backfill failed (${patchR.status}): ${body.slice(0, 200)}`);
    }
  } catch (err) {
    console.warn(`${LOG_PREFIX} backfill error:`, err);
  }
}
