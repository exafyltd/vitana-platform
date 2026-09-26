/**
 * Voice Self-Healing operator actions (VTID-04626)
 *
 * The decisions an operator makes on the Command Hub → Voice → Self-Healing
 * screen. Every function returns a structured result and never throws.
 *
 * Accept & Execute used to allocate one VTID per proposed step and leave each
 * at status='scheduled', assigned_to='autopilot', metadata.source=
 * 'voice-investigator-execute'. Since VTID-03516 the worker-runner only claims
 * rows marked as autonomous work, and nothing else ever picks up 'scheduled'
 * rows — so every accept since 2026-05-30 produced VTIDs that never ran.
 * Accept now hands the report to the Dev Autopilot on-ramp (the same path the
 * Operator Console uses): one VTID, one agent execution that discovers the
 * files itself, and — with OPERATOR_PR_APPROVAL_REQUIRED on staging and prod —
 * a branch held at `awaiting_approval` for a human before any PR opens.
 */

import { emitOasisEvent } from './oasis-event-service';
import { spawnInvestigator, VOICE_PIPELINE_DESCRIPTION } from './voice-architecture-investigator';
import { fetchReportById } from './voice-healing-overview';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: SUPABASE_SERVICE_ROLE as string,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

export interface ActionResult {
  ok: boolean;
  status: number;
  error?: string;
  [k: string]: unknown;
}

async function patchReport(id: string, patch: Record<string, unknown>): Promise<boolean> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) return false;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/voice_architecture_reports?id=eq.${encodeURIComponent(id)}`,
      { method: 'PATCH', headers: headers({ Prefer: 'return=minimal' }), body: JSON.stringify(patch) },
    );
    return res.ok;
  } catch {
    return false;
  }
}

function isFailedStub(row: Record<string, any>): boolean {
  return row.schema_version === 'v1-stub' || row.report?.investigator_status === 'failed';
}

// =============================================================================
// Accept → Dev Autopilot
// =============================================================================

/** Pure: the request the agent executor receives for an accepted report. */
export function buildAcceptPlan(row: Record<string, any>, notes?: string | null): { title: string; plan: string } {
  const rec = row.report?.recommendation || {};
  const steps: string[] = Array.isArray(rec.proposed_next_steps) ? rec.proposed_next_steps.map(String) : [];
  const decisions: string[] = Array.isArray(rec.required_human_decisions)
    ? rec.required_human_decisions.map(String)
    : [];
  const track = String(rec.track || 'fix');
  const title = `Voice self-healing: ${track.replace(/_/g, ' ')} for ${row.class}`.slice(0, 180);
  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push('');
  lines.push(
    `An operator accepted Voice Architecture Investigator report ${row.id} on the Command Hub Voice Self-Healing screen.`,
  );
  lines.push(`Failure class: ${row.class}; signature: ${row.normalized_signature ?? '(none)'}; trigger: ${row.trigger_reason}.`);
  lines.push('');
  lines.push(`Current voice pipeline: ${VOICE_PIPELINE_DESCRIPTION}`);
  lines.push('');
  lines.push('## Recommendation');
  lines.push(String(rec.summary || '(no summary)'));
  if (rec.rationale) lines.push('', `Rationale: ${rec.rationale}`);
  if (rec.contradiction_check) lines.push('', `What would invalidate it: ${rec.contradiction_check}`);
  if (steps.length) {
    lines.push('', '## Proposed steps');
    steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  }
  if (decisions.length) {
    lines.push('', '## Open human decisions (do not decide these in code — flag them in the PR body)');
    decisions.forEach((d) => lines.push(`- ${d}`));
  }
  if (notes) lines.push('', `## Operator notes`, notes);
  lines.push(
    '',
    '## Constraints',
    '- Do the smallest change that implements the steps that are code changes; skip steps that are pure investigation and say so in the PR body.',
    '- The report was written by a model from limited evidence. Verify every claim about the code before acting on it.',
    '- Never reintroduce a Google/Vertex dependency outside the Serbian bridge; never hardcode a sentence Vitana speaks.',
    '- Add or update tests for what you change.',
  );
  return { title, plan: lines.join('\n') };
}

export async function acceptReport(
  id: string,
  actor: { user_id: string; email?: string | null },
  notes?: string | null,
): Promise<ActionResult> {
  const row = await fetchReportById(id);
  if (!row) return { ok: false, status: 404, error: 'report not found' };
  if (row.status !== 'open') {
    return { ok: false, status: 409, error: `report already ${row.status}`, report_status: row.status };
  }
  if (isFailedStub(row)) {
    return { ok: false, status: 400, error: 'this is a failed investigation, not a report — retry it first' };
  }
  const rec = row.report?.recommendation || {};
  if (!rec.summary && !(Array.isArray(rec.proposed_next_steps) && rec.proposed_next_steps.length)) {
    return { ok: false, status: 400, error: 'report has no recommendation to execute' };
  }

  const { title, plan } = buildAcceptPlan(row, notes);
  const { triggerOperatorExecution } = await import('./operator-execution-onramp');
  const exec = await triggerOperatorExecution({
    title,
    planMarkdown: plan,
    filesReferenced: [],
    openEnded: true,
    requestedBy: `voice-healing:${actor.user_id}`,
  });
  if (!exec.ok) {
    return { ok: false, status: 502, error: `Dev Autopilot refused the task: ${exec.error}` };
  }

  const acceptedAt = new Date().toISOString();
  const executionRef = {
    execution_id: exec.execution_id,
    finding_id: exec.finding_id,
    vtid: exec.vtid,
    accepted_at: acceptedAt,
    accepted_by: actor.email || actor.user_id,
  };
  const patched = await patchReport(id, {
    status: 'accepted',
    acknowledged_by: actor.email || actor.user_id,
    acknowledged_at: acceptedAt,
    decision_notes: notes ?? null,
    report: { ...(row.report || {}), _execution: executionRef },
  });

  try {
    await emitOasisEvent({
      vtid: exec.vtid,
      type: 'voice.healing.report.accepted',
      source: 'voice-lab',
      status: 'info',
      message: `Voice investigator report ${id} (${row.class}) accepted — Dev Autopilot execution ${exec.execution_id.slice(0, 8)} queued`,
      payload: { report_id: id, class: row.class, ...executionRef },
    });
  } catch {
    /* best-effort */
  }

  return {
    ok: true,
    status: 200,
    report_id: id,
    execution: executionRef,
    report_updated: patched,
  };
}

// =============================================================================
// Failed investigations: retry / dismiss
// =============================================================================

export async function retryReport(id: string, actor: { user_id: string; email?: string | null }): Promise<ActionResult> {
  const row = await fetchReportById(id);
  if (!row) return { ok: false, status: 404, error: 'report not found' };
  if (row.status !== 'open') return { ok: false, status: 409, error: `report already ${row.status}` };

  const r = await spawnInvestigator({
    class: row.class,
    normalized_signature: row.normalized_signature ?? null,
    trigger_reason: 'manual',
    related_vtid: row.related_vtid ?? null,
    notes: `Retry of report ${id} (originally ${row.trigger_reason}) requested by ${actor.email || actor.user_id}.`,
  });
  // The old row is superseded only when the retry produced a real report;
  // a second failure leaves it open so nothing disappears silently.
  if (r.ok && r.report_id) {
    await patchReport(id, {
      status: 'rejected',
      acknowledged_by: actor.email || actor.user_id,
      acknowledged_at: new Date().toISOString(),
      decision_notes: `superseded by retry ${r.report_id}`,
    });
  }
  return {
    ok: r.ok,
    status: r.ok ? 200 : 502,
    error: r.ok ? undefined : r.detail || r.validation.reason || 'investigation failed again',
    new_report_id: r.report_id,
    validation: r.validation,
  };
}

export async function dismissReports(
  ids: string[] | 'all_failed',
  actor: { user_id: string; email?: string | null },
  reason: string,
): Promise<ActionResult> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) return { ok: false, status: 500, error: 'Supabase not configured' };
  let filter: string;
  if (ids === 'all_failed') {
    filter = 'status=eq.open&schema_version=eq.v1-stub';
  } else {
    const clean = ids.filter((i) => /^[0-9a-f-]{36}$/i.test(i));
    if (clean.length === 0) return { ok: false, status: 400, error: 'no valid report ids' };
    filter = `status=eq.open&id=in.(${clean.join(',')})`;
  }
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/voice_architecture_reports?${filter}`, {
      method: 'PATCH',
      headers: headers({ Prefer: 'return=representation' }),
      body: JSON.stringify({
        status: 'rejected',
        acknowledged_by: actor.email || actor.user_id,
        acknowledged_at: new Date().toISOString(),
        decision_notes: `dismissed: ${reason}`.slice(0, 500),
      }),
    });
    if (!res.ok) return { ok: false, status: res.status, error: (await res.text()).slice(0, 300) };
    const rows = (await res.json()) as Array<{ id: string }>;
    try {
      await emitOasisEvent({
        vtid: 'VTID-VOICE-HEALING',
        type: 'voice.healing.report.dismissed',
        source: 'voice-lab',
        status: 'info',
        message: `${rows.length} voice investigator report(s) dismissed by ${actor.email || actor.user_id}`,
        payload: { report_ids: rows.map((r) => r.id), reason },
      });
    } catch {
      /* best-effort */
    }
    return { ok: true, status: 200, dismissed: rows.length, report_ids: rows.map((r) => r.id) };
  } catch (err: any) {
    return { ok: false, status: 500, error: err?.message ?? 'dismiss failed' };
  }
}

// =============================================================================
// Execution progress
// =============================================================================

export async function reportExecution(id: string): Promise<ActionResult> {
  const row = await fetchReportById(id);
  if (!row) return { ok: false, status: 404, error: 'report not found' };
  const ref = row.report?._execution;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) return { ok: false, status: 500, error: 'Supabase not configured' };

  if (ref?.execution_id) {
    try {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/dev_autopilot_executions?id=eq.${encodeURIComponent(ref.execution_id)}` +
          '&select=id,status,branch,pr_url,pr_number,failure_stage,created_at,updated_at,completed_at&limit=1',
        { headers: headers() },
      );
      const rows = res.ok ? ((await res.json()) as any[]) : [];
      return { ok: true, status: 200, kind: 'dev_autopilot', ref, execution: rows[0] ?? null };
    } catch (err: any) {
      return { ok: false, status: 500, error: err?.message ?? 'fetch failed' };
    }
  }

  // Reports accepted before VTID-04626: the per-step ledger rows.
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/vtid_ledger?metadata->>source_report_id=eq.${encodeURIComponent(id)}` +
        '&select=vtid,title,status,is_terminal,terminal_outcome,updated_at&order=vtid.asc&limit=50',
      { headers: headers() },
    );
    const rows = res.ok ? ((await res.json()) as any[]) : [];
    return { ok: true, status: 200, kind: 'legacy_ledger', vtids: rows };
  } catch (err: any) {
    return { ok: false, status: 500, error: err?.message ?? 'fetch failed' };
  }
}
