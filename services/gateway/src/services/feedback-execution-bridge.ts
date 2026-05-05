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
  // VTID-02702: dev_autopilot_config.id is INTEGER (1), not text 'singleton'.
  // The earlier query 400'd, falling through to a hardcoded scope set that
  // never reflected runtime config updates — including the expansion that
  // removed **/orb-live.ts from deny_scope.
  const resp = await fetch(`${s.url}/rest/v1/dev_autopilot_config?id=eq.1&select=allow_scope,deny_scope&limit=1`, {
    headers: s.headers,
  });
  if (resp.ok) {
    const rows = (await resp.json().catch(() => [])) as Array<SafetyConfigSummary>;
    if (rows[0] && Array.isArray(rows[0].allow_scope) && rows[0].allow_scope.length > 0) {
      return rows[0];
    }
  }
  // Fallback only if the live config is unreachable or empty. Keep the
  // ORIGINAL conservative defaults — the runtime expansion lives in the DB,
  // and a degraded gateway shouldn't accidentally widen scope.
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

  // 1. Idempotency (VTID-02674): the recommendation has a UNIQUE constraint
  //    on (source_type, signal_fingerprint). A previous failed attempt may
  //    have left an orphan recommendation in the DB even after we rolled
  //    back the ticket's linked_finding_id. So we check BOTH:
  //      (a) ticket.linked_finding_id → recommendation row
  //      (b) recommendation by signal_fingerprint = `feedback:<ticket_id>`
  //    If either match exists, REUSE the recommendation (no INSERT) — that
  //    avoids the 23505 "duplicate key" error we hit on retry after a
  //    safety-gate rejection.
  const existingFindingId = await (async (): Promise<string | null> => {
    if (ticket.linked_finding_id) {
      const r = await fetch(
        `${s.url}/rest/v1/autopilot_recommendations?id=eq.${ticket.linked_finding_id}&select=id&limit=1`,
        { headers: s.headers },
      );
      const rows = (await r.json().catch(() => [])) as Array<{ id: string }>;
      if (rows[0]) return rows[0].id;
    }
    // Fingerprint-based fallback — orphan recovery.
    const fp = `feedback:${ticket.id}`;
    const r = await fetch(
      `${s.url}/rest/v1/autopilot_recommendations?signal_fingerprint=eq.${encodeURIComponent(fp)}&source_type=eq.dev_autopilot&select=id&limit=1`,
      { headers: s.headers },
    );
    const rows = (await r.json().catch(() => [])) as Array<{ id: string }>;
    return rows[0]?.id ?? null;
  })();

  if (existingFindingId) {
    // Re-link the ticket if it was orphaned by a previous rollback.
    await fetch(
      `${s.url}/rest/v1/feedback_tickets?id=eq.${ticket.id}`,
      {
        method: 'PATCH',
        headers: { ...s.headers, Prefer: 'return=minimal' },
        body: JSON.stringify({ linked_finding_id: existingFindingId }),
      },
    ).catch(() => { /* non-blocking */ });

    // Bridge the existing finding to a fresh execution. The bridge itself
    // is idempotent on inflight executions, so a re-Activate during cooling
    // returns the same execution; otherwise it generates a new one.
    const bridgeR = await bridgeActivationToExecution(existingFindingId, approvedBy ?? null);
    if (!bridgeR.ok) {
      const decision = (bridgeR.decision ?? null) as { violations?: BridgeViolation[] } | null;
      const violations: BridgeViolation[] = decision?.violations
        ? decision.violations.map(v => ({ code: v.code, message: v.message, detail: v.detail }))
        : [{ code: 'bridge_failed', message: bridgeR.error ?? 'unknown bridge failure' }];
      return {
        ok: false,
        recommendation_id: existingFindingId,
        error: `bridge failed: ${bridgeR.error ?? 'unknown'}`,
        violations,
      };
    }
    return {
      ok: true,
      recommendation_id: existingFindingId,
      execution_id: bridgeR.execution_id,
      skipped: ticket.linked_finding_id ? 'already_linked' : 'reused_orphan',
    };
  }

  // 2. Pre-flight scope check + auto-retry (VTID-02671). Parse Devon's
  //    "Files to touch" section and validate against allow_scope/deny_scope.
  //    If the draft is bad, we silently re-call Devon with the violations
  //    as feedback up to 2 times. The supervisor only sees a violation if
  //    Devon still can't produce a valid spec after retries — at that
  //    point a human edit is genuinely needed.
  const cfg = await loadSafetyConfig(s);
  const MAX_DRAFT_RETRIES = 2;
  let proposedFiles = parseFilesToTouchFromSpec(ticket.spec_md);
  let flight = preflightFiles(proposedFiles, cfg);

  for (let attempt = 0; attempt < MAX_DRAFT_RETRIES; attempt++) {
    const isBad = proposedFiles.length === 0 || flight.allowed.length === 0;
    if (!isBad) break;

    // Build feedback for Devon explaining what was wrong.
    const reasons: string[] = [];
    if (proposedFiles.length === 0) {
      reasons.push('Your previous draft did not list any files in the "Files to touch" section. EVERY draft must include concrete file paths.');
    }
    if (flight.denied.length > 0) {
      reasons.push(`These files are FORBIDDEN (deny-scope): ${flight.denied.join(', ')}. Pick allow-scoped equivalents instead.`);
    }
    if (flight.outside.length > 0) {
      reasons.push(`These files are OUTSIDE the allow-scope (likely don't exist in this codebase): ${flight.outside.join(', ')}. Use ONLY paths starting with services/gateway/src/{routes,services,frontend/command-hub}/** or services/agents/**.`);
    }
    const retryFeedback = [
      'AUTO-RETRY (your previous draft was rejected by the safety pre-flight)',
      '====================================================================',
      ...reasons,
      '',
      `Allow-scope: ${cfg.allow_scope.join(', ')}`,
      `Deny-scope:  ${cfg.deny_scope.join(', ')}`,
      '',
      'Re-write the spec with VALID allow-scoped paths. Include at least one .test.ts file.',
      '====================================================================',
    ].join('\n');

    console.log(`[${VTID}] auto-retry Devon (attempt ${attempt + 1}/${MAX_DRAFT_RETRIES}) for ${ticket.ticket_number}`);

    try {
      const { llmDraftDevonSpec } = await import('./feedback-llm-resolvers');
      const r = await llmDraftDevonSpec(ticket as any, {
        supervisorInstructions: ticket.supervisor_notes,
        retryFeedback,
      });
      if (r.markdown && r.markdown.trim()) {
        // Persist the new draft so the supervisor sees the corrected
        // version when they reopen the drawer (and so subsequent runs
        // start from the good draft).
        await fetch(`${s.url}/rest/v1/feedback_tickets?id=eq.${ticket.id}`, {
          method: 'PATCH',
          headers: { ...s.headers, Prefer: 'return=minimal' },
          body: JSON.stringify({ spec_md: r.markdown }),
        }).catch(() => { /* non-blocking */ });
        ticket.spec_md = r.markdown;
        proposedFiles = parseFilesToTouchFromSpec(r.markdown);
        flight = preflightFiles(proposedFiles, cfg);
      }
    } catch (err) {
      console.warn(`[${VTID}] auto-retry failed:`, err);
      break;
    }
  }

  // After retries — if STILL bad, surface violations for the supervisor
  // to take over manually.
  if (proposedFiles.length === 0) {
    return {
      ok: false,
      error: 'NO_FILES_IN_SPEC',
      violations: [{
        code: 'no_files_in_spec',
        message: "Devon couldn't propose concrete files even after auto-retry. Tighten Step 1 instructions with specific module names (e.g. services/gateway/src/services/persona-registry.ts).",
      }],
    };
  }
  if (flight.allowed.length === 0) {
    const violations: BridgeViolation[] = [];
    if (flight.denied.length > 0) {
      violations.push({
        code: 'file_in_deny_scope',
        message: `Devon kept proposing forbidden files even after auto-retry: ${flight.denied.join(', ')}. The fix likely requires touching deny-scoped code (e.g. orb-live.ts) — that's intentionally human-only. Edit Step 1 to point Devon at an allow-scoped wrapper instead.`,
        detail: { denied: flight.denied, deny_scope: cfg.deny_scope },
      });
    }
    if (flight.outside.length > 0) {
      violations.push({
        code: 'file_outside_allow_scope',
        message: `Devon kept hallucinating non-existent paths after auto-retry: ${flight.outside.join(', ')}. Edit Step 1 with explicit module names.`,
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
