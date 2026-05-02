/**
 * VTID-02665: Feedback Execution Bridge.
 *
 * Converts an activated bug / ux_issue feedback ticket into the existing
 * dev autopilot pipeline:
 *
 *   feedback_ticket (kind=bug|ux_issue, status=in_progress, spec_md set)
 *       │
 *       ▼
 *   INSERT autopilot_recommendations (source_type='dev_autopilot',
 *       spec_snapshot=<ticket spec + supervisor notes>)
 *       │
 *       ▼
 *   bridgeActivationToExecution(finding_id)
 *       (generates plan + creates dev_autopilot_executions row +
 *        sets execute_after = now so backgroundExecutorTick claims it)
 *       │
 *       ▼
 *   Existing autopilot worker runs Claude Messages API with the spec
 *   → makes the code changes → opens PR → CI → merge → EXEC-DEPLOY
 *       │
 *       ▼
 *   feedback_tickets.linked_finding_id (this PR) +
 *   feedback_tickets.linked_pr_url + linked_vtid (later, by reconciler)
 *
 * The supervisor's instructions (supervisor_notes) take priority over
 * the user's report when the spec was generated upstream — VTID-02664.
 * This service treats spec_md as the authoritative work item and just
 * forwards it; supervisor_notes is included verbatim for the executor's
 * Claude session as additional context.
 */

import { bridgeActivationToExecution } from './dev-autopilot-execute';

const VTID = 'VTID-02665';

interface FeedbackTicketRow {
  id: string;
  ticket_number: string | null;
  kind: string;
  status: string;
  spec_md: string | null;
  supervisor_notes: string | null;
  raw_transcript: string | null;
  vitana_id: string | null;
  screen_path: string | null;
  app_version: string | null;
  linked_finding_id: string | null;
}

export interface BridgeResult {
  ok: boolean;
  recommendation_id?: string;
  execution_id?: string;
  skipped?: string;
  error?: string;
}

interface SupaConfig {
  url: string;
  key: string;
  headers: Record<string, string>;
}

function getSupabase(): SupaConfig | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return null;
  return {
    url,
    key,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
  };
}

function shortenForTitle(s: string, max = 80): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max - 1) + '…';
}

// Pull a one-line problem statement from Devon's spec (which begins with
// `# <ticket_number> — <one-line problem statement>`). Falls back to the
// ticket's raw_transcript if the spec heading isn't present.
function extractProblemHeadline(specMd: string | null, raw: string | null): string {
  const md = (specMd ?? '').trim();
  if (md) {
    const firstLine = md.split('\n', 1)[0] ?? '';
    const stripped = firstLine.replace(/^#\s*/, '').trim();
    if (stripped) {
      // Strip leading "FB-XXXX —" prefix Devon's template includes.
      const withoutPrefix = stripped.replace(/^[A-Z0-9-]+\s*[—-]\s*/, '').trim();
      if (withoutPrefix) return withoutPrefix;
      return stripped;
    }
  }
  if (raw && raw.trim()) return shortenForTitle(raw);
  return 'Feedback ticket — no spec';
}

/**
 * Dispatch a feedback ticket through the dev autopilot pipeline.
 *
 * Idempotent: if linked_finding_id is already set, the existing
 * recommendation is returned (no new row, no duplicate execution). The
 * downstream bridgeActivationToExecution is also idempotent on its own
 * inflight check.
 *
 * Returns:
 *   { ok: true, recommendation_id, execution_id }   on success / re-click
 *   { ok: false, error }                            on failure
 *   { ok: true, skipped: "<why>" }                  for non-bridgeable kinds
 */
export async function dispatchFeedbackTicket(
  ticket: FeedbackTicketRow,
  approvedBy?: string | null,
): Promise<BridgeResult> {
  const s = getSupabase();
  if (!s) return { ok: false, error: 'Supabase not configured' };

  // Only bug / ux_issue feed the dev autopilot. Other kinds get their own
  // delivery paths (Sage answer, Atlas claim, Mira account) — handled
  // elsewhere or in follow-up PRs. Refuse here cleanly so callers can log
  // the skip without crashing.
  if (ticket.kind !== 'bug' && ticket.kind !== 'ux_issue') {
    return { ok: true, skipped: `kind=${ticket.kind} not dev_autopilot` };
  }

  const spec = (ticket.spec_md ?? '').trim();
  if (!spec) {
    return { ok: false, error: 'NO_SPEC — call /draft-spec before dispatch' };
  }

  // 1. Idempotency — if already linked, just look up the execution and
  //    return. Operator can press Activate again on a still-running ticket
  //    without duplicating.
  if (ticket.linked_finding_id) {
    const existingRecResp = await fetch(
      `${s.url}/rest/v1/autopilot_recommendations?id=eq.${ticket.linked_finding_id}&select=id,status&limit=1`,
      { headers: s.headers },
    );
    const existingRec = (await existingRecResp.json().catch(() => [])) as Array<{ id: string; status: string }>;
    if (existingRec[0]) {
      const execResp = await fetch(
        `${s.url}/rest/v1/dev_autopilot_executions?finding_id=eq.${ticket.linked_finding_id}&select=id,status&order=created_at.desc&limit=1`,
        { headers: s.headers },
      );
      const exec = (await execResp.json().catch(() => [])) as Array<{ id: string; status: string }>;
      return {
        ok: true,
        recommendation_id: existingRec[0].id,
        execution_id: exec[0]?.id,
        skipped: 'already_linked',
      };
    }
    // linked_finding_id is set but the recommendation row was deleted —
    // fall through and create a new one. Don't block the dispatch.
  }

  // 2. Build the recommendation. spec_snapshot is the payload the autopilot
  //    executor reads at run-time. We pack the spec and supervisor notes so
  //    the Claude session has everything it needs.
  const headline = extractProblemHeadline(ticket.spec_md, ticket.raw_transcript);
  const title = `[${ticket.ticket_number ?? 'feedback'}] ${shortenForTitle(headline, 100)}`;
  const summary = ticket.supervisor_notes
    ? `${shortenForTitle(headline, 200)} — ${shortenForTitle(ticket.supervisor_notes, 280)}`
    : shortenForTitle(headline, 480);
  const now = new Date().toISOString();

  const payload = {
    title,
    summary,
    domain: 'feedback',
    risk_level: 'medium',
    risk_class: 'medium',
    // VTID-02668: impact_score / effort_score are INTEGER (0-10 scale) per
    // 20260427100000_BOOTSTRAP_autopilot_realign_substrate.sql. The earlier
    // 0.7 / 0.5 floats triggered Postgres 22P02 "invalid input syntax for
    // type integer". 7 = high impact, 5 = medium effort, matching the
    // auto_exec_eligible >=5 threshold.
    impact_score: 7,
    effort_score: 5,
    status: 'new',
    source_type: 'dev_autopilot',
    source_ref: `feedback_ticket:${ticket.id}`,
    auto_exec_eligible: false,
    signal_fingerprint: `feedback:${ticket.id}`,
    first_seen_at: now,
    last_seen_at: now,
    seen_count: 1,
    spec_snapshot: {
      // Standard dev_autopilot fields the executor / planner expect.
      signal_type: 'feedback_ticket',
      file_path: null,
      line_number: null,
      suggested_action: spec,
      scanner: 'feedback_pipeline',
      // VTID-02665 extension — feedback-specific context. The autopilot
      // planner will see this when generating the plan version.
      feedback: {
        ticket_id: ticket.id,
        ticket_number: ticket.ticket_number,
        kind: ticket.kind,
        spec_md: spec,
        supervisor_notes: ticket.supervisor_notes ?? null,
        raw_transcript: ticket.raw_transcript ?? null,
        screen_path: ticket.screen_path ?? null,
        app_version: ticket.app_version ?? null,
        reporter_vitana_id: ticket.vitana_id ?? null,
      },
    },
  };

  const insertResp = await fetch(
    `${s.url}/rest/v1/autopilot_recommendations?select=id`,
    {
      method: 'POST',
      headers: { ...s.headers, Prefer: 'return=representation' },
      body: JSON.stringify(payload),
    },
  );
  if (!insertResp.ok) {
    const text = await insertResp.text().catch(() => '');
    return { ok: false, error: `recommendation insert failed (${insertResp.status}): ${text.slice(0, 200)}` };
  }
  const rows = (await insertResp.json().catch(() => [])) as Array<{ id: string }>;
  const findingId = rows[0]?.id;
  if (!findingId) return { ok: false, error: 'recommendation insert returned no id' };

  // 3. Backlink the ticket so re-Activate is a no-op.
  await fetch(
    `${s.url}/rest/v1/feedback_tickets?id=eq.${ticket.id}`,
    {
      method: 'PATCH',
      headers: { ...s.headers, Prefer: 'return=minimal' },
      body: JSON.stringify({ linked_finding_id: findingId }),
    },
  ).catch(() => { /* non-blocking; the next dispatch will idempotency-skip via the check above */ });

  // 4. Bridge to execution. This generates the plan if missing, creates
  //    the dev_autopilot_executions row, and sets execute_after=now so
  //    the next backgroundExecutorTick claims it (~30s).
  const bridge = await bridgeActivationToExecution(findingId, approvedBy ?? null);
  if (!bridge.ok) {
    // Don't unset linked_finding_id — the recommendation exists; the bridge
    // just couldn't kick the execution. Operator can retry.
    return {
      ok: false,
      recommendation_id: findingId,
      error: `bridge failed: ${bridge.error ?? 'unknown'}`,
    };
  }

  console.log(`[${VTID}] dispatched ${ticket.ticket_number} → finding=${findingId.slice(0, 8)} execution=${(bridge.execution_id ?? '').slice(0, 8)}`);
  return {
    ok: true,
    recommendation_id: findingId,
    execution_id: bridge.execution_id,
  };
}
