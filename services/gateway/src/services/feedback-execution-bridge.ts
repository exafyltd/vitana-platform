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

export interface BridgeViolation {
  code: string;
  message: string;
  detail?: unknown;
}

export interface BridgeResult {
  ok: boolean;
  recommendation_id?: string;
  execution_id?: string;
  skipped?: string;
  error?: string;
  // VTID-02669: structured violations (safety gate or local pre-flight) so
  // the UI can render a bullet list and guide the supervisor to revise.
  violations?: BridgeViolation[];
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

// VTID-02669: parse Devon's "Files to touch" section out of spec_md so we can
// (a) seed spec_snapshot.file_path with a real allow-scoped path for the
// safety gate's pre-flight check (avoids file_outside_allow_scope on a null
// file_path) and (b) fail FAST with a friendly violation if every proposed
// file is in deny_scope — saves a planner round trip the gate would refuse.
//
// Devon's spec template (DEVON_SYSTEM in feedback-llm-resolvers.ts) emits a
// `## Files to touch (best guess)` section with a bullet list. We grep for
// path-shaped tokens (with at least one slash and a known extension).
const FILE_PATH_REGEX = /([a-zA-Z0-9_./-]+\.(?:tsx?|jsx?|sql|md|yml|yaml|json|css|html|sh|py))/g;

export function parseFilesToTouchFromSpec(specMd: string | null | undefined): string[] {
  if (!specMd) return [];
  const md = specMd.replace(/\r\n/g, '\n');
  // Find the section heading variants. Tolerate slight wording drift.
  const headingPattern = /^##+\s*Files?\s+to\s+touch\b[^\n]*$/im;
  const startMatch = md.match(headingPattern);
  if (!startMatch) {
    // Fallback: pull file paths from anywhere in the doc.
    return Array.from(new Set((md.match(FILE_PATH_REGEX) ?? []).filter(p => p.includes('/'))));
  }
  const startIdx = (startMatch.index ?? 0) + startMatch[0].length;
  // Section ends at next H2/H3 or end of doc.
  const after = md.slice(startIdx);
  const nextHeading = after.match(/^##+\s/m);
  const sectionBody = nextHeading ? after.slice(0, nextHeading.index) : after;
  return Array.from(new Set((sectionBody.match(FILE_PATH_REGEX) ?? []).filter(p => p.includes('/'))));
}

interface SafetyConfigSummary {
  allow_scope: string[];
  deny_scope: string[];
}

async function loadSafetyConfig(s: SupaConfig): Promise<SafetyConfigSummary> {
  const resp = await fetch(`${s.url}/rest/v1/dev_autopilot_config?id=eq.singleton&select=allow_scope,deny_scope&limit=1`, {
    headers: s.headers,
  });
  if (!resp.ok) {
    return {
      allow_scope: [
        'services/gateway/src/routes/**',
        'services/gateway/src/services/**',
        'services/gateway/src/frontend/command-hub/**',
        'services/agents/**',
      ],
      deny_scope: [
        'supabase/migrations/**',
        '**/auth*',
        '**/orb-live.ts',
        '.github/workflows/**',
        '**/.env*',
      ],
    };
  }
  const rows = (await resp.json().catch(() => [])) as Array<SafetyConfigSummary>;
  return rows[0] ?? { allow_scope: [], deny_scope: [] };
}

function preflightFiles(files: string[], cfg: SafetyConfigSummary): {
  allowed: string[];
  denied: string[];
  outside: string[];
} {
  // We import matchGlob lazily (require inside service module is fine in our
  // runtime) so the bridge has no cyclic dep on the gate at module load.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { matchGlob } = require('./dev-autopilot-safety') as { matchGlob: (p: string, pat: string) => boolean };
  const matchAny = (p: string, pats: string[]) => pats.some(pat => matchGlob(p, pat));
  const allowed: string[] = [];
  const denied: string[] = [];
  const outside: string[] = [];
  for (const f of files) {
    if (matchAny(f, cfg.deny_scope)) denied.push(f);
    else if (matchAny(f, cfg.allow_scope)) allowed.push(f);
    else outside.push(f);
  }
  return { allowed, denied, outside };
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

  // 2. Pre-flight scope check (VTID-02669). Pull "Files to touch" from
  //    Devon's spec, validate against allow_scope / deny_scope. If every
  //    proposed file is denied or out-of-scope, refuse with a structured
  //    violation BEFORE inserting the recommendation — saves a planner
  //    round trip the safety gate would refuse anyway and gives the
  //    supervisor a clear, actionable error.
  const proposedFiles = parseFilesToTouchFromSpec(ticket.spec_md);
  const cfg = await loadSafetyConfig(s);
  const flight = preflightFiles(proposedFiles, cfg);
  if (proposedFiles.length === 0) {
    return {
      ok: false,
      error: 'NO_FILES_IN_SPEC',
      violations: [{
        code: 'no_files_in_spec',
        message: "Devon's spec didn't list any files to touch. Add a `## Files to touch` section with concrete paths, then Re-generate.",
      }],
    };
  }
  if (flight.allowed.length === 0) {
    const violations: BridgeViolation[] = [];
    if (flight.denied.length > 0) {
      violations.push({
        code: 'file_in_deny_scope',
        message: `Every proposed file is in the dev autopilot deny-scope: ${flight.denied.join(', ')}. Revise your instructions to scope the fix to allowed paths (gateway routes/services/frontend, agents). Files like orb-live.ts, supabase/migrations/**, and .github/workflows/** are intentionally excluded.`,
        detail: { denied: flight.denied, deny_scope: cfg.deny_scope },
      });
    }
    if (flight.outside.length > 0) {
      violations.push({
        code: 'file_outside_allow_scope',
        message: `Files outside the allow-scope: ${flight.outside.join(', ')}. Allow scope: ${cfg.allow_scope.join(', ')}.`,
        detail: { outside: flight.outside, allow_scope: cfg.allow_scope },
      });
    }
    return { ok: false, error: 'NO_ALLOWED_FILES', violations };
  }

  // 3. Build the recommendation. spec_snapshot is the payload the autopilot
  //    executor reads at run-time. We pack the spec and supervisor notes so
  //    the Claude session has everything it needs. Set file_path to the
  //    first allow-scoped file so the planner has a real seed (the safety
  //    pre-flight at listing time also reads file_path).
  const headline = extractProblemHeadline(ticket.spec_md, ticket.raw_transcript);
  const title = `[${ticket.ticket_number ?? 'feedback'}] ${shortenForTitle(headline, 100)}`;
  const summary = ticket.supervisor_notes
    ? `${shortenForTitle(headline, 200)} — ${shortenForTitle(ticket.supervisor_notes, 280)}`
    : shortenForTitle(headline, 480);
  const now = new Date().toISOString();
  const seedFilePath = flight.allowed[0];

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
      file_path: seedFilePath,
      proposed_files: flight.allowed,
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
    // VTID-02669: surface decision.violations[] from the safety gate so the
    // UI can show exactly which rule rejected the recommendation. Common
    // post-pre-flight cases: tests_missing (Devon didn't propose a test
    // file), daily_budget_exhausted, kill_switch_engaged, or the LLM
    // planner expanded files_to_modify outside what the bridge pre-flight
    // saw.
    const decision = (bridge.decision ?? null) as { violations?: BridgeViolation[] } | null;
    const violations: BridgeViolation[] = decision?.violations
      ? decision.violations.map(v => ({ code: v.code, message: v.message, detail: v.detail }))
      : [{ code: 'bridge_failed', message: bridge.error ?? 'unknown bridge failure' }];

    // VTID-02669: rollback the linked_finding_id so subsequent retries
    // start fresh — otherwise the supervisor is stuck with a stale link.
    await fetch(
      `${s.url}/rest/v1/feedback_tickets?id=eq.${ticket.id}`,
      {
        method: 'PATCH',
        headers: { ...s.headers, Prefer: 'return=minimal' },
        body: JSON.stringify({ linked_finding_id: null }),
      },
    ).catch(() => { /* non-blocking */ });

    return {
      ok: false,
      recommendation_id: findingId,
      error: `bridge failed: ${bridge.error ?? 'unknown'}`,
      violations,
    };
  }

  console.log(`[${VTID}] dispatched ${ticket.ticket_number} → finding=${findingId.slice(0, 8)} execution=${(bridge.execution_id ?? '').slice(0, 8)}`);
  return {
    ok: true,
    recommendation_id: findingId,
    execution_id: bridge.execution_id,
  };
}
